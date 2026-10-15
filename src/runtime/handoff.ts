import type { AgentRuntime, HttpFn } from "./types";
import { createSessionKey } from "./sessionKey";
import { buildThreadUrl, openThreadUrl } from "./threadUrl";
import { buildHandoffMessage } from "./message";
import { buildHookRequest, classifyHookOutcome } from "./hookRequest";
import type { HookFailureResult } from "./hookRequest";
import { buildChatRequest, classifyChatOutcome } from "./chatRequest";
import type { ChatFailureResult } from "./chatRequest";

/** G12: "settled" for the chat kind means 5 seconds passed with no error — it has no separate "accepted" signal of its own. */
const CHAT_SETTLE_MS = 5000;

export interface HandoffInput {
	runtime: AgentRuntime;
	/** The button's `agentId:` override, if any — falls back to `runtime.agentId` when absent/blank. */
	agentIdOverride?: string;
	/** Already rendered (templating has already run); not yet checked for emptiness — see E8. */
	prompt: string;
	/** Absolute path of the note the button lives in — the message's last line. */
	notePath: string;
	/** The note's basename — the session key's note part (G8). */
	noteBasename: string;
	/** The button's `open:` line resolved against the settings default, already computed by the caller. */
	openRequested: boolean;
	/** Looked up from secret storage right before this call, held nowhere else (F5). */
	token: string | undefined;
}

export interface HandoffHooks {
	/** The single HTTP seam — real callers pass `createObsidianHttpFn(...)` configured with the right timeout for this runtime's kind (HOOK_TIMEOUT_MS for a hook, something generous for chat); tests pass a fake. */
	httpFn: HttpFn;
	/** Epoch ms "now" — injected so the session key is deterministic in tests. */
	nowMs: () => number;
	/** `window.open`, injected so opening a thread is testable without a real window. */
	openUrl: (url: string) => void;
	notify: (message: string) => void;
	/** G7: "Sending to <name>…". */
	onSending: () => void;
	/** G9: "Sent to <name> ↗" (threadUrl set) or plain "Sent to <name>" (threadUrl undefined). */
	onSent: (threadUrl: string | undefined) => void;
	/** G12: runs the button as the terminal would have, before any runtime routing existed. */
	fallbackToTerminal: () => void;
}

function hookFailureNotice(name: string, result: HookFailureResult): string {
	switch (result.kind) {
		case "sessionKeyRejected":
			return "OpenClaw rejected the session key: enable allowRequestSessionKey and allow the inline: prefix";
		case "unauthorized":
			return "token rejected";
		case "httpError":
			return `${name} returned status ${result.status}.`;
		case "unreachable":
			return `${name} isn't reachable, running here`;
	}
}

function chatFailureNotice(name: string, result: ChatFailureResult): string {
	switch (result.kind) {
		case "unauthorized":
			return "token rejected";
		case "httpError":
			return `${name} returned status ${result.status}.`;
		case "unreachable":
			return `${name} isn't reachable, running here`;
	}
}

/**
 * G13/R2: wording for a chat failure that arrives *after* the 5-second
 * settle. By then `settle()` has already run (the thread may be open, the
 * button already says "Sent") — `chatFailureNotice`'s pre-send wording
 * ("running here", "token rejected") is wrong here because no fallback
 * happens and the terminal never runs; saying either would wrongly invite
 * a second click/run. This always says the run failed on the runtime
 * itself and that nothing here retried it.
 */
function lateChatFailureNotice(name: string, result: ChatFailureResult): string {
	const detail =
		result.kind === "unauthorized"
			? "rejected the token"
			: result.kind === "httpError"
				? `returned status ${result.status}`
				: "lost the connection";
	return `${name} ${detail} after accepting the prompt — no fallback ran.`;
}

type RaceResult<T> = { via: "value"; value: T } | { via: "timer" };

/**
 * R3: the exact button-label wording for "Sending to <name>…" (G7) and
 * "Sent to <name>" (G9, before the "↗" link/no-link decision which
 * buttonBlock.ts makes separately) — exported so both the real click
 * wiring (buttonBlock.ts) and the secret-leak sweep build the identical
 * string, instead of the test guessing at a copy that could drift from
 * what the button actually shows.
 */
