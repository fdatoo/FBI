#!/usr/bin/env bash
# FBI run container entrypoint. Mounted at /usr/local/bin/supervisor.sh.
#
# The agent's only branch is $PRIMARY_BRANCH (the user's typed branch, or
# claude/run-<id> if none was provided). Commits are pushed to:
#   - safeguard  (local bind-mount; always succeeds)
#   - origin     (best-effort; result drives /fbi-state/mirror-status)
#
# Required env vars (set by orchestrator):
#   RUN_ID, REPO_URL, DEFAULT_BRANCH,
#   GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL
# Optional:
#   FBI_BRANCH              user's typed branch (else claude/run-<id>)
#   FBI_MARKETPLACES        newline-separated plugin marketplace sources
#   FBI_PLUGINS             newline-separated plugin specs
#   FBI_RESUME_SESSION_ID   resume an existing session
#   Any project secret, injected as env var.
# Required mounts:
#   /ssh-agent              (host ssh-agent socket, RW)
#   /home/agent/.claude/.credentials.json (host credentials, RO — OAuth)
#   /fbi                    (injected via putArchive: preamble/instructions/global/prompt)
#   /safeguard              (host-side bare git repo for this run)
#   /fbi-state              (host-side dir; hook writes mirror-status here)
#
# Contract: at end, write /tmp/result.json with exit_code, push_exit, head_sha, branch.

set -euo pipefail

