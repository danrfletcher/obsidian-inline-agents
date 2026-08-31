import { spawn } from "child_process";
import { existsSync } from "fs";

export interface AgentProcessHandle {
	write: (data: string) => void;
	kill: () => void;
	onData: (cb: (chunk: string) => void) => void;
	onExit: (cb: (code: number | null) => void) => void;
}

// Candidates in preference order; first one that exists on disk wins.
const PYTHON_CANDIDATES = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
const PTY_SPAWN_SNIPPET = "import pty,sys; pty.spawn(sys.argv[1:])";

function resolvePython(): string {
	return PYTHON_CANDIDATES.find((p) => existsSync(p)) ?? "python3";
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
 * bidirectional write/read round-trip (via `cat`) worked correctly.
 *
 * Trade-off vs. real node-pty: terminal resize doesn't propagate to the
 * child (no ioctl access from here), so a very long agent run in a resized
 * pane may wrap awkwardly. Content still comes through correctly either way.
 */
export function spawnAgentProcess(bin: string, args: string[], cwd: string): AgentProcessHandle {
	const child = spawn(resolvePython(), ["-c", PTY_SPAWN_SNIPPET, bin, ...args], {
		cwd,
		env: process.env,
	});

	const dataCbs: Array<(chunk: string) => void> = [];
	const exitCbs: Array<(code: number | null) => void> = [];

	child.stdout?.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		dataCbs.forEach((cb) => cb(text));
	});
	child.stderr?.on("data", (chunk: Buffer) => {
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
