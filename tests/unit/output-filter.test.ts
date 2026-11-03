import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/xterm";
import { cleanOutputRows, extractCleanText } from "../../src/outputCapture";
import { composePrompt } from "../../src/inputPrompt";
import { renderPromptTemplate } from "../../src/templating";
import type { AgentContext } from "../../src/context";

const { Terminal } = xterm;

// The agent-output filter for `input:` runs (E6): the typed text must not
// reach the note. The rows below are real: they were captured by running
// tests/support/stub-agent.sh through xterm.js (convertEol, the same
// "$ <bin> <args>" echo line buttonBlock.ts writes) at 40 and 80 columns.
// Prompts come from the real composer and renderer, nothing is mocked.

const context: AgentContext = {
	file: {
		path: "Notes/Roadmap.md",
		basename: "Roadmap",
		name: "Roadmap.md",
		folder: "Notes",
		extension: "md",
		frontmatter: {},
		tags: [],
		ctime: "",
		mtime: "",
	},
	vault: { name: "v", basePath: "/v" },
	date: { today: "2026-11-03", now: "2026-11-03T00:00:00.000Z" },
};

function compose(template: string, typed: string): string {
	const composed = composePrompt(template, typed, (segment) => renderPromptTemplate(segment, context, { allowJs: false }));
	assert.equal(composed.error, undefined);
	return composed.text;
}

const compact = (text: string) => text.replace(/\s+/g, "");

/** Every non-blank typed line is gone, however it was wrapped. */
function assertTypedTextAbsent(output: string, typed: string, label: string) {
	for (const line of typed.split("\n").map((l) => l.trim()).filter((l) => l !== "")) {
		assert.ok(!compact(output).includes(compact(line)), `${label}: "${line}" is still in the output:\n${output}`);
	}
}

const REPLY = "Stub reply: all done.";

interface Fixture {
	name: string;
	cols: number;
	template: string;
	typed: string;
	rows: string[];
}

const fixtures: Fixture[] = [
	{
		name: "single line, token in the middle, 40 columns",
		cols: 40,
		template: "Merge this ticket into {{ input }} and archive it",
		typed: "Obsidian Atlas dark mode",
		rows: [
			"$ /Users/danfletcher/.local/share/vector",
			"/tmp/worktrees/belsay-3/tests/support/st",
			'ub-agent.sh --dangerously-skip-permissio',
			'ns "Merge this ticket into Obsidian Atla',
			's dark mode and archive it"',
			"",
			"❯ Merge this ticket into Obsidian Atlas ",
			"dark mode and archive it",
			"Merge this ticket into Obsidian Atlas da",
			"rk mode and archive it",
			"",
			"Stub reply: all done.",
			"Crunched for 1s · done 2:54 PM",
			"",
			"[agent-console] process exited (code 0)",
		],
	},
	{
		name: "single line, token in the middle, 80 columns",
		cols: 80,
		template: "Merge this ticket into {{ input }} and archive it",
		typed: "Obsidian Atlas dark mode",
		rows: [
			"$ /Users/danfletcher/.local/share/vector/tmp/worktrees/belsay-3/tests/support/st",
			'ub-agent.sh --dangerously-skip-permissions "Merge this ticket into Obsidian Atla',
			's dark mode and archive it"',
			"",
			"❯ Merge this ticket into Obsidian Atlas dark mode and archive it",
			"Merge this ticket into Obsidian Atlas dark mode and archive it",
			"",
			"Stub reply: all done.",
			"Crunched for 1s · done 2:54 PM",
			"",
			"[agent-console] process exited (code 0)",
		],
	},
	{
		name: "three lines with $& and $1, appended, 80 columns",
		cols: 80,
		template: "Review these:",
		typed: "first $& line\nsecond $1 line {{ input }}",
		rows: [
			"$ /Users/danfletcher/.local/share/vector/tmp/worktrees/belsay-3/tests/support/st",
			'ub-agent.sh --dangerously-skip-permissions "Review these:',
			"first $& line",
			'second $1 line {{ input }}"',
			"",
			"❯ Review these:",
			"Review these:",
			"first $& line",
			"second $1 line {{ input }}",
			"",
			"Stub reply: all done.",
			"Crunched for 1s · done 2:54 PM",
			"",
			"[agent-console] process exited (code 0)",
		],
	},
	{
		name: "lines that start with '$ ' and '❯ ', one wrapping, 40 columns",
		cols: 40,
		template: "Do this for me:",
		typed: "$ rm the old draft\n❯ keep the new one\nthird line is rather long and will wrap at forty columns",
		rows: [
			"$ /Users/danfletcher/.local/share/vector",
			"/tmp/worktrees/belsay-3/tests/support/st",
			"ub-agent.sh --dangerously-skip-permissio",
			'ns "Do this for me:',
			"$ rm the old draft",
			"❯ keep the new one",
			"third line is rather long and will wrap ",
			'at forty columns"',
			"",
			"❯ Do this for me:",
			"Do this for me:",
			"$ rm the old draft",
			"❯ keep the new one",
			"third line is rather long and will wrap ",
			"at forty columns",
			"",
			"Stub reply: all done.",
			"Crunched for 1s · done 2:54 PM",
			"",
			"[agent-console] process exited (code 0)",
		],
	},
];

