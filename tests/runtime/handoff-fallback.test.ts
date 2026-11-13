import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRunner } from "../../src/runtime/handoff";
import type { HandoffHooks, HandoffInput } from "../../src/runtime/handoff";
import { createFallbackToTerminal } from "../../src/runtime/fallbackWiring";
import { buildHandoffMessage } from "../../src/runtime/message";
import { runInputSubmit } from "../../src/runtime/clickRouting";
import { resolveClickTarget } from "../../src/runtime/targetResolve";
import type { AgentRuntime, HttpFn, HttpOutcome, HttpRequest, SecretStore } from "../../src/runtime/types";
import { composePrompt } from "../../src/inputPrompt";
import { renderPromptTemplate } from "../../src/templating";
import type { AgentContext } from "../../src/context";

// G14/E5: a hand-off that fails before it is accepted starts the terminal
// with the very prompt the runtime was given. The real hand-off runner and
// the real wiring helper buttonBlock.ts uses are driven here; only the
// HTTP call and the terminal are recording fakes. Prompts come from the
// real composer.

const context: AgentContext = {
	file: {
		path: "Notes/Roadmap.md",
		basename: "Roadmap",
		name: "Roadmap.md",
		folder: "Notes",
		extension: "md",
		frontmatter: {},
		tags: [],
		ctime: "",
		mtime: "",
	},
	vault: { name: "v", basePath: "/v" },
	date: { today: "2026-11-03", now: "2026-11-03T00:00:00.000Z" },
};

const TEMPLATE = "Merge this ticket into {{ input }} and archive it";
const TYPED = "Obsidian Atlas dark mode $& $1 {{ file.path }}\nsecond line";

function render(segment: string) {
	return renderPromptTemplate(segment, context, { allowJs: false });
}

const COMPOSED = (() => {
	const composed = composePrompt(TEMPLATE, TYPED, render);
	assert.equal(composed.error, undefined);
	return composed.text;
})();

// A re-render of the button's own prompt (what the fallback used to run)
// is not the composed prompt: that is what lets these tests tell the two apart.
assert.notEqual(render(TEMPLATE).text, COMPOSED);
assert.ok(COMPOSED.includes(TYPED));

function hookRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
	return {
		id: "openclaw-id",
		name: "openclaw",
		kind: "openclaw-hook",
		baseUrl: "http://127.0.0.1:1",
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
		baseUrl: "http://127.0.0.1:1",
		agentId: "gpt-4o",
		tokenRequired: false,
		sendSessionKeyHeader: false,
		threadUrlTemplate: "hermes://thread/{sessionKeyPath}",
		...overrides,
	};
}

interface Session {
	/** "notice", "sent" and "terminal", in the order they happened. */
	events: string[];
	notices: string[];
	/** What the terminal flow was called with. */
	terminalRuns: { typedText: string | undefined; composedPrompt: string | undefined }[];
	restored: number;
	hooks: HandoffHooks;
}

function makeSession(
	httpFn: HttpFn,
	prompt: string,
	typedText: string | undefined
): { session: Session; input: (runtime: AgentRuntime) => HandoffInput } {
	const session: Session = {
		events: [],
		notices: [],
		terminalRuns: [],
		restored: 0,
		hooks: undefined as unknown as HandoffHooks,
	};
	session.hooks = {
		httpFn,
		nowMs: () => 1000,
		openUrl: () => undefined,
		notify: (message) => {
			session.events.push("notice");
			session.notices.push(message);
		},
		onSending: () => undefined,
		onSent: () => session.events.push("sent"),
		fallbackToTerminal: createFallbackToTerminal({
			typedText,
			composedPrompt: prompt,
			restoreButton: () => {
				session.restored++;
			},
			runTerminalFlow: (typed, composedPrompt) => {
				session.events.push("terminal");
				session.terminalRuns.push({ typedText: typed, composedPrompt });
			},
		}),
	};
	return {
		session,
		input: (runtime) => ({
			runtime,
			prompt,
			notePath: "/vault/Notes/Roadmap.md",
			noteBasename: "Roadmap",
			openRequested: true,
			token: runtime.tokenRequired ? undefined : "tok-123",
		}),
	};
}

const respond =
	(outcome: HttpOutcome, captured: HttpRequest[] = []): HttpFn =>
	async (request) => {
		captured.push(request);
		return outcome;
	};

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

