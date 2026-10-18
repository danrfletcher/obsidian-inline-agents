import type { HttpOutcome, HttpRequest } from "./types";

/**
 * G15: "the run lasts while Obsidian stays open (a dropped connection
 * cancels it)" — there's no reason to impose the hook kind's 15-second
 * ceiling here (G12's 5-second rule, not this, decides when a chat send
 * counts as settled), but the underlying HttpFn still needs *some* bound
 * so a socket that never resolves at all doesn't hang forever. 10 minutes
 * is a generous, arbitrary ceiling rather than a documented limit — a
 * judgement call, since the ticket doesn't specify one.
 */
export const CHAT_HTTP_TIMEOUT_MS = 10 * 60 * 1000;

export interface ChatRequestParams {
	baseUrl: string;
	/** Undefined when no token is configured for this runtime at all. */
	token: string | undefined;
	/** The runtime's agent id/model, or the button's `agentId:` override. */
	model: string;
	message: string;
	sessionKey: string;
	/** G1/G15: the runtime's own "send session key as x-openclaw-session-key" box. */
	sendSessionKeyHeader: boolean;
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/**
 * G15: `POST <base>/chat/completions`, one `user`-role chat message, and
 * the session key in the standard OpenAI-compatible `user` request field
 * (identifying the caller/session to the server) — distinct from the
 * message's own `role: "user"`, which is the chat turn itself. Also sends
 * `x-openclaw-session-key` when the runtime's own box for that is on.
 * `stream: false` is explicit rather than just omitted, since the whole
 * point is that the response is never read (F3/F9) — there's nothing to
 * stream into.
 */
export function buildChatRequest(params: ChatRequestParams): HttpRequest {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (params.token) headers.Authorization = `Bearer ${params.token}`;
	if (params.sendSessionKeyHeader) headers["x-openclaw-session-key"] = params.sessionKey;
	const body = JSON.stringify({
		model: params.model,
		messages: [{ role: "user", content: params.message }],
		user: params.sessionKey,
		stream: false,
	});
	return { url: `${trimTrailingSlash(params.baseUrl)}/chat/completions`, method: "POST", headers, body };
}

export type ChatSendResult = { kind: "accepted" } | ChatFailureResult;

export type ChatFailureResult =
	| { kind: "unauthorized" }
	| { kind: "httpError"; status: number }
	| { kind: "unreachable" };

/**
 * Classifies a chat send's raw outcome by HTTP status only — the response
 * body is never read (G15), so there's nothing here to parse. Whether this
 * counts as "settled" at all is the 5-second rule in handoff.ts, not this
 * function — this just says what *kind* of outcome it was, whenever it
 * actually arrives.
 */
export function classifyChatOutcome(outcome: HttpOutcome): ChatSendResult {
	switch (outcome.kind) {
		case "timeout":
		case "refused":
		case "error":
			return { kind: "unreachable" };
		case "response": {
			const { status } = outcome;
			if (status === 401 || status === 403) return { kind: "unauthorized" };
			if (status < 200 || status >= 300) return { kind: "httpError", status };
			return { kind: "accepted" };
		}
	}
}
