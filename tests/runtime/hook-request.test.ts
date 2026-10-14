import { test } from "node:test";
import assert from "node:assert/strict";
import { HOOK_PREFACE, buildHandoffMessage } from "../../src/runtime/message";
import { HOOK_TIMEOUT_MS, buildHookRequest, classifyHookOutcome } from "../../src/runtime/hookRequest";
import type { HttpOutcome } from "../../src/runtime/types";

test("G14: message starts with the preface line, then the prompt, a blank line, then Note: as the last line", () => {
	const message = buildHandoffMessage("Run the weekly review.", "/vault/notes/weekly.md", true);
	assert.equal(message, `${HOOK_PREFACE}\nRun the weekly review.\n\nNote: /vault/notes/weekly.md`);
	assert.ok(message.startsWith(HOOK_PREFACE));
	assert.ok(message.endsWith("Note: /vault/notes/weekly.md"));
});

test("G15: the chat kind's message has no preface", () => {
	const message = buildHandoffMessage("Run the weekly review.", "/vault/notes/weekly.md", false);
	assert.equal(message, "Run the weekly review.\n\nNote: /vault/notes/weekly.md");
	assert.ok(!message.includes(HOOK_PREFACE));
});

test("E9: a 200 KB prompt passes through the message builder completely unchanged, no truncation", () => {
	const bigPrompt = "x".repeat(200 * 1024);
	const message = buildHandoffMessage(bigPrompt, "/vault/note.md", false);
	assert.ok(message.includes(bigPrompt));
	assert.equal(message, `${bigPrompt}\n\nNote: /vault/note.md`);
});

test("G14: builds POST <base>/hooks/agent, bearer auth, Idempotency-Key, and the exact body shape", () => {
	const request = buildHookRequest({
		baseUrl: "http://127.0.0.1:18789",
		token: "tok-SECRET-123",
		agentId: "main",
		name: "weekly",
		sessionKey: "inline:weekly:1000",
		message: "hello",
	});
	assert.equal(request.url, "http://127.0.0.1:18789/hooks/agent");
	assert.equal(request.method, "POST");
	assert.equal(request.headers.Authorization, "Bearer tok-SECRET-123");
	assert.equal(request.headers["Content-Type"], "application/json");
	assert.ok(request.headers["Idempotency-Key"] && request.headers["Idempotency-Key"].length > 0);
	assert.deepEqual(JSON.parse(request.body ?? "{}"), {
		message: "hello",
		agentId: "main",
		name: "weekly",
		sessionKey: "inline:weekly:1000",
		sessionMode: "persistent",
		deliver: false,
	});
});

test("G14: a fresh Idempotency-Key is generated per call", () => {
	const params = {
		baseUrl: "http://x",
		token: undefined,
		agentId: "main",
		name: "n",
		sessionKey: "inline:n:1",
		message: "m",
	};
	const a = buildHookRequest(params);
	const b = buildHookRequest(params);
	assert.notEqual(a.headers["Idempotency-Key"], b.headers["Idempotency-Key"]);
});

test("no token configured: request has no Authorization header at all", () => {
	const request = buildHookRequest({
		baseUrl: "http://x",
		token: undefined,
		agentId: "main",
		name: "n",
		sessionKey: "inline:n:1",
		message: "m",
	});
	assert.equal(request.headers.Authorization, undefined);
});

test("trailing slash on baseUrl does not produce a double slash", () => {
	const request = buildHookRequest({
		baseUrl: "http://x/",
		token: undefined,
		agentId: "main",
		name: "n",
		sessionKey: "inline:n:1",
		message: "m",
	});
	assert.equal(request.url, "http://x/hooks/agent");
});

test("G14: HOOK_TIMEOUT_MS is 15 seconds (E2's timeout bound)", () => {
	assert.equal(HOOK_TIMEOUT_MS, 15000);
});

test("G14: success is HTTP 200 with ok:true and a non-empty runId", () => {
	const outcome: HttpOutcome = { kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "run-1" }) };
	assert.deepEqual(classifyHookOutcome(outcome), { kind: "ok", runId: "run-1" });
});

test("E4: 200 with ok:false gives an httpError, not an ok result", () => {
	const outcome: HttpOutcome = { kind: "response", status: 200, body: JSON.stringify({ ok: false }) };
	assert.deepEqual(classifyHookOutcome(outcome), { kind: "httpError", status: 200 });
});

test("E4: 200 with no runId gives an httpError", () => {
	const outcome: HttpOutcome = { kind: "response", status: 200, body: JSON.stringify({ ok: true }) };
	assert.deepEqual(classifyHookOutcome(outcome), { kind: "httpError", status: 200 });
});

test("E4: 200 with a malformed (non-JSON) body is treated as an httpError, not thrown", () => {
	const outcome: HttpOutcome = { kind: "response", status: 200, body: "not json" };
	assert.deepEqual(classifyHookOutcome(outcome), { kind: "httpError", status: 200 });
});

test("E3: 401 gives unauthorized", () => {
	assert.deepEqual(classifyHookOutcome({ kind: "response", status: 401 }), { kind: "unauthorized" });
});

test("E3: 403 gives unauthorized", () => {
	assert.deepEqual(classifyHookOutcome({ kind: "response", status: 403 }), { kind: "unauthorized" });
});

test("G14/E12: a 400 about the session-key policy is classified as sessionKeyRejected", () => {
	const outcome: HttpOutcome = {
		kind: "response",
		status: 400,
		body: JSON.stringify({ error: "allowRequestSessionKey is not enabled for this agent" }),
	};
	assert.deepEqual(classifyHookOutcome(outcome), { kind: "sessionKeyRejected" });
});

test("E4: any other 400 is reported by status only, not misclassified as a session-key rejection", () => {
	const outcome: HttpOutcome = { kind: "response", status: 400, body: JSON.stringify({ error: "bad agentId" }) };
	assert.deepEqual(classifyHookOutcome(outcome), { kind: "httpError", status: 400 });
});

test("E4: other HTTP statuses (5xx) are reported by status only", () => {
	assert.deepEqual(classifyHookOutcome({ kind: "response", status: 503 }), { kind: "httpError", status: 503 });
});

test("E2: timeout, refused and error outcomes are all classified as unreachable", () => {
	assert.deepEqual(classifyHookOutcome({ kind: "timeout" }), { kind: "unreachable" });
	assert.deepEqual(classifyHookOutcome({ kind: "refused" }), { kind: "unreachable" });
	assert.deepEqual(classifyHookOutcome({ kind: "error", reason: "request failed" }), { kind: "unreachable" });
});
