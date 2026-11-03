import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composePrompt, DEFAULT_INPUT_PLACEHOLDER, parseInputKey } from "../../src/inputPrompt";
import { renderPromptTemplate, type RenderPromptResult } from "../../src/templating";
import type { AgentContext } from "../../src/context";

const identity = (s: string): RenderPromptResult => ({ text: s });

test("token path: every {{ input }} is replaced by the typed text", () => {
	assert.equal(
		composePrompt("Merge into {{ input }} and archive", "Obsidian Atlas dark mode", identity).text,
		"Merge into Obsidian Atlas dark mode and archive",
	);
});

test("token path: the token is matched before rendering, so rendered output containing it is left alone", () => {
	// A frontmatter value or file name that renders to the literal token text.
	const render = (s: string): RenderPromptResult => ({ text: s.replace("{{ file.name }}", "{{ input }}") });
	const out = composePrompt("File {{ file.name }} -> {{ input }}", "X", render);
	assert.equal(out.text, "File {{ input }} -> X");
});

test("append path: text goes after exactly one newline", () => {
	assert.equal(composePrompt("Summarise this", "foo", identity).text, "Summarise this\nfoo");
});

test("append path: trailing newlines on the prompt are trimmed, trailing spaces kept", () => {
	for (const tail of ["\n", "\r\n", "\n\n\n", "\r\n\r\n", "\n\r\n"]) {
		assert.equal(composePrompt(`Summarise this${tail}`, "foo", identity).text, "Summarise this\nfoo", JSON.stringify(tail));
	}
	assert.equal(composePrompt("Summarise this  ", "foo", identity).text, "Summarise this  \nfoo");
	assert.equal(composePrompt("Summarise this  \n", "foo", identity).text, "Summarise this  \nfoo");
});

test("append path: an empty prompt gives just the typed text, no leading newline", () => {
	assert.equal(composePrompt("", "foo", identity).text, "foo");
	assert.equal(composePrompt("\n\n", "foo", identity).text, "foo");
});

const tokenTable: Array<[string, boolean]> = [
	["{{input}}", true],
	["{{ input }}", true],
	["{{   input   }}", true],
	["{{ input.x }}", false],
	["{{ Input }}", false],
	["{{ inputs }}", false],
	["{{= input }}", false],
	["{ input }", false],
];
for (const [token, matches] of tokenTable) {
	test(`token matching: ${token} ${matches ? "is replaced" : "is left alone and the append path is used"}`, () => {
		const out = composePrompt(`A ${token} B`, "TXT", identity).text;
		assert.equal(out, matches ? "A TXT B" : `A ${token} B\nTXT`);
	});
}

test("E1: typed template syntax comes through byte for byte in both paths, never evaluated or re-substituted", () => {
	const real = (s: string) => renderPromptTemplate(s, ctx, { allowJs: true });
	for (const typed of ["{{ file.path }}", "{{= 1+1 }}", "{{ input }}"]) {
		assert.equal(composePrompt("go {{ input }} now", typed, real).text, `go ${typed} now`);
		assert.equal(composePrompt("go", typed, real).text, `go\n${typed}`);
		assert.equal(composePrompt("go {{ input }} {{ input }}", typed, identity).text, `go ${typed} ${typed}`);
	}
});

test("E8: typed text is trimmed at both ends, interior is unchanged", () => {
	assert.equal(composePrompt("{{ input }}", "  a\n\n  b \n", identity).text, "a\n\n  b");
	assert.equal(composePrompt("p", " \t\n a\tb\n\nc \t\n ", identity).text, "p\na\tb\n\nc");
});

test("E9: three tokens, including adjacent and at the very start and end, all get the text", () => {
	const out = composePrompt("{{ input }}-{{input}}{{ input }}", "Z", identity).text;
	assert.equal(out, "Z-ZZ");
	assert.equal(out.includes("{{"), false);
	assert.equal(composePrompt("{{ input }} mid {{ input }} {{ input }}", "Z", identity).text, "Z mid Z Z");
});

test("E10: dollar patterns arrive unchanged in the token and append paths", () => {
	for (const typed of ["$&", "$1", "$'", "$`", "$$", "$<name>", "$& $1 $' $` $$ $<name>"]) {
		assert.equal(composePrompt("a {{ input }} b", typed, identity).text, `a ${typed} b`, typed);
		assert.equal(composePrompt("a {{ input }}$1{{ input }} b", typed, identity).text, `a ${typed}$1${typed} b`, typed);
		assert.equal(composePrompt("a (x)(y) $1", typed, identity).text, `a (x)(y) $1\n${typed}`, typed);
	}
});

test("multi-line and very long text is returned unchanged apart from the trim", () => {
	const long = "line one\nline two\n" + "x".repeat(100_000) + "\nend";
	const padded = `\n  ${long}  \n`;
	assert.equal(composePrompt("{{ input }}", padded, identity).text, long);
	assert.equal(composePrompt("p", padded, identity).text, `p\n${long}`);
});

test("unicode, emoji and CJK text pass through unchanged", () => {
	for (const typed of ["合并到 Atlas", "🚀 ship it 👩‍💻", "café ñ"]) {
		assert.equal(composePrompt("to {{ input }}!", typed, identity).text, `to ${typed}!`);
		assert.equal(composePrompt("to", typed, identity).text, `to\n${typed}`);
	}
});

