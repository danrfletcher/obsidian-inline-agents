import { test } from "node:test";
import assert from "node:assert/strict";
import { testConnection } from "../../src/runtime/testConnection";
import type { HttpFn, HttpOutcome, HttpRequest } from "../../src/runtime/types";

const SENTINEL_TOKEN = "sk-sentinel-do-not-leak-6f2a9c";

function fakeHttpFn(outcome: HttpOutcome, capture?: { request?: HttpRequest }): HttpFn {
	return async (request) => {
		if (capture) capture.request = request;
		return outcome;
	};
}

test("tokenRequired with no token entered fails without calling the HTTP function at all", async () => {
	let called = false;
	const httpFn: HttpFn = async () => {
		called = true;
		return { kind: "response", status: 200 };
	};
	const result = await testConnection({ baseUrl: "http://x", tokenRequired: true, kind: "openclaw-hook" }, "", httpFn);
	assert.equal(result.ok, false);
	assert.equal(called, false);
});

test("2xx response reports reachable with the status code", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: false, kind: "openclaw-hook" },
		"",
		fakeHttpFn({ kind: "response", status: 200 })
	);
	assert.equal(result.ok, true);
	assert.match(result.message, /200/);
});

test("401 reports token rejected", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true, kind: "openai-chat" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 401 })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /401/);
});

test("403 reports token rejected", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true, kind: "openai-chat" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 403 })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /403/);
});

test("5xx reports a server error", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true, kind: "openai-chat" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 503 })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /503/);
});

test("timeout reports a timeout, no status code", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true, kind: "openclaw-hook" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "timeout" })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /[Tt]imed out/);
});

test("refused reports connection refused", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true, kind: "openclaw-hook" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "refused" })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /refused/i);
});

test("G3: never POSTs to a prompt endpoint — only a GET, never /hooks/agent or /chat/completions", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection(
		{ baseUrl: "http://x/agent-runtime", tokenRequired: false, kind: "openclaw-hook" },
		"",
		fakeHttpFn({ kind: "response", status: 200 }, capture)
	);
	assert.equal(capture.request?.method, "GET");
	assert.equal(capture.request?.url, "http://x/agent-runtime");
	assert.ok(!capture.request?.body);
});

test("R2: openai-chat kind checks GET <baseUrl>/models — an auth-protected, non-prompt endpoint", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection(
		{ baseUrl: "https://api.example.com/v1", tokenRequired: true, kind: "openai-chat" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 200 }, capture)
	);
	assert.equal(capture.request?.method, "GET");
	assert.equal(capture.request?.url, "https://api.example.com/v1/models");
});

test("R2: openai-chat kind strips a trailing slash from the base URL before appending /models", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection(
		{ baseUrl: "https://api.example.com/v1/", tokenRequired: false, kind: "openai-chat" },
		"",
		fakeHttpFn({ kind: "response", status: 200 }, capture)
	);
	assert.equal(capture.request?.url, "https://api.example.com/v1/models");
});

test("R2: openclaw-hook kind checks GET on the bare base URL (no hook endpoint can verify a token without a prompt)", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection(
		{ baseUrl: "http://127.0.0.1:18789", tokenRequired: true, kind: "openclaw-hook" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 200 }, capture)
	);
	assert.equal(capture.request?.url, "http://127.0.0.1:18789");
});

test("R2: a reachable openclaw-hook result says it only checked reachability, not the token", async () => {
	const result = await testConnection(
		{ baseUrl: "http://127.0.0.1:18789", tokenRequired: true, kind: "openclaw-hook" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 200 })
	);
	assert.equal(result.ok, true);
	assert.match(result.message, /only checks reachability/i);
});

test("R2: a reachable openai-chat result does not carry the hook reachability-only caveat", async () => {
	const result = await testConnection(
		{ baseUrl: "https://api.example.com", tokenRequired: true, kind: "openai-chat" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 200 })
	);
	assert.equal(result.ok, true);
	assert.ok(!/only checks reachability/i.test(result.message));
});

test("F6: sends only Authorization: Bearer <token>, no other header", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection(
		{ baseUrl: "http://x", tokenRequired: true, kind: "openclaw-hook" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 200 }, capture)
	);
	assert.deepEqual(capture.request?.headers, { Authorization: `Bearer ${SENTINEL_TOKEN}` });
});

test("F6: no Authorization header at all when no token is entered and none is required", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection(
		{ baseUrl: "http://x", tokenRequired: false, kind: "openclaw-hook" },
		"",
		fakeHttpFn({ kind: "response", status: 200 }, capture)
	);
	assert.deepEqual(capture.request?.headers, {});
});

test("F5: no outcome's message ever contains the sentinel token", async () => {
	const outcomes: HttpOutcome[] = [
		{ kind: "response", status: 200 },
		{ kind: "response", status: 401 },
		{ kind: "response", status: 403 },
		{ kind: "response", status: 503 },
		{ kind: "timeout" },
		{ kind: "refused" },
		{ kind: "error", reason: "request failed" },
	];
	for (const kind of ["openclaw-hook", "openai-chat"] as const) {
		for (const outcome of outcomes) {
			const result = await testConnection({ baseUrl: "http://x", tokenRequired: true, kind }, SENTINEL_TOKEN, fakeHttpFn(outcome));
			assert.ok(!result.message.includes(SENTINEL_TOKEN), `leaked token for outcome ${JSON.stringify(outcome)} (${kind})`);
		}
	}
	// And the "token required but not entered" short-circuit path too.
	const shortCircuit = await testConnection({ baseUrl: "http://x", tokenRequired: true, kind: "openclaw-hook" }, "", async () => {
		throw new Error("should not be called");
	});
	assert.ok(!shortCircuit.message.includes(SENTINEL_TOKEN));
});

test("F5: an 'error' outcome's reason is surfaced but never the raw token even if a caller tried to misuse it", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true, kind: "openclaw-hook" },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "error", reason: "request failed" })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /request failed/);
	assert.ok(!result.message.includes(SENTINEL_TOKEN));
});