for (const fx of fixtures) {
	test(`E6: ${fx.name}: no typed line survives, the reply does (with the prompt)`, () => {
		const prompt = compose(fx.template, fx.typed);
		const out = cleanOutputRows(fx.rows, fx.typed, prompt);
		assertTypedTextAbsent(out, fx.typed, fx.name);
		assert.ok(out.includes(REPLY), out);
		assert.ok(!out.includes("Crunched for"), "the completion line is still dropped");
		assert.ok(!out.startsWith("$"), out);
	});

	test(`E6: ${fx.name}: no typed line survives without the prompt either, the reply does`, () => {
		const out = cleanOutputRows(fx.rows, fx.typed);
		// Without the prompt, the printed-back prompt can only be recognised
		// where the typed text stands alone on whole rows, so only the
		// fixtures built that way are checked on the printed-back copy.
		const echoRowsOnly = fx.rows.slice(0, fx.rows.indexOf(""));
		assertTypedTextAbsent(cleanOutputRows(echoRowsOnly, fx.typed), fx.typed, `${fx.name} (echo)`);
		assert.ok(out.includes(REPLY), out);
	});

	test(`F3: ${fx.name}: no typed text gives today's output, byte for byte`, () => {
		const today = cleanOutputRows(fx.rows);
		assert.equal(cleanOutputRows(fx.rows, undefined, "a prompt"), today);
		assert.equal(cleanOutputRows(fx.rows, ""), today);
		assert.equal(cleanOutputRows(fx.rows, "  \n\t\n ", "a prompt"), today);
	});
}

test("F3: today's output for the first fixture is the pinned text", () => {
	// Pinned from the code as it was before `input:` (no typed-text step):
	// only the first "$" row and the "❯" row go; the wrapped echo rows stay.
	assert.equal(
		cleanOutputRows(fixtures[0].rows),
		[
			"/tmp/worktrees/belsay-3/tests/support/st",
			"ub-agent.sh --dangerously-skip-permissio",
			'ns "Merge this ticket into Obsidian Atla',
			's dark mode and archive it"',
			"",
			"dark mode and archive it",
			"Merge this ticket into Obsidian Atlas da",
			"rk mode and archive it",
			"",
			"Stub reply: all done.",
			"",
			"[agent-console] process exited (code 0)",
		].join("\n")
	);
});

test("E6: what the rest of the output keeps: reply lines, one blank between runs, no traceback", () => {
	const typed = "Obsidian Atlas dark mode";
	const rows = [
		'$ stub "Merge into Obsidian Atlas dark mode"',
		"",
		"❯ Merge into Obsidian Atlas dark mode",
		"",
		"",
		"",
		"First reply line.",
		"",
		"",
		"Second reply line.",
		"Traceback (most recent call last):",
		'  File "x.py", line 1, in <module>',
		"KeyboardInterrupt",
		"Crunched for 1s · done 2:54 PM",
		"   ",
	];
	assert.equal(
		cleanOutputRows(rows, typed, "Merge into Obsidian Atlas dark mode"),
		["First reply line.", "", "Second reply line."].join("\n")
	);
});

