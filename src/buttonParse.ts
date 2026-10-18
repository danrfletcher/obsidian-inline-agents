import type { AgentKind } from "./agents";
import type { ModelMapping } from "./settingsModel";

/**
 * Pure note-level parsing — no "obsidian" import, so it can be unit tested
 * under Node (see tests/unit/button-parse.test.ts) and used as-is by
 * buttonBlock.ts, which is where the DOM/click wiring built on top of it
 * lives.
 */

export type AgentOutputTarget = "terminal" | "file";
export type CompletionMode = "responseEnd" | "manual";
export type AppendPosition = "top" | "bottom" | "belowButton";

export interface ButtonSpec {
	text: string;
	prompt: string;
	autoApprove?: boolean;
	agent?: AgentKind;
	/**
	 * Either the `name` of a mapping configured in Settings for whichever
	 * agent this button ends up using, or a literal model string to pass
	 * straight through (e.g. pasted via a model dropdown's copy button).
	 * Undefined means "don't pass --model at all" — see resolveModel().
	 */
	model?: string;
	/** Where the agent's output ends up. Default: "terminal". */
	agentOutput?: AgentOutputTarget;
	/** Only used when agentOutput is "file". Default: "bottom". */
	append?: AppendPosition;
	/** Whether the terminal accordion opens automatically on click. Default: true. */
	showTerminal?: boolean;
	/** How the button's loading state ends. Default: "manual". */
	completion?: CompletionMode;
	/**
	 * `target: terminal` or `target: <runtime name>` (G5). Undefined means
	 * the line was omitted, which uses the settings "Default target"
	 * silently — see resolveTargetName() in runtime/targetResolve.ts.
	 */
	target?: string;
	/**
	 * `open: true|false` (G6). Undefined means the line was omitted *or*
	 * malformed — both fall back to the settings default for `open`.
	 */
	open?: boolean;
	/** Overrides a runtime's configured agent/model for this button only (G6). */
	agentId?: string;
}

/**
 * ```agent-button
 * text: Run Sufficiency Check
 * prompt: Run teacher-artefact-sufficiency-check.md on {{file.path}}
 * autoApprove: true
 * agent: ClaudeCode
 * model: myMainModel
 * agentOutput: file
 * append: belowButton
 * showTerminal: false
 * completion: responseEnd
 * target: terminal
 * open: true
 * agentId: main
 * ```
 * The block itself is deliberately a plain `key: value`-per-line format
 * rather than an inline shortcode syntax — it's what Obsidian's own
 * registerMarkdownCodeBlockProcessor is built for (works identically in
 * Reading view and Live Preview, no custom text-scanning/escaping to get
 * wrong), and it's the same shape the "Buttons" community plugin uses.
 *
 * `prompt`'s own value supports `{{ }}` context lookups and (opt-in)
 * `{{= }}` JS expressions — see templating.ts / context.ts.
 *
 * `agent:` accepts `ClaudeCode`/`OpenCode` (case-insensitive; `claude` is
 * also accepted as a synonym for `ClaudeCode`). Anything else — including
 * the line being omitted entirely — falls back to the plugin-wide
 * "Default Agent" setting.
 *
 * `model:` accepts either the `name` of a model mapping configured in
 * Settings for whichever agent this button resolves to (case-insensitive),
 * or a literal model string passed straight through to the CLI's `--model`
 * flag (e.g. one copied via a mapping dropdown's copy button). Omitting the
 * line entirely passes no `--model` flag at all, leaving the CLI to fall
 * back to its own default the same way it would if run bare from a
 * terminal.
 *
 * `target:` names where the click goes: `terminal` (also the default when
 * the line is omitted) or the name of a configured agent runtime,
 * case-insensitive. `open:` and `agentId:` only matter for a runtime
 * target — see runtime/targetResolve.ts for how all three are resolved at
 * click time.
 */
function parseAgentKind(value: string): AgentKind | undefined {
	const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
	if (normalized === "claude" || normalized === "claudecode") return "claude";
	if (normalized === "opencode") return "opencode";
	return undefined;
}

export function parseButtonBlock(source: string): ButtonSpec {
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
				// Anything unrecognized (including the line being omitted
				// entirely) is left unset so it falls back to the plugin-wide
				// "Default Agent" setting rather than silently forcing one.
				spec.agent = parseAgentKind(value);
				break;
			case "model":
				// Case preserved deliberately — a mapping name is matched
				// case-insensitively at resolve time (see resolveModel()),
				// but a literal model string passed straight through (e.g.
				// an Ollama model like "orcarouter/Qwen3.8-27B-Uncensored")
				// may be case-sensitive to whatever's on the other end.
				spec.model = value;
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
			case "target":
				// Case preserved — matched case-insensitively against runtime
				// names at resolve time (see resolveTargetName()), but the
				// original text is kept for the unknown-target notice.
				spec.target = value;
				break;
			case "open":
				// Anything other than a recognized true/false spelling
				// (including empty) is left unset, which falls back to the
				// settings default for `open` — G6's "malformed" case.
				spec.open = /^(true|yes|on|1)$/i.test(value) ? true : /^(false|no|off|0)$/i.test(value) ? false : undefined;
				break;
			case "agentid":
				spec.agentId = value;
				break;
		}
	}
	return {
		text: spec.text ?? "Run agent",
		prompt: spec.prompt ?? "",
		autoApprove: spec.autoApprove,
		agent: spec.agent,
		model: spec.model,
		agentOutput: spec.agentOutput,
		append: spec.append,
		showTerminal: spec.showTerminal,
		completion: spec.completion,
		target: spec.target,
		open: spec.open,
		agentId: spec.agentId,
	};
}

/**
 * A button's `model:` value is deliberately ambiguous between two things,
 * resolved in this order:
 *  1. the `name` of a mapping configured in Settings for whichever agent
 *     this button ends up using (case-insensitive — "myMainModel" and
 *     "mymainmodel" both hit the same row), or
 *  2. failing that, the value itself, passed straight through as a literal
 *     model string — this is what lets someone paste a raw model ID via a
 *     dropdown option's copy button without configuring a mapping first.
 * Undefined (the key was never set) short-circuits to undefined, which
 * buildAgentCommand treats as "don't pass --model at all".
 */
export function resolveModel(rawValue: string | undefined, mappings: ModelMapping[]): string | undefined {
	if (!rawValue) return undefined;
	const needle = rawValue.trim().toLowerCase();
	const match = mappings.find((m) => m.name.trim().toLowerCase() === needle && m.name.trim() !== "");
	return match ? match.model : rawValue;
}
