#!/usr/bin/env bash
# Decides whether to push / which branch to push at the end of an FBI run.
#
# Under the safeguard model the post-commit hook already pushes to safeguard
# and origin on every commit, so this script no longer manages pushes — it
# reports the already-observed push status for result.json. Kept as a
# separate file so it can be tested against git fixtures.
#
# Required env:
#   DEFAULT_BRANCH   name of the project's default branch (e.g. "main")
#   RUN_ID           numeric run id (logged only)
#   CLAUDE_EXIT      exit code of the claude process
#   RESULT_PATH      path to write the result JSON to
# Optional:
#   SESSION_ID       Claude session ID captured by supervisor.sh

set -euo pipefail

: "${DEFAULT_BRANCH:?DEFAULT_BRANCH required}"
: "${RUN_ID:?RUN_ID required}"
: "${CLAUDE_EXIT:?CLAUDE_EXIT required}"
: "${RESULT_PATH:?RESULT_PATH required}"

git fetch --quiet origin "$DEFAULT_BRANCH" 2>/dev/null || true

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"

TITLE=""
if [ -f /fbi-state/title ]; then
    TITLE="$(tr -d '\n\r' < /fbi-state/title | head -c 200)"
fi

# Push exit is sourced from the last origin-push log (written by the post-
# commit hook). No-remote projects write no log; treat absent log as success.
PUSH_EXIT=0
if [ -f /tmp/last-origin-push.log ]; then
    if grep -qE '^!|rejected|error:' /tmp/last-origin-push.log 2>/dev/null; then
        PUSH_EXIT=1
    fi
fi

printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s","branch":"%s","session_id":"%s","title":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" "$CURRENT_BRANCH" "${SESSION_ID:-}" "$TITLE" > "$RESULT_PATH"
