/**
 * Pure key handling for the `input:` field's textarea — no "obsidian", DOM,
 * fs or window access, so it can be unit tested under Node
 * (tests/unit/input-field-keys.test.ts). buttonBlock.ts calls it from the
 * keydown handler and acts on the result.
 */

export interface InputKeyEvent {
	key: string;
	shiftKey: boolean;
	/** `KeyboardEvent.isComposing`: an IME composition is active. */
	isComposing: boolean;
}

/**
 * What the keydown handler should do:
 *  - "submit":  prevent the default and submit the field's text (G2).
 *  - "cancel":  prevent the default and close the field, running nothing (G3).
 *  - "ignore":  prevent the default and do nothing — Enter on empty or
 *               whitespace-only text (G4).
 *  - "default": leave the key alone — typing, Shift+Enter's newline, and
 *               every key during an IME composition (G2).
 */
export type InputKeyAction = "submit" | "cancel" | "ignore" | "default";

/** Submit is enabled only when there is something besides whitespace to send (G4). */
export function canSubmitInput(text: string): boolean {
	return text.trim() !== "";
}

/** Classifies one keydown in the field. `text` is the field's current value. */
export function classifyInputKey(evt: InputKeyEvent, text: string): InputKeyAction {
	// Enter or Esc pressed to pick or abandon an IME candidate belongs to
	// the IME, never to the field.
	if (evt.isComposing) return "default";
	if (evt.key === "Escape") return "cancel";
	if (evt.key === "Enter") {
		if (evt.shiftKey) return "default";
		return canSubmitInput(text) ? "submit" : "ignore";
	}
	return "default";
}
