# Auto-resume on Claude rate-limit — design

**Status:** draft · 2026-04-22
**Scope:** server-only. When Claude Code exits because it hit its Pro/Max usage limit, FBI automatically waits until the limit resets and resumes the same Claude session inside a new container. No UI primitives are created here; existing run-list and run-detail UIs gain a new state and two new actions.

## 1. Goals & non-goals

### Goals

- Unattended long-running work survives Claude's 5-hour usage ceiling without manual intervention.
- Resume continues the *same* Claude conversation (`claude --resume <session-id>`), not a fresh prompt.
- One run = one row in the UI; multiple container attempts are an internal detail of that run.
- Global kill-switch to turn the feature off before periods the user can't monitor.
- Hard cap on consecutive auto-resumes per run as a loop guard.
- Persists across FBI server restarts: a run scheduled for 4am still resumes at 4am even if the process was restarted at 3am.

### Non-goals (deferred)

- Per-run opt-in toggle — a global switch covers the use case without adding a form field.
- Editing the prompt between attempts — conflicts with session-resume semantics. Cancel and start a new run instead.
- Cross-account awareness or rate-limit prediction — reactive only; we find out when Claude tells us.
- Stagger / serialization of concurrent resumes — account-wide reset fires all at once; if the user wants one at a time, they queue manually.
- A standalone auto-resume UI (settings checkbox aside). The run-list/detail surfaces already show state; the new state piggybacks on them.

## 2. Architecture

### Happy path

1. Run is `running`. Claude hits its limit and exits. Supervisor writes `/tmp/result.json` with the exit code as it does today.
2. On `container.wait()` resolution, the orchestrator's post-run path consults a new pure module `resumeDetector.classify(logTail, latestRateLimitState)` **before** calling `runs.markFinished`.
3. If the verdict is `kind:'rate_limit'` AND `settings.auto_resume_enabled` AND `run.resume_attempts < settings.auto_resume_max_attempts`:
   - Update the row: `state='awaiting_resume'`, `next_resume_at=<reset ms>`, `resume_attempts += 1`, `last_limit_reset_at=<reset ms>`.
   - Keep the log file open for append; emit `[fbi] awaiting resume until <ISO time>` to the terminal stream.
   - Push a `{type:'state', state:'awaiting_resume', next_resume_at, resume_attempts, last_limit_reset_at}` WebSocket frame.
   - `ResumeScheduler.schedule(runId, next_resume_at)` sets a `setTimeout`.
   - The run's `/var/lib/fbi/runs/<id>/claude-projects/` mount (created by the usage spec) is **retained** for reuse; nothing is deleted.
4. At fire time, `ResumeScheduler` re-reads the row. If it's still `awaiting_resume`, it calls `orchestrator.resume(runId)`. Otherwise it bails silently (user may have cancelled).
5. `resume()` mirrors `launch()` with three changes:
   - Bind-mount the preserved `claude-projects/` directory into the new container at `/home/agent/.claude/projects/`.
   - Pass `FBI_RESUME_SESSION_ID=<claude_session_id>` into the container's env. The supervisor, seeing it set, invokes `claude --resume "$FBI_RESUME_SESSION_ID"` instead of reading `/fbi/prompt.txt`.
   - Append to the same `log_path` instead of truncating.
6. Row transitions back to `running`. Container runs. On exit: normal completion path. If it's another rate-limit, goto 3. If the cap is now reached, goto cap-exceeded path (§5). Otherwise, terminal success/failure as today.

### Modules & boundaries

- **`resumeDetector`** (`src/server/orchestrator/resumeDetector.ts`) — pure classification. `classify(logTail: string, state: RateLimitState | null): ResumeVerdict`. No I/O. Fixture-driven tests.
- **`ResumeScheduler`** (`src/server/orchestrator/resumeScheduler.ts`) — singleton, owned by `Orchestrator`. In-memory `Map<runId, {timer, fireAt}>` of pending timers; DB is source of truth. Methods `schedule`, `cancel`, `fireNow`, `rehydrate`.
- **`Orchestrator.resume(runId)`** — new method on the existing `Orchestrator` class. Shares setup helpers with `launch()` (auth, MCP config, image resolve, prompt injection) via small extracted helpers; diverges on session-mount + `--resume` invocation.
- **`supervisor.sh`** — gains one branch: `if [ -n "$FBI_RESUME_SESSION_ID" ]; then claude --resume "$FBI_RESUME_SESSION_ID" --dangerously-skip-permissions …; else <existing prompt flow>; fi`.
- **`usageTailer`** (from the usage spec) — gains one additional side effect: when the first JSONL file appears, write its filename's UUID into `runs.claude_session_id`.

