# Agent Runtimes

A button doesn't have to run in the inline terminal. `target: <name>` hands its rendered prompt off to an **agent runtime** — a named HTTP endpoint configured in Settings — so the work runs as an agent thread on that runtime and keeps going (for the OpenClaw hook kind) when the note, or Obsidian itself, is closed.

This is a second *target* for a button, not a replacement for the terminal: `target: terminal` (or no `target:` line at all) behaves exactly as it always has. See [All Fields](../reference/fields.md) for `target:`, `open:` and `agentId:`.

## Terminal or runtime?

| | Inline terminal (`target: terminal`) | Agent runtime (`target: <name>`) |
|---|---|---|
| Where the agent runs | Claude Code or OpenCode, spawned on this machine under the note | An agent you already run elsewhere (OpenClaw, Hermes Agent, another OpenAI-compatible server) |
| What you see in Obsidian | A live terminal, run state, optional output written into the note | A "Sent to `<name>`" button, optionally a link to the thread. Nothing streams back |
| Where you read the reply | In the note | On the runtime (its app, chat or dashboard) |
| Survives closing Obsidian | No | OpenClaw hook: yes. OpenAI-compatible chat: no |
| Setup | Install the CLI | Turn on the runtime's HTTP endpoint, then add it under **Agent runtimes** |

Use a runtime when the work belongs with an agent that has its own memory, tools and channels, and you only want the note to kick it off.

## Quick start

1. Turn on the runtime's HTTP endpoint (see [OpenClaw hook](#openclaw-hook) or [OpenAI-compatible chat](#openai-compatible-chat-hermes-agent-etc) below).
2. Settings → Inline Agents → **Agent runtimes** → add a runtime. Give it a short **Name**, since that's what buttons type.
3. In the **Token** field, pick or create a secret holding the token, then click **Test connection**.
4. Add `target: <name>` to a button:

````markdown
```agent-button
text: Hand this note to Hermes
prompt: Summarise {{file.path}} and list the open actions.
target: hermes
```
````

5. Click it. The button shows "Sending to hermes…", then "Sent to hermes". Read the reply on the runtime.

## The two runtime kinds

| Kind | Setting value | Covers | Request |
|---|---|---|---|
| OpenClaw hook | `OpenClaw hook` | OpenClaw's inbound hook | `POST <base>/hooks/agent`, asynchronous, survives Obsidian closing |
| OpenAI-compatible chat | `OpenAI-compatible chat` | Hermes Agent, and most other OpenAI-compatible chat servers | `POST <base>/chat/completions`, a normal user turn, runs only while Obsidian stays open |

### OpenClaw hook

An OpenClaw instance has an inbound hook that starts (or continues) an agent session asynchronously — the run keeps going on OpenClaw's side whether or not Obsidian is still open to see it.

Example: OpenClaw is running at `http://127.0.0.1:18789`.

