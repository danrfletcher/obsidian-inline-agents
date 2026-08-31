import { App, PluginSettingTab, Setting } from "obsidian";
import type AgentConsolePlugin from "./main";
import type { AgentKind } from "./agents";
import { checkBinaryAvailable, listOpenCodeModels, resolveBinary, CLAUDE_CANDIDATES, OPENCODE_CANDIDATES } from "./runner";

/** One `model:` shortcut a button can reference by `name`. See resolveModel() in buttonBlock.ts. */
export interface ModelMapping {
	name: string;
	model: string;
}

export interface AgentConsoleSettings {
	agent: AgentKind;
	autoApproveDefault: boolean;
	claude: { binaryPath: string; models: ModelMapping[] };
	opencode: { binaryPath: string; models: ModelMapping[] };
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
	claude: { binaryPath: "/Users/danfletcher/.local/bin/claude", models: [{ name: "", model: "" }] },
	opencode: { binaryPath: "opencode", models: [{ name: "", model: "" }] },
};

/**
 * Claude Code has no CLI command to list its own available models live —
 * unlike OpenCode's `models` subcommand (see runner.ts's
 * listOpenCodeModels), there's nothing to query. This is a curated static
 * list of the aliases/IDs `claude --model` itself documents accepting
 * (`claude --help`, checked live 2026-08-31), kept here rather than
 * invented — it'll drift as Anthropic ships new models, but a stale list
 * is still useful as a starting point, and the model-mapping row's field
 * is always a free-text input, so any current model string can be typed
 * or pasted in regardless of whether it's in this list.
 */
export const CLAUDE_MODEL_OPTIONS = [
	"sonnet",
	"opus",
	"fable",
	"haiku",
	"claude-sonnet-5",
	"claude-opus-5",
	"claude-fable-5",
	"claude-haiku-4-5-20251001",
];

type ProviderKey = "claude" | "opencode";
type ConnectionStatus = "checking" | "connected" | "disconnected";

/**
 * Uses the classic imperative `display()` API rather than the declarative
 * `getSettingDefinitions()` this tab used through v0.1.4 — the model-mapping
 * section needs dynamically-added/removed rows, a custom dropdown with a
 * per-option copy button, and live status dots, none of which the
 * declarative control types (dropdown/toggle/text) can express. The
 * trade-off: this tab no longer appears in Obsidian's built-in settings
 * search index, which the declarative API opted into. Worth it here — see
 * https://docs.obsidian.md/Plugins/User+interface/Settings for both APIs.
 *
 * "Claude Code" and "OpenCode" are the CLIs' own proper names, not generic
 * UI copy, so they intentionally don't collapse to lowercase-after-the-
 * first-word "sentence case" the way a plain settings label would — same
 * reasoning as any other on-screen brand name (e.g. "GitHub", not "Github").
 */
export class AgentConsoleSettingTab extends PluginSettingTab {
	plugin: AgentConsolePlugin;
	private statusDots: Partial<Record<ProviderKey, HTMLElement>> = {};
	private openCodeModelCache: string[] = [];
	private openCodeModelsLoading = false;
	// Every open model-picker popover, so a single document-level click
	// listener can close whichever ones the click landed outside of. One
	// listener bound once in the constructor rather than one per row per
	// display() call — the latter (an earlier version of this file) added a
	// fresh document listener every time a mapping was added/removed and
	// never removed the old ones, leaking a listener per render forever.
	private openPickers: Array<{ el: HTMLElement; close: () => void }> = [];
	private readonly handleDocumentClick = (evt: MouseEvent) => {
		for (const picker of this.openPickers) {
			if (!picker.el.contains(evt.target as Node)) picker.close();
		}
	};

