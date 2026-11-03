import type { Terminal } from "@xterm/xterm";

/**
 * Best-effort classification of what the agent is doing right now, read
 * straight off xterm.js's own rendered buffer (not the raw ANSI bytes —
 * xterm has already done the hard work of turning cursor moves/redraws
 * into a stable 2D screen, so reading *that* is far more reliable than
 * trying to pattern-match a live ANSI stream ourselves).
 *
 * This is inherently heuristic: it's tuned against Claude Code's actual
 * observed CLI output (verified live in the desktop-obsidian container,
 * 2026-08-31) and is unverified against OpenCode's output, which may not
 * follow the same conventions at all. Only used when a button's
 * `completion: responseEnd` — `completion: manual` (the default) never
 * calls this, so a misclassification there can't affect anything.
 */
export type AgentTurnState = "streaming" | "awaiting-input" | "idle-done";

// The agent is showing a menu/dialog and is blocked on the user picking an
// option — the folder-trust and bypass-permissions dialogs we saw live both
// look like this, and Claude Code's tool-permission prompts ("Do you want
// to proceed?") are documented to use the same "Enter to confirm" style.
const QUESTION_PATTERNS: RegExp[] = [
	/enter to confirm/i,
	/esc(?:ape)? to cancel/i,
	/do you want to (proceed|continue)/i,
	/\(y\/n\)/i,
	/❯\s*\d+\.\s/,
];

// Claude Code prints a one-time "<spinner-verb> for Ns · done H:MM AM/PM"
// summary line when a turn finishes (verified live: "Crunched for 7s · done
// 2:54 PM"). This is a much safer "the agent is done talking" signal than
// the persistent bottom status bar, which — as far as we've verified —
// may well be redrawn continuously while a turn is still in progress, not
// only once it ends.
const IDLE_DONE_PATTERNS: RegExp[] = [/·\s*done\s+\d{1,2}:\d{2}\s*(am|pm)?/i];

function getTailText(term: Terminal, lines = 40): string {
	const buf = term.buffer.active;
	const start = Math.max(0, buf.length - lines);
	const out: string[] = [];
	for (let y = start; y < buf.length; y++) {
		const line = buf.getLine(y);
		if (line) out.push(line.translateToString(true));
	}
	return out.join("\n");
}

export function classifyTurnState(term: Terminal): AgentTurnState {
	const tail = getTailText(term, 40);
	if (QUESTION_PATTERNS.some((re) => re.test(tail))) return "awaiting-input";
	if (IDLE_DONE_PATTERNS.some((re) => re.test(tail))) return "idle-done";
	return "streaming";
}

// Lines that are our own scaffolding or CLI/TUI chrome rather than agent
// content — dropped when capturing output for `agentOutput: file`. Also
// heuristic, and deliberately conservative: it only strips things we've
// directly observed, rather than trying to guess at everything a CLI might
// ever print.
const CHROME_LINE_PATTERNS: RegExp[] = [
	/^\$\s/, // our own "$ <bin> <args>" echo line
	/^❯\s/, // Claude Code's own echo of what was typed into its prompt box
	/^\[agent console\]/i, // our own start/exit marker lines
	/·\s*done\s+\d{1,2}:\d{2}\s*(am|pm)?/i, // the turn-completion summary line
	/shift\+tab to cycle/i, // persistent bottom status bar
	/bypass permissions on/i,
	/^[│╭╮╰╯─>\s]+$/, // box-drawing-only chrome (empty input box, etc.)
];

/**
 * Killing a session via completion: manual's "Complete" button (or a note
 * closing) sends SIGINT, which python's pty.spawn surfaces as a raw
 * KeyboardInterrupt traceback rather than a clean exit — verified live.
 * Dropped wholesale (start line through the unindented exception name that
 * ends it) rather than matched line-by-line, since the individual lines in
 * between (code context, `~~~~^^^^` markers) don't have a stable shape of
 * their own, and the traceback's start line can land mid a TUI redraw and
 * get composited onto part of an unrelated line.
 */
