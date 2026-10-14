import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRunner, createSingleFlightHandoff } from "../../src/runtime/handoff";
import type { HandoffHooks, HandoffInput } from "../../src/runtime/handoff";
import type { AgentRuntime, HttpFn, HttpOutcome, HttpRequest } from "../../src/runtime/types";

function hookRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
	return {
		id: "openclaw-id",
		name: "openclaw",
		kind: "openclaw-hook",
		baseUrl: "http://127.0.0.1:18789",
		agentId: "main",
		tokenRequired: false,
		sendSessionKeyHeader: false,
		threadUrlTemplate: "hermes://thread/{sessionKeyPath}",
		...overrides,
	};
}

function chatRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
	return {
		id: "hermes-id",
		name: "hermes",
		kind: "openai-chat",
		baseUrl: "https://api.example.com",
		agentId: "gpt-4o",
		tokenRequired: false,
		sendSessionKeyHeader: false,
		threadUrlTemplate: "hermes://thread/{sessionKeyPath}",
		...overrides,
	};
}

function baseInput(runtime: AgentRuntime, overrides: Partial<HandoffInput> = {}): HandoffInput {
	return {
		runtime,
		prompt: "Run the weekly review.",
		notePath: "/vault/weekly.md",
		noteBasename: "weekly",
		openRequested: true,
		token: undefined,
		...overrides,
	};
}

interface Recorder {
	notices: string[];
	sendingCalls: number;
	sentUrls: (string | undefined)[];
	fallbackCalls: number;
	openedUrls: string[];
	hooks: HandoffHooks;
}

function makeRecorder(httpFn: HttpFn, nowMs: () => number = () => 1000): Recorder {
	const notices: string[] = [];
	const sentUrls: (string | undefined)[] = [];
	const openedUrls: string[] = [];
	const rec: Recorder = {
		notices,
		sendingCalls: 0,
		sentUrls,
		fallbackCalls: 0,
		openedUrls,
		hooks: {
			httpFn,
			nowMs,
			openUrl: (url) => openedUrls.push(url),
			notify: (message) => notices.push(message),
			onSending: () => {
				rec.sendingCalls++;
			},
			onSent: (threadUrl) => sentUrls.push(threadUrl),
			fallbackToTerminal: () => {
				rec.fallbackCalls++;
			},
		},
	};
	return rec;
}

function fakeHttpFn(outcome: HttpOutcome, captured: HttpRequest[] = []): HttpFn {
	return async (request) => {
		captured.push(request);
		return outcome;
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function flushMicrotasks(times = 6): Promise<void> {
	let p: Promise<unknown> = Promise.resolve();
	for (let i = 0; i < times; i++) p = p.then(() => undefined);
	return p as Promise<void>;
}

// --- States (G7/G9) ---------------------------------------------------

test("G7: onSending fires once per hand-off, before the request settles", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.sendingCalls, 1);
});

test("G9: on success with a template, onSent receives the built thread URL", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));
	await runner.runHandoff(baseInput(hookRuntime(), { noteBasename: "weekly" }), rec.hooks);
	assert.equal(rec.sentUrls.length, 1);
	assert.match(rec.sentUrls[0] ?? "", /^hermes:\/\/thread\/inline\/weekly\/\d+$/);
	assert.deepEqual(rec.openedUrls, rec.sentUrls as string[]);
});

test("G9: on success with no template, onSent receives undefined and nothing is opened", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));
	const runtime = hookRuntime({ threadUrlTemplate: undefined });
	await runner.runHandoff(baseInput(runtime), rec.hooks);
	assert.deepEqual(rec.sentUrls, [undefined]);
	assert.deepEqual(rec.openedUrls, []);
});

test("GP6: open: false still builds and reports the thread URL, it just isn't opened", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));
	await runner.runHandoff(baseInput(hookRuntime(), { openRequested: false }), rec.hooks);
	assert.equal(rec.sentUrls.length, 1);
	assert.ok(rec.sentUrls[0]);
	assert.deepEqual(rec.openedUrls, []);
});

// --- G10: every later click is independent --------------------------

