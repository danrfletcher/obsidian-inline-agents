import { App, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type AgentConsolePlugin from "./main";
import type { AgentKind } from "./agents";

export interface AgentConsoleSettings {
	agent: AgentKind;
	autoApproveDefault: boolean;
	/** Gates `{{= expr }}` JS expressions in `prompt:` templates (see
	 * templating.ts). Off by default — an expression evaluates with
	 * `new Function` against the button's context, which is arbitrary code
	 * execution scoped to whatever's in that context; same posture
	 * Dataview takes with its own JS-queries setting. */
	allowJsExpressions: boolean;
	claude: { binaryPath: string };
	opencode: { binaryPath: string };
}

// Prefilled with what setup found live on this Mac (2026-08-31):
// `/Users/danfletcher/.local/bin/claude` confirmed working (`claude
// --version` → 2.1.207); `opencode` installed globally via npm
// (`opencode-ai`) — bare name resolves via PATH. Note: this same
// data.json is also read inside the `desktop-obsidian` container, where
// neither of these paths is correct — src/runner.ts's resolveBinary()
// falls through known container install locations (and finally bare PATH
// lookup) whenever the configured path doesn't exist on disk, so one vault
// works in both places without needing to be reconfigured each time.
export const DEFAULT_SETTINGS: AgentConsoleSettings = {
	agent: "claude",
	autoApproveDefault: false,
	allowJsExpressions: false,
	claude: { binaryPath: "/Users/danfletcher/.local/bin/claude" },
	opencode: { binaryPath: "opencode" },
};

/**
 * Uses Obsidian's declarative settings API (`getSettingDefinitions`,
 * added 1.13.0) rather than the older imperative `display()` — it's the
 * form Obsidian now asks plugins to use, and it's what makes these
 * settings show up in Obsidian's own settings search. Since this API
 * only exists from 1.13.0 onward, manifest.json's minAppVersion is
 * pinned to match.
 *
 * "Claude Code" and "OpenCode" are the CLIs' own proper names, not
 * generic UI copy, so they intentionally don't collapse to
 * lowercase-after-the-first-word "sentence case" the way a plain
 * settings label would — same reasoning as any other on-screen brand
 * name (e.g. "GitHub", not "Github").
 */
export class AgentConsoleSettingTab extends PluginSettingTab {
	plugin: AgentConsolePlugin;

	constructor(app: App, plugin: AgentConsolePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Inline Agents",
				items: [
					{
						name: "Default Agent",
						desc: 'Which CLI agent note buttons run when they do not specify an "agent:" line.',
						control: {
							type: "dropdown",
							key: "agent",
							options: { claude: "Claude Code", opencode: "OpenCode" },
						},
					},
					{
						name: "Auto-approve by default",
						desc:
							'When on, buttons run with permission checks bypassed unless a button sets "autoApprove: false". ' +
							"When off, the agent asks before each tool use, right in the terminal, unless a button sets " +
							'"autoApprove: true".',
						control: { type: "toggle", key: "autoApproveDefault" },
					},
					{
						name: "Allow JavaScript expressions in prompts",
						desc:
							'When on, a prompt\'s "{{= expression }}" segments run as real JavaScript (with the button\'s file, ' +
							"vault, and date context in scope) before the agent sees them — e.g. " +
							'"{{= file.frontmatter.status === \'draft\' ? \'Finish\' : \'Review\' }}". This is arbitrary code ' +
							"execution scoped to that context, run whenever a note with such a button is opened and clicked, " +
							'so it\'s off by default. Plain "{{ file.basename }}"-style lookups always work regardless of this ' +
							"setting.",
						control: { type: "toggle", key: "allowJsExpressions" },
					},
				],
			},
			{
				type: "group",
				heading: "Claude Code",
				items: [
					{
						name: "Claude Code binary path",
						desc:
							'Absolute path to the claude executable. A bare "claude" may not resolve — Obsidian, as a GUI app, ' +
							"doesn't always see the same PATH your Terminal does (this is why it's prefilled with a full path). " +
							"If this path doesn't exist where the vault is currently open (e.g. the desktop-obsidian container), " +
							"it falls back to a few known install locations, then bare PATH lookup — see runner.ts.",
						control: {
							type: "text",
							key: "claudeBinaryPath",
							placeholder: "/Users/you/.local/bin/claude",
						},
					},
				],
			},
			{
				type: "group",
				heading: "OpenCode",
				items: [
					{
						name: "OpenCode binary path",
						desc:
							"Absolute path to the opencode executable, or a bare command name to rely on PATH. Same fallback " +
							"behaviour as Claude Code above applies if this path doesn't exist in the current environment.",
						control: {
							type: "text",
							key: "opencodeBinaryPath",
							placeholder: "/usr/local/bin/opencode",
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		switch (key) {
			case "agent":
				return this.plugin.settings.agent;
			case "autoApproveDefault":
				return this.plugin.settings.autoApproveDefault;
			case "allowJsExpressions":
				return this.plugin.settings.allowJsExpressions;
			case "claudeBinaryPath":
				return this.plugin.settings.claude.binaryPath;
			case "opencodeBinaryPath":
				return this.plugin.settings.opencode.binaryPath;
			default:
				return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case "agent":
				this.plugin.settings.agent = value as AgentKind;
				break;
			case "autoApproveDefault":
				this.plugin.settings.autoApproveDefault = Boolean(value);
				break;
			case "allowJsExpressions":
				this.plugin.settings.allowJsExpressions = Boolean(value);
				break;
			case "claudeBinaryPath":
				this.plugin.settings.claude.binaryPath = String(value).trim();
				break;
			case "opencodeBinaryPath":
				this.plugin.settings.opencode.binaryPath = String(value).trim();
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
	}
}
