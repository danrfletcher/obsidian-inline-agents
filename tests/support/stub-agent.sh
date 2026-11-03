#!/bin/sh
# Stand-in for the agent binary, for checking `input:` runs by hand or from
# a test. Set it as `claude.binaryPath` (or `opencode.binaryPath`) in the
# plugin's data.json. The prompt is the last argument, for both agents.
#
# It prints what Claude Code prints: "❯ <first line of the prompt>", the
# whole prompt, a reply line and the turn-completion line the plugin
# looks for under `completion: responseEnd`. Then it exits, or, when
# STUB_SLEEP is set (see stub-agent-sleep.sh), keeps the session alive.
for arg in "$@"; do prompt="$arg"; done
first=$(printf '%s\n' "$prompt" | head -n 1)
printf '❯ %s\n' "$first"
printf '%s\n' "$prompt"
printf '\nStub reply: all done.\n'
printf 'Crunched for 1s · done 2:54 PM\n'
if [ -n "$STUB_SLEEP" ]; then sleep 3600; fi
