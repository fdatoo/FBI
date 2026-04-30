# FBI — Post-v1 P1 Improvements Design

**Date:** 2026-04-21
**Project:** FBI
**Status:** Draft — pending user review
**Backlog reference:** [`docs/feature-gaps.md`](../../feature-gaps.md)

## 1. Overview

Four independent improvements on top of v1. Each is self-contained and can be
planned/implemented in isolation; they share this spec because they surfaced
together as the P1 tier from the post-v1 gap evaluation.

### Scope

| # | Feature | Category | Why P1 |
|---|---------|----------|--------|
| 1 | Claude-owned branch naming + follow-up runs | A. Run iteration | Auto-named `claude/run-<id>` branches prevent real iteration; the operator can't easily continue prior work. |
| 2 | Recent-prompt dropdown on NewRun | A. Run iteration | Re-pasting the same prompt is the highest-friction part of iteration. |
| 3 | Completion notifications | B. Visibility | Runs take minutes to hours; babysitting tabs is the operator's biggest time tax. |
| 4 | Per-container resource caps | D. Safety & limits | `--dangerously-skip-permissions` on the operator's personal box with no caps is a real risk. |

### Non-goals in this spec

- Named/curated prompt templates. Deferred until re-paste patterns reveal what's worth curating.
- `parent_run_id` or any explicit parent/child run link. Lineage via shared branch name is enough for v1.
- Webhooks, email, or SSE for notifications. Polling is fine at this scale.
- Disk quota on containers. Workspace is bounded by anon-volume lifetime; image-cache growth is Category D / Image GC, not this spec.
- Cross-project global prompt templates. `settings.global_prompt` already covers the coarse case.

---

## 2. P1 #1 — Claude-owned branch naming and follow-up runs

### 2.1 Goal

Stop pre-computing branch names at run-submit time. Let Claude choose, optionally
steered by an operator-supplied hint. Collapse "follow-up run" into "new run on
an existing branch."

### 2.2 Design

**Prompt preamble** — prepended to every run, before global prompt and project
instructions. Two forms, picked at run start based on whether the NewRun form's
"Branch name" field was filled:

*Hinted form* (field was `fix-login-bug`):

```
You are working in /workspace on <repo_url>.
Its default branch is <default_branch>. Do NOT commit to <default_branch>.
Create or check out a branch named `fix-login-bug`,
do your work there, and leave all commits on that branch.
```

*Blank form* (field was empty):

```
You are working in /workspace on <repo_url>.
Its default branch is <default_branch>. Do NOT commit to <default_branch>.
Create or check out a branch appropriately named for this task,
do your work there, and leave all commits on that branch.
```

**Supervisor changes** (`src/server/orchestrator/supervisor.sh`):
- Remove the pre-existing `git checkout -b "$BRANCH_NAME" "origin/$DEFAULT_BRANCH"`.
- After clone, stay on the cloned default branch's HEAD.
- Claude runs; may switch/create branches freely.
- After Claude exits: `git add -A && git commit -m "wip: claude run $RUN_ID"` if dirty.
- If `git rev-parse --abbrev-ref HEAD` equals `$DEFAULT_BRANCH`, Claude never branched. Move HEAD onto fallback branch `claude/run-$RUN_ID` so we never push to default.
- `git push -u origin HEAD`.
- Record the actual branch name in `/tmp/result.json`.

**Result JSON** — add `branch`:

```json
{"exit_code": 0, "push_exit": 0, "head_sha": "...", "branch": "fix-login-bug"}
```

**Data model** (`runs.branch_name`):
- Kept `NOT NULL`. Inserted as the operator's hint when present, otherwise empty string `""`. Rewritten from `result.json.branch` on run completion. (This avoids the SQLite column-nullability-change dance.)
- The hint (or `""`) is passed to the supervisor as `$BRANCH_NAME` purely so it can surface the value in logs if needed. The supervisor no longer pre-creates a branch — Claude owns branching, steered by the preamble.

**NewRun form** (`src/web/pages/NewRun.tsx`):
- New optional "Branch name" text input between project header and the prompt textarea.
- Placeholder: *"leave blank to let Claude choose"*.
- Reads `?branch=` query param on mount and pre-fills the field.

**RunDetail** (`src/web/pages/RunDetail.tsx`):
- "Follow up" button enabled when `state ∈ {succeeded, failed, cancelled}` AND `branch_name` is a non-empty string.
- Click → `navigate(/projects/<project_id>/runs/new?branch=<branch_name>)`.

### 2.3 Edge cases

- **Claude doesn't branch.** Supervisor detects `HEAD == default_branch`, creates fallback `claude/run-<id>`, pushes. Logged, not errored.
- **Claude switches branches mid-run.** Only HEAD at exit is pushed. Known limitation; future spec can expand if needed.
- **Pushed branch already exists on remote and diverged.** Push fails → run marked `failed` with `error="git push failed"`. Same behaviour as today.
- **Operator hint contains invalid git ref characters.** Prose preamble is fed to Claude; if Claude creates a literally-invalid branch, push fails → run marked failed. No server-side validation in v1.

---

## 3. P1 #2 — Recent prompts dropdown