# ── styled output helpers ─────────────────────────────────────────────────────
# Assumes UTF-8 locale + ANSI SGR terminal (xterm.js). _fbi_fatal callers must exit explicitly.
_fbi_status() { printf '\033[97m○\033[0m  %s\n'           "$*"; }
_fbi_cmd()    {
  local verb="$1"; shift
  if [ $# -gt 0 ]; then
    printf '\033[32m$\033[0m  \033[36m%s\033[0m \033[35m%s\033[0m\n' "$verb" "$*"
  else
    printf '\033[32m$\033[0m  \033[36m%s\033[0m\n' "$verb"
  fi
}
_fbi_warn()   { printf '\033[33m⚠\033[0m  \033[33m%s\033[0m\n' "$*" >&2; }
_fbi_fatal()  { printf '\033[31m✕\033[0m  \033[31m%s\033[0m\n' "$*" >&2; }
# ─────────────────────────────────────────────────────────────────────────────

export SSH_AUTH_SOCK=/ssh-agent

# WIP snapshotter — periodic snapshot of the working tree to safeguard.
if [ -x /usr/local/bin/fbi-wip-snapshotter.sh ]; then
    /usr/local/bin/fbi-wip-snapshotter.sh >/dev/null 2>&1 &
fi

# Take ownership of the bind-mounted state and safeguard dirs. These are
# created on the host by the server process and bind-mounted in; their
# host uid won't match agent (1001) so writes from supervisor.sh and the
# post-commit hook would otherwise fail with "Permission denied". The
# entrypoint shim (worker.gleam:container_spec) already does this for
# /ssh-agent; we do it here for the rest. Agent has NOPASSWD sudo via
# postbuild.sh, so this works even after runuser drops privileges.
for dir in /fbi-state /safeguard; do
  if [ -d "$dir" ]; then sudo chown -R agent:agent "$dir" 2>/dev/null || true; fi
done

if [ -n "${FBI_MARKETPLACES:-}" ]; then
    while IFS= read -r mkt; do
        [ -z "$mkt" ] && continue
        _fbi_status "adding marketplace $mkt"
        claude plugin marketplace add "$mkt" || _fbi_warn "marketplace add failed: $mkt"
    done <<< "$FBI_MARKETPLACES"
fi
if [ -n "${FBI_PLUGINS:-}" ]; then
    while IFS= read -r plug; do
        [ -z "$plug" ] && continue
        _fbi_status "installing plugin $plug"
        claude plugin install "$plug" || _fbi_warn "plugin install failed: $plug"
    done <<< "$FBI_PLUGINS"
fi

cd /workspace

# Bind-mounted local-path repos (test/dev convenience: e.g.
# /tmp/empty-repo.git owned by the host uid) trip git's CVE-2022-24765
# "dubious ownership" check when accessed by the container's agent uid.
# Mark all repos safe — this container is single-tenant for one run, so
# there's no untrusted-repo risk to defend against here. Harmless for
# remote-URL repos that don't hit the check anyway.
git config --global --add safe.directory '*' || true

_fbi_cmd "git clone" "$REPO_URL ."
git clone --recurse-submodules "$REPO_URL" . || { _fbi_fatal "clone failed"; exit 10; }

PRIMARY_BRANCH="${FBI_BRANCH:-claude/run-${RUN_ID}}"

# Detect whether the project has an origin remote. No-remote projects are
# supported; only safeguard pushes happen in that case.
HAS_ORIGIN=0
if git remote get-url origin >/dev/null 2>&1; then
    HAS_ORIGIN=1
fi

# Register the safeguard remote. Idempotent.
git remote add safeguard /safeguard 2>/dev/null \
    || git remote set-url safeguard /safeguard \
    || { _fbi_fatal "could not register safeguard remote"; exit 14; }

# Checkout the primary branch. Resume mode prefers safeguard; fresh mode
# prefers origin; both fall back to creating the branch locally.
CHECKED_OUT=0
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    if git fetch --quiet safeguard "$PRIMARY_BRANCH" 2>/dev/null; then
        if git rev-parse --verify --quiet "safeguard/$PRIMARY_BRANCH" >/dev/null 2>&1; then
            _fbi_cmd "git checkout -B" "$PRIMARY_BRANCH safeguard/$PRIMARY_BRANCH"
            git checkout -B "$PRIMARY_BRANCH" "safeguard/$PRIMARY_BRANCH" \
                || { _fbi_fatal "could not restore from safeguard/$PRIMARY_BRANCH"; exit 13; }
            CHECKED_OUT=1
        fi
    fi
fi

if [ "$CHECKED_OUT" = "0" ]; then
    if [ "$HAS_ORIGIN" = "1" ] && git rev-parse --verify --quiet "origin/$PRIMARY_BRANCH" >/dev/null 2>&1; then
        _fbi_cmd "git checkout -B" "$PRIMARY_BRANCH origin/$PRIMARY_BRANCH"
        git checkout -B "$PRIMARY_BRANCH" "origin/$PRIMARY_BRANCH" \
            || { _fbi_fatal "could not switch to $PRIMARY_BRANCH"; exit 13; }
    else
        _fbi_cmd "git checkout -b" "$PRIMARY_BRANCH"
        git checkout -b "$PRIMARY_BRANCH" \
            || { _fbi_fatal "could not create branch $PRIMARY_BRANCH"; exit 13; }
        # Only push to origin when the user provided an explicit branch name.
        # Auto-generated claude/run-N branches are not pushed initially; the
        # agent renames the branch and the post-commit hook handles the first push.
        case "$PRIMARY_BRANCH" in
          claude/run-*) : ;;
          *)
            if [ "$HAS_ORIGIN" = "1" ]; then
                _fbi_cmd "git push -u" "origin $PRIMARY_BRANCH"
                git push -u origin "$PRIMARY_BRANCH" \
                    || _fbi_warn "initial push of $PRIMARY_BRANCH to origin failed"
            fi
            ;;
        esac
    fi
fi

git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Export HAS_ORIGIN so the hook subshell inherits it.
export HAS_ORIGIN

mkdir -p /fbi-state
# Pre-seed mirror-status for no-remote projects so the UI shows the muted
# indicator even before the first commit.
if [ "$HAS_ORIGIN" = "0" ]; then
    echo local_only > /fbi-state/mirror-status
fi

# Silent post-commit push hook.
#   - safeguard: always push; the hook's core durability guarantee.
#   - origin: only push when HAS_ORIGIN=1. force-with-lease detects external
#     divergence and surfaces it via /fbi-state/mirror-status.
mkdir -p .git/hooks
cat > .git/hooks/post-commit <<'HOOK'
#!/bin/sh
mkdir -p /fbi-state
BRANCH="$(git symbolic-ref --short HEAD)"

# Record the current branch name so the server can pick it up live.
echo "$BRANCH" > /fbi-state/branch-name

# The safeguard mirror always uses the fixed claude/run-N ref so the server
# can look up commits regardless of what the agent named the primary branch.
MIRROR="claude/run-${RUN_ID}"

