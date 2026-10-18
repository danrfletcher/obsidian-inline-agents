import type { HttpFn, RuntimeKind } from "./types";

export interface TestConnectionResult {
	ok: boolean;
	/** Status and reason only — never a body or header (F5/F6). */
	message: string;
}

export interface TestConnectionRuntime {
	baseUrl: string;
	tokenRequired: boolean;
	kind: RuntimeKind;
}

/**
 * The URL "Test connection" checks, per kind. `openai-chat` has a
 * standard, auth-protected, non-prompt endpoint (`GET /models`) that
 * actually validates the token. `openclaw-hook` has none — every documented
 * hook endpoint (`/hooks/wake`, `/hooks/agent`, `/hooks/<name>`) is POST-only
 * and triggers a real action, so this falls back to the bare base URL,
 * which only proves the server is reachable (see the caller for the
 * resulting caveat in the message).
 */
function buildCheckUrl(runtime: TestConnectionRuntime): string {
	if (runtime.kind === "openai-chat") {
		return `${runtime.baseUrl.replace(/\/+$/, "")}/models`;
	}
	return runtime.baseUrl;
}

/**
 * G3: checks reachability and the token, without sending a prompt — this
 * never builds a `/hooks/agent` or `/chat/completions` request, just a GET
 * against a kind-specific, non-prompt endpoint with (at most) a bearer
 * token header (F6: no OAuth, no other custom header). Uses whatever token
 * is currently entered in the form (E6), not what's already saved to
 * secret storage.
 *
 * Every branch here is a canned, fixed string plus a status code — F5
 * requires that no output of this module ever contains the token, for
 * every one of these outcomes, so nothing here is allowed to echo a raw
 * header, body, or (for the "error" outcome) an unsanitized error message;
 * see httpAdapter.ts, which is responsible for turning any thrown error
 * into one of HttpOutcome's fixed shapes before it reaches here.
 */
export async function testConnection(
	runtime: TestConnectionRuntime,
	token: string,
	httpFn: HttpFn
): Promise<TestConnectionResult> {
	const trimmedToken = token.trim();
	if (runtime.tokenRequired && !trimmedToken) {
		return { ok: false, message: "Token required but not entered." };
	}

	const headers: Record<string, string> = {};
	if (trimmedToken) headers.Authorization = `Bearer ${trimmedToken}`;

	const outcome = await httpFn({ url: buildCheckUrl(runtime), method: "GET", headers });
	// OpenClaw documents no auth-checked, non-prompt hook endpoint (R2) — a
	// 2xx here only proves the server is up, not that the token is valid,
	// so say so rather than imply a check that didn't happen.
	const reachableOnlyNote =
		runtime.kind === "openclaw-hook"
			? " This only checks reachability — OpenClaw's hook endpoints have no safe way to verify the token without sending a prompt."
			: "";

	switch (outcome.kind) {
		case "response":
			if (outcome.status >= 200 && outcome.status < 300) {
				return { ok: true, message: `Reachable (status ${outcome.status}).${reachableOnlyNote}` };
			}
			if (outcome.status === 401 || outcome.status === 403) {
				return { ok: false, message: `Token rejected (status ${outcome.status}).` };
			}
			if (outcome.status >= 500) {
				return { ok: false, message: `Server error (status ${outcome.status}).` };
			}
			return { ok: false, message: `Unexpected response (status ${outcome.status}).` };
		case "timeout":
			return { ok: false, message: "Timed out." };
		case "refused":
			return { ok: false, message: "Connection refused." };
		case "error":
			return { ok: false, message: `Request failed (${outcome.reason}).` };
	}
}
