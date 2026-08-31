# Captured File Output

When `agentOutput: file` is set, the plugin renders the full terminal buffer to plain text once the run ends and strips out what it recognizes as its own scaffolding or CLI/TUI chrome — the `$ <binary> <args>` echo line, the CLI's own prompt echo, the turn-completion summary line, the persistent bottom status bar, box-drawing-only lines, and (if the session was killed mid-run) the raw Python `KeyboardInterrupt` traceback that PTY allocation surfaces on `SIGINT`.

What's left is written into the note as:

```markdown
**Agent output** (<button text>, <timestamp>)

<captured content>
```

Real example — a button with `agentOutput: file` and `append: belowButton`, after the session behind it exited:

![Agent output written into the note](../assets/agent-output-file.png)

## What gets captured

This captures the whole visible session transcript (tool-call summaries included, not just the agent's final reply) rather than attempting to isolate "the assistant's message" specifically — doing real semantic extraction of just the reply would need much deeper, CLI-specific knowledge of each agent's exact output format than is safe to assume here.

It's good enough to drop into a note as a record of the run; it isn't a guarantee of a perfectly clean, chrome-free transcript in every case, especially for CLIs whose output this hasn't been tuned against.

!!! warning "Heuristic, not exact"
    Both this and [`completion: responseEnd`](completion-modes.md#responseend) work by pattern-matching the rendered terminal screen against text Claude Code has actually been observed to print, not by any structured signal from the agent itself. A CLI update that changes its output formatting, or output that doesn't match the patterns this was tuned against, can cause a stray line to survive into the captured output.

## When the write actually happens

The write is triggered by the underlying process **exiting**, not by the agent finishing its reply. Under `completion: manual` those two things are close together (the session stays in its loading state until you close it, which is also when it exits). Under `completion: responseEnd` they can be far apart — the spinner clears when the agent finishes replying, but the session (and therefore the eventual file write) doesn't end until the session is later closed some other way.
