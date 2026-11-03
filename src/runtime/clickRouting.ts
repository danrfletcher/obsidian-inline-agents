import type { AgentRuntime } from "./types";
import type { TargetResolution } from "./targetResolve";

export interface ClickRoutingHooks {
	/**
	 * The entire existing (0.2.1) click body — sessionAlive check, accordion,
	 * ensureTerm, spawn, all of it — passed in unchanged by buttonBlock.ts.
	 * Kept as a single opaque callback rather than broken into per-step hooks
	 * so this seam can't drift from "the runtime branch is not entered" (F8)
	 * into "some of the terminal steps run anyway".
	 */
	runTerminalFlow: () => void;
	/** PR-1.F1: hands the resolved runtime off to the hand-off flow (see runtime/handoff.ts) — never touches any terminal state (F8, G11: no run state, no completion, no file output for a runtime target). */
	runRuntimeFlow: (runtime: AgentRuntime) => void;
}

/**
 * The only thing standing between a resolved target and the terminal: for
 * "terminal", run the (unchanged) terminal flow; for "runtime", hand off to
 * the HTTP runtime flow instead — never both, and never a terminal flash
 * on the way there (F8).
 */
export function runClickDecision(resolution: TargetResolution, hooks: ClickRoutingHooks): void {
	if (resolution.kind === "terminal") {
		hooks.runTerminalFlow();
	} else {
		hooks.runRuntimeFlow(resolution.runtime);
	}
}

export interface ClickState {
	/** The button has an `input:` line (`spec.input` is set). */
	hasInput: boolean;
	/** A terminal child process is alive — includes the `is-awaiting-input` state and a `completion: responseEnd` button that already looks idle. */
	sessionAlive: boolean;
	/** This block's own HTTP hand-off is in flight (`button.disabled`). */
	handoffInFlight: boolean;
}

/**
 * G1/G9: what a click on the button does. "open-field" only for an idle
 * button with an `input:` line; every other click is "run-as-today" — the
 * existing path, which reopens a live terminal or ignores a click during an
 * in-flight hand-off, and which for a button without `input:` runs it.
 */
export function decideClickAction(state: ClickState): "open-field" | "run-as-today" {
	if (!state.hasInput || state.sessionAlive || state.handoffInFlight) return "run-as-today";
	return "open-field";
}

export interface InputSubmitHooks {
	/** Shows one Notice. */
	notify: (message: string) => void;
	/** The terminal flow with the typed text to compose into the prompt. */
	runTerminalFlow: (typedText: string) => void;
	/** The runtime flow with the typed text to compose into the prompt. */
	runRuntimeFlow: (runtime: AgentRuntime, typedText: string) => void;
}

/**
 * G7: the submit-time counterpart of a click. The resolution passed in was
 * made at submit, so its notices are shown here — once each — and the typed
 * text is handed to whichever flow it picked. Rendering and composing
 * happen inside the flows, so a render error shows the same message as
 * today and spawns nothing.
 *
 * An unknown `target:` is the exception to a click's fallback: a click
 * runs the default target (E1), but a submit would then send the typed
 * text somewhere the author never named, so nothing runs. Today's notice
 * says "running the default target instead", which would be untrue here,
 * so it is replaced by one notice saying nothing was run.
 */
export function runInputSubmit(resolution: TargetResolution, typedText: string, hooks: InputSubmitHooks): void {
	if (resolution.unknownTarget !== undefined) {
		hooks.notify(`Unknown target "${resolution.unknownTarget}" — nothing was run. Check the button's target: line.`);
		return;
	}
	resolution.notices.forEach((notice) => hooks.notify(notice));
	runClickDecision(resolution, {
		runTerminalFlow: () => hooks.runTerminalFlow(typedText),
		runRuntimeFlow: (runtime) => hooks.runRuntimeFlow(runtime, typedText),
	});
}
