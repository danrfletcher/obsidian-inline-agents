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
3. Paste the token and click **Test connection**.
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

1. In Settings → Inline Agents → **Agent runtimes**, add a runtime: name `openclaw`, kind **OpenClaw hook**, base URL `http://127.0.0.1:18789`, agent ID `main`, and the hook's token (e.g. `<your-hook-token>` — paste the real value OpenClaw gave you; the field is masked and the value never leaves this device).
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
    | Send session id as `X-Hermes-Session-Id` | on |
    | Thread-URL template | `hermes://open/{sessionId}` (see [Opening the Hermes chat from the thread link](#opening-the-hermes-chat-from-the-thread-link)) |

4. Click **Test connection**. It calls `GET /models`, so a wrong key shows up here rather than on the first click.

5. A button with `target: hermes` now sends its prompt as a normal user turn (`POST <base>/chat/completions`, one `user`-role message). Nothing is prefixed onto it the way the OpenClaw hook kind's instruction line is. The turn runs on the Hermes profile whose gateway hosts the API server, with that profile's tools, memory and skills. With the session id on and the template set, the button shows "Sent to hermes ↗" and opens that chat in the Hermes desktop app. Read the reply there.

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
| **Send session id as `X-Hermes-Session-Id`** | toggle, default off (chat kind only) | Sends the plugin's [session id](#session-keys-and-thread-urls) in Hermes' `X-Hermes-Session-Id` header, and as the request body's `user` field in place of the session key, so Hermes files the chat under that id and `{sessionId}` in the template points at it. Needs `API_SERVER_KEY` set on Hermes — see [Opening the Hermes chat from the thread link](#opening-the-hermes-chat-from-the-thread-link). |
| **Token** | masked secret field | Stored in Obsidian's own per-device secret storage, not `data.json` — see [Where the token lives](#where-the-token-lives) below. |
| **Thread-URL template** | text, optional | Builds the link the "Sent to `<name>` ↗" button opens — see [Thread-URL templates](#thread-url-templates) below. |
| **Test connection** | button | Checks reachability and the token, without sending a prompt — see [Test connection](#test-connection) below. |

Also on this screen:

- **Default target** — a dropdown of `Terminal` plus every configured runtime name. This is what a button without a `target:` line uses, and what an unknown `target:` name falls back to.
- The toggle next to it — the default for a button's `open:` line when it's missing or malformed. On by default.

Two runtimes can't share a name — the settings tab refuses to save a duplicate.

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

From the same key it derives a **session id**: the key with each `:` replaced by `-`, so `inline:weekly-review:1793618103221` gives `inline-weekly-review-1793618103221`. The id uses only `a-z 0-9 - _` and never contains `:`, which is what Hermes' in-app links require. The key and the id are worked out once per click, before the request goes out, and the request and the thread URL use the same values.

### Thread-URL templates

An optional per-runtime template that builds the link the "Sent to `<name>` ↗" button opens, using:

| Placeholder | Fills in |
|---|---|
| `{agentId}` | The agent ID/model actually used for this click (the button's `agentId:` override, or the runtime's configured one). |
| `{sessionKey}` | The full session key, e.g. `inline:weekly-review:1760000000000`. |
| `{sessionKeyPath}` | The session key split on `:` into path segments and rejoined with `/` — `inline/weekly-review/1760000000000`. |
| `{sessionId}` | The session key with each `:` replaced by `-`, e.g. `inline-weekly-review-1793618103221`. Filled for both runtime kinds, and not URL-encoded (it only holds safe characters). Only the OpenAI-compatible chat kind with **Send session id** on actually sends it to the runtime; the OpenClaw hook kind ignores `{sessionId}`. |

The template can use `http`, `https`, or any custom URL scheme a runtime's own app registers — the plugin doesn't know any particular runtime's scheme, so anything is accepted except four schemes that are never safe to open automatically: **`file`**, **`javascript`**, **`data`**, **`vbscript`**. A template using one of those is rejected at settings-save time, and checked again defensively right before a thread would open.

With no thread-URL template at all, there's nothing to open — the click is fire-and-forget, the button just shows "Sent to `<name>`" with no link, and (with `open: true`) a one-time-per-runtime-per-session notice says no thread URL is set.

Opening a thread uses the operating system's own URL handler, the same way a link in any other app would — an `http(s)` URL opens in your default browser; a custom scheme opens whatever app registered it.

### Opening the Hermes chat from the thread link

The Hermes desktop app opens a chat from a `hermes://open/<id>` link. Hermes never reports its own chat id back, so the plugin chooses the id itself and tells Hermes to use it:

1. In the `hermes` runtime, turn on **Send session id as `X-Hermes-Session-Id`**.
2. Set **Thread-URL template** to `hermes://open/{sessionId}`.

With both set, a click sends the [session id](#session-keys-and-thread-urls) in an `X-Hermes-Session-Id` header and as the request body's `user` field (instead of the session key), and the thread link is `hermes://open/<that id>`. For `Weekly Review.md` clicked at epoch ms `1793618103221` that is `hermes://open/inline-weekly-review-1793618103221`. Hermes stores the chat under the id it was given, lists it under the **API** section of the desktop sidebar, and the reply lands in the same chat when the run finishes. The header carries the session id, not the token; the token is only ever sent in the `Authorization` header.

The plugin knows one Hermes header name and no URL scheme: the template stays yours to write. `hermes://open/sessions/{sessionId}` also works, through Hermes' legacy redirect to the same chat, but the short form above is the documented one.

What to know:

- **`API_SERVER_KEY` is required for the header.** Hermes only accepts `X-Hermes-Session-Id` when its API server has a key (`API_SERVER_KEY`, set in step 1 of the example above). A Hermes with no key answers 403, and a notice reads `Hermes needs API_SERVER_KEY set to use session ids.` and nothing opens. Like any failure before the 5-second settle, it falls back to the terminal. A 401 keeps the usual `token rejected` wording.
- **Which profile.** The link opens on the profile that hosts the API server: the default profile, on port 8642. If the desktop app is showing a different profile, the link may open an empty or missing chat.
- **A template using `{sessionId}` with the toggle off** points at a chat that does not exist, because Hermes never receives the id. Settings shows a warning under the template field (`Hermes only uses this id when 'Send session id' is on.`); the click itself still works. With the hook kind the warning reads `OpenClaw ignores {sessionId}.`, and with both the OpenClaw-header and session-id toggles on it says the OpenClaw header sends a key containing `:` to Hermes. Both headers are still sent.
- **When it opens.** As for every runtime, the link opens at the 5-second settle, while the turn is usually still running, not when the reply arrives. The chat holds your prompt, and the reply shows up in it when the run finishes.
- **The ↗ lasts only while the note stays rendered.** The link is kept in the button, never written to the note. Re-rendering the note or restarting Obsidian drops it. The chat itself stays in Hermes' **API** sidebar section, so you can still open it there.
- **Same-millisecond collision.** The id is the note's basename plus the epoch millisecond of the click. Two clicks from notes with the same basename in the same millisecond share an id, so the second turn shares or collides with the first one's server-side session. No guard exists against this.
- **Long chats.** When Hermes compresses a long chat, the link is expected to follow the chat to its newest part. That is read from Hermes' source, not tested.
- **No desktop app.** If the Hermes desktop app isn't installed, or nothing handles `hermes://`, the link does whatever your operating system does with an unhandled URL scheme; the plugin adds nothing to that.
- **Existing runtimes are not edited for you.** A `hermes` runtime you set up earlier keeps working exactly as before, with no header and a blank template, until you turn the toggle on and set the template by hand.

The only thing Hermes needs for this is the `API_SERVER_KEY` it already uses to run the API server.

## Test connection

Each runtime has its own **Test connection** button — it checks reachability and the token *without* sending a prompt, using whatever token is currently typed into the form (not necessarily what's already saved). For the OpenAI-compatible chat kind this calls the standard `GET /models` endpoint, which actually validates the token; the OpenClaw hook kind has no safe, non-prompt endpoint to check against, so this only confirms the base URL is reachable (the result message says so).

## Where the token lives

A runtime's token is kept in **Obsidian's own secret storage**, not in `data.json`, a note, or any log. Secret storage is **per device** — the token field itself is Obsidian's own masked secret-entry component, and what gets saved to `data.json` is only the *name* of the secret, never the value. If settings sync to a second device, that device has the runtime configured but has to enter the token again; until it does, a token-required runtime shows "token not set on this device" and a click falls back to the terminal rather than sending with no token.

A token never appears in a note, a thread URL, a query string, the console, a notice, or an error message — failures are reported by HTTP status and a fixed reason string only, never by echoing a header or body. "Test connection" never shows the token either.

## Falling back to the terminal

If anything stops the prompt from reaching the runtime, the plugin shows a notice and runs the button in the inline terminal instead — exactly as if `target:` had been `terminal` all along. Nothing here runs the prompt twice: for the OpenAI-compatible chat kind, "has the runtime accepted it yet" is decided by a 5-second rule (see below), and a fallback only ever happens *before* that point.

| Reason | Notice | Fix |
|---|---|---|
| `target:` names a runtime that doesn't exist | `Unknown target "<name>" — running the default target instead.` | Check the spelling against **Agent runtimes** in Settings, or fix the button. |
| The runtime is unreachable (connection refused, DNS failure, or no response) | `<name> isn't reachable, running here` | Make sure the runtime's HTTP server is actually running and reachable at its configured base URL. The hook kind falls back if no response arrives within 15 seconds. The chat kind only falls back on a connection error that arrives **within** the first 5 seconds (see the 5-second rule below) — a chat run that is merely slow to respond is treated as sent, not unreachable. |
| The token was rejected (401, or 403 when the session-id toggle is off) | `token rejected` | Re-enter the correct token for this runtime in Settings, on this device. |
| The chat kind sends a session id and Hermes answers 403 | `Hermes needs API_SERVER_KEY set to use session ids.` | Set `API_SERVER_KEY` on the Hermes side, which is what lets it accept `X-Hermes-Session-Id`, then click again. |
| No token stored on this device for a runtime marked "token required" | `Token not set on this device for "<name>".` | Enter the token in Settings on this device — settings synced from another device carry the runtime's configuration but never its token. |
| OpenClaw rejects the session key (its policy isn't enabled) | `OpenClaw rejected the session key: enable allowRequestSessionKey and allow the inline: prefix` | On the OpenClaw side, turn on `allowRequestSessionKey` and add `"inline:"` to `allowedSessionKeyPrefixes`. |

### The chat kind's 5-second rule

The OpenAI-compatible chat kind has no separate "the runtime accepted this" signal of its own — there's just the HTTP response. So "settled" for this kind means **5 seconds have passed with no error**:

- An error that arrives **within** the first 5 seconds always falls back to the terminal — a run that fails that fast hasn't actually started on the runtime.
- An error that arrives **after** the 5 seconds have already settled (the button already says "Sent", the thread may already be open) is a notice only — the terminal never runs a second copy, so the prompt is never run twice.
- A late *timeout* specifically produces no notice at all, since it only means this plugin's own send stopped waiting — the run itself may well still be going on the runtime.

The OpenClaw hook kind doesn't need this: it has a real "accepted" signal (`{ ok: true, runId }`), so a failure before that reply is always a fallback, same as any other kind.

## What the plugin never does

- It never starts, installs, restarts, or configures a runtime — you turn on the runtime's own HTTP endpoint yourself, outside of Obsidian. The plugin only ever talks to a runtime you've explicitly configured, and only on a button click or "Test connection" — never on its own.
- It makes no network request to anything you haven't configured in **Agent runtimes**.
- No OAuth, no login flow, no custom header beyond a bearer token and the two optional session headers (`x-openclaw-session-key` and `X-Hermes-Session-Id`), both off by default.

## Next

See [All Fields](../reference/fields.md) for the full `agent-button` field list, and [Settings Reference](../settings.md) for the rest of the settings tab.
