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
| `target` | `terminal` / a configured agent runtime's name | settings' **Default target** | Where the click goes. `terminal` (or an unrecognised name) runs in the inline terminal as before; a runtime's name hands the prompt off over HTTP instead — see [Agent Runtimes](../agents/runtimes.md). |
| `open` | `true` / `false` | settings' default for `open` | Runtime targets only: whether the thread opens automatically once the hand-off settles. |
| `agentId` | any string | the runtime's own configured agent/model | Runtime targets only: overrides the runtime's agent id or model for this one button. |
| `input` | any text / `false`, `no`, `off`, `0` (off) | none (no field) | Makes the button ask for text before it runs: a click opens a text field with this text as its placeholder, and what you submit becomes part of the prompt. A bare `input:` uses the placeholder "Type here". Only the first colon splits the line, so a colon inside the placeholder is fine. See [`input`](#input) below. |

Example of a runtime target:

````markdown
```agent-button
text: Run weekly review
prompt: Run the weekly review on {{file.path}}
target: openclaw
open: true
agentId: main
```
````

## `{{this file}}` template

`{{file.path}}` in the example above is replaced with the vault-relative path of the note the button lives in — resolved from the code block's own source note (`ctx.sourcePath`), not whichever pane happens to be focused, so it's correct even with split panes. It's one of many available lookups; see [Context and Templating](../templating/overview.md) for the full list.

## `agentOutput: terminal` vs `file`

- `terminal` — output stays in the live terminal accordion. Nothing is written to the note.
- `file` — once the run finishes, the captured output is written into the note itself. The terminal accordion is still available while the run is live (subject to `showTerminal`); it's only the *destination* of the final result that changes. See [Captured File Output](file-output.md).

## `append` positions (only with `agentOutput: file`)

- `bottom` — appended to the end of the note.
- `top` — inserted after the frontmatter block (if any), otherwise at the very top of the note.
- `belowButton` — inserted directly below the `agent-button` code block that triggered the run. The block's position is snapshotted at click time; if the note has changed shape by the time the run finishes (edited, block moved), the plugin sanity-checks that snapshot against the note's current content and falls back to `bottom` rather than risk inserting into the middle of an unrelated paragraph.

## `input`

`input: <placeholder>` makes a button ask for text first. Clicking an idle button replaces it, in place, with a focused text field showing the placeholder, plus **Submit** and **Cancel**:

````markdown
```agent-button
text: Draft a reply
prompt: Draft a reply to this note that says: {{ input }}
input: What should the reply say?
```
````

It is one text field only, nothing more. A bare `input:` shows the placeholder "Type here", and a colon inside the placeholder is fine (`input: Ticket: name or id`). `input: false`, `no`, `off` or `0` (any case) turns it off, the same as leaving the line out.

- **Nothing runs until Submit.** Enter submits and Shift+Enter adds a newline. Esc or **Cancel** restores the button and discards the text. Clicking elsewhere leaves the field open.
- **Empty text cannot be submitted.** With empty or whitespace-only text, Submit is disabled and Enter does nothing. Leading and trailing blanks and newlines in what you type or paste are trimmed; the inside is sent unchanged.
- **The field opens empty every time.** Opening a second `input:` button's field closes the first.
- **Long or multi-line text** is sent unchanged, and the field scrolls rather than growing the note.
- **Closing the note, or changing the block's content, while the field is open** drops the field and runs nothing.

### The `{{ input }}` token

Put `{{ input }}` in the `prompt` to say where the typed text goes. It is exactly that token, with optional spaces inside the braces. Every occurrence is replaced with the same text. `{{ input.x }}` and typos are left untouched, like any unknown name in a `{{ }}` lookup.

With no `{{ input }}` token in the prompt, the typed text is appended after one newline (trailing newlines on the prompt are trimmed first).

The typed text is inserted after the prompt has been rendered, and is never rendered or evaluated itself. Typed `{{ file.path }}` or `{{= 1+1 }}` reaches the agent as exactly those characters, and a typed `{{ input }}` is not substituted again. Typed `$&`, `$1` and `$'` arrive unchanged too.

### Where the text goes

- **Terminal or runtime:** the same composed prompt goes to either. The target and the prompt are resolved when you submit, not when you click.
- **Runtime unavailable at submit:** you get the existing notice, then the run falls back to the inline terminal carrying the same typed text.
- **`agentOutput: file`:** the typed text's lines are filtered out of the written output, the same way the prompt echo is. The rest of the output is unchanged.
- **`completion: responseEnd`:** after the reply, while the session is still alive, a click reopens the live terminal, as it does for any button. The field returns once the session ends.
- **While a run is live,** including a run waiting on your answer and a hand-off still being sent, a click behaves as it does for any button, and no field shows.

### What the plugin keeps

The plugin keeps no copy of the typed text of its own: not in the note and not in `data.json`. The `input:` line holds only the placeholder. Terminal scrollback, a runtime's thread and the agent's own history keep what they always kept for anything sent to them.