function assertFellBackWithTypedText(s: Session, label: string) {
	assert.deepEqual(
		s.terminalRuns,
		[{ typedText: TYPED, composedPrompt: COMPOSED }],
		`${label}: the terminal ran once, with the typed text and composed prompt`
	);
	assert.equal(s.restored, 1, `${label}: the button was restored once`);
	// E5: the notice comes first, then the terminal.
	assert.equal(s.events[s.events.length - 1], "terminal", label);
}

function assertNoTypedTextInNotices(s: Session, label: string) {
	for (const notice of s.notices) {
		assert.ok(!notice.includes("Obsidian Atlas"), `${label}: notice leaks the typed text: ${notice}`);
		assert.ok(!notice.includes("second line"), `${label}: notice leaks the typed text: ${notice}`);
		assert.ok(!notice.includes(COMPOSED), `${label}: notice leaks the prompt: ${notice}`);
	}
}

const fallbackOutcomes: { name: string; runtime: AgentRuntime; outcome: HttpOutcome; notice: RegExp }[] = [
	{ name: "hook unreachable (refused)", runtime: hookRuntime(), outcome: { kind: "refused" }, notice: /isn't reachable, running here/ },
	{ name: "hook unreachable (timeout)", runtime: hookRuntime(), outcome: { kind: "timeout" }, notice: /isn't reachable, running here/ },
	{ name: "hook 401", runtime: hookRuntime(), outcome: { kind: "response", status: 401 }, notice: /^token rejected$/ },
	{ name: "hook 403", runtime: hookRuntime(), outcome: { kind: "response", status: 403 }, notice: /^token rejected$/ },
	{ name: "hook other status", runtime: hookRuntime(), outcome: { kind: "response", status: 503 }, notice: /503/ },
	{
		name: "hook 200 with ok:false",
		runtime: hookRuntime(),
		outcome: { kind: "response", status: 200, body: JSON.stringify({ ok: false }) },
		notice: /200/,
	},
	{
		name: "hook 400 session-key policy",
		runtime: hookRuntime(),
		outcome: { kind: "response", status: 400, body: JSON.stringify({ error: "allowRequestSessionKey disabled" }) },
		notice: /rejected the session key/,
	},
	{ name: "chat unreachable (refused), before the settle", runtime: chatRuntime(), outcome: { kind: "refused" }, notice: /isn't reachable, running here/ },
	{ name: "chat 401, before the settle", runtime: chatRuntime(), outcome: { kind: "response", status: 401 }, notice: /^token rejected$/ },
	{ name: "chat 500, before the settle", runtime: chatRuntime(), outcome: { kind: "response", status: 500 }, notice: /500/ },
];

for (const c of fallbackOutcomes) {
	test(`G14/E5: ${c.name}: the notice, then the terminal runs the composed prompt`, async () => {
		const { session, input } = makeSession(respond(c.outcome), COMPOSED, TYPED);
		await createHandoffRunner().runHandoff(input(c.runtime), session.hooks);
		assert.equal(session.notices.length, 1, session.notices.join(" | "));
		assert.match(session.notices[0], c.notice);
		assert.deepEqual(session.events, ["notice", "terminal"]);
		assertFellBackWithTypedText(session, c.name);
		assertNoTypedTextInNotices(session, c.name);
	});
}

test("G14/E5: a chat error before the 5 s settle (pending request that then fails) falls back with the composed prompt", async () => {
	const pending = deferred<HttpOutcome>();
	const { session, input } = makeSession(async () => pending.promise, COMPOSED, TYPED);
	const run = createHandoffRunner().runHandoff(input(chatRuntime()), session.hooks);
	pending.resolve({ kind: "response", status: 500 });
	await run;
	assertFellBackWithTypedText(session, "early chat error");
	assertNoTypedTextInNotices(session, "early chat error");
});

test("G14/E5: a runtime that needs a token this device lacks skips the request and falls back with the composed prompt", async () => {
	const requests: HttpRequest[] = [];
	const { session, input } = makeSession(respond({ kind: "response", status: 200 }, requests), COMPOSED, TYPED);
	const runtime = hookRuntime({ tokenRequired: true, tokenSecretName: "missing" });
	await createHandoffRunner().runHandoff(input(runtime), session.hooks);
	assert.deepEqual(requests, []);
	assertFellBackWithTypedText(session, "missing token");
});

test("E5: a late chat error after the 5 s settle is a notice only: the terminal is never started", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = deferred<HttpOutcome>();
	const { session, input } = makeSession(async () => pending.promise, COMPOSED, TYPED);
	const run = createHandoffRunner().runHandoff(input(chatRuntime()), session.hooks);
	t.mock.timers.tick(5000);
	await run;
	assert.deepEqual(session.events, ["sent"]);

	pending.resolve({ kind: "response", status: 500 });
	await flushMicrotasks();
	assert.deepEqual(session.terminalRuns, [], "the typed text is never run a second time");
	assert.equal(session.restored, 0);
	assert.equal(session.notices.length, 1);
	assert.match(session.notices[0], /no fallback ran/);
	assertNoTypedTextInNotices(session, "late chat error");
});

test("G14: the terminal is not started at all when the hand-off is accepted", async () => {
	const accepted: HttpOutcome = { kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) };
	const { session, input } = makeSession(respond(accepted), COMPOSED, TYPED);
	await createHandoffRunner().runHandoff(input(hookRuntime()), session.hooks);
	assert.deepEqual(session.terminalRuns, []);
	assert.deepEqual(session.events, ["sent"]);
});

test("F3: a button without input: falls back exactly as before: the terminal flow gets no arguments and renders the button's own prompt", async () => {
	const { session, input } = makeSession(respond({ kind: "refused" }), "Run the weekly review.", undefined);
	await createHandoffRunner().runHandoff(input(hookRuntime()), session.hooks);
	assert.deepEqual(session.terminalRuns, [{ typedText: undefined, composedPrompt: undefined }]);
	assert.equal(session.restored, 1);
	assert.deepEqual(session.events, ["notice", "terminal"]);
});

test("F7: the body sent to a runtime is exactly buildHandoffMessage(composedPrompt, notePath, preface), with the typed text once", async () => {
	for (const runtime of [hookRuntime(), chatRuntime()]) {
		const requests: HttpRequest[] = [];
		const accepted: HttpOutcome = { kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) };
		const { session, input } = makeSession(respond(accepted, requests), COMPOSED, TYPED);
		await createHandoffRunner().runHandoff(input(runtime), session.hooks);
		assert.equal(requests.length, 1, runtime.kind);
		const parsed = JSON.parse(requests[0].body ?? "{}");
		const sent: string = runtime.kind === "openclaw-hook" ? parsed.message : parsed.messages[0].content;
		assert.equal(sent, buildHandoffMessage(COMPOSED, "/vault/Notes/Roadmap.md", runtime.kind === "openclaw-hook"), runtime.kind);
		assert.equal(sent.split("Obsidian Atlas dark mode").length - 1, 1, `${runtime.kind}: the typed text appears once`);
	}
});

