import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRunner, createSingleFlightHandoff } from "../../src/runtime/handoff";
import type { HandoffHooks, HandoffInput } from "../../src/runtime/handoff";
import type { AgentRuntime, HttpFn, HttpOutcome, HttpRequest } from "../../src/runtime/types";
import { openThreadUrl } from "../../src/runtime/threadUrl";

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

// --- Session id header (G5, G6, GP3, GP4, E13) -------------------------

const WEEKLY_MS = 1793618103221;
const WEEKLY_KEY = "inline:weekly-review:1793618103221";
const WEEKLY_ID = "inline-weekly-review-1793618103221";

function weeklyInput(runtime: AgentRuntime): HandoffInput {
	return baseInput(runtime, { noteBasename: "Weekly Review", notePath: "/vault/Weekly Review.md" });
}

const OK_CHAT: HttpOutcome = { kind: "response", status: 200 };
const OK_HOOK: HttpOutcome = { kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) };

test("GP4/G5: chat runtime, toggle on: one POST carrying X-Hermes-Session-Id and body user = the id derived from the key", async () => {
	const captured: HttpRequest[] = [];
	const runner = createHandoffRunner();
	const rec = makeRecorder(fakeHttpFn(OK_CHAT, captured), () => WEEKLY_MS);
	const runtime = chatRuntime({
		baseUrl: "http://127.0.0.1:8642/v1",
		tokenRequired: true,
		sendSessionIdHeader: true,
		threadUrlTemplate: "hermes://thread/{sessionKey}",
	});
	await runner.runHandoff({ ...weeklyInput(runtime), token: "tok-SECRET-123" }, rec.hooks);

	assert.equal(captured.length, 1);
	const [request] = captured;
	assert.equal(request.method, "POST");
	assert.equal(request.url, "http://127.0.0.1:8642/v1/chat/completions");
	assert.equal(request.headers.Authorization, "Bearer tok-SECRET-123");
	assert.equal(request.headers["X-Hermes-Session-Id"], WEEKLY_ID);
	assert.equal(JSON.parse(request.body ?? "{}").user, WEEKLY_ID);
	assert.ok(!(request.headers["X-Hermes-Session-Id"] ?? "").includes(":"));
	assert.equal(request.headers["x-openclaw-session-key"], undefined);
	// The thread URL is still built from the colon key (unchanged by this toggle).
	assert.deepEqual(rec.sentUrls, [`hermes://thread/${WEEKLY_KEY}`]);
});

test("G6: the id is derived once per click: header and body are the same string, and it comes from the key the click used", async () => {
	const captured: HttpRequest[] = [];
	const runner = createHandoffRunner();
	let clock = 0;
	const rec = makeRecorder(fakeHttpFn(OK_CHAT, captured), () => WEEKLY_MS + clock++);
	const runtime = chatRuntime({ sendSessionIdHeader: true, sendSessionKeyHeader: true });
	await runner.runHandoff(weeklyInput(runtime), rec.hooks);

	const [request] = captured;
	const headerId = request.headers["X-Hermes-Session-Id"];
	assert.equal(headerId, JSON.parse(request.body ?? "{}").user);
	// nowMs was read exactly once for the click, and the id is that key with ':' -> '-'.
	assert.equal(clock, 1);
	assert.equal(headerId, request.headers["x-openclaw-session-key"].replace(/:/g, "-"));
	assert.equal(request.headers["x-openclaw-session-key"], WEEKLY_KEY);
});

test("added: two clicks in different milliseconds on one note send different ids", async () => {
	const captured: HttpRequest[] = [];
	const runner = createHandoffRunner();
	let now = WEEKLY_MS;
	const rec = makeRecorder(fakeHttpFn(OK_CHAT, captured), () => now);
	const runtime = chatRuntime({ sendSessionIdHeader: true });
	await runner.runHandoff(weeklyInput(runtime), rec.hooks);
	now += 1;
	await runner.runHandoff(weeklyInput(runtime), rec.hooks);
	assert.equal(captured.length, 2);
	assert.notEqual(captured[0].headers["X-Hermes-Session-Id"], captured[1].headers["X-Hermes-Session-Id"]);
});