1. In Settings → Inline Agents → **Agent runtimes**, add a runtime: name `openclaw`, kind **OpenClaw hook**, base URL `http://127.0.0.1:18789`, agent ID `main`, and the hook's token (e.g. `<your-hook-token>`). The **Token** field is Obsidian's secret picker: choose an existing secret, or create a new one named for this runtime and paste the value OpenClaw gave you. The value stays in this device's secret storage and is never synced; it is sent only to this runtime, as the bearer token.
2. OpenClaw itself must have these enabled before the hook will accept a request:
    - `hooks.enabled`
    - `allowRequestSessionKey: true`
    - `allowedSessionKeyPrefixes: ["inline:"]` (every session key this plugin sends starts with `inline:` — see [Session keys](#session-keys-and-thread-urls) below)
3. A button with `target: openclaw` now sends its prompt to that hook instead of running in the terminal.

OpenClaw treats the hook's text as **untrusted external content**, the same as any other inbound message — it does not implicitly trust it just because it came from this plugin. The request's message is prefixed with one line making clear it's an instruction from the vault owner, sent by their Inline Agents button, to reduce the chance OpenClaw summarizes it instead of carrying it out — but OpenClaw's own trust/approval policy still applies.

The run is asynchronous: once OpenClaw accepts the hook (`{ ok: true, runId }`), the agent keeps working there regardless of whether the note or Obsidian stays open. Closing the note doesn't stop it, and clicking the button again later starts an independent second thread.

### OpenAI-compatible chat (Hermes Agent, etc.)

Any server exposing an OpenAI-compatible `chat/completions` endpoint — Hermes Agent's API server is the shipped example — can be configured as this kind.

#### Example: Hermes Agent

Hermes Agent ships an OpenAI-compatible [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server), off by default. It runs inside the Hermes gateway.

1. **Turn the API server on.** Add two lines to `~/.hermes/.env` (generate the key with `openssl rand -hex 32`):

    ```bash
    API_SERVER_ENABLED=true
    API_SERVER_KEY=<your-generated-key>
    ```

2. **Restart the gateway** with `hermes gateway restart` (or start it with `hermes gateway`). Its log should show `API server listening on http://127.0.0.1:8642`. Check it from a terminal:

    ```bash
    curl -s -H "Authorization: Bearer <your-generated-key>" http://127.0.0.1:8642/v1/models
    ```

3. **Add the runtime.** Settings → Inline Agents → **Agent runtimes** → add:

    | Field | Value |
    |---|---|
    | Name | `hermes` |
    | Kind | **OpenAI-compatible chat** |
    | Base URL | `http://127.0.0.1:8642/v1` |
    | Agent ID or model | `hermes-agent` |
    | Token required | on |
    | Token | the `API_SERVER_KEY` value |
    | Send session key as `x-openclaw-session-key` | off (that header is for OpenClaw) |
    | Thread-URL template | leave blank (see [Hermes has no thread link yet](#hermes-has-no-thread-link-yet)) |

4. Click **Test connection**. It calls `GET /models`, so a wrong key shows up here rather than on the first click.

5. A button with `target: hermes` now sends its prompt as a normal user turn (`POST <base>/chat/completions`, one `user`-role message). Nothing is prefixed onto it the way the OpenClaw hook kind's instruction line is. The turn runs on the Hermes profile whose gateway hosts the API server, with that profile's tools, memory and skills. Read the reply on the Hermes side.

The same steps work for any other OpenAI-compatible server: point **Base URL** at its `/v1` root and set **Agent ID or model** to a model name it accepts.

Unlike the OpenClaw hook, this run **lasts only while Obsidian stays open** — there's no separate asynchronous session on the runtime's side; the request itself is the run, and a dropped connection (including Obsidian closing) cancels it. See [Fire-and-forget](#fire-and-forget-and-what-is-not-tracked) below.

## Agent runtimes settings

Settings → Inline Agents → **Agent runtimes**:

| Setting | | |
|---|---|---|
| **Name** | text, unique | What a button's `target:` line matches against, case-insensitive. |
| **Kind** | dropdown | `OpenClaw hook` or `OpenAI-compatible chat`. |
| **Base URL** | text | The runtime's http(s) base URL, e.g. `http://127.0.0.1:18789`. No embedded credentials or query string. |
| **Agent ID or model** | text | The OpenClaw agent id, or the chat kind's `model`. A button's `agentId:` line overrides this for that one button. |
| **Token required** | toggle, default on | When on, a click is blocked with a notice ("token not set on this device") if no token is stored on this device, and the thread never reaches the runtime. |
| **Send session key as `x-openclaw-session-key`** | toggle, default off (chat kind only) | Turn on when the chat endpoint is itself OpenClaw's, so it can see the same session key as the hook kind does. |
| **Token** | secret picker | Choose or create a named secret in Obsidian's own per-device secret storage — only the secret's name is saved in `data.json`, never the value. See [Where the token lives](#where-the-token-lives) below. |
| **Thread-URL template** | text, optional | Builds the link the "Sent to `<name>` ↗" button opens — see [Thread-URL templates](#thread-url-templates) below. |
| **Test connection** | button | Checks reachability and the token, without sending a prompt — see [Test connection](#test-connection) below. |

Also on this screen:

- **Default target** — a dropdown of `Terminal` plus every configured runtime name. This is what a button without a `target:` line uses, and what an unknown `target:` name falls back to.
- The toggle next to it — the default for a button's `open:` line when it's missing or malformed. On by default.

Two runtimes can't share a name — the settings tab refuses to save a duplicate.

A new runtime is only a draft until it has a valid name and base URL: nothing is written to your settings before that, and a draft you leave unfinished is dropped when you close the settings tab. Renaming the runtime that is the **Default target** keeps it as the Default target under its new name.

## `target:`, `open:` and `agentId:` on a button

````markdown
```agent-button
text: Run weekly review
prompt: Run the weekly review on {{file.path}}
target: openclaw
```
````

- **`target`** — `terminal` (the default) or the name of a configured runtime, case-insensitive. A name that doesn't match any configured runtime shows a notice and falls back to the **Default target** setting.
- **`open`** — `true`/`false`. Defaults to the settings-wide default when the line is missing or malformed. Only matters for a runtime target: with `open: true`, the thread opens as soon as the hand-off settles.
- **`agentId`** — overrides the runtime's configured agent/model for this one button only.

## What happens on click

1. The button shows "Sending to `<name>`…" and ignores further clicks until this hand-off settles — but the *next* click, once it has settled, starts an independent new thread (there's no "one run at a time" rule for a runtime target).
2. The plugin picks a session key up front (see below), so it's known before the request goes out.
3. Once settled, the button shows "Sent to `<name>` ↗" (a link to the thread, if the runtime has a thread-URL template) or plain "Sent to `<name>`" (no template configured). With `open` on, the thread opens at once.
4. Every click starts a brand-new thread — there's no concept of "the same session as last time."

### Fire-and-forget, and what is not tracked

A runtime target is deliberately fire-and-forget:

- No reply is streamed back into the note or the button.
- No run state — the button doesn't track whether the agent is still working, waiting on input, or done.
- No file output — `agentOutput: file` has nothing to write, because there's no captured output to write.
- Reading the reply, continuing the thread, and any approvals all happen **on the runtime itself**, not in Obsidian.

Because of this, these button fields are **ignored** for a runtime target, with a one-line notice naming whichever ones this particular button set: `model`, `autoApprove`, `agentOutput`, `completion`, `showTerminal`.

!!! warning "Obsidian closing cancels an OpenAI-compatible chat run"
    The OpenAI-compatible chat kind's run lasts only as long as the request is in flight — closing Obsidian (or the note) mid-request drops the connection and cancels the run on the runtime's side. This is documented behaviour, not something the plugin handles or works around. The OpenClaw hook kind has no such limit: once accepted, it survives Obsidian closing.

## Session keys and thread URLs

Before sending, the plugin picks a **session key**: `inline:<note basename, URL-safe>:<epoch ms>` — the note's basename lowercased, anything outside `a-z 0-9 - _` replaced with `-`, capped at 40 characters, then the timestamp. This is why `allowedSessionKeyPrefixes: ["inline:"]` is what OpenClaw needs to allow.

### Thread-URL templates

An optional per-runtime template that builds the link the "Sent to `<name>` ↗" button opens, using:

| Placeholder | Fills in |
|---|---|
| `{agentId}` | The agent ID/model actually used for this click (the button's `agentId:` override, or the runtime's configured one), URI-encoded so a `/`, `?` or `#` in it can't change the URL's shape. |
| `{sessionKey}` | The full session key, e.g. `inline:weekly-review:1760000000000`. |
| `{sessionKeyPath}` | The session key split on `:` into path segments and rejoined with `/` — `inline/weekly-review/1760000000000`. |

The template can use `http`, `https`, or any custom URL scheme a runtime's own app registers — the plugin doesn't know any particular runtime's scheme, so anything is accepted except four schemes that are never safe to open automatically: **`file`**, **`javascript`**, **`data`**, **`vbscript`**. A template using one of those is rejected at settings-save time, and checked again defensively right before a thread would open.

With no thread-URL template at all, there's nothing to open — the click is fire-and-forget, the button just shows "Sent to `<name>`" with no link, and (with `open: true`) a one-time-per-runtime-per-session notice says no thread URL is set.

Opening a thread uses the operating system's own URL handler, the same way a link in any other app would — an `http(s)` URL opens in your default browser; a custom scheme opens whatever app registered it.

### Hermes has no thread link yet

Leave the Thread-URL template blank for a Hermes runtime. The Hermes desktop app can open a chat by link, but none of the placeholders above give it the right chat:

- Hermes picks its own id for the chat a button starts, and the plugin doesn't learn it. `{sessionKey}` is the plugin's own key, and the chat kind only sends it as `x-openclaw-session-key`, which Hermes ignores.
- The plugin's session keys contain `:`, which Hermes' in-app links reject.

Until that changes, a Hermes button shows "Sent to hermes" with no link, and you find the chat in Hermes yourself.

## Test connection

Each runtime has its own **Test connection** button — it checks reachability and the token *without* sending a prompt, using the token stored under the secret name this runtime is set to (there's no separate unsaved token — pick or create the secret first). For the OpenAI-compatible chat kind this calls the standard `GET /models` endpoint, which actually validates the token; the OpenClaw hook kind has no safe, non-prompt endpoint to check against, so this only confirms the base URL is reachable (the result message says so).

## Where the token lives

A runtime's token is kept in **Obsidian's own secret storage**, not in `data.json`, a note, or any log. Secret storage is **per device** — the token field itself is Obsidian's own masked secret-entry component, and what gets saved to `data.json` is only the *name* of the secret, never the value. If settings sync to a second device, that device has the runtime configured but has to enter the token again; until it does, a token-required runtime shows "token not set on this device" and a click falls back to the terminal rather than sending with no token.

A token never appears in a note, a thread URL, a query string, the console, a notice, or an error message — failures are reported by HTTP status and a fixed reason string only, never by echoing a header or body. "Test connection" never shows the token either.

## Falling back to the terminal

If anything stops the prompt from reaching the runtime, the plugin shows a notice and runs the button in the inline terminal instead — exactly as if `target:` had been `terminal` all along. Nothing here runs the prompt twice: for the OpenAI-compatible chat kind, "has the runtime accepted it yet" is decided by a 5-second rule (see below), and a fallback only ever happens *before* that point.

| Reason | Notice | Fix |
|---|---|---|
| The runtime is unreachable (connection refused, DNS failure, or no response) | `<name> isn't reachable, running here` | Make sure the runtime's HTTP server is actually running and reachable at its configured base URL. The hook kind falls back if no response arrives within 15 seconds. The chat kind only falls back on a connection error that arrives **within** the first 5 seconds (see the 5-second rule below) — a chat run that is merely slow to respond is treated as sent, not unreachable. |
| The runtime answered with another HTTP status, or (hook kind) a `200` without `ok: true` and a `runId` | `<name> returned status <N>.` | Look at the runtime's own logs — it received the request but didn't accept it. |
| The token was rejected (401/403) | `token rejected` | Re-enter the correct token for this runtime in Settings, on this device. |
| No token stored on this device for a runtime marked "token required" | `Token not set on this device for "<name>".` | Enter the token in Settings on this device — settings synced from another device carry the runtime's configuration but never its token. |
| OpenClaw rejects the session key (its policy isn't enabled) | `OpenClaw rejected the session key: enable allowRequestSessionKey and allow the inline: prefix` | On the OpenClaw side, turn on `allowRequestSessionKey` and add `"inline:"` to `allowedSessionKeyPrefixes`. |

A `target:` that names no configured runtime is not a terminal fallback: it shows `Unknown target "<name>" — running the default target instead.` and runs the **Default target** setting, which is a runtime if you've set one as the default. Check the spelling against **Agent runtimes** in Settings, or fix the button.

### The chat kind's 5-second rule

The OpenAI-compatible chat kind has no separate "the runtime accepted this" signal of its own — there's just the HTTP response. So "settled" for this kind means **5 seconds have passed with no error**:

- An error that arrives **within** the first 5 seconds always falls back to the terminal — a run that fails that fast hasn't actually started on the runtime.
- An error that arrives **after** the 5 seconds have already settled (the button already says "Sent", the thread may already be open) is a notice only — the terminal never runs a second copy, so the prompt is never run twice.
- A late *timeout* specifically produces no notice at all, since it only means this plugin's own send stopped waiting — the run itself may well still be going on the runtime.

The OpenClaw hook kind doesn't need this: it has a real "accepted" signal (`{ ok: true, runId }`), so a failure before that reply is always a fallback, same as any other kind.

## What the plugin never does

- It never starts, installs, restarts, or configures a runtime — you turn on the runtime's own HTTP endpoint yourself, outside of Obsidian. The plugin only ever talks to a runtime you've explicitly configured, and only on a button click or "Test connection" — never on its own.
- It makes no network request to anything you haven't configured in **Agent runtimes**.
- No OAuth and no login flow: the only credential it ever sends is the bearer token. (The requests also carry non-secret protocol headers: the hook kind's `Idempotency-Key`, and the chat kind's optional `x-openclaw-session-key`.)

## Next

See [All Fields](../reference/fields.md) for the full `agent-button` field list, and [Settings Reference](../settings.md) for the rest of the settings tab.
