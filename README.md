# Inline Agents

📖 **[Full documentation](https://danrfletcher.github.io/obsidian-inline-agents/)**

An Obsidian plugin that turns "run this workflow" instructions in a note into a button. Click it, and it fires Claude Code or OpenCode at the note, in a live terminal right underneath — or, if you'd rather not watch it work, quietly in the background with the result dropped straight into the note when it's done.

Built to replace plain-text "Run `features/learning-artefacts/teacher-artefact-leveller.md`" instructions scattered across a note system with something clickable.

## Install (local, this vault)

Already wired up: `.obsidian/plugins/inline-agents` is a symlink into this repo, so Obsidian loads it directly — no build step needed to use it as-is. Enable it in **Settings → Community plugins** (turn on Community plugins first if you haven't) and toggle **Inline Agents** on.

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
prompt: Run features/learning-artefacts/teacher-artefact-sufficiency-check.md on {{file.path}}
autoApprove: true
agent: ClaudeCode
model: myMainModel
agentOutput: file
append: belowButton
showTerminal: false
completion: responseEnd
```
````

Every field except `text` and `prompt` is optional and falls back to a sensible default.

### Fields

- **`text`** — the button label.
- **`prompt`** — what gets sent to the agent as its first message. Supports `{{ }}` context and `{{= }}` expressions — see [Context and templating](#context-and-templating) below.
- **`autoApprove`** (`true`/`false`, optional) — overrides the plugin-wide **Auto-approve by default** setting for this one button. When on, the agent runs with permission checks bypassed (`claude --dangerously-skip-permissions` / `opencode run --auto`). When off, it asks before each tool use, right there in the terminal.
- **`agent`** (`ClaudeCode`/`OpenCode`, case-insensitive, optional) — overrides the plugin-wide **Default Agent** setting for this one button. Unrecognized or omitted values fall back to that setting.
- **`model`** (optional) — which model the agent uses for this run. Either the `name` of a model mapping configured in Settings for whichever agent this button resolves to (see [Model selection](#model-selection) below), or a literal model string passed straight through to the CLI's own `--model` flag. Omitted entirely, no `--model` flag is passed at all — the CLI falls back to its own default (env var, its own config, whatever it'd use if run bare from a terminal).
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

### Context and templating

`prompt:` isn't just a static string — it's a template rendered against a snapshot of the note the button lives in, taken at click time (`src/context.ts` / `src/templating.ts`). Two tiers:

**`{{ path.to.value }}` — plain lookups, always available.** Dot-path access into the context object below. An unknown *root* name (e.g. a typo like `{{flie.basename}}`) is left in the prompt untouched, so the mistake stays visible rather than silently vanishing; a missing value under a *known* root (e.g. no frontmatter, or a field that isn't set) renders as an empty string.

Available context:

| Path | Value |
| --- | --- |
| `file.path` | Vault-relative path of the note the button is in |
| `file.basename` | Filename without extension |
| `file.name` | Filename with extension |
| `file.folder` | Vault-relative path of the containing folder ("" at vault root) |
| `file.extension` | File extension without the dot |
| `file.frontmatter.<key>` | Any YAML frontmatter field |
| `file.tags` | All tags on the note (frontmatter `tags` + inline `#tags`, deduped) |
| `file.ctime` / `file.mtime` | Creation / modification time, ISO 8601 |
| `vault.name` | Vault's display name |
| `vault.basePath` | Vault's real filesystem path |
| `date.today` | Today's date, `YYYY-MM-DD` |
| `date.now` | Current timestamp, ISO 8601 |

**`{{= expression }}` — a small expression language, opt-in.** For anything a plain lookup can't express — conditionals, comparisons, string building — `{{= }}` evaluates a compact expression against the same context, with property access (`file.frontmatter.status`), string/number/boolean literals, `+ - * / %`, comparisons (`== != === !== < <= > >=`), `&& || !`, a ternary (`cond ? a : b`), and a small fixed set of helper functions: `join(arr, sep)`, `upper(s)`, `lower(s)`, `default(val, fallback)`, `includes(collection, item)`, `length(x)`. For example:

```
prompt: {{= file.frontmatter.status === "draft" ? "Finish drafting " + file.basename : "Review " + file.basename }}
```

This is deliberately **not** arbitrary JavaScript via `eval`/`new Function` — Obsidian's own community-plugin lint (`eslint-plugin-obsidianmd`) flags that pattern and its config marks the rule non-suppressible, a hard constraint for anything submitted to the community plugin directory, not a style preference. `src/expr.ts` is a small hand-written parser/interpreter instead: no assignment, no loops, no access to anything outside the context object, and a fixed, closed set of callable names — there's no code-execution surface to sandbox because there's no way to reach outside the grammar. It covers the realistic "compute part of a prompt from this note's metadata" use case without that risk.

Because it can run arbitrary-ish logic (however constrained) on every click, `{{= }}` is **off by default** — a button using it does nothing until **Allow JavaScript expressions in prompts** is turned on in Settings → Inline Agents. While off, a button whose prompt contains `{{= }}` writes a clear error to the terminal and doesn't run, rather than silently sending the literal `{{= ... }}` text to the agent.

### Model selection

Neither CLI is told which model to use unless a button's `model:` line resolves to one — with no `model:` line at all, a button behaves exactly as it always has (no `--model` flag passed, CLI picks its own default).

Settings → Inline Agents has a **Model mappings** list under each provider (Claude Code / OpenCode) — pairs of a short `name` (what you type after `model:` in a button) and the actual model string sent to `--model`. Click **+** to add a row, **✕** to remove one. Each row's model field is a free-text input with a **▾** dropdown next to it listing that provider's known models:

- **Claude Code** — no CLI command exists to list its models live, so this is a small curated list of the aliases/IDs `claude --model --help` documents (`sonnet`, `opus`, `fable`, `haiku`, and their full `claude-*` IDs). Type or paste any other model string directly if it's not in the list — the field never restricts you to what's in the dropdown.
- **OpenCode** — a live list from `opencode models`, which covers every provider OpenCode is currently configured for, including a local one (e.g. an Ollama config pointed at `http://host.docker.internal:11434/v1` from inside a container, or `http://localhost:11434/v1` on the same machine Ollama runs on — see [opencode.ai/docs/providers](https://opencode.ai/docs/providers/)). Refreshed automatically when Settings opens, or on demand via the ↻ button next to the provider's name.

Every option in the dropdown has its own copy button (⧉) — use it to grab the raw model string for pasting straight into a button's `model:` line without setting up a mapping at all.

Each provider's heading also shows a connection status dot (🟢/🔴), refreshed the same way as the model list — green means the configured binary actually runs (`<bin> --version` exits 0), red means it doesn't (not installed, wrong path, etc.). It's a binary-resolves check, not an auth/provider-reachability check — a red OpenCode dot with Ollama unreachable still shows as OpenCode itself being fine; run a button to see the actual provider error.

### How file output is captured

When `agentOutput: file` is set, the plugin renders the full xterm buffer to plain text once the run ends and strips out what it recognizes as its own scaffolding or CLI/TUI chrome — the `$ <binary> <args>` echo line, Claude Code's own prompt echo, the turn-completion summary line, the persistent bottom status bar, box-drawing-only lines, and (if the session was killed mid-run) the raw Python `KeyboardInterrupt` traceback that `pty.spawn` surfaces on `SIGINT`. What's left is written into the note as:

```
**Agent output** (<button text>, <timestamp>)

<captured content>
```

This captures the whole visible session transcript (tool-call summaries included, not just the agent's final reply) rather than attempting to isolate "the assistant's message" specifically — doing real semantic extraction of just the reply would need much deeper, CLI-specific knowledge of each agent's exact output format than is safe to assume here. It's good enough to drop into a note as a record of the run; it isn't a guarantee of a perfectly clean, chrome-free transcript in every case, especially for CLIs whose output this hasn't been tuned against.

Settings (gear icon → Inline Agents): the Default Agent used when a button does not specify `agent:`, each agent's binary path and connection status, each agent's model mappings (see [Model selection](#model-selection) above), the default auto-approve toggle, and whether `{{= }}` expressions in prompts are allowed to run (see [Context and templating](#context-and-templating) above).

## Known limitations (MVP)

- **PTY allocation uses `python3`, not `node-pty`.** First cut used BSD `script -q /dev/null`, which is broken *specifically when Obsidian spawns it* (`script: tcgetattr/ioctl: Operation not supported on socket` — Node's default piped stdio hands the child a socket-backed fd, and script's setup path can't `tcgetattr` that). Fixed by shelling out to `python3 -c "import pty,sys; pty.spawn(sys.argv[1:])"` instead, which does its own PTY allocation and doesn't have that dependency. Needs a `python3` at one of a few standard locations, or on `PATH` — true on basically any Mac or Linux environment.
- **Binary path resolution is best-effort.** `resolveBinary()` tries the configured setting, then a hardcoded candidate list of known install locations, then falls back to a bare command name for Node's own `PATH` lookup. It's been verified across a couple of real environments but isn't exhaustive — an unusual install location may still need to be set explicitly in Settings.
- **OpenCode's basic command shape is now verified live** (`opencode run [--auto] [--model <provider/model>] --dir <path> "<prompt>"`, against a real `opencode` CLI talking to a local Ollama provider — confirmed both listing models via `opencode models` and getting a real completion back through a button). The `responseEnd` completion heuristic and file-output chrome-stripping, however, are still tuned specifically against Claude Code's observed terminal output and remain unverified for OpenCode, which may use different completion markers, dialog phrasing, or none of the above — treat OpenCode runs with `completion: responseEnd` or `agentOutput: file` as a test until that's checked too.
- **`agentOutput: file` and `completion: responseEnd` are heuristic, not exact.** Both work by pattern-matching the rendered terminal screen against text Claude Code has actually been observed to print, not by any structured signal from the agent itself. A CLI update that changes its output formatting, or output that doesn't match the patterns this was tuned against, can cause a run to be misclassified (e.g. the spinner not clearing, or a stray line surviving into the captured file output).
- **Closing the note kills a `manual`-mode run.** Each button's process is tied to its block's lifetime; navigating away from the note (destroying that block) sends the child process `SIGINT`. There's no background-run registry that survives the view closing entirely — a run started under `completion: responseEnd` does outlive the button going idle, but not the note being closed.
- **No live terminal resize signal to the child.** The PTY is allocated via `python3`'s `pty.spawn()` rather than a native `node-pty` build, specifically to avoid Electron-ABI version-pinning headaches. The trade-off is `SIGWINCH`/`ioctl` resize forwarding — a long run in a pane you resize mid-flight may wrap oddly, but content still comes through correctly.
- **One button = one fixed workflow.** Each `agent-button` block has one hardcoded prompt; there's no dropdown/picker for choosing a workflow at click time. A real improvement here would be auto-detecting existing plain-text "Run `X.md`" instructions in a vault and turning them into buttons automatically — not yet built.
- **`{{= }}` expressions are regex-delimited, not brace-matched.** Both `{{= }}` and `{{ }}` are found with a non-greedy match up to the first `}}`, so an expression containing a literal `}}` (most plausibly a nested object/array literal) won't parse correctly. Realistic prompt-building — property access, comparisons, string concatenation, ternaries, the built-in helpers — doesn't hit this; it's a limitation of the templating layer around `src/expr.ts`, not the expression language itself.
- **`&&`, `||`, and `? :` in `{{= }}` always evaluate both sides**, unlike real JS short-circuiting. Harmless in practice — everything in the expression language is a pure, total function of its inputs (property access never throws, and the only callable functions are the fixed pure helpers), so there's no side effect an unused branch could produce — but worth knowing if you were expecting `a || expensiveLookup()` to skip `expensiveLookup()`.
- **Uses Node's `child_process` and `fs` directly.** This is what `isDesktopOnly: true` in manifest.json is declaring — the whole plugin exists to spawn a real CLI process (Claude Code / OpenCode) behind a PTY and locate the vault on disk to use as its working directory, so this isn't optional. Obsidian's own automated review flags direct filesystem/shell access as a Warning under BEHAVIOR — an accurate observation about this plugin's Node/Electron dependency, not a bug, and not something a desktop-only plugin like this one can avoid.
- **`src/runner.ts`'s Node API surface is asserted through local interfaces, not left as raw `@types/node` types.** Obsidian's community-review type-checker doesn't resolve Node's ambient declarations the way this repo's own `tsc`/eslint do — `process`, and the return values of `existsSync`/`spawn`, all come back typed `any` on their end, cascading into a wall of `@typescript-eslint/no-unsafe-*` findings even though `npm run lint` here was always clean. Moving `@types/node` into `dependencies` (tried first, on the theory their checker only installs `dependencies`) turned out not to be it — a preview scan of that exact commit still showed every warning. The fix that actually worked: every touchpoint in `runner.ts` now goes through `X as unknown as T` into a small hand-written interface describing just the shape this file uses. That assertion type-checks — and produces the same concrete, non-`any` type — no matter whether the underlying value resolves as `any`, a real Node signature, or anything else, so it closes the gap in both environments at once rather than guessing at which one is right.
- **The settings tab uses the older imperative `display()` API, not the declarative `getSettingDefinitions()` one.** The model-mapping list (dynamically added/removed rows, a custom dropdown with a per-option copy button, live connection-status dots) needs DOM control the declarative control types (dropdown/toggle/text) can't express. Trade-off: this tab no longer appears in Obsidian's own in-app settings search, which the declarative API opts into — see the docstring on `AgentConsoleSettingTab` in `src/settings.ts`.
- **Claude Code's model dropdown is a static, curated list, not a live one.** There's no `claude` CLI subcommand to enumerate available models the way `opencode models` does for OpenCode, so Settings ships a fixed list of the aliases/IDs `claude --model --help` documents (`sonnet`, `opus`, `fable`, `haiku`, plus their full `claude-*` IDs) — see `CLAUDE_MODEL_OPTIONS` in `src/settings.ts`. It'll drift as Anthropic ships new models; the field is always free-text, so any current model string can still be typed or pasted in regardless.
- **xterm.js's own CSS is vendored wholesale into `styles.css`.** A couple of its rules (underline-style `text-decoration` combinations, and an `!important` on `.xterm-dim` needed to override inline styles xterm.js sets at runtime — see the comment above it) trip Obsidian's CSS lint. Left as shipped by xterm.js rather than hand-edited, since changing vendored terminal-rendering CSS to satisfy a style-guide check risks breaking ANSI rendering for the sake of a cosmetic warning.

## Dev

```bash
npm install
npm run dev    # esbuild --watch, writes main.js on save
npm run build  # typecheck + production (minified) build
```

Source lives in `src/`; `main.js` is generated (gitignored) — see `esbuild.config.mjs`.
