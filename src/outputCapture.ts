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

/**
 * Renders the whole current buffer to plain text and strips known chrome
 * lines, for `agentOutput: file`. This captures the full session transcript
 * (prompt echo already excluded, tool-call summaries and the agent's reply
 * included) rather than isolating just the final reply — doing real
 * semantic extraction of "the assistant's message" from rendered terminal
 * output would need much deeper knowledge of each CLI's exact formatting
 * than is safe to assume here. Good enough to drop into a note; not a
 * promise of a clean, chrome-free transcript in every case.
 */
export function extractCleanText(term: Terminal): string {
	const buf = term.buffer.active;
	const rawLines: string[] = [];
	for (let y = 0; y < buf.length; y++) {
		const line = buf.getLine(y);
		if (line) rawLines.push(line.translateToString(true));
	}

	const withoutTraceback = stripPythonTraceback(rawLines);

	const kept = withoutTraceback.filter((line) => {
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
