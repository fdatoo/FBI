# Safeguard Store & Branch Semantics Design

## Goal

Give every run a durable, host-side, always-writable store of Claude's committed work so that runs can be browsed, resumed, and recovered independently of the user's origin — without polluting origin with any FBI-internal branches.

## Context

This supersedes `2026-04-24-wip-store-and-agent-branches-design.md`. That design made `claude/run-<id>` the canonical branch and pushed it to origin as a safety mirror, which turned out to be wrong: it pollutes the user's remote with ephemeral branches, and it couples "did we push to origin?" with "is Claude's work safe?".

The new model separates those two concerns:

- **User's branch on origin** is Claude's real output — the same thing any human collaborator would push.
- **Safeguard** is an FBI-internal, host-side store that always holds Claude's committed work, regardless of whether origin pushes succeed.

## Key decisions (from brainstorm)

- **β** — Recovery UX: failed runs can be browsed, resumed, or discarded (not cherry-picked). Requires a git-queryable store outside the container.
- **A** — Scope: committed history only. No WIP ref, no uncommitted tree capture. Mid-turn interrupts lose the current turn's uncommitted work; Claude resumes from its last commit.
- **II** — UI reads from the safeguard always. Container is pure compute; safeguard is pure storage. Retires the GitStateWatcher-in-container code path.
- **B** — Cleanup is piggy-backed on run delete. No time-based or merge-triggered GC.
- **A (divergence)** — When origin push fails, the agent keeps working. UI shows a banner; safeguard keeps mirroring; next successful push auto-clears.

## Non-goals

- Mid-turn / uncommitted state recovery (scope A).
- Multi-host durability — safeguard lives on the FBI host.
- Automatic GC based on time or merge state.
- Cherry-pick or partial recovery from a failed run.

## Architecture

### Storage layout

Each run gets a bare git repo on the host at:

```
/var/lib/agent-manager/runs/<run-id>/wip.git
```

- Created empty (`git init --bare`) when the run record is created in the database.
- Owned by the FBI server process (host user, not a container user).
- Deleted when the run is deleted via the UI.
- Not shared between runs. No alternates; each safeguard is fully independent.

### Branch semantics

On run creation, the user optionally types a branch name. If blank, FBI generates `claude/run-<id>`. The final value is stored in `run.branch_name` and is the only branch Claude pushes anywhere.

- It's what gets pushed to origin (best-effort).
- It's what gets pushed to the safeguard (always).
- There is no separate "mirror" branch on origin.

### Container lifecycle

**Startup (fresh run):**

1. FBI bind-mounts `/var/lib/agent-manager/runs/<id>/wip.git` into the container as `/safeguard`.
2. Container clones the project repo into `/workspace` (existing behavior).
3. Adds `safeguard` as a second remote: `git remote add safeguard /safeguard`.
4. Checks out the branch:
   - If `origin/<branch>` exists: `git checkout -B <branch> origin/<branch>`.
   - Else: `git checkout -b <branch>`, then `git push -u origin <branch>` (best-effort; no failure if origin is offline).
5. Installs the post-commit hook.
6. Starts the agent.

**Startup (resume of an existing run):**

Differs only in step 4:

- If `safeguard` already has `<branch>`: `git fetch safeguard <branch>` then `git checkout -B <branch> safeguard/<branch>`.
- This restores Claude's last committed state bit-for-bit.
- Any uncommitted in-flight edits from the prior container are gone (per scope A).

### Post-commit hook

Installed as `/workspace/.git/hooks/post-commit`. Runs after every commit. Both pushes run in the background so the agent isn't blocked:

```sh
#!/bin/sh
BRANCH="$(git symbolic-ref --short HEAD)"

# Safeguard: always-succeeds local push.
(
  git push safeguard "HEAD:refs/heads/$BRANCH" > /tmp/last-safeguard-push.log 2>&1 \
    || echo "fatal: safeguard push failed" >&2
) &

# Origin: best-effort.
(
  if git push --recurse-submodules=on-demand --force-with-lease \
      origin "HEAD:refs/heads/$BRANCH" > /tmp/last-origin-push.log 2>&1; then
    echo ok > /fbi-state/mirror-status
  else
    echo diverged > /fbi-state/mirror-status
  fi
) &
```

