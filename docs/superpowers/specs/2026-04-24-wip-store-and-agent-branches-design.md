# WIP Store + Agent-Owned Branches Design

**Date:** 2026-04-24
**Status:** Draft (awaiting review)

## Problem

FBI runs today push their end-of-run state directly to origin on whatever branch the run was checked out on. This conflates three needs under a single operation (`git push -u origin <branch>`):

1. **Durability** — don't lose work when a container dies
2. **Visibility** — keep the Changes tab / PR checks / CI up to date during the run
3. **Handoff** — let the user review and ship

That one overloaded primitive fails in predictable ways:

- If the user (or anyone) has advanced the remote branch since the container last fetched, the final `git push` is rejected as non-fast-forward. The run ends with `Git: exit code 127` or a visible push error, and WIP may be lost.
- The finalize step creates a synthetic `wip: claude run N` commit that pollutes the user's feature branch with agent scratch (screenshots, tmp files, etc.).
- An unclean termination — SIGKILL, OOM, Docker daemon restart, auto-resume tear-down — never reaches finalize at all. Everything uncommitted is lost.

This design separates durability, visibility, and handoff into two independent stores with different contracts, eliminates the push-rejection failure mode by construction, and gives resume a real restore path.

## Goals

1. **Make the push-rejected failure mode structurally impossible** for the agent's primary work.
2. **Persist uncommitted state** across container teardown so resume can restore it — including the unclean-termination path.
3. **Keep the user's CI / PR / deployment-preview workflow working** when a run targets a feature branch (via a best-effort mirror to that branch).
4. **Expose restored state in the UI** before the user clicks Continue, so they aren't resuming blindly.
5. **Fail loud on restore conflicts**, never silently overwrite user-facing state.

## Non-Goals (phase 1)

1. First-class "promote `claude/run-N` into my branch X" Ship-tab action. Users can still use GitHub PR retargeting or manual cherry-pick.
2. Multi-snapshot history / time-travel browsing. `wip.git` keeps only the latest snapshot (force-pushed `wip` ref).
3. Cross-run state sharing ("fork from run 42's WIP into a new run").
4. Server-triggered snapshots via `GitStateWatcher`. Container-side daemon is sufficient.
5. Configurable snapshot cadence. Hard-coded at 30s.
6. Retention beyond "delete with run". No GC of stale `wip.git` directories.
7. Cross-host / cross-FBI-instance portability of `wip.git`.
8. Changes to the Ship tab components built in the preceding `change-management-rework` work. Ship ops already operate on `run.branch_name`, which becomes `claude/run-N` under this design — no UI edit needed.

## Architecture Overview — the Two-Space Model

Two independent git stores with distinct contracts:

| Store | Location | Lifecycle | What lives here | Writers |
|---|---|---|---|---|
| **User's remote (origin)** | GitHub (or whatever the project's remote is) | User-owned | Real commits on `claude/run-N` branches; user's feature branches (touched only via best-effort mirror) | FBI is the sole writer for `claude/run-N`; FBI pushes to user's feature branch only via the mirror path |
| **Per-run WIP store** | `/var/lib/agent-manager/runs/<id>/wip.git` (bare, server-local) | Bound to the run row — deleted when the run is deleted | One ref: `refs/heads/wip`. Points at the latest snapshot commit. Ancestry includes any unpushed real commits. | FBI only (container pushes via bind mount) |

The container has one working git repo at `/workspace/.git` with two remotes:

- `origin` → user's GitHub
- `fbi-wip` → `/fbi-wip.git` (bind mount of the host-side bare repo)

The WIP store is bare (no working tree) and local (bind-mounted, not network). Pushes to it are local filesystem ops — fast, offline, no auth.

## Branch Policy — `(A′)` Shadow + Mirror

**Every run owns exactly one origin branch: `claude/run-N`**, where `N` is the run id. Sole-writer contract: the only git process pushing to this ref is *this run's container*. Under this contract, fast-forward push is always the right update; divergence is impossible except through external contract violation.

Concretely, at run-start (`supervisor.sh`):

