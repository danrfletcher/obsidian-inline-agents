import type { HttpFn } from "./types";

export interface TestConnectionResult {
	ok: boolean;
	/** Status and reason only — never a body or header (F5/F6). */
	message: string;
}

export interface TestConnectionRuntime {
	baseUrl: string;
	tokenRequired: boolean;
}

/**
 * G3: checks reachability and the token, without sending a prompt — this
 * never builds a `/hooks/agent` or `/chat/completions` request, just a GET
 * against the runtime's base URL with (at most) a bearer token header
 * (F6: no OAuth, no other custom header). Uses whatever token is currently
 * entered in the form (E6), not what's already saved to secret storage.
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

	const outcome = await httpFn({ url: runtime.baseUrl, method: "GET", headers });

	switch (outcome.kind) {
		case "response":
			if (outcome.status >= 200 && outcome.status < 300) {
				return { ok: true, message: `Reachable (status ${outcome.status}).` };
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
