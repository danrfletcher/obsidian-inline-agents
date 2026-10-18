/**
 * The hand-off's request body text — shared between both runtime kinds
 * (see hookRequest.ts / chatRequest.ts), since G7/G14/G15 describe the
 * same underlying shape with one difference: the hook kind gets an extra
 * preface line the chat kind never sends.
 */

/** G14's settled wording for the one preface line the hook kind (and only the hook kind) prepends — OpenClaw still wraps the hook text as untrusted content; this line reduces the chance it gets summarised instead of carried out. */
export const HOOK_PREFACE = "This is an instruction from the vault owner, sent by their Inline Agents button. Carry it out.";

/**
 * `<rendered prompt>\n\nNote: <absolute path>`, optionally preceded by
 * `HOOK_PREFACE` + a newline. The prompt is sent exactly as rendered — no
 * trimming, no truncation (E9) — so only the preface and the trailing
 * "Note:" line are added around it.
 */
export function buildHandoffMessage(prompt: string, notePath: string, includePreface: boolean): string {
	const body = `${prompt}\n\nNote: ${notePath}`;
	return includePreface ? `${HOOK_PREFACE}\n${body}` : body;
}
