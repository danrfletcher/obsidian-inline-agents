import type { RuntimeKind } from "./types";
import { validateThreadUrlTemplate } from "./validation";

/** Chat kind, template uses `{sessionId}`, "Send session id" is off: Hermes never sees the id the link points at. */
export const SESSION_ID_TOGGLE_OFF_WARNING = "Hermes only uses this id when 'Send session id' is on.";

/** Hook kind, template uses `{sessionId}`: the hook request never carries the id. */
export const HOOK_IGNORES_SESSION_ID_WARNING = "OpenClaw ignores {sessionId}.";

/** Chat kind, both header toggles on: both headers are still sent. */
export const BOTH_HEADERS_WARNING =
	'The OpenClaw header sends a key containing ":" to Hermes. Both headers are still sent.';

/** The settings a runtime's warnings depend on. Matches the same-named `AgentRuntime` fields. */
export interface RuntimeWarningInput {
	kind: RuntimeKind;
	sendSessionKeyHeader: boolean;
	/** Absent (a runtime saved before the toggle existed) counts as off. */
	sendSessionIdHeader?: boolean;
	/** The template text as typed, not necessarily the stored value. */
	threadUrlTemplate?: string;
}

export interface RuntimeWarnings {
	/** At most one line, shown under the Thread-URL template field. */
	template?: string;
	/** Shown when the chat kind has both header toggles on; independent of the template. */
	bothHeaders?: string;
}

/** `{sessionId}` exactly as `buildThreadUrl` fills it: case-sensitive, no inner spaces. */
function usesSessionId(template: string): boolean {
	return template.includes("{sessionId}");
}

/**
 * Non-blocking warnings for one runtime's settings card, recomputed by the
 * settings tab whenever the template text, either header toggle or the kind
 * changes. Pure: it only reads its argument and never blocks saving. A
 * template that fails validation (disallowed or missing scheme) gets no
 * template warning, so the warning never competes with the validation error
 * shown for it.
 */
export function runtimeWarnings(input: RuntimeWarningInput): RuntimeWarnings {
	const warnings: RuntimeWarnings = {};
	const sessionIdOn = input.sendSessionIdHeader === true;
	const template = (input.threadUrlTemplate ?? "").trim();

	if (template && validateThreadUrlTemplate(template).ok && usesSessionId(template)) {
		if (input.kind === "openclaw-hook") warnings.template = HOOK_IGNORES_SESSION_ID_WARNING;
		else if (!sessionIdOn) warnings.template = SESSION_ID_TOGGLE_OFF_WARNING;
	}

	if (input.kind === "openai-chat" && input.sendSessionKeyHeader && sessionIdOn) {
		warnings.bothHeaders = BOTH_HEADERS_WARNING;
	}
	return warnings;
}