test("a render error for any piece returns the error and the original template, with none of the typed text", () => {
	const fail = (s: string): RenderPromptResult => (s === " BAD " ? { text: s, error: "boom" } : { text: s });
	const typed = "SECRET-TYPED";
	const tokenPath = composePrompt("a {{ input }} BAD {{ input }}", typed, (s) => fail(s === " BAD " ? s : s));
	assert.equal(tokenPath.error, "boom");
	assert.equal(tokenPath.text, "a {{ input }} BAD {{ input }}");
	assert.equal(tokenPath.text.includes(typed), false);

	const appendPath = composePrompt("whole", typed, () => ({ text: "", error: "nope" }));
	assert.deepEqual(appendPath, { text: "whole", error: "nope" });

	// Error on the first piece only, and on the last piece only.
	for (const bad of ["a ", " b"]) {
		const r = composePrompt("a {{ input }} b", typed, (s) => (s === bad ? { text: s, error: "e" } : { text: s }));
		assert.equal(r.error, "e");
		assert.equal(r.text, "a {{ input }} b");
	}
});

test("composePrompt does not throw for empty text, an empty template, or a token-only template", () => {
	assert.doesNotThrow(() => composePrompt("", "", identity));
	assert.doesNotThrow(() => composePrompt("p", "", identity));
	assert.doesNotThrow(() => composePrompt("{{ input }}", "", identity));
	assert.equal(composePrompt("{{ input }}", "x", identity).text, "x");
	assert.equal(composePrompt("{{ input }}", "", identity).text, "");
	assert.equal(composePrompt("", "", identity).text, "");
});

test("F1: no carry-over between calls", () => {
	const first = composePrompt("p {{ input }}", "FIRST-TEXT", identity);
	const second = composePrompt("p {{ input }}", "second", identity);
	assert.equal(first.text, "p FIRST-TEXT");
	assert.equal(second.text, "p second");
	assert.equal(second.text.includes("FIRST"), false);
	const a = composePrompt("p", "FIRST-TEXT", identity);
	const b = composePrompt("p", "second", identity);
	assert.equal(b.text.includes("FIRST"), false);
	assert.equal(a.text, "p\nFIRST-TEXT");
});

test("F1: module source has no logging, storage, fs, obsidian import, require or module-level mutable state", () => {
	const src = readFileSync(resolve(import.meta.dirname, "../../src/inputPrompt.ts"), "utf8");
	for (const banned of ["console.", "localStorage", "sessionStorage", "saveData", "writeFile", 'from "obsidian"', "require("]) {
		assert.equal(src.includes(banned), false, `source must not contain ${banned}`);
	}
	assert.equal(/^(let|var)\s/m.test(src), false, "no module-level let/var");
	assert.equal(/^export\s+(let|var)\s/m.test(src), false);
});

const ctx: AgentContext = {
	file: {
		path: "Notes/a.md",
		basename: "a",
		name: "a.md",
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

test("F4: render is never given the typed text (spy, token and append paths)", () => {
	const typed = "TYPED-{{= 1+1 }}-{{ file.path }}";
	for (const template of ["x {{ input }} y {{ input }}", "x y", "", "{{ input }}"]) {
		const seen: string[] = [];
		composePrompt(template, typed, (s) => {
			seen.push(s);
			return { text: s };
		});
		assert.ok(seen.length > 0);
		for (const arg of seen) assert.equal(arg.includes("TYPED"), false, `render saw typed text for template ${JSON.stringify(template)}`);
	}
});

test("F4: with the real renderer and allowJs, typed {{= 1+1 }} is not evaluated but template expressions still are", () => {
	const real = (s: string) => renderPromptTemplate(s, ctx, { allowJs: true });
	const out = composePrompt("sum {{= 1+1 }} on {{ file.path }}: {{ input }}", "{{= 1+1 }}", real);
	assert.equal(out.error, undefined);
	assert.equal(out.text, "sum 2 on Notes/a.md: {{= 1+1 }}");
	assert.equal(composePrompt("sum", "{{= 1+1 }}", real).text, "sum\n{{= 1+1 }}");
});

test("a real render error (JS disabled) surfaces and keeps the typed text out", () => {
	const real = (s: string) => renderPromptTemplate(s, ctx, { allowJs: false });
	const out = composePrompt("{{= 1+1 }} {{ input }}", "typed-secret", real);
	assert.ok(out.error);
	assert.equal(out.text, "{{= 1+1 }} {{ input }}");
});

test("parseInputKey: placeholder, bare key, off spellings", () => {
	assert.equal(parseInputKey("Ticket to merge into"), "Ticket to merge into");
	assert.equal(parseInputKey("  Ticket  "), "Ticket");
	assert.equal(parseInputKey(""), DEFAULT_INPUT_PLACEHOLDER);
	assert.equal(parseInputKey("   "), DEFAULT_INPUT_PLACEHOLDER);
	assert.equal(DEFAULT_INPUT_PLACEHOLDER, "Type here");
	for (const off of ["false", "FALSE", "No", "off", "OFF", "0"]) assert.equal(parseInputKey(off), undefined, off);
	assert.equal(parseInputKey("false alarm"), "false alarm");
});
