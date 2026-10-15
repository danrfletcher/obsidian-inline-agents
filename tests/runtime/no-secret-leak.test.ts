import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRunner, sendingLabel, sentLabel } from "../../src/runtime/handoff";
import type { HandoffHooks, HandoffInput } from "../../src/runtime/handoff";
import { buildHookRequest } from "../../src/runtime/hookRequest";
import { buildChatRequest } from "../../src/runtime/chatRequest";
import type { AgentRuntime, HttpFn, HttpOutcome, HttpRequest } from "../../src/runtime/types";

const SECRET = "tok-SECRET-123";
const BEARER = `Bearer ${SECRET}`;

function hookRuntime(): AgentRuntime {
	return {
		id: "openclaw-id",
		name: "openclaw",
		kind: "openclaw-hook",
		baseUrl: "http://127.0.0.1:18789",
		agentId: "main",
		tokenRequired: true,
		tokenSecretName: "openclaw-secret",
		sendSessionKeyHeader: false,
		threadUrlTemplate: "hermes://thread/{sessionKeyPath}",
	};
}

function chatRuntime(): AgentRuntime {
	return {
		id: "hermes-id",
		name: "hermes",
		kind: "openai-chat",
		baseUrl: "https://api.example.com",
		agentId: "gpt-4o",
		tokenRequired: true,
		tokenSecretName: "hermes-secret",
		sendSessionKeyHeader: true,
		threadUrlTemplate: "hermes://thread/{sessionKeyPath}",
	};
}

function baseInput(runtime: AgentRuntime): HandoffInput {
	return {
		runtime,
		prompt: "Run the weekly review.",
		notePath: "/vault/weekly.md",
		noteBasename: "weekly",
		openRequested: true,
		token: SECRET,
	};
}

/**
 * F5/R3: console spy so the sweep also covers anything the runtime module
 * (or anything it calls) logs, not just the notices/labels/URLs it hands
 * back to its own hooks. Restored unconditionally so one test's spying
 * never leaks into the next.
 */
function spyOnConsole(surface: string[]): () => void {
	const methods = ["log", "warn", "error", "info", "debug"] as const;
	const originals = methods.map((m) => console[m]);
	for (const m of methods) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(console as any)[m] = (...args: unknown[]) => {
			surface.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
		};
	}
	return () => {
		methods.forEach((m, i) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(console as any)[m] = originals[i];
		});
	};
}

/**
 * Every string this run could show the user — notices, thread URLs,
 * opened URLs, and (R3) the exact button labels buttonBlock.ts's
 * onSending/onSent build (via the shared sendingLabel/sentLabel helpers,
 * so this can never silently drift from what the button actually shows)
 * — for the leak sweep.
 */
function makeSweepingHooks(runtime: AgentRuntime, httpFn: HttpFn): { hooks: HandoffHooks; surface: string[] } {
	const surface: string[] = [];
	const hooks: HandoffHooks = {
		httpFn,
		nowMs: () => 1000,
		openUrl: (url) => surface.push(url),
		notify: (message) => surface.push(message),
		onSending: () => surface.push(sendingLabel(runtime.name)),
		onSent: (threadUrl) => {
			surface.push(sentLabel(runtime.name));
			if (threadUrl) surface.push(threadUrl);
		},
		fallbackToTerminal: () => {},
	};
	return { hooks, surface };
}

/** F5/R3: asserts none of `strings` contains the raw token or its Bearer form. */
function assertNoLeak(strings: string[], context: string): void {
	for (const s of strings) {
		assert.ok(!s.includes(SECRET), `leaked raw token in ${context}: ${s}`);
		assert.ok(!s.includes(BEARER), `leaked Bearer token in ${context}: ${s}`);
	}
}

