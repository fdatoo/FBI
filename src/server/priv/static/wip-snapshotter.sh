#!/usr/bin/env bash
# /usr/local/bin/fbi-wip-snapshotter.sh — runs as agent inside FBI containers.
# Every 5s, snapshot the working tree as a synthetic git commit and push it
# to refs/fbi/wip-snapshot on the safeguard remote. Never touches HEAD,
# branch refs, or the agent's index.

set +e  # never exit; transient git errors during agent ops are normal

WORKTREE="${WORKTREE:-/workspace}"
INTERVAL="${WIP_SNAPSHOT_INTERVAL:-5}"

cd "$WORKTREE" 2>/dev/null || exit 0

while true; do
  sleep "$INTERVAL"
  # Skip if HEAD doesn't resolve yet (pre-first-commit).
  HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || continue
  TMP_INDEX=$(mktemp /tmp/fbi-wip-index.XXXXXX)
  cp .git/index "$TMP_INDEX" 2>/dev/null || continue
  GIT_INDEX_FILE="$TMP_INDEX" git add -A 2>/dev/null
  TREE=$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree 2>/dev/null)
  rm -f "$TMP_INDEX"
  [ -z "$TREE" ] && continue
  COMMIT=$(git commit-tree "$TREE" -p "$HEAD_SHA" -m "wip snapshot" 2>/dev/null)
  [ -z "$COMMIT" ] && continue
  git update-ref refs/fbi/wip-snapshot "$COMMIT" 2>/dev/null
  git push --quiet --force safeguard \
    "refs/fbi/wip-snapshot:refs/fbi/wip-snapshot" 2>/dev/null
done
