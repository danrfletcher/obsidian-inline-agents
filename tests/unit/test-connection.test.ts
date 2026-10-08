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
	const result = await testConnection({ baseUrl: "http://x", tokenRequired: true }, "", httpFn);
	assert.equal(result.ok, false);
	assert.equal(called, false);
});

test("2xx response reports reachable with the status code", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: false },
		"",
		fakeHttpFn({ kind: "response", status: 200 })
	);
	assert.equal(result.ok, true);
	assert.match(result.message, /200/);
});

test("401 reports token rejected", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 401 })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /401/);
});

test("403 reports token rejected", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 403 })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /403/);
});

test("5xx reports a server error", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "response", status: 503 })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /503/);
});

test("timeout reports a timeout, no status code", async () => {
	const result = await testConnection({ baseUrl: "http://x", tokenRequired: true }, SENTINEL_TOKEN, fakeHttpFn({ kind: "timeout" }));
	assert.equal(result.ok, false);
	assert.match(result.message, /[Tt]imed out/);
});

test("refused reports connection refused", async () => {
	const result = await testConnection({ baseUrl: "http://x", tokenRequired: true }, SENTINEL_TOKEN, fakeHttpFn({ kind: "refused" }));
	assert.equal(result.ok, false);
	assert.match(result.message, /refused/i);
});

test("G3: never POSTs to a prompt endpoint — only a GET against the base URL", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection({ baseUrl: "http://x/agent-runtime", tokenRequired: false }, "", fakeHttpFn({ kind: "response", status: 200 }, capture));
	assert.equal(capture.request?.method, "GET");
	assert.equal(capture.request?.url, "http://x/agent-runtime");
	assert.ok(!capture.request?.body);
});

test("F6: sends only Authorization: Bearer <token>, no other header", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection({ baseUrl: "http://x", tokenRequired: true }, SENTINEL_TOKEN, fakeHttpFn({ kind: "response", status: 200 }, capture));
	assert.deepEqual(capture.request?.headers, { Authorization: `Bearer ${SENTINEL_TOKEN}` });
});

test("F6: no Authorization header at all when no token is entered and none is required", async () => {
	const capture: { request?: HttpRequest } = {};
	await testConnection({ baseUrl: "http://x", tokenRequired: false }, "", fakeHttpFn({ kind: "response", status: 200 }, capture));
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
	for (const outcome of outcomes) {
		const result = await testConnection({ baseUrl: "http://x", tokenRequired: true }, SENTINEL_TOKEN, fakeHttpFn(outcome));
		assert.ok(!result.message.includes(SENTINEL_TOKEN), `leaked token for outcome ${JSON.stringify(outcome)}`);
	}
	// And the "token required but not entered" short-circuit path too.
	const shortCircuit = await testConnection({ baseUrl: "http://x", tokenRequired: true }, "", async () => {
		throw new Error("should not be called");
	});
	assert.ok(!shortCircuit.message.includes(SENTINEL_TOKEN));
});

test("F5: an 'error' outcome's reason is surfaced but never the raw token even if a caller tried to misuse it", async () => {
	const result = await testConnection(
		{ baseUrl: "http://x", tokenRequired: true },
		SENTINEL_TOKEN,
		fakeHttpFn({ kind: "error", reason: "request failed" })
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /request failed/);
	assert.ok(!result.message.includes(SENTINEL_TOKEN));
});
