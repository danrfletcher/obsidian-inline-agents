/**
 * How a failed hand-off falls back to the terminal (G12, G14). Kept out of
 * buttonBlock.ts, which imports "obsidian" and xterm and so cannot load
 * under Node, so tests/runtime/handoff-fallback.test.ts can drive the real
 * wiring.
 */

export interface FallbackWiring {
	/** The text submitted from an `input:` field; undefined for a plain click. */
	typedText: string | undefined;
	/** The prompt the hand-off was given — already rendered and, with `typedText`, composed. */
	composedPrompt: string;
	/** Puts the button back to how it looked before the hand-off started. */
	restoreButton: () => void;
	/**
	 * The terminal flow. With `composedPrompt` it runs exactly that prompt
	 * and renders nothing; without it, it renders the button's prompt
	 * itself, as it always has.
	 */
	runTerminalFlow: (typedText?: string, composedPrompt?: string) => void;
}

/**
 * Builds the `fallbackToTerminal` hook for one hand-off.
 *
 * A button without `input:` falls back exactly as before: the terminal
 * flow renders the button's prompt again. With typed text the terminal
 * gets the very prompt the runtime was given instead, because a second
 * render of the button's prompt would not contain the typed text. The
 * typed text is passed along too, only so the file output can leave it
 * out (see extractCleanText).
 */
export function createFallbackToTerminal(wiring: FallbackWiring): () => void {
	return () => {
		wiring.restoreButton();
		if (wiring.typedText === undefined) {
			wiring.runTerminalFlow();
		} else {
			wiring.runTerminalFlow(wiring.typedText, wiring.composedPrompt);
		}
	};
}