test("G10: a later click starts a new thread with a new session key, not the same one", async () => {
	const runner = createHandoffRunner();
	const captured: HttpRequest[] = [];
	const rec = makeRecorder(
		fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }, captured)
	);
	let now = 1000;
	rec.hooks.nowMs = () => now;
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	now = 2000;
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(captured.length, 2);
	const key1 = (JSON.parse(captured[0].body ?? "{}") as { sessionKey: string }).sessionKey;
	const key2 = (JSON.parse(captured[1].body ?? "{}") as { sessionKey: string }).sessionKey;
	assert.notEqual(key1, key2);
});

// --- G7/E10: double click is single-flight ----------------------------

test("E10/G7: a second click while a hand-off is in flight is ignored outright", async () => {
	const runner = createHandoffRunner();
	const pending = deferred<HttpOutcome>();
	let callCount = 0;
	const httpFn: HttpFn = async () => {
		callCount++;
		return pending.promise;
	};
	const rec = makeRecorder(httpFn);
	const guarded = createSingleFlightHandoff(runner.runHandoff);

	const first = guarded(baseInput(hookRuntime()), rec.hooks);
	const second = guarded(baseInput(hookRuntime()), rec.hooks); // should be a no-op
	pending.resolve({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) });
	await Promise.all([first, second]);

	assert.equal(callCount, 1);
	assert.equal(rec.sendingCalls, 1);
	assert.equal(rec.sentUrls.length, 1);
});

test("E10: a click after the previous one has settled starts a genuinely new hand-off", async () => {
	const runner = createHandoffRunner();
	const captured: HttpRequest[] = [];
	const httpFn = fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }, captured);
	const rec = makeRecorder(httpFn);
	const guarded = createSingleFlightHandoff(runner.runHandoff);

	await guarded(baseInput(hookRuntime()), rec.hooks);
	await guarded(baseInput(hookRuntime()), rec.hooks);

	assert.equal(captured.length, 2);
	assert.equal(rec.sendingCalls, 2);
});

// --- E5: once-per-runtime-per-session notice --------------------------

test("E5: no template + open on gives the 'no thread URL' notice once; a second click gives no second notice", async () => {
	const runner = createHandoffRunner();
	const runtime = hookRuntime({ threadUrlTemplate: undefined });
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));

	await runner.runHandoff(baseInput(runtime), rec.hooks);
	await runner.runHandoff(baseInput(runtime), rec.hooks);

	const warnings = rec.notices.filter((n) => /no thread-url template/i.test(n));
	assert.equal(warnings.length, 1);
});

test("E5: no template + open off gives no 'no thread URL' notice at all", async () => {
	const runner = createHandoffRunner();
	const runtime = hookRuntime({ threadUrlTemplate: undefined });
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));

	await runner.runHandoff(baseInput(runtime, { openRequested: false }), rec.hooks);

	assert.deepEqual(rec.notices, []);
});

test("E5: the once-per-session notice is shared across the runner, not per HandoffInput object", async () => {
	const runner = createHandoffRunner();
	const runtimeA = hookRuntime({ threadUrlTemplate: undefined, id: "r-a", name: "r-a" });
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));

	await runner.runHandoff(baseInput(runtimeA), rec.hooks);
	// A different runtime id still gets its own first-time notice.
	const runtimeB = hookRuntime({ threadUrlTemplate: undefined, id: "r-b", name: "r-b" });
	await runner.runHandoff(baseInput(runtimeB), rec.hooks);

	const warnings = rec.notices.filter((n) => /no thread-url template/i.test(n));
	assert.equal(warnings.length, 2);
});

// --- E8: empty prompt --------------------------------------------------

test("E8: an empty prompt sends nothing, shows a notice, and does not start the terminal", async () => {
	const runner = createHandoffRunner();
	let httpCalled = false;
	const rec = makeRecorder(async () => {
		httpCalled = true;
		return { kind: "response", status: 200 };
	});
	await runner.runHandoff(baseInput(hookRuntime(), { prompt: "   " }), rec.hooks);
	assert.equal(httpCalled, false);
	assert.equal(rec.sendingCalls, 0);
	assert.equal(rec.fallbackCalls, 0);
	assert.equal(rec.notices.length, 1);
});

// --- Token missing (E6, the fallback half new in this PR) -------------