1. Clone origin.
2. If `FBI_CHECKOUT_BRANCH` is set, `git checkout <that>` first — for the agent's *context*, not as a push target.
3. `git checkout -b claude/run-$RUN_ID`.
4. `git push -u origin claude/run-$RUN_ID` — creates the branch on origin immediately, so the UI has a target from second one.
5. `git remote add fbi-wip /fbi-wip.git`.

**Preamble change.** Today's preamble tells the agent to "create or check out a branch appropriately named…". Under this design, FBI has already created `claude/run-N`. New wording:

> "You are working on branch `claude/run-N`. Make all commits here. Do NOT push to or modify any other branch."

### Mirror

When a run was pointed at a user feature branch (i.e., `run.base_branch != project.default_branch`), the post-commit hook does **two pushes** per commit:

1. `git push origin claude/run-N` — primary. Always succeeds (sole writer).
2. `git push origin claude/run-N:$BASE_BRANCH` — mirror, fast-forward only. Best effort.

If the mirror push is rejected (user advanced the branch externally, someone else committed), the hook **does not retry and does not fail the run**. The canonical state remains safe on `claude/run-N`. The server reads the push exit code from `/tmp/last-push.log` and sets a per-run `mirror_status` that the UI surfaces prominently.

**Mirror state surface (Ship tab addition — minimal):** one banner row above the existing Ship sections when `mirror_status == 'diverged'`:

> ⚠ Mirror to `terminal-robust-redesign` is out of sync.
> Last mirrored: `abc1234`. Your branch is now at `def5678`.
> [Rebase `claude/run-42` onto your branch & retry] · [Stop mirroring]

The **Rebase & retry** action is a new op on `fbi-history-op.sh` (`mirror-rebase`): fetch `$BASE_BRANCH` from origin, rebase `claude/run-N` onto it, force-push `claude/run-N`, retry the mirror push. Idempotent.

**Stop mirroring** sets `run.base_branch = NULL` and `run.mirror_status = NULL`; subsequent commits push only to `claude/run-N`. (`base_branch = NULL` means "treat as project default"; since claude/run-N ≠ project default by construction, no mirror fires.)

### DB schema additions

Two new columns on `runs`:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `base_branch` | `TEXT` nullable | `NULL` (treated as project default when read) | The branch the run is "about" — mirror target, Ship-tab merge/PR target, Changes-tab `ahead/behind` reference. Set at run-start from `FBI_CHECKOUT_BRANCH` if provided. |
| `mirror_status` | `TEXT` nullable | `NULL` (means "none / no mirror configured") | One of `'ok'` (last mirror push succeeded), `'diverged'` (last mirror push rejected), or `NULL` (no mirror — `base_branch` equals the project default). Written by the orchestrator after it reads each post-commit hook's exit in `/tmp/last-push.log`. |

Also a new run state value: `'resume_failed'` (for the Q4 path). Added to the existing state enum, handled like `'failed'` for UI filtering purposes but distinguished by the Changes-tab banner.

`base_branch` drives three places:

- The mirror push target (post-commit hook's second push).
- Ship-tab merge / sync / PR ops — server-side handler uses `run.base_branch ?? project.default_branch` as the base instead of hardcoding the project default.
- The "ahead/behind" counts in the Changes-tab branch header.

No UI changes needed for the Ship tab itself — merge/sync buttons already POST the run id and take action server-side; the server just computes the base differently. The Changes-tab branch header already reads `branch_base.base` from the API payload, so the server needs to populate it from `run.base_branch` rather than from a hard-coded project default.

### Migration for existing runs

On first resume of a pre-existing run (one whose `branch_name` is NOT `claude/run-N`):

1. Clone origin; check out the old branch for reference.
2. `git checkout -b claude/run-$RUN_ID` from the old branch's tip.
3. `git push -u origin claude/run-$RUN_ID`.
4. Update DB: `runs.branch_name = 'claude/run-N'`; `runs.base_branch = <old branch>` (so the mirror fires for it going forward).
5. The old branch on origin is left untouched. No force-push, no delete.

## Components

Three new units:

### `src/server/orchestrator/wipRepo.ts`

Server-side module owning the host-side bare repo.

```ts
export function init(runId: number): string  // returns absolute path, creates `/var/lib/agent-manager/runs/<id>/wip.git` if absent
export function path(runId: number): string  // absolute path, no side effects
export function exists(runId: number): boolean
export function remove(runId: number): void  // idempotent `rm -rf`
export function readSnapshotFiles(runId: number): Array<FilesDirtyEntry>  // `git show --name-status wip`
export function readSnapshotDiff(runId: number, filePath: string): FileDiffPayload
```

- `init` uses `git init --bare` with `core.sharedRepository=group`, chowns to the FBI service user with GID matching the container's `agent` user (same mechanism as the docker-socket forwarding added in `35edb0f`).
- `readSnapshotFiles` and `readSnapshotDiff` let the server render WIP without docker exec'ing into a container (container may not exist).

### `src/server/orchestrator/fbi-wip-snapshot.sh`

Container-side POSIX sh script, bind-mounted at `/usr/local/bin/fbi-wip-snapshot.sh`. Sole job: capture the current working-tree state into a commit object on top of `HEAD`, push it to `fbi-wip/wip`, leave HEAD / index / working tree untouched.

Core logic (approximate):

```sh
#!/bin/sh
set -u
cd /workspace || { printf '{"ok":false,"reason":"no-workspace"}\n'; exit 0; }

# Skip if nothing to snapshot.
if [ -z "$(git status --porcelain)" ]; then
  last=$(git rev-parse --verify -q refs/remotes/fbi-wip/wip || echo '')
  printf '{"ok":true,"sha":"%s","noop":true}\n' "$last"
  exit 0
fi

parent=$(git rev-parse HEAD)

# Use a temporary index so we can stage everything without touching the real one.
tmp_index=$(mktemp)
cp "$(git rev-parse --git-dir)/index" "$tmp_index" 2>/dev/null || :
export GIT_INDEX_FILE="$tmp_index"
git add -A
tree=$(git write-tree)
unset GIT_INDEX_FILE
rm -f "$tmp_index"

# Write the snapshot commit and push it.
msg="fbi wip snapshot $(date -u +%s) run=${FBI_RUN_ID:-?}"
commit=$(printf '%s\n' "$msg" | git commit-tree "$tree" -p "$parent")

if ! out=$(git push --force --quiet fbi-wip "$commit:refs/heads/wip" 2>&1); then
  printf '{"ok":false,"reason":"push","message":"%s"}\n' "$(printf '%s' "$out" | tr '\n' ' ' | sed 's/"/\\"/g')"
  exit 0
fi

printf '{"ok":true,"sha":"%s"}\n' "$commit"
```

Output contract mirrors `fbi-history-op.sh`: one JSON line on stdout, exit 0 on structured success or structured failure (non-zero only on unreachable preconditions). This lets supervisor call it and log the line to `/tmp/last-snapshot.log`.

### Snapshot daemon (in `supervisor.sh`)

A tiny background loop, spawned before `claude` launches and killed by the existing trap at container teardown:

```sh
(
  while true; do
    sleep 30
    out=$(/usr/local/bin/fbi-wip-snapshot.sh 2>&1)
    echo "$out" > /tmp/last-snapshot.log
    # Also update /fbi-state/snapshot-status (single-line) so GitStateWatcher can surface staleness.
    printf '%s\n' "$out" > /fbi-state/snapshot-status 2>/dev/null || :
  done
) &
SNAPSHOT_PID=$!
trap 'kill "$SNAPSHOT_PID" 2>/dev/null || :' EXIT
```

One final run of the snapshot script happens in `finalizeBranch.sh` after the daemon is killed — catches anything in the 0–30s window since the last tick.

### Existing units that change

**`src/server/orchestrator/snapshotScripts.ts`** — extended to also copy `fbi-wip-snapshot.sh` into the per-run `scripts/` dir.

**`src/server/orchestrator/index.ts`** — two Binds added at container creation:

```ts
`${path.join(scriptsDir, 'fbi-wip-snapshot.sh')}:/usr/local/bin/fbi-wip-snapshot.sh:ro`,
`${wipRepo.path(runId)}:/fbi-wip.git:rw`,
```

Plus a call to `wipRepo.init(runId)` in the run-creation path, and a call to `wipRepo.remove(runId)` in the run-deletion path.

**`src/server/orchestrator/supervisor.sh`** — adds `claude/run-N` branch creation, `fbi-wip` remote registration, snapshot daemon spawn.

**`src/server/orchestrator/finalizeBranch.sh`** — no longer writes a `wip:` commit or pushes uncommitted state to origin. Kills the snapshot daemon, runs `fbi-wip-snapshot.sh` once more, writes `wip_sha` into `result.json` alongside the existing fields.

**`src/server/api/runs.ts`** — new endpoints:

- `GET /api/runs/:id/wip` → `{ ok: true, files: FilesDirtyEntry[], parent_sha: string, snapshot_sha: string } | { ok: false, reason: 'no-wip' }`
- `GET /api/runs/:id/wip/file?path=...` → `{ hunks, truncated }` (same shape as the existing `getRunFileDiff`)
- `POST /api/runs/:id/wip/discard` → clears the wip ref before a fresh resume (used by the Q4 failure banner)
- `POST /api/runs/:id/wip/patch` (GET that streams `git format-patch`) → the emergency export

**`src/web/features/runs/ChangesTab.tsx`** — new "Unsaved changes (will be restored on resume)" section, shown only when run state is not live AND `wip_sha` is present. Same `CommitRow` / `DiffBlock` components as today; just a different data source.

**`src/web/features/runs/ship/MirrorStatusBanner.tsx`** (new) — yellow banner at the top of the Ship tab when `run.mirror_status === 'diverged'`, with the two action buttons.

## Data Flow — Lifecycle

### Run-start

```
1. Server: runs.create → wipRepo.init(runId)
2. Server: createContainerForRun with two new Binds (wip.git rw, fbi-wip-snapshot.sh ro)
3. Container starts; supervisor.sh:
   a. Clone origin.
   b. If FBI_CHECKOUT_BRANCH: git checkout <that> (context only).
   c. git checkout -b claude/run-N
   d. git push -u origin claude/run-N
   e. git remote add fbi-wip /fbi-wip.git
   f. Spawn snapshot daemon.
   g. Launch claude.
```

### During the run

```
Agent commits → post-commit hook:
  1. git push origin claude/run-N               (primary; always fast-forwards)
  2. if base_branch != default:
        git push origin claude/run-N:$BASE_BRANCH   (mirror; best-effort)

Every 30s → fbi-wip-snapshot.sh:
  - If tree unchanged vs parent: no-op.
  - Else: write tree, commit-tree on top of HEAD, force-push to fbi-wip/wip.

GitStateWatcher (server) → polls `docker exec git status` every 2s, unchanged.
```

### Clean finalize

```
finalizeBranch.sh:
  1. Kill snapshot daemon.
  2. Run fbi-wip-snapshot.sh one last time.
  3. Write /tmp/result.json with:
     { exit_code, push_exit (last mirror attempt's code, or 0), head_sha,
       branch: "claude/run-N", wip_sha: "<snapshot>" | "" }
```

### Unclean termination (SIGKILL, OOM, Docker daemon restart, auto-resume tear-down)

No finalize runs. The last periodic snapshot in `fbi-wip/wip` is the persisted state. Nothing else required on teardown.

### Resume

```
1. Server: resume(runId). Creates a fresh container with the same Binds.
2. supervisor.sh (augmented resume branch):
   a. Clone origin; checkout claude/run-N.
   b. git remote add fbi-wip /fbi-wip.git
   c. git fetch fbi-wip
   d. If refs/remotes/fbi-wip/wip doesn't exist: no WIP to restore; skip to (h). (Fresh-resume path.)
   e. Compute parent = `git rev-parse fbi-wip/wip^`.
      Verify: `git merge-base --is-ancestor origin/claude/run-N parent`.
        - If NOT ancestor (divergence case): goto restore_failed.
        - If ancestor (happy path, or snapshot ancestry has unpushed commits):
            git reset --hard parent      # HEAD now at snapshot's parent
            # If parent != origin/claude/run-N (unpushed commits in snapshot ancestry),
            # push them so origin catches up:
            git push origin claude/run-N
   f. git read-tree --reset -u fbi-wip/wip
      # Working tree + index now match the snapshot's tree; HEAD stayed at the snapshot's parent.
   g. Spawn snapshot daemon.
   h. Launch claude --resume $FBI_RESUME_SESSION_ID.

restore_failed:
  Write /tmp/result.json with { stage: "restore", error: "diverged" | "branch-missing",
                                parent_sha, snapshot_sha, origin_tip }.
  Exit non-zero. Server reads this and sets run state to 'resume_failed'.
```

### Resume-failure UI

When a run is in state `resume_failed`, the Changes tab shows a blocking banner:

> ⚠ Couldn't restore unsaved changes: `origin/claude/run-42` diverged from the snapshot's parent.
>
> Snapshot parent: `abc1234`
> Origin tip:      `ff99be2`
>
> [Download WIP as patch] · [Discard WIP and resume fresh] · [Cancel]

- **Download WIP as patch** — `GET /api/runs/:id/wip/patch` streams `git format-patch <parent>..<snapshot>`.
- **Discard WIP and resume fresh** — `POST /api/runs/:id/wip/discard` (clears `wip` ref), then re-invokes resume. New container starts without restore step.
- **Cancel** — goes back to the run list.

### Delete run

```
Server: runs.delete →
  1. wipRepo.remove(runId)  # rm -rf /var/lib/agent-manager/runs/<id>/wip.git
  2. Best-effort: git push origin --delete claude/run-N
     (done only if run.branch_name starts with 'claude/' — never delete user-named branches)
```

The implementation plan should confirm today's `runs.delete` behavior around remote-branch deletion and preserve the "only delete FBI-owned branches" invariant.

## Error Handling / Failure Modes

All failures follow one principle: **WIP is additive durability; its absence never blocks the agent's work or the run's primary happy path.**

| Condition | Behavior |
|---|---|
| `wipRepo.init` fails to create the bare repo | Log + proceed without the bind mount. Run starts normally; snapshot daemon's first call fails, so no WIP durability for this run. Surface as amber "WIP unavailable" pill in the Changes tab. |
| Bind mount missing inside the container (orchestrator bug, stale run, etc.) | Supervisor's `git remote add fbi-wip /fbi-wip.git` fails; subsequent snapshots no-op. Run proceeds without WIP. Warn in log. |
| Snapshot daemon failures (disk full, transient git error) | Logged to `/tmp/last-snapshot.log`; daemon keeps looping. Server reads `/fbi-state/snapshot-status`; UI pill goes amber if snapshots have been failing for > 2 minutes. Agent is never blocked. |
| `wip.git` fsck failure on container startup | Skip snapshots entirely for this container. Log. Run proceeds. |
| Restore divergence on resume | Fail loud. Run state → `resume_failed`. Changes-tab banner with the three-action menu. |
| Mirror push rejected | Log. Set `run.mirror_status = 'diverged'`. Surface via Ship-tab banner. Primary push to `claude/run-N` was unaffected — no run failure. |
| Primary push to `claude/run-N` rejected (should be impossible under contract) | Indicates external contract violation. Log, fail finalize loudly, expose structured error in `result.json`. |

## Testing Strategy

### Unit (vitest, server-side)

- `wipRepo.test.ts` — init creates bare repo with correct permissions; `remove` is idempotent; `readSnapshotFiles` returns correct entries against a fixture bare repo.
- `snapshotScripts.test.ts` (existing) — extended: asserts `fbi-wip-snapshot.sh` is copied into the run's scripts dir.
- `finalizeBranch.test.ts` (existing) — assertions updated: finalize no longer writes a "wip" commit, no longer pushes uncommitted state to origin; it invokes the snapshot script once and records `wip_sha`.
- `historyOp.test.ts` — new case for `mirror-rebase` op (fetch base, rebase, force-push, re-mirror).
- `runs.api.wip.test.ts` (new) — exercises all four new endpoints against a fixture `wip.git`.

### Shell (POSIX, run in throwaway containers with local git fixtures)

- `fbi-wip-snapshot.sh`: happy-path snapshots tracked + staged + untracked files; no-change tick exits cleanly without pushing; working tree / HEAD / index unchanged after every call.
- Resume restore steps (extracted as a helper script if supervisor.sh grows unwieldy): given a sample `wip.git` and an origin clone, working tree ends at `claude/run-N` tip with snapshot tree applied; divergence case produces the structured `/tmp/result.json`.

### Integration (vitest + real docker, gated by `FBI_DOCKER_TESTS=1`)

- `orchestrator.wip.happy.test.ts` — spin up a real run container, make a few commits and uncommitted changes, wait for one snapshot tick, assert `wip.git/wip` exists and has the expected tree; tear down; resume; assert the new container ends in the same uncommitted state.
- `orchestrator.wip.crash.test.ts` — same setup; SIGKILL the container between a snapshot and clean shutdown; resume; assert no data loss of snapshotted state.
- `orchestrator.mirror.test.ts` — post-commit mirror push succeeds when fast-forward; mirror_status flips to `'diverged'` and does not retry when user pushes to the feature branch externally.
- `orchestrator.resume_failed.test.ts` — force-push `origin/claude/run-N` to an unrelated commit; resume; assert `result.json` has `stage: "restore", error: "diverged"` and run state is `resume_failed`.

### Web (react-testing-library)

- `ChangesTab.wip.test.tsx` — renders the "Unsaved changes" section when the payload from `/api/runs/:id/wip` is present; omits it when `no-wip`.
- `ChangesTab.resume_failed.test.tsx` — renders the blocking banner; the three buttons fire the right API calls.
- `MirrorStatusBanner.test.tsx` — renders only when `mirror_status === 'diverged'`; both actions wire through to `useHistoryOp` / settings endpoints correctly.

### Manual smoke (plan-end)

- Full Playwright walkthrough: start a run targeting a non-default branch; make a commit; confirm mirror pushes; advance the user branch externally; confirm the yellow banner appears on Ship; click Rebase & retry; confirm the mirror reattaches.

## Decisions Locked In

| # | Question | Choice | Notes |
|---|---|---|---|
| Q1 | Branch ownership policy | **`(A′)` always-agent-owned + best-effort mirror** | `claude/run-N` is the canonical state; feature branches get mirrored when `base_branch != default` |
| Q2 | UI visibility of WIP | **(B)** Read-only "Unsaved changes (will be restored on resume)" section in the Changes tab when run is not live and `wip_sha` exists | |
| Q3 | Snapshot cadence | **(C)** Periodic every 30s + one final call at finalize; in-container daemon | Configurable cadence is phase 2 |
| Q4 | Restore conflict behavior | **(A)** Fail loud; run state → `resume_failed`; three-button banner | Under sole-writer contract this should be vanishingly rare |
| — | Storage topology | **Dual repo**: ephemeral `/workspace/.git` in container, durable bare `/var/lib/agent-manager/runs/<id>/wip.git` on host, bind-mounted in as `/fbi-wip.git` | Phase-2 option: promote to a full per-run mirror of origin if disk speed or offline resilience matter |

## Known Costs / Follow-ups

1. **User who starts a run against their feature branch** still has to do one action (or wait for the mirror) to see commits on that branch. If the mirror hasn't fired yet (very new commit) or failed (divergence), there's a window where the feature branch looks stale. This is intrinsic to the shadow model; acceptable cost for durability.
2. **Promote UX ("merge `claude/run-N` into `X`")** is deferred. For phase 1, users route through GitHub PR retargeting or manual cherry-pick. Phase 2 adds a dedicated Ship-tab action.
3. **Multi-snapshot history** (e.g., "restore the snapshot from 10 min ago") would be an easy extension — just stop force-pushing `wip` and accumulate snapshot commits on the ref instead. Phase 2 if asked for.
4. **Cross-host portability** of `wip.git` is out of scope and currently impossible without manual export. If a user moves their FBI install between hosts, old runs' WIP would be lost. Acceptable for current FBI deployment model.
5. **Staged / unstaged / untracked distinction is flattened on restore.** The snapshot tree captures the union of staged + unstaged + untracked files. On resume, the restore applies that tree to both the index and working tree, so everything appears as "staged" relative to HEAD. No data is lost, but the agent sees a slightly different state than the instant before the snapshot (where some changes might have been unstaged or untracked). Acceptable approximation for MVP; adding parallel snapshot refs for the finer distinction is easy if it matters later.

## Open Questions for the Implementer (deliberately left)

None. The spec is intended to be unambiguous; any questions that surface during implementation planning should be raised back here for answer, not guessed at.