// --- E5: render error, unknown target ---------------------------------------

// This covers the message and the text it leaves out. It does not cover the
// runtime-target path in startRuntimeFlow (src/buttonBlock.ts): that a Notice
// is shown, nothing is spawned or sent, and sessionAlive stays false. That
// module imports "obsidian" and xterm and cannot load under node, so the
// tester checks it in the app.
test("E5: a render error carries the same message as today and none of the typed text", () => {
	const typed = "TYPED-SECRET-123 $&";
	// {{= }} is off, so rendering fails exactly as it does for a click.
	const withExpression = "Do {{= 1+1 }} for {{ input }}";
	const composed = composePrompt(withExpression, typed, render);
	const plainClick = render(withExpression);
	assert.ok(composed.error);
	assert.equal(composed.error, plainClick.error, "the same message as a click without input:");
	assert.ok(!composed.error?.includes("TYPED-SECRET-123"));
	assert.ok(!composed.text.includes("TYPED-SECRET-123"), "text is the unrendered template");
});

const noSecrets: SecretStore = { hasToken: () => false, getToken: () => undefined };

test("E5: an unknown target: at submit shows one notice and starts nothing, even when the default target is an unreachable runtime", () => {
	const resolution = resolveClickTarget({ target: "nope" }, { runtimes: [hookRuntime()], defaultTarget: "openclaw" }, noSecrets);
	assert.ok(resolution.notices.length >= 1, "resolveClickTarget reports its own notices");
	const events: string[] = [];
	runInputSubmit(resolution, TYPED, {
		notify: (message) => events.push(`notice:${message}`),
		runTerminalFlow: () => events.push("terminal"),
		runRuntimeFlow: () => events.push("runtime"),
	});
	assert.equal(events.length, 1);
	assert.match(events[0], /^notice:Unknown target "nope" — nothing was run/);
	assert.ok(!events[0].includes("Obsidian Atlas"));
});
