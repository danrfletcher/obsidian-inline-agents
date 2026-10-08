import { test } from "node:test";
import assert from "node:assert/strict";
import { parseButtonBlock, resolveModel } from "../../src/buttonParse";

test("target: is parsed, trimmed, and case preserved", () => {
	assert.equal(parseButtonBlock("target: openclaw").target, "openclaw");
	assert.equal(parseButtonBlock("target:   OpenClaw  ").target, "OpenClaw");
	assert.equal(parseButtonBlock("target: terminal").target, "terminal");
});

test("target: absent leaves target undefined", () => {
	assert.equal(parseButtonBlock("text: Run it\nprompt: hi").target, undefined);
});

test("target: empty value leaves target as empty string, not undefined", () => {
	// An explicit but blank `target:` line still sets the key (resolveTargetName
	// treats "" the same as "no target:" — see target-resolve.test.ts).
	assert.equal(parseButtonBlock("target: ").target, "");
});

test("open: recognizes true-ish and false-ish spellings case-insensitively", () => {
	for (const v of ["true", "TRUE", "yes", "on", "1"]) {
		assert.equal(parseButtonBlock(`open: ${v}`).open, true, `open: ${v} should be true`);
	}
	for (const v of ["false", "FALSE", "no", "off", "0"]) {
		assert.equal(parseButtonBlock(`open: ${v}`).open, false, `open: ${v} should be false`);
	}
});

test("open: malformed or empty leaves open undefined (falls back to settings default)", () => {
	assert.equal(parseButtonBlock("open: maybe").open, undefined);
	assert.equal(parseButtonBlock("open: ").open, undefined);
	assert.equal(parseButtonBlock("text: x").open, undefined);
});

test("open: tolerates surrounding whitespace", () => {
	assert.equal(parseButtonBlock("open:   true  ").open, true);
	assert.equal(parseButtonBlock("open:   off  ").open, false);
});

test("agentId: is parsed and trimmed", () => {
	assert.equal(parseButtonBlock("agentId: main").agentId, "main");
	assert.equal(parseButtonBlock("agentId:   main  ").agentId, "main");
});

test("agentId: key match is case-insensitive, value case is preserved", () => {
	assert.equal(parseButtonBlock("AGENTID: Main-Agent").agentId, "Main-Agent");
	assert.equal(parseButtonBlock("AgentId: Main-Agent").agentId, "Main-Agent");
});

test("repeated keys: last occurrence wins for target, open and agentId", () => {
	const spec = parseButtonBlock(["target: terminal", "target: openclaw", "open: true", "open: false", "agentId: a", "agentId: b"].join("\n"));
	assert.equal(spec.target, "openclaw");
	assert.equal(spec.open, false);
	assert.equal(spec.agentId, "b");
});

test("unknown keys are ignored and do not affect target/open/agentId parsing", () => {
	const spec = parseButtonBlock(["target: openclaw", "totallyMadeUpKey: whatever", "open: true", "agentId: main"].join("\n"));
	assert.equal(spec.target, "openclaw");
	assert.equal(spec.open, true);
	assert.equal(spec.agentId, "main");
});

test("blank lines and comment lines are skipped", () => {
	const spec = parseButtonBlock(["# a comment", "", "target: openclaw", "   ", "agentId: main"].join("\n"));
	assert.equal(spec.target, "openclaw");
	assert.equal(spec.agentId, "main");
});

test("0.2.1 keys: all original fields still parse unchanged", () => {
	const source = [
		"text: Run Sufficiency Check",
		"prompt: Run teacher-artefact-sufficiency-check.md on {{file.path}}",
		"autoApprove: true",
		"agent: ClaudeCode",
		"model: myMainModel",
		"agentOutput: file",
		"append: belowButton",
		"showTerminal: false",
		"completion: responseEnd",
	].join("\n");
	const spec = parseButtonBlock(source);
	assert.equal(spec.text, "Run Sufficiency Check");
	assert.equal(spec.prompt, "Run teacher-artefact-sufficiency-check.md on {{file.path}}");
	assert.equal(spec.autoApprove, true);
	assert.equal(spec.agent, "claude");
	assert.equal(spec.model, "myMainModel");
	assert.equal(spec.agentOutput, "file");
	assert.equal(spec.append, "belowButton");
	assert.equal(spec.showTerminal, false);
	assert.equal(spec.completion, "responseEnd");
	// And the new fields default to undefined when their lines are absent.
	assert.equal(spec.target, undefined);
	assert.equal(spec.open, undefined);
	assert.equal(spec.agentId, undefined);
});

test("defaults: text and prompt fall back when absent; everything else stays undefined", () => {
	const spec = parseButtonBlock("");
	assert.equal(spec.text, "Run agent");
	assert.equal(spec.prompt, "");
	assert.equal(spec.autoApprove, undefined);
	assert.equal(spec.agent, undefined);
	assert.equal(spec.model, undefined);
	assert.equal(spec.agentOutput, undefined);
	assert.equal(spec.append, undefined);
	assert.equal(spec.showTerminal, undefined);
	assert.equal(spec.completion, undefined);
	assert.equal(spec.target, undefined);
	assert.equal(spec.open, undefined);
	assert.equal(spec.agentId, undefined);
});

test("resolveModel: matches a mapping name case-insensitively", () => {
	const mappings = [{ name: "myMainModel", model: "claude-sonnet-5" }];
	assert.equal(resolveModel("mymainmodel", mappings), "claude-sonnet-5");
	assert.equal(resolveModel("MyMainModel", mappings), "claude-sonnet-5");
});

test("resolveModel: falls through to the literal value when no mapping matches", () => {
	const mappings = [{ name: "myMainModel", model: "claude-sonnet-5" }];
	assert.equal(resolveModel("some-literal-model-id", mappings), "some-literal-model-id");
});

test("resolveModel: undefined input stays undefined", () => {
	assert.equal(resolveModel(undefined, []), undefined);
});
