import type { AgentRuntime, HttpFn, RuntimeKind, SecretStore } from "./types";
import type { ClickSettingsFields, ClickSpecFields } from "./targetResolve";
import { resolveClickTarget } from "./targetResolve";
import { runClickDecision } from "./clickRouting";
import { sendingLabel, sentLabel } from "./handoff";
import type { HandoffHooks, HandoffInput } from "./handoff";
import { HOOK_TIMEOUT_MS } from "./hookRequest";
import { CHAT_HTTP_TIMEOUT_MS } from "./chatRequest";

/**
 * The obsidian-free click wiring that buttonBlock.ts used to hold inline:
 * the order of the terminal flow's steps, the click handler that routes a
 * resolved target, and the runtime flow that builds a hand-off and hooks
 * the button's UI up to it. buttonBlock.ts now only supplies the DOM- and
 * xterm-bound pieces (the `steps` / `ui` / `deps` below), so tests can run
 * the *real* handler against recording stand-ins instead of a hand-written
 * list of the calls it is expected to make.
 */

/** G14/G15: the HttpFn ceiling for each runtime kind — hook waits 15 s, chat gets a generous bound (G12's 5-second rule, not this, decides when a chat send counts as settled). */
export function httpTimeoutForKind(kind: RuntimeKind): number {
	return kind === "openclaw-hook" ? HOOK_TIMEOUT_MS : CHAT_HTTP_TIMEOUT_MS;
}

/** The individual steps of the (unchanged, 0.2.1) terminal click body. buttonBlock.ts binds each to the real DOM/xterm/PTY. */
export interface TerminalFlowSteps {
	/** Whether a child process is currently spawned and hasn't exited yet. */
	isSessionAlive: () => boolean;
	/** A session is already live: just re-open its accordion, start nothing. */
	revealExistingSession: () => void;
	/** Marks the session alive, sets the running state and shows the "Show/Hide terminal" toggle. */
	markRunning: () => void;
	/** Opens or closes the accordion according to the button's `showTerminal` (default open). */
	applyAccordionPreference: () => void;
	ensureTerm: () => void;
	clearTerm: () => void;
	/** Everything after the terminal exists: snapshot position, render the prompt, resolve the binary, spawn, wire output. */
	launch: () => void;
}

/**
 * The terminal click body, in its fixed order: sessionAlive check → (if
 * live, reveal and stop) → mark running → accordion → ensureTerm → clear →
 * launch. Passed to `runClickDecision` as `runTerminalFlow`, and reused
 * directly as the runtime flow's fallback-to-terminal (G12).
 */
export function createTerminalFlow(steps: TerminalFlowSteps): () => void {
	return () => {
		if (steps.isSessionAlive()) {
			steps.revealExistingSession();
			return;
		}
		steps.markRunning();
		steps.applyAccordionPreference();
		steps.ensureTerm();
		steps.clearTerm();
		steps.launch();
	};
}

/** The button chrome the runtime flow drives (G7/G9/G12). */
export interface RuntimeFlowUi {
	/** "Sending to <name>…", button disabled, thread link hidden. */
	showSending: (label: string) => void;
	/** "Sent to <name>", button re-enabled, thread link shown iff `threadUrl`. */
	showSent: (label: string, threadUrl: string | undefined) => void;
	/** Back to the button's own text, enabled, thread link hidden. */
	showIdle: () => void;
}

export interface RuntimeFlowDeps {
	ui: RuntimeFlowUi;
	/** Vault base path; throws when the vault has no filesystem adapter. */
	getVaultBasePath: () => string;
	/** Renders the button's prompt template against the note — `error` set means "don't send". */
	renderPrompt: (cwd: string) => { text: string; error?: string; noteBasename: string };
	/** Vault-relative path of the note the button is in. */
	sourcePath: string;
	agentIdOverride: string | undefined;
	/** `open:` line resolved against the settings default. */
	getOpenRequested: () => boolean;
	secretStore: SecretStore;
	/** Builds the HttpFn for a given timeout — production passes `createObsidianHttpFn`. */
	createHttpFn: (timeoutMs: number) => HttpFn;
	runHandoff: (input: HandoffInput, hooks: HandoffHooks) => Promise<void>;
	nowMs: () => number;
	openUrl: (url: string) => void;
	notify: (message: string) => void;
	setTimer: (callback: () => void, ms: number) => void;
	/** G12: runs the button as `target: terminal` would have. */
	runTerminalFlow: () => void;
}

/** `<vault base path>/<vault-relative source path>` — the absolute path that goes on the hand-off message's last "Note:" line (G7). Vault-relative paths always use "/" regardless of OS. */
export function toAbsoluteNotePath(vaultBasePath: string, sourcePath: string): string {
	return `${vaultBasePath.replace(/[\\/]+$/, "")}/${sourcePath}`;
}

/**
 * The runtime branch of a click: resolve the vault path and prompt, then
 * hand off over HTTP with the button's UI wired to the hand-off's states.
 * `deps.runHandoff` should be a per-button single-flight wrapper (see
 * createSingleFlightHandoff).
 */
export function createRuntimeFlow(deps: RuntimeFlowDeps): (runtime: AgentRuntime) => void {
	return (runtime) => {
		let cwd: string;
		try {
			cwd = deps.getVaultBasePath();
		} catch (err) {
			deps.notify((err as Error).message);
			return;
		}
		const rendered = deps.renderPrompt(cwd);
		if (rendered.error) {
			deps.notify(rendered.error);
			return;
		}

		void deps.runHandoff(
			{
				runtime,
				agentIdOverride: deps.agentIdOverride,
				prompt: rendered.text,
				notePath: toAbsoluteNotePath(cwd, deps.sourcePath),
				noteBasename: rendered.noteBasename,
				openRequested: deps.getOpenRequested(),
				token: deps.secretStore.getToken(runtime.tokenSecretName),
			},
			{
				httpFn: deps.createHttpFn(httpTimeoutForKind(runtime.kind)),
				nowMs: deps.nowMs,
				openUrl: deps.openUrl,
				notify: deps.notify,
				setTimer: deps.setTimer,
				onSending: () => deps.ui.showSending(sendingLabel(runtime.name)),
				onSent: (threadUrl) => deps.ui.showSent(sentLabel(runtime.name), threadUrl),
				// G12: every failure before the hand-off is accepted runs the
				// button exactly as target: terminal would.
				fallbackToTerminal: () => {
					deps.ui.showIdle();
					deps.runTerminalFlow();
				},
				onAborted: () => deps.ui.showIdle(),
			}
		);
	};
}

export interface ClickHandlerDeps {
	spec: ClickSpecFields;
	getSettings: () => ClickSettingsFields;
	secretStore: SecretStore;
	notify: (message: string) => void;
	runTerminalFlow: () => void;
	runRuntimeFlow: (runtime: AgentRuntime) => void;
}

/**
 * What the button's `click` listener runs. Resolved before any terminal
 * set-up (sessionAlive check, accordion, ensureTerm) — a runtime target must
 * never flash a terminal, even for one tick (F8, G11). Nothing here, or in
 * building the handler, makes an HTTP request: a request only ever comes
 * from `runRuntimeFlow`, on a click (F4).
 */
export function createClickHandler(deps: ClickHandlerDeps): () => void {
	return () => {
		const resolution = resolveClickTarget(deps.spec, deps.getSettings(), deps.secretStore);
		resolution.notices.forEach((notice) => deps.notify(notice));
		runClickDecision(resolution, {
			runTerminalFlow: deps.runTerminalFlow,
			runRuntimeFlow: deps.runRuntimeFlow,
		});
	};
}