test("G5/E9: toggle off, or the field absent, behaves as before: no id header, user = the session key", async () => {
	for (const overrides of [{ sendSessionIdHeader: false }, {}] as Partial<AgentRuntime>[]) {
		const captured: HttpRequest[] = [];
		const runner = createHandoffRunner();
		const rec = makeRecorder(fakeHttpFn(OK_CHAT, captured), () => WEEKLY_MS);
		await runner.runHandoff(weeklyInput(chatRuntime(overrides)), rec.hooks);
		const [request] = captured;
		assert.equal(request.headers["X-Hermes-Session-Id"], undefined);
		assert.deepEqual(Object.keys(request.headers), ["Content-Type"]);
		assert.equal(JSON.parse(request.body ?? "{}").user, WEEKLY_KEY);
	}
});

test("added/E13: a hook runtime with the stored toggle on sends exactly what a runtime that never had the field sends", async () => {
	const withField: HttpRequest[] = [];
	const withoutField: HttpRequest[] = [];
	await createHandoffRunner().runHandoff(
		weeklyInput(hookRuntime({ sendSessionIdHeader: true })),
		makeRecorder(fakeHttpFn(OK_HOOK, withField), () => WEEKLY_MS).hooks
	);
	await createHandoffRunner().runHandoff(
		weeklyInput(hookRuntime()),
		makeRecorder(fakeHttpFn(OK_HOOK, withoutField), () => WEEKLY_MS).hooks
	);
	assert.equal(withField.length, 1);
	// The hook request carries a fresh random Idempotency-Key per build; everything else must match.
	const stable = (r: HttpRequest): HttpRequest => ({ ...r, headers: { ...r.headers, "Idempotency-Key": "-" } });
	assert.deepEqual(withField.map(stable), withoutField.map(stable));
	assert.equal(withField[0].headers["X-Hermes-Session-Id"], undefined);
	assert.ok(!(withField[0].body ?? "").includes(WEEKLY_ID));
	assert.equal(JSON.parse(withField[0].body ?? "{}").sessionKey, WEEKLY_KEY);
});

// --- {sessionId} in the thread URL (G8, G9, GP2, GP5, GP7, E6, E7, F1-F5) ---

const HERMES_TEMPLATE = "hermes://open/{sessionId}";
const HERMES_URL = `hermes://open/${WEEKLY_ID}`;

function hermesRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
	return chatRuntime({
		baseUrl: "http://127.0.0.1:8642/v1",
		threadUrlTemplate: HERMES_TEMPLATE,
		...overrides,
	});
}

test("GP2/GP5/G9: chat kind, toggle on and off: nothing opens before 5000 ms, then the exact id-based URL is opened and reported", async (t) => {
	for (const sendSessionIdHeader of [true, false]) {
		await t.test(`toggle ${sendSessionIdHeader ? "on" : "off"}`, async (st) => {
			st.mock.timers.enable({ apis: ["setTimeout"] });
			const captured: HttpRequest[] = [];
			const pending = deferred<HttpOutcome>();
			const rec = makeRecorder(async (request) => {
				captured.push(request);
				return pending.promise;
			}, () => WEEKLY_MS);
			const runPromise = createHandoffRunner().runHandoff(
				weeklyInput(hermesRuntime({ sendSessionIdHeader })),
				rec.hooks
			);

			assert.equal(rec.sendingCalls, 1);
			st.mock.timers.tick(4999);
			await flushMicrotasks();
			assert.deepEqual(rec.openedUrls, []);
			assert.deepEqual(rec.sentUrls, []);

			st.mock.timers.tick(1);
			await runPromise;
			assert.deepEqual(rec.openedUrls, [HERMES_URL]);
			assert.deepEqual(rec.sentUrls, [HERMES_URL]);
			assert.ok(!HERMES_URL.slice("hermes://".length).includes(":"));
			// The reply has not arrived yet: opened mid-run, not after the reply.
			assert.equal(captured.length, 1);
			pending.resolve(OK_CHAT);
			await flushMicrotasks();
			assert.deepEqual(rec.openedUrls, [HERMES_URL]);
		});
	}
});

