import { test } from "node:test";
import assert from "node:assert/strict";
import { runClickDecision } from "../../src/runtime/clickRouting";
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
