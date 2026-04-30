#!/bin/sh
# FBI history operation runner. Invoked inside a container (live run container
# via `docker exec`, or a transient --rm container) to perform one git
# operation on behalf of the server.
#
# Env vars (required):
#   FBI_OP            one of: merge | sync | squash-local
#   FBI_BRANCH        feature branch name (e.g. feat/x)
#   FBI_DEFAULT       default branch (e.g. main)
# Op-specific:
#   FBI_STRATEGY      for op=merge: merge | rebase | squash
#   FBI_SUBJECT       for op=squash-local or op=merge/strategy=squash
#   FBI_RUN_ID        run id, for commit messages
#
# Output contract: one JSON line on stdout:
#   {"ok":true,"sha":"...","message":""}
#   {"ok":false,"reason":"conflict|gh-error","message":"..."}
# Exit code is always 0 on structured failure; non-zero only on unreachable
# pre-conditions (no /workspace, no git).
#
# Design: the op runs in a *separate worktree* (mktemp dir) so it never
# disturbs the agent's working tree in /workspace. Works equally for live
# and transient containers. POSIX sh only — no bashisms, so alpine-based
# images work.

set -u

: "${FBI_OP:?FBI_OP required}"
: "${FBI_BRANCH:?FBI_BRANCH required}"
: "${FBI_DEFAULT:?FBI_DEFAULT required}"

cd /workspace || { printf '%s\n' '{"ok":false,"reason":"gh-error","message":"no /workspace"}'; exit 2; }

emit_fail() {
  reason=$1
  msg=$(printf '%s' "$2" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '%s\n' "{\"ok\":false,\"reason\":\"${reason}\",\"message\":\"${msg}\"}"
}
emit_ok() {
  sha=$1
  printf '%s\n' "{\"ok\":true,\"sha\":\"${sha}\",\"message\":\"\"}"
}

# push-submodule doesn't need a worktree — it operates on the existing
# /workspace/<path> submodule clone directly.
if [ "$FBI_OP" != "push-submodule" ]; then
  WORK=$(mktemp -d)
  cleanup() {
    git -C /workspace worktree remove --force "$WORK" 2>/dev/null || rm -rf "$WORK"
  }
  trap cleanup EXIT

  if ! out=$(git -C /workspace fetch --quiet --recurse-submodules=on-demand origin '+refs/heads/*:refs/remotes/origin/*' 2>&1); then
    emit_fail gh-error "fetch failed: $out"
    exit 0
  fi

  # Prefer the safeguard's view of the run branch over origin's (safeguard is
  # the canonical source of Claude's committed work under the safeguard
  # design; origin may be stale or behind).
  if [ -d /safeguard ]; then
      git -C /workspace remote add safeguard /safeguard 2>/dev/null \
          || git -C /workspace remote set-url safeguard /safeguard 2>/dev/null \
          || :
      if git -C /workspace fetch --quiet safeguard "$FBI_BRANCH" 2>/dev/null; then
          git -C /workspace update-ref "refs/remotes/origin/$FBI_BRANCH" "safeguard/$FBI_BRANCH" 2>/dev/null || :
      fi
  fi

  if ! out=$(git -C /workspace worktree add --detach "$WORK" "origin/$FBI_DEFAULT" 2>&1); then
    emit_fail gh-error "worktree add failed: $out"
    exit 0
  fi

  cd "$WORK" || exit
fi

run_merge() {
  strategy="${FBI_STRATEGY:-merge}"
  case "$strategy" in
    merge)
      if ! out=$(git merge --no-ff "origin/$FBI_BRANCH" 2>&1); then
        git merge --abort 2>/dev/null
        emit_fail conflict "merge conflict: $out"
        exit 0
      fi
      if ! out=$(git push --recurse-submodules=on-demand origin "HEAD:refs/heads/$FBI_DEFAULT" 2>&1); then
        emit_fail gh-error "push failed: $out"
        exit 0
      fi
      ;;
    rebase)
      if ! git checkout --detach "origin/$FBI_BRANCH" 2>/dev/null; then
        emit_fail gh-error "checkout branch failed"
        exit 0
      fi
      if ! out=$(git rebase "origin/$FBI_DEFAULT" 2>&1); then
        git rebase --abort 2>/dev/null
        emit_fail conflict "rebase conflict: $out"
        exit 0
      fi
      if ! out=$(git push --recurse-submodules=on-demand --force origin "HEAD:refs/heads/$FBI_BRANCH" 2>&1); then
        emit_fail gh-error "force-push branch failed: $out"
        exit 0
      fi
      rebased_sha=$(git rev-parse HEAD)
      if ! git checkout --detach "origin/$FBI_DEFAULT" 2>/dev/null; then
        emit_fail gh-error "checkout default (post-rebase) failed"
        exit 0
      fi
      if ! out=$(git merge --ff-only "$rebased_sha" 2>&1); then
        emit_fail gh-error "ff-merge failed: $out"
        exit 0
      fi
      if ! out=$(git push --recurse-submodules=on-demand origin "HEAD:refs/heads/$FBI_DEFAULT" 2>&1); then
        emit_fail gh-error "push failed: $out"
        exit 0
      fi
      ;;
    squash)
      subject="${FBI_SUBJECT:-Merge branch $FBI_BRANCH (FBI run ${FBI_RUN_ID:-?})}"
      if ! out=$(git merge --squash "origin/$FBI_BRANCH" 2>&1); then
        git merge --abort 2>/dev/null
        emit_fail conflict "squash conflict: $out"
        exit 0
      fi
      if ! out=$(git -c user.name="${GIT_AUTHOR_NAME:-FBI}" -c user.email="${GIT_AUTHOR_EMAIL:-fbi@example.com}" commit -m "$subject" 2>&1); then
        emit_fail gh-error "commit failed: $out"
        exit 0
      fi
      if ! out=$(git push --recurse-submodules=on-demand origin "HEAD:refs/heads/$FBI_DEFAULT" 2>&1); then
        emit_fail gh-error "push failed: $out"
        exit 0
      fi
      ;;
    *)
      emit_fail gh-error "unknown strategy $strategy"
      exit 0
      ;;
  esac
  sha=$(git rev-parse HEAD 2>/dev/null || echo '')
  emit_ok "$sha"
}

