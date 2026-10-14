import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThreadUrl, openThreadUrl } from "../../src/runtime/threadUrl";

test("G9: fills {agentId} and {sessionKey} into the template", () => {
	const url = buildThreadUrl("https://hermes.example/t/{agentId}/{sessionKey}", {
		agentId: "main",
		sessionKey: "inline:weekly:1000",
	});
	assert.equal(url, "https://hermes.example/t/main/inline:weekly:1000");
});

test("G9: {sessionKeyPath} is the session key split on ':' and rejoined with '/'", () => {
	const url = buildThreadUrl("hermes://thread/{sessionKeyPath}", {
		agentId: "main",
		sessionKey: "inline:weekly:1000",
	});
	assert.equal(url, "hermes://thread/inline/weekly/1000");
});

test("G9: {sessionKeyPath} and {sessionKey} can both appear without clobbering each other", () => {
	const url = buildThreadUrl("https://x/{sessionKeyPath}?raw={sessionKey}", {
		agentId: "main",
		sessionKey: "inline:weekly:1000",
	});
	assert.equal(url, "https://x/inline/weekly/1000?raw=inline:weekly:1000");
});

test("G9: multiple occurrences of the same placeholder are all filled", () => {
	const url = buildThreadUrl("https://x/{agentId}/{agentId}", { agentId: "main", sessionKey: "inline:a:1" });
	assert.equal(url, "https://x/main/main");
});

test("E5: an undefined template returns undefined (fire-and-forget, nothing to open)", () => {
	assert.equal(buildThreadUrl(undefined, { agentId: "main", sessionKey: "inline:a:1" }), undefined);
});

test("E5: a whitespace-only template returns undefined", () => {
	assert.equal(buildThreadUrl("   ", { agentId: "main", sessionKey: "inline:a:1" }), undefined);
});

test("G9: http(s) and custom-scheme URLs are opened via the injected open function", () => {
	const opened: string[] = [];
	const result = openThreadUrl("https://example.com/thread/1", (url) => opened.push(url));
	assert.deepEqual(result, { opened: true });
	assert.deepEqual(opened, ["https://example.com/thread/1"]);
});

test("G1/G9: a made-up custom app scheme (e.g. hermes://) is accepted and opened", () => {
	const opened: string[] = [];
	const result = openThreadUrl("hermes://thread/1", (url) => opened.push(url));
	assert.deepEqual(result, { opened: true });
	assert.deepEqual(opened, ["hermes://thread/1"]);
});

test("G1/G9: file, javascript, data and vbscript schemes are never opened and give a notice reason, in any case", () => {
	for (const scheme of ["file", "FILE", "javascript", "JavaScript", "data", "DATA", "vbscript", "VBScript"]) {
		const opened: string[] = [];
		const result = openThreadUrl(`${scheme}:something`, (url) => opened.push(url));
		assert.equal(result.opened, false);
		assert.ok(result.reason && result.reason.length > 0, `expected a reason for scheme ${scheme}`);
		assert.deepEqual(opened, []);
	}
});

test("a URL with no scheme at all is never opened", () => {
	const opened: string[] = [];
	const result = openThreadUrl("not-a-url", (url) => opened.push(url));
	assert.equal(result.opened, false);
	assert.deepEqual(opened, []);
});
