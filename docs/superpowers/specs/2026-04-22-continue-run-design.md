# Continue failed/cancelled runs — design

**Status:** draft · 2026-04-22
**Scope:** server + UI. A user-initiated "Continue" action that revives any terminated run (`failed`, `cancelled`, or `succeeded`) by re-entering Claude's saved session (`claude --resume <session-id>`). Builds on the auto-resume infrastructure already in place: reuses `createContainerForRun`, reuses the supervisor's `--resume` branch, reuses the log/stream primitives. Introduces one supervisor-level change — branch checkout on resume — that also tightens the existing auto-resume path.

## 1. Goals & non-goals

### Goals

- When a run fails (OOM, rate-limit cap hit, uncaught exception) or was cancelled by mistake, the user can pick up the conversation exactly where Claude left off without starting a fresh prompt.
- Exactly one UI action; internal details (session lookup, branch checkout, attempt counter reset) stay invisible.
- Same run id and same log stream across the failure and the continuation — the UI shouldn't grow a second row per revival.
- Auto-resume inside a continuation still works; it just counts from zero again.
- Fix the pre-existing divergence where auto-resume always re-clones to default branch, orphaning any WIP commit the previous attempt pushed. After this change, both auto-resume and continue check out the run's branch when one exists.

### Non-goals

