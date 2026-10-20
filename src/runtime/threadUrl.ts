import { extractUrlScheme, isDisallowedUrlScheme } from "./validation";
import { splitSessionKeyPath } from "./sessionKey";

export interface ThreadUrlVars {
	agentId: string;
	sessionKey: string;
}

/**
 * G9: fills `{agentId}`, `{sessionKey}` and `{sessionKeyPath}` (the session
 * key split on ":" into path segments, rejoined with "/" — the natural
 * separator for a URL path) into a runtime's thread-URL template. Returns
 * undefined when there's no template to fill at all (E5: fire-and-forget,
 * nothing to open).
 *
 * `{agentId}` is URI-encoded: it can come from a button's free-text
 * `agentId:` override, and a "/", "?" or "#" in it must not change the
 * URL's structure. `{sessionKey}` / `{sessionKeyPath}` are inserted as-is:
 * the plugin builds the key itself from a basename sanitised to
 * [a-z0-9_-] plus ":" separators and an epoch (see sessionKey.ts), so it
 * can't contain a URL-structural character, and encoding the ":" would
 * change the documented URL shape.
 */
export function buildThreadUrl(template: string | undefined, vars: ThreadUrlVars): string | undefined {
	const trimmed = (template ?? "").trim();
	if (!trimmed) return undefined;
	const sessionKeyPath = splitSessionKeyPath(vars.sessionKey).join("/");
	return trimmed
		.replace(/\{agentId\}/g, () => encodeURIComponent(vars.agentId))
		.replace(/\{sessionKeyPath\}/g, sessionKeyPath)
		.replace(/\{sessionKey\}/g, vars.sessionKey);
}

export interface OpenResult {
	opened: boolean;
	/** Set only when `opened` is false — why nothing was opened, for a notice. */
	reason?: string;
}

/**
 * G9/GP6/R1: the href the settled "↗" thread link should carry — the real
 * thread URL when its scheme is one `openThreadUrl` would actually open,
 * or "#" (never the raw filled URL) when there's no URL at all or its
 * scheme is one of the ones that must never open automatically. Keeping a
 * disallowed scheme out of `href` entirely (not just out of the click
 * handler) matters because an anchor's `href` can be reached outside the
 * click listener too (e.g. a middle-click or "open in new tab", which
 * bypasses `preventDefault`) — this is the second line of defence the
 * click handler's own `openThreadUrl` call backs up.
 */
export function threadLinkHref(threadUrl: string | undefined): string {
	if (!threadUrl) return "#";
	const scheme = extractUrlScheme(threadUrl);
	return scheme && !isDisallowedUrlScheme(scheme) ? threadUrl : "#";
}

/**
 * G9: opens a thread URL through the operating system's own handler
 * (`window.open`, injected here as `openFn` so this stays testable under
 * Node) — on desktop this is what hands an http(s) URL to the user's
 * default browser, and is also what lets a custom scheme reach whichever
 * app registered it (e.g. Hermes' desktop app). The handful of schemes
 * that must never open automatically are refused here too, as a second
 * line of defence alongside validateThreadUrlTemplate's settings-time
 * check, in case a template reached this point some other way (e.g. an
 * older data.json saved before that check existed).
 */
export function openThreadUrl(url: string, openFn: (url: string) => void): OpenResult {
	const scheme = extractUrlScheme(url);
	if (!scheme) {
		return { opened: false, reason: "Thread URL has no scheme — nothing opened." };
	}
	if (isDisallowedUrlScheme(scheme)) {
		return { opened: false, reason: `The "${scheme}:" scheme is not allowed to open automatically.` };
	}
	openFn(url);
	return { opened: true };
}