function stripPythonTraceback(lines: string[]): string[] {
	const out: string[] = [];
	let inTraceback = false;
	for (const line of lines) {
		if (!inTraceback && /traceback \(most recent call last\)/i.test(line)) {
			inTraceback = true;
			continue;
		}
		if (inTraceback) {
			if (/^[A-Za-z_][\w.]*(Error|Interrupt|Exception)\b/.test(line.trim()) && !/^\s/.test(line)) {
				inTraceback = false;
			}
			continue;
		}
		out.push(line);
	}
	return out;
}

/** Removes every whitespace character, so a text matches however a terminal wrapped it or trimmed the blanks at a row's end. */
function compact(text: string): string {
	return text.replace(/\s+/g, "");
}

// An echo of what was sent to the agent starts on a row like these (the
// same two shapes CHROME_LINE_PATTERNS drops): our own "$ <bin> <args>"
// line and Claude Code's "❯ <what was typed>" line.
const ECHO_START_RE = /^(?:\$|❯)\s/;

// A row that starts the agent's reply (Claude Code's "⏺" bullet, "●", and
// the "⎿" of a tool result). It ends the block of rows an echo row can claim
// text from, even when no blank row comes between them.
const REPLY_START_RE = /^[⏺●⎿]/;

/**
 * The rows that hold text typed into an `input:` field, so they can be
 * kept out of the file output (E6). Works on plain rows, whatever width
 * the terminal wrapped them at, so it can be tested without a terminal.
 *
 * Everything is compared with whitespace removed. A match is dropped
 * whole rows at a time, because the rows around the typed text also hold
 * flags or prompt text that goes with it. The rules:
 *
 *  - Echo: each "$ " or "❯ " row (unless it is only typed text) claims the first match of the first
 *    typed line that starts inside its own block of rows, plus the
 *    following typed lines for as long as they come directly after it.
 *    The block is the row itself and the non-blank rows directly after
 *    it, up to the next such row or a row that starts a reply (a "⏺", "●"
 *    or "⎿" bullet). This covers the wrapped continuation rows of the
 *    "$ <bin> <args>" echo and of the "❯" echo. Each echo row claims only
 *    one match, and only inside its block, so a reply further down that
 *    quotes the text (after a follow-up the user typed, or a "❯ 1. Yes"
 *    choice row) is not mistaken for an echo and is kept.
 *  - Prompt: with `composedPrompt` (the whole prompt that was sent), any
 *    place it is printed in full is dropped, and so is any one of its
 *    lines that holds typed text and sits alone on its rows. That is how
 *    an agent that prints the prompt back, in the middle of a sentence of
 *    the template, is caught.
 *  - Standalone: a typed line that covers whole rows exactly was printed
 *    on its own. A reply line that is word for word equal to a typed line
 *    is dropped too, as it cannot be told apart from an echo.
 *
 * A reply line that only contains the typed text next to other words is
 * kept. A short text (a few characters) can match inside the flags of the
 * "$" row first, in which case its real echo may stay: the typed text is
 * only reliably kept out when it is a few words long.
 */
