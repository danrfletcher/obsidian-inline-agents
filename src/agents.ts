export type AgentKind = "claude" | "opencode";

export interface RunOptions {
	prompt: string;
	cwd: string;
	autoApprove: boolean;
	/**
	 * Literal string to pass as the CLI's `--model` flag (a model ID, or
	 * whatever alias the CLI itself accepts — e.g. Claude Code's "sonnet").
	 * Undefined means "don't pass --model at all", which leaves each CLI to
	 * fall back to its own default resolution (env var, its own settings
	 * file, last-used-per-directory, etc.) exactly as if it were run bare
	 * from a terminal with no flag.
	 */
	model?: string;
}

export interface AgentCommand {
	bin: string;
	args: string[];
}

/**
 * Claude Code: interactive by default when given a bare prompt argument —
 * `claude "<prompt>"` starts a normal interactive session with that as the
 * first message, which is exactly what we want feeding the terminal
 * accordion. `--dangerously-skip-permissions` is Claude Code's own
 * documented flag for bypassing tool-permission prompts entirely.
 */
export function buildClaudeCommand(binaryPath: string, opts: RunOptions): AgentCommand {
	const args: string[] = [];
	if (opts.autoApprove) {
		args.push("--dangerously-skip-permissions");
	}
	if (opts.model) {
		args.push("--model", opts.model);
	}
	args.push(opts.prompt);
	return { bin: binaryPath || "claude", args };
}

/**
 * OpenCode: unlike Claude Code, the interactive TUI (`opencode [dir]`)
 * cannot take an initial prompt — only `opencode run "<prompt>"` accepts one
 * (opencode.ai/docs/cli). `run` still allocates through our PTY wrapper, so
 * it can still prompt for approval on the terminal when `--auto` isn't
 * passed. `--auto` is OpenCode's documented "approve anything not
 * explicitly denied" flag (opencode.ai/docs/permissions).
 *
 * NOTE: not live-verified against a real `opencode` binary — only the
 * OpenCode desktop app was found installed as of 2026-08-31, not the CLI.
 * See this repo's README.
 */
export function buildOpenCodeCommand(binaryPath: string, opts: RunOptions): AgentCommand {
	const args: string[] = ["run"];
	if (opts.autoApprove) {
		args.push("--auto");
	}
	if (opts.model) {
		args.push("--model", opts.model);
	}
	args.push("--dir", opts.cwd);
	args.push(opts.prompt);
	return { bin: binaryPath || "opencode", args };
}

export function buildAgentCommand(agent: AgentKind, binaryPath: string, opts: RunOptions): AgentCommand {
	return agent === "opencode" ? buildOpenCodeCommand(binaryPath, opts) : buildClaudeCommand(binaryPath, opts);
}
