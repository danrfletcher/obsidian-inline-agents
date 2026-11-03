# Changelog

The full, authoritative changelog is the project's [GitHub Releases page](https://github.com/danrfletcher/obsidian-inline-agents/releases) — every release ships `main.js`, `manifest.json`, and `styles.css` as downloadable assets alongside its notes.

## Highlights

### Unreleased

- A button can now ask for text before it runs. Add an `input:` line and a click turns the button into a text field; what you submit becomes part of the prompt, in the new `{{ input }}` token's place (or on a new line after the prompt if it has none). The text goes unchanged to the terminal or an HTTP runtime. See [`input`](reference/fields.md#input).

### 0.3.2

- New per-runtime toggle **Send session id as `X-Hermes-Session-Id`** (OpenAI-compatible chat kind only, default off). When on, the plugin sends a colon-free session id in that header and as the request's `user` field.
- New `{sessionId}` placeholder for the Thread-URL template, filled for both runtime kinds.
- A Hermes runtime can now open its desktop chat: set the toggle on and the template to `hermes://open/{sessionId}`. Settings warns when a template uses `{sessionId}` without the toggle, and a 403 shows a hint about `API_SERVER_KEY`.
- Docs fix: the note saying Hermes could not open its chat from a link is replaced with the working setup. The real-app checks (opening the chat, the display of a running turn, a link after Hermes compresses a chat) are still to be run.

### 0.3.1

- Shorter plugin description in `manifest.json` (230 characters), to fit the community store's 250-character limit. No code changes.

### 0.3.0

- Buttons can now send their prompt to an **HTTP agent runtime** instead of the inline terminal — `target: <name>` hands off to a configured runtime (an OpenClaw hook, or any OpenAI-compatible chat endpoint, e.g. Hermes Agent) and opens the resulting thread. New `open:` and `agentId:` button fields, a new **Agent runtimes** section in Settings (name, kind, base URL, token, agent/model, thread-URL template, "Test connection"), and a per-device token stored in Obsidian's own secret storage, never in `data.json`. See [Agent Runtimes](agents/runtimes.md).

### 0.2.1

- Fixed a TDZ (temporal dead zone) crash in `runCommand()` that permanently blocked OpenCode's model refresh.

### 0.2.0

- `prompt:` templates: `{{ path.to.value }}` context lookups (file, vault, date) and an opt-in `{{= expression }}` mini expression language, replacing the old single `{{this file}}` placeholder. See [Context and Templating](templating/overview.md).

### 0.1.5

- Per-provider **Model mappings** in Settings — a `model:` field on `agent-button` blocks, a live model dropdown for OpenCode, a curated static list for Claude Code, and a green/red connection-status dot per provider. See [Model Mappings](agents/model-mappings.md).

### 0.1.4

- `agent-button` blocks can set `agent: ClaudeCode` / `agent: OpenCode` to override the plugin-wide default per button. The plugin-wide setting was relabeled **Default Agent** for clarity.

### 0.1.0 – 0.1.3

- Initial release: the `agent-button` code block, live PTY-backed terminal, `completion: manual` / `responseEnd`, `agentOutput: file` capture, and the settings tab.

See each release's own notes on GitHub for the full detail behind these.