/** F5: the token must only ever appear in the Authorization header of a captured request. */
function assertRequestsDontLeak(captured: HttpRequest[]): void {
	for (const request of captured) {
		for (const [name, value] of Object.entries(request.headers)) {
			if (name.toLowerCase() === "authorization") continue;
			assert.ok(!value.includes(SECRET), `token leaked into header "${name}"`);
		}
		assert.ok(!request.url.includes(SECRET), "token leaked into request URL");
		if (request.body) {
			const parsedBody = JSON.parse(request.body) as Record<string, unknown>;
			assert.ok(
				!Object.values(parsedBody).some((v) => typeof v === "string" && v.includes(SECRET)),
				"token leaked into request body"
			);
		}
	}
}

/** E2/E3/E4/E12 and friends — outcomes that fail before (or without ever) settling. */
function earlyFixtures(): HttpOutcome[] {
	return [
		{ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }, // success
		{ kind: "response", status: 401 }, // E3
		{ kind: "response", status: 403 }, // E3
		{ kind: "response", status: 400, body: JSON.stringify({ error: "allowRequestSessionKey disabled" }) }, // E12
		{ kind: "response", status: 400, body: `oops ${BEARER} leaked in a library error` }, // malformed/misbehaving upstream
		{ kind: "response", status: 503 }, // E4
		{ kind: "response", status: 200, body: "not json" }, // malformed response
		{ kind: "timeout" }, // E2
		{ kind: "refused" }, // E2
		{ kind: "error", reason: `request failed with ${BEARER}` }, // a transport error that tried to misuse the token
	];
}

test("F5: no notice, thread URL, opened URL, console call or button-facing string ever contains the token, across every early outcome, both runtime kinds", async () => {
	for (const runtimeFactory of [hookRuntime, chatRuntime]) {
		for (const outcome of earlyFixtures()) {
			const runtime = runtimeFactory();
			const runner = createHandoffRunner();
			const captured: HttpRequest[] = [];
			const httpFn: HttpFn = async (request) => {
				captured.push(request);
				return outcome;
			};
			const { hooks, surface } = makeSweepingHooks(runtime, httpFn);
			const consoleSurface: string[] = [];
			const restoreConsole = spyOnConsole(consoleSurface);

			let threw: string | undefined;
			try {
				await runner.runHandoff(baseInput(runtime), hooks);
			} catch (err) {
				threw = err instanceof Error ? err.message : String(err);
			} finally {
				restoreConsole();
			}

			// R3: runHandoff is documented (not just assumed) never to
			// reject for any of these outcomes — every failure mode is
			// turned into a notice/fallback inside the module, never a
			// thrown error the caller would have to catch.
			assert.equal(threw, undefined, `runHandoff should not reject for ${runtime.kind}/${outcome.kind}, got: ${threw}`);
			if (threw) assertNoLeak([threw], "a thrown/caught error message");

			assertNoLeak(surface, "notice/label/URL surface");
			assertNoLeak(consoleSurface, "console output");
			assertRequestsDontLeak(captured);
		}
	}
});

test("F5/R3: a late chat failure after the 5s settle never leaks the token, and uses the late-failure wording (not the pre-send fallback text)", async (t) => {
	for (const lateOutcome of [
		{ kind: "response", status: 401 },
		{ kind: "response", status: 500, body: `upstream said ${BEARER}` },
		{ kind: "refused" },
		{ kind: "error", reason: `request failed with ${BEARER}` },
	] as HttpOutcome[]) {
		await t.test(`late outcome ${JSON.stringify(lateOutcome)}`, async (st) => {
			st.mock.timers.enable({ apis: ["setTimeout"] });
			const runtime = chatRuntime();
			const runner = createHandoffRunner();
			let resolveHttp!: (o: HttpOutcome) => void;
			const pending = new Promise<HttpOutcome>((resolve) => (resolveHttp = resolve));
			const captured: HttpRequest[] = [];
			const httpFn: HttpFn = async (request) => {
				captured.push(request);
				return pending;
			};
			const { hooks, surface } = makeSweepingHooks(runtime, httpFn);
			const consoleSurface: string[] = [];
			const restoreConsole = spyOnConsole(consoleSurface);

			const runPromise = runner.runHandoff(baseInput(runtime), hooks);
			st.mock.timers.tick(5000);
			await runPromise; // settled — "Sent to hermes" already shown

			resolveHttp(lateOutcome);
			// Flush the microtask queue so the post-settle notify runs.
			await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

			restoreConsole();

			assertNoLeak(surface, "notice/label/URL surface (late chat failure)");
			assertNoLeak(consoleSurface, "console output (late chat failure)");
			assertRequestsDontLeak(captured);

			// The pre-send fallback wording ("isn't reachable, running
			// here", bare "token rejected") must never appear once
			// settled — see R2.
			const lateNotice = surface.find((s) => /no fallback ran/.test(s));
			if (lateNotice) {
				assert.doesNotMatch(lateNotice, /running here/);
				assert.notEqual(lateNotice, "token rejected");
			}
		});
	}
});

