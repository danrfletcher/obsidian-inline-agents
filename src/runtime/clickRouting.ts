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