### 3.1 Goal

Eliminate re-pasting for iterative work. Zero new persistence.

### 3.2 Design

**API** — new endpoint:

```
GET /api/projects/:id/prompts/recent?limit=10
→ [{ "prompt": "...", "last_used_at": <ms>, "run_id": <int> }, …]
```

Query:

```sql
SELECT prompt, MAX(created_at) AS last_used_at, MAX(id) AS run_id
  FROM runs
 WHERE project_id = ?
 GROUP BY prompt
 ORDER BY last_used_at DESC
 LIMIT ?;
```

Exact-string dedup is sufficient for v1.

**UI** (`src/web/pages/NewRun.tsx`):
- A compact "Recent prompts ▾" dropdown above the textarea.
- Hidden entirely if the project has no prior runs.
- Selecting an item replaces the textarea contents (no merging, no prepend).
- No autosave of the current draft.

**Default limit:** 10.

### 3.3 Edge cases

- **No runs yet.** Dropdown hidden.
- **All prompts identical.** Dropdown shows one entry.
- **Very long prompt.** Dropdown items truncate to the first ~80 chars with an ellipsis; full text loads on select.

---

## 4. P1 #3 — Completion notifications

### 4.1 Goal

Stop requiring the operator to sit on a page to know when a run ends.

### 4.2 Design

**Channels — three, combined:**

1. **Browser Notification API.** OS popup on run completion. On the first terminal-state event in any tab, call `Notification.requestPermission()` if `Notification.permission === 'default'`. The browser itself remembers grant/deny; no app-side flag.
2. **Tab title prefix.** When the tab loses focus, completions accumulate into an unread count; title becomes `(N) · FBI`. Resets on focus.
3. **Favicon dot.** Favicon gains a colored dot reflecting the most recent terminal state: green (succeeded), red (failed), gray (cancelled). Resets to default on any tab focus.

**Scope — global watcher.** One `useRunWatcher` hook mounts at the SPA root
(`App.tsx`) and polls `GET /api/runs?state=running` every 5 seconds.

Algorithm per tick:
- `prevRunning: Set<runId>` is the set from the previous tick.
- `currentRunning: Set<runId>` is this tick's response.
- For every id in `prevRunning` that is not in `currentRunning`, fetch `GET /api/runs/<id>`, read its terminal state, fire all three channels.
- Write `currentRunning` into `prevRunning` for next tick.

On first tick, `prevRunning` is empty, so no spurious notifications fire for
runs that were running before the tab opened.

**Settings** — `settings.notifications_enabled` boolean (default `true`).
Settings page (`src/web/pages/Settings.tsx`) gets a "Enable notifications"
toggle. Disabled → the watcher hook short-circuits (no polling, no UI side effects).

**Data model** (`src/server/db/schema.sql`):

```sql
ALTER TABLE settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1;
```

### 4.3 Edge cases

