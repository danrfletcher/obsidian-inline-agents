import { MarkdownRenderChild } from "obsidian";
import type { MarkdownSectionInformation } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type AgentConsolePlugin from "./main";
import type { AgentKind } from "./agents";
import { buildAgentCommand } from "./agents";
import { spawnAgentProcess, AgentProcessHandle, resolveBinary, CLAUDE_CANDIDATES, OPENCODE_CANDIDATES } from "./runner";
import { classifyTurnState, extractCleanText } from "./outputCapture";
import { writeAgentOutputToFile, AppendPosition } from "./fileOutput";

type AgentOutputTarget = "terminal" | "file";
type CompletionMode = "responseEnd" | "manual";

interface ButtonSpec {
	text: string;
	prompt: string;
	autoApprove?: boolean;
	agent?: AgentKind;
	/** Where the agent's output ends up. Default: "terminal". */
	agentOutput?: AgentOutputTarget;
	/** Only used when agentOutput is "file". Default: "bottom". */
	append?: AppendPosition;
	/** Whether the terminal accordion opens automatically on click. Default: true. */
	showTerminal?: boolean;
	/** How the button's loading state ends. Default: "manual". */
	completion?: CompletionMode;
}

/**
 * ```agent-button
 * text: Run Sufficiency Check
 * prompt: Run teacher-artefact-sufficiency-check.md on {{this file}}
 * autoApprove: true
 * agent: claude
 * agentOutput: file
 * append: belowButton
 * showTerminal: false
 * completion: responseEnd
 * ```
 * Deliberately a plain `key: value`-per-line block rather than an inline
 * `{{shortcode}}` syntax — it's what Obsidian's own
 * registerMarkdownCodeBlockProcessor is built for (works identically in
 * Reading view and Live Preview, no custom text-scanning/escaping to get
 * wrong), and it's the same shape the "Buttons" community plugin uses.
 */
function parseButtonBlock(source: string): ButtonSpec {
	const spec: Partial<ButtonSpec> = {};
	for (const rawLine of source.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		switch (key) {
			case "text":
				spec.text = value;
				break;
			case "prompt":
				spec.prompt = value;
				break;
			case "autoapprove":
				spec.autoApprove = /^(true|yes|on|1)$/i.test(value);
				break;
			case "agent":
				spec.agent = value.toLowerCase() === "opencode" ? "opencode" : "claude";
				break;
			case "agentoutput":
				spec.agentOutput = value.toLowerCase() === "file" ? "file" : "terminal";
				break;
			case "append": {
				const v = value.toLowerCase().replace(/\s+/g, "");
				spec.append = v === "top" ? "top" : v === "belowbutton" ? "belowButton" : "bottom";
				break;
			}
			case "showterminal":
				spec.showTerminal = /^(true|yes|on|1)$/i.test(value);
				break;
			case "completion":
				spec.completion = value.toLowerCase() === "responseend" ? "responseEnd" : "manual";
				break;
		}
	}
	return {
		text: spec.text ?? "Run agent",
		prompt: spec.prompt ?? "",
		autoApprove: spec.autoApprove,
		agent: spec.agent,
		agentOutput: spec.agentOutput,
		append: spec.append,
		showTerminal: spec.showTerminal,
		completion: spec.completion,
	};
}

/** `{{this file}}` → the vault-relative path of the note the button lives
 * in (ctx.sourcePath — the file this code block belongs to, not whichever
 * pane happens to be focused, so it's correct even with split panes). */
function resolvePrompt(template: string, sourcePath: string): string {
	return template.replace(/\{\{\s*this file\s*\}\}/gi, sourcePath);
}

export function registerAgentButtonProcessor(plugin: AgentConsolePlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("agent-button", (source, el, ctx) => {
		const spec = parseButtonBlock(source);

		const wrapper = el.createDiv({ cls: "agent-console-block" });
		const button = wrapper.createEl("button", { cls: "agent-console-button" });
		const buttonLabel = button.createSpan({ cls: "agent-console-button-label", text: spec.text });
		button.createSpan({ cls: "agent-console-spinner" });
		button.createSpan({ cls: "agent-console-pencil", text: "✏️" });
		void buttonLabel;

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

		button.addEventListener("click", () => {
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
			const prompt = resolvePrompt(spec.prompt, ctx.sourcePath);
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
			const built = buildAgentCommand(agentKind, resolvedBinary, { prompt, cwd, autoApprove });

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
						writeAgentOutputToFile(
							plugin.app,
							ctx.sourcePath,
							spec.text,
							clean,
							appendPosition,
							sectionInfo
						).catch((err) => {
							term?.write(
								`\r\n\x1b[31m[agent-console] Failed to write output to file: ${(err as Error).message}\x1b[0m\r\n`
							);
						});
					}
				}
			});
		});

		completeBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			handle?.kill();
		});

		toggle.addEventListener("click", () => setAccordionOpen(!accordionOpen));

		const child = new MarkdownRenderChild(wrapper);
		child.onunload = () => {
			handle?.kill();
			term?.dispose();
		};
		ctx.addChild(child);
	});
}
