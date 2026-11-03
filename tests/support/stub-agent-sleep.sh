#!/bin/sh
# Same as stub-agent.sh, but the session stays alive after the reply (for
# `completion: responseEnd` checks). End it with the button's ✓ or by
# closing the note.
STUB_SLEEP=1 exec "$(dirname "$0")/stub-agent.sh" "$@"