# Safeguard push — always runs to the fixed mirror ref.
(
  git push --force safeguard "HEAD:refs/heads/$MIRROR" > /tmp/last-safeguard-push.log 2>&1 \
    || echo "fatal: safeguard push failed" >&2
) &

# Origin push — uses the current (potentially renamed) branch name.
# Best-effort; skipped entirely when HAS_ORIGIN=0.
if [ "${HAS_ORIGIN:-0}" = "1" ]; then
  (
    if git push --recurse-submodules=on-demand --force-with-lease \
        origin "HEAD:refs/heads/$BRANCH" > /tmp/last-origin-push.log 2>&1; then
      echo ok > /fbi-state/mirror-status
    else
      echo diverged > /fbi-state/mirror-status
    fi
  ) &
else
  echo local_only > /fbi-state/mirror-status
fi
HOOK
chmod +x .git/hooks/post-commit

# FBI Claude Code hooks — project-level settings.local.json (gitignored by
# default, so never conflicts with anything in the cloned repo).
mkdir -p /workspace/.claude
cat > /workspace/.claude/settings.local.json <<'CLHOOKS'
{
  "hooks": {
    "Stop": [{
      "hooks": [{"type": "command", "command": "echo waiting > /fbi-state/agent-status 2>/dev/null || true", "async": true}]
    }],
    "UserPromptSubmit": [{
      "hooks": [{"type": "command", "command": "echo running > /fbi-state/agent-status 2>/dev/null || true"}]
    }]
  }
}
CLHOOKS

# Run the agent. Two modes:
#   fresh: compose /tmp/prompt.txt from /fbi/*.txt and stdin-pipe into claude.
#   resume: use $FBI_RESUME_SESSION_ID to continue an existing session.

# Mark time so we can detect which session file claude creates/updates.
touch /tmp/fbi-session-marker

# Signal "agent setup complete, about to start claude" to anyone watching
# /fbi-state. Used by the Dockerfile HEALTHCHECK and the orchestrator.
# Distinct from /fbi-state/prompted (written below for fresh runs) and
# /fbi-state/waiting (written for resume runs).
touch /fbi-state/ready

set +e
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    _fbi_status "resuming session $FBI_RESUME_SESSION_ID"
    touch /fbi-state/waiting
    claude --resume "$FBI_RESUME_SESSION_ID" --dangerously-skip-permissions
    CLAUDE_EXIT=$?
else
    : > /tmp/prompt.txt
    for section in preamble.txt global.txt instructions.txt; do
        if [ -s "/fbi/$section" ]; then
            cat "/fbi/$section" >> /tmp/prompt.txt
            printf '\n\n---\n\n' >> /tmp/prompt.txt
        fi
    done
    case "${FBI_KIND:-work}" in
      polish)
        if [ -f /usr/local/share/fbi/polish-prompt.txt ]; then
          cat /usr/local/share/fbi/polish-prompt.txt > /fbi/prompt.txt
        fi
        ;;
      merge-conflict)
        cat <<'EOF' > /fbi/prompt.txt
Resolve the merge conflicts in /workspace, then commit the resolution.
EOF
        ;;
    esac
    [ -f /fbi/prompt.txt ] || { _fbi_fatal "prompt.txt not found in /fbi"; exit 12; }
    cat /fbi/prompt.txt >> /tmp/prompt.txt
    touch /fbi-state/prompted
    claude --dangerously-skip-permissions < /tmp/prompt.txt
    CLAUDE_EXIT=$?
fi
set -e

# Capture the Claude session ID so the server can offer "Continue" on this run.
# For resume runs the session ID is already known; for fresh runs we find the
# JSONL file that claude created or updated since our marker.
SESSION_ID=""
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    SESSION_ID="$FBI_RESUME_SESSION_ID"
else
    LATEST=$(find /home/agent/.claude/projects -name "*.jsonl" -type f -newer /tmp/fbi-session-marker \
        2>/dev/null | head -1)
    if [ -n "$LATEST" ]; then
        SESSION_ID=$(basename "$LATEST" .jsonl)
    fi
fi

SESSION_ID="$SESSION_ID" CLAUDE_EXIT="$CLAUDE_EXIT" RESULT_PATH=/fbi-state/result.json \
    /usr/local/bin/fbi-finalize-branch.sh

exit $CLAUDE_EXIT