- **First-ever terminal-state event.** Permission prompt appears once. Grant or deny, tab title and favicon still update (those don't require permission).
- **User blocks notifications.** No retry. Tab title + favicon remain functional.
- **Run starts and finishes entirely between two polls.** It never appears in `prevRunning`, so no notification. Accepted: 5 s window, unlikely in practice since our runs are minutes+.
- **Multiple FBI tabs open.** Each runs its own watcher; all notify. Acceptable noise.
- **Tab focused when completion arrives.** Browser popup fires; title/favicon don't mutate.
- **Clock skew / polling drift.** Not a concern — watcher uses set diffing, not timestamps.

---

## 5. P1 #4 — Per-container resource caps

### 5.1 Goal

Hard ceiling on any single run's blast radius. Stop a runaway agent from
taking down the host.

### 5.2 Design

**Three caps:**

| Cap | Kind | Enforced via |
|---|---|---|
| Memory | Hard (OOM-kill) | `HostConfig.Memory` (bytes) |
| CPU | Soft (throttle) | `HostConfig.NanoCpus` (10⁹ ns per CPU) |
| Pids | Hard (fork EAGAIN) | `HostConfig.PidsLimit` (int) |

No disk cap in v1 — workspace is an anon volume destroyed with the container.

**Global defaults via env vars** (parsed in `src/server/config.ts`):

| Var | Default | Unit |
|---|---|---|
| `FBI_CONTAINER_MEM_MB` | `4096` | MB integer |
| `FBI_CONTAINER_CPUS` | `2.0` | float CPUs |
| `FBI_CONTAINER_PIDS` | `4096` | integer |

**Per-project override** — three nullable columns on `projects`:

```sql
ALTER TABLE projects ADD COLUMN mem_mb INTEGER;
ALTER TABLE projects ADD COLUMN cpus REAL;
ALTER TABLE projects ADD COLUMN pids_limit INTEGER;
```

`NULL` → inherit global default at run start.

**UI** — Edit Project page gets three optional numeric inputs. Empty → `NULL`.
Placeholder shows the current global default so the operator sees the
inherited value.

**Enforcement** — in `src/server/orchestrator/index.ts` when creating the
container:

```ts
const memMb   = project.mem_mb     ?? config.containerMemMb;
const cpus    = project.cpus       ?? config.containerCpus;
const pids    = project.pids_limit ?? config.containerPids;

HostConfig: {
  Memory:    memMb * 1024 * 1024,
  NanoCpus:  Math.round(cpus * 1e9),
  PidsLimit: pids,
  // …existing binds, etc.
}
```

**OOM detection** — on `container.wait()`, inspect `waitRes.StatusCode` and
the follow-up `container.inspect()` `State.OOMKilled` flag. If OOM-killed,
set `error="container OOM (memory cap <X> MB)"` so the operator sees
the cap was the cause.

### 5.3 Edge cases

- **Operator sets mem_mb = 64.** Container dies at startup or immediately; reported as failed with OOM message. No validation — operator's mistake to fix.
- **NanoCpus < 0.1.** Runs but crawls. No lower bound.
- **Pids too low.** `git clone` or `npm` may fail to fork; failure surfaces naturally. Accepted.
- **Existing projects on first deploy.** `ALTER TABLE ADD COLUMN` → `NULL` → inherit default. No data migration.

---

## 6. Consolidated changes

### 6.1 Data model

| Table | Change |
|---|---|
| `runs` | `branch_name` semantics relaxed (empty string allowed, overwritten post-run). Column stays `NOT NULL`. |
| `projects` | Add `mem_mb INTEGER`, `cpus REAL`, `pids_limit INTEGER` (nullable). |
| `settings` | Add `notifications_enabled INTEGER NOT NULL DEFAULT 1`. |

All schema changes apply via additive `ALTER TABLE` and `schema.sql` edits;
no destructive rewrites required.

### 6.2 Environment variables

New:

- `FBI_CONTAINER_MEM_MB` (default `4096`)
- `FBI_CONTAINER_CPUS` (default `2.0`)
- `FBI_CONTAINER_PIDS` (default `4096`)

### 6.3 API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects/:id/prompts/recent?limit=10` | Recent prompts dropdown (§3) |

No other new endpoints. Existing endpoints unchanged in shape; the
`Settings` and `Project` payloads gain new fields per §4 and §5.

### 6.4 UI changes

| File | Change |
|---|---|
| `src/web/pages/NewRun.tsx` | Add optional Branch name input; add Recent-prompts dropdown; read `?branch=` query param. |
| `src/web/pages/RunDetail.tsx` | Add Follow-up button. |
| `src/web/pages/EditProject.tsx` | Add three resource-cap inputs. |
| `src/web/pages/Settings.tsx` | Add notifications toggle. |
| `src/web/App.tsx` | Mount `useRunWatcher` hook. |
| `src/web/lib/` | New `notifications.ts` helpers (permission, show, favicon, title prefix). |

### 6.5 Server changes

| File | Change |
|---|---|
| `src/server/config.ts` | Parse three new container caps. |
| `src/server/db/schema.sql` | All schema additions. |
| `src/server/db/projects.ts` | Read/write three new cap columns. |
| `src/server/db/settings.ts` | Read/write `notifications_enabled`. |
| `src/server/db/runs.ts` | Accept `branch_name=""` on insert; `markFinished` accepts a new `branch` field to overwrite. |
| `src/server/api/projects.ts` | `/api/projects/:id/prompts/recent` route. |
| `src/server/api/runs.ts` | Accept optional `branch` on POST `/api/projects/:id/runs`. |
| `src/server/orchestrator/index.ts` | Remove pre-computed branch; pass resource caps via HostConfig; record OOM; read `branch` from result JSON; overwrite `runs.branch_name` on completion; compose prompt preamble with hint. |
| `src/server/orchestrator/supervisor.sh` | Drop pre-`checkout -b`; post-run HEAD detection + fallback; push HEAD; include `branch` in result JSON. |

---

## 7. Open questions / known unknowns

1. **Favicon rendering.** The cleanest approach is a canvas-drawn 32×32 favicon rewritten via `<link rel="icon">` replacement. Will confirm during implementation — if the setup is heavier than expected, fall back to tab-title-only with favicon deferred.
2. **Notification permission timing.** Prompting on the *first* terminal-state event (rather than at page load) avoids a permission dialog on a brand-new install with no context. This choice is in the design; revisit if it feels awkward in use.
3. **Supervisor change and in-flight runs.** If the server is restarted mid-run, the existing recovery path marks the run failed, so we never observe a cross-version supervisor run. The supervisor's backwards-compat behaviour (accepting a non-empty `$BRANCH_NAME`) is belt-and-suspenders, not load-bearing.
4. **CPU soft-throttle visibility.** The operator won't see *why* a run is slow if it's CPU-bound at the cap. Not addressed in v1; could be added as a `/api/runs/:id/stats` later.

---

## 8. Implementation order (suggested)

Independent, so any order works. Recommended by risk:

1. **§5 resource caps** first — lowest-risk, pure additive safety net.
2. **§3 recent prompts** — tiny, high-value quality-of-life.
3. **§4 completion notifications** — medium-sized; lots of small UI bits.
4. **§2 branch autonomy + follow-up** last — touches the supervisor and the runs lifecycle, the highest-blast-radius change.
