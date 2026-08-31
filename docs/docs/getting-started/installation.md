# Installation

Inline Agents is a **desktop-only** plugin — it spawns a real CLI process (Claude Code or OpenCode) behind a PTY and needs to locate your vault on disk, neither of which is possible in Obsidian Mobile. `isDesktopOnly: true` in `manifest.json` reflects this.

## Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/danrfletcher/obsidian-inline-agents/releases/latest).
2. Create a folder named `inline-agents` inside your vault's `.obsidian/plugins/` directory.
3. Place the three downloaded files inside it.
4. Reload Obsidian (or use **Settings → Community plugins → Reload plugins**).
5. Enable **Inline Agents** under **Settings → Community plugins**.

## BRAT (Beta Reviewers Auto-update Tool)

If you use [BRAT](https://github.com/TfTHacker/obsidian42-brat) to track plugins directly from GitHub:

1. Install BRAT from the Community Plugins browser if you haven't already.
2. Run the **BRAT: Add a beta plugin for testing** command.
3. Paste `danrfletcher/obsidian-inline-agents`.
4. BRAT installs it and will offer updates as new releases ship.

## Requirements

- **A `claude` and/or `opencode` CLI binary installed somewhere on the machine.** The plugin doesn't bundle either — it shells out to whichever you already have. See [Agents and Models](../agents/overview.md) for how the plugin locates the binary, and each CLI's own docs ([Claude Code](https://code.claude.com/docs/en/setup), [OpenCode](https://opencode.ai/docs/)) for installing it in the first place.
- **`python3`** on `PATH` (or at one of a few standard locations) — used to allocate a real PTY for the terminal. True on basically any Mac or Linux environment already.

## Next

Once it's enabled, head to [Your First Button](first-button.md) to build one from scratch.
