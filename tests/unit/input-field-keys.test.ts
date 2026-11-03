import { test } from "node:test";
import assert from "node:assert/strict";
import { canSubmitInput, classifyInputKey } from "../../src/inputFieldKeys";
import type { InputKeyAction, InputKeyEvent } from "../../src/inputFieldKeys";

function key(k: string, extra: Partial<InputKeyEvent> = {}): InputKeyEvent {
	return { key: k, shiftKey: false, isComposing: false, ...extra };
}

interface Row {
	name: string;
	evt: InputKeyEvent;
	text: string;
	expected: InputKeyAction;
}

const rows: Row[] = [
	{ name: "G2: Enter with text submits", evt: key("Enter"), text: "Obsidian Atlas dark mode", expected: "submit" },
	{ name: "G2: Enter with multi-line text submits", evt: key("Enter"), text: "a\nb", expected: "submit" },
	{ name: "G2: Shift+Enter is left to insert a newline", evt: key("Enter", { shiftKey: true }), text: "abc", expected: "default" },
	{ name: "G2: Shift+Enter on empty text still just inserts a newline", evt: key("Enter", { shiftKey: true }), text: "", expected: "default" },
	{ name: "G2: Enter during IME composition never submits", evt: key("Enter", { isComposing: true }), text: "abc", expected: "default" },
	{ name: "G3: Esc cancels", evt: key("Escape"), text: "abc", expected: "cancel" },
	{ name: "G3: Esc cancels an empty field", evt: key("Escape"), text: "", expected: "cancel" },
	{ name: "G3: Esc during IME composition belongs to the IME", evt: key("Escape", { isComposing: true }), text: "abc", expected: "default" },
	{ name: "G4: Enter on empty text does nothing", evt: key("Enter"), text: "", expected: "ignore" },
	{ name: "G4: Enter on spaces only does nothing", evt: key("Enter"), text: "   ", expected: "ignore" },
	{ name: "G4: Enter on newlines and tabs only does nothing", evt: key("Enter"), text: "\n\t \r\n", expected: "ignore" },
	{ name: "G4: Enter on text with surrounding blanks still submits", evt: key("Enter"), text: "  x \n", expected: "submit" },
	{ name: "an ordinary character is left alone", evt: key("a"), text: "", expected: "default" },
	{ name: "Backspace is left alone", evt: key("Backspace"), text: "abc", expected: "default" },
	{ name: "an arrow key is left alone", evt: key("ArrowLeft"), text: "abc", expected: "default" },
];

for (const row of rows) {
	test(row.name, () => {
		assert.equal(classifyInputKey(row.evt, row.text), row.expected);
	});
}

test("G4: canSubmitInput is false for empty and whitespace-only text, true otherwise", () => {
	assert.equal(canSubmitInput(""), false);
	assert.equal(canSubmitInput(" \n\t "), false);
	assert.equal(canSubmitInput("x"), true);
	assert.equal(canSubmitInput("  x  "), true);
});
