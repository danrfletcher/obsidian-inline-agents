import { MarkdownRenderChild, Notice } from "obsidian";
import type { MarkdownSectionInformation } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type AgentConsolePlugin from "./main";
import type { AgentKind } from "./agents";
import { buildAgentCommand } from "./agents";
import { spawnAgentProcess, AgentProcessHandle, resolveBinary, CLAUDE_CANDIDATES, OPENCODE_CANDIDATES } from "./runner";
import { classifyTurnState, extractCleanText } from "./outputCapture";
import { writeAgentOutputToFile, AppendPosition } from "./fileOutput";
import { buildAgentContext } from "./context";
import { renderPromptTemplate } from "./templating";
import type { AgentContext } from "./context";
import type { RenderPromptResult } from "./templating";
import { parseButtonBlock, resolveModel, AgentOutputTarget, CompletionMode } from "./buttonParse";
import { composePrompt } from "./inputPrompt";
import { canSubmitInput, classifyInputKey } from "./inputFieldKeys";
import { resolveClickTarget } from "./runtime/targetResolve";
import { runClickDecision, decideClickAction, runInputSubmit } from "./runtime/clickRouting";
import type { AgentRuntime } from "./runtime/types";
import { createSecretStoreAdapter } from "./runtime/secretStoreAdapter";
import { createHandoffRunner, createSingleFlightHandoff, sendingLabel, sentLabel } from "./runtime/handoff";
import { createObsidianHttpFn } from "./runtime/httpAdapter";
import { openThreadUrl, threadLinkHref } from "./runtime/threadUrl";
import { HOOK_TIMEOUT_MS } from "./runtime/hookRequest";
import { CHAT_HTTP_TIMEOUT_MS } from "./runtime/chatRequest";

/** `<vault base path>/<vault-relative source path>` — the absolute path that goes on the hand-off message's last "Note:" line (G7). Vault-relative paths always use "/" regardless of OS. */
function toAbsoluteNotePath(vaultBasePath: string, sourcePath: string): string {
	return `${vaultBasePath.replace(/[\\/]+$/, "")}/${sourcePath}`;
}

