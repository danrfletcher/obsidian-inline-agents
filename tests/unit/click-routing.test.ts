import { test } from "node:test";
import assert from "node:assert/strict";
import { createClickHandler, createRuntimeFlow, createTerminalFlow } from "../../src/runtime/clickFlow";
import type { TerminalFlowSteps } from "../../src/runtime/clickFlow";
import { createHandoffRunner } from "../../src/runtime/handoff";
import { migrateSettings } from "../../src/runtime/settingsMigrate";
import { resolveClickTarget } from "../../src/runtime/targetResolve";
import type { AgentRuntime, HttpFn, SecretStore } from "../../src/runtime/types";

/**
 * A stub terminal that records the calls the *real* terminal flow
 * (createTerminalFlow, the same function buttonBlock.ts runs) makes on it.
 * The flow's order lives in createTerminalFlow, not in this stub — the stub
 * only logs each step as it is invoked.
 */
function recordingTerminalSteps(sessionAlive = false): { calls: string[]; steps: TerminalFlowSteps } {
	const calls: string[] = [];
	const record = (name: string) => () => {
		calls.push(name);
	};
	return {
		calls,
		steps: {
			isSessionAlive: () => {
				calls.push("isSessionAlive");
				return sessionAlive;
			},
			revealExistingSession: record("revealExistingSession"),
			markRunning: record("markRunning"),
			applyAccordionPreference: record("applyAccordionPreference"),
			ensureTerm: record("ensureTerm"),
			clearTerm: record("clearTerm"),
			launch: record("launch"),
		},
	};
}

const noSecrets: SecretStore = { hasToken: () => false, getToken: () => undefined };

const openclaw: AgentRuntime = {
	id: "openclaw-id",
	name: "openclaw",
	kind: "openclaw-hook",
	baseUrl: "http://127.0.0.1:18789",
	agentId: "main",
	tokenRequired: false,
	sendSessionKeyHeader: false,
};

/** Builds the real click handler over a recording terminal and a recording runtime flow. */
function makeHandler(spec: { target?: string }, settings: { runtimes: AgentRuntime[]; defaultTarget: string }, sessionAlive = false) {
	const { calls, steps } = recordingTerminalSteps(sessionAlive);
	const runtimeCalls: AgentRuntime[] = [];
	const notices: string[] = [];
	const handler = createClickHandler({
		spec,
		getSettings: () => settings,
		secretStore: noSecrets,
		notify: (message) => notices.push(message),
		runTerminalFlow: createTerminalFlow(steps),
		runRuntimeFlow: (runtime) => {
			runtimeCalls.push(runtime);
		},
	});
	return { handler, calls, runtimeCalls, notices };
}

const IN_ORDER = ["isSessionAlive", "markRunning", "applyAccordionPreference", "ensureTerm", "clearTerm", "launch"];

test("F8: target: terminal runs the real terminal flow's steps in the 0.2.1 order, once, and never the runtime flow", () => {
	const { handler, calls, runtimeCalls } = makeHandler({ target: "terminal" }, { runtimes: [], defaultTarget: "terminal" });
	handler();
	assert.deepEqual(calls, IN_ORDER);
	assert.deepEqual(runtimeCalls, []);
});

test("F8: no target: line runs the terminal flow the same way when the default target is terminal", () => {
	const { handler, calls } = makeHandler({}, { runtimes: [openclaw], defaultTarget: "terminal" });
	handler();
	assert.deepEqual(calls, IN_ORDER);
});

test("F8: clicking again while a session is alive only reveals the existing terminal — no second start", () => {
	const { handler, calls } = makeHandler({ target: "terminal" }, { runtimes: [], defaultTarget: "terminal" }, true);
	handler();
	assert.deepEqual(calls, ["isSessionAlive", "revealExistingSession"]);
});

test("F8: a runtime-target click makes no terminal call of any kind (no flash), and runs the runtime flow with the resolved runtime", () => {
	const { handler, calls, runtimeCalls } = makeHandler({ target: "openclaw" }, { runtimes: [openclaw], defaultTarget: "terminal" });
	handler();
	assert.deepEqual(calls, []);
	assert.deepEqual(runtimeCalls, [openclaw]);
});

test("F8: no target: line goes to a runtime when that runtime is the Default target", () => {
	const { handler, calls, runtimeCalls } = makeHandler({}, { runtimes: [openclaw], defaultTarget: "openclaw" });
	handler();
	assert.deepEqual(calls, []);
	assert.deepEqual(runtimeCalls, [openclaw]);
});