run_sync() {
  if ! git checkout --detach "origin/$FBI_BRANCH" 2>/dev/null; then
    emit_fail gh-error "checkout branch failed"
    exit 0
  fi
  if ! out=$(git rebase "origin/$FBI_DEFAULT" 2>&1); then
    git rebase --abort 2>/dev/null
    emit_fail conflict "rebase conflict: $out"
    exit 0
  fi
  if ! out=$(git push --recurse-submodules=on-demand --force origin "HEAD:refs/heads/$FBI_BRANCH" 2>&1); then
    emit_fail gh-error "force-push failed: $out"
    exit 0
  fi
  sha=$(git rev-parse HEAD 2>/dev/null || echo '')
  emit_ok "$sha"
}

run_squash_local() {
  : "${FBI_SUBJECT:?FBI_SUBJECT required for squash-local}"
  if ! git checkout --detach "origin/$FBI_BRANCH" 2>/dev/null; then
    emit_fail gh-error "checkout branch failed"
    exit 0
  fi
  base=$(git merge-base HEAD "origin/$FBI_DEFAULT" 2>/dev/null) || {
    emit_fail gh-error "merge-base failed"
    exit 0
  }
  if ! out=$(git reset --soft "$base" 2>&1); then
    emit_fail gh-error "reset failed: $out"
    exit 0
  fi
  if ! out=$(git -c user.name="${GIT_AUTHOR_NAME:-FBI}" -c user.email="${GIT_AUTHOR_EMAIL:-fbi@example.com}" commit -m "$FBI_SUBJECT" 2>&1); then
    emit_fail gh-error "commit failed: $out"
    exit 0
  fi
  if ! out=$(git push --recurse-submodules=on-demand --force origin "HEAD:refs/heads/$FBI_BRANCH" 2>&1); then
    emit_fail gh-error "force-push failed: $out"
    exit 0
  fi
  sha=$(git rev-parse HEAD 2>/dev/null || echo '')
  emit_ok "$sha"
}

run_push_submodule() {
  : "${FBI_PATH:?FBI_PATH required for push-submodule}"
  if [ ! -d "/workspace/$FBI_PATH/.git" ] && [ ! -f "/workspace/$FBI_PATH/.git" ]; then
    emit_fail gh-error "not a git repo: $FBI_PATH"
    exit 0
  fi
  if ! out=$(git -C "/workspace/$FBI_PATH" push origin HEAD 2>&1); then
    emit_fail gh-error "submodule push failed: $out"
    exit 0
  fi
  sha=$(git -C "/workspace/$FBI_PATH" rev-parse HEAD 2>/dev/null || echo '')
  emit_ok "$sha"
}

run_mirror_rebase() {
    : "${FBI_BASE_BRANCH:?FBI_BASE_BRANCH required for mirror-rebase}"
    if ! out=$(git -C /workspace fetch --quiet origin "$FBI_BASE_BRANCH" "$FBI_BRANCH" 2>&1); then
        emit_fail gh-error "fetch failed: $out"
        exit 0
    fi
    cd /workspace || exit
    if ! git checkout --detach "origin/$FBI_BRANCH" 2>/dev/null; then
        emit_fail gh-error "checkout branch failed"
        exit 0
    fi
    if ! out=$(git rebase "origin/$FBI_BASE_BRANCH" 2>&1); then
        git rebase --abort 2>/dev/null
        emit_fail conflict "rebase conflict: $out"
        exit 0
    fi
    rebased=$(git rev-parse HEAD)
    if ! out=$(git push --force-with-lease origin "HEAD:refs/heads/$FBI_BRANCH" 2>&1); then
        emit_fail gh-error "push agent branch failed: $out"
        exit 0
    fi
    if ! out=$(git push origin "$rebased:refs/heads/$FBI_BASE_BRANCH" 2>&1); then
        emit_fail gh-error "mirror push failed: $out"
        exit 0
    fi
    emit_ok "$rebased"
}

case "$FBI_OP" in
  merge) run_merge ;;
  sync) run_sync ;;
  squash-local) run_squash_local ;;
  push-submodule) run_push_submodule ;;
  mirror-rebase) run_mirror_rebase ;;
  *)
    emit_fail gh-error "unknown op $FBI_OP"
    exit 0
    ;;
esac
