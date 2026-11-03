import { test } from "node:test";
import assert from "node:assert/strict";
import { decideClickAction, runClickDecision, runInputSubmit } from "../../src/runtime/clickRouting";
import { resolveClickTarget } from "../../src/runtime/targetResolve";
import type { AgentRuntime, SecretStore } from "../../src/runtime/types";

/**
 * Stands in for buttonBlock.ts's real terminal flow (sessionAlive check,
 * accordion open, ensureTerm, spawn, ...) — records only whether and in
 * what order it ran, since the real implementation can't run outside
 * Obsidian/DOM.
 */
function recordingTerminalFlow() {
	const calls: string[] = [];
	return {
		calls,
		runTerminalFlow: () => {
			calls.push("sessionAlive-check");
			calls.push("accordion-open");
			calls.push("ensureTerm");
		},
	};
}

const noSecrets: SecretStore = { hasToken: () => false, getToken: () => undefined };

/** A no-op spy — asserts (via its call list) that the runtime flow was/wasn't entered, without pulling in the real hand-off module. */
function recordingRuntimeFlow() {
	const calls: AgentRuntime[] = [];
	return { calls, runRuntimeFlow: (runtime: AgentRuntime) => calls.push(runtime) };
}

test("F8: target: terminal runs the terminal flow, in order, once", () => {
	const resolution = resolveClickTarget({ target: "terminal" }, { runtimes: [], defaultTarget: "terminal" }, noSecrets);
	const { calls, runTerminalFlow } = recordingTerminalFlow();
	const { calls: runtimeCalls, runRuntimeFlow } = recordingRuntimeFlow();
	runClickDecision(resolution, { runTerminalFlow, runRuntimeFlow });
	assert.deepEqual(calls, ["sessionAlive-check", "accordion-open", "ensureTerm"]);
	assert.deepEqual(runtimeCalls, []);
});

test("F8: no target: line runs the terminal flow the same way, when the default target is terminal", () => {
	const resolution = resolveClickTarget({}, { runtimes: [], defaultTarget: "terminal" }, noSecrets);
	const { calls, runTerminalFlow } = recordingTerminalFlow();
	const { runRuntimeFlow } = recordingRuntimeFlow();
	runClickDecision(resolution, { runTerminalFlow, runRuntimeFlow });
	assert.deepEqual(calls, ["sessionAlive-check", "accordion-open", "ensureTerm"]);
});

test("F8: a runtime-target click never runs the terminal flow, and runs the runtime flow with the resolved runtime instead", () => {
	const runtime: AgentRuntime = {
		id: "openclaw-id",
		name: "openclaw",
		kind: "openclaw-hook",
		baseUrl: "http://127.0.0.1:18789",
		agentId: "main",
		tokenRequired: false,
		sendSessionKeyHeader: false,
	};
	const resolution = resolveClickTarget({ target: "openclaw" }, { runtimes: [runtime], defaultTarget: "terminal" }, noSecrets);
	assert.equal(resolution.kind, "runtime");
	const { calls, runTerminalFlow } = recordingTerminalFlow();
	const { calls: runtimeCalls, runRuntimeFlow } = recordingRuntimeFlow();
	runClickDecision(resolution, { runTerminalFlow, runRuntimeFlow });
	assert.deepEqual(calls, []);
	assert.deepEqual(runtimeCalls, [runtime]);
});

test("F8: an unknown-target click that falls back to the terminal default still runs the terminal flow", () => {
	const resolution = resolveClickTarget({ target: "does-not-exist" }, { runtimes: [], defaultTarget: "terminal" }, noSecrets);
	assert.equal(resolution.kind, "terminal");
	assert.equal(resolution.notices.length, 1);
	const { calls, runTerminalFlow } = recordingTerminalFlow();
	const { runRuntimeFlow } = recordingRuntimeFlow();
	runClickDecision(resolution, { runTerminalFlow, runRuntimeFlow });
	assert.deepEqual(calls, ["sessionAlive-check", "accordion-open", "ensureTerm"]);
});

// --- `input:` buttons (G1, G7, G9) --------------------------------------

const idle = { hasInput: true, sessionAlive: false, handoffInFlight: false };

test("G1: an idle button with input: opens the field", () => {
	assert.equal(decideClickAction(idle), "open-field");
});

