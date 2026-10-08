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
 * token itself is never part of this object — it lives in Obsidian's
 * per-device secret storage, keyed by `id` (see SecretStore below).
 */
export interface AgentRuntime {
	/** Stable id generated once at creation; used as the secret-storage key. Never shown or edited. */
	id: string;
	/** User-visible, unique (case-insensitive) name — what `target: <name>` matches against. */
	name: string;
	kind: RuntimeKind;
	baseUrl: string;
	/** Agent id (OpenClaw hook) or model (OpenAI-compatible chat); a button's `agentId:` can override it. */
	agentId: string;
	/** Whether a missing token on this device blocks a click. Default true. */
	tokenRequired: boolean;
	/** Chat kind only: also send the session key as `x-openclaw-session-key`. Default false. */
	sendSessionKeyHeader: boolean;
	/** Optional URL used to open the thread; may use {agentId}, {sessionKey}, {sessionKeyPath}. */
	threadUrlTemplate?: string;
}

/** Per-device token lookup, abstracted away from Obsidian's actual secretStorage so it's fake-able in tests. */
export interface SecretStore {
	hasToken(runtimeId: string): boolean;
}

/** The only shape the runtime module is allowed to build a request from — see httpAdapter.ts for the real implementation. */
export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

/**
 * Never throws — every failure mode (including a thrown error from the
 * underlying transport) is normalized into one of these outcomes before it
 * reaches anything that builds a user-facing message, so there's exactly one
 * place (the adapter) that could ever leak a raw error string.
 */
export type HttpOutcome =
	| { kind: "response"; status: number }
	| { kind: "timeout" }
	| { kind: "refused" }
	| { kind: "error"; reason: string };

export type HttpFn = (request: HttpRequest) => Promise<HttpOutcome>;