test("GP5: open: false still reports the URL to onSent but opens nothing", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async () => pending.promise, () => WEEKLY_MS);
	const runPromise = createHandoffRunner().runHandoff(
		{ ...weeklyInput(hermesRuntime({ sendSessionIdHeader: true })), openRequested: false },
		rec.hooks
	);
	t.mock.timers.tick(5000);
	await runPromise;
	assert.deepEqual(rec.sentUrls, [HERMES_URL]);
	assert.deepEqual(rec.openedUrls, []);
});

test("G8: the URL's id is the very id the request sends (toggle on): one derivation, two consumers", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const captured: HttpRequest[] = [];
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async (request) => {
		captured.push(request);
		return pending.promise;
	}, () => WEEKLY_MS);
	const runPromise = createHandoffRunner().runHandoff(
		weeklyInput(hermesRuntime({ sendSessionIdHeader: true })),
		rec.hooks
	);
	t.mock.timers.tick(5000);
	await runPromise;
	assert.equal(captured[0].headers["X-Hermes-Session-Id"], WEEKLY_ID);
	assert.equal(rec.openedUrls[0], `hermes://open/${captured[0].headers["X-Hermes-Session-Id"]}`);
});

test("G8/F5: hook kind with {sessionId} in the template builds the same id-based URL, and its request equals the 0.3.1 fixture", async () => {
	const captured: HttpRequest[] = [];
	const rec = makeRecorder(fakeHttpFn(OK_HOOK, captured), () => WEEKLY_MS);
	const runtime = hookRuntime({
		baseUrl: "http://127.0.0.1:18789",
		tokenRequired: true,
		threadUrlTemplate: "hermes://open/{sessionId}",
		// Whatever the toggles say, the hook request must not change.
		sendSessionIdHeader: true,
		sendSessionKeyHeader: true,
	});
	await createHandoffRunner().runHandoff(
		{ ...baseInput(runtime, { noteBasename: "Weekly Review", notePath: "/vault/Weekly Review.md" }), prompt: "Summarise Weekly Review.md", token: "tok-SECRET-123" },
		rec.hooks
	);
	assert.deepEqual(rec.openedUrls, [HERMES_URL]);
	assert.deepEqual(rec.sentUrls, [HERMES_URL]);

	// Fixture copied from the output of the 0.3.1 sources (commit 54de3b4)
	// for the same pinned input. The Idempotency-Key is random per build.
	assert.equal(captured.length, 1);
	const { "Idempotency-Key": idempotencyKey, ...stableHeaders } = captured[0].headers;
	assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
	assert.deepEqual({ ...captured[0], headers: stableHeaders }, {
		url: "http://127.0.0.1:18789/hooks/agent",
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer tok-SECRET-123" },
		body: '{"message":"This is an instruction from the vault owner, sent by their Inline Agents button. Carry it out.\\nSummarise Weekly Review.md\\n\\nNote: /vault/Weekly Review.md","agentId":"main","name":"Weekly Review","sessionKey":"inline:weekly-review:1793618103221","sessionMode":"persistent","deliver":false}',
	});
});

test("G8: old placeholders in a hook template still produce 0.3.1 URLs", async () => {
	const rec = makeRecorder(fakeHttpFn(OK_HOOK), () => WEEKLY_MS);
	const runtime = hookRuntime({ threadUrlTemplate: "openclaw://thread/{agentId}/{sessionKeyPath}?k={sessionKey}" });
	await createHandoffRunner().runHandoff(weeklyInput(runtime), rec.hooks);
	assert.deepEqual(rec.openedUrls, [`openclaw://thread/main/inline/weekly-review/1793618103221?k=${WEEKLY_KEY}`]);
});

