# Model Mappings

Neither CLI is told which model to use unless a button's `model:` line resolves to one — with no `model:` line at all, a button behaves exactly as it always has: no `--model` flag passed, the CLI picks its own default.

## Setting up a mapping

Settings → Inline Agents has a **Model mappings** list under each provider (Claude Code / OpenCode) — pairs of a short `name` (what you type after `model:` in a button) and the actual model string sent to `--model`. Click **+** to add a row, **✕** to remove one.

Each row's model field is a free-text input with a **▾** dropdown next to it listing that provider's known models:

- **Claude Code** — no CLI command exists to list its models live, so this is a small curated list of the aliases/IDs `claude --model --help` documents (`sonnet`, `opus`, `fable`, `haiku`, and their full `claude-*` IDs). Type or paste any other model string directly if it's not in the list — the field never restricts you to what's in the dropdown.

    ![Claude Code model mappings, with the "quick" -> "sonnet" mapping configured](../assets/settings-claude-models.png)

- **OpenCode** — a live list from `opencode models`, which covers every provider OpenCode is currently configured for, including a local one (e.g. an Ollama config pointed at `http://host.docker.internal:11434/v1` from inside a container, or `http://localhost:11434/v1` on the same machine Ollama runs on — see [opencode.ai/docs/providers](https://opencode.ai/docs/providers/)). Refreshed automatically when Settings opens, or on demand via the ↻ button next to the provider's name.

    ![OpenCode's live model dropdown, showing local Ollama models with a copy button](../assets/settings-opencode-models.png)

Every option in the dropdown has its own copy button (⧉) — use it to grab the raw model string for pasting straight into a button's `model:` line without setting up a mapping at all.

## How `model:` resolves

A button's `model:` value is resolved in this order:

1. The `name` of a mapping configured in Settings for whichever agent this button ends up using (case-insensitive — `myMainModel` and `mymainmodel` both hit the same row).
2. Failing that, the value is passed straight through as a literal model string — this is what lets you paste a raw model ID via a dropdown's copy button without configuring a mapping first.

If the key is omitted entirely, no `--model` flag is passed at all.

!!! note "Mappings are scoped per provider"
    A mapping named `quick` under Claude Code and a button using `agent: OpenCode` with `model: quick` won't see each other — mapping names are looked up only against the agent the button actually resolves to.

## Next

See [Claude Code and OpenCode](overview.md) for how the agent itself is chosen.
