# Inline Agents

An Obsidian plugin that turns "run this workflow" instructions in a note into a button. Click it, and it fires Claude Code or OpenCode at the note, in a live terminal right underneath — or, if you'd rather not watch it work, quietly in the background with the result dropped straight into the note when it's done.

Built to replace plain-text "Run `features/learning-artefacts/teacher-artefact-leveller.md`" instructions scattered across a note system with something clickable.

## Install (local, this vault)

Already wired up: `.obsidian/plugins/obsidian-inline-agents` is a symlink into this repo, so Obsidian loads it directly — no build step needed to use it as-is. Enable it in **Settings → Community plugins** (turn on Community plugins first if you haven't) and toggle **Inline Agents** on.

## How it works

Each `agent-button` code block is its own self-contained widget, rendered via Obsidian's `registerMarkdownCodeBlockProcessor`. Clicking the button:

1. Resolves which agent binary to run. The configured path in Settings is a preference, not a guarantee — `resolveBinary()` (`src/runner.ts`) falls through a list of known install locations for the current OS/environment, then finally a bare command name so Node's own `PATH` lookup can find it. This lets the same `data.json` work across different machines (e.g. a real Mac and a container) without hand-editing settings every time the vault is opened somewhere else.
2. Spawns the agent CLI behind a real PTY. Node's own `child_process.spawn` gives a child pipe-backed stdio, not a real terminal, and most CLI agents (Claude Code and OpenCode included) behave differently — or refuse to run interactively at all — without one. Rather than depending on a native `node-pty` build (which needs a fresh prebuild every time Obsidian's bundled Electron version changes), the plugin shells out to `python3 -c "import pty,sys; pty.spawn(sys.argv[1:])"`, which does its own PTY allocation. See `src/runner.ts` for the full story of why (a first attempt using BSD `script` broke specifically under Obsidian's process spawning).
3. Feeds the PTY's output into an [xterm.js](https://xtermjs.org/) terminal instance rendered in an accordion under the button, so what you see is a real terminal, not a plain text log — ANSI colors, redraws, and all. You can type directly into it exactly like a normal terminal (approve/deny tool calls, answer questions) whenever the agent isn't auto-approving.
4. Once the process exits (or, in `responseEnd` completion mode, once the agent finishes its reply), the button returns to its idle state — and if `agentOutput: file` is set, the captured terminal output is cleaned up and written into the note.

Everything downstream of "read the rendered xterm buffer" — turn-state classification for `completion: responseEnd`, and clean-text extraction for `agentOutput: file` — works off xterm.js's own rendered screen (`src/outputCapture.ts`) rather than parsing the raw ANSI stream by hand. xterm has already done the hard work of turning cursor moves and redraws into a stable 2D grid of text, so reading *that* is far more reliable than trying to pattern-match a live ANSI stream.

## Usage

Drop a fenced code block with the `agent-button` language tag anywhere in a note:

````markdown
```agent-button
text: Run Sufficiency Check
prompt: Run features/learning-artefacts/teacher-artefact-sufficiency-check.md on {{this file}}
autoApprove: true
agent: claude
agentOutput: file
append: belowButton
showTerminal: false
completion: responseEnd
```
````

Every field except `text` and `prompt` is optional and falls back to a sensible default.

### Fields

- **`text`** — the button label.
- **`prompt`** — what gets sent to the agent as its first message. `{{this file}}` is replaced with the vault-relative path of the note the button is *in* (not whichever pane happens to be focused — it's resolved from the code block's own source note, so it's correct even with split panes).
- **`autoApprove`** (`true`/`false`, optional) — overrides the plugin-wide **Auto-approve by default** setting for this one button. When on, the agent runs with permission checks bypassed (`claude --dangerously-skip-permissions` / `opencode run --auto`). When off, it asks before each tool use, right there in the terminal.
- **`agent`** (`claude`/`opencode`, optional) — overrides the plugin-wide agent choice for this one button.
- **`agentOutput`** (`terminal`/`file`, default `terminal`) — where the agent's output ends up.
  - `terminal` — output stays in the live terminal accordion, as before. Nothing is written to the note.
  - `file` — once the run finishes, the captured output is written into the note itself (see [How file output is captured](#how-file-output-is-captured) below). The terminal accordion is still available while the run is live (subject to `showTerminal`); it's only the *destination* of the final result that changes.
- **`append`** (`top`/`bottom`/`belowButton`, default `bottom`, only meaningful when `agentOutput: file`) — where the captured output block gets inserted.
  - `bottom` — appended to the end of the note.
  - `top` — inserted after the frontmatter block (if any), otherwise at the very top of the note.
  - `belowButton` — inserted directly below the `agent-button` code block that triggered the run. The block's position in the note is snapshotted at click time; if the note has changed shape by the time the run finishes (edited, block moved), the plugin sanity-checks that snapshot against the note's current content and falls back to `bottom` rather than risk inserting into the middle of an unrelated paragraph.
- **`showTerminal`** (`true`/`false`, default `true`) — whether the terminal accordion opens automatically when the button is clicked.
  - `true` — the terminal appears in place immediately, as it always has.
  - `false` — the terminal stays collapsed; only the "Show terminal" toggle appears below the button, so you can open it on demand without it popping open every time.
- **`completion`** (`responseEnd`/`manual`, default `manual`) — how the button's loading state is resolved. See below.

### Completion modes

This controls when the button's spinner clears — which is a separate thing from whether the underlying agent session is still alive.

- **`manual`** (default) — the button stays in its loading state until the terminal session is closed, either by hand (closing the terminal, or the note itself, which sends the session `SIGINT`) or via the small checkmark button that appears to the right of the main button whenever a run is live under this mode (hover it to see the "Complete" tooltip). Clicking it kills the session and returns the button to idle. This is the safest default: nothing decides "the agent is done" on your behalf.
- **`responseEnd`** — the button's loading state clears automatically as soon as the agent finishes responding, *without* killing the underlying session — it keeps running in the background until the note is closed or it's killed some other way. This is heuristic: the plugin watches the rendered terminal for Claude Code's own turn-completion marker (a line like `Crunched for 7s · done 2:54 PM`) and clears the spinner when it sees one. If the agent is instead showing a dialog or question it's blocked on — a permission prompt, a "yes/no" confirmation — the spinner is swapped for a ✏️ icon instead of clearing, so a run that's actually waiting on you doesn't silently look finished. This detection is tuned against Claude Code's observed CLI output and is unverified against OpenCode, which may not use the same conventions at all (see [Known limitations](#known-limitations-mvp)).

### How file output is captured

When `agentOutput: file` is set, the plugin renders the full xterm buffer to plain text once the run ends and strips out what it recognizes as its own scaffolding or CLI/TUI chrome — the `$ <binary> <args>` echo line, Claude Code's own prompt echo, the turn-completion summary line, the persistent bottom status bar, box-drawing-only lines, and (if the session was killed mid-run) the raw Python `KeyboardInterrupt` traceback that `pty.spawn` surfaces on `SIGINT`. What's left is written into the note as:

```
**Agent output** (<button text>, <timestamp>)

<captured content>
```

This captures the whole visible session transcript (tool-call summaries included, not just the agent's final reply) rather than attempting to isolate "the assistant's message" specifically — doing real semantic extraction of just the reply would need much deeper, CLI-specific knowledge of each agent's exact output format than is safe to assume here. It's good enough to drop into a note as a record of the run; it isn't a guarantee of a perfectly clean, chrome-free transcript in every case, especially for CLIs whose output this hasn't been tuned against.

Settings (gear icon → Inline Agents): which agent runs by default, each agent's binary path, and the default auto-approve toggle.

## Known limitations (MVP)

- **PTY allocation uses `python3`, not `node-pty`.** First cut used BSD `script -q /dev/null`, which is broken *specifically when Obsidian spawns it* (`script: tcgetattr/ioctl: Operation not supported on socket` — Node's default piped stdio hands the child a socket-backed fd, and script's setup path can't `tcgetattr` that). Fixed by shelling out to `python3 -c "import pty,sys; pty.spawn(sys.argv[1:])"` instead, which does its own PTY allocation and doesn't have that dependency. Needs a `python3` at one of a few standard locations, or on `PATH` — true on basically any Mac or Linux environment.
- **Binary path resolution is best-effort.** `resolveBinary()` tries the configured setting, then a hardcoded candidate list of known install locations, then falls back to a bare command name for Node's own `PATH` lookup. It's been verified across a couple of real environments but isn't exhaustive — an unusual install location may still need to be set explicitly in Settings.
- **OpenCode is unverified.** The Claude Code adapter has been exercised live; the OpenCode adapter (`src/agents.ts`) is written from opencode.ai's documented CLI shape (`opencode run [--auto] --dir <path> "<prompt>"`) but hasn't been run against a real `opencode` CLI binary end to end. The `responseEnd` completion heuristic and file-output chrome-stripping are tuned specifically against Claude Code's observed output and are similarly unverified for OpenCode, which may use different completion markers, dialog phrasing, or none of the above — treat early OpenCode runs, especially with `completion: responseEnd` or `agentOutput: file`, as a test.
- **`agentOutput: file` and `completion: responseEnd` are heuristic, not exact.** Both work by pattern-matching the rendered terminal screen against text Claude Code has actually been observed to print, not by any structured signal from the agent itself. A CLI update that changes its output formatting, or output that doesn't match the patterns this was tuned against, can cause a run to be misclassified (e.g. the spinner not clearing, or a stray line surviving into the captured file output).
- **Closing the note kills a `manual`-mode run.** Each button's process is tied to its block's lifetime; navigating away from the note (destroying that block) sends the child process `SIGINT`. There's no background-run registry that survives the view closing entirely — a run started under `completion: responseEnd` does outlive the button going idle, but not the note being closed.
- **No live terminal resize signal to the child.** The PTY is allocated via `python3`'s `pty.spawn()` rather than a native `node-pty` build, specifically to avoid Electron-ABI version-pinning headaches. The trade-off is `SIGWINCH`/`ioctl` resize forwarding — a long run in a pane you resize mid-flight may wrap oddly, but content still comes through correctly.
- **One button = one fixed workflow.** Each `agent-button` block has one hardcoded prompt; there's no dropdown/picker for choosing a workflow at click time. A real improvement here would be auto-detecting existing plain-text "Run `X.md`" instructions in a vault and turning them into buttons automatically — not yet built.

## Dev

```bash
npm install
npm run dev    # esbuild --watch, writes main.js on save
npm run build  # typecheck + production (minified) build
```

Source lives in `src/`; `main.js` is generated (gitignored) — see `esbuild.config.mjs`.
