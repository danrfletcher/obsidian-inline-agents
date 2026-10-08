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
}

/**
 * The only thing standing between a resolved target and the terminal: for
 * "terminal", run the (unchanged) terminal flow; for "runtime", do nothing
 * terminal-related at all. Sending the prompt to a runtime isn't built yet
 * (that's PR-1.F1) — this PR's runtime branch is otherwise a no-op once its
 * notices (unknown target, ignored fields, token missing) have been shown.
 */
export function runClickDecision(resolution: TargetResolution, hooks: ClickRoutingHooks): void {
	if (resolution.kind === "terminal") {
		hooks.runTerminalFlow();
	}
}
