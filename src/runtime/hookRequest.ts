import type { HttpOutcome, HttpRequest } from "./types";

/** G14: "waits up to 15 s; longer counts as unreachable (E2)" — the timeout the caller must construct this kind's HttpFn with (see httpAdapter.ts's createObsidianHttpFn(HOOK_TIMEOUT_MS)); kept here so the one number that matters lives next to the request it governs. */
export const HOOK_TIMEOUT_MS = 15000;

export interface HookRequestParams {
	baseUrl: string;
	/** Undefined when no token is configured for this runtime at all (G1's "token required" box can be off). */
	token: string | undefined;
	agentId: string;
	/** The hook body's `name` field — see handoff.ts for which value this is (a judgement call: the ticket doesn't specify what this field is for). */
	name: string;
	sessionKey: string;
	message: string;
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/**
 * G14: `POST <base>/hooks/agent`, bearer auth, a fresh `Idempotency-Key`
 * per call (so OpenClaw can de-dupe a retried click), persistent session
 * mode and `deliver: false` — the run is asynchronous and keeps going on
 * OpenClaw's side regardless of whether Obsidian stays open to see it.
 */
export function buildHookRequest(params: HookRequestParams): HttpRequest {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"Idempotency-Key": crypto.randomUUID(),
	};
	if (params.token) headers.Authorization = `Bearer ${params.token}`;
	const body = JSON.stringify({
		message: params.message,
		agentId: params.agentId,
		name: params.name,
		sessionKey: params.sessionKey,
		sessionMode: "persistent",
		deliver: false,
	});
	return { url: `${trimTrailingSlash(params.baseUrl)}/hooks/agent`, method: "POST", headers, body };
}

export type HookSendResult = { kind: "ok"; runId: string } | HookFailureResult;

export type HookFailureResult =
	| { kind: "sessionKeyRejected" }
	| { kind: "unauthorized" }
	| { kind: "httpError"; status: number }
	| { kind: "unreachable" };

function safeParseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * G14/E12: OpenClaw's own wording for "the session-key policy isn't
 * enabled" isn't pinned down anywhere the ticket could verify (Q17, still
 * unverified at Dan's real server), so rather than match one fixed
 * sentence, this looks for the two concepts any such message has to
 * mention — a session key, and either the `allowRequestSessionKey` flag
 * or the "inline:" prefix allow-list — in whatever `error` text a 400
 * response carries.
 */
function isSessionKeyPolicyError(body: Record<string, unknown> | undefined): boolean {
	const text = typeof body?.error === "string" ? body.error : "";
	if (!text) return false;
	return /allowRequestSessionKey/i.test(text) || (/session.?key/i.test(text) && /(allow|prefix|polic|disabled|not enabled)/i.test(text));
}

/**
 * Normalizes the raw HttpOutcome of a hook send into exactly the cases the
 * hand-off flow needs to react to (G14, E3, E4, E12) — the response body
 * is only ever inspected here, to test for the one known policy-error
 * shape and to read `ok`/`runId`; it never reaches a notice or any other
 * caller (F5), and a malformed/unparsable body is treated the same as "no
 * runId" rather than thrown.
 */
export function classifyHookOutcome(outcome: HttpOutcome): HookSendResult {
	switch (outcome.kind) {
		case "timeout":
		case "refused":
		case "error":
			return { kind: "unreachable" };
		case "response": {
			const { status, body } = outcome;
			if (status === 401 || status === 403) return { kind: "unauthorized" };
			const parsed = safeParseJsonObject(body);
			if (status === 400 && isSessionKeyPolicyError(parsed)) return { kind: "sessionKeyRejected" };
			if (status < 200 || status >= 300) return { kind: "httpError", status };
			const runId = parsed?.runId;
			if (parsed?.ok === true && typeof runId === "string" && runId.length > 0) {
				return { kind: "ok", runId };
			}
			return { kind: "httpError", status };
		}
	}
}
