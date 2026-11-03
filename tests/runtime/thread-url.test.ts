import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThreadUrl, openThreadUrl, threadLinkHref } from "../../src/runtime/threadUrl";

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

// --- R1: the settled "↗" link's href (buttonBlock.ts) -------------------

test("R1: threadLinkHref is '#' when there is no thread URL at all", () => {
	assert.equal(threadLinkHref(undefined), "#");
});

test("R1: threadLinkHref passes through an allowed-scheme URL unchanged", () => {
	assert.equal(threadLinkHref("https://example.com/thread/1"), "https://example.com/thread/1");
	assert.equal(threadLinkHref("hermes://thread/1"), "hermes://thread/1");
});

test("R1: threadLinkHref is '#' (never the raw URL) for a disallowed scheme, in any case", () => {
	for (const scheme of ["file", "FILE", "javascript", "JavaScript", "data", "DATA", "vbscript", "VBScript"]) {
		assert.equal(threadLinkHref(`${scheme}:something`), "#");
	}
});

// --- G8: the {sessionId} placeholder ----------------------------------

const WEEKLY_KEY = "inline:weekly-review:1793618103221";
const WEEKLY_ID = "inline-weekly-review-1793618103221";
const WEEKLY_VARS = { agentId: "main", sessionKey: WEEKLY_KEY, sessionId: WEEKLY_ID };

test("G8: {sessionId} fill rule, every placeholder combination", () => {
	const table: { name: string; template: string | undefined; expected: string | undefined }[] = [
		{ name: "one", template: "hermes://open/{sessionId}", expected: `hermes://open/${WEEKLY_ID}` },
		{ name: "many", template: "x://{sessionId}/{sessionId}?a={sessionId}", expected: `x://${WEEKLY_ID}/${WEEKLY_ID}?a=${WEEKLY_ID}` },
		{
			name: "with {sessionKey} and {sessionKeyPath}",
			template: "x://{sessionId}|{sessionKey}|{sessionKeyPath}",
			expected: `x://${WEEKLY_ID}|${WEEKLY_KEY}|inline/weekly-review/1793618103221`,
		},
		{
			name: "all four, reversed order and repeated",
			template: "x://{sessionKeyPath}|{sessionKey}|{sessionId}|{agentId}|{sessionKey}|{sessionKeyPath}|{sessionId}",
			expected: `x://inline/weekly-review/1793618103221|${WEEKLY_KEY}|${WEEKLY_ID}|main|${WEEKLY_KEY}|inline/weekly-review/1793618103221|${WEEKLY_ID}`,
		},
		{ name: "none (old placeholders only)", template: "x://{agentId}/{sessionKeyPath}", expected: "x://main/inline/weekly-review/1793618103221" },
		{ name: "no placeholder at all", template: "x://static", expected: "x://static" },
		{ name: "surrounding whitespace is trimmed", template: "  hermes://open/{sessionId}  ", expected: `hermes://open/${WEEKLY_ID}` },
		{ name: "undefined template", template: undefined, expected: undefined },
		{ name: "empty template", template: "", expected: undefined },
		{ name: "whitespace-only template", template: "  \t ", expected: undefined },
	];
	for (const row of table) {
		assert.equal(buildThreadUrl(row.template, WEEKLY_VARS), row.expected, row.name);
	}
});

test("G8: {sessionId} is inserted verbatim, never URL-encoded, while {sessionKey} keeps its ':'", () => {
	const url = buildThreadUrl("x://{sessionId}?k={sessionKey}", WEEKLY_VARS);
	assert.equal(url, `x://${WEEKLY_ID}?k=${WEEKLY_KEY}`);
	assert.ok(!(url ?? "").includes("%"));
	assert.ok(!WEEKLY_ID.includes(":"));
	// Verbatim even for a value that encodeURIComponent would change.
	assert.equal(buildThreadUrl("x://{sessionId}", { ...WEEKLY_VARS, sessionId: "a_b-c9" }), "x://a_b-c9");
});

test("G8: {sessionKey} does not eat {sessionKeyPath} nor {sessionId}, and vice versa", () => {
	assert.equal(buildThreadUrl("{sessionKey}", WEEKLY_VARS), WEEKLY_KEY);
	assert.equal(buildThreadUrl("{sessionKeyPath}", WEEKLY_VARS), "inline/weekly-review/1793618103221");
	assert.equal(buildThreadUrl("{sessionId}", WEEKLY_VARS), WEEKLY_ID);
	assert.equal(buildThreadUrl("{sessionIdX}{sessionKeyPat}", WEEKLY_VARS), "{sessionIdX}{sessionKeyPat}");
});

test("G8: templates without {sessionId} give the same output whether or not an id is passed (0.3.1 output unchanged)", () => {
	const templates = [
		"https://hermes.example/t/{agentId}/{sessionKey}",
		"hermes://thread/{sessionKeyPath}",
		"https://x/{sessionKeyPath}?raw={sessionKey}",
		"https://x/{agentId}/{agentId}",
	];
	for (const template of templates) {
		assert.equal(
			buildThreadUrl(template, { agentId: "main", sessionKey: "inline:weekly:1000", sessionId: "inline-weekly-1000" }),
			buildThreadUrl(template, { agentId: "main", sessionKey: "inline:weekly:1000" }),
			template
		);
	}
});

test("GP1/GP5: openThreadUrl accepts hermes://open/<id> and hands that exact URL to the opener", () => {
	const opened: string[] = [];
	const url = `hermes://open/${WEEKLY_ID}`;
	assert.deepEqual(openThreadUrl(url, (u) => opened.push(u)), { opened: true });
	assert.deepEqual(opened, [url]);
});

test("GP1: the four disallowed schemes are still refused in any case, including with an id-shaped path", () => {
	for (const scheme of ["file", "FILE", "javascript", "JavaScript", "data", "DATA", "vbscript", "VBScript"]) {
		const opened: string[] = [];
		const result = openThreadUrl(`${scheme}:${WEEKLY_ID}`, (u) => opened.push(u));
		assert.equal(result.opened, false, scheme);
		assert.ok(result.reason?.includes(scheme.toLowerCase()) || result.reason?.includes(scheme), scheme);
		assert.ok(!(result.reason ?? "").includes(WEEKLY_ID), "reason never contains the id");
		assert.deepEqual(opened, []);
	}
});

test("GP5: threadLinkHref returns the hermes://open/<id> URL, and '#' for a disallowed scheme", () => {
	const url = `hermes://open/${WEEKLY_ID}`;
	assert.equal(threadLinkHref(url), url);
	assert.equal(threadLinkHref(buildThreadUrl("hermes://open/{sessionId}", WEEKLY_VARS)), url);
	assert.equal(threadLinkHref(buildThreadUrl("javascript:{sessionId}", WEEKLY_VARS)), "#");
	assert.equal(threadLinkHref(buildThreadUrl("file:///{sessionId}", WEEKLY_VARS)), "#");
});
