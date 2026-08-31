# FAQ and Troubleshooting

## A provider's status dot is red

The configured binary doesn't resolve or doesn't run (`<bin> --version` failed). Check:

- Is the CLI actually installed? A red dot most commonly just means it isn't.
- Is the **binary path** in Settings correct, or is it a bare command name that isn't on the `PATH` Obsidian sees? GUI apps on macOS don't always inherit your shell's `PATH` — see [Claude Code and OpenCode](agents/overview.md#how-the-binary-is-located).
- The dot only checks that the binary *runs* — it doesn't check login/auth. A green dot with a failing button usually means an auth problem, not a plugin problem; check the CLI's own login state directly (e.g. `claude doctor`).

## Claude Code fails with "`--dangerously-skip-permissions` cannot be used with root/sudo privileges"

Claude Code's own CLI refuses that flag when the process runs as `root` — this happens if Obsidian itself is running as root (common in some container setups). It's a Claude Code safety restriction, not something the plugin can route around. Either run Obsidian as a non-root user, or turn off auto-approve for that button and approve tool calls manually in the terminal.

## A button's `model:` value doesn't seem to do anything

Check that the mapping `name` you typed matches one configured under the **agent that button actually resolves to** — mappings are scoped per provider, so a Claude Code mapping named `quick` isn't visible to a button using `agent: OpenCode`. If nothing matches, the value is passed straight through as a literal model string, which most CLIs reject as unknown if it isn't a real model ID — see [Model Mappings](agents/model-mappings.md).

## A `{{= }}` expression does nothing / errors

`{{= }}` expressions are off by default. Turn on **Allow JavaScript expressions in prompts** in Settings — see [Context and Templating](templating/overview.md). While off, a button whose prompt contains `{{= }}` writes a clear error to the terminal instead of running.

## A `{{ }}` lookup shows up literally in the sent prompt instead of being replaced

That means the *root* name wasn't recognized (a typo like `{{flie.basename}}`) — this is deliberate, so the mistake stays visible rather than silently vanishing. Check the spelling against the [Context Reference](templating/context-reference.md). A *missing* value under a real root (e.g. no frontmatter `status` field) renders as an empty string instead, which looks different from this case.

## The plugin needs `python3` — is that a problem?

The terminal is allocated via `python3 -c "import pty,sys; pty.spawn(sys.argv[1:])"` rather than a native `node-pty` build, specifically to avoid needing a fresh native prebuild every time Obsidian's bundled Electron version changes. This needs a `python3` at one of a few standard locations, or on `PATH` — true on basically any Mac or Linux environment already. If it's genuinely missing, install Python 3 for your OS and it'll be picked up.

An earlier attempt used BSD `script -q /dev/null`, which is broken *specifically when Obsidian spawns it* (`script: tcgetattr/ioctl: Operation not supported on socket`) — this is why `python3` is used instead, not `script`.

## Other things worth knowing

- **Binary path resolution is best-effort**, not exhaustive — an unusual install location may need to be set explicitly in Settings.
- **`agentOutput: file` and `completion: responseEnd` are both heuristic**, pattern-matching the rendered terminal against text Claude Code has been observed to print — a CLI update or unusual output can occasionally misclassify a run. See [Completion Modes](reference/completion-modes.md) and [Captured File Output](reference/file-output.md).
- **Closing the note kills a `manual`-mode run.** Each button's process is tied to its block's lifetime — navigating away sends the child process `SIGINT`. A `responseEnd` run does outlive the button going idle, but not the note being closed.
- **No live terminal resize signal to the child** — a long run in a pane you resize mid-flight may wrap oddly, but content still comes through correctly.
- **One button = one fixed workflow.** There's no dropdown/picker for choosing a prompt at click time; each block is one hardcoded (templated) prompt.

## Still stuck?

Open an issue on [GitHub](https://github.com/danrfletcher/obsidian-inline-agents/issues) with what you tried and what happened.