test("F5/R3: a late chat timeout after the 5s settle produces no notice and leaks nothing", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const runtime = chatRuntime();
	const runner = createHandoffRunner();
	let resolveHttp!: (o: HttpOutcome) => void;
	const pending = new Promise<HttpOutcome>((resolve) => (resolveHttp = resolve));
	const captured: HttpRequest[] = [];
	const httpFn: HttpFn = async (request) => {
		captured.push(request);
		return pending;
	};
	const { hooks, surface } = makeSweepingHooks(runtime, httpFn);
	const consoleSurface: string[] = [];
	const restoreConsole = spyOnConsole(consoleSurface);

	const runPromise = runner.runHandoff(baseInput(runtime), hooks);
	t.mock.timers.tick(5000);
	await runPromise;

	resolveHttp({ kind: "timeout" });
	await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

	restoreConsole();

	assertNoLeak(surface, "notice/label/URL surface (late chat timeout)");
	assertNoLeak(consoleSurface, "console output (late chat timeout)");
	assertRequestsDontLeak(captured);
	// R2: a late timeout is specifically never reported as a failure —
	// only the "Sending to…"/"Sent to…" labels (and the thread URL) are
	// in the surface, no extra notice.
	const extraNotices = surface.filter(
		(s) => s !== sendingLabel(runtime.name) && s !== sentLabel(runtime.name) && !s.startsWith("hermes://")
	);
	assert.deepEqual(extraNotices, []);
});

test("F5: the token travels only in the Authorization header, never in the body or x-openclaw-session-key", () => {
	const hookRequest = buildHookRequest({
		baseUrl: "http://x",
		token: SECRET,
		agentId: "main",
		name: "n",
		sessionKey: "inline:n:1",
		message: "m",
	});
	assert.equal(hookRequest.headers.Authorization, BEARER);
	assert.ok(!(hookRequest.body ?? "").includes(SECRET));

	const chatRequest = buildChatRequest({
		baseUrl: "http://x",
		token: SECRET,
		model: "m",
		message: "m",
		sessionKey: "inline:n:1",
		sendSessionKeyHeader: true,
	});
	assert.equal(chatRequest.headers.Authorization, BEARER);
	assert.ok(!(chatRequest.body ?? "").includes(SECRET));
	assert.notEqual(chatRequest.headers["x-openclaw-session-key"], SECRET);
});

test("F5: an outcome whose body tries to smuggle the token back in never reaches a notice (hook kind reduces to status/ok/runId only)", async () => {
	const runtime = hookRuntime();
	const runner = createHandoffRunner();
	const { hooks, surface } = makeSweepingHooks(runtime, async () => ({
		kind: "response",
		status: 400,
		body: JSON.stringify({ error: `token leaked: ${BEARER}` }),
	}));
	await runner.runHandoff(baseInput(runtime), hooks);
	assertNoLeak(surface, "hook-kind smuggled-token body");
});
