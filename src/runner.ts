import { spawn } from "child_process";

export interface AgentProcessHandle {
	write: (data: string) => void;
	kill: () => void;
	onData: (cb: (chunk: string) => void) => void;
	onExit: (cb: (code: number | null) => void) => void;
}

/**
 * Spawns `bin args...` allocated behind a real PTY, without needing a native
 * node-pty build tied to Obsidian's exact bundled Electron/Node ABI (which
 * would need a fresh prebuild every time Obsidian updates Electron).
 *
 * The trick: BSD `script` (present at /usr/bin/script on every Mac) opens a
 * pseudo-tty and proxies it to its own stdin/stdout — `script -q /dev/null
 * <cmd> <args>` runs <cmd> with a real TTY attached (verified live:
 * `process.stdout.isTTY` reports `true` inside it), which both Claude Code's
 * and OpenCode's interactive/Ink-style UIs need to render and to prompt for
 * permission approval. `/dev/null` discards script's own on-disk transcript
 * copy — we read the live stream straight off the child's stdout instead.
 *
 * Trade-off vs. real node-pty: terminal resize doesn't propagate to the
 * child (no ioctl access from here), so a very long agent run in a resized
 * pane may wrap awkwardly. Content still comes through correctly either way.
 */
export function spawnAgentProcess(bin: string, args: string[], cwd: string): AgentProcessHandle {
	const child = spawn("script", ["-q", "/dev/null", bin, ...args], {
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
