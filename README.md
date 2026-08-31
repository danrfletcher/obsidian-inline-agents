# Agent Console

An Obsidian plugin that turns "run this workflow" instructions in a note into a button — click it, and it fires Claude Code or OpenCode at the note, in a live terminal right underneath.

Built 2026-08-31 to replace the plain-text "Run `features/learning-artefacts/teacher-artefact-leveller.md`" instructions scattered across the Classroom system (Teacher/Tutor/Examiner) with something clickable.

## Install (local, this vault)

Already wired up: `.obsidian/plugins/obsidian-agent-console` is a symlink into this repo, so Obsidian loads it directly — no build step needed to use it as-is. Enable it in **Settings → Community plugins** (turn on Community plugins first if you haven't) and toggle **Agent Console** on.

## Usage

Drop a fenced code block with the `agent-button` language tag anywhere in a note:

````markdown
```agent-button
text: Run Sufficiency Check
prompt: Run features/learning-artefacts/teacher-artefact-sufficiency-check.md on {{this file}}
autoApprove: true
```
````

Fields:
- `text` — the button label.
- `prompt` — what gets sent to the agent as its first message. `{{this file}}` is replaced with the vault-relative path of the note the button is *in* (not whichever pane happens to be focused).
- `autoApprove` (optional, `true`/`false`) — overrides the plugin-wide **Auto-approve by default** setting for this one button. When on, the agent runs with permission checks bypassed (`claude --dangerously-skip-permissions` / `opencode run --auto`). When off, it'll ask before each tool use, right there in the terminal.
- `agent` (optional, `claude`/`opencode`) — overrides the plugin-wide agent choice for this one button.

Click the button: it goes into a loading state, and a terminal accordion opens underneath showing the agent running live — you can type into it exactly like a real terminal (approve/deny tool calls, answer questions) when not auto-approving. Click "Hide terminal" to collapse the accordion without killing the run; click the button again while it's running to reopen it.

Settings (gear icon → Agent Console): which agent runs by default, each agent's binary path, and the default auto-approve toggle.

## Known limitations (MVP)

- **OpenCode is unverified.** Only the OpenCode *desktop app* was found installed on this Mac when this was built — no `opencode` CLI binary anywhere on disk. The adapter (`src/agents.ts`) is written from opencode.ai's docs (`opencode run [--auto] --dir <path> "<prompt>"`) but has never actually been run. Install the CLI and point Settings → OpenCode binary path at it, then it should work — but treat the first real run as a test.
- **Closing the note kills the run.** Each button's process is tied to its block's lifetime; navigating away from the note (destroying that block) sends the child process `SIGINT`. There's no background-run registry that survives the view closing — starting a run and leaving would need a v2.
- **No live terminal resize signal to the child.** The PTY is allocated via BSD `script` (see `src/runner.ts`'s comment) rather than a native `node-pty` build, specifically to dodge Electron-ABI version-pinning headaches. The one thing that trades away is `SIGWINCH`/`ioctl` resize forwarding — a long run in a pane you resize mid-flight may wrap oddly, but content still comes through correctly.
- **One button = one fixed workflow.** Each `agent-button` block has one hardcoded prompt; there's no dropdown/picker for choosing a workflow at click time. (This was also true of the plain Shell Commands + Buttons DIY baseline this replaces — a real improvement here is auto-detecting the vault's existing "Run `X.md`" instruction text and turning it into a button automatically, not yet built.)

## Dev

```bash
npm install
npm run dev    # esbuild --watch, writes main.js on save
npm run build  # typecheck + production (minified) build
```

Source lives in `src/`; `main.js` is generated (gitignored) — see `esbuild.config.mjs`.