test("E6: a reply line that only shares words with the typed text is kept", () => {
	const typed = "dark mode";
	const rows = [
		'$ stub "Switch to dark mode"',
		"",
		"❯ Switch to dark mode",
		"Switch to dark mode",
		"",
		"I switched the theme. Dark is now the mode of the vault.",
		"The dark side and the mode picker are unchanged.",
	];
	const out = cleanOutputRows(rows, typed, "Switch to dark mode");
	assert.ok(out.includes("I switched the theme. Dark is now the mode of the vault."), out);
	assert.ok(out.includes("The dark side and the mode picker are unchanged."), out);
	assert.ok(!out.includes("Switch to dark mode"), out);
});

test("E6: a typed text that is a substring of a reply line keeps that reply line", () => {
	const typed = "Atlas";
	const prompt = "Merge into Atlas now";
	const rows = [
		'$ stub "Merge into Atlas now"',
		"",
		"❯ Merge into Atlas now",
		"Merge into Atlas now",
		"",
		"Merged. The Atlas note now links back here.",
		"Atlas is up to date.",
	];
	const out = cleanOutputRows(rows, typed, prompt);
	assert.ok(out.includes("Merged. The Atlas note now links back here."), out);
	assert.ok(out.includes("Atlas is up to date."), out);
	assert.ok(!out.includes("Merge into Atlas now"), out);
});

test("E6: a follow-up '❯ ' row or a '❯ 1. Yes' choice row does not claim a later reply that quotes the typed text", () => {
	const typed = "Obsidian Atlas dark mode";
	const prompt = "Merge this ticket into Obsidian Atlas dark mode and archive it";
	const quoting = "⏺ Merged into Obsidian Atlas dark mode and archived the ticket.";
	const variants: Array<[string, string[]]> = [
		[
			"follow-up, reply directly after it",
			[`$ claude "${prompt}"`, "", `❯ ${prompt}`, "⏺ Shall I merge it?", "❯ yes go ahead", quoting, "Done."],
		],
		[
			"follow-up, blank row before the reply",
			[`$ claude "${prompt}"`, "", `❯ ${prompt}`, "⏺ Shall I merge it?", "", "❯ yes go ahead", "", quoting, "Done."],
		],
		[
			"choice row",
			[`$ claude "${prompt}"`, "", `❯ ${prompt}`, "⏺ Shall I merge it?", "❯ 1. Yes", "  2. No", "", quoting, "Done."],
		],
	];
	for (const [name, rows] of variants) {
		const out = cleanOutputRows(rows, typed, prompt);
		assert.ok(out.includes(quoting), `${name}: the reply quoting the typed text is kept:\n${out}`);
		assert.ok(out.includes("⏺ Shall I merge it?"), `${name}: the first reply line is kept:\n${out}`);
		assert.ok(out.endsWith("Done."), `${name}: the last line is kept:\n${out}`);
		assert.ok(!out.includes(`Merge this ticket into ${typed}`), `${name}: the prompt echo is still dropped:\n${out}`);
	}
});

test("E6: a typed line equal to a whole reply line is dropped (it cannot be told from an echo)", () => {
	// Known cost of the rule: a reply line that is word for word the typed
	// text goes with the echoes. The alternative would be keeping the
	// printed-back typed text whenever it stands alone on its rows.
	const typed = "Obsidian Atlas dark mode";
	const rows = [
		'$ stub "Merge into Obsidian Atlas dark mode"',
		"",
		"❯ Merge into Obsidian Atlas dark mode",
		"",
		"Obsidian Atlas dark mode",
		"Done.",
	];
	assert.equal(cleanOutputRows(rows, typed), "Done.");
});

test("E6: text containing $&, $1, $', {{ input }} and non-Latin characters is matched literally", () => {
	const typed = "price $& and $1 and $' {{ input }} 合并 票据";
	const prompt = compose("Do: {{ input }} please", typed);
	assert.equal(prompt, `Do: ${typed} please`);
	const rows = [`$ stub "${prompt}"`, "", `❯ ${prompt}`, "", REPLY];
	assert.equal(cleanOutputRows(rows, typed, prompt), REPLY);
});

