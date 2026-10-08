import { App, PluginSettingTab, Setting, SecretComponent } from "obsidian";
import type AgentConsolePlugin from "./main";
import type { AgentKind } from "./agents";
import { checkBinaryAvailable, listOpenCodeModels, resolveBinary, CLAUDE_CANDIDATES, OPENCODE_CANDIDATES } from "./runner";
import { CLAUDE_MODEL_OPTIONS } from "./settingsModel";
import type { AgentRuntime, RuntimeKind } from "./runtime/types";
import { validateBaseUrl, validateRuntimeName, validateThreadUrlTemplate } from "./runtime/validation";
import { testConnection } from "./runtime/testConnection";
import { createObsidianHttpFn } from "./runtime/httpAdapter";

export type { ModelMapping, AgentConsoleSettings } from "./settingsModel";
export { DEFAULT_SETTINGS, CLAUDE_MODEL_OPTIONS } from "./settingsModel";

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

		new Setting(containerEl)
			.setName("Allow JavaScript expressions in prompts")
			.setDesc(
				'When on, a prompt\'s "{{= expression }}" segments run as real JavaScript (with the button\'s file, ' +
					"vault, and date context in scope) before the agent sees them — e.g. " +
					'"{{= file.frontmatter.status === \'draft\' ? \'Finish\' : \'Review\' }}". This is arbitrary code ' +
					"execution scoped to that context, run whenever a note with such a button is opened and clicked, " +
					'so it\'s off by default. Plain "{{ file.basename }}"-style lookups always work regardless of this ' +
					"setting."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.allowJsExpressions).onChange(async (value) => {
					this.plugin.settings.allowJsExpressions = value;
					await this.plugin.saveSettings();
				})
			);

		this.renderRuntimesSection(containerEl);

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

	/**
	 * G1/G2/G3/G4: the "Agent runtimes" list, the "Default target"/"open"
	 * defaults, and per-row "Test connection". No reordering — rows render
	 * in array order and the only way to change position is remove + re-add.
	 */
	private renderRuntimesSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Agent runtimes").setHeading();

		const defaultTargetSetting = new Setting(containerEl)
			.setName("Default target")
			.setDesc(
				"Where a button goes when its \"target:\" line is missing, or names a runtime that no longer exists. " +
					'The toggle is the default for a button\'s "open:" line.'
			);
		defaultTargetSetting.addDropdown((dropdown) => {
			dropdown.addOption("terminal", "Terminal");
			for (const runtime of this.plugin.settings.runtimes) {
				if (runtime.name.trim()) dropdown.addOption(runtime.name, runtime.name);
			}
			const current = this.plugin.settings.defaultTarget;
			const resolvedValue =
				current.toLowerCase() === "terminal"
					? "terminal"
					: this.plugin.settings.runtimes.find((r) => r.name.toLowerCase() === current.toLowerCase())?.name ??
						"terminal";
			dropdown.setValue(resolvedValue);
			dropdown.onChange(async (value) => {
				this.plugin.settings.defaultTarget = value;
				await this.plugin.saveSettings();
			});
		});
		defaultTargetSetting.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.defaultOpen).onChange(async (value) => {
				this.plugin.settings.defaultOpen = value;
				await this.plugin.saveSettings();
			})
		);

		const listEl = containerEl.createDiv({ cls: "agent-console-runtime-list" });
		this.plugin.settings.runtimes.forEach((_, index) => this.renderRuntimeRow(listEl, index));

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Add runtime")
				.setCta()
				.onClick(() => {
					void (async () => {
						const runtime: AgentRuntime = {
							id: crypto.randomUUID(),
							name: "",
							kind: "openclaw-hook",
							baseUrl: "",
							agentId: "",
							tokenRequired: true,
							sendSessionKeyHeader: false,
							threadUrlTemplate: "",
						};
						this.plugin.settings.runtimes.push(runtime);
						await this.plugin.saveSettings();
						this.display();
					})();
				})
		);
	}

	private hasTokenOnThisDevice(runtime: AgentRuntime): boolean {
		const value = this.plugin.app.secretStorage.getSecret(runtime.id);
		return typeof value === "string" && value.trim() !== "";
	}

	private renderRuntimeRow(listEl: HTMLElement, index: number): void {
		const runtime = this.plugin.settings.runtimes[index];
		const card = listEl.createDiv({ cls: "agent-console-runtime-card" });

		const nameSetting = new Setting(card).setName("Name").setDesc('Matched case-insensitively against a button\'s "target:" line.');
		nameSetting.addText((text) =>
			text
				.setPlaceholder("openclaw")
				.setValue(runtime.name)
				.onChange(async (value) => {
					const result = validateRuntimeName(value, this.plugin.settings.runtimes, index);
					if (!result.ok) {
						nameSetting.setErrorMessage(result.reason);
						return;
					}
					nameSetting.setErrorMessage(null);
					runtime.name = value.trim();
					await this.plugin.saveSettings();
				})
		);

		new Setting(card)
			.setName("Kind")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ "openclaw-hook": "OpenClaw hook", "openai-chat": "OpenAI-compatible chat" })
					.setValue(runtime.kind)
					.onChange(async (value) => {
						runtime.kind = value as RuntimeKind;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		const baseUrlSetting = new Setting(card).setName("Base URL");
		baseUrlSetting.addText((text) =>
			text
				.setPlaceholder("http://127.0.0.1:18789")
				.setValue(runtime.baseUrl)
				.onChange(async (value) => {
					const result = validateBaseUrl(value);
					if (!result.ok) {
						baseUrlSetting.setErrorMessage(result.reason);
						return;
					}
					baseUrlSetting.setErrorMessage(null);
					runtime.baseUrl = value.trim();
					await this.plugin.saveSettings();
				})
		);

		new Setting(card)
			.setName("Agent ID or model")
			.setDesc('Overridable per button with "agentId:".')
			.addText((text) =>
				text
					.setPlaceholder(runtime.kind === "openclaw-hook" ? "main" : "gpt-4o")
					.setValue(runtime.agentId)
					.onChange(async (value) => {
						runtime.agentId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(card)
			.setName("Token required")
			.setDesc("Block a click with a notice if no token is stored on this device.")
			.addToggle((toggle) =>
				toggle.setValue(runtime.tokenRequired).onChange(async (value) => {
					runtime.tokenRequired = value;
					await this.plugin.saveSettings();
				})
			);

		if (runtime.kind === "openai-chat") {
			new Setting(card)
				.setName("Send session key as x-openclaw-session-key")
				.setDesc("Turn this on if this chat endpoint is OpenClaw's.")
				.addToggle((toggle) =>
					toggle.setValue(runtime.sendSessionKeyHeader).onChange(async (value) => {
						runtime.sendSessionKeyHeader = value;
						await this.plugin.saveSettings();
					})
				);
		}

		const hasToken = this.hasTokenOnThisDevice(runtime);
		const tokenSetting = new Setting(card)
			.setName("Token")
			.setDesc(
				runtime.tokenRequired && !hasToken
					? "Token required but not set on this device."
					: "Stored only in this device's secret storage — never in data.json."
			);
		if (runtime.tokenRequired && !hasToken) tokenSetting.settingEl.addClass("agent-console-runtime-token-missing");
		let pendingTokenValue = "";
		tokenSetting.addComponent((el) => {
			const secret = new SecretComponent(this.app, el);
			secret.setValue(hasToken ? "••••••••" : "");
			secret.onChange((value) => {
				pendingTokenValue = value;
				this.plugin.app.secretStorage.setSecret(runtime.id, value);
				tokenSetting.settingEl.removeClass("agent-console-runtime-token-missing");
				tokenSetting.setDesc("Stored only in this device's secret storage — never in data.json.");
			});
			return secret;
		});

		const threadUrlSetting = new Setting(card)
			.setName("Thread-URL template")
			.setDesc("Optional. May use {agentId}, {sessionKey}, {sessionKeyPath}.");
		threadUrlSetting.addText((text) =>
			text
				.setPlaceholder("https://example.com/threads/{sessionKey}")
				.setValue(runtime.threadUrlTemplate ?? "")
				.onChange(async (value) => {
					const result = validateThreadUrlTemplate(value);
					if (!result.ok) {
						threadUrlSetting.setErrorMessage(result.reason);
						return;
					}
					threadUrlSetting.setErrorMessage(null);
					runtime.threadUrlTemplate = value.trim();
					await this.plugin.saveSettings();
				})
		);

		const testSetting = new Setting(card).setName("Test connection").setDesc("Checks reachability and the token — never sends a prompt.");
		testSetting.addButton((btn) =>
			btn.setButtonText("Test connection").onClick(() => {
				void (async () => {
					btn.setDisabled(true);
					testSetting.setDesc("Checking…");
					const tokenForTest = pendingTokenValue || (this.plugin.app.secretStorage.getSecret(runtime.id) ?? "");
					const result = await testConnection(runtime, tokenForTest, createObsidianHttpFn());
					testSetting.setDesc(result.message);
					testSetting.settingEl.toggleClass("agent-console-test-ok", result.ok);
					testSetting.settingEl.toggleClass("agent-console-test-fail", !result.ok);
					btn.setDisabled(false);
				})();
			})
		);

		new Setting(card).addButton((btn) =>
			btn
				.setButtonText("Remove")
				.setWarning()
				.onClick(() => {
					void (async () => {
						this.plugin.app.secretStorage.setSecret(runtime.id, "");
						const removedName = runtime.name.trim().toLowerCase();
						this.plugin.settings.runtimes.splice(index, 1);
						if (this.plugin.settings.defaultTarget.trim().toLowerCase() === removedName) {
							this.plugin.settings.defaultTarget = "terminal";
						}
						await this.plugin.saveSettings();
						this.display();
					})();
				})
		);
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
