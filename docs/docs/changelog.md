# Changelog

The full, authoritative changelog is the project's [GitHub Releases page](https://github.com/danrfletcher/obsidian-inline-agents/releases) — every release ships `main.js`, `manifest.json`, and `styles.css` as downloadable assets alongside its notes.

## Highlights

### 0.2.0

- `prompt:` templates: `{{ path.to.value }}` context lookups (file, vault, date) and an opt-in `{{= expression }}` mini expression language, replacing the old single `{{this file}}` placeholder. See [Context and Templating](templating/overview.md).

### 0.1.5

- Per-provider **Model mappings** in Settings — a `model:` field on `agent-button` blocks, a live model dropdown for OpenCode, a curated static list for Claude Code, and a green/red connection-status dot per provider. See [Model Mappings](agents/model-mappings.md).

### 0.1.4

- `agent-button` blocks can set `agent: ClaudeCode` / `agent: OpenCode` to override the plugin-wide default per button. The plugin-wide setting was relabeled **Default Agent** for clarity.

### 0.1.0 – 0.1.3

- Initial release: the `agent-button` code block, live PTY-backed terminal, `completion: manual` / `responseEnd`, `agentOutput: file` capture, and the settings tab.

See each release's own notes on GitHub for the full detail behind these.
