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
		sessionId: "inline-note-1",
		sendSessionIdHeader: false,
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
		sessionId: "inline-note-1",
		sendSessionIdHeader: false,
	});
	assert.equal(withHeader.headers["x-openclaw-session-key"], "inline:note:1");

	const withoutHeader = buildChatRequest({
		baseUrl: "http://x",
		token: undefined,
		model: "m",
		message: "msg",
		sessionKey: "inline:note:1",
		sendSessionKeyHeader: false,
		sessionId: "inline-note-1",
		sendSessionIdHeader: false,
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
		sessionId: "inline-note-1",
		sendSessionIdHeader: false,
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
		sessionId: "inline-note-1",
		sendSessionIdHeader: false,
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
		sessionId: "inline-note-1",
		sendSessionIdHeader: false,
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
		sessionId: "inline-note-1",
		sendSessionIdHeader: false,
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

// --- Session id header (G5, E13, F7) ----------------------------------

const SESSION_KEY = "inline:weekly-review:1793618103221";
const SESSION_ID = "inline-weekly-review-1793618103221";

function sessionRequest(overrides: Partial<Parameters<typeof buildChatRequest>[0]>) {
	return buildChatRequest({
		baseUrl: "http://127.0.0.1:8642/v1",
		token: "tok-SECRET-123",
		model: "hermes-agent",
		message: "hello",
		sessionKey: SESSION_KEY,
		sendSessionKeyHeader: false,
		sessionId: SESSION_ID,
		sendSessionIdHeader: false,
		...overrides,
	});
}

test("G5/GP4: toggle on sends X-Hermes-Session-Id (exact casing) and body user = the session id, not the key", () => {
	const request = sessionRequest({ sendSessionIdHeader: true });
	assert.equal(request.url, "http://127.0.0.1:8642/v1/chat/completions");
	assert.deepEqual(request.headers, {
		"Content-Type": "application/json",
		Authorization: "Bearer tok-SECRET-123",
		"X-Hermes-Session-Id": SESSION_ID,
	});
	assert.ok(Object.keys(request.headers).includes("X-Hermes-Session-Id"));
	assert.deepEqual(JSON.parse(request.body ?? "{}"), {
		model: "hermes-agent",
		messages: [{ role: "user", content: "hello" }],
		user: SESSION_ID,
		stream: false,
	});
	assert.ok(!(request.headers["X-Hermes-Session-Id"] ?? "").includes(":"));
	assert.ok(!(request.body ?? "").includes(SESSION_KEY));
});

test("G5/F7: toggle off is byte for byte the previous request, with user = session key and no session-id header", () => {
	const request = sessionRequest({ sendSessionIdHeader: false });
	assert.deepEqual(request.headers, {
		"Content-Type": "application/json",
		Authorization: "Bearer tok-SECRET-123",
	});
	assert.equal(
		request.body,
		JSON.stringify({
			model: "hermes-agent",
			messages: [{ role: "user", content: "hello" }],
			user: SESSION_KEY,
			stream: false,
		})
	);
});

test("added: both toggles on sends the colon key in x-openclaw-session-key and the id in X-Hermes-Session-Id", () => {
	const request = sessionRequest({ sendSessionKeyHeader: true, sendSessionIdHeader: true });
	assert.equal(request.headers["x-openclaw-session-key"], SESSION_KEY);
	assert.equal(request.headers["X-Hermes-Session-Id"], SESSION_ID);
	assert.equal(JSON.parse(request.body ?? "{}").user, SESSION_ID);
});

test("added: session-key toggle on alone leaves the id header off and user = session key", () => {
	const request = sessionRequest({ sendSessionKeyHeader: true });
	assert.equal(request.headers["x-openclaw-session-key"], SESSION_KEY);
	assert.equal(request.headers["X-Hermes-Session-Id"], undefined);
	assert.equal(JSON.parse(request.body ?? "{}").user, SESSION_KEY);
});