test("GP7/E7: different nowMs give different URLs; the same nowMs and basename give identical ones (no guard, counter or suffix)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runner = createHandoffRunner();
	const urls: string[] = [];
	for (const now of [WEEKLY_MS, WEEKLY_MS + 1, WEEKLY_MS + 1]) {
		const pending = deferred<HttpOutcome>();
		const rec = makeRecorder(async () => pending.promise, () => now);
		const runPromise = runner.runHandoff(weeklyInput(hermesRuntime({ sendSessionIdHeader: true })), rec.hooks);
		t.mock.timers.tick(5000);
		await runPromise;
		urls.push(...(rec.openedUrls));
	}
	assert.equal(urls.length, 3);
	assert.equal(urls[0], HERMES_URL);
	assert.equal(urls[1], "hermes://open/inline-weekly-review-1793618103222");
	assert.notEqual(urls[0], urls[1]);
	// E7: documented behaviour. A second click in the same millisecond reuses the id.
	assert.equal(urls[1], urls[2]);
});

test("GP7: reopening the ↗ is the same URL the hand-off reported (onSent carries what was opened)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async () => pending.promise, () => WEEKLY_MS);
	const runPromise = createHandoffRunner().runHandoff(weeklyInput(hermesRuntime({ sendSessionIdHeader: true })), rec.hooks);
	t.mock.timers.tick(5000);
	await runPromise;
	const reopened: string[] = [];
	assert.deepEqual(openThreadUrl(rec.sentUrls[0] ?? "", (u) => reopened.push(u)), { opened: true });
	assert.deepEqual(reopened, rec.openedUrls);
});

test("E6/F1: a late 5xx, late 401 and late timeout keep today's wording, open nothing more and send nothing more", async (t) => {
	const cases: { name: string; outcome: HttpOutcome; notice: string | undefined }[] = [
		{ name: "5xx", outcome: { kind: "response", status: 503 }, notice: "hermes returned status 503 after accepting the prompt — no fallback ran." },
		{ name: "401", outcome: { kind: "response", status: 401 }, notice: "hermes rejected the token after accepting the prompt — no fallback ran." },
		{ name: "timeout", outcome: { kind: "timeout" }, notice: undefined },
	];
	for (const c of cases) {
		await t.test(c.name, async (st) => {
			st.mock.timers.enable({ apis: ["setTimeout"] });
			const captured: HttpRequest[] = [];
			const pending = deferred<HttpOutcome>();
			const rec = makeRecorder(async (request) => {
				captured.push(request);
				return pending.promise;
			}, () => WEEKLY_MS);
			const runPromise = createHandoffRunner().runHandoff(weeklyInput(hermesRuntime({ sendSessionIdHeader: true })), rec.hooks);
			st.mock.timers.tick(5000);
			await runPromise;
			assert.deepEqual(rec.openedUrls, [HERMES_URL]);

			pending.resolve(c.outcome);
			await flushMicrotasks();
			st.mock.timers.tick(60000);
			await flushMicrotasks();

			assert.deepEqual(rec.notices, c.notice ? [c.notice] : []);
			assert.equal(rec.openedUrls.length, 1);
			assert.equal(rec.sentUrls.length, 1);
			assert.equal(captured.length, 1);
			assert.equal(rec.fallbackCalls, 0);
			assert.ok(rec.notices.every((n) => !n.includes(WEEKLY_ID)));
		});
	}
});

test("G9/guard: an early error (before 5 s) opens nothing and falls back to the terminal", async () => {
	for (const outcome of [{ kind: "response", status: 500 }, { kind: "response", status: 401 }, { kind: "refused" }] as HttpOutcome[]) {
		const pending = deferred<HttpOutcome>();
		const rec = makeRecorder(async () => pending.promise, () => WEEKLY_MS);
		const runPromise = createHandoffRunner().runHandoff(weeklyInput(hermesRuntime({ sendSessionIdHeader: true })), rec.hooks);
		pending.resolve(outcome);
		await runPromise;
		assert.deepEqual(rec.openedUrls, []);
		assert.deepEqual(rec.sentUrls, []);
		assert.equal(rec.fallbackCalls, 1);
		assert.equal(rec.notices.length, 1);
		assert.ok(!rec.notices[0].includes(WEEKLY_ID));
	}
});

