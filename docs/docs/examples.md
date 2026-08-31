# Examples

Copy-pasteable `agent-button` blocks for common setups. Adjust `prompt:`, `agent:`, and `model:` to match your own vault and Settings.

## A sufficiency-check workflow, output written into the note

````markdown
```agent-button
text: Run Sufficiency Check
prompt: Run features/learning-artefacts/teacher-artefact-sufficiency-check.md on {{file.path}}
autoApprove: true
agent: ClaudeCode
agentOutput: file
append: belowButton
showTerminal: false
completion: responseEnd
```
````

## A prompt that branches on frontmatter status

Requires **Allow JavaScript expressions in prompts** turned on (see [Context and Templating](templating/overview.md)):

````markdown
```agent-button
text: Draft or review
prompt: {{= file.frontmatter.status === "draft" ? "Finish drafting " + file.basename : "Review " + file.basename }}
agent: ClaudeCode
```
````

## A fast local pass with a mapped Ollama model

Assumes an OpenCode `ollama` provider is configured (see [opencode.ai/docs/providers](https://opencode.ai/docs/providers/)) and a mapping named `local-fast` is set up in Settings pointing at it — see [Model Mappings](agents/model-mappings.md):

````markdown
```agent-button
text: Quick local summary
prompt: Summarize the open action items in {{file.path}} as a short bulleted list.
agent: OpenCode
model: local-fast
showTerminal: true
completion: manual
```
````

## A literal model string, no mapping configured

Useful for a one-off test before you've set up a mapping — pastes straight from a dropdown's copy button:

````markdown
```agent-button
text: Try a specific model
prompt: Summarize {{file.basename}}.
agent: OpenCode
model: ollama/qwen3.8:27b-mlx
showTerminal: true
completion: manual
```
````

## An auto-approved background run, result appended to the note

````markdown
```agent-button
text: File a follow-up (background)
prompt: Check {{file.path}} for anything marked TODO and list them.
agent: ClaudeCode
autoApprove: true
agentOutput: file
append: belowButton
showTerminal: false
completion: responseEnd
```
````

Result, once the underlying session eventually closes:

![Agent output written into the note](assets/agent-output-file.png)

## Multiple buttons, different agents, on the same note

Nothing stops different buttons on the same note from routing to different agents or models — a fast pass and a thorough pass side by side:

````markdown
```agent-button
text: Draft this week's report
prompt: Draft a weekly report for {{file.basename}}, using the notes tagged #weekly-log from the last 7 days.
agent: ClaudeCode
model: myMainModel
showTerminal: true
completion: manual
```

```agent-button
text: Summarize with OpenCode
prompt: Summarize the open action items in {{file.path}} as a short bulleted list.
agent: OpenCode
showTerminal: true
completion: manual
```
````

![Multiple buttons in one note, idle](assets/buttons-idle.png)