test("G9: a live terminal run (sessionAlive, which includes awaiting-input) does not open the field", () => {
	assert.equal(decideClickAction({ ...idle, sessionAlive: true }), "run-as-today");
});

test("G9: an in-flight hand-off does not open the field", () => {
	assert.equal(decideClickAction({ ...idle, handoffInFlight: true }), "run-as-today");
});

test("F3: a button without input: never opens the field, idle or not", () => {
	assert.equal(decideClickAction({ ...idle, hasInput: false }), "run-as-today");
	assert.equal(decideClickAction({ hasInput: false, sessionAlive: true, handoffInFlight: true }), "run-as-today");
});

function submitRecorder() {
	const events: string[] = [];
	return {
		events,
		hooks: {
			notify: (message: string) => events.push(`notice:${message}`),
			runTerminalFlow: (typed: string) => events.push(`terminal:${typed}`),
			runRuntimeFlow: (runtime: AgentRuntime, typed: string) => events.push(`runtime:${runtime.name}:${typed}`),
		},
	};
}

const openclaw: AgentRuntime = {
	id: "openclaw-id",
	name: "openclaw",
	kind: "openclaw-hook",
	baseUrl: "http://127.0.0.1:18789",
	agentId: "main",
	tokenRequired: false,
	sendSessionKeyHeader: false,
};

test("G7: a terminal target at submit runs the terminal flow once with the typed text, nothing else", () => {
	const resolution = resolveClickTarget({ target: "terminal" }, { runtimes: [openclaw], defaultTarget: "openclaw" }, noSecrets);
	const { events, hooks } = submitRecorder();
	runInputSubmit(resolution, "Obsidian Atlas dark mode", hooks);
	assert.deepEqual(events, ["terminal:Obsidian Atlas dark mode"]);
});

test("G7: a runtime target at submit runs the runtime flow once with the typed text and never the terminal flow", () => {
	const resolution = resolveClickTarget({ target: "openclaw" }, { runtimes: [openclaw], defaultTarget: "terminal" }, noSecrets);
	const { events, hooks } = submitRecorder();
	runInputSubmit(resolution, "Obsidian Atlas dark mode", hooks);
	assert.deepEqual(events, ["runtime:openclaw:Obsidian Atlas dark mode"]);
});

test("a bad target at submit reports one notice that fits and runs nothing (terminal default)", () => {
	const resolution = resolveClickTarget({ target: "does-not-exist" }, { runtimes: [], defaultTarget: "terminal" }, noSecrets);
	const { events, hooks } = submitRecorder();
	runInputSubmit(resolution, "typed", hooks);
	assert.deepEqual(events, ['notice:Unknown target "does-not-exist" — nothing was run. Check the button\'s target: line.']);
});

test("a bad target at submit runs nothing when the default target is a runtime too, even with ignored-field and token notices", () => {
	const needsToken: AgentRuntime = { ...openclaw, tokenRequired: true, tokenSecretName: "missing" };
	const resolution = resolveClickTarget({ target: "nope", model: "sonnet" }, { runtimes: [needsToken], defaultTarget: "openclaw" }, noSecrets);
	const { events, hooks } = submitRecorder();
	runInputSubmit(resolution, "typed", hooks);
	assert.deepEqual(events, ['notice:Unknown target "nope" — nothing was run. Check the button\'s target: line.']);
});

test("a click (not a submit) on a bad target still falls back to the default target with today's notice", () => {
	const resolution = resolveClickTarget({ target: "does-not-exist" }, { runtimes: [], defaultTarget: "terminal" }, noSecrets);
	assert.deepEqual(resolution.notices, ['Unknown target "does-not-exist" — running the default target instead.']);
	assert.equal(resolution.kind, "terminal");
});

test("typed text is passed to the flow as typed ($&, $1, template tokens, non-Latin)", () => {
	const typed = "$& $1 {{ file.path }} {{ input }} 合并";
	const resolution = resolveClickTarget({}, { runtimes: [], defaultTarget: "terminal" }, noSecrets);
	const { events, hooks } = submitRecorder();
	runInputSubmit(resolution, typed, hooks);
	assert.deepEqual(events, [`terminal:${typed}`]);
});
