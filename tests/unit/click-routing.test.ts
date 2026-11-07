import { test } from "node:test";
import assert from "node:assert/strict";
import { decideClickAction, runClickDecision, runInputSubmit } from "../../src/runtime/clickRouting";
import { resolveClickTarget } from "../../src/runtime/targetResolve";
import { createSingleFlightHandoff } from "../../src/runtime/handoff";
import type { HandoffHooks, HandoffInput } from "../../src/runtime/handoff";
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

// --- G12: `completion: responseEnd` after the reply -------------------------
//
// After the reply the button looks idle (setVisualState("idle") fires on
// "idle-done") while the process is still running. The gate has no input for
// the visual state at all: it keys on `sessionAlive`, so the same idle look
// can mean "reopen the terminal" or "open the field", depending on that.

test("G12: sessionAlive with an idle-looking button reopens the terminal, no field", () => {
	const looksIdleSessionAlive = { hasInput: true, sessionAlive: true, handoffInFlight: false };
	assert.equal(decideClickAction(looksIdleSessionAlive), "run-as-today");

	// "run-as-today" for a terminal target is the terminal flow, whose own
	// sessionAlive check opens the accordion rather than starting a run.
	const resolution = resolveClickTarget({ target: "terminal", input: "Type here" }, { runtimes: [], defaultTarget: "terminal" }, noSecrets);
	const { calls, runTerminalFlow } = recordingTerminalFlow();
	const { calls: runtimeCalls, runRuntimeFlow } = recordingRuntimeFlow();
	runClickDecision(resolution, { runTerminalFlow, runRuntimeFlow });
	assert.deepEqual(calls, ["sessionAlive-check", "accordion-open", "ensureTerm"]);
	assert.deepEqual(runtimeCalls, []);
});

test("G12/GP6: once the session has ended the same button opens the field", () => {
	assert.equal(decideClickAction({ hasInput: true, sessionAlive: false, handoffInFlight: false }), "open-field");
});

test("G12: an in-flight hand-off gives no field and a second hand-off is ignored", async () => {
	// The gate answers "run-as-today" while a hand-off is in flight (the
	// button is disabled); the click is then ignored by the single-flight
	// wrapper buttonBlock.ts puts around every hand-off. Both halves are
	// driven here, with the real wrapper.
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let started = 0;
	const guarded = createSingleFlightHandoff(async () => {
		started++;
		await gate;
	});
	const input = {} as HandoffInput;
	const hooks = {} as HandoffHooks;

	const first = guarded(input, hooks);
	assert.equal(decideClickAction({ hasInput: true, sessionAlive: false, handoffInFlight: true }), "run-as-today");
	// The click that "run-as-today" lets through. Not awaited before the gate
	// is released: without the in-flight guard it would block on the gate and
	// hang the suite instead of failing the assertion below.
	const second = guarded(input, hooks);
	assert.equal(started, 1, "the second hand-off was ignored while the first was in flight");

	release();
	await Promise.all([first, second]);
	assert.equal(started, 1, "the ignored second hand-off never started after the first settled");
	await guarded(input, hooks);
	assert.equal(started, 2, "a click after the first settled starts a new hand-off");
});

test("G12: an in-flight hand-off still wins over everything: no field", () => {
	assert.equal(decideClickAction({ hasInput: true, sessionAlive: false, handoffInFlight: true }), "run-as-today");
	assert.equal(decideClickAction({ hasInput: true, sessionAlive: true, handoffInFlight: true }), "run-as-today");
});