### Interaction with the claude-usage spec

This design **depends on** the claude-usage spec's per-run `claude-projects/` mount and JSONL tailer. Specifically:

- The mount directory (`/var/lib/fbi/runs/<id>/claude-projects/`) is the vehicle for preserving the Claude session across attempts.
- The tailer observes the session UUID (it's the `.jsonl` filename under `<cwd-slug>/`) and writes it to `runs.claude_session_id`.
- `rate_limit_state` is one of the detection inputs.

If this spec ships before claude-usage, the two mount/tailer changes move here instead. Either way, they're the same code; the ordering just changes which doc describes them. The rest of this design is unchanged.

## 3. Data model

### `runs` — new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `resume_attempts` | INTEGER NOT NULL | 0 | Count of auto-resumes taken for this run. Compared against `settings.auto_resume_max_attempts`. |
| `next_resume_at` | INTEGER | NULL | ms epoch of the scheduled resume; NULL unless `state='awaiting_resume'`. |
| `claude_session_id` | TEXT | NULL | Session UUID captured from the JSONL filename; used for `--resume`. |
| `last_limit_reset_at` | INTEGER | NULL | ms epoch of the reset time claimed by the most recent limit hit (for UI display + audit). Distinct from `next_resume_at`: persists after the resume fires, so the UI can show "resumed after 4h wait." |

### `RunState` enum

Add `awaiting_resume`. Full set becomes:

```ts
type RunState = 'queued' | 'running' | 'awaiting_resume' | 'succeeded' | 'failed' | 'cancelled';
```

Terminal states unchanged: `succeeded`, `failed`, `cancelled`. `awaiting_resume` is a non-terminal pause between two `running` spans.

### `settings` — new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `auto_resume_enabled` | INTEGER (bool) | 1 | Global kill-switch. |
| `auto_resume_max_attempts` | INTEGER | 5 | Per-run cap on consecutive auto-resumes. |

### Migration

One additive migration. Existing rows take the defaults. Idempotent `ALTER TABLE ... ADD COLUMN`, guarded by a columns-probe (same pattern as existing FBI migrations).

### Query shapes supported

- Runs awaiting resume, for startup rehydration: `SELECT id, next_resume_at FROM runs WHERE state='awaiting_resume'`.
- Cancel path, removing scheduler entry on project delete (handled in app layer, not SQL): look up runs by `project_id` with `state IN ('running', 'awaiting_resume')` and cancel each.
- Run detail fetch includes the new columns; the existing `Run` type is extended additively.

## 4. Detection & time parsing (`resumeDetector`)

### Signature

```ts
export interface ResumeVerdict {
  kind: 'rate_limit' | 'other';
  reset_at: number | null;          // ms epoch; null if kind='other' or no time found
  source: 'log_epoch' | 'log_text' | 'rate_limit_state' | 'fallback_clamp' | null;
}

export function classify(
  logTail: string,
  rateLimitState: { reset_at: number | null; requests_remaining: number | null; tokens_remaining: number | null } | null,
  now: number,
): ResumeVerdict;
```

Pure; `now` is injected for testability.

### Primary source — log text

Scan the last ~8 KB of `logTail`. Patterns tried in priority order:

1. **Pipe-delimited epoch**: `/Claude usage limit reached\|(\d+)/` — group 1 is seconds-epoch. Machine-readable; zero tz ambiguity. `source='log_epoch'`.
2. **Human reset string**: `/Claude usage limit reached\. Your limit will reset at (.+?)\./` — hand group 1 to a small time-parse helper (accepts `3pm`, `3:00 PM`, with optional trailing `(Zone)`; resolves to today in that zone, rolls to tomorrow if the computed instant is already past). `source='log_text'`.
3. **Lenient fallback**: any occurrence of `/usage limit/i` or `/rate limit/i` with no parseable time → `kind:'rate_limit'`, `reset_at=null`, `source=null`. Caller consults the state fallback.

### Fallback source — `rate_limit_state`

Triggered when the log scan returns `kind:'other'` but the exit was non-zero, **or** when the log says `rate_limit` with `reset_at=null`.

Condition: `state != null` AND `(state.requests_remaining === 0 || state.tokens_remaining === 0)` AND `state.reset_at != null` AND `state.reset_at > now`.

If satisfied: return `kind:'rate_limit'`, `reset_at=state.reset_at`, `source='rate_limit_state'`.

### Precedence when both fire

Log text wins when it produced a concrete time. The state's `reset_at` is the rolling 5h-window header; Claude's human message is what the user's plan actually says. Use the log time if present; otherwise the state time; otherwise clamp.

### Sanity clamps

- `reset_at <= now` → `reset_at = now + 60_000`, `source='fallback_clamp'`, warn-level log. Happens if e.g. the parsed time was already past due to a scheduling race.
- `reset_at > now + 24h` → treat as parse failure: return `kind:'other'`, log at warn with the suspicious value. No legitimate Claude limit is more than 24h out; if we see one it's almost certainly a bug.

### Fixtures

`src/server/orchestrator/__fixtures__/resume-detector/`:

- `pipe-epoch.log` — pipe-delimited form.
- `human-3pm.log` — `Your limit will reset at 3pm (America/Los_Angeles).`
- `human-no-zone.log` — no trailing zone; parser uses host tz.
- `human-rollover.log` — parsed time is earlier than "now"; parser rolls to tomorrow.
- `reworded-lenient.log` — contains `usage limit` but no known pattern; triggers state fallback.
- `unrelated-exit.log` — error unrelated to limits; verdict `other`.
- `state-only.log` — log is silent; `rateLimitState.requests_remaining=0`, future `reset_at`; verdict `rate_limit` from state.
- `clamp-past.log` — log parses a time that's now past; clamp to `now + 60s`.
- `clamp-future.log` — log parses a time 72h out; verdict `other`.

Every regex or code path has at least one fixture. No regex merges without a fixture.

## 5. Scheduling & lifecycle (`ResumeScheduler`)

### State

`Map<runId, { timer: NodeJS.Timeout; fireAt: number }>`, instance-only. Source of truth is the `runs` row.

### Methods

- `schedule(runId: number, fireAt: number): void` — cancels any existing timer for the run, then `setTimeout(() => this.fire(runId), Math.max(0, fireAt - Date.now()))`. Records in the map.
- `cancel(runId: number): void` — clear timer if present, remove map entry. No DB write; caller owns state transition.
- `fireNow(runId: number): void` — clear timer, call `fire(runId)` synchronously on next tick. Used by `POST /api/runs/:id/resume-now`.
- `rehydrate(): Promise<void>` — called once from server boot after `orchestrator.recover()`. Queries `SELECT id, next_resume_at FROM runs WHERE state='awaiting_resume'`, schedules each.
- `fire(runId)` — private. Re-reads the row. If state is no longer `awaiting_resume`, bail. Otherwise `orchestrator.resume(runId)`; swallow errors (resume itself marks the run failed on error).

### Startup sequence

In `src/server/index.ts` (or wherever the orchestrator currently boots):

1. `orchestrator.recover()` — existing behavior: fail-out any `running` rows whose container is gone.
2. `scheduler.rehydrate()` — schedule any `awaiting_resume` rows. Timers for fireAt-in-the-past fire on next tick.
3. Start HTTP listener.

### Shutdown

No special handling needed. Timers are in-memory; they die with the process. Rehydration on next boot restores them.

## 6. API surface

### Types (additions to `src/shared/types.ts`)

```ts
export type RunState =
  | 'queued'
  | 'running'
  | 'awaiting_resume'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Run {
  // ... existing fields ...
  resume_attempts: number;                    // 0 if never auto-resumed
  next_resume_at: number | null;              // ms epoch; non-null iff state='awaiting_resume'
  last_limit_reset_at: number | null;         // ms epoch of most recent limit hit's reset time
  claude_session_id: string | null;           // UUID; captured on first session start
}

export interface Settings {
  // ... existing fields ...
  auto_resume_enabled: boolean;
  auto_resume_max_attempts: number;
}

export type RunWsStateMessage = {
  type: 'state';
  state: RunState;
  next_resume_at?: number | null;
  resume_attempts?: number;
  last_limit_reset_at?: number | null;
};
```

### REST endpoints

**New:**

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/runs/:id/resume-now` | empty | `204` on success; `409` if run not in `awaiting_resume`; `404` if run not found |

**Modified:**

- `GET /api/runs` and `/api/runs/:id`: response `Run` gains the four new fields.
- `DELETE /api/runs/:id` (cancel): extended. When `state='awaiting_resume'`, call `scheduler.cancel(id)` and set state to `cancelled`. No container to stop.
- `GET /api/settings`: response gains `auto_resume_enabled` and `auto_resume_max_attempts`.
- `PATCH /api/settings`: accepts either field. Validates `auto_resume_max_attempts` in `[1, 20]`.

### WebSocket

Existing `/api/ws/runs/:id` socket. Add a `{type:'state', ...}` frame emitted on every run-state transition (at minimum: `running → awaiting_resume`, `awaiting_resume → running`, `awaiting_resume → cancelled`, terminal transitions). Clients that don't recognize the type ignore it.

Existing `{type:'tty'}` frames continue carrying `[fbi] awaiting resume until <ISO>`, `[fbi] resuming (attempt N of M)`, and `[fbi] rate limited; exceeded auto-resume cap` markers so the terminal shows continuity.

## 7. User actions on awaiting runs

- **Cancel** — existing UI control. Extended to transition `awaiting_resume → cancelled` and clear the scheduler entry.
- **Resume now** — new UI control, visible only when `state='awaiting_resume'`. POSTs `/api/runs/:id/resume-now`.

No other actions (no prompt edit, no attempt-count reset, no manual-schedule-adjust). These would fight session-resume semantics or add mechanism for unlikely workflows.

## 8. Error handling & edge cases

- **Session JSONL never written** (Claude died before its first turn → `claude_session_id` NULL). Resume falls back to a fresh `launch`-style container: prompt injected at `/fbi/prompt.txt`, no `FBI_RESUME_SESSION_ID` set, supervisor runs the normal prompt flow. Log marker: `[fbi] resume: no session captured, starting fresh`. Still counts against the cap.
- **`--resume` errors** (corrupted JSONL, Claude version mismatch, etc.). Container exits non-zero with non-rate-limit output. `classify` returns `kind:'other'`. Run is marked `failed` terminally. User sees the error in the log.
- **User cancels during timer wait.** `scheduler.cancel` + state → `cancelled`. Idempotent.
- **Resume Now after scheduled time already passed.** Fire path works regardless of whether the timer has or hasn't yet fired; `fire()`'s re-read-row guard catches any race.
- **Detector verdict `rate_limit` with no `reset_at`.** Should not occur in practice (tailer records state once a run runs long enough to hit a limit). If it does, `classify` clamps to `now + 5 minutes` via `fallback_clamp`, warn log. Never schedule for epoch 0 or NaN.
- **Project deleted while run awaiting.** Existing `ON DELETE CASCADE` removes the row. The scheduler's `fire()` re-read returns no row and bails. To be tidy, the project-delete endpoint also calls `scheduler.cancel()` for each removed run's id.
- **FBI crashes during resume boot** (after `awaiting_resume → running`, before container attached). Existing `orchestrator.recover()` handles this: `container_id` is NULL → `failed` with the current "lost container" message.
- **Host reboots past `next_resume_at`.** `rehydrate()` sees fireAt-in-past, fires on next tick. Log marker: `[fbi] resuming (delayed; scheduled for <ISO>, fired at <ISO>)`.
- **Concurrent fire + cancel race.** `fire()` re-reads the row. If state moved to `cancelled` between timer expiration and re-read, bail without launching a container.
- **Clock skew / host clock jumps forward.** Timer fires early. Claude either works (budget is back) or re-hits (re-schedule, subject to the cap).
- **Cap reached.** Run marked `failed` with error string `rate limited; exceeded auto-resume cap (N attempts)`. No scheduler entry. UI treats it like any terminal failure plus shows `resume_attempts` for context.
- **Feature globally disabled mid-run.** If `auto_resume_enabled` flips to false while a run is `awaiting_resume`, the existing timer still fires (disabling the feature stops *new* awaits; doesn't retroactively cancel scheduled ones). To manually clear, user cancels. Rationale: surprising retroactive cancellation would contradict user expectation when the run has already been told "I'll resume you at 3pm."
- **Multiple runs with the same reset time.** Each has its own scheduler entry; all fire near-simultaneously. Account-wide reset means they all have budget; any that re-hit just re-schedule.

## 9. Testing

### Unit

- `resumeDetector.test.ts` — all fixtures under `__fixtures__/resume-detector/` plus the two clamp cases. Inject `now`; assert verdict shape exactly.
- `resumeScheduler.test.ts` — fake timers. `schedule` / `cancel` / `fireNow`. `schedule` with past fireAt fires on next tick. `rehydrate` schedules rows from a seeded DB. `fire()` bails when re-read state is not `awaiting_resume`.
- `db/runs.test.ts` (extended) — migration adds columns idempotently; list by `awaiting_resume`; round-trip all four new fields.
- `db/settings.test.ts` (extended) — new settings fields round-trip; defaults applied on first-boot migration.
- `api/runs.test.ts` (extended) — `POST /resume-now` 204 when awaiting, 409 when not, 404 when missing. `DELETE` on awaiting run clears scheduler and sets state to `cancelled`.
- `api/settings.test.ts` (extended) — PATCH validates `auto_resume_max_attempts` in `[1, 20]`.
- `api/ws.test.ts` (extended) — subscribed client receives a `{type:'state'}` frame on transition to `awaiting_resume` and back to `running`.

### Integration (Docker-gated; auto-skip if Docker unreachable)

- `resume.integration.test.ts`
  - Stub container writes canned JSONL then exits with pipe-delimited limit message.
  - Assert: run enters `awaiting_resume`, `claude_session_id` captured from the JSONL filename, `next_resume_at` equals parsed epoch.
  - Fast-forward by calling `scheduler.fireNow(id)`.
  - Assert second container: its config contains `FBI_RESUME_SESSION_ID=<id>`; mount for `claude-projects/` is bound at `/home/agent/.claude/projects/`.
  - Stub second container exits clean → run ends `succeeded`.
- `resume-cap.integration.test.ts`
  - Stub container always hits limit.
  - Assert after `max_attempts` resumes, run is `failed` with error string `rate limited; exceeded auto-resume cap (<max> attempts)`, no scheduler entry remains.

### Non-tests (explicit)

- No real Claude calls. All tests use stub containers + fixture JSONL.
- No frontend tests — the UI additions are a state badge + a button + a settings checkbox; covered by the server contract above.

## 10. Summary of file changes (inventory, no diffs)

- **New:**
  - `src/server/orchestrator/resumeDetector.ts`
  - `src/server/orchestrator/resumeScheduler.ts`
  - `src/server/orchestrator/__fixtures__/resume-detector/*.log`
  - Tests mirroring each of the above.
- **Modified:**
  - `src/shared/types.ts` — `RunState` enum, `Run` fields, `Settings` fields, WS state message type.
  - `src/server/db/schema.sql` — new columns on `runs` and `settings`; migration in `src/server/db/index.ts`.
  - `src/server/db/runs.ts` — select/serialize new columns; `listByState('awaiting_resume')` support.
  - `src/server/db/settings.ts` — read/write new fields with defaults.
  - `src/server/orchestrator/index.ts` — post-run classification branch, `resume()` method, scheduler wiring, `recover()` coexistence.
  - `src/server/orchestrator/supervisor.sh` — `--resume` branch when `FBI_RESUME_SESSION_ID` is set.
  - `src/server/api/runs.ts` — `POST /:id/resume-now`; cancel path extension.
  - `src/server/api/settings.ts` — validate + expose new fields.
  - `src/server/api/ws.ts` — emit `{type:'state'}` frames on run-state transitions.
  - `src/server/index.ts` — call `scheduler.rehydrate()` at boot.
  - Depending on claude-usage spec ordering: either that spec or this one adds the `claude-projects/` mount and session-id capture in the tailer.
- **Unchanged:** anything under `src/web/`. UI wire-up (state badge, resume-now button, settings checkbox) is additive against the stable contract above and intentionally descoped from this spec.