test("F2/F3/F4: the reply is never read; exactly one request per click, to <base>/chat/completions, with no profile selector", async (t) => {
	for (const replyBeforeSettle of [true, false]) {
		await t.test(replyBeforeSettle ? "reply inside 5 s" : "reply after settle", async (st) => {
			st.mock.timers.enable({ apis: ["setTimeout"] });
			const captured: HttpRequest[] = [];
			const pending = deferred<HttpOutcome>();
			const rec = makeRecorder(async (request) => {
				captured.push(request);
				return pending.promise;
			}, () => WEEKLY_MS);
			const reply: HttpOutcome = {
				kind: "response",
				status: 200,
				body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "REPLY-MARKER" } }] }),
			};
			const runPromise = createHandoffRunner().runHandoff(
				{ ...weeklyInput(hermesRuntime({ sendSessionIdHeader: true })), token: "tok-SECRET-123" },
				rec.hooks
			);
			if (replyBeforeSettle) {
				pending.resolve(reply);
			} else {
				st.mock.timers.tick(5000);
			}
			await runPromise;
			if (!replyBeforeSettle) {
				pending.resolve(reply);
				await flushMicrotasks();
			}

			const everything = JSON.stringify({ notices: rec.notices, sent: rec.sentUrls, opened: rec.openedUrls });
			assert.ok(!everything.includes("REPLY-MARKER"));
			assert.deepEqual(rec.openedUrls, [HERMES_URL]);

			assert.equal(captured.length, 1);
			assert.equal(captured[0].url, "http://127.0.0.1:8642/v1/chat/completions");
			assert.equal(captured[0].method, "POST");
			assert.deepEqual(Object.keys(captured[0].headers).sort(), ["Authorization", "Content-Type", "X-Hermes-Session-Id"]);
			assert.ok(!Object.keys(captured[0].headers).some((h) => /profile/i.test(h)));
			assert.ok(!/profile/i.test(captured[0].body ?? ""));
			assert.equal(JSON.parse(captured[0].body ?? "{}").stream, false);
		});
	}
});

test("added: a disallowed-scheme template notice names the scheme and never contains the id; nothing opens", async (t) => {
	for (const scheme of ["file", "javascript", "data", "vbscript"]) {
		await t.test(scheme, async (st) => {
			st.mock.timers.enable({ apis: ["setTimeout"] });
			const pending = deferred<HttpOutcome>();
			const rec = makeRecorder(async () => pending.promise, () => WEEKLY_MS);
			const runPromise = createHandoffRunner().runHandoff(
				weeklyInput(hermesRuntime({ sendSessionIdHeader: true, threadUrlTemplate: `${scheme}:{sessionId}` })),
				rec.hooks
			);
			st.mock.timers.tick(5000);
			await runPromise;
			assert.deepEqual(rec.openedUrls, []);
			assert.equal(rec.notices.length, 1);
			assert.ok(rec.notices[0].includes(`"${scheme}:"`));
			assert.ok(!rec.notices[0].includes(WEEKLY_ID));
			assert.ok(!rec.notices[0].includes("inline"));
		});
	}
});

test("added: a click while a hand-off is in flight is still ignored (one request, one open)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const captured: HttpRequest[] = [];
	const pending = deferred<HttpOutcome>();
	const rec = makeRecorder(async (request) => {
		captured.push(request);
		return pending.promise;
	}, () => WEEKLY_MS);
	const guarded = createSingleFlightHandoff(createHandoffRunner().runHandoff);
	const input = weeklyInput(hermesRuntime({ sendSessionIdHeader: true }));
	const first = guarded(input, rec.hooks);
	const second = guarded(input, rec.hooks);
	t.mock.timers.tick(5000);
	await Promise.all([first, second]);
	assert.equal(captured.length, 1);
	assert.equal(rec.sendingCalls, 1);
	assert.deepEqual(rec.openedUrls, [HERMES_URL]);
});
