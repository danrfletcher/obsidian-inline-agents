/**
 * Shared types for agent runtimes (settings, target resolution, the HTTP
 * seam used by "Test connection"). Nothing in this file imports "obsidian" —
 * it's imported by both the plugin's Obsidian-facing glue and by the
 * Node-only test suite (see tests/unit).
 */

/** The two runtime kinds this plugin ships. */
export type RuntimeKind = "openclaw-hook" | "openai-chat";

/**
 * A user-configured HTTP agent runtime (settings → "Agent runtimes"). The
 * token itself is never part of this object. Obsidian's secret storage is
 * shared across plugins and keyed by a *name* the user picks or creates
 * through the SecretComponent picker (see docs.obsidian.md, "Store
 * secrets") — `tokenSecretName` holds that name, not the secret, so storing
 * it in data.json is fine (F5). The actual value is looked up on demand via
 * `app.secretStorage.getSecret(tokenSecretName)`.
 */
export interface AgentRuntime {
	/** Stable id generated once at creation. Never shown or edited. */
	id: string;
	/** User-visible, unique (case-insensitive) name — what `target: <name>` matches against. */
	name: string;
	kind: RuntimeKind;
	baseUrl: string;
	/** Agent id (OpenClaw hook) or model (OpenAI-compatible chat); a button's `agentId:` can override it. */
	agentId: string;
	/** Whether a missing token on this device blocks a click. Default true. */
	tokenRequired: boolean;
	/** Name of the secret in Obsidian's shared secret storage that holds this runtime's token, if one is set. */
	tokenSecretName?: string;
	/** Chat kind only: also send the session key as `x-openclaw-session-key`. Default false. */
	sendSessionKeyHeader: boolean;
	/** Optional URL used to open the thread; may use {agentId}, {sessionKey}, {sessionKeyPath}. */
	threadUrlTemplate?: string;
}

/** Per-device token lookup, abstracted away from Obsidian's actual secretStorage so it's fake-able in tests. */
export interface SecretStore {
	hasToken(tokenSecretName: string | undefined): boolean;
	/**
	 * The actual secret value, read at send time only (F5: never cached in
	 * module state) — undefined when there's no secret name configured or
	 * nothing stored under it on this device.
	 */
	getToken(tokenSecretName: string | undefined): string | undefined;
}

/** The only shape the runtime module is allowed to build a request from — see httpAdapter.ts for the real implementation. */
export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	/**
	 * Whether the caller needs the response text (`HttpOutcome.body`). Off by
	 * default: only the hook kind sets it (it parses a `{ ok, runId }` reply);
	 * the chat kind and "Test connection" never read a response body (G15).
	 */
	readBody?: boolean;
}

/**
 * Never throws — every failure mode (including a thrown error from the
 * underlying transport) is normalized into one of these outcomes before it
 * reaches anything that builds a user-facing message, so there's exactly one
 * place (the adapter) that could ever leak a raw error string.
 *
 * `body` (response kind only) carries the raw response text, present only
 * when the request set `readBody` (see httpCore.ts): the hook kind asks for
 * it and parses it as JSON `{ ok, runId }` via hookRequest.ts's
 * classifyHookOutcome; the chat kind never asks, so its response body is
 * never read at all (G15).
 */
export type HttpOutcome =
	| { kind: "response"; status: number; body?: string }
	| { kind: "timeout" }
	| { kind: "refused" }
	| { kind: "error"; reason: string };

export type HttpFn = (request: HttpRequest) => Promise<HttpOutcome>;
