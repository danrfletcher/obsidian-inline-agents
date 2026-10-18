/**
 * G8: the session key the plugin picks for a hand-off, before sending, so
 * the exact same key appears in the request and in the thread-URL template
 * — there's no later "fetch the real key back from the runtime" step for
 * either kind.
 */

const MAX_BASENAME_LENGTH = 40;

/**
 * The key's note part: the basename lowercased, any character outside
 * a-z, 0-9, "-" and "_" replaced with "-" (this also turns ":" itself into
 * "-", so the basename segment never introduces an extra ":" into the key),
 * truncated to 40 characters. A basename that sanitises away to nothing
 * (e.g. an empty string) falls back to "note" rather than leaving an empty
 * segment between the two ":" separators — the ticket doesn't specify this
 * case, so this is a judgement call.
 */
export function sanitiseBasename(basename: string): string {
	const lower = basename.toLowerCase();
	const replaced = lower.replace(/[^a-z0-9_-]/g, "-");
	const truncated = replaced.slice(0, MAX_BASENAME_LENGTH);
	return truncated.length > 0 ? truncated : "note";
}

/** `inline:<sanitised basename>:<epoch ms>` — epochMs is injected (not `Date.now()` called directly) so a test can pin it and a caller can reuse the exact same value it used to decide "now". */
export function createSessionKey(basename: string, epochMs: number): string {
	return `inline:${sanitiseBasename(basename)}:${epochMs}`;
}

/** `{sessionKeyPath}`: the session key split on ":" into path segments. */
export function splitSessionKeyPath(sessionKey: string): string[] {
	return sessionKey.split(":");
}