export function sendingLabel(runtimeName: string): string {
	return `Sending to ${runtimeName}…`;
}

export function sentLabel(runtimeName: string): string {
	return `Sent to ${runtimeName}`;
}

/** Races `promise` against a plain timer, without assuming anything about either resolving first — used for the chat kind's 5-second rule (G12). Uses the real global `setTimeout`, so a test can control it with `node:test`'s mock timers rather than this module needing its own clock abstraction. */
function raceSettle<T>(promise: Promise<T>, ms: number): Promise<RaceResult<T>> {
	const timer = new Promise<RaceResult<T>>((resolve) => {
		setTimeout(() => resolve({ via: "timer" }), ms);
	});
	const value = promise.then((v): RaceResult<T> => ({ via: "value", value: v }));
	return Promise.race([value, timer]);
}

/**
 * G1-G15/E2-E12: the whole hand-off, from the session key the plugin
 * chooses through to "settled" (G9, a thread opened or fire-and-forget) or
 * a fallback to the terminal (G12). One runner is shared by every
 * agent-button block for the plugin's lifetime — see createHandoffRunner —
 * so the once-per-runtime "no thread URL" notice (E5) is genuinely once
 * per Obsidian session, not once per block.
 */
export function createHandoffRunner(): {
	runHandoff: (input: HandoffInput, hooks: HandoffHooks) => Promise<void>;
} {
	const warnedNoThreadUrl = new Set<string>();

	function settle(input: HandoffInput, hooks: HandoffHooks, agentId: string, sessionKey: string): void {
		const threadUrl = buildThreadUrl(input.runtime.threadUrlTemplate, { agentId, sessionKey });
		if (threadUrl) {
			if (input.openRequested) {
				const openResult = openThreadUrl(threadUrl, hooks.openUrl);
				if (!openResult.opened && openResult.reason) hooks.notify(openResult.reason);
			}
		} else if (input.openRequested && !warnedNoThreadUrl.has(input.runtime.id)) {
			// E5: once per runtime per Obsidian session, not once per block or per click.
			warnedNoThreadUrl.add(input.runtime.id);
			hooks.notify(`No thread-URL template is set for "${input.runtime.name}" — nothing to open.`);
		}
		hooks.onSent(threadUrl);
	}

	async function runHookHandoff(
		input: HandoffInput,
		hooks: HandoffHooks,
		agentId: string,
		sessionKey: string,
		message: string
	): Promise<void> {
		const request = buildHookRequest({
			baseUrl: input.runtime.baseUrl,
			token: input.token,
			agentId,
			// The hook body's `name` field: the ticket doesn't say what it's
			// for, so this uses the note's basename as the most useful
			// available, non-secret label for the session OpenClaw starts —
			// a judgement call, called out in the PR summary for review.
			name: input.noteBasename,
			sessionKey,
			message,
		});
		const outcome = await hooks.httpFn(request);
		const result = classifyHookOutcome(outcome);
		if (result.kind === "ok") {
			settle(input, hooks, agentId, sessionKey);
			return;
		}
		// G12/E2/E3/E4/E12: every failure before the hook accepts the prompt
		// is a notice, then the terminal runs — the hook kind has no
		// "accepted but something failed later" path of its own (once it
		// replies 200/ok/runId, the run is OpenClaw's, not ours, G14).
		hooks.notify(hookFailureNotice(input.runtime.name, result));
		hooks.fallbackToTerminal();
	}

	async function runChatHandoff(
		input: HandoffInput,
		hooks: HandoffHooks,
		agentId: string,
		sessionKey: string,
		message: string
	): Promise<void> {
		// E11: there is deliberately no cancel, retry or close handling for a
		// chat run — if Obsidian closes mid-request (or mid-5-second-wait),
		// whatever happens to the in-flight promise happens; nothing here
		// aborts the request, retries it, or notices the window closing.
		// Documented rather than handled, per the spec.
		const request = buildChatRequest({
			baseUrl: input.runtime.baseUrl,
			token: input.token,
			model: agentId,
			message,
			sessionKey,
			sendSessionKeyHeader: input.runtime.sendSessionKeyHeader,
		});

		// Kept as two handles on the same underlying send: `rawOutcome` so
		// the post-settle branch can tell a local HttpFn timeout (R2: the
		// chat HttpFn's own ceiling firing, not a confirmed failure — the
		// run may well have succeeded on the runtime) apart from a real
		// unauthorized/httpError/connection failure; `classified` for
		// everything the 5-second race itself needs to decide.
		const rawOutcome = hooks.httpFn(request);
		const classified = rawOutcome.then(classifyChatOutcome);
		const race = await raceSettle(classified, CHAT_SETTLE_MS);

		if (race.via === "timer") {
			// G12: 5 seconds with no error is settled.
			settle(input, hooks, agentId, sessionKey);
			// G13/R2: an error arriving after that is a notice only — the
			// terminal never runs and the prompt is never run twice. A
			// late *timeout* specifically isn't reported at all: it only
			// means the HttpFn's own ceiling (CHAT_HTTP_TIMEOUT_MS) fired
			// while the run was likely still going on the runtime, not
			// that anything is confirmed to have failed.
			void Promise.all([rawOutcome, classified]).then(([raw, result]) => {
				if (result.kind === "accepted") return;
				if (raw.kind === "timeout") return;
				hooks.notify(lateChatFailureNotice(input.runtime.name, result));
			});
			return;
		}

		if (race.value.kind === "accepted") {
			settle(input, hooks, agentId, sessionKey);
			return;
		}
		// G12: an error inside the 5 seconds always falls back — a run that
		// errors that early has not started.
		hooks.notify(chatFailureNotice(input.runtime.name, race.value));
		hooks.fallbackToTerminal();
	}

	async function runHandoff(input: HandoffInput, hooks: HandoffHooks): Promise<void> {
		// E8: empty/whitespace-only prompt sends nothing, shows a notice,
		// makes no request, and (unlike every other failure here) never
		// reaches "Sending…" or the terminal fallback at all.
		if (input.prompt.trim() === "") {
			hooks.notify("Prompt is empty — nothing sent.");
			return;
		}

		// E6: a token-required runtime with no token on this device already
		// got its "token not set on this device" notice from
		// resolveClickTarget — this is the fallback half of that edge case
		// (new in this PR): skip the request entirely rather than send with
		// no Authorization header, and go straight to the terminal.
		if (input.runtime.tokenRequired && !input.token) {
			hooks.fallbackToTerminal();
			return;
		}

		hooks.onSending();

		// G8: chosen once, before sending, so the same key appears in the
		// request and (via settle() -> buildThreadUrl) the thread URL.
		const sessionKey = createSessionKey(input.noteBasename, hooks.nowMs());
		const agentId = input.agentIdOverride?.trim() || input.runtime.agentId;
		const message = buildHandoffMessage(input.prompt, input.notePath, input.runtime.kind === "openclaw-hook");

		if (input.runtime.kind === "openclaw-hook") {
			await runHookHandoff(input, hooks, agentId, sessionKey, message);
		} else {
			await runChatHandoff(input, hooks, agentId, sessionKey, message);
		}
	}

	return { runHandoff };
}

/**
 * G7/E10: wraps a runner's `runHandoff` so a second call while the first
 * hand-off for *this* button is still in flight is ignored outright — not
 * queued, not noticed, nothing. The caller owns exactly one of these per
 * agent-button block (not shared across blocks, unlike createHandoffRunner
 * itself) since "ignore further clicks until settled" is a per-button
 * rule, not a per-runtime or per-plugin one; once a hand-off settles (or
 * fails), the very next click starts an independent one (G10).
 */
export function createSingleFlightHandoff(
	runHandoff: (input: HandoffInput, hooks: HandoffHooks) => Promise<void>
): (input: HandoffInput, hooks: HandoffHooks) => Promise<void> {
	let inFlight = false;
	return async (input: HandoffInput, hooks: HandoffHooks): Promise<void> => {
		if (inFlight) return;
		inFlight = true;
		try {
			await runHandoff(input, hooks);
		} finally {
			inFlight = false;
		}
	};
}