The hook uses `git symbolic-ref --short HEAD` at runtime rather than baking the branch name in at install time, so it stays correct if the agent ever switches branches (it shouldn't, but defensively).

### UI read path

The FBI server reads run state from the safeguard bare repo directly, not from the container:

- `/changes` opens `/var/lib/agent-manager/runs/<id>/wip.git` with `nodegit` / `simple-git` / raw `git` CLI and constructs `ChangesPayload` (commits list, diffs, file tree) against the project's default base branch.
- WebSocket change notifications come from a host-side watcher on the safeguard's `refs/heads/<branch>` file — whenever the ref moves, we re-read and emit.
- Container-side `GitStateWatcher` and the in-container `/fbi-state` publishing path for ChangesPayload are retired.

Implication: mid-turn uncommitted changes are never shown in the UI. This is fine under scope A — Claude commits before finishing a turn.

### Divergence UX

The container's post-commit hook writes `ok` or `diverged` to `/fbi-state/mirror-status` after each origin-push attempt. FBI mirrors this to `run.mirror_status` in the database.

When `mirror_status === 'diverged'`:

- Ship tab shows `MirrorStatusBanner` with copy describing the divergence and two actions:
  - **Sync & retry** — runs the `sync` history op (rebase local onto origin/<branch>, push again).
  - **Dismiss** — silences the banner for this run without nuking any state. (Contrast with today's `clearRunBaseBranch`, which is overreach.)

The agent is **not paused**. Subsequent commits keep attempting their origin push; any success auto-transitions `mirror_status` back to `ok` and the banner clears itself.

### Merge / PR flow

Ship tab's merge and "Create PR" actions read from the safeguard, but they still need commits to be on origin before merging:

1. FBI's server fetches the run's branch from the safeguard into the host-side project repo (FBI's pre-existing server-side clone used for all server-originated git operations): `git fetch /var/lib/.../wip.git <branch>:refs/heads/<branch>`.
2. From the project repo, `git push origin <branch>`.
3. If that push fails, surface the divergence and require the user to Sync & retry first.
4. If it succeeds, proceed with the merge / PR as today.

Keeping the project repo as the server's single git workspace (rather than adding `origin` to every safeguard) means only one place has credentials for the user's remote.

### Deletion

Run delete:

1. Stop the container (if running).
2. `rm -rf /var/lib/agent-manager/runs/<id>/wip.git`.
3. Delete the row from the `runs` table.

No separate "archive" option in v1. Users who want to preserve state can simply not delete the run.

## Edge cases

### No-remote projects

Some projects have no `origin` remote configured (e.g., local-only scratch projects).

- Detect at container startup (`git remote get-url origin` fails).
- Skip the origin-push half of the post-commit hook entirely.
- `mirror_status` becomes a new value: `'local_only'` (distinct from `'ok'` and `'diverged'`).
- UI shows a muted indicator ("No remote configured — commits saved locally only") instead of the divergence banner. No action buttons; no user intervention needed.

### Submodules

`--recurse-submodules=on-demand` is already in the post-commit hook for origin. For the safeguard push, submodule objects **don't** go to the safeguard:

- The superproject commit references submodule commits by SHA.
- Submodule objects live on origin (or wherever the submodule's own remote is).
- If origin is up to date, the references resolve. If not, submodule resolution degrades gracefully (same as any git client seeing a ref to an unknown commit).

Keeping submodule objects out of the safeguard keeps the store small and matches today's submodule handling.

### Concurrent runs on the same branch

If two runs are created with the same `branch_name`, they'll race on the force-pushes to origin and produce a confusing state.

- On run create, check whether any non-terminal run already holds this `branch_name`.
- If one does: warn the user ("Run #X is already using branch `foo`; starting another run on the same branch will cause them to overwrite each other's pushes") and offer a choice: use a different branch or proceed anyway.
- Don't outright block; the user might know what they're doing.

## Migration from current state

The current tree (commit `82fae0f` on `change-management-rework`) has:

- Primary branch = user's typed branch with a mirror-push to origin's `claude/run-<id>` — **wrong, origin pollution**.
- `fbi-wip-snapshot.sh` / `fbi-resume-restore.sh` scripts that snapshot working-tree state into a host-side bare repo — **partly right, we keep these**.
- `GitStateWatcher` reads from the live container — **changes under II**.

### Changes required

1. **supervisor.sh:** Drop the `MIRROR_BRANCH` concept. Drop the "initial mirror push of claude/run-N" block. Keep the primary-branch logic but also add `git remote add safeguard /safeguard` and change the resume path to fetch from safeguard.

2. **Post-commit hook:** Replace the current dual-push-to-origin shape with the safeguard-plus-origin shape from the design. Background both. Write `mirror_status` only based on the origin outcome.

3. **Orchestrator (`src/server/orchestrator/index.ts`):** Ensure the safeguard bare repo is created at run-create time and bind-mounted at container-start time. Drop env plumbing for the old mirror-branch concept.

4. **`fbi-wip-snapshot.sh` / `fbi-resume-restore.sh`:** Remove. Under A, snapshotting is what the post-commit hook already does, and restoring is the resume branch of supervisor.sh's startup logic. No separate scripts are needed.

5. **`GitStateWatcher` → safeguard watcher:** Replace the in-container watcher with a host-side `fs.watch` on the safeguard's `refs/heads/<branch>` file. WebSocket emit on change.

6. **`/changes` endpoint:** Change the source from the live container's `.git` to the host-side safeguard. Requires a small server-side library for reading bare git repos.

7. **`MirrorStatusBanner` copy:** Already updated in `82fae0f` for the inverted semantics. Confirm it still reads correctly under the new model (it should — "branch diverged on origin" matches). Replace the `clearRunBaseBranch` call on Dismiss with a `dismissMirrorBanner` that just flips a UI state flag (or per-run persistent dismissal).

8. **Run-delete flow:** Add `rm -rf /var/lib/agent-manager/runs/<id>/wip.git` to whatever code path handles run deletion today.

9. **Concurrent-branch check:** Add a check at run-create time and return a 409 (or present a confirm dialog in the UI) when another active run owns the branch.

10. **No-remote detection:** Add `mirror_status='local_only'` as a valid value; update the UI banner switch to surface a muted indicator instead of the divergence one.

## Success criteria

- A run whose origin push fails (diverged, offline, or absent remote) still shows all of Claude's work in the Ship tab and can be resumed.
- A failed / crashed run can be opened in the UI and browsed; commits, diffs, and file tree all render.
- No branches named `claude/run-<id>` ever appear on origin unless the user explicitly chose that name.
- Deleting a run removes both the row and the host-side bare repo; no stale safeguard directories.
- Two concurrent runs on distinct branches never interfere with each other's safeguards.