test("E6: a token-required runtime with no token skips the request entirely and falls back to the terminal", async () => {
	const runner = createHandoffRunner();
	let httpCalled = false;
	const rec = makeRecorder(async () => {
		httpCalled = true;
		return { kind: "response", status: 200 };
	});
	const runtime = hookRuntime({ tokenRequired: true });
	await runner.runHandoff(baseInput(runtime, { token: undefined }), rec.hooks);
	assert.equal(httpCalled, false);
	assert.equal(rec.sendingCalls, 0);
	assert.equal(rec.fallbackCalls, 1);
});

// --- Hook kind failure fallbacks (E2/E3/E4/E12) -------------------------

test("E2: a hook 'unreachable' outcome (timeout/refused/error) gives a reason notice, then falls back", async () => {
	for (const outcome of [{ kind: "timeout" }, { kind: "refused" }, { kind: "error", reason: "x" }] as HttpOutcome[]) {
		const runner = createHandoffRunner();
		const rec = makeRecorder(fakeHttpFn(outcome));
		await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
		assert.equal(rec.fallbackCalls, 1);
		assert.equal(rec.notices.length, 1);
		assert.match(rec.notices[0], /isn't reachable, running here/);
		assert.equal(rec.sentUrls.length, 0);
	}
});

test("E3: a hook 401/403 gives exactly 'token rejected', then falls back", async () => {
	for (const status of [401, 403]) {
		const runner = createHandoffRunner();
		const rec = makeRecorder(fakeHttpFn({ kind: "response", status }));
		await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
		assert.equal(rec.fallbackCalls, 1);
		assert.deepEqual(rec.notices, ["token rejected"]);
	}
});

test("E4: any other hook HTTP status gives a status-only notice, then falls back", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 503 }));
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.fallbackCalls, 1);
	assert.equal(rec.notices.length, 1);
	assert.match(rec.notices[0], /503/);
});

test("E4: 200 with ok:false or no runId gives a status-only notice, then falls back", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: false }) }));
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.fallbackCalls, 1);
	assert.match(rec.notices[0], /200/);
});

test("E12: a 400 session-key policy error shows the fixed message, then falls back", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(
		fakeHttpFn({
			kind: "response",
			status: 400,
			body: JSON.stringify({ error: "allowRequestSessionKey disabled" }),
		})
	);
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.fallbackCalls, 1);
	assert.deepEqual(rec.notices, [
		"OpenClaw rejected the session key: enable allowRequestSessionKey and allow the inline: prefix",
	]);
});

// --- Chat kind and the 5-second rule (G12/G13) --------------------------

test("G12: a chat error that arrives before 5s falls back to the terminal with a notice", async () => {
	const runner = createHandoffRunner();
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async () => pending.promise);
	const runPromise = runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
	pending.resolve({ kind: "response", status: 500 });
	await runPromise;
	assert.equal(rec.fallbackCalls, 1);
	assert.equal(rec.sentUrls.length, 0);
	assert.match(rec.notices[0], /500/);
});

test("G12: 5 seconds pass with no error: the hand-off settles even though the request is still pending", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createHandoffRunner();
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async () => pending.promise);
	const runPromise = runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
	t.mock.timers.tick(5000);
	await runPromise;
	assert.equal(rec.sentUrls.length, 1);
	assert.equal(rec.fallbackCalls, 0);
});

test("G13: an error arriving after settling at 5s is a notice only — the terminal never runs", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createHandoffRunner();
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async () => pending.promise);
	const runPromise = runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
	t.mock.timers.tick(5000);
	await runPromise;
	assert.equal(rec.sentUrls.length, 1);

	pending.resolve({ kind: "response", status: 500 });
	await flushMicrotasks();

	assert.equal(rec.fallbackCalls, 0);
	assert.equal(rec.notices.length, 1);
	assert.match(rec.notices[0], /500/);
});

test("G13: a late success after settling at 5s produces no extra notice", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createHandoffRunner();
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async () => pending.promise);
	const runPromise = runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
	t.mock.timers.tick(5000);
	await runPromise;

	pending.resolve({ kind: "response", status: 200 });
	await flushMicrotasks();

	assert.equal(rec.fallbackCalls, 0);
	assert.equal(rec.notices.length, 0);
	assert.equal(rec.sentUrls.length, 1);
});
