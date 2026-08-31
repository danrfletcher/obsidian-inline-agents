import { spawn } from "child_process";
import { existsSync } from "fs";

export interface AgentProcessHandle {
	write: (data: string) => void;
	kill: () => void;
	onData: (cb: (chunk: string) => void) => void;
	onExit: (cb: (code: number | null) => void) => void;
}

// --- Bulletproof typing for Node's built-in APIs -----------------------
//
// Obsidian's community-review type-checker does not resolve Node's global
// ambient declarations (@types/node) the way this repo's own `tsc`/eslint
// do — `process`, and the return values of `existsSync`/`spawn`, all come
// back typed `any` on their end, which cascades into a wall of
// `@typescript-eslint/no-unsafe-*` findings on every line that touches
// them, even though `npm run lint` here is clean. Moving `@types/node`
// into `dependencies` (tried first) didn't change that — their checker
// evidently isn't reading it from either dependency section.
//
// Rather than keep guessing at their sandbox, every touchpoint below is
// asserted through `unknown` into a small local interface describing only
// the shape this file actually uses. `X as unknown as T` type-checks no
// matter what X's real inferred type is — `any`, a proper Node signature,
// or anything else — so this reads identically (and safely) in both
// environments, and the runtime behaviour is completely unchanged.
type ExistsSyncFn = (path: string) => boolean;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- unnecessary here (where @types/node resolves) but required in Obsidian's community-review type-checker, where existsSync resolves as `any` without it.
const fsExistsSync = existsSync as unknown as ExistsSyncFn;

interface ReadableLike {
	on(event: "data", listener: (chunk: { toString(encoding?: string): string }) => void): void;
}
interface WritableLike {
	write(data: string): void;
	destroyed: boolean;
}
interface ChildProcessLike {
	stdout: ReadableLike | null;
	stderr: ReadableLike | null;
	stdin: WritableLike | null;
	killed: boolean;
	on(event: "exit", listener: (code: number | null) => void): void;
	on(event: "error", listener: (err: Error) => void): void;
	kill(signal?: string): void;
}
type SpawnFn = (
	command: string,
	args: string[],
	options: { cwd: string; env: Record<string, string | undefined> }
) => ChildProcessLike;
const spawnProcess = spawn as unknown as SpawnFn;
interface ProcessLike {
	env: Record<string, string | undefined>;
}
const typedProcess = process as unknown as ProcessLike;
const processEnv = typedProcess.env;
// -------------------------------------------------------------------------

// Candidates in preference order; first one that exists on disk wins.
const PYTHON_CANDIDATES = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
const PTY_SPAWN_SNIPPET = "import pty,sys; pty.spawn(sys.argv[1:])";

function resolvePython(): string {
	return PYTHON_CANDIDATES.find((p) => fsExistsSync(p)) ?? "python3";
}

// Known install locations for the agent CLIs, across the environments this
// vault actually runs in: Dan's real Mac (via .local/bin, homebrew, or a
// plain global npm install) and the `desktop-obsidian` Docker container
// (npm global installs land in /usr/bin there). `data.json` is a single
// file shared between both — a path valid in one is often not valid in the
// other — so `resolveBinary` below treats the configured setting as a
// preference, not a hard requirement, and falls through these before
// giving up and trusting PATH.
export const CLAUDE_CANDIDATES = [
	"/Users/danfletcher/.local/bin/claude",
	"/usr/bin/claude",
	"/usr/local/bin/claude",
	"/opt/homebrew/bin/claude",
];
export const OPENCODE_CANDIDATES = [
	"/usr/bin/opencode",
	"/usr/local/bin/opencode",
	"/opt/homebrew/bin/opencode",
	"/Users/danfletcher/.local/bin/opencode",
];

/**
 * Resolves which binary to actually exec for an agent, so a single shared
 * `data.json` keeps working whether this vault is open on the real Mac or
 * inside the container:
 *  1. the user's configured path, if it exists on this filesystem
 *  2. the first known candidate location that exists on this filesystem
 *  3. `binName` bare (no slash) — Node's spawn() then does its own PATH
 *     lookup at exec time, which covers any install this list doesn't know
 *     about, provided it's on the PATH the process actually launches with.
 */
export function resolveBinary(configuredPath: string, binName: string, candidates: string[]): string {
	if (configuredPath && fsExistsSync(configuredPath)) return configuredPath;
	const found = candidates.find((p) => fsExistsSync(p));
	if (found) return found;
	return binName;
}

