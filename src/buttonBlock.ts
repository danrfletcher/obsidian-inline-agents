import { MarkdownRenderChild } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type AgentConsolePlugin from "./main";
import type { AgentKind } from "./agents";
import { buildAgentCommand } from "./agents";
import { spawnAgentProcess, AgentProcessHandle } from "./runner";

interface ButtonSpec {
	text: string;
	prompt: string;
	autoApprove?: boolean;
	agent?: AgentKind;
}

/**
 * ```agent-button
 * text: Run Sufficiency Check
 * prompt: Run teacher-artefact-sufficiency-check.md on {{this file}}
 * autoApprove: true
 * agent: claude
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
		}
	}
	return {
		text: spec.text ?? "Run agent",
		prompt: spec.prompt ?? "",
		autoApprove: spec.autoApprove,
		agent: spec.agent,
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
		const spinner = button.createSpan({ cls: "agent-console-spinner" });
		void buttonLabel;

		const toggle = wrapper.createDiv({ cls: "agent-console-toggle", text: "Show terminal" });
		toggle.style.display = "none";

		const accordion = wrapper.createDiv({ cls: "agent-console-accordion" });
		accordion.style.display = "none";
		const termHost = accordion.createDiv({ cls: "agent-console-term" });

		let term: Terminal | null = null;
		let fitAddon: FitAddon | null = null;
		let running = false;
		let handle: AgentProcessHandle | null = null;
		let accordionOpen = false;

		const setAccordionOpen = (open: boolean) => {
			accordionOpen = open;
			accordion.style.display = open ? "block" : "none";
			toggle.setText(open ? "Hide terminal" : "Show terminal");
			if (open) {
				fitAddon?.fit();
				term?.focus();
			}
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
			if (running) {
				setAccordionOpen(true);
				return;
			}
			running = true;
			button.addClass("is-running");
			toggle.style.display = "block";
			setAccordionOpen(true);
			ensureTerm();
			term?.clear();

			const settings = plugin.settings;
			const agentKind: AgentKind = spec.agent ?? settings.agent;
			const autoApprove = spec.autoApprove ?? settings.autoApproveDefault;
			let cwd: string;
			try {
				cwd = plugin.getVaultBasePath();
			} catch (err) {
				term?.write(`\r\n\x1b[31m[agent-console] ${(err as Error).message}\x1b[0m\r\n`);
				running = false;
				button.removeClass("is-running");
				return;
			}
			const prompt = resolvePrompt(spec.prompt, ctx.sourcePath);
			const binaryPath = agentKind === "opencode" ? settings.opencode.binaryPath : settings.claude.binaryPath;
			const built = buildAgentCommand(agentKind, binaryPath, { prompt, cwd, autoApprove });

			term?.write(
				`\x1b[2m$ ${built.bin} ${built.args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\x1b[0m\r\n\r\n`
			);

			handle = spawnAgentProcess(built.bin, built.args, cwd);
			handle.onData((chunk) => term?.write(chunk));
			handle.onExit((code) => {
				running = false;
				button.removeClass("is-running");
				term?.write(`\r\n\x1b[2m[agent-console] process exited (code ${code ?? "unknown"})\x1b[0m\r\n`);
			});
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
