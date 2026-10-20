import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeFlow, httpTimeoutForKind, toAbsoluteNotePath } from "../../src/runtime/clickFlow";
import type { RuntimeFlowDeps } from "../../src/runtime/clickFlow";
import { HOOK_TIMEOUT_MS } from "../../src/runtime/hookRequest";
import { CHAT_HTTP_TIMEOUT_MS } from "../../src/runtime/chatRequest";
import type { HandoffHooks, HandoffInput } from "../../src/runtime/handoff";
import type { AgentRuntime } from "../../src/runtime/types";

const hook: AgentRuntime = {
	id: "h",
	name: "openclaw",
	kind: "openclaw-hook",
	baseUrl: "http://127.0.0.1:18789",
	agentId: "main",
	tokenRequired: false,
	sendSessionKeyHeader: false,
	tokenSecretName: "oc-token",
};
const chat: AgentRuntime = { ...hook, id: "c", name: "hermes", kind: "openai-chat" };

interface Harness {
	deps: RuntimeFlowDeps;
	timeouts: number[];
	handoffs: Array<{ input: HandoffInput; hooks: HandoffHooks }>;
	ui: string[];
	notices: string[];
	terminalRuns: number[];
}

function harness(overrides: Partial<RuntimeFlowDeps> = {}): Harness {
	const h: Harness = { deps: undefined as unknown as RuntimeFlowDeps, timeouts: [], handoffs: [], ui: [], notices: [], terminalRuns: [] };
	h.deps = {
		ui: {
			showSending: (label) => h.ui.push(`sending:${label}`),
			showSent: (label, url) => h.ui.push(`sent:${label}:${url ?? "-"}`),
			showIdle: () => h.ui.push("idle"),
		},
		getVaultBasePath: () => "/vault/",
		renderPrompt: () => ({ text: "Run it.", noteBasename: "weekly" }),
		sourcePath: "notes/weekly.md",
		agentIdOverride: "other-agent",
		getOpenRequested: () => true,
		secretStore: { hasToken: () => true, getToken: (name) => (name === "oc-token" ? "tok-123" : undefined) },
		createHttpFn: (timeoutMs) => {
			h.timeouts.push(timeoutMs);
			return async () => ({ kind: "response", status: 200 });
		},
		runHandoff: async (input, hooks) => {
			h.handoffs.push({ input, hooks });
		},
		nowMs: () => 1000,
		openUrl: () => {},
		notify: (message) => h.notices.push(message),
		setTimer: () => {},
		runTerminalFlow: () => h.terminalRuns.push(1),
		...overrides,
	};
	return h;
}

test("G14: the click wiring builds a hook runtime's HttpFn with the 15-second timeout", () => {
	const h = harness();
	createRuntimeFlow(h.deps)(hook);
	assert.deepEqual(h.timeouts, [HOOK_TIMEOUT_MS]);
	assert.equal(HOOK_TIMEOUT_MS, 15000);
});

test("G15: the click wiring builds a chat runtime's HttpFn with the generous chat ceiling, not the hook's 15 seconds", () => {
	const h = harness();
	createRuntimeFlow(h.deps)(chat);
	assert.deepEqual(h.timeouts, [CHAT_HTTP_TIMEOUT_MS]);
	assert.notEqual(CHAT_HTTP_TIMEOUT_MS, HOOK_TIMEOUT_MS);
});

test("httpTimeoutForKind maps each kind to its own ceiling", () => {
	assert.equal(httpTimeoutForKind("openclaw-hook"), 15000);
	assert.equal(httpTimeoutForKind("openai-chat"), CHAT_HTTP_TIMEOUT_MS);
});

test("G7: the hand-off input carries the absolute note path, basename, agentId override, open flag and the token read at click time", () => {
	const h = harness();
	createRuntimeFlow(h.deps)(hook);
	assert.equal(h.handoffs.length, 1);
	const { input } = h.handoffs[0];
	assert.equal(input.runtime, hook);
	assert.equal(input.prompt, "Run it.");
	assert.equal(input.notePath, "/vault/notes/weekly.md");
	assert.equal(input.noteBasename, "weekly");
	assert.equal(input.agentIdOverride, "other-agent");
	assert.equal(input.openRequested, true);
	assert.equal(input.token, "tok-123");
});

test("toAbsoluteNotePath joins without doubling the slash", () => {
	assert.equal(toAbsoluteNotePath("/vault", "a/b.md"), "/vault/a/b.md");
	assert.equal(toAbsoluteNotePath("/vault///", "a.md"), "/vault/a.md");
});

test("G7/G9: the hooks drive the button UI with the real Sending / Sent labels", () => {
	const h = harness();
	createRuntimeFlow(h.deps)(hook);
	const { hooks } = h.handoffs[0];
	hooks.onSending();
	hooks.onSent("hermes://thread/1");
	hooks.onSent(undefined);
	assert.deepEqual(h.ui, ["sending:Sending to openclaw…", "sent:Sent to openclaw:hermes://thread/1", "sent:Sent to openclaw:-"]);
});

test("G12: fallbackToTerminal resets the button to idle, then runs the terminal flow, in that order", () => {
	const order: string[] = [];
	const h = harness({ runTerminalFlow: () => order.push("terminal") });
	h.deps.ui.showIdle = () => order.push("idle");
	createRuntimeFlow(h.deps)(hook);
	h.handoffs[0].hooks.fallbackToTerminal();
	assert.deepEqual(order, ["idle", "terminal"]);
});

test("R4: onAborted resets the button to idle without starting the terminal", () => {
	const h = harness();
	createRuntimeFlow(h.deps)(hook);
	h.handoffs[0].hooks.onAborted();
	assert.deepEqual(h.ui, ["idle"]);
	assert.deepEqual(h.terminalRuns, []);
});

test("a vault with no filesystem path shows its message and hands nothing off", () => {
	const h = harness({
		getVaultBasePath: () => {
			throw new Error("needs a local vault");
		},
	});
	createRuntimeFlow(h.deps)(hook);
	assert.deepEqual(h.notices, ["needs a local vault"]);
	assert.deepEqual(h.handoffs, []);
	assert.deepEqual(h.timeouts, []);
});

test("a prompt-template error is shown as a notice and nothing is handed off or requested", () => {
	const h = harness({ renderPrompt: () => ({ text: "", error: "Expressions are off.", noteBasename: "weekly" }) });
	createRuntimeFlow(h.deps)(hook);
	assert.deepEqual(h.notices, ["Expressions are off."]);
	assert.deepEqual(h.handoffs, []);
	assert.deepEqual(h.timeouts, []);
});