- Editing the prompt before continuing — the saved session is the whole point; if the user wants a different prompt, they start a new run.
- Surfacing continue actions outside `RunDetail` — no inline list-row button, no project-level shortcut. Continue is a considered action.
- Server-side dedupe across concurrent clicks beyond what the state machine already gives us (second click hits a run that's no longer `failed`/`cancelled` and gets rejected).
- Recovering from session file loss — if the JSONLs on disk are gone, continue is not offered. There's no rehydration from logs or backups.

## 2. Architecture

### Happy path

1. User opens `RunDetail` for a run in `failed`, `cancelled`, or `succeeded`. The page includes a "Continue" button, disabled with a tooltip when `claude_session_id` is null.
2. User clicks. UI issues `POST /api/runs/:id/continue`.
3. Server handler calls `orchestrator.continueRun(runId)`.
4. `continueRun` validates eligibility (state, session id, session file presence on disk). If any check fails, it throws `ContinueNotEligibleError` with a machine-readable `code` and a human message.
5. On success: orchestrator opens `LogStore(run.log_path)` in append mode, emits `[fbi] continuing from session <id>` into the stream, resets `resume_attempts = 0`, clears `finished_at`/`exit_code`/`error` via `runs.markContinuing(runId, containerId)`, transitions the row `failed|cancelled|succeeded → running`.
6. Container is created via the existing `createContainerForRun(runId, { resumeSessionId, branchName })` — `resumeSessionId` from `run.claude_session_id`, `branchName` from `run.branch_name`. Both become env vars (`FBI_RESUME_SESSION_ID`, `FBI_CHECKOUT_BRANCH`) passed to supervisor.
7. Supervisor clones the repo, checks out `FBI_CHECKOUT_BRANCH` (falling through to `$DEFAULT_BRANCH` if the branch doesn't exist remotely), skips prompt composition (already true when `FBI_RESUME_SESSION_ID` is set after the earlier fix), runs `claude --resume`.
8. Normal `awaitAndComplete` flow resumes. If this attempt hits a rate limit, auto-resume behaves exactly as for a fresh run — classifies, schedules, resumes — now counting from `resume_attempts=1`.

### Modules & boundaries

- **`Orchestrator.continueRun(runId: number): Promise<void>`** — new method on the existing class. Shares `createContainerForRun` and `awaitAndComplete` with `launch`/`resume`. The only ceremony it owns is eligibility checks and the `markContinuing` transition.
- **`ContinueEligibility`** (`src/server/orchestrator/continueEligibility.ts`) — pure function `check(run, runsDir)` that returns `{ ok: true } | { ok: false, code, message }`. Encapsulates the state + session-id + session-file-on-disk rules. Lets us unit-test the rules without spinning up a container or a docker stub.
- **`RunsRepo.markContinuing(id, containerId)`** — new DB method. Transitions `failed|cancelled|succeeded → running`, sets `container_id = ?`, resets `resume_attempts = 0`, clears `finished_at`, `exit_code`, `error`. Symmetric to the existing `markResuming` except for the counter reset and the broader source-state set.
- **`supervisor.sh`** — gains one conditional: `if [ -n "$FBI_CHECKOUT_BRANCH" ]; then git checkout "$FBI_CHECKOUT_BRANCH" || git checkout "$DEFAULT_BRANCH"; else git checkout "$DEFAULT_BRANCH"; fi`. Replaces the unconditional `git checkout $DEFAULT_BRANCH`. The `||` fallback handles the race where a run died before pushing the branch.
- **`createContainerForRun`** — signature gains an optional `branchName: string | null` alongside `resumeSessionId`. Both map to env vars. `launch()` passes `null`/`null`; `resume()` passes session + branch; `continueRun()` passes session + branch. No behavior change for fresh launches.
- **HTTP endpoint** (`src/server/api/runs.ts`) — `POST /api/runs/:id/continue`. Returns 204 on success, 404 if the run doesn't exist, 409 with `{ code, message }` on ineligibility, 500 on unexpected orchestrator error. No request body.
- **UI** — extend `RunHeader` (`src/web/features/runs/RunHeader.tsx`), which already owns the per-state action row (Follow up, Cancel, More ▾). Add an `onContinue: () => void` prop and a `<Button variant="primary" size="sm">Continue</Button>` rendered when `run.state ∈ {failed, cancelled, succeeded}`. Disabled with a tooltip when `run.claude_session_id == null`. `RunDetail.tsx` wires the handler to a fetch of the new endpoint; no new standalone component needed.

### Data flow

```
User click
  → POST /api/runs/:id/continue
  → Orchestrator.continueRun
      → ContinueEligibility.check                    (pure)
      → RunsRepo.markContinuing                      (state row → running, counters reset)
      → createContainerForRun(opts with branch)      (existing, extended signature)
      → supervisor.sh                                (FBI_CHECKOUT_BRANCH + --resume)
      → awaitAndComplete                             (existing, includes auto-resume logic)
  → 204
```

WebSocket state frames are emitted via `publishState(runId)` at each transition — same as today.

## 3. State machine

No new enum values. The existing `RunState` covers everything:

```
queued
  ↓ launch()
running ──────────────┐
  ↓ rate limit        │
awaiting_resume       │
  ↓ resume()          │
running               │
  ↓ (success / fail / cancel)
succeeded | failed | cancelled
  ↓ continueRun()     │
running ──────────────┘
```

`continueRun` is the only transition out of `failed`/`cancelled` back into `running`.

`resume_attempts` is a single counter. `markAwaitingResume` bumps it, `markContinuing` resets it. That means "auto-resume cap" measures consecutive automatic resumes within a single user intent — exactly what the cap is meant to guard against.

## 4. Eligibility check

`ContinueEligibility.check(run, runsDir)`:

1. `run.state ∈ {failed, cancelled, succeeded}` — otherwise `code: 'wrong_state'`.
2. `run.claude_session_id != null` — otherwise `code: 'no_session'`.
3. `fs.existsSync(runMountDir(runsDir, run.id))` AND the directory contains at least one `.jsonl` file — otherwise `code: 'session_files_missing'`.

Check #3 is `O(readdir)` on one directory tree, only triggered on click. We don't annotate run rows with "has session files" — it's not worth the write pressure and it'd drift.

## 5. HTTP API

```
POST /api/runs/:id/continue

204 No Content                   — orchestrator accepted the continuation
404 Not Found                    — no such run id
409 Conflict                     — { code: 'wrong_state'|'no_session'|'session_files_missing', message }
500 Internal Server Error        — { message } for any unexpected error
```

Idempotency: a second POST while the run is `running` again returns 409 `wrong_state`. We don't need request deduplication on the client — the button hides as soon as the state changes.

## 6. UI

- `RunHeader` gains a **Continue** button. Visible when `run.state ∈ {failed, cancelled, succeeded}`. Disabled with tooltip *"No session captured — start a new run instead."* when `claude_session_id` is null.
- On click: `POST`, then optimistically disable the button. On 204, the WebSocket `state` frame drives the re-render (button disappears when state flips to `running`). On 409, show the server's human message in a toast / inline error. On other errors, generic "Could not continue this run" message.
- No confirmation dialog. The action is reversible by `cancel`.

## 7. Testing

- `continueEligibility.test.ts` (pure): each failure code has its own test; happy case too. Uses `fs` with tmpdirs for the session-files check.
- `runs.test.ts`: new cases for `markContinuing` — asserts state transition from both `failed` and `cancelled`, counter reset, error/exit field clearing. Symmetry check vs. `markResuming`.
- `continue.flow.test.ts`: stubbed-docker flow test in the style of `autoResume.flow.test.ts`. Sets up a `failed` run with a session id and a tmp session JSONL; calls `continueRun`; asserts the new container was created with the right env vars and the final state is `succeeded`.
- `supervisor.test.ts`: extend existing suite with two new cases — `FBI_CHECKOUT_BRANCH=feature/x` causes the git-stub to be called with that branch; a stub that returns nonzero for the requested branch falls through to `$DEFAULT_BRANCH`.
- HTTP layer: existing `runs.test.ts` integration style — 204 happy path, 409 for each eligibility code, 404 for missing run.
- UI: no dedicated test. The click path is a trivial fetch against an existing action-bar pattern; it's covered by humans exercising the RunDetail page.

## 8. Edge cases

- **Session files GC'd after success but before the user clicks** — eligibility rejects with `session_files_missing`. The UI surfaces the message in the button's error state; the user can start a new run with the same prompt.
- **Branch was never pushed** — `FBI_CHECKOUT_BRANCH` checkout fails, supervisor falls through to `$DEFAULT_BRANCH`, the container continues. Claude's session memory may diverge from the actual workspace state; this is strictly better than today's auto-resume, which always has the divergence.
- **Concurrent clicks** — second click hits the HTTP layer while the first is in flight. The second call reaches `continueRun`, reads the row, sees `state='running'`, rejects with `wrong_state`. No locking needed — the DB read-then-transition is fine because `markContinuing` requires `state ∈ {failed, cancelled, succeeded}` in its WHERE clause.
- **Continue during an active auto-resume loop** — can't happen; auto-resume only runs from `awaiting_resume`, which is not an eligible source state.
- **Orchestrator crashes mid-continue** — on restart, `recover()` sees `state='running'` with a fresh `container_id`. If the container exists, it reattaches. If it's gone, the run is marked `failed` with "container gone on restart" — same as any other orchestrator-crash recovery. The user can click Continue again.
- **Rate-limit cap hit inside a continuation** — same handling as today: row goes `failed` with the `exceeded auto-resume cap` error. Continue button reappears. The user can continue the continuation.

## 9. Migration & rollout

- DB migration: none. `markContinuing` is a new query against existing columns.
- Backward compatibility: supervisor's `FBI_CHECKOUT_BRANCH` is only read when set. Old runs that don't pass it get today's behavior. Any auto-resume that was in flight across the deploy still works the same way — the orchestrator adds the env var on the next container creation, supervisor picks it up, done.
- Feature flag: none. The button is always present for eligible runs; if we want to disable, we can later gate on a settings toggle, but the MVP ships without one.
