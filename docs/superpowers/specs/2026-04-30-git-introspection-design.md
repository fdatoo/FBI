# Git Introspection — Design

**Date:** 2026-04-30
**Status:** approved
**Branch:** fdatoo/gleam

## Problem

The frontend has a Changes panel, a WIP panel, file-diff viewers, and a History menu (merge / sync / squash / polish / mirror-rebase). The Gleam port currently stubs all of these to empty/no-op responses, so users can't see what their agent did, can't review uncommitted work, and can't drive the post-run history operations the original Elixir server supported.

This work fills in the real implementations: a per-run bare git repo on the host (`{runs_dir}/{run_id}/wip`) is the source of truth for committed history; a small in-container daemon snapshots the working tree to a dedicated ref so uncommitted state is visible from outside the container; a new `fbi/git/*` server module wraps `git` shell-out and parses results; handlers for `/changes`, `/wip[/file|/discard|/patch]`, `/file-diff`, `/commits/:sha/files`, and `/history` produce the responses the frontend expects.

## Goals

1. `/api/runs/:id/changes` returns a real `ChangesPayload` — branch name, ahead/behind, commits with per-file changes, uncommitted file list, child runs.
2. `/api/runs/:id/wip` returns the live uncommitted-changes view; `/wip/file?path=` returns a per-file diff; `/wip/patch` downloads a patch; `/wip/discard` resets the live working tree.
3. `/api/runs/:id/file-diff?path=&ref=` returns a unified diff against any committed sha or the worktree snapshot.
4. `/api/runs/:id/commits/:sha/files` returns the file list for a commit.
5. `/api/runs/:id/history` dispatches all five `HistoryOp` variants in scope (merge / sync / squash-local / polish / mirror-rebase). `push-submodule` returns `kind: invalid` (deferred).
6. WIP visibility survives container exit — terminal runs still expose their last uncommitted snapshot.

## Architecture

### WIP snapshot mechanism

A small bash daemon `priv/static/wip-snapshotter.sh` runs in the container as the `agent` user, started by `supervisor.sh` in the background. Every 5 seconds:

```bash
cp .git/index /tmp/wip-index 2>/dev/null || true
GIT_INDEX_FILE=/tmp/wip-index git add -A 2>/dev/null
TREE=$(GIT_INDEX_FILE=/tmp/wip-index git write-tree 2>/dev/null)
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
if [ -n "$TREE" ] && [ -n "$HEAD_SHA" ]; then
  COMMIT=$(git commit-tree "$TREE" -p "$HEAD_SHA" -m "wip snapshot" 2>/dev/null)
  git update-ref refs/fbi/wip-snapshot "$COMMIT"
  git push --quiet safeguard refs/fbi/wip-snapshot:refs/fbi/wip-snapshot --force 2>/dev/null
fi
```

This runs entirely in parallel with the existing post-commit hook. The hook handles committed history (pushes to `safeguard` and origin); the snapshotter handles uncommitted state (pushes only `refs/fbi/wip-snapshot` to `safeguard`). The agent's branch refs and index are never touched — we always copy the current index to a temp file before staging into it. If HEAD is unborn, the cycle is a no-op.

### Server-side git module structure

Three new modules:

- **`fbi/git.gleam`** — single low-level shell-out wrapper:
  ```gleam
  pub fn run(repo_path: String, args: List(String)) -> Result(String, GitError)
  ```
  Invokes `git -C repo_path <args...>` via `fbi_cmd:run/3`. Returns stdout on exit 0, `Error(GitError(exit_code, stderr))` otherwise. Resolves `git` once at module init via `find_executable`; if not found, every call returns `Error(GitUnavailable)`. Single funnel — nothing else in the codebase shells out to git directly.

- **`fbi/git/parse.gleam`** — parsing helpers:
  - `parse_log_porcelain` — `%H%x00%s%x00%ct` records into `(sha, subject, committed_at)`
  - `parse_status_porcelain_v2` — for the `docker exec`-side WIP fetch (sync/merge target detection)
  - `parse_diff_hunks` — unified diff into `FileDiffHunk[]`
  - `parse_numstat` — `--numstat` lines into `(additions, deletions, path)`
  - `parse_name_status` — `--name-status` lines into `(status, path)`
  - Pure text→records, no git invocations. Easy to unit-test against fixtures.