test("F8/E1: an unknown target shows one notice, then runs the terminal default through the real flow", () => {
	const { handler, calls, notices } = makeHandler({ target: "does-not-exist" }, { runtimes: [], defaultTarget: "terminal" });
	handler();
	assert.equal(notices.length, 1);
	assert.deepEqual(calls, IN_ORDER);
});

test("F8: the click handler resolves the target on every click, so a settings change applies to the next click", () => {
	const settings = { runtimes: [openclaw], defaultTarget: "terminal" };
	const { handler, calls, runtimeCalls } = makeHandler({}, settings);
	handler();
	assert.deepEqual(calls, IN_ORDER);
	settings.defaultTarget = "openclaw";
	handler();
	assert.deepEqual(runtimeCalls, [openclaw]);
});

// --- F4: nothing makes an HTTP request until a runtime-target click -------

function countingHttpFn(): { httpFn: HttpFn; requests: number[] } {
	const requests: number[] = [];
	const httpFn: HttpFn = async () => {
		requests.push(requests.length);
		return { kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) };
	};
	return { httpFn, requests };
}

/** The real runtime flow over fakes, with `createHttpFn` handing out the counting HttpFn. */
function makeRuntimeFlow(httpFn: HttpFn, timeouts: number[] = []) {
	const sent: string[] = [];
	const flow = createRuntimeFlow({
		ui: { showSending: () => {}, showSent: (label) => sent.push(label), showIdle: () => {} },
		getVaultBasePath: () => "/vault",
		renderPrompt: () => ({ text: "Run it.", noteBasename: "weekly" }),
		sourcePath: "weekly.md",
		agentIdOverride: undefined,
		getOpenRequested: () => false,
		secretStore: noSecrets,
		createHttpFn: (timeoutMs) => {
			timeouts.push(timeoutMs);
			return httpFn;
		},
		runHandoff: createHandoffRunner().runHandoff,
		nowMs: () => 1000,
		openUrl: () => {},
		notify: () => {},
		setTimer: () => {},
		runTerminalFlow: () => {},
	});
	return { flow, sent };
}

test("F4: loading settings, building the click handler and rendering a button (no click) make zero HTTP calls", () => {
	const { httpFn, requests } = countingHttpFn();
	const timeouts: number[] = [];
	// "load": migrate saved settings that already contain a runtime.
	const settings = migrateSettings({ runtimes: [openclaw], defaultTarget: "openclaw" });
	// "render": build the flow and handler for a button targeting that runtime, but don't click.
	const { flow } = makeRuntimeFlow(httpFn, timeouts);
	createClickHandler({
		spec: { target: "openclaw" },
		getSettings: () => settings,
		secretStore: noSecrets,
		notify: () => {},
		runTerminalFlow: () => {},
		runRuntimeFlow: flow,
	});
	resolveClickTarget({ target: "openclaw" }, settings, noSecrets);
	assert.deepEqual(requests, []);
	assert.deepEqual(timeouts, [], "not even an HttpFn is constructed before a click");
});

test("F4: a terminal-target click makes zero HTTP calls", () => {
	const { httpFn, requests } = countingHttpFn();
	const { flow } = makeRuntimeFlow(httpFn);
	const { steps } = recordingTerminalSteps();
	createClickHandler({
		spec: { target: "terminal" },
		getSettings: () => ({ runtimes: [openclaw], defaultTarget: "openclaw" }),
		secretStore: noSecrets,
		notify: () => {},
		runTerminalFlow: createTerminalFlow(steps),
		runRuntimeFlow: flow,
	})();
	assert.deepEqual(requests, []);
});

test("F4: a runtime-target click makes exactly one HTTP call", async () => {
	const { httpFn, requests } = countingHttpFn();
	const { flow, sent } = makeRuntimeFlow(httpFn);
	createClickHandler({
		spec: { target: "openclaw" },
		getSettings: () => ({ runtimes: [openclaw], defaultTarget: "terminal" }),
		secretStore: noSecrets,
		notify: () => {},
		runTerminalFlow: () => assert.fail("terminal must not run"),
		runRuntimeFlow: flow,
	})();
	// The hand-off is async; let it finish.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests.length, 1);
	assert.deepEqual(sent, ["Sent to openclaw"]);
});
