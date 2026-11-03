import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseButtonBlock } from "../../src/buttonParse";
import { composePrompt, DEFAULT_INPUT_PLACEHOLDER } from "../../src/inputPrompt";
import { renderPromptTemplate } from "../../src/templating";
import type { AgentContext } from "../../src/context";

const root = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

/** Every ```agent-button fenced block body in a markdown file, in order. */
function agentButtonBlocks(markdown: string): string[] {
	const out: string[] = [];
	const re = /^[ \t]*```agent-button[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
	for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) out.push(m[1]);
	return out;
}

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
	date: {} as AgentContext["date"],
};

test("G11: the examples page's input example parses and composes to the prompt its prose promises", () => {
	const examples = read("docs/docs/examples.md");
	const blocks = agentButtonBlocks(examples).filter((b) => /^input:/m.test(b));
	assert.equal(blocks.length, 1, "expected exactly one input example on the examples page");

	const spec = parseButtonBlock(blocks[0]);
	assert.ok(spec.text.length > 0, "text is empty");
	assert.ok(spec.prompt.length > 0, "prompt is empty");
	assert.ok(spec.input !== undefined && spec.input.length > 0, "placeholder is empty");
	assert.match(spec.prompt, /\{\{ input \}\}/);

	const composed = composePrompt(spec.prompt, "Obsidian Atlas dark mode", (s) =>
		renderPromptTemplate(s, ctx, { allowJs: false }),
	);
	assert.equal(composed.error, undefined);
	assert.equal(composed.text, "Summarize what this note says about Obsidian Atlas dark mode in three bullet points.");

	// The page's prose quotes the placeholder and the composed prompt.
	assert.ok(examples.includes(`"${spec.input}"`), "prose does not quote the placeholder");
	assert.ok(examples.includes(`\`${composed.text}\``), "prose does not quote the composed prompt");
});

for (const file of ["docs/docs/reference/fields.md", "README.md"]) {
	const blocks = agentButtonBlocks(read(file));
	const inputLines = blocks.flatMap((b, i) =>
		b
			.split("\n")
			.filter((l) => /^input:/i.test(l))
			.map((l) => ({ block: i, line: l, source: b })),
	);

	test(`G11: ${file} shows at least one input: line in an agent-button block`, () => {
		if (file.endsWith("fields.md")) assert.ok(inputLines.length > 0, "no input: line found in any code block");
	});

	for (const { block, line, source } of inputLines) {
		test(`G11: ${file} block ${block}: "${line}" parses`, () => {
			const spec = parseButtonBlock(source);
			assert.ok(spec.input === undefined || spec.input.length > 0);
		});
	}
}

test("G11: the documented key spellings parse as the reference page says", () => {
	assert.equal(DEFAULT_INPUT_PLACEHOLDER, "Type here");
	assert.ok(read("docs/docs/reference/fields.md").includes(`"${DEFAULT_INPUT_PLACEHOLDER}"`));
	assert.equal(parseButtonBlock("text: a\nprompt: b\ninput:").input, "Type here");
	for (const off of ["false", "no", "off", "0", "OFF"]) {
		assert.equal(parseButtonBlock(`text: a\nprompt: b\ninput: ${off}`).input, undefined, off);
	}
	assert.equal(parseButtonBlock("text: a\nprompt: b\ninput: Ticket: name or id").input, "Ticket: name or id");
});