	constructor(app: App, plugin: AgentConsolePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		document.removeEventListener("click", this.handleDocumentClick);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.openPickers = [];
		// Idempotent: remove-then-add so repeated display() calls (every
		// mapping add/remove re-renders the whole tab) never stack up more
		// than one listener, regardless of whether hide() ran in between.
		document.removeEventListener("click", this.handleDocumentClick);
		document.addEventListener("click", this.handleDocumentClick);

		new Setting(containerEl)
			.setName("Default Agent")
			.setDesc('Which CLI agent note buttons run by default. A button can override this with its own "agent:" line.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ claude: "Claude Code", opencode: "OpenCode" })
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

		this.renderProviderSection(containerEl, {
			key: "claude",
			title: "Claude Code",
			binaryDesc:
				'Absolute path to the claude executable. A bare "claude" may not resolve — Obsidian, as a GUI app, ' +
				"doesn't always see the same PATH your Terminal does (this is why it's prefilled with a full path). " +
				"If this path doesn't exist where the vault is currently open (e.g. the desktop-obsidian container), " +
				"it falls back to a few known install locations, then bare PATH lookup — see runner.ts.",
			binaryPlaceholder: "/Users/you/.local/bin/claude",
			modelOptionsDesc:
				"Claude Code has no live model list to query — these are the aliases/IDs claude --model documents " +
				"accepting. Type or paste any other model string directly if it's not in this list.",
			getModelOptions: () => CLAUDE_MODEL_OPTIONS,
			modelPlaceholder: "model string, e.g. claude-sonnet-5",
		});

		this.renderProviderSection(containerEl, {
			key: "opencode",
			title: "OpenCode",
			binaryDesc:
				"Absolute path to the opencode executable, or a bare command name to rely on PATH. Same fallback " +
				"behaviour as Claude Code above applies if this path doesn't exist in the current environment.",
			binaryPlaceholder: "/usr/local/bin/opencode",
			modelOptionsDesc: "Live list from `opencode models` — covers every provider OpenCode is currently configured for (including a local Ollama provider, if you've set one up).",
			getModelOptions: () => this.openCodeModelCache,
			modelPlaceholder: "model string, e.g. ollama/qwen3.8:27b-mlx",
		});
	}

	private resolvedBinary(key: ProviderKey): string {
		const settings = this.plugin.settings[key];
		return key === "claude"
			? resolveBinary(settings.binaryPath, "claude", CLAUDE_CANDIDATES)
			: resolveBinary(settings.binaryPath, "opencode", OPENCODE_CANDIDATES);
	}

	private setStatus(key: ProviderKey, status: ConnectionStatus): void {
		const dot = this.statusDots[key];
		if (!dot) return;
		dot.removeClass("is-connected", "is-disconnected", "is-checking");
		dot.addClass(status === "connected" ? "is-connected" : status === "disconnected" ? "is-disconnected" : "is-checking");
		dot.setAttr(
			"aria-label",
			status === "connected" ? "Connected" : status === "disconnected" ? "Not connected" : "Checking…"
		);
		dot.setAttr("title", dot.getAttr("aria-label") ?? "");
	}

	private async refreshStatus(key: ProviderKey): Promise<void> {
		this.setStatus(key, "checking");
		let cwd: string;
		try {
			cwd = this.plugin.getVaultBasePath();
		} catch {
			this.setStatus(key, "disconnected");
			return;
		}
		const ok = await checkBinaryAvailable(this.resolvedBinary(key), cwd);
		this.setStatus(key, ok ? "connected" : "disconnected");
	}

	private async refreshOpenCodeModels(onUpdate: () => void): Promise<void> {
		if (this.openCodeModelsLoading) return;
		this.openCodeModelsLoading = true;
		let cwd: string;
		try {
			cwd = this.plugin.getVaultBasePath();
		} catch {
			this.openCodeModelsLoading = false;
			return;
		}
		this.openCodeModelCache = await listOpenCodeModels(this.resolvedBinary("opencode"), cwd);
		this.openCodeModelsLoading = false;
		onUpdate();
	}

	private renderProviderSection(
		containerEl: HTMLElement,
		opts: {
			key: ProviderKey;
			title: string;
			binaryDesc: string;
			binaryPlaceholder: string;
			modelOptionsDesc: string;
			getModelOptions: () => string[];
			modelPlaceholder: string;
		}
	): void {
		const heading = new Setting(containerEl).setHeading();
		heading.nameEl.setText(opts.title);
		const dot = heading.nameEl.createSpan({ cls: "agent-console-status-dot is-checking" });
		this.statusDots[opts.key] = dot;
		heading.addExtraButton((btn) =>
			btn
				.setIcon("refresh-cw")
				.setTooltip(`Re-check ${opts.title} connection` + (opts.key === "opencode" ? " and refresh model list" : ""))
				.onClick(() => {
					void this.refreshStatus(opts.key);
					if (opts.key === "opencode") {
						void this.refreshOpenCodeModels(() => this.display());
					}
				})
		);

		new Setting(containerEl)
			.setName(`${opts.title} binary path`)
			.setDesc(opts.binaryDesc)
			.addText((text) =>
				text
					.setPlaceholder(opts.binaryPlaceholder)
					.setValue(this.plugin.settings[opts.key].binaryPath)
					.onChange(async (value) => {
						this.plugin.settings[opts.key].binaryPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		void this.refreshStatus(opts.key);
		if (opts.key === "opencode" && this.openCodeModelCache.length === 0 && !this.openCodeModelsLoading) {
			void this.refreshOpenCodeModels(() => this.display());
		}

		const mappingsHeader = new Setting(containerEl)
			.setName("Model mappings")
			.setDesc(
				`Give a model a short name here, then reference it from a button with "model: <name>". ${opts.modelOptionsDesc}`
			);
		mappingsHeader.addExtraButton((btn) =>
			btn
				.setIcon("plus")
				.setTooltip("Add mapping")
				.onClick(() => {
					void (async () => {
						this.plugin.settings[opts.key].models.push({ name: "", model: "" });
						await this.plugin.saveSettings();
						this.display();
					})();
				})
		);

		const listEl = containerEl.createDiv({ cls: "agent-console-model-list" });
		this.plugin.settings[opts.key].models.forEach((mapping, index) => {
			this.renderModelMappingRow(listEl, opts.key, index, opts.getModelOptions, opts.modelPlaceholder);
		});
	}

	private renderModelMappingRow(
		listEl: HTMLElement,
		providerKey: ProviderKey,
		index: number,
		getModelOptions: () => string[],
		modelPlaceholder: string
	): void {
		const mapping = this.plugin.settings[providerKey].models[index];
		const row = listEl.createDiv({ cls: "agent-console-model-row" });

		const nameInput = row.createEl("input", { type: "text", cls: "agent-console-model-name", placeholder: "name" });
		nameInput.value = mapping.name;
		nameInput.addEventListener("change", () => {
			mapping.name = nameInput.value.trim();
			void this.plugin.saveSettings();
		});

		const picker = row.createDiv({ cls: "agent-console-model-picker" });
		const modelInput = picker.createEl("input", {
			type: "text",
			cls: "agent-console-model-value",
			placeholder: modelPlaceholder,
		});
		modelInput.value = mapping.model;
		modelInput.addEventListener("change", () => {
			mapping.model = modelInput.value.trim();
			void this.plugin.saveSettings();
		});

		const toggleBtn = picker.createEl("button", { cls: "agent-console-model-picker-toggle", text: "▾" });
		toggleBtn.setAttr("type", "button");
		toggleBtn.setAttr("aria-label", "Choose from available models");
		const menu = picker.createDiv({ cls: "agent-console-model-picker-menu" });
		menu.setCssStyles({ display: "none" });

		const closeMenu = () => menu.setCssStyles({ display: "none" });
		const renderMenu = () => {
			menu.empty();
			const options = getModelOptions();
			if (options.length === 0) {
				menu.createDiv({ cls: "agent-console-model-picker-empty", text: "No models found — check the connection status above." });
				return;
			}
			options.forEach((modelString) => {
				const optionEl = menu.createDiv({ cls: "agent-console-model-option" });
				const nameSpan = optionEl.createSpan({ cls: "agent-console-model-option-name", text: modelString });
				nameSpan.addEventListener("click", () => {
					modelInput.value = modelString;
					mapping.model = modelString;
					void this.plugin.saveSettings();
					closeMenu();
				});
				const copyBtn = optionEl.createEl("button", { cls: "agent-console-model-option-copy", text: "⧉" });
				copyBtn.setAttr("type", "button");
				copyBtn.setAttr("title", "Copy model string");
				copyBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					void navigator.clipboard.writeText(modelString).then(() => {
						const original = copyBtn.textContent;
						copyBtn.setText("✓");
						window.setTimeout(() => copyBtn.setText(original ?? "⧉"), 1200);
					});
				});
			});
		};

		toggleBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			const isOpen = menu.style.display !== "none";
			if (isOpen) {
				closeMenu();
				return;
			}
			renderMenu();
			menu.setCssStyles({ display: "block" });
		});
		// Closing on an outside click is handled by the tab's single shared
		// document listener (see handleDocumentClick) rather than one
		// listener per row — this just registers into that shared list.
		this.openPickers.push({ el: picker, close: closeMenu });

		const removeBtn = row.createEl("button", { cls: "agent-console-model-remove", text: "✕" });
		removeBtn.setAttr("type", "button");
		removeBtn.setAttr("aria-label", "Remove this mapping");
		removeBtn.addEventListener("click", () => {
			void (async () => {
				const models = this.plugin.settings[providerKey].models;
				models.splice(index, 1);
				if (models.length === 0) models.push({ name: "", model: "" });
				await this.plugin.saveSettings();
				this.display();
			})();
		});
	}
}