- **`fbi/git/repo.gleam`** — domain operations against a run's bare repo. Builds on `git.gleam` + `parse.gleam`. Handlers call this layer:
  - `commits_on_branch(repo_path, branch, base)` — `git log base..branch --pretty=format:%H%x00%s%x00%ct`
  - `commit_files(repo_path, sha)` — `git show --name-status --numstat <sha>`
  - `file_diff(repo_path, ref, path)` — committed diff
  - `wip_files(repo_path)` — diff of `refs/fbi/wip-snapshot` against its parent
  - `branch_base_ahead_behind(repo_path, branch, default_sha)` — merge-base + rev-list --count

### Handler structure

Replaces the existing stubs:
- `handlers/changes.gleam` — rewritten. `/changes`, `/file-diff`, `/commits/:sha/files`. The submodule-commit-files arm stays a stub.
- `handlers/wip.gleam` — rewritten. `/wip`, `/wip/file`, `/wip/discard`, `/wip/patch`.
- `handlers/history.gleam` — new. `/history` POST dispatches the five HistoryOp variants. The previous stub in `handlers/changes.gleam` is removed.

### `/api/runs/:id/changes` assembly

Composes the response with a sequence of `repo.gleam` calls plus DB queries:

- `branch_name` — from `runs.branch_name`.
- `branch_base` — `git merge-base <branch> <default>` then two `git rev-list --count` calls. The default branch may not be in the bare repo (the safeguard mirror only mirrors the run's branch). On first request, fetch a single shallow ref via the project's repo URL, cache the resulting sha at `runs_dir/{id}/state/origin-default-sha`. If the fetch fails, `branch_base` is `null` and a warning is logged.
- `commits` — `git log <default>..<branch> --pretty=format:%H%x00%s%x00%ct`. For each commit, `git show --name-status --numstat <sha>` for the per-file list. `pushed` is derived from `runs.mirror_status`: `"ok"` → all commits pushed, anything else → all `pushed: false`. The post-commit hook fails atomically (a failed origin push leaves the chain unpushed), so per-commit pushed precision isn't worth a separate fetch.
- `uncommitted` — `git diff --name-status --numstat <parent>..<snapshot>` against `refs/fbi/wip-snapshot`. Empty list if the ref is missing or the diff is empty.
- `dirty_submodules` — always `[]` (deferred).
- `integrations.github` — always `{}` (deferred).
- `children` — `SELECT id, kind, state, created_at FROM runs WHERE parent_run_id = ?`.

No caching in v1. Each request runs ~5–10 git invocations; locally that's well under 200ms for runs with under 50 commits.

### WIP endpoints

**`GET /api/runs/:id/wip`** — read against the bare repo:
1. `git rev-parse --verify refs/fbi/wip-snapshot` → if missing, return `{ok: false, reason: "no-wip"}`.
2. `git rev-parse <snapshot>^` for the parent.
3. `git diff --name-status --numstat <parent>..<snapshot>` → file list.
4. Empty diff → `{ok: false, reason: "no-wip"}`.
5. Otherwise `{ok: true, snapshot_sha, parent_sha, files}`.

**`GET /api/runs/:id/wip/file?path=`** — same parent/snapshot lookup, then `git diff <parent>..<snapshot> -- <path>`. Hunks parsed via `parse_diff_hunks`. 1MB output cap → `truncated: true`.

**`GET /api/runs/:id/wip/patch`** — `git diff <parent>..<snapshot>` raw, served as `text/x-patch` with `Content-Disposition: attachment; filename="run-N-wip.patch"`. No truncation.

**`POST /api/runs/:id/wip/discard`** — mutates the live container's working tree; the bare repo can't do this:
1. Look up the run in the registry. Not running → `409 Conflict` with `{error: "container_not_running"}`.
2. New helper `docker.exec_container(sock, cid, cmd)` runs `git restore --staged --worktree . && git clean -fd` inside the container as the `agent` user (under the same root-then-`runuser` entrypoint pattern).
3. The next snapshotter tick (≤5s) will produce an empty WIP snapshot.
4. Return 204 on success.

### `/api/runs/:id/file-diff?path=&ref=`

- `ref=worktree` → same as `/wip/file` for that path.
- `ref=<sha>` → `git diff <sha>^..<sha> -- <path>`. Root commits (no parent) use the empty-tree sentinel `4b825dc642cb6eb9a060e54bf8d69288fbee4904` as the left side.
- Same hunk parser, 1MB cap.
- 404 if the sha doesn't resolve.

### `/api/runs/:id/commits/:sha/files`

`git show --name-status --numstat <sha>`, parse into `FilesHeadEntry[]`. Same parser as `/changes`. 404 if the sha doesn't resolve.

### `/api/runs/:id/history` (HistoryOp dispatch)

Splitting by execution model:

**Pure git ops (host-side against the bare repo, return `complete` or `git-error`):**
- **`mirror-rebase`** — `git fetch origin <default>` against the bare repo, `git rebase origin/<default>`, `git update-ref refs/heads/<branch>`. Conflicts spawn a `merge-conflict` child run (see below).
- **`squash-local`** — `git reset --soft <merge-base>`, `git commit --allow-empty -m <subject>`, `git update-ref`. Pure plumbing.
- **`push-submodule`** — submodules deferred, returns `{kind: "invalid", message: "submodules not supported in this build"}`.

**Container-side ops (need the live container's working tree, dispatch via `docker exec`):**
- **`sync`** — `docker exec ... git pull --no-rebase`. Returns `complete` or spawns a `merge-conflict` child.
- **`merge`** — same idea, `MergeStrategy` controls the flag (`--no-ff`, `--ff-only`, `--squash`). Returns `complete` or spawns a `merge-conflict` child.

**Agent-spawning ops (insert child run, return `{kind: "agent", child_run_id}`):**
- **`polish`** — inserts a new run with `kind: 'polish'` and `parent_run_id` set, starts supervisor + worker through the existing `run_supervisor.start_run` path. The polish-specific prompt template is read from `priv/static/polish-prompt.txt` and injected into the run's preamble. `supervisor.sh` reads `kind` and adjusts behavior accordingly (small addition).

**Conflict result:** when `merge`/`sync`/`mirror-rebase` hits conflicts, instead of leaving the working tree mid-resolve, we insert a child run with `kind: 'merge-conflict'` whose prompt instructs an agent to resolve and commit. Return `{kind: "conflict", child_run_id}`.

**`agent-busy`:** returned when a polish/conflict child would step on an already-running child for the same parent — `SELECT 1 FROM runs WHERE parent_run_id = ? AND state IN ('queued','running','waiting','awaiting_resume')`.

**Per-run mutex:** `/history` ops for the same run hold a per-run lock implemented as an entry in a registry-style mutex actor. Concurrent requests wait up to 200ms; then return `agent-busy`.

### Error handling and edge cases

- **Bare repo missing** — single `repo_exists/2` check at top of every handler. 404.
- **Refs missing** (pre-first-commit). `/changes` returns the empty-but-shaped payload; doesn't error.
- **Default branch unknown** — `branch_base: null`, log a warning.
- **Git CLI missing** — every git op returns `Error(GitUnavailable)`. Read endpoints 503 with descriptive body. `/history` returns `kind: git-unavailable`.
- **Container exec fails** (for `sync`/`merge`/`wip/discard`) — return `kind: git-error` with stderr. `409 container_not_running` is the special case for `wip/discard` when we know upfront the container is gone.
- **Concurrent `/history` calls** for the same run — per-run mutex; 200ms wait, then `agent-busy`.

## Deferrals (tracked alongside reattach spec)

These are explicitly out of scope here and listed alongside the existing out-of-scope checklist in `2026-04-29-reattach-on-boot-design.md`.

1. **Submodule support** — `dirty_submodules: []` on `/changes`, `submodule_bumps: []` on every commit, `/api/runs/:id/submodule/:path/commits/:sha/files` stays a stub returning `{files: []}`, `push-submodule` returns `kind: invalid`.
2. **GitHub integration block** — `integrations.github: {}` on `/changes`. Real impl needs `gh` CLI auth and per-project repo discovery.
3. **Per-request caching of `/changes`** — naive each time. Add a per-run cache invalidated on `mirror-status` change if it gets hot.
4. **`pushed` precision** — derived from `runs.mirror_status` applied uniformly. A real per-commit pushed flag would require fetching origin's actual ref state; deferred.
5. **Multi-row file-diff endpoints** for runs with massive diffs — the 1MB cap is a hard truncation. Streaming or chunked diff fetch is a future improvement.

## Verification

- Unit tests cover `parse.gleam` against fixture strings (log porcelain, status v2, diff hunks, numstat, name-status). This is the most error-prone piece.
- Integration tests for `repo.gleam` use a tmp git repo set up in test fixtures with known commits.
- Handler tests use the test DB + a tmp `runs_dir` containing a real bare repo seeded by the test setup.
- Manual via Playwright after a real run: open Changes panel, see commits with file lists; trigger an edit in the running container, see WIP populate within 5s; click a commit to see file diff; trigger `polish` from the History menu and watch the child run start.
