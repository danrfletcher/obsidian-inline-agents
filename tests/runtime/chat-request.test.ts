import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_HTTP_TIMEOUT_MS, buildChatRequest, classifyChatOutcome } from "../../src/runtime/chatRequest";
import type { HttpOutcome } from "../../src/runtime/types";

test("G15: builds POST <base>/chat/completions, bearer auth, one user message, session key in `user`", () => {
	const request = buildChatRequest({
		baseUrl: "https://api.example.com",
		token: "tok-SECRET-123",
		model: "gpt-4o",
		message: "hello\n\nNote: /vault/note.md",
		sessionKey: "inline:note:1000",
		sendSessionKeyHeader: false,
	});
	assert.equal(request.url, "https://api.example.com/chat/completions");
	assert.equal(request.method, "POST");
	assert.equal(request.headers.Authorization, "Bearer tok-SECRET-123");
	assert.equal(request.headers["x-openclaw-session-key"], undefined);
	assert.deepEqual(JSON.parse(request.body ?? "{}"), {
		model: "gpt-4o",
		messages: [{ role: "user", content: "hello\n\nNote: /vault/note.md" }],
		user: "inline:note:1000",
		stream: false,
	});
});

test("G15: x-openclaw-session-key is sent only when the runtime's own box for it is on", () => {
	const withHeader = buildChatRequest({
		baseUrl: "http://x",
		token: undefined,
		model: "m",
		message: "msg",
		sessionKey: "inline:note:1",
		sendSessionKeyHeader: true,
	});
	assert.equal(withHeader.headers["x-openclaw-session-key"], "inline:note:1");

	const withoutHeader = buildChatRequest({
		baseUrl: "http://x",
		token: undefined,
		model: "m",
		message: "msg",
		sessionKey: "inline:note:1",
		sendSessionKeyHeader: false,
	});
	assert.equal(withoutHeader.headers["x-openclaw-session-key"], undefined);
});

test("no token configured: request has no Authorization header at all", () => {
	const request = buildChatRequest({
		baseUrl: "http://x",
		token: undefined,
		model: "m",
		message: "msg",
		sessionKey: "inline:note:1",
		sendSessionKeyHeader: false,
	});
	assert.equal(request.headers.Authorization, undefined);
});

test("trailing slash on baseUrl does not produce a double slash", () => {
	const request = buildChatRequest({
		baseUrl: "http://x/",
		token: undefined,
		model: "m",
		message: "msg",
		sessionKey: "inline:note:1",
		sendSessionKeyHeader: false,
	});
	assert.equal(request.url, "http://x/chat/completions");
});

test("G15: no preface and no agentId/name fields in the chat body", () => {
	const request = buildChatRequest({
		baseUrl: "http://x",
		token: undefined,
		model: "m",
		message: "msg",
		sessionKey: "inline:note:1",
		sendSessionKeyHeader: false,
	});
	const body = JSON.parse(request.body ?? "{}");
	assert.equal(Object.prototype.hasOwnProperty.call(body, "agentId"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(body, "name"), false);
});

test("E9: a 200 KB message passes through the request body completely unchanged", () => {
	const bigMessage = "x".repeat(200 * 1024);
	const request = buildChatRequest({
		baseUrl: "http://x",
		token: undefined,
		model: "m",
		message: bigMessage,
		sessionKey: "inline:note:1",
		sendSessionKeyHeader: false,
	});
	const body = JSON.parse(request.body ?? "{}");
	assert.equal(body.messages[0].content, bigMessage);
});

test("G15: CHAT_HTTP_TIMEOUT_MS is a generous ceiling, not the 5-second settle rule", () => {
	assert.ok(CHAT_HTTP_TIMEOUT_MS > 5000);
});

test("classifies a 2xx response as accepted", () => {
	const outcome: HttpOutcome = { kind: "response", status: 200 };
	assert.deepEqual(classifyChatOutcome(outcome), { kind: "accepted" });
});

test("G15: the response body is never read by the chat classifier, even if present and malformed", () => {
	const outcome: HttpOutcome = { kind: "response", status: 200, body: "{not valid json" };
	assert.deepEqual(classifyChatOutcome(outcome), { kind: "accepted" });
});

test("E3: 401/403 classify as unauthorized", () => {
	assert.deepEqual(classifyChatOutcome({ kind: "response", status: 401 }), { kind: "unauthorized" });
	assert.deepEqual(classifyChatOutcome({ kind: "response", status: 403 }), { kind: "unauthorized" });
});

test("E4: other non-2xx statuses classify by status only", () => {
	assert.deepEqual(classifyChatOutcome({ kind: "response", status: 400 }), { kind: "httpError", status: 400 });
	assert.deepEqual(classifyChatOutcome({ kind: "response", status: 500 }), { kind: "httpError", status: 500 });
});

test("G12: network failures (timeout, refused, error) classify as unreachable", () => {
	assert.deepEqual(classifyChatOutcome({ kind: "timeout" }), { kind: "unreachable" });
	assert.deepEqual(classifyChatOutcome({ kind: "refused" }), { kind: "unreachable" });
	assert.deepEqual(classifyChatOutcome({ kind: "error", reason: "request failed" }), { kind: "unreachable" });
});
