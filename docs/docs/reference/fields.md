# All Fields

The full `agent-button` shape:

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

It's deliberately a plain `key: value`-per-line block rather than an inline shortcode syntax — it's what Obsidian's own code-block processor is built for (works identically in Reading view and Live Preview), and it's the same shape the "Buttons" community plugin uses.

Every field except `text` and `prompt` is optional and falls back to a sensible default.

| Field | Values | Default | |
|---|---|---|---|
| `text` | any string | — | The button label. |
| `prompt` | any string | — | What gets sent to the agent as its first message. Supports `{{ }}` lookups and `{{= }}` expressions — see [Context and Templating](../templating/overview.md). |
| `autoApprove` | `true` / `false` | plugin's **Auto-approve by default** setting | Overrides the plugin-wide setting for this one button. When on, the agent runs with permission checks bypassed (`claude --dangerously-skip-permissions` / `opencode run --auto`). When off, it asks before each tool use, right there in the terminal. |
| `agent` | `ClaudeCode` / `OpenCode` (case-insensitive) | plugin's **Default Agent** setting | Overrides the plugin-wide agent choice for this one button. Unrecognized or omitted values fall back to the setting. See [Agents and Models](../agents/overview.md). |
| `model` | a mapping name, or a literal model string | none (`--model` omitted) | Which model the agent uses. See [Model Mappings](../agents/model-mappings.md). |
| `agentOutput` | `terminal` / `file` | `terminal` | Where the agent's output ends up — see [Captured File Output](file-output.md). |
| `append` | `top` / `bottom` / `belowButton` | `bottom` | Where the captured output gets inserted (only meaningful when `agentOutput: file`). |
| `showTerminal` | `true` / `false` | `true` | Whether the terminal accordion opens automatically on click. |
| `completion` | `manual` / `responseEnd` | `manual` | How the button's loading state resolves — see [Completion Modes](completion-modes.md). |

## `{{this file}}` template

`{{file.path}}` in the example above is replaced with the vault-relative path of the note the button lives in — resolved from the code block's own source note (`ctx.sourcePath`), not whichever pane happens to be focused, so it's correct even with split panes. It's one of many available lookups; see [Context and Templating](../templating/overview.md) for the full list.

## `agentOutput: terminal` vs `file`

- `terminal` — output stays in the live terminal accordion. Nothing is written to the note.
- `file` — once the run finishes, the captured output is written into the note itself. The terminal accordion is still available while the run is live (subject to `showTerminal`); it's only the *destination* of the final result that changes. See [Captured File Output](file-output.md).

## `append` positions (only with `agentOutput: file`)

- `bottom` — appended to the end of the note.
- `top` — inserted after the frontmatter block (if any), otherwise at the very top of the note.
- `belowButton` — inserted directly below the `agent-button` code block that triggered the run. The block's position is snapshotted at click time; if the note has changed shape by the time the run finishes (edited, block moved), the plugin sanity-checks that snapshot against the note's current content and falls back to `bottom` rather than risk inserting into the middle of an unrelated paragraph.
