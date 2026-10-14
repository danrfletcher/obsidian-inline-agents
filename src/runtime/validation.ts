import type { AgentRuntime } from "./types";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Schemes a thread-URL template is never allowed to use, regardless of how it's typed. */
const DISALLOWED_THREAD_URL_SCHEMES = new Set(["file", "javascript", "data", "vbscript"]);

/**
 * The thread-URL template is optional and user-supplied (the plugin doesn't
 * know any runtime's URL scheme — see the ticket's constraints), so this only
 * rejects the handful of schemes that are never safe to open automatically
 * (G1's acceptance line). Everything else, including made-up app schemes
 * like `hermes://`, is accepted.
 */
export function validateThreadUrlTemplate(raw: string): ValidationResult {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: true };
	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
	if (!match) {
		return { ok: false, reason: "Thread-URL template must start with a scheme, e.g. https:// or myapp://." };
	}
	const scheme = match[1].toLowerCase();
	if (DISALLOWED_THREAD_URL_SCHEMES.has(scheme)) {
		return { ok: false, reason: `The "${scheme}:" scheme is not allowed in a thread-URL template.` };
	}
	return { ok: true };
}

/**
 * A runtime's base URL is always a real http(s) API endpoint (unlike the
 * thread-URL template). Rejected outright — rather than silently stripped —
 * if it could carry a token: embedded basic-auth credentials or a query
 * string (F5: a token must never end up in the base URL).
 */
export function validateBaseUrl(raw: string): ValidationResult {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, reason: "Base URL is required." };
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, reason: "Base URL is not a valid URL." };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: "Base URL must use http or https." };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, reason: "Base URL must not contain a username or password." };
	}
	if (parsed.search) {
		return { ok: false, reason: "Base URL must not contain a query string." };
	}
	return { ok: true };
}

/** Name uniqueness (case-insensitive) and non-emptiness — E14. `selfIndex` is -1 when validating a brand-new row. */
export function validateRuntimeName(name: string, runtimes: AgentRuntime[], selfIndex: number): ValidationResult {
	const trimmed = name.trim();
	if (!trimmed) return { ok: false, reason: "Name is required." };
	const duplicate = runtimes.some((r, i) => i !== selfIndex && r.name.trim().toLowerCase() === trimmed.toLowerCase());
	if (duplicate) return { ok: false, reason: `A runtime named "${trimmed}" already exists.` };
	return { ok: true };
}