test("E6: a typed text that starts with '$ ' or '❯ ' inside the echo is still removed", () => {
	const typed = "$ rm -rf build\n❯ then stop";
	const prompt = compose("Careful:", typed);
	const rows = [
		'$ stub "Careful:',
		"$ rm -rf build",
		'❯ then stop"',
		"",
		"❯ Careful:",
		"$ rm -rf build",
		"❯ then stop",
		"",
		REPLY,
	];
	const out = cleanOutputRows(rows, typed, prompt);
	// The printed-back prompt goes whole, including its template line.
	assert.equal(out, REPLY);
});

test("E6: empty or whitespace-only typed text drops nothing", () => {
	const rows = fixtures[0].rows;
	for (const typed of ["", " ", "\n", " \t\n  \n"]) {
		assert.equal(cleanOutputRows(rows, typed, "x"), cleanOutputRows(rows), JSON.stringify(typed));
	}
});

test("E6: text is matched however it is wrapped, 40 and 80 columns, soft-wrapped mid-word", () => {
	const typed = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
	const prompt = compose("Do {{ input }} now", typed);
	for (const cols of [40, 80]) {
		const wrap = (text: string): string[] => {
			const out: string[] = [];
			for (let i = 0; i < text.length; i += cols) out.push(text.slice(i, i + cols).replace(/\s+$/, ""));
			return out;
		};
		const rows = [...wrap(`$ /bin/stub --flag "${prompt}"`), "", ...wrap(`❯ ${prompt}`), ...wrap(prompt), "", REPLY];
		const out = cleanOutputRows(rows, typed, prompt);
		assertTypedTextAbsent(out, typed, `${cols} columns`);
		assert.ok(out.includes(REPLY), out);
	}
});

// --- Through a real xterm.js buffer, and extractCleanText itself ----------

const STUB = fileURLToPath(new URL("../support/stub-agent.sh", import.meta.url));

async function rowsThroughXterm(cols: number, prompt: string): Promise<Terminal> {
	const args = ["--dangerously-skip-permissions", prompt];
	const output = execFileSync(STUB, args).toString();
	const term = new Terminal({ cols, rows: 24, convertEol: true, scrollback: 5000, allowProposedApi: true });
	// The same echo line buttonBlock.ts writes, then the agent's output, then the exit line.
	const echo = `\x1b[2m$ ${STUB} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\x1b[0m\r\n\r\n`;
	const data = `${echo}${output}\r\n\x1b[2m[agent-console] process exited (code 0)\x1b[0m\r\n`;
	await new Promise<void>((resolve) => term.write(data, resolve));
	return term;
}

const xtermCases: { name: string; template: string; typed: string }[] = [
	{ name: "golden path", template: "Merge this ticket into {{ input }} and archive it", typed: "Obsidian Atlas dark mode" },
	{ name: "three lines with $&", template: "Review these:", typed: "first $& line\nsecond $1 line\nthird {{ input }} line" },
	{
		name: "long text that wraps",
		template: "Context: {{ file.basename }}",
		typed: "this is a long line of typed text that is certain to wrap in a terminal that is only forty columns wide, and then some more",
	},
];

for (const cols of [40, 80]) {
	for (const c of xtermCases) {
		test(`E6 (real xterm, ${cols} columns): ${c.name}: extractCleanText leaves the reply and none of the typed text`, async () => {
			const prompt = compose(c.template, c.typed);
			const term = await rowsThroughXterm(cols, prompt);
			try {
				const out = extractCleanText(term, c.typed, prompt);
				assertTypedTextAbsent(out, c.typed, c.name);
				assert.ok(out.includes(REPLY), out);
				assert.ok(!out.includes("Crunched for"), out);
				// The same terminal without a typed text still shows it: the filter is what removes it.
				assert.ok(compact(extractCleanText(term)).includes(compact(c.typed.split("\n")[0])), "control: today's output has the typed text");
			} finally {
				term.dispose();
			}
		});
	}
}
