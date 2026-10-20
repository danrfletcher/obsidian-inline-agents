import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpFn } from "../../src/runtime/httpCore";
import type { HttpTimers, Transport } from "../../src/runtime/httpCore";
import type { HttpRequest } from "../../src/runtime/types";

const REQUEST: HttpRequest = { url: "http://x/hooks/agent", method: "POST", headers: {}, body: "{}" };

/** Timers backed by node:test's mock timers (global setTimeout resolved at call time). */
const timers: HttpTimers = {
	setTimer: (callback, ms) => setTimeout(callback, ms),
	clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function neverResolves(): Transport {
	return () => new Promise(() => {});
}

test("G14/E2: the HttpFn resolves to a timeout outcome once the configured ceiling passes, and not before", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const httpFn = createHttpFn(neverResolves(), 15000, timers);
	let outcome: unknown;
	const p = httpFn(REQUEST).then((o) => (outcome = o));

	t.mock.timers.tick(14999);
	await Promise.resolve();
	assert.equal(outcome, undefined, "still waiting at 14999 ms");

	t.mock.timers.tick(1);
	await p;
	assert.deepEqual(outcome, { kind: "timeout" });
});

test("a response before the ceiling wins, and a later timer firing changes nothing", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const httpFn = createHttpFn(async () => ({ status: 200, readText: () => "" }), 15000, timers);
	const outcome = await httpFn(REQUEST);
	assert.deepEqual(outcome, { kind: "response", status: 200 });
	t.mock.timers.tick(20000);
});

test("G15: the response text is not read unless the request asks for it", async () => {
	let reads = 0;
	const transport: Transport = async () => ({
		status: 200,
		readText: () => {
			reads++;
			return "BODY";
		},
	});
	const httpFn = createHttpFn(transport, 1000, timers);

	const chatLike = await httpFn(REQUEST);
	assert.equal(reads, 0, "readText must not be called for a request without readBody");
	assert.deepEqual(chatLike, { kind: "response", status: 200 });

	const hookLike = await httpFn({ ...REQUEST, readBody: true });
	assert.equal(reads, 1);
	assert.deepEqual(hookLike, { kind: "response", status: 200, body: "BODY" });
});

test("F5: a transport error is reduced to a fixed outcome that never echoes the error text", async () => {
	const secretError = new Error("failed to reach http://x with Bearer tok-SECRET-123");
	const outcome = await createHttpFn(async () => Promise.reject(secretError), 1000, timers)(REQUEST);
	assert.deepEqual(outcome, { kind: "error", reason: "request failed" });
});

test("a refused connection is reported as refused", async () => {
	const outcome = await createHttpFn(async () => Promise.reject(new Error("net::ERR_CONNECTION_REFUSED")), 1000, timers)(REQUEST);
	assert.deepEqual(outcome, { kind: "refused" });
});

test("a transport that throws synchronously still resolves (never rejects) to the fixed error outcome", async () => {
	const transport: Transport = () => {
		throw new Error("sync boom Bearer tok-SECRET-123");
	};
	const outcome = await createHttpFn(transport, 1000, timers)(REQUEST);
	assert.deepEqual(outcome, { kind: "error", reason: "request failed" });
});

test("a readText that throws is reduced to the fixed error outcome", async () => {
	const transport: Transport = async () => ({
		status: 200,
		readText: () => {
			throw new Error("bad body Bearer tok-SECRET-123");
		},
	});
	const outcome = await createHttpFn(transport, 1000, timers)({ ...REQUEST, readBody: true });
	assert.deepEqual(outcome, { kind: "error", reason: "request failed" });
});

test("the timer is cleared once a response arrives", async () => {
	const cleared: unknown[] = [];
	const spyTimers: HttpTimers = {
		setTimer: () => "handle-1",
		clearTimer: (handle) => cleared.push(handle),
	};
	await createHttpFn(async () => ({ status: 204, readText: () => "" }), 1000, spyTimers)(REQUEST);
	assert.deepEqual(cleared, ["handle-1"]);
});
