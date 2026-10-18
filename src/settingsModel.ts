import type { AgentKind } from "./agents";
import type { AgentRuntime } from "./runtime/types";

/**
 * Plain settings types/defaults, deliberately free of any "obsidian" import
 * so they (and the pure migration/validation logic built on them) can be
 * imported by the Node test suite — see tests/unit and
 * src/runtime/settingsMigrate.ts. The Obsidian-facing settings tab
 * (src/settings.ts) imports from here rather than the other way around.
 */

/** One `model:` shortcut a button can reference by `name`. See resolveModel() in buttonParse.ts. */
export interface ModelMapping {
	name: string;
	model: string;
}

export interface AgentConsoleSettings {
	agent: AgentKind;
	autoApproveDefault: boolean;
	/** Gates `{{= expr }}` JS expressions in `prompt:` templates (see
	 * templating.ts). Off by default — an expression evaluates with
	 * `new Function` against the button's context, which is arbitrary code
	 * execution scoped to whatever's in that context; same posture
	 * Dataview takes with its own JS-queries setting. */
	allowJsExpressions: boolean;
	claude: { binaryPath: string; models: ModelMapping[] };
	opencode: { binaryPath: string; models: ModelMapping[] };
	/** Configured HTTP agent runtimes — see src/runtime/types.ts. */
	runtimes: AgentRuntime[];
	/** "terminal" or the name of a configured runtime. Always kept valid — see settingsMigrate.ts. */
	defaultTarget: string;
	/** Default for a button's `open:` line when it's absent or malformed. */
	defaultOpen: boolean;
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
	claude: { binaryPath: "/Users/danfletcher/.local/bin/claude", models: [{ name: "", model: "" }] },
	opencode: { binaryPath: "opencode", models: [{ name: "", model: "" }] },
	runtimes: [],
	defaultTarget: "terminal",
	defaultOpen: true,
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