function rowsOccupiedByTypedText(rows: string[], typedText: string, composedPrompt?: string): Set<number> {
	const dropped = new Set<number>();
	const typed = typedText
		.split(/\r\n|\r|\n/)
		.map(compact)
		.filter((line) => line !== "");
	if (typed.length === 0) return dropped;

	// One string of every row's non-blank characters, with the row each one came from.
	let stream = "";
	const rowOf: number[] = [];
	const firstOffset = new Map<number, number>();
	const lastOffset = new Map<number, number>();
	rows.forEach((row, y) => {
		const c = compact(row);
		if (c === "") return;
		firstOffset.set(y, stream.length);
		for (let i = 0; i < c.length; i++) rowOf.push(y);
		stream += c;
		lastOffset.set(y, stream.length - 1);
	});

	const dropRange = (from: number, to: number) => {
		for (let y = from; y <= to; y++) dropped.add(y);
	};
	// Drops the rows of every place `needle` covers whole rows exactly.
	const dropWhereAlone = (needle: string) => {
		for (let at = stream.indexOf(needle); at !== -1; at = stream.indexOf(needle, at + 1)) {
			const first = rowOf[at];
			const last = rowOf[at + needle.length - 1];
			if (firstOffset.get(first) === at && lastOffset.get(last) === at + needle.length - 1) dropRange(first, last);
		}
	};

	// Echo rows.
	const anchors: number[] = [];
	const typedAll = typed.join("");
	rows.forEach((row, y) => {
		// A row that is nothing but typed text is not an echo start, even if the
		// typed text itself begins with "$ " or "❯ ".
		if (ECHO_START_RE.test(row.trim()) && !typedAll.includes(compact(row))) anchors.push(y);
	});
	anchors.forEach((anchor, n) => {
		// The echo row and the non-blank rows directly after it (its wrapped
		// continuation), not past the next echo row or the start of a reply.
		const nextAnchor = n + 1 < anchors.length ? anchors[n + 1] : rows.length;
		let blockEnd = anchor;
		while (
			blockEnd + 1 < nextAnchor &&
			rows[blockEnd + 1].trim() !== "" &&
			!REPLY_START_RE.test(rows[blockEnd + 1].trim())
		) {
			blockEnd++;
		}
		const from = firstOffset.get(anchor) ?? stream.length;
		const at = stream.indexOf(typed[0], from);
		if (at === -1 || rowOf[at] > blockEnd) return;
		let end = at + typed[0].length;
		for (let i = 1; i < typed.length && stream.startsWith(typed[i], end); i++) end += typed[i].length;
		dropRange(rowOf[at], rowOf[end - 1]);
	});

	// The prompt printed back.
	const whole = composedPrompt === undefined ? "" : compact(composedPrompt);
	if (whole !== "") {
		for (let at = stream.indexOf(whole); at !== -1; at = stream.indexOf(whole, at + whole.length)) {
			dropRange(rowOf[at], rowOf[at + whole.length - 1]);
		}
		for (const line of composedPrompt?.split(/\r\n|\r|\n/) ?? []) {
			const c = compact(line);
			if (c !== "" && typed.some((t) => c.includes(t))) dropWhereAlone(c);
		}
	}

	// Standalone rows.
	for (const line of typed) dropWhereAlone(line);
	return dropped;
}

/**
 * The text-cleaning half of extractCleanText, over plain rows. Passing
 * `typedText` (the text submitted from an `input:` field) also drops the
 * rows it occupies, and `composedPrompt` (the whole prompt sent) helps find
 * them; without a typed text, or with a blank one, the result is exactly
 * what it was before `input:` existed.
 */
export function cleanOutputRows(rawLines: string[], typedText?: string, composedPrompt?: string): string {
	const withoutTraceback = stripPythonTraceback(rawLines);
	const typedRows =
		typedText === undefined ? new Set<number>() : rowsOccupiedByTypedText(withoutTraceback, typedText, composedPrompt);

	const kept = withoutTraceback.filter((line, y) => {
		if (typedRows.has(y)) return false;
		const trimmed = line.trim();
		if (!trimmed) return true;
		return !CHROME_LINE_PATTERNS.some((re) => re.test(trimmed));
	});

	const collapsed: string[] = [];
	let blankRun = 0;
	for (const line of kept) {
		if (line.trim() === "") {
			blankRun++;
			if (blankRun > 1) continue;
		} else {
			blankRun = 0;
		}
		collapsed.push(line);
	}

	return collapsed.join("\n").trim();
}

/**
 * Renders the whole current buffer to plain text and strips known chrome
 * lines, for `agentOutput: file`. This captures the full session transcript
 * (prompt echo already excluded, tool-call summaries and the agent's reply
 * included) rather than isolating just the final reply — doing real
 * semantic extraction of "the assistant's message" from rendered terminal
 * output would need much deeper knowledge of each CLI's exact formatting
 * than is safe to assume here. Good enough to drop into a note; not a
 * promise of a clean, chrome-free transcript in every case.
 *
 * `typedText` is the text submitted from an `input:` field, if any, and
 * `composedPrompt` the whole prompt that was sent: the rows the typed text
 * occupies, including wrapped continuation rows of the echoes, are dropped
 * as well (see rowsOccupiedByTypedText).
 */
export function extractCleanText(term: Terminal, typedText?: string, composedPrompt?: string): string {
	const buf = term.buffer.active;
	const rawLines: string[] = [];
	for (let y = 0; y < buf.length; y++) {
		const line = buf.getLine(y);
		if (line) rawLines.push(line.translateToString(true));
	}
	return cleanOutputRows(rawLines, typedText, composedPrompt);
}
