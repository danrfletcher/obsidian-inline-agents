import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRunner, createSingleFlightHandoff, handoffAbortedNotice } from "../../src/runtime/handoff";
import { createClickHandler } from "../../src/runtime/clickFlow";
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
	abortedCalls: number;
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
		abortedCalls: 0,
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
			onAborted: () => {
				rec.abortedCalls++;
			},
			// Resolves the global `setTimeout` at call time, so a test's
			// `mock.timers.enable` takes effect.
			setTimer: (callback, ms) => {
				setTimeout(callback, ms);
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
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
	// R2: a late failure gets its own wording — never the pre-send
	// "isn't reachable, running here" (the terminal is not, in fact,
	// running) and it must say no fallback happened.
	assert.match(rec.notices[0], /500/);
	assert.doesNotMatch(rec.notices[0], /running here/);
	assert.match(rec.notices[0], /no fallback ran/);
});

test("G13/R2: a late 401/403 after settling says the token was rejected after accepting, not the pre-send 'token rejected' wording", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createHandoffRunner();
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async () => pending.promise);
	const runPromise = runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
	t.mock.timers.tick(5000);
	await runPromise;

	pending.resolve({ kind: "response", status: 401 });
	await flushMicrotasks();

	assert.equal(rec.fallbackCalls, 0);
	assert.equal(rec.notices.length, 1);
	assert.notEqual(rec.notices[0], "token rejected");
	assert.match(rec.notices[0], /no fallback ran/);
});

test("G13/R2: a late connection failure (refused/error) after settling says the runtime failed, not that the terminal is running", async (t) => {
	for (const outcome of [{ kind: "refused" }, { kind: "error", reason: "x" }] as HttpOutcome[]) {
		await t.test(`outcome ${outcome.kind}`, async (st) => {
			st.mock.timers.enable({ apis: ["setTimeout"] });
			const runner = createHandoffRunner();
			const pending = deferred<HttpOutcome>();
			const rec = makeRecorder(async () => pending.promise);
			const runPromise = runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
			st.mock.timers.tick(5000);
			await runPromise;

			pending.resolve(outcome);
			await flushMicrotasks();

			assert.equal(rec.fallbackCalls, 0);
			assert.equal(rec.notices.length, 1);
			assert.doesNotMatch(rec.notices[0], /running here/);
			assert.match(rec.notices[0], /no fallback ran/);
		});
	}
});

test("G13/R2: a late timeout after settling produces no notice at all — the HttpFn's own ceiling firing isn't a confirmed failure", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createHandoffRunner();
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async () => pending.promise);
	const runPromise = runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
	t.mock.timers.tick(5000);
	await runPromise;
	assert.equal(rec.sentUrls.length, 1);

	pending.resolve({ kind: "timeout" });
	await flushMicrotasks();

	assert.equal(rec.fallbackCalls, 0);
	assert.equal(rec.notices.length, 0);
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


// --- PR-1.F1 R4: anything that throws after onSending resets the button ----

const LEAKY_ERROR = "boom: Bearer tok-SECRET-123 at http://internal/hooks/agent";

test("R4: an HttpFn that rejects (hook kind) never rejects runHandoff — one fixed notice, then onAborted resets the button", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(async () => {
		throw new Error(LEAKY_ERROR);
	});
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.sendingCalls, 1);
	assert.equal(rec.abortedCalls, 1);
	assert.deepEqual(rec.notices, [handoffAbortedNotice("openclaw")]);
	assert.equal(rec.sentUrls.length, 0);
	assert.equal(rec.fallbackCalls, 0, "an unexpected throw must not silently start a terminal run");
	assert.ok(!rec.notices.join("").includes("SECRET"), "the thrown error's text is never surfaced");
});

test("R4: an HttpFn that rejects before 5s (chat kind) resets the button the same way", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(async () => {
		throw new Error(LEAKY_ERROR);
	});
	await runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
	assert.equal(rec.abortedCalls, 1);
	assert.deepEqual(rec.notices, [handoffAbortedNotice("hermes")]);
});