export function registerAgentButtonProcessor(plugin: AgentConsolePlugin): void {
	const secretStore = createSecretStoreAdapter(plugin.app);
	// One runner for the plugin's whole lifetime, shared by every
	// agent-button block — see handoff.ts: that's what makes E5's "no
	// thread URL" notice genuinely once per Obsidian session rather than
	// once per block.
	const handoffRunner = createHandoffRunner();
	// G13: closes the one input field that is open right now, if any, so
	// opening a second one cancels the first. Holds a function only — never
	// the typed text, which lives in the textarea alone (G8).
	let closeOpenInputField: (() => void) | null = null;

	plugin.registerMarkdownCodeBlockProcessor("agent-button", (source, el, ctx) => {
		const spec = parseButtonBlock(source);

		const wrapper = el.createDiv({ cls: "agent-console-block" });
		const button = wrapper.createEl("button", { cls: "agent-console-button" });
		const buttonLabel = button.createSpan({ cls: "agent-console-button-label", text: spec.text });
		button.createSpan({ cls: "agent-console-spinner" });
		button.createSpan({ cls: "agent-console-pencil", text: "✏️" });
		// G9: the "↗" affordance for a settled hand-off with a thread-URL
		// template — a separate clickable element from the button itself so
		// clicking it opens the thread (on demand, any time after settling)
		// without re-triggering a new hand-off, which is what clicking the
		// button's own body does (G10).
		const threadLink = button.createEl("a", { cls: "agent-console-thread-link", text: "↗" });
		threadLink.setAttr("href", "#");
		threadLink.setCssStyles({ display: "none" });

		// Manual-completion affordance: hidden unless a run is live under
		// completion: manual. Clicking it kills the child process, which
		// drives the button back to idle through the normal onExit path.
		const completeBtn = wrapper.createEl("button", { cls: "agent-console-complete-btn", text: "✓" });
		completeBtn.setAttr("type", "button");
		completeBtn.setAttr("title", "Complete");
		completeBtn.setAttr("aria-label", "Complete");

		const toggle = wrapper.createDiv({ cls: "agent-console-toggle", text: "Show terminal" });
		toggle.setCssStyles({ display: "none" });

		const accordion = wrapper.createDiv({ cls: "agent-console-accordion" });
		accordion.setCssStyles({ display: "none" });
		const termHost = accordion.createDiv({ cls: "agent-console-term" });

		let term: Terminal | null = null;
		let fitAddon: FitAddon | null = null;
		// Whether a child process is currently spawned and hasn't exited yet.
		// Distinct from the button's spinner/pencil chrome (see setVisualState)
		// — under completion: responseEnd the two can diverge: the session
		// stays alive in the background after the agent finishes replying,
		// right up until the note closes or the session is killed some other
		// way, even though the button itself has already gone back to idle.
		let sessionAlive = false;
		let handle: AgentProcessHandle | null = null;
		let accordionOpen = false;
		let sectionInfo: MarkdownSectionInformation | null = null;
		// R1/G9: the thread URL from the most recently settled hand-off, if
		// any — what clicking the "↗" link on demand opens. Kept separate
		// from the link's `href` (see threadLinkHref) so a disallowed
		// scheme can still be refused with a notice on click rather than
		// doing nothing.
		let currentThreadUrl: string | undefined;

		const setAccordionOpen = (open: boolean) => {
			accordionOpen = open;
			accordion.setCssStyles({ display: open ? "block" : "none" });
			toggle.setText(open ? "Hide terminal" : "Show terminal");
			if (open) {
				fitAddon?.fit();
				term?.focus();
			}
		};

		type VisualState = "idle" | "running" | "awaiting-input";
		const setVisualState = (state: VisualState) => {
			button.removeClass("is-running");
			button.removeClass("is-awaiting-input");
			if (state === "running") button.addClass("is-running");
			if (state === "awaiting-input") button.addClass("is-awaiting-input");
		};

		const setCompleteBtnVisible = (visible: boolean) => {
			completeBtn.toggleClass("is-visible", visible);
		};

		const ensureTerm = () => {
			if (term) return;
			term = new Terminal({
				convertEol: true,
				fontSize: 13,
				scrollback: 5000,
				theme: { background: "#00000000" },
			});
			fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.open(termHost);
			fitAddon.fit();
			term.onData((data) => {
				handle?.write(data);
			});
		};

		// Renders the button's prompt. `typedText` is set only when an `input:`
		// field was submitted: the prompt is then composed from the template
		// and that text right now (see inputPrompt.ts), and the text itself
		// is never rendered. Without it, rendering is exactly as before.
		const renderPrompt = (context: AgentContext, typedText?: string): RenderPromptResult => {
			const opts = { allowJs: plugin.settings.allowJsExpressions };
			if (typedText === undefined) return renderPromptTemplate(spec.prompt, context, opts);
			return composePrompt(spec.prompt, typedText, (segment) => renderPromptTemplate(segment, context, opts));
		};

		// The entire pre-PR-1.F1 click body — sessionAlive check, accordion,
		// ensureTerm, spawn, all of it — unchanged apart from taking the
		// optional `typedText` of a submitted `input:` field. Also reused
		// directly as the runtime flow's fallback-to-terminal
		// (G12/E2/E3/E4/E6/E12): every failure before a hand-off is accepted
		// runs the button exactly as if `target:` had been `terminal` all
		// along.
		const runTerminalFlow = (typedText?: string) => {
			if (sessionAlive) {
				setAccordionOpen(true);
				return;
			}
			sessionAlive = true;
			setVisualState("running");
			toggle.setCssStyles({ display: "block" });

			const showTerminal = spec.showTerminal ?? true;
			setAccordionOpen(showTerminal);
			ensureTerm();
			term?.clear();

			// Snapshot where this block sits in the note right now — used by
			// agentOutput: file / append: belowButton once the run finishes.
			// See writeAgentOutputToFile's docstring for why this is only a
			// best-effort anchor.
			sectionInfo = ctx.getSectionInfo(wrapper);

			const settings = plugin.settings;
			const agentKind: AgentKind = spec.agent ?? settings.agent;
			const autoApprove = spec.autoApprove ?? settings.autoApproveDefault;
			const model = resolveModel(spec.model, agentKind === "opencode" ? settings.opencode.models : settings.claude.models);
			const agentOutput: AgentOutputTarget = spec.agentOutput ?? "terminal";
			const appendPosition: AppendPosition = spec.append ?? "bottom";
			const completion: CompletionMode = spec.completion ?? "manual";
			setCompleteBtnVisible(completion === "manual");

			let cwd: string;
			try {
				cwd = plugin.getVaultBasePath();
			} catch (err) {
				term?.write(`\r\n\x1b[31m[agent-console] ${(err as Error).message}\x1b[0m\r\n`);
				sessionAlive = false;
				setVisualState("idle");
				setCompleteBtnVisible(false);
				return;
			}
			const context = buildAgentContext(plugin.app, ctx.sourcePath, cwd);
			const rendered = renderPrompt(context, typedText);
			if (rendered.error) {
				term?.write(`\r\n\x1b[31m[agent-console] ${rendered.error}\x1b[0m\r\n`);
				sessionAlive = false;
				setVisualState("idle");
				setCompleteBtnVisible(false);
				return;
			}
			const prompt = rendered.text;
			// The configured path is a preference, not a guarantee — this same
			// data.json is shared between Dan's real Mac and the desktop-obsidian
			// container, and a path valid in one is usually wrong in the other.
			// resolveBinary() falls through known install locations, then bare
			// PATH lookup, so one vault works in both without hand-editing settings
			// every time it's opened somewhere else.
			const configuredPath = agentKind === "opencode" ? settings.opencode.binaryPath : settings.claude.binaryPath;
			const resolvedBinary =
				agentKind === "opencode"
					? resolveBinary(configuredPath, "opencode", OPENCODE_CANDIDATES)
					: resolveBinary(configuredPath, "claude", CLAUDE_CANDIDATES);
			const built = buildAgentCommand(agentKind, resolvedBinary, { prompt, cwd, autoApprove, model });

			term?.write(
				`\x1b[2m$ ${built.bin} ${built.args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\x1b[0m\r\n\r\n`
			);

			handle = spawnAgentProcess(built.bin, built.args, cwd);
			handle.onData((chunk) => {
				term?.write(chunk, () => {
					if (completion !== "responseEnd" || !term) return;
					const state = classifyTurnState(term);
					if (state === "awaiting-input") setVisualState("awaiting-input");
					else if (state === "idle-done") setVisualState("idle");
					else setVisualState("running");
				});
			});
			handle.onExit((code) => {
				sessionAlive = false;
				setVisualState("idle");
				setCompleteBtnVisible(false);
				term?.write(`\r\n\x1b[2m[agent-console] process exited (code ${code ?? "unknown"})\x1b[0m\r\n`);

				if (agentOutput === "file" && term) {
					const clean = extractCleanText(term);
					if (clean) {
						writeAgentOutputToFile(plugin.app, ctx.sourcePath, spec.text, clean, appendPosition, sectionInfo).catch(
							(err) => {
								term?.write(
									`\r\n\x1b[31m[agent-console] Failed to write output to file: ${(err as Error).message}\x1b[0m\r\n`
								);
							}
						);
					}
				}
			});
		};

		// G7/E10: one single-flight wrapper per block — a second click while
		// this block's own hand-off is still in flight is ignored outright.
		// Not shared across blocks (unlike handoffRunner itself), since the
		// one-at-a-time rule is per button, not per runtime (see handoff.ts).
		const sendHandoff = createSingleFlightHandoff(handoffRunner.runHandoff);

		threadLink.addEventListener("click", (evt) => {
			// Opening the already-settled thread on demand must never count
			// as a new click on the button itself (G10: every click on the
			// button starts a new thread; this is "open the one we already
			// have"). Goes through the same openThreadUrl scheme check the
			// automatic open-on-settle path uses (GP6/G9/R1), so a
			// disallowed scheme is refused with a notice rather than doing
			// nothing.
			evt.stopPropagation();
			evt.preventDefault();
			if (!currentThreadUrl) return;
			const result = openThreadUrl(currentThreadUrl, (url) => window.open(url));
			if (!result.opened && result.reason) new Notice(result.reason);
		});

		// The runtime flow: renders (and, with `typedText`, composes) the
		// prompt now and hands it off. Used by a plain click and by a
		// submitted `input:` field alike.
		const startRuntimeFlow = (runtime: AgentRuntime, typedText?: string) => {
			let cwd: string;
			try {
				cwd = plugin.getVaultBasePath();
			} catch (err) {
				new Notice((err as Error).message);
				return;
			}
			const context = buildAgentContext(plugin.app, ctx.sourcePath, cwd);
			const rendered = renderPrompt(context, typedText);
			if (rendered.error) {
				new Notice(rendered.error);
				return;
			}

			void sendHandoff(
				{
					runtime,
					agentIdOverride: spec.agentId,
					prompt: rendered.text,
					notePath: toAbsoluteNotePath(cwd, ctx.sourcePath),
					noteBasename: context.file.basename,
					openRequested: spec.open ?? plugin.settings.defaultOpen,
					token: secretStore.getToken(runtime.tokenSecretName),
				},
				{
					httpFn: createObsidianHttpFn(runtime.kind === "openclaw-hook" ? HOOK_TIMEOUT_MS : CHAT_HTTP_TIMEOUT_MS),
					nowMs: () => Date.now(),
					openUrl: (url) => window.open(url),
					notify: (message) => new Notice(message),
					onSending: () => {
						button.disabled = true;
						threadLink.setCssStyles({ display: "none" });
						buttonLabel.setText(sendingLabel(runtime.name));
					},
					onSent: (threadUrl) => {
						button.disabled = false;
						buttonLabel.setText(sentLabel(runtime.name));
						// R1: href only ever carries a URL `openThreadUrl` would
						// actually open — never a disallowed scheme (file,
						// javascript, data, vbscript), even though the link
						// itself still shows and stays clickable whenever a
						// template exists (GP6/G9).
						currentThreadUrl = threadUrl;
						threadLink.setAttr("href", threadLinkHref(threadUrl));
						threadLink.setCssStyles({ display: threadUrl ? "inline" : "none" });
					},
					// G12: every failure before the hand-off is accepted
					// runs the button exactly as target: terminal would —
					// see runTerminalFlow above.
					fallbackToTerminal: () => {
						button.disabled = false;
						buttonLabel.setText(spec.text);
						threadLink.setCssStyles({ display: "none" });
						runTerminalFlow(typedText);
					},
				}
			);
		};

		// The field is a transient textarea that replaces the idle button and
		// holds the typed text in its own `value` and nowhere else (G8).
		// Submit reads it once and passes it on as an argument. This keeps
		// only the function that closes this block's field, if one is open.
		let dismissInputField: (() => boolean) | null = null;

		const openInputField = (placeholder: string) => {
			// G13: opening this field cancels any other one that is open.
			closeOpenInputField?.();

			const field = wrapper.createDiv({ cls: "agent-console-input-field" });
			wrapper.insertBefore(field, button);
			const textarea = field.createEl("textarea", {
				cls: "agent-console-input-text",
				attr: { placeholder, "aria-label": placeholder, rows: "2" },
			});
			const actions = field.createDiv({ cls: "agent-console-input-actions" });
			const submitBtn = actions.createEl("button", {
				cls: "agent-console-input-submit mod-cta",
				text: "Submit",
				attr: { type: "button" },
			});
			const cancelBtn = actions.createEl("button", {
				cls: "agent-console-input-cancel",
				text: "Cancel",
				attr: { type: "button" },
			});
			submitBtn.disabled = true;
			// Only the button swaps: the "↗" link lives inside it, and the
			// ✓ button, toggle and accordion are siblings that stay put.
			button.addClass("is-input-open");

			// Removes the field and brings the button back, running nothing.
			// False if it was already closed, which is what makes a second
			// Enter or a double-clicked Submit run once.
			let closed = false;
			const dismiss = (): boolean => {
				if (closed) return false;
				closed = true;
				field.remove();
				button.removeClass("is-input-open");
				if (closeOpenInputField === dismiss) closeOpenInputField = null;
				if (dismissInputField === dismiss) dismissInputField = null;
				return true;
			};
			closeOpenInputField = dismiss;
			dismissInputField = dismiss;

			const cancel = () => {
				if (dismiss()) button.focus();
			};
			const submit = () => {
				const text = textarea.value.trim();
				if (!canSubmitInput(text)) return;
				if (!dismiss()) return;
				// G7: target, prompt and the `append` position (taken inside
				// runTerminalFlow) are all resolved now, not at click time.
				const resolution = resolveClickTarget(spec, plugin.settings, secretStore);
				runInputSubmit(resolution, text, {
					notify: (message) => new Notice(message),
					runTerminalFlow: (typed) => runTerminalFlow(typed),
					runRuntimeFlow: (runtime, typed) => startRuntimeFlow(runtime, typed),
				});
				button.focus();
			};

			// G10: in Live Preview the field sits inside the editor's
			// widget, so none of its key events may reach the editor. They
			// are stopped on the field itself, after the textarea's own
			// handlers below have seen them.
			for (const type of ["keydown", "keyup", "keypress", "compositionstart", "compositionupdate", "compositionend"]) {
				field.addEventListener(type, (evt) => evt.stopPropagation());
			}
			field.addEventListener("keydown", (evt) => {
				if (evt.target !== textarea) {
					// Esc on Submit or Cancel closes the field too (G3).
					if (evt.key === "Escape") {
						evt.preventDefault();
						cancel();
					}
					return;
				}
				const action = classifyInputKey(
					{ key: evt.key, shiftKey: evt.shiftKey, isComposing: evt.isComposing },
					textarea.value
				);
				if (action === "default") return;
				evt.preventDefault();
				if (action === "submit") submit();
				else if (action === "cancel") cancel();
			});
			textarea.addEventListener("input", () => {
				submitBtn.disabled = !canSubmitInput(textarea.value);
			});
			submitBtn.addEventListener("click", submit);
			cancelBtn.addEventListener("click", cancel);

			textarea.focus();
		};

		button.addEventListener("click", () => {
			// G1/G9: only an idle button with an `input:` line opens the
			// field. A live terminal (including awaiting-input) or an
			// in-flight hand-off keeps today's behaviour, below.
			const action = decideClickAction({
				hasInput: spec.input !== undefined,
				sessionAlive,
				handoffInFlight: button.disabled,
			});
			if (action === "open-field" && spec.input !== undefined) {
				openInputField(spec.input);
				return;
			}

			// Resolved before any terminal set-up (sessionAlive check,
			// accordion, ensureTerm) — a runtime target must never flash a
			// terminal, even for one tick (F8, G11). See
			// runtime/targetResolve.ts and runtime/clickRouting.ts.
			const resolution = resolveClickTarget(spec, plugin.settings, secretStore);
			resolution.notices.forEach((notice) => new Notice(notice));

			runClickDecision(resolution, {
				runTerminalFlow: () => runTerminalFlow(),
				runRuntimeFlow: (runtime) => startRuntimeFlow(runtime),
			});
		});

		completeBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			handle?.kill();
		});

		toggle.addEventListener("click", () => setAccordionOpen(!accordionOpen));

		const child = new MarkdownRenderChild(wrapper);
		child.onunload = () => {
			// E3: the note closed or this block's content changed — drop an
			// open field and run nothing.
			dismissInputField?.();
			handle?.kill();
			term?.dispose();
		};
		ctx.addChild(child);
	});
}