/**
 * Spawns `bin args...` allocated behind a real PTY, without needing a native
 * node-pty build tied to Obsidian's exact bundled Electron/Node ABI (which
 * would need a fresh prebuild every time Obsidian updates Electron).
 *
 * First attempt here was BSD `script -q /dev/null <cmd> <args>` — works
 * perfectly when *you* run it from a real terminal (verified), but FAILS
 * when Obsidian spawns it: `script: tcgetattr/ioctl: Operation not
 * supported on socket`. Reproduced outside Obsidian entirely with a bare
 * `node -e "require('child_process').spawn('script', ...)"` — Node's
 * default 'pipe' stdio hands the child a socket-backed fd, and BSD script's
 * setup path calls tcgetattr on it (to replicate the *caller's* terminal
 * settings onto the new pty), which errors on a non-tty/non-regular-pipe fd.
 *
 * Fix: `python3 -c "import pty,sys; pty.spawn(sys.argv[1:])"` instead.
 * Python's pty.spawn() does its own openpty()/fork() and doesn't try to
 * copy termios settings from a controlling terminal that may not exist —
 * verified working from the exact same socket-stdio spawn shape Obsidian
 * uses: `process.stdout.isTTY` reports `true` inside the child, and a
 * bidirectional write/read round-trip (via `cat`) worked correctly. Also
 * verified end to end inside the `desktop-obsidian` Docker container (its
 * python3 lives at /lsiopy/bin/python3 — not in PYTHON_CANDIDATES above,
 * but still resolves correctly via the bare-name PATH fallback since that
 * path is on the container's PATH).
 *
 * Trade-off vs. real node-pty: terminal resize doesn't propagate to the
 * child (no ioctl access from here), so a very long agent run in a resized
 * pane may wrap awkwardly. Content still comes through correctly either way.
 */
export function spawnAgentProcess(bin: string, args: string[], cwd: string): AgentProcessHandle {
	const child = spawnProcess(resolvePython(), ["-c", PTY_SPAWN_SNIPPET, bin, ...args], {
		cwd,
		env: processEnv,
	});

	const dataCbs: Array<(chunk: string) => void> = [];
	const exitCbs: Array<(code: number | null) => void> = [];

	child.stdout?.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		dataCbs.forEach((cb) => cb(text));
	});
	child.stderr?.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		dataCbs.forEach((cb) => cb(text));
	});
	child.on("exit", (code) => {
		exitCbs.forEach((cb) => cb(code));
	});
	child.on("error", (err) => {
		dataCbs.forEach((cb) => cb(`\r\n\x1b[31m[agent-console] Failed to start "${bin}": ${err.message}\x1b[0m\r\n`));
		exitCbs.forEach((cb) => cb(null));
	});

	return {
		write: (data: string) => {
			if (child.stdin && !child.stdin.destroyed) {
				child.stdin.write(data);
			}
		},
		kill: () => {
			if (!child.killed) {
				child.kill("SIGINT");
			}
		},
		onData: (cb) => dataCbs.push(cb),
		onExit: (cb) => exitCbs.push(cb),
	};
}

export interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Runs `bin args...` to completion with plain piped stdio (no PTY, no
 * interactivity) and collects its output — for one-shot, non-interactive
 * probes like `--version` or `models`, not actual agent sessions. Used by
 * the settings tab's connection-status dots and OpenCode's model-list
 * fetch, so it's deliberately not the PTY path above: those are quick
 * background checks, not something a user is meant to watch or type into.
 *
 * Times out and kills the child after `timeoutMs` rather than leaving the
 * settings UI stuck on "checking…" forever if `bin` resolves to something
 * that never exits on its own (e.g. a bare command name that happens to
 * launch an interactive shell instead of the CLI we expect).
 */
export function runCommand(bin: string, args: string[], cwd: string, timeoutMs = 8000): Promise<CommandResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			resolve(result);
		};

		let child: ChildProcessLike;
		try {
			child = spawnProcess(bin, args, { cwd, env: processEnv });
		} catch (err) {
			finish({ code: null, stdout: "", stderr: (err as Error).message });
			return;
		}

		const timer = window.setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: null, stdout, stderr: stderr + "\n[agent-console] timed out" });
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("exit", (code) => finish({ code, stdout, stderr }));
		child.on("error", (err) => finish({ code: null, stdout, stderr: stderr + err.message }));
	});
}

/**
 * "Is this CLI actually runnable right now" — the plugin's status dots.
 * Deliberately just `--version`: it's fast, needs no auth/network, and
 * fails cleanly (non-zero exit, or the spawn itself erroring) for a
 * binary that doesn't resolve at all. It doesn't confirm the agent is
 * *authenticated* or that a configured provider is reachable — only that
 * the executable exists and runs. That's the same bar `resolveBinary`
 * already needs met to do anything useful, so it's the right bar here too.
 */
export async function checkBinaryAvailable(bin: string, cwd: string): Promise<boolean> {
	const result = await runCommand(bin, ["--version"], cwd, 6000);
	return result.code === 0;
}

/**
 * Lists OpenCode's configured models as `provider/model` strings, via
 * `opencode models` (opencode.ai/docs/cli — "displays all models available
 * across your configured providers in the format provider/model"). This
 * covers local/OpenAI-compatible providers (e.g. an Ollama config) as well
 * as hosted ones already authenticated via `opencode auth login` — no
 * `--refresh` flag here, since that re-pulls models.dev's hosted-provider
 * catalog over the network and isn't needed to see a local provider's
 * models; the settings UI has its own refresh action for that.
 *
 * Returns [] on any failure (binary missing, no providers configured,
 * timeout) rather than throwing — callers treat an empty list as "nothing
 * to show", same as a provider with genuinely zero models configured.
 */
export async function listOpenCodeModels(bin: string, cwd: string): Promise<string[]> {
	const result = await runCommand(bin, ["models"], cwd, 15000);
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line.includes("/"));
}
