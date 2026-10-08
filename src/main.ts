import { FileSystemAdapter, Plugin } from "obsidian";
import type { AgentConsoleSettings } from "./settingsModel";
import { AgentConsoleSettingTab } from "./settings";
import { migrateSettings } from "./runtime/settingsMigrate";
import { registerAgentButtonProcessor } from "./buttonBlock";

export default class AgentConsolePlugin extends Plugin {
	settings: AgentConsoleSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new AgentConsoleSettingTab(this.app, this));
		registerAgentButtonProcessor(this);
	}

	onunload(): void {
		// Individual agent-button blocks kill their own child process via
		// their MarkdownRenderChild.onunload (registered per-block); nothing
		// plugin-wide to tear down here.
	}

	/** Real filesystem path to the vault root — used as the agent's cwd. */
	getVaultBasePath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		throw new Error("Agent Console needs a local, on-disk vault (this vault has no filesystem adapter).");
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<AgentConsoleSettings> | null;
		this.settings = migrateSettings(saved);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
