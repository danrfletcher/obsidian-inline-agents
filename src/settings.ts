import { App, PluginSettingTab, Setting } from "obsidian";
import type AgentConsolePlugin from "./main";
import type { AgentKind } from "./agents";

export interface AgentConsoleSettings {
	agent: AgentKind;
	autoApproveDefault: boolean;
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
	claude: { binaryPath: "/Users/danfletcher/.local/bin/claude" },
	opencode: { binaryPath: "opencode" },
};

export class AgentConsoleSettingTab extends PluginSettingTab {
	plugin: AgentConsolePlugin;

	constructor(app: App, plugin: AgentConsolePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Inline Agents" });

		new Setting(containerEl)
			.setName("Agent")
			.setDesc(
				'Which CLI agent note buttons run by default. A button can override this with its own "agent:" line.'
			)
			.addDropdown((drop) =>
				drop
					.addOption("claude", "Claude Code")
					.addOption("opencode", "OpenCode")
					.setValue(this.plugin.settings.agent)
					.onChange(async (value) => {
						this.plugin.settings.agent = value as AgentKind;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-approve by default")
			.setDesc(
				'When on, buttons run with permission checks bypassed unless a button sets "autoApprove: false". ' +
					"When off, the agent asks before each tool use, right in the terminal, unless a button sets " +
					'"autoApprove: true".'
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoApproveDefault).onChange(async (value) => {
					this.plugin.settings.autoApproveDefault = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "Claude Code" });
		new Setting(containerEl)
			.setName("Claude Code binary path")
			.setDesc(
				'Absolute path to the claude executable. A bare "claude" may not resolve — Obsidian, as a GUI app, ' +
					"doesn't always see the same PATH your Terminal does (this is why it's prefilled with a full path). " +
					"If this path doesn't exist where the vault is currently open (e.g. the desktop-obsidian container), " +
					"it falls back to a few known install locations, then bare PATH lookup — see runner.ts."
			)
			.addText((text) =>
				text
					.setPlaceholder("/Users/you/.local/bin/claude")
					.setValue(this.plugin.settings.claude.binaryPath)
					.onChange(async (value) => {
						this.plugin.settings.claude.binaryPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "OpenCode" });
		new Setting(containerEl)
			.setName("OpenCode binary path")
			.setDesc(
				"Absolute path to the opencode executable, or a bare command name to rely on PATH. Same fallback " +
					"behaviour as Claude Code above applies if this path doesn't exist in the current environment."
			)
			.addText((text) =>
				text
					.setPlaceholder("/usr/local/bin/opencode")
					.setValue(this.plugin.settings.opencode.binaryPath)
					.onChange(async (value) => {
						this.plugin.settings.opencode.binaryPath = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}