test("R4: an HttpFn that rejects after the 5s settle is swallowed — no abort (the button already says Sent), no unhandled rejection", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createHandoffRunner();
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(() => pending.promise);
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const runPromise = runner.runHandoff(baseInput(chatRuntime()), rec.hooks);
		t.mock.timers.tick(5000);
		await runPromise;
		assert.equal(rec.sentUrls.length, 1);

		pending.reject(new Error(LEAKY_ERROR));
		await flushMicrotasks();
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.equal(rec.abortedCalls, 0);
	assert.equal(rec.notices.length, 0);
	assert.deepEqual(unhandled, []);
});

test("R4: openUrl throwing while opening the thread doesn't fail the hand-off — a notice, and the button still goes to Sent", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));
	rec.hooks.openUrl = () => {
		throw new Error(LEAKY_ERROR);
	};
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.sentUrls.length, 1, "onSent still ran");
	assert.equal(rec.abortedCalls, 0);
	assert.equal(rec.notices.length, 1);
	assert.match(rec.notices[0], /Couldn't open the thread/);
	assert.ok(!rec.notices[0].includes("SECRET"));
});

test("R4: onSent throwing is caught too — the button is reset rather than left stuck on Sending", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn({ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }));
	rec.hooks.onSent = () => {
		throw new Error("ui broke");
	};
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.abortedCalls, 1);
	assert.deepEqual(rec.notices, [handoffAbortedNotice("openclaw")]);
});

test("R4: if notify itself throws during the abort, runHandoff still resolves and still resets the button", async () => {
	const runner = createHandoffRunner();
	const rec = makeRecorder(async () => {
		throw new Error("x");
	});
	rec.hooks.notify = () => {
		throw new Error("no notices available");
	};
	await runner.runHandoff(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.abortedCalls, 1);
});

test("R4: single-flight releases after an aborted hand-off, so the very next click runs normally", async () => {
	const runner = createHandoffRunner();
	let calls = 0;
	const rec = makeRecorder(async () => {
		calls++;
		if (calls === 1) throw new Error("first fails");
		return { kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) };
	});
	const send = createSingleFlightHandoff(runner.runHandoff);
	await send(baseInput(hookRuntime()), rec.hooks);
	await send(baseInput(hookRuntime()), rec.hooks);
	assert.equal(rec.abortedCalls, 1);
	assert.equal(rec.sentUrls.length, 1);
});

// --- PR-1.F1 R5: the ignored-field notice, through the real click handler --

test("G11: clicking a runtime-target button that sets terminal-only fields shows exactly one notice naming them, then hands off", () => {
	const notices: string[] = [];
	const handedOff: string[] = [];
	createClickHandler({
		spec: { target: "openclaw", model: "opus", autoApprove: true, completion: "responseEnd", agentOutput: "file", showTerminal: false },
		getSettings: () => ({ runtimes: [hookRuntime()], defaultTarget: "terminal" }),
		secretStore: { hasToken: () => true, getToken: () => undefined },
		notify: (message) => notices.push(message),
		runTerminalFlow: () => assert.fail("terminal must not run for a runtime target"),
		runRuntimeFlow: (runtime) => handedOff.push(runtime.name),
	})();
	assert.deepEqual(notices, ['Ignored for runtime target "openclaw": model, autoApprove, agentOutput, completion, showTerminal.']);
	assert.deepEqual(handedOff, ["openclaw"]);
});

test("G11: a runtime-target button that sets none of those fields shows no ignored-fields notice", () => {
	const notices: string[] = [];
	createClickHandler({
		spec: { target: "openclaw" },
		getSettings: () => ({ runtimes: [hookRuntime()], defaultTarget: "terminal" }),
		secretStore: { hasToken: () => true, getToken: () => undefined },
		notify: (message) => notices.push(message),
		runTerminalFlow: () => {},
		runRuntimeFlow: () => {},
	})();
	assert.deepEqual(notices, []);
});
