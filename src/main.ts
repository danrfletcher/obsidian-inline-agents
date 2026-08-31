import { FileSystemAdapter, Plugin } from "obsidian";
import { AgentConsoleSettings, AgentConsoleSettingTab, DEFAULT_SETTINGS } from "./settings";
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
		// Object.assign alone would be a *shallow* merge — a data.json saved
		// before the per-provider "models" array existed has `claude`/
		// `opencode` objects with only `binaryPath`, and a shallow merge
		// would drop DEFAULT_SETTINGS.claude/opencode (models included)
		// wholesale rather than filling in just the missing keys. Merge each
		// nested provider object explicitly instead.
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			claude: { ...DEFAULT_SETTINGS.claude, ...saved?.claude },
			opencode: { ...DEFAULT_SETTINGS.opencode, ...saved?.opencode },
		};
		// An empty mappings list (rather than a missing one) is also
		// possible — e.g. after removing every row in Settings. Always keep
		// at least one placeholder row so the "+" button has something to
		// render next to.
		if (this.settings.claude.models.length === 0) this.settings.claude.models = [{ name: "", model: "" }];
		if (this.settings.opencode.models.length === 0) this.settings.opencode.models = [{ name: "", model: "" }];
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
