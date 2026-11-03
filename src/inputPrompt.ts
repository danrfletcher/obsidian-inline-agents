import type { RenderPromptResult } from "./templating";

/**
 * Pure input-text handling for `input:` buttons — no "obsidian", DOM, fs or
 * window access, so it can be unit tested under Node
 * (tests/unit/input-prompt.test.ts). It holds no state: nothing here keeps a
 * copy of the typed text between calls.
 */

export const DEFAULT_INPUT_PLACEHOLDER = "Type here";

const OFF_RE = /^(false|no|off|0)$/i;

/**
 * Reads the `input:` button key. A bare `input:` gives the default
 * placeholder, `false`/`no`/`off`/`0` (any case) mean off (undefined), and
 * anything else is the placeholder text, case preserved.
 */
export function parseInputKey(value: string): string | undefined {
	const v = value.trim();
	if (v === "") return DEFAULT_INPUT_PLACEHOLDER;
	if (OFF_RE.test(v)) return undefined;
	return v;
}

// Exactly `{{ input }}` with optional spaces/tabs inside the braces. Not
// `{{ input.x }}`, `{{ Input }}`, `{{= input }}` and so on. Used only with
// split(), never as a replace() pattern, so the typed text can never be
// interpreted as a replacement string (`$&`, `$1`, ...).
const INPUT_TOKEN_RE = /\{\{[ \t]*input[ \t]*\}\}/;

export interface ComposedPrompt {
	text: string;
	/** Set if rendering failed; `text` is then the unrendered template and
	 * contains none of the typed text. Callers should not spawn the agent. */
	error?: string;
}

/**
 * Builds the prompt to dispatch from a button's prompt template and the
 * text typed into its field.
 *
 *  - The typed text is trimmed at both ends only.
 *  - If the template contains `{{ input }}`, it is matched on the template
 *    *before* rendering; the pieces between tokens are rendered separately
 *    and joined around the typed text, so every occurrence gets the text.
 *  - Otherwise the whole template is rendered, its trailing newlines are
 *    trimmed, and the text is appended after exactly one newline (or is the
 *    whole prompt if the rendered template is empty).
 *
 * The typed text is never passed to `render`, so it is never evaluated or
 * re-substituted. A render error returns `{ text: template, error }`.
 */
export function composePrompt(
	template: string,
	typedText: string,
	render: (segment: string) => RenderPromptResult,
): ComposedPrompt {
	const text = typedText.trim();
	const pieces = template.split(INPUT_TOKEN_RE);

	if (pieces.length > 1) {
		const rendered: string[] = [];
		for (const piece of pieces) {
			const r = render(piece);
			if (r.error) return { text: template, error: r.error };
			rendered.push(r.text);
		}
		return { text: rendered.join(text) };
	}

	const r = render(template);
	if (r.error) return { text: template, error: r.error };
	const base = r.text.replace(/[\r\n]+$/, "");
	return { text: base === "" ? text : `${base}\n${text}` };
}
