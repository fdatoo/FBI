# Auto-resume on Claude rate-limit implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude Code exits because it hit its Pro/Max usage ceiling, FBI parks the run in a new `awaiting_resume` state, persists a timer to the reset time, and re-enters the same Claude session (`claude --resume <session-id>`) in a fresh container when the window lifts.

**Architecture:** Post-run hook in the orchestrator classifies the exit via a new pure `resumeDetector` module (log-text primary, `rate_limit_state` fallback — state table created here as a minimal subset of what the claude-usage spec will own). A new `ResumeScheduler` singleton (in-memory `setTimeout` map, DB source of truth) fires scheduled resumes; on fire it calls a new `Orchestrator.resume()` method that mirrors `launch()` but bind-mounts the run's preserved `claude-projects/` directory and sets `FBI_RESUME_SESSION_ID` for the supervisor, which invokes `claude --resume $FBI_RESUME_SESSION_ID`. Run rows gain four columns (`resume_attempts`, `next_resume_at`, `claude_session_id`, `last_limit_reset_at`) and a new state `awaiting_resume`; settings gain `auto_resume_enabled` and `auto_resume_max_attempts`.

**Tech Stack:** TypeScript (Node 20+), better-sqlite3, Fastify + @fastify/websocket, dockerode, Vitest.

---

## Spec reference

Design spec: `docs/superpowers/specs/2026-04-22-auto-resume-design.md`. Read before starting.

## Dependency on the claude-usage spec

The auto-resume design says the per-run `claude-projects/` mount and JSONL-based session-id capture *may* come from the claude-usage spec (`docs/superpowers/specs/2026-04-22-claude-usage-design.md`). At the time of writing, neither feature is in `main`. **This plan is self-contained** — it owns the mount and a minimal post-run session-id scan. If claude-usage merges first:

- The mount at `/var/lib/fbi/runs/<id>/claude-projects/` is already created by its tailer. Task 6's mount-creation code becomes a redundant `mkdirSync`; keep it (idempotent) so this plan still works if merged in the opposite order.
- `runs.claude_session_id` is populated by its live tailer. Task 6's post-run scan becomes a redundant safety net; keep it — it fires only if the column is still NULL.
- The `rate_limit_state` table from Task 1 overlaps with the claude-usage spec's identical table. Whoever merges first wins; the second PR's migration has `IF NOT EXISTS` / `cols.has(...)` guards and is idempotent.

No coordination is required beyond that.

---

## File structure

**New files**

- `src/server/orchestrator/resumeDetector.ts` — pure classification (log text + state → verdict).
- `src/server/orchestrator/resumeDetector.test.ts` — fixture-driven tests.
- `src/server/orchestrator/__fixtures__/resume-detector/*.log` — fixture log-tails.
- `src/server/orchestrator/resumeScheduler.ts` — in-memory timer manager with DB rehydration.
- `src/server/orchestrator/resumeScheduler.test.ts` — fake-timer tests.
- `src/server/orchestrator/sessionId.ts` — post-run scan of the `claude-projects/` mount.
- `src/server/orchestrator/sessionId.test.ts` — tempdir tests.
- `src/server/logs/stateBroadcaster.ts` — per-run JSON state-frame broadcaster.
- `src/server/logs/stateBroadcaster.test.ts`
- `src/server/orchestrator/resume.integration.test.ts` — Docker-gated end-to-end.

**Modified files**

- `src/server/db/schema.sql` — new `rate_limit_state` table (subset; shared with claude-usage spec if it merges too). No columns here — column adds go via `migrate()` so upgrade DBs stay consistent.
- `src/server/db/index.ts` — `migrate()` adds four columns to `runs` and two to `settings`; creates `rate_limit_state` if missing (guarded).
- `src/shared/types.ts` — `RunState` gets `'awaiting_resume'`; `Run` gains four fields; `Settings` gains two; new WS message type.
- `src/server/db/runs.ts` — new methods for state transitions and listing awaiting runs.
- `src/server/db/runs.test.ts` — tests for new methods + columns round-trip.
- `src/server/db/settings.ts` — read/write new fields with defaults.
- `src/server/db/settings.test.ts` — round-trip tests for new fields.
- `src/server/db/rateLimitState.ts` — **new file**, tiny repo for the rate_limit_state singleton (feeds the detector fallback). Added here and not in `runs.ts` because it has a different lifecycle.
- `src/server/db/rateLimitState.test.ts`
- `src/server/logs/registry.ts` — sibling map for state broadcasters.
- `src/server/orchestrator/supervisor.sh` — branch on `FBI_RESUME_SESSION_ID`.
- `src/server/orchestrator/index.ts` — classification in post-run path; new `resume()` method; scheduler wiring; `recover()` coexistence.
- `src/server/api/runs.ts` — `POST /:id/resume-now`; extend cancel to handle `awaiting_resume`.
- `src/server/api/runs.test.ts` — coverage for new and modified routes.
- `src/server/api/settings.ts` — validate and expose new settings fields.
- `src/server/api/settings.test.ts` (create if missing, or add cases to existing).
- `src/server/api/ws.ts` — subscribe to state broadcaster; send as text JSON frames alongside binary.
- `src/server/api/ws.test.ts` — assert state frames on transitions.
- `src/server/index.ts` — construct state-broadcaster registry; call `scheduler.rehydrate()` at boot; pass new deps through.

---

## Task 1: Schema + migration for new columns and `rate_limit_state`

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts` (extend `migrate()`)
- Modify: `src/server/db/index.test.ts` (if it asserts migration; otherwise covered downstream)

- [ ] **Step 1: Append `rate_limit_state` table to `schema.sql`**

Append to the bottom of `src/server/db/schema.sql`:

```sql
-- Auto-resume on rate-limit (see docs/superpowers/specs/2026-04-22-auto-resume-design.md).
-- Shared subset with the claude-usage spec; whoever merges first creates it.
-- Extra columns on `runs` and `settings` are added via migrate() in index.ts.
CREATE TABLE IF NOT EXISTS rate_limit_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  requests_remaining INTEGER,
  requests_limit INTEGER,
  tokens_remaining INTEGER,
  tokens_limit INTEGER,
  reset_at INTEGER,
  observed_at INTEGER NOT NULL,
  observed_from_run_id INTEGER
);
```

- [ ] **Step 2: Extend `migrate()` in `src/server/db/index.ts`**

Insert inside `migrate()`, *after* the existing `settingsCols` block and *before* the final `INSERT OR IGNORE INTO settings`:

```ts
  const runCols = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>)
      .map((r) => r.name)
  );
  if (!runCols.has('resume_attempts')) {
    db.exec('ALTER TABLE runs ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!runCols.has('next_resume_at')) {
    db.exec('ALTER TABLE runs ADD COLUMN next_resume_at INTEGER');
  }
  if (!runCols.has('claude_session_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN claude_session_id TEXT');
  }
  if (!runCols.has('last_limit_reset_at')) {
    db.exec('ALTER TABLE runs ADD COLUMN last_limit_reset_at INTEGER');
  }
  if (!settingsCols.has('auto_resume_enabled')) {
    db.exec('ALTER TABLE settings ADD COLUMN auto_resume_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!settingsCols.has('auto_resume_max_attempts')) {
    db.exec('ALTER TABLE settings ADD COLUMN auto_resume_max_attempts INTEGER NOT NULL DEFAULT 5');
  }
```

Leave the final `INSERT OR IGNORE INTO settings` statement untouched — the existing seed row picks up the new columns via their `DEFAULT`s.

- [ ] **Step 3: Run the existing DB tests to confirm the migration is idempotent**

Run: `npm test -- src/server/db`
Expected: PASS (all existing tests). If any fail, the migration is misordered — the `runCols` lookup must come *after* any ALTERs that add new run columns elsewhere.

- [ ] **Step 4: Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts
git commit -m "feat(db): migrate runs + settings columns for auto-resume; add rate_limit_state table"
```

---

## Task 2: Shared type updates

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Update `RunState` and extend `Run`**

In `src/shared/types.ts`, replace the existing `RunState` and `Run` with:

```ts
export type RunState =
  | 'queued'
  | 'running'
  | 'awaiting_resume'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Run {
  id: number;
  project_id: number;
  prompt: string;
  branch_name: string;
  state: RunState;
  container_id: string | null;
  log_path: string;
  exit_code: number | null;
  error: string | null;
  head_commit: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  resume_attempts: number;
  next_resume_at: number | null;
  claude_session_id: string | null;
  last_limit_reset_at: number | null;
}
```

- [ ] **Step 2: Extend `Settings`**

Add two fields to the existing `Settings` interface:

```ts
export interface Settings {
  global_prompt: string;
  notifications_enabled: boolean;
  concurrency_warn_at: number;
  image_gc_enabled: boolean;
  last_gc_at: number | null;
  last_gc_count: number | null;
  last_gc_bytes: number | null;
  global_marketplaces: string[];
  global_plugins: string[];
  auto_resume_enabled: boolean;
  auto_resume_max_attempts: number;
  updated_at: number;
}
```

- [ ] **Step 3: Add the WebSocket state-message type**

Append at the bottom of `src/shared/types.ts`:

```ts
export type RunWsStateMessage = {
  type: 'state';
  state: RunState;
  next_resume_at: number | null;
  resume_attempts: number;
  last_limit_reset_at: number | null;
};
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: this will surface missing-field errors in code that constructs `Run`/`Settings` (repos, API routes, tests). Those are fixed in later tasks. If typecheck fails only in server code, that's expected; track the failures to confirm each is resolved by a later task.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add awaiting_resume state and auto-resume fields on Run/Settings"
```

---

## Task 3: RunsRepo — new transitions and queries

**Files:**
- Modify: `src/server/db/runs.ts`
- Modify: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write failing tests for the new behavior**

Append to `src/server/db/runs.test.ts`:

```ts
describe('RunsRepo auto-resume', () => {
  let runs: RunsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepos();
    runs = r.runs;
    projectId = r.projectId;
  });

  it('new runs have zeroed auto-resume fields', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    expect(run.resume_attempts).toBe(0);
    expect(run.next_resume_at).toBeNull();
    expect(run.claude_session_id).toBeNull();
    expect(run.last_limit_reset_at).toBeNull();
  });

  it('markAwaitingResume sets state and timestamps and bumps attempts', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c');
    runs.markAwaitingResume(run.id, { next_resume_at: 9000, last_limit_reset_at: 9000 });
    const after = runs.get(run.id)!;
    expect(after.state).toBe('awaiting_resume');
    expect(after.next_resume_at).toBe(9000);
    expect(after.last_limit_reset_at).toBe(9000);
    expect(after.resume_attempts).toBe(1);
    expect(after.container_id).toBeNull();
  });

  it('markResuming clears awaiting fields and returns to running', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    runs.markAwaitingResume(run.id, { next_resume_at: 9000, last_limit_reset_at: 9000 });
    runs.markResuming(run.id, 'c2');
    const after = runs.get(run.id)!;
    expect(after.state).toBe('running');
    expect(after.container_id).toBe('c2');
    expect(after.next_resume_at).toBeNull();
  });

  it('setClaudeSessionId writes once; no-op on subsequent calls with different value', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.setClaudeSessionId(run.id, 'session-1');
    runs.setClaudeSessionId(run.id, 'session-2'); // ignored
    expect(runs.get(run.id)!.claude_session_id).toBe('session-1');
  });

  it('listByState includes awaiting_resume rows', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c');
    runs.markAwaitingResume(run.id, { next_resume_at: 9000, last_limit_reset_at: 9000 });
    expect(runs.listByState('awaiting_resume').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: FAIL with `markAwaitingResume is not a function`, `markResuming is not a function`, `setClaudeSessionId is not a function`, and shape mismatches on the field defaults test.

- [ ] **Step 3: Implement the methods**

In `src/server/db/runs.ts`, add these methods to `RunsRepo` (place them after `markFinished`):

```ts
  markAwaitingResume(
    id: number,
    p: { next_resume_at: number; last_limit_reset_at: number },
  ): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='awaiting_resume',
                container_id=NULL,
                next_resume_at=?,
                last_limit_reset_at=?,
                resume_attempts = resume_attempts + 1
          WHERE id=?`,
      )
      .run(p.next_resume_at, p.last_limit_reset_at, id);
  }

  markResuming(id: number, containerId: string): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='running',
                container_id=?,
                next_resume_at=NULL,
                started_at=COALESCE(started_at, ?)
          WHERE id=?`,
      )
      .run(containerId, Date.now(), id);
  }

  setClaudeSessionId(id: number, sessionId: string): void {
    this.db
      .prepare(
        `UPDATE runs
            SET claude_session_id=?
          WHERE id=? AND claude_session_id IS NULL`,
      )
      .run(sessionId, id);
  }

  listAwaiting(): Array<Pick<Run, 'id' | 'next_resume_at'>> {
    return this.db
      .prepare(
        `SELECT id, next_resume_at FROM runs WHERE state='awaiting_resume'`,
      )
      .all() as Array<Pick<Run, 'id' | 'next_resume_at'>>;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(db): add awaiting-resume transitions and session-id setter on RunsRepo"
```

---

## Task 4: SettingsRepo — read/write auto-resume fields

**Files:**
- Modify: `src/server/db/settings.ts`
- Modify: `src/server/db/settings.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/server/db/settings.test.ts`:

```ts
describe('SettingsRepo auto-resume', () => {
  it('returns defaults on fresh DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    const s = settings.get();
    expect(s.auto_resume_enabled).toBe(true);
    expect(s.auto_resume_max_attempts).toBe(5);
  });

  it('patches and reads back both fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    settings.update({ auto_resume_enabled: false, auto_resume_max_attempts: 3 });
    const s = settings.get();
    expect(s.auto_resume_enabled).toBe(false);
    expect(s.auto_resume_max_attempts).toBe(3);
  });
});
```

If `settings.test.ts` does not already import `fs`, `path`, `os`, `openDb`, and `SettingsRepo`, add the imports following the pattern in `runs.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/server/db/settings.test.ts`
Expected: FAIL — `auto_resume_enabled` is `undefined`.

- [ ] **Step 3: Extend `SettingsRepo`**

In `src/server/db/settings.ts`:

Update `SettingsRow` to include the two new integer columns:

```ts
interface SettingsRow {
  id: number;
  global_prompt: string;
  notifications_enabled: number;
  concurrency_warn_at: number;
  image_gc_enabled: number;
  last_gc_at: number | null;
  last_gc_count: number | null;
  last_gc_bytes: number | null;
  global_marketplaces_json: string;
  global_plugins_json: string;
  auto_resume_enabled: number;
  auto_resume_max_attempts: number;
  updated_at: number;
}
```

Extend `get()` return to map the new fields (add inside the return object):

```ts
      auto_resume_enabled: row.auto_resume_enabled === 1,
      auto_resume_max_attempts: row.auto_resume_max_attempts,
```

Extend `update()` patch accept and apply:

```ts
  update(patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
    concurrency_warn_at?: number;
    image_gc_enabled?: boolean;
    global_marketplaces?: string[];
    global_plugins?: string[];
    auto_resume_enabled?: boolean;
    auto_resume_max_attempts?: number;
  }): Settings {
    const existing = this.get();
    const merged = {
      global_prompt: patch.global_prompt ?? existing.global_prompt,
      notifications_enabled: patch.notifications_enabled ?? existing.notifications_enabled,
      concurrency_warn_at: patch.concurrency_warn_at ?? existing.concurrency_warn_at,
      image_gc_enabled: patch.image_gc_enabled ?? existing.image_gc_enabled,
      global_marketplaces: patch.global_marketplaces ?? existing.global_marketplaces,
      global_plugins: patch.global_plugins ?? existing.global_plugins,
      auto_resume_enabled: patch.auto_resume_enabled ?? existing.auto_resume_enabled,
      auto_resume_max_attempts: patch.auto_resume_max_attempts ?? existing.auto_resume_max_attempts,
    };
    const now = Date.now();
    this.db.prepare(
      `UPDATE settings SET
        global_prompt = ?, notifications_enabled = ?,
        concurrency_warn_at = ?, image_gc_enabled = ?,
        global_marketplaces_json = ?, global_plugins_json = ?,
        auto_resume_enabled = ?, auto_resume_max_attempts = ?,
        updated_at = ?
       WHERE id = 1`
    ).run(
      merged.global_prompt,
      merged.notifications_enabled ? 1 : 0,
      merged.concurrency_warn_at,
      merged.image_gc_enabled ? 1 : 0,
      JSON.stringify(merged.global_marketplaces),
      JSON.stringify(merged.global_plugins),
      merged.auto_resume_enabled ? 1 : 0,
      merged.auto_resume_max_attempts,
      now,
    );
    return this.get();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/server/db/settings.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/settings.ts src/server/db/settings.test.ts
git commit -m "feat(db): expose auto_resume_enabled and auto_resume_max_attempts via SettingsRepo"
```

---

## Task 5: `RateLimitStateRepo` — minimal singleton for the detector fallback

**Files:**
- Create: `src/server/db/rateLimitState.ts`
- Create: `src/server/db/rateLimitState.test.ts`

This repo exposes only what the detector fallback needs: reading the current row. Writes are nominal-only (stubbed until the claude-usage tailer lands), but the upsert method exists so integration tests can seed a row.

- [ ] **Step 1: Write failing tests**

Create `src/server/db/rateLimitState.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { RateLimitStateRepo } from './rateLimitState.js';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  return new RateLimitStateRepo(db);
}

describe('RateLimitStateRepo', () => {
  it('returns null when nothing observed', () => {
    const repo = makeRepo();
    expect(repo.get()).toBeNull();
  });

  it('upsert + get round-trip', () => {
    const repo = makeRepo();
    repo.upsert({
      requests_remaining: 0,
      requests_limit: 100,
      tokens_remaining: 5000,
      tokens_limit: 200000,
      reset_at: 9000,
      observed_at: 8000,
      observed_from_run_id: 42,
    });
    const s = repo.get();
    expect(s).not.toBeNull();
    expect(s!.requests_remaining).toBe(0);
    expect(s!.reset_at).toBe(9000);
  });

  it('upsert is last-write-wins when observed_at advances', () => {
    const repo = makeRepo();
    repo.upsert({
      requests_remaining: 10, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: 1000, observed_at: 1000, observed_from_run_id: 1,
    });
    repo.upsert({
      requests_remaining: 0, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: 2000, observed_at: 2000, observed_from_run_id: 2,
    });
    expect(repo.get()!.requests_remaining).toBe(0);
  });

  it('upsert ignores older observations', () => {
    const repo = makeRepo();
    repo.upsert({
      requests_remaining: 0, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: 2000, observed_at: 2000, observed_from_run_id: 2,
    });
    repo.upsert({
      requests_remaining: 50, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: 1000, observed_at: 1000, observed_from_run_id: 1,
    });
    expect(repo.get()!.requests_remaining).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/server/db/rateLimitState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RateLimitStateRepo`**

Create `src/server/db/rateLimitState.ts`:

```ts
import type { DB } from './index.js';

export interface RateLimitSnapshot {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;
  observed_at: number;
  observed_from_run_id: number | null;
}

export class RateLimitStateRepo {
  constructor(private db: DB) {}

  get(): RateLimitSnapshot | null {
    const row = this.db.prepare('SELECT * FROM rate_limit_state WHERE id = 1').get() as
      | RateLimitSnapshot
      | undefined;
    return row ?? null;
  }

  upsert(s: RateLimitSnapshot): void {
    this.db.prepare(
      `INSERT INTO rate_limit_state
         (id, requests_remaining, requests_limit, tokens_remaining, tokens_limit,
          reset_at, observed_at, observed_from_run_id)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         requests_remaining = excluded.requests_remaining,
         requests_limit     = excluded.requests_limit,
         tokens_remaining   = excluded.tokens_remaining,
         tokens_limit       = excluded.tokens_limit,
         reset_at           = excluded.reset_at,
         observed_at        = excluded.observed_at,
         observed_from_run_id = excluded.observed_from_run_id
       WHERE excluded.observed_at > rate_limit_state.observed_at`,
    ).run(
      s.requests_remaining, s.requests_limit, s.tokens_remaining, s.tokens_limit,
      s.reset_at, s.observed_at, s.observed_from_run_id,
    );
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `npm test -- src/server/db/rateLimitState.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/rateLimitState.ts src/server/db/rateLimitState.test.ts
git commit -m "feat(db): add RateLimitStateRepo singleton"
```

---

## Task 6: `resumeDetector` — pure classification with fixtures

**Files:**
- Create: `src/server/orchestrator/resumeDetector.ts`
- Create: `src/server/orchestrator/resumeDetector.test.ts`
- Create: `src/server/orchestrator/__fixtures__/resume-detector/*.log`

- [ ] **Step 1: Create fixtures**

Create one file per fixture under `src/server/orchestrator/__fixtures__/resume-detector/`:

`pipe-epoch.log`:
```
[fbi] resolving image
... normal output ...
Claude usage limit reached|1745373600
```

`human-3pm.log`:
```
... tool use output ...
Claude usage limit reached. Your limit will reset at 3pm (America/Los_Angeles).
```

`human-no-zone.log`:
```
Claude usage limit reached. Your limit will reset at 9:30 AM.
```

`reworded-lenient.log`:
```
Error: you have exceeded the usage limit for this account. Please try again later.
```

`unrelated-exit.log`:
```
fatal: unable to access 'origin': The requested URL returned error: 403
```

`state-only.log`:
```
Error: connection reset
```

`clamp-past.log`:
```
Claude usage limit reached. Your limit will reset at 12:00 AM.
```

`clamp-future.log`:
```
Claude usage limit reached|9999999999
```

(`clamp-future.log`'s timestamp is ~2286-11-20 UTC — well beyond 24h from any plausible `now`.)

- [ ] **Step 2: Write the failing test file**

Create `src/server/orchestrator/resumeDetector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './resumeDetector.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) =>
  fs.readFileSync(path.join(HERE, '__fixtures__/resume-detector', name), 'utf8');

// Fixed "now" used where tests don't care: 2026-04-22T12:00:00Z
const NOW = Date.UTC(2026, 3, 22, 12, 0, 0);

describe('resumeDetector.classify', () => {
  it('parses the pipe-epoch form', () => {
    const v = classify(fx('pipe-epoch.log'), null, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('log_epoch');
    expect(v.reset_at).toBe(1745373600 * 1000);
  });

  it('parses the human reset form with zone', () => {
    // Choose a "now" that puts "3pm America/Los_Angeles" in the future:
    // 2026-04-22T00:00:00 PDT  →  07:00 UTC.
    const now = Date.UTC(2026, 3, 22, 8, 0, 0);
    const v = classify(fx('human-3pm.log'), null, now);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('log_text');
    // 3pm PDT (UTC-7) on 2026-04-22 = 22:00 UTC
    expect(v.reset_at).toBe(Date.UTC(2026, 3, 22, 22, 0, 0));
  });

  it('parses the human reset form without zone (uses host tz)', () => {
    const v = classify(fx('human-no-zone.log'), null, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('log_text');
    expect(typeof v.reset_at).toBe('number');
  });

  it('lenient fallback produces rate_limit with state backfill', () => {
    const state = {
      requests_remaining: 0, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: NOW + 60 * 60 * 1000,
    };
    const v = classify(fx('reworded-lenient.log'), state, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('rate_limit_state');
    expect(v.reset_at).toBe(state.reset_at);
  });

  it('unrelated exit with no state produces "other"', () => {
    const v = classify(fx('unrelated-exit.log'), null, NOW);
    expect(v.kind).toBe('other');
    expect(v.reset_at).toBeNull();
  });

  it('log silent but state indicates zero-remaining → rate_limit from state', () => {
    const state = {
      requests_remaining: 0, requests_limit: 100,
      tokens_remaining: null, tokens_limit: null,
      reset_at: NOW + 30 * 60 * 1000,
    };
    const v = classify(fx('state-only.log'), state, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('rate_limit_state');
  });

  it('past parsed time clamps to now+60s', () => {
    // "12:00 AM" on today's date is in the past when now=noon.
    const v = classify(fx('clamp-past.log'), null, NOW);
    expect(v.kind).toBe('rate_limit');
    expect(v.source).toBe('fallback_clamp');
    expect(v.reset_at).toBe(NOW + 60_000);
  });

  it('parsed time >24h out is treated as parse failure', () => {
    const v = classify(fx('clamp-future.log'), null, NOW);
    expect(v.kind).toBe('other');
    expect(v.reset_at).toBeNull();
  });
});
```

- [ ] **Step 3: Verify failure**

Run: `npm test -- src/server/orchestrator/resumeDetector.test.ts`
Expected: FAIL — `classify` not exported.

- [ ] **Step 4: Implement `resumeDetector`**

Create `src/server/orchestrator/resumeDetector.ts`:

```ts
export interface RateLimitStateInput {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;
}

export interface ResumeVerdict {
  kind: 'rate_limit' | 'other';
  reset_at: number | null;
  source: 'log_epoch' | 'log_text' | 'rate_limit_state' | 'fallback_clamp' | null;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Scan the last ~8 KB of the log for limit signals.
const TAIL_BYTES = 8 * 1024;

const RE_PIPE_EPOCH = /Claude usage limit reached\|(\d+)/;
const RE_HUMAN = /Claude usage limit reached\. Your limit will reset at ([^.]+)\./;
const RE_LENIENT = /(?:usage limit|rate limit)/i;

export function classify(
  logTail: string,
  state: RateLimitStateInput | null,
  now: number,
): ResumeVerdict {
  const tail = logTail.length > TAIL_BYTES ? logTail.slice(-TAIL_BYTES) : logTail;

  // 1. Pipe-delimited epoch.
  const mEpoch = tail.match(RE_PIPE_EPOCH);
  if (mEpoch) {
    const ms = Number(mEpoch[1]) * 1000;
    return sanityClamp(ms, 'log_epoch', state, now);
  }

  // 2. Human reset string.
  const mHuman = tail.match(RE_HUMAN);
  if (mHuman) {
    const parsed = parseHumanResetTime(mHuman[1], now);
    if (parsed !== null) return sanityClamp(parsed, 'log_text', state, now);
    // parseable text but unparseable time → fall through to lenient.
  }

  // 3. Lenient pattern → consult state.
  if (RE_LENIENT.test(tail)) {
    const fromState = classifyFromState(state, now);
    if (fromState) return fromState;
    // Pattern matched but no state → clamp.
    return { kind: 'rate_limit', reset_at: now + 5 * 60_000, source: 'fallback_clamp' };
  }

  // 4. No log signal — last chance: state alone.
  const fromState = classifyFromState(state, now);
  if (fromState) return fromState;

  return { kind: 'other', reset_at: null, source: null };
}

function classifyFromState(
  state: RateLimitStateInput | null,
  now: number,
): ResumeVerdict | null {
  if (!state) return null;
  const zero =
    state.requests_remaining === 0 || state.tokens_remaining === 0;
  if (!zero) return null;
  if (state.reset_at == null || state.reset_at <= now) return null;
  if (state.reset_at > now + TWENTY_FOUR_HOURS_MS) return null;
  return { kind: 'rate_limit', reset_at: state.reset_at, source: 'rate_limit_state' };
}

function sanityClamp(
  ms: number,
  source: Exclude<ResumeVerdict['source'], null>,
  _state: RateLimitStateInput | null,
  now: number,
): ResumeVerdict {
  if (!Number.isFinite(ms)) {
    return { kind: 'other', reset_at: null, source: null };
  }
  if (ms > now + TWENTY_FOUR_HOURS_MS) {
    return { kind: 'other', reset_at: null, source: null };
  }
  if (ms <= now) {
    return { kind: 'rate_limit', reset_at: now + 60_000, source: 'fallback_clamp' };
  }
  return { kind: 'rate_limit', reset_at: ms, source };
}

/**
 * Parse strings like "3pm", "3:00 PM", "9:30 AM", optionally followed by
 * " (America/Los_Angeles)" or similar zone hint. Returns ms-epoch or null.
 *
 * Resolution is relative to `now`: pick today in the given zone (or host tz
 * if absent); if the result is already past, roll forward one day.
 */
export function parseHumanResetTime(text: string, now: number): number | null {
  const trimmed = text.trim();
  // Extract optional "(Zone/Area)" suffix.
  const zoneMatch = trimmed.match(/^(.*?)\s*\(([A-Za-z_]+\/[A-Za-z_]+|[A-Z]{2,4})\)\s*$/);
  const timePart = (zoneMatch ? zoneMatch[1] : trimmed).trim();
  const tz = zoneMatch ? zoneMatch[2] : undefined;

  // Accept "3pm", "3 pm", "3:00pm", "3:00 PM", "9:30am", with am/pm required.
  const tm = timePart.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!tm) return null;
  let hour = Number(tm[1]);
  const minute = tm[2] ? Number(tm[2]) : 0;
  const mer = tm[3].toLowerCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (mer === 'am' && hour === 12) hour = 0;
  else if (mer === 'pm' && hour !== 12) hour += 12;

  // Build "today at HH:MM" in the given zone, resolve to UTC ms.
  const ms = resolveLocalTimeToUtc(now, hour, minute, tz);
  if (ms === null) return null;

  // Roll to tomorrow if the computed time is already past.
  if (ms <= now) return ms + 24 * 60 * 60 * 1000;
  return ms;
}

/**
 * Given `now` (ms UTC), an hour/minute, and optional IANA timezone or short
 * abbreviation, return the UTC ms-epoch for "today at HH:MM" in that zone.
 *
 * Implementation uses Intl.DateTimeFormat to find the offset for `now` in the
 * target zone, then constructs the target instant. Short abbreviations (PDT,
 * EST, etc.) are not supported by Intl directly; for those we fall back to
 * host-local time and accept the imprecision (the sanity clamp catches any
 * wild miss).
 */
function resolveLocalTimeToUtc(
  now: number,
  hour: number,
  minute: number,
  tz: string | undefined,
): number | null {
  // Host-local path.
  if (!tz || !tz.includes('/')) {
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  }
  // IANA path: compute zone offset for `now`, apply to today's date at HH:MM.
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(now)).filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value]),
    );
    const y = Number(parts.year);
    const mo = Number(parts.month) - 1;
    const d = Number(parts.day);
    // Local "today at HH:MM" in the target zone, expressed as if it were UTC.
    const localAsUtc = Date.UTC(y, mo, d, hour, minute, 0, 0);
    // Find the zone's offset for `now`.
    const offsetMs = getZoneOffsetMs(tz, now);
    if (offsetMs === null) return null;
    return localAsUtc - offsetMs;
  } catch {
    return null;
  }
}

function getZoneOffsetMs(tz: string, at: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(new Date(at)).filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second), 0,
    );
    return asUtc - at;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Verify pass**

Run: `npm test -- src/server/orchestrator/resumeDetector.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/resumeDetector.ts src/server/orchestrator/resumeDetector.test.ts src/server/orchestrator/__fixtures__/resume-detector/
git commit -m "feat(orchestrator): pure resumeDetector for rate-limit classification"
```

---

## Task 7: Session-id post-run scan + mount directory helper

**Files:**
- Create: `src/server/orchestrator/sessionId.ts`
- Create: `src/server/orchestrator/sessionId.test.ts`

The scan is trivial: list `<mountDir>/**/*.jsonl` (one level of sub-dir for `<cwd-slug>`) and extract the UUID from the first filename. We keep it separate from `resumeDetector` because it touches the filesystem.

- [ ] **Step 1: Write failing tests**

Create `src/server/orchestrator/sessionId.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSessionId, runMountDir } from './sessionId.js';

function tempdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-sess-'));
}

describe('runMountDir', () => {
  it('returns <runsDir>/<id>/claude-projects', () => {
    expect(runMountDir('/var/lib/fbi/runs', 42))
      .toBe('/var/lib/fbi/runs/42/claude-projects');
  });
});

describe('scanSessionId', () => {
  it('returns null when directory does not exist', () => {
    expect(scanSessionId(path.join(tempdir(), 'missing'))).toBeNull();
  });

  it('returns null when no JSONL files are present', () => {
    const dir = tempdir();
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'other.txt'), 'x');
    expect(scanSessionId(dir)).toBeNull();
  });

  it('returns the UUID from a single JSONL filename under a sub-directory', () => {
    const dir = tempdir();
    const sub = path.join(dir, '-home-agent-workspace');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, 'b3e7f0a0-1234-5678-9abc-def012345678.jsonl'),
      'line\n',
    );
    expect(scanSessionId(dir)).toBe('b3e7f0a0-1234-5678-9abc-def012345678');
  });

  it('returns the newest file when several exist', () => {
    const dir = tempdir();
    const sub = path.join(dir, '-workspace');
    fs.mkdirSync(sub, { recursive: true });
    const older = path.join(sub, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
    const newer = path.join(sub, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');
    fs.writeFileSync(older, 'x');
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.writeFileSync(newer, 'y');
    fs.utimesSync(newer, new Date(2000), new Date(2000));
    expect(scanSessionId(dir)).toBe('bbbbbbbb-1111-2222-3333-444444444444');
  });

  it('rejects non-UUID .jsonl filenames', () => {
    const dir = tempdir();
    const sub = path.join(dir, '-workspace');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'not-a-uuid.jsonl'), 'x');
    expect(scanSessionId(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/server/orchestrator/sessionId.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/server/orchestrator/sessionId.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runMountDir(runsDir: string, runId: number): string {
  return path.join(runsDir, String(runId), 'claude-projects');
}

export function scanSessionId(mountDir: string): string | null {
  let subs: string[];
  try {
    subs = fs.readdirSync(mountDir);
  } catch {
    return null;
  }
  const candidates: Array<{ uuid: string; mtimeMs: number }> = [];
  for (const sub of subs) {
    const subPath = path.join(mountDir, sub);
    let files: string[];
    try {
      files = fs.readdirSync(subPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const base = file.slice(0, -'.jsonl'.length);
      if (!UUID_RE.test(base)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(subPath, file)).mtimeMs;
      } catch {
        continue;
      }
      candidates.push({ uuid: base, mtimeMs });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].uuid;
}
```

- [ ] **Step 4: Verify pass**

Run: `npm test -- src/server/orchestrator/sessionId.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/sessionId.ts src/server/orchestrator/sessionId.test.ts
git commit -m "feat(orchestrator): post-run session-id scan of claude-projects mount"
```

---

## Task 8: `ResumeScheduler` — in-memory timers, DB-backed rehydrate

**Files:**
- Create: `src/server/orchestrator/resumeScheduler.ts`
- Create: `src/server/orchestrator/resumeScheduler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/orchestrator/resumeScheduler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { ResumeScheduler } from './resumeScheduler.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const fired: number[] = [];
  const scheduler = new ResumeScheduler({
    runs,
    onFire: async (id) => { fired.push(id); },
  });
  return { runs, projectId: p.id, scheduler, fired };
}

describe('ResumeScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedule fires at the target time', async () => {
    const { scheduler, fired } = setup();
    scheduler.schedule(1, Date.now() + 1000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(fired).toEqual([1]);
  });

  it('fireAt in the past fires immediately', async () => {
    const { scheduler, fired } = setup();
    scheduler.schedule(2, Date.now() - 5000);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual([2]);
  });

  it('cancel prevents fire', async () => {
    const { scheduler, fired } = setup();
    scheduler.schedule(3, Date.now() + 500);
    scheduler.cancel(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toEqual([]);
  });

  it('fireNow fires on next tick and clears the timer', async () => {
    const { scheduler, fired } = setup();
    scheduler.schedule(4, Date.now() + 5000);
    scheduler.fireNow(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual([4]);
    // Advancing past original target must not re-fire.
    await vi.advanceTimersByTimeAsync(6000);
    expect(fired).toEqual([4]);
  });

  it('rehydrate schedules all awaiting rows', async () => {
    const { runs, projectId, scheduler, fired } = setup();
    for (const at of [1000, 2000]) {
      const r = runs.create({
        project_id: projectId, prompt: 'x',
        log_path_tmpl: (id) => `/tmp/${id}.log`,
      });
      runs.markStarted(r.id, 'c');
      runs.markAwaitingResume(r.id, { next_resume_at: Date.now() + at, last_limit_reset_at: Date.now() + at });
    }
    await scheduler.rehydrate();
    await vi.advanceTimersByTimeAsync(2500);
    expect(fired.length).toBe(2);
  });

  it('rehydrate tolerates rows with NULL next_resume_at (fires on next tick)', async () => {
    const { runs, projectId, scheduler, fired } = setup();
    const r = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(r.id, 'c');
    // Directly put it in awaiting_resume with null next_resume_at via the repo API:
    runs.markAwaitingResume(r.id, { next_resume_at: 0, last_limit_reset_at: 0 });
    await scheduler.rehydrate();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toContain(r.id);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/server/orchestrator/resumeScheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ResumeScheduler`**

Create `src/server/orchestrator/resumeScheduler.ts`:

```ts
import type { RunsRepo } from '../db/runs.js';

export interface ResumeSchedulerDeps {
  runs: RunsRepo;
  /** Invoked when a timer fires; never from within a setTimeout callback that holds a lock. */
  onFire: (runId: number) => Promise<void> | void;
}

export class ResumeScheduler {
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(private deps: ResumeSchedulerDeps) {}

  schedule(runId: number, fireAt: number): void {
    this.cancel(runId);
    const delay = Math.max(0, fireAt - Date.now());
    const t = setTimeout(() => {
      this.timers.delete(runId);
      void this.fire(runId);
    }, delay);
    this.timers.set(runId, t);
  }

  cancel(runId: number): void {
    const t = this.timers.get(runId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(runId);
    }
  }

  fireNow(runId: number): void {
    this.cancel(runId);
    setTimeout(() => { void this.fire(runId); }, 0);
  }

  async rehydrate(): Promise<void> {
    const rows = this.deps.runs.listAwaiting();
    for (const row of rows) {
      this.schedule(row.id, row.next_resume_at ?? 0);
    }
  }

  private async fire(runId: number): Promise<void> {
    try {
      await this.deps.onFire(runId);
    } catch {
      // Caller's responsibility to mark the run failed; swallow here.
    }
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `npm test -- src/server/orchestrator/resumeScheduler.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/resumeScheduler.ts src/server/orchestrator/resumeScheduler.test.ts
git commit -m "feat(orchestrator): ResumeScheduler with DB-backed rehydrate"
```

---

## Task 9: State broadcaster + registry sibling

**Files:**
- Create: `src/server/logs/stateBroadcaster.ts`
- Create: `src/server/logs/stateBroadcaster.test.ts`
- Modify: `src/server/logs/registry.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/logs/stateBroadcaster.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StateBroadcaster, type StateFrame } from './stateBroadcaster.js';

describe('StateBroadcaster', () => {
  it('delivers the latest frame to new subscribers', () => {
    const b = new StateBroadcaster();
    const f: StateFrame = {
      type: 'state', state: 'awaiting_resume',
      next_resume_at: 1, resume_attempts: 1, last_limit_reset_at: 1,
    };
    b.publish(f);
    const received: StateFrame[] = [];
    b.subscribe((x) => received.push(x));
    expect(received).toEqual([f]);
  });

  it('broadcasts subsequent frames to all subscribers', () => {
    const b = new StateBroadcaster();
    const a: StateFrame[] = [];
    const c: StateFrame[] = [];
    b.subscribe((x) => a.push(x));
    b.subscribe((x) => c.push(x));
    const f: StateFrame = {
      type: 'state', state: 'running',
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    };
    b.publish(f);
    expect(a).toEqual([f]);
    expect(c).toEqual([f]);
  });

  it('unsubscribe removes the listener', () => {
    const b = new StateBroadcaster();
    const received: StateFrame[] = [];
    const un = b.subscribe((x) => received.push(x));
    un();
    b.publish({
      type: 'state', state: 'running',
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });
    expect(received).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/server/logs/stateBroadcaster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the broadcaster**

Create `src/server/logs/stateBroadcaster.ts`:

```ts
import type { RunWsStateMessage } from '../../shared/types.js';

export type StateFrame = RunWsStateMessage;
type Listener = (frame: StateFrame) => void;

export class StateBroadcaster {
  private subs = new Set<Listener>();
  private last: StateFrame | null = null;

  publish(frame: StateFrame): void {
    this.last = frame;
    for (const s of this.subs) s(frame);
  }

  subscribe(listener: Listener): () => void {
    this.subs.add(listener);
    if (this.last) listener(this.last);
    return () => { this.subs.delete(listener); };
  }
}
```

- [ ] **Step 4: Extend the registry**

Replace `src/server/logs/registry.ts` with:

```ts
import { Broadcaster } from './broadcaster.js';
import { StateBroadcaster } from './stateBroadcaster.js';

export class RunStreamRegistry {
  private bytes = new Map<number, Broadcaster>();
  private state = new Map<number, StateBroadcaster>();

  getOrCreate(runId: number): Broadcaster {
    let b = this.bytes.get(runId);
    if (!b) {
      b = new Broadcaster();
      this.bytes.set(runId, b);
    }
    return b;
  }

  get(runId: number): Broadcaster | undefined {
    return this.bytes.get(runId);
  }

  getOrCreateState(runId: number): StateBroadcaster {
    let b = this.state.get(runId);
    if (!b) {
      b = new StateBroadcaster();
      this.state.set(runId, b);
    }
    return b;
  }

  getState(runId: number): StateBroadcaster | undefined {
    return this.state.get(runId);
  }

  release(runId: number): void {
    this.bytes.delete(runId);
    this.state.delete(runId);
  }
}
```

- [ ] **Step 5: Verify typecheck + registry tests pass**

Run: `npm test -- src/server/logs`
Expected: all pass (including the existing `registry.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/server/logs/stateBroadcaster.ts src/server/logs/stateBroadcaster.test.ts src/server/logs/registry.ts
git commit -m "feat(logs): StateBroadcaster + sibling map on RunStreamRegistry"
```

---

## Task 10: Supervisor `--resume` branch

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`

- [ ] **Step 1: Add the resume branch**

Replace the block in `src/server/orchestrator/supervisor.sh` that currently runs the agent (`# Run the agent.` through `set -e`) with:

```bash
# Run the agent. Two modes:
#   fresh: read composed prompt from /tmp/prompt.txt and stdin-pipe into claude.
#   resume: use $FBI_RESUME_SESSION_ID to continue an existing session.
set +e
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    echo "[fbi] resuming claude session $FBI_RESUME_SESSION_ID"
    claude --resume "$FBI_RESUME_SESSION_ID" --dangerously-skip-permissions
    CLAUDE_EXIT=$?
else
    claude --dangerously-skip-permissions < /tmp/prompt.txt
    CLAUDE_EXIT=$?
fi
set -e
```

The prompt-composition steps (lines 52–60) remain unchanged; `/tmp/prompt.txt` is simply unused on the resume path.

- [ ] **Step 2: Verify shell syntax**

Run: `bash -n src/server/orchestrator/supervisor.sh`
Expected: no output (no syntax errors). Nonzero exit means a typo.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): --resume branch when FBI_RESUME_SESSION_ID is set"
```

---

## Task 11: Orchestrator — post-run classification, `resume()` method, scheduler wiring

**Files:**
- Modify: `src/server/orchestrator/index.ts`

This is the biggest single task. We add: (1) a post-run `classify` branch that routes rate-limit exits to `markAwaitingResume` instead of `markFinished`, (2) the `resume()` method, (3) scheduler wiring through the constructor, (4) `rehydrate()` call on boot, (5) post-run session-id capture, (6) state-broadcast emission at transitions.

- [ ] **Step 1: Extend `OrchestratorDeps` and the constructor**

Near the top of `src/server/orchestrator/index.ts`:

```ts
import { classify, type RateLimitStateInput } from './resumeDetector.js';
import { ResumeScheduler } from './resumeScheduler.js';
import { scanSessionId, runMountDir } from './sessionId.js';
import { LogStore } from '../logs/store.js';
import fs from 'node:fs';
import type { RateLimitStateRepo } from '../db/rateLimitState.js';
```

Extend `OrchestratorDeps`:

```ts
export interface OrchestratorDeps {
  docker: Docker;
  config: Config;
  projects: ProjectsRepo;
  runs: RunsRepo;
  secrets: SecretsRepo;
  settings: SettingsRepo;
  mcpServers: McpServersRepo;
  streams: RunStreamRegistry;
  rateLimitState: RateLimitStateRepo;
}
```

Extend the `Orchestrator` constructor to build the scheduler:

```ts
  private scheduler: ResumeScheduler;

  constructor(private deps: OrchestratorDeps) {
    this.imageBuilder = new ImageBuilder(deps.docker);
    this.gc = new ImageGc(this.deps.docker, () => ({ always: ALWAYS, postbuild: POSTBUILD }));
    this.scheduler = new ResumeScheduler({
      runs: deps.runs,
      onFire: async (id) => {
        const run = this.deps.runs.get(id);
        if (!run || run.state !== 'awaiting_resume') return;
        await this.resume(id);
      },
    });
  }
```

- [ ] **Step 2: Add the mount directory + state publisher helpers**

Add as private methods on `Orchestrator`:

```ts
  private mountDirFor(runId: number): string {
    return runMountDir(this.deps.config.runsDir, runId);
  }

  private ensureMountDir(runId: number): string {
    const dir = this.mountDirFor(runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private publishState(runId: number): void {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    this.deps.streams.getOrCreateState(runId).publish({
      type: 'state',
      state: run.state,
      next_resume_at: run.next_resume_at,
      resume_attempts: run.resume_attempts,
      last_limit_reset_at: run.last_limit_reset_at,
    });
  }
```

- [ ] **Step 3: Build `createContainerForRun` (shared setup, not the full `launch`)**

`launch()` currently builds image → creates container → injects files → starts. Extract the container-creation + env + mounts into a helper so `resume()` can share the logic with one `Env`-extra and one extra `Binds` entry. Place this method on `Orchestrator`:

```ts
  private async createContainerForRun(
    runId: number,
    opts: { resumeSessionId: string | null },
    onBytes: (chunk: Uint8Array) => void,
  ): Promise<{ container: Docker.Container; imageTag: string; authCleanup: () => void }> {
    const run = this.deps.runs.get(runId)!;
    const project = this.deps.projects.get(run.project_id)!;
    const memMb = project.mem_mb ?? this.deps.config.containerMemMb;
    const cpus = project.cpus ?? this.deps.config.containerCpus;
    const pids = project.pids_limit ?? this.deps.config.containerPids;

    onBytes(Buffer.from(`[fbi] resolving image\n`));
    const devcontainerFile = await fetchDevcontainerFile(
      project.repo_url, this.deps.config.hostSshAuthSock, onBytes,
    );
    const imageTag = await this.imageBuilder.resolve({
      projectId: project.id,
      devcontainerFile,
      overrideJson: project.devcontainer_override_json,
      onLog: onBytes,
    });
    onBytes(Buffer.from(`[fbi] image: ${imageTag}\n`));

    const auth: GitAuth = new SshAgentForwarding(this.deps.config.hostSshAuthSock);
    const projectSecrets = this.deps.secrets.decryptAll(project.id);
    const authorName = project.git_author_name ?? this.deps.config.gitAuthorName;
    const authorEmail = project.git_author_email ?? this.deps.config.gitAuthorEmail;

    const settingsData = this.deps.settings.get();
    const marketplaces = uniq([...settingsData.global_marketplaces, ...project.marketplaces]);
    const plugins = uniq([...settingsData.global_plugins, ...project.plugins]);

    const mountDir = this.ensureMountDir(runId);

    onBytes(Buffer.from(`[fbi] starting container\n`));
    const container = await this.deps.docker.createContainer({
      Image: imageTag,
      name: `fbi-run-${runId}-${Date.now()}`,
      User: 'agent',
      Env: [
        `RUN_ID=${runId}`,
        `REPO_URL=${project.repo_url}`,
        `DEFAULT_BRANCH=${project.default_branch}`,
        `GIT_AUTHOR_NAME=${authorName}`,
        `GIT_AUTHOR_EMAIL=${authorEmail}`,
        `FBI_MARKETPLACES=${marketplaces.join('\n')}`,
        `FBI_PLUGINS=${plugins.join('\n')}`,
        'IS_SANDBOX=1',
        ...(opts.resumeSessionId ? [`FBI_RESUME_SESSION_ID=${opts.resumeSessionId}`] : []),
        ...Object.entries(auth.env()).map(([k, v]) => `${k}=${v}`),
        ...Object.entries(projectSecrets).map(([k, v]) => `${k}=${v}`),
      ],
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      Entrypoint: ['/usr/local/bin/supervisor.sh'],
      HostConfig: {
        AutoRemove: false,
        Memory: memMb * 1024 * 1024,
        NanoCpus: Math.round(cpus * 1e9),
        PidsLimit: pids,
        Binds: [
          `${SUPERVISOR}:/usr/local/bin/supervisor.sh:ro`,
          `${mountDir}:/home/agent/.claude/projects/`,
          ...claudeAuthMounts(this.deps.config.hostClaudeDir),
          ...auth.mounts().map((m) =>
            `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
          ),
        ],
      },
    });

    return { container, imageTag, authCleanup: () => { /* no-op */ } };
  }
```

Note: `name: fbi-run-<id>-<ts>` (instead of `fbi-run-<id>`) because `resume()` creates a second container for the same run and Docker requires unique names.

- [ ] **Step 4: Refactor `launch()` to use `createContainerForRun` and emit state on running**

Inside `launch()`, replace the container-create + logging preamble block (roughly lines 98–171 in the current file) with a call to `createContainerForRun(runId, { resumeSessionId: null }, onBytes)`, followed by the same `injectFiles` + attach + start + wait sequence as before. The key additions:

- Right after `markStarted(runId, container.id)`: `this.publishState(runId);`
- In the post-wait classification block (replacing the straight-line `markFinished`), add the branching code from Step 5.

Shape of the updated `launch()` body (elided parts unchanged):

```ts
  async launch(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.state !== 'queued') throw new Error(`run ${runId} not queued`);
    const project = this.deps.projects.get(run.project_id);
    if (!project) throw new Error(`project ${run.project_id} missing`);

    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk); broadcaster.publish(chunk);
    };

    const branchHint = run.branch_name;
    const preamble = [
      `You are working in /workspace on ${project.repo_url}.`,
      `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
      branchHint
        ? `Create or check out a branch named \`${branchHint}\`,`
        : `Create or check out a branch appropriately named for this task,`,
      'do your work there, and leave all commits on that branch.',
      '',
    ].join('\n');

    try {
      const { container } = await this.createContainerForRun(
        runId, { resumeSessionId: null }, onBytes,
      );
      const projectSecrets = this.deps.secrets.decryptAll(project.id);
      const effectiveMcps = this.deps.mcpServers.listEffective(project.id);

      await injectFiles(container, '/fbi', {
        'prompt.txt': run.prompt ?? '',
        'instructions.txt': project.instructions ?? '',
        'global.txt': this.deps.settings.get().global_prompt,
        'preamble.txt': preamble,
      });
      const claudeJson = buildContainerClaudeJson(
        this.deps.config.hostClaudeDir, effectiveMcps, projectSecrets,
      );
      await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);
      await injectFiles(
        container, '/home/agent/.claude',
        { 'settings.json': JSON.stringify({ skipDangerousModePermissionPrompt: true }) },
        1000,
      );

      const attach = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });
      attach.on('data', (c: Buffer) => onBytes(c));
      await container.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markStarted(runId, container.id);
      this.publishState(runId);

      await this.awaitAndComplete(runId, container, onBytes, store, broadcaster);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] error: ${msg}\n`));
      this.deps.runs.markFinished(runId, { state: 'failed', error: msg });
      this.publishState(runId);
      this.active.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
  }
```

- [ ] **Step 5: Extract `awaitAndComplete` shared between `launch()` and `resume()`**

Add as a private method:

```ts
  private async awaitAndComplete(
    runId: number,
    container: Docker.Container,
    onBytes: (chunk: Uint8Array) => void,
    store: LogStore,
    broadcaster: ReturnType<RunStreamRegistry['getOrCreate']>,
  ): Promise<void> {
    const waitRes = await container.wait();
    const inspect = await container.inspect().catch(() => null);
    const oomKilled = Boolean(inspect?.State?.OOMKilled);
    const wasCancelled = this.cancelled.delete(runId);
    const resultText = await readFileFromContainer(container, '/tmp/result.json').catch(() => '');
    const parsed = parseResultJson(resultText);

    // Capture Claude session id from the mount (idempotent on repeat runs).
    const sessionId = scanSessionId(this.mountDirFor(runId));
    if (sessionId) this.deps.runs.setClaudeSessionId(runId, sessionId);

    const failedNormally =
      !(waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0);
    const settings = this.deps.settings.get();

    if (failedNormally && !wasCancelled && settings.auto_resume_enabled) {
      const logTail = Buffer.from(LogStore.readAll(this.deps.runs.get(runId)!.log_path)).toString('utf8');
      const rls = this.deps.rateLimitState.get();
      const rlsInput: RateLimitStateInput | null = rls ? {
        requests_remaining: rls.requests_remaining,
        requests_limit: rls.requests_limit,
        tokens_remaining: rls.tokens_remaining,
        tokens_limit: rls.tokens_limit,
        reset_at: rls.reset_at,
      } : null;
      const verdict = classify(logTail, rlsInput, Date.now());

      if (verdict.kind === 'rate_limit' && verdict.reset_at !== null) {
        const run = this.deps.runs.get(runId)!;
        if (run.resume_attempts + 1 > settings.auto_resume_max_attempts) {
          onBytes(Buffer.from(
            `\n[fbi] rate limited; exceeded auto-resume cap (${settings.auto_resume_max_attempts} attempts)\n`,
          ));
          this.deps.runs.markFinished(runId, {
            state: 'failed',
            error: `rate limited; exceeded auto-resume cap (${settings.auto_resume_max_attempts} attempts)`,
          });
          this.publishState(runId);
        } else {
          this.deps.runs.markAwaitingResume(runId, {
            next_resume_at: verdict.reset_at,
            last_limit_reset_at: verdict.reset_at,
          });
          onBytes(Buffer.from(
            `\n[fbi] awaiting resume until ${new Date(verdict.reset_at).toISOString()}\n`,
          ));
          this.publishState(runId);
          this.scheduler.schedule(runId, verdict.reset_at);
          await container.remove({ force: true, v: true }).catch(() => {});
          this.active.delete(runId);
          // Keep log + broadcaster open — resume() will append.
          return;
        }
        await container.remove({ force: true, v: true }).catch(() => {});
        this.active.delete(runId);
        store.close(); broadcaster.end();
        this.deps.streams.release(runId);
        return;
      }
    }

    // Normal terminal path.
    const state: 'succeeded' | 'failed' | 'cancelled' = wasCancelled
      ? 'cancelled'
      : waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0
        ? 'succeeded'
        : 'failed';
    const branchFromResult =
      parsed?.branch && parsed.branch.length > 0 ? parsed.branch : null;
    const memMb = this.deps.projects.get(this.deps.runs.get(runId)!.project_id)?.mem_mb ?? this.deps.config.containerMemMb;
    this.deps.runs.markFinished(runId, {
      state,
      exit_code: parsed?.exit_code ?? waitRes.StatusCode,
      head_commit: parsed?.head_sha ?? null,
      branch_name: branchFromResult,
      error: state === 'failed'
        ? oomKilled
          ? `container OOM (memory cap ${memMb} MB)`
          : parsed
            ? parsed.push_exit !== 0
              ? `git push failed (code ${parsed.push_exit})`
              : `agent exit ${parsed.exit_code}`
            : `container exit ${waitRes.StatusCode}`
        : null,
    });
    onBytes(Buffer.from(`\n[fbi] run ${state}\n`));
    this.publishState(runId);
    await container.remove({ force: true, v: true }).catch(() => {});
    this.active.delete(runId);
    store.close(); broadcaster.end();
    this.deps.streams.release(runId);
  }
```

(The branches that previously lived inline in `launch()` are now all inside `awaitAndComplete`. Remove the old inline versions from `launch()` to avoid duplication.)

- [ ] **Step 6: Implement `resume(runId)`**

Add as a public method on `Orchestrator`:

```ts
  async resume(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.state !== 'awaiting_resume') return;

    // Reuse the existing log store and broadcaster.
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => { store.append(chunk); broadcaster.publish(chunk); };

    onBytes(Buffer.from(
      `\n[fbi] resuming (attempt ${run.resume_attempts} of ${this.deps.settings.get().auto_resume_max_attempts})\n`,
    ));

    try {
      const sessionId = run.claude_session_id; // may be null — supervisor falls through to fresh
      const { container } = await this.createContainerForRun(
        runId, { resumeSessionId: sessionId }, onBytes,
      );

      if (!sessionId) {
        onBytes(Buffer.from(`[fbi] resume: no session captured, starting fresh\n`));
        const project = this.deps.projects.get(run.project_id)!;
        const preamble = [
          `You are working in /workspace on ${project.repo_url}.`,
          `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
          run.branch_name
            ? `Create or check out a branch named \`${run.branch_name}\`,`
            : `Create or check out a branch appropriately named for this task,`,
          'do your work there, and leave all commits on that branch.',
          '',
        ].join('\n');
        await injectFiles(container, '/fbi', {
          'prompt.txt': run.prompt ?? '',
          'instructions.txt': project.instructions ?? '',
          'global.txt': this.deps.settings.get().global_prompt,
          'preamble.txt': preamble,
        });
      }

      const projectSecrets = this.deps.secrets.decryptAll(run.project_id);
      const effectiveMcps = this.deps.mcpServers.listEffective(run.project_id);
      const claudeJson = buildContainerClaudeJson(
        this.deps.config.hostClaudeDir, effectiveMcps, projectSecrets,
      );
      await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);
      await injectFiles(
        container, '/home/agent/.claude',
        { 'settings.json': JSON.stringify({ skipDangerousModePermissionPrompt: true }) },
        1000,
      );

      const attach = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });
      attach.on('data', (c: Buffer) => onBytes(c));
      await container.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markResuming(runId, container.id);
      this.publishState(runId);

      await this.awaitAndComplete(runId, container, onBytes, store, broadcaster);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] resume error: ${msg}\n`));
      this.deps.runs.markFinished(runId, { state: 'failed', error: `resume failed: ${msg}` });
      this.publishState(runId);
      this.active.delete(runId);
      store.close(); broadcaster.end(); this.deps.streams.release(runId);
    }
  }
```

- [ ] **Step 7: Extend `cancel()` to handle `awaiting_resume`**

Replace the existing `cancel` method with:

```ts
  async cancel(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    if (run.state === 'awaiting_resume') {
      this.scheduler.cancel(runId);
      this.deps.runs.markFinished(runId, { state: 'cancelled', error: null });
      this.publishState(runId);
      const bc = this.deps.streams.get(runId);
      bc?.end();
      this.deps.streams.release(runId);
      return;
    }
    const a = this.active.get(runId);
    if (!a) return;
    await a.container.stop({ t: 10 }).catch(() => {});
    this.cancelled.add(runId);
  }
```

- [ ] **Step 8: Public `fireResumeNow` method for the API handler**

Append:

```ts
  fireResumeNow(runId: number): void {
    this.scheduler.fireNow(runId);
  }

  async rehydrateSchedules(): Promise<void> {
    await this.scheduler.rehydrate();
  }
```

- [ ] **Step 9: Typecheck + existing tests**

Run:
- `npm run typecheck`
- `npm test -- src/server`

Expected: typecheck passes; unit tests pass. If any test constructs `new Orchestrator({...})`, it now needs a `rateLimitState` entry — pass `new RateLimitStateRepo(db)`.

- [ ] **Step 10: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): post-run rate-limit classification, resume(), scheduler wiring"
```

---

## Task 12: API — `POST /api/runs/:id/resume-now` and settings exposure

**Files:**
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/api/runs.test.ts`
- Modify: `src/server/api/settings.ts`
- Modify: `src/server/api/settings.test.ts` (create if missing)
- Modify: `src/server/index.ts` (thread new deps into the route registrations)

- [ ] **Step 1: Extend the runs-route `Deps` and add the new route**

In `src/server/api/runs.ts`, extend `Deps`:

```ts
interface Deps {
  runs: RunsRepo;
  projects: ProjectsRepo;
  gh: GhDeps;
  runsDir: string;
  launch: (runId: number) => Promise<void>;
  cancel: (runId: number) => Promise<void>;
  fireResumeNow: (runId: number) => void;
}
```

Inside `registerRunsRoutes`, add the endpoint (place it below the existing `DELETE /api/runs/:id`):

```ts
  app.post('/api/runs/:id/resume-now', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.state !== 'awaiting_resume') {
      return reply.code(409).send({ error: 'not awaiting resume' });
    }
    deps.fireResumeNow(run.id);
    reply.code(204);
  });
```

Also update the existing `GET /api/runs` query-param narrowing to accept `awaiting_resume`:

```ts
    const state = (q.state === 'running' || q.state === 'queued' ||
      q.state === 'succeeded' || q.state === 'failed' || q.state === 'cancelled' ||
      q.state === 'awaiting_resume')
      ? q.state : undefined;
```

And the `DELETE /api/runs/:id` — extend the "is this run active?" branch:

```ts
  app.delete('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.state === 'running' || run.state === 'awaiting_resume') {
      await deps.cancel(run.id);
    } else {
      deps.runs.delete(run.id);
      try { fs.unlinkSync(run.log_path); } catch { /* noop */ }
    }
    reply.code(204);
  });
```

- [ ] **Step 2: Write failing tests for the new endpoint**

Append to `src/server/api/runs.test.ts`:

```ts
describe('POST /api/runs/:id/resume-now', () => {
  it('404 when run missing', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST', url: '/api/runs/9999/resume-now',
    });
    expect(res.statusCode).toBe(404);
  });

  it('409 when run is not awaiting_resume', async () => {
    const { app, projectId } = setup();
    const created = await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/runs`,
      payload: { prompt: 'hi' },
    });
    const run = JSON.parse(created.body);
    const res = await app.inject({
      method: 'POST', url: `/api/runs/${run.id}/resume-now`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('204 and fires scheduler when awaiting_resume', async () => {
    // Reusing makeApp gives us direct access to the runs repo.
    const { app, runs, projects } = makeApp();
    const p = projects.create({
      name: 'x', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const r = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(r.id, 'c');
    runs.markAwaitingResume(r.id, { next_resume_at: 1, last_limit_reset_at: 1 });
    const fired: number[] = [];
    // Replace the deps on-the-fly by re-registering on a fresh Fastify:
    const app2 = Fastify();
    registerRunsRoutes(app2, {
      runs, projects, gh: stubGh, runsDir: '/tmp',
      launch: async () => {},
      cancel: async () => {},
      fireResumeNow: (id: number) => { fired.push(id); },
    });
    const res = await app2.inject({
      method: 'POST', url: `/api/runs/${r.id}/resume-now`,
    });
    expect(res.statusCode).toBe(204);
    expect(fired).toEqual([r.id]);
  });
});
```

Update the existing `setup()` in this file to pass a stub `fireResumeNow: () => {}` wherever the route is registered (and the same for `makeApp`). Add it to the imports if missing:

```ts
import Fastify from 'fastify';
```

- [ ] **Step 3: Settings API — validate and pass through the new fields**

In `src/server/api/settings.ts`, replace the `PATCH` body type with:

```ts
    const body = req.body as {
      global_prompt?: string;
      notifications_enabled?: boolean;
      concurrency_warn_at?: number;
      image_gc_enabled?: boolean;
      global_marketplaces?: string[];
      global_plugins?: string[];
      auto_resume_enabled?: boolean;
      auto_resume_max_attempts?: number;
    };
    if (body.auto_resume_max_attempts !== undefined) {
      const n = Number(body.auto_resume_max_attempts);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return { error: 'auto_resume_max_attempts must be integer in [1, 20]' };
      }
    }
```

(The `return { error: ... }` pattern matches how other FBI routes signal client errors inline — inspect neighboring files for the repo's convention and match exactly.)

- [ ] **Step 4: Add settings API tests**

If `src/server/api/settings.test.ts` does not exist, create it:

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { SettingsRepo } from '../db/settings.js';
import { registerSettingsRoutes } from './settings.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const settings = new SettingsRepo(db);
  const app = Fastify();
  registerSettingsRoutes(app, {
    settings,
    runGc: async () => ({ deletedCount: 0, deletedBytes: 0 }),
  });
  return { app };
}

describe('settings routes', () => {
  it('GET /api/settings includes auto-resume defaults', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(res.body);
    expect(body.auto_resume_enabled).toBe(true);
    expect(body.auto_resume_max_attempts).toBe(5);
  });

  it('PATCH rejects auto_resume_max_attempts out of range', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { auto_resume_max_attempts: 0 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/auto_resume_max_attempts/);
  });

  it('PATCH updates valid auto_resume fields', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings',
      payload: { auto_resume_enabled: false, auto_resume_max_attempts: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.auto_resume_enabled).toBe(false);
    expect(body.auto_resume_max_attempts).toBe(3);
  });
});
```

- [ ] **Step 5: Wire the new dep in `src/server/index.ts`**

Change the `registerRunsRoutes` call:

```ts
  registerRunsRoutes(app, {
    runs, projects, gh,
    runsDir: config.runsDir,
    launch: (id) => orchestrator.launch(id),
    cancel: (id) => orchestrator.cancel(id),
    fireResumeNow: (id) => orchestrator.fireResumeNow(id),
  });
```

Add a `RateLimitStateRepo` construction (after the other repos) and pass into the orchestrator:

```ts
import { RateLimitStateRepo } from './db/rateLimitState.js';
```

```ts
  const rateLimitState = new RateLimitStateRepo(db);
  const orchestrator = new Orchestrator({
    docker, config, projects, runs, secrets, settings, mcpServers, streams,
    rateLimitState,
  });
```

And after `await orchestrator.recover();`, add:

```ts
  await orchestrator.rehydrateSchedules();
```

- [ ] **Step 6: Run affected test suites**

Run:
- `npm test -- src/server/api`
- `npm run typecheck`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/api/runs.ts src/server/api/runs.test.ts src/server/api/settings.ts src/server/api/settings.test.ts src/server/index.ts
git commit -m "feat(api): POST /api/runs/:id/resume-now + settings auto-resume fields"
```

---

## Task 13: WebSocket — forward state frames as JSON text

**Files:**
- Modify: `src/server/api/ws.ts`
- Modify: `src/server/api/ws.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `src/server/api/ws.test.ts`:

```ts
import { StateBroadcaster } from '../logs/stateBroadcaster.js';

describe('WS state frames', () => {
  it('sends state frames as text JSON alongside the binary stream', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const streams = new RunStreamRegistry();
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({
      project_id: p.id, prompt: 'hi',
      log_path_tmpl: () => logPath,
    });
    runs.markStarted(run.id, 'c');
    // Pre-create state broadcaster with an initial frame.
    const sb = streams.getOrCreateState(run.id);
    sb.publish({
      type: 'state', state: 'running',
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });

    const app = Fastify();
    await app.register(fastifyWebsocket);
    registerWsRoute(app, {
      runs, streams,
      orchestrator: { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} },
    });
    await app.listen({ port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/runs/${run.id}/shell`);
    const texts: string[] = [];
    ws.on('message', (d, isBinary) => {
      if (!isBinary) texts.push(d.toString());
    });
    await new Promise<void>((res) => ws.on('open', () => res()));
    // Publish a transition.
    sb.publish({
      type: 'state', state: 'awaiting_resume',
      next_resume_at: 9000, resume_attempts: 1, last_limit_reset_at: 9000,
    });
    await new Promise<void>((res) => setTimeout(res, 50));
    ws.close();
    await new Promise<void>((res) => ws.on('close', () => res()));
    await app.close();

    // Expect at least the "awaiting_resume" frame; the initial "running" frame
    // may also arrive as replay.
    const parsed = texts.map((t) => JSON.parse(t));
    expect(parsed.some((x) => x.type === 'state' && x.state === 'awaiting_resume')).toBe(true);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- src/server/api/ws.test.ts`
Expected: FAIL — new test receives no text frames.

- [ ] **Step 3: Subscribe to the state broadcaster in `ws.ts`**

In `src/server/api/ws.ts`, inside the `app.get('/api/runs/:id/shell', …)` handler, after the existing `const bc = deps.streams.getOrCreate(runId);` line, add:

```ts
    const stateBc = deps.streams.getOrCreateState(runId);
    const unsubState = stateBc.subscribe((frame) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    });
```

And in the `socket.on('close', …)` handler, also call `unsubState()`:

```ts
    socket.on('close', () => { unsub(); unsubState(); });
```

- [ ] **Step 4: Verify pass**

Run: `npm test -- src/server/api/ws.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/ws.ts src/server/api/ws.test.ts
git commit -m "feat(ws): forward run state frames as JSON text over the shell socket"
```

---

## Task 14: Orchestrator-level unit test for the classification/scheduling path

Docker-free. Drives `awaitAndComplete` indirectly by building an `Orchestrator` in-memory with a stubbed docker and a canned container-wait result.

**Files:**
- Create: `src/server/orchestrator/autoResume.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/orchestrator/autoResume.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { SecretsRepo } from '../db/secrets.js';
import { SettingsRepo } from '../db/settings.js';
import { McpServersRepo } from '../db/mcpServers.js';
import { RateLimitStateRepo } from '../db/rateLimitState.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { classify } from './resumeDetector.js';

/**
 * The deep end-to-end resume flow is exercised in the Docker-gated
 * integration test. Here we just verify the classification+transition
 * contract via direct calls on RunsRepo + classify(), which together
 * define "what happens when a run's log says limit-reached":
 *
 * - We write a log containing the pipe-epoch form.
 * - We run classify() against it.
 * - We call markAwaitingResume with the parsed reset_at.
 * - We observe the state, the bump to resume_attempts, and listAwaiting.
 */
describe('auto-resume end-to-end (in-process)', () => {
  it('classifies a pipe-epoch limit log and transitions to awaiting_resume', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(dir, `${id}.log`),
    });
    runs.markStarted(run.id, 'c');

    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    const resetAtSec = Math.floor((now + 60 * 60_000) / 1000);
    const log = `... work ...\nClaude usage limit reached|${resetAtSec}\n`;
    const verdict = classify(log, null, now);
    expect(verdict.kind).toBe('rate_limit');
    expect(verdict.reset_at).toBe(resetAtSec * 1000);

    runs.markAwaitingResume(run.id, {
      next_resume_at: verdict.reset_at!,
      last_limit_reset_at: verdict.reset_at!,
    });
    const after = runs.get(run.id)!;
    expect(after.state).toBe('awaiting_resume');
    expect(after.resume_attempts).toBe(1);
    expect(after.next_resume_at).toBe(resetAtSec * 1000);
    expect(runs.listAwaiting().length).toBe(1);
  });

  it('cap-exceeded transitions to failed with the specific error string', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const settings = new SettingsRepo(db);
    settings.update({ auto_resume_max_attempts: 2 });

    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(dir, `${id}.log`),
    });
    runs.markStarted(run.id, 'c');
    runs.markAwaitingResume(run.id, { next_resume_at: 1, last_limit_reset_at: 1 });
    runs.markResuming(run.id, 'c2');
    runs.markAwaitingResume(run.id, { next_resume_at: 2, last_limit_reset_at: 2 });
    const cur = runs.get(run.id)!;
    const s = settings.get();

    // The third would exceed the cap of 2. Simulate the orchestrator's decision:
    expect(cur.resume_attempts + 1 > s.auto_resume_max_attempts).toBe(true);

    runs.markFinished(run.id, {
      state: 'failed',
      error: `rate limited; exceeded auto-resume cap (${s.auto_resume_max_attempts} attempts)`,
    });
    expect(runs.get(run.id)!.error).toMatch(/exceeded auto-resume cap \(2 attempts\)/);
  });
});
```

- [ ] **Step 2: Verify pass**

Run: `npm test -- src/server/orchestrator/autoResume.test.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/autoResume.test.ts
git commit -m "test(orchestrator): in-process auto-resume classification + cap path"
```

---

## Task 15: Docker-gated integration test — mocked dockerode

Rather than spinning real containers (which requires the image + supervisor + a functioning Claude install), the integration test for this feature uses a **mocked `dockerode`** that simulates the container lifecycle deterministically. The real `dockerode` is still used by the existing `image.test.ts` / orchestrator integration tests when Docker is reachable; this test is unit-style and runs in CI regardless.

**Files:**
- Create: `src/server/orchestrator/autoResume.flow.test.ts`

- [ ] **Step 1: Write the test**

Create `src/server/orchestrator/autoResume.flow.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { SecretsRepo } from '../db/secrets.js';
import { SettingsRepo } from '../db/settings.js';
import { McpServersRepo } from '../db/mcpServers.js';
import { RateLimitStateRepo } from '../db/rateLimitState.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { Orchestrator } from './index.js';

/**
 * Stub enough of dockerode for the orchestrator's launch+resume path:
 *  - createContainer returns a container with attach/start/wait/inspect/remove
 *  - attach + wait are driven by the test to simulate exit behavior
 *  - putArchive / getArchive no-op (or return the /tmp/result.json we decide)
 */
function makeStubDocker(scenarios: Array<{
  stdout: string; exitCode: number; resultJson: string;
}>) {
  const createdContainers: Array<{ envSeen: string[]; bindsSeen: string[] }> = [];
  let idx = 0;
  const stub = {
    createContainer: async (opts: { Env: string[]; HostConfig: { Binds: string[] } }) => {
      const s = scenarios[idx++];
      createdContainers.push({ envSeen: opts.Env, bindsSeen: opts.HostConfig.Binds });
      const events = new EventEmitter();
      const attachStream = new EventEmitter() as EventEmitter & {
        write: (b: Buffer) => void;
      };
      attachStream.write = () => {};
      return {
        id: `stub-${idx}`,
        attach: async () => attachStream,
        start: async () => {
          setImmediate(() => attachStream.emit('data', Buffer.from(s.stdout)));
        },
        wait: async () => ({ StatusCode: s.exitCode }),
        inspect: async () => ({ State: { OOMKilled: false } }),
        remove: async () => {},
        getArchive: async () => {
          // Simulate /tmp/result.json extraction.
          const tar = await import('tar-stream');
          const pack = tar.pack();
          pack.entry({ name: 'result.json' }, s.resultJson);
          pack.finalize();
          const chunks: Buffer[] = [];
          for await (const c of pack as unknown as AsyncIterable<Buffer>) chunks.push(c);
          const buf = Buffer.concat(chunks);
          // Return a readable stream over this buffer.
          const { Readable } = await import('node:stream');
          return Readable.from(buf);
        },
        putArchive: async () => {},
        resize: async () => {},
        stop: async () => {},
      };
    },
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]['docker'];
  return { stub, createdContainers };
}

function setup(runsDir: string) {
  const db = openDb(path.join(runsDir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const secrets = new SecretsRepo(db, Buffer.alloc(32));
  const settings = new SettingsRepo(db);
  const mcpServers = new McpServersRepo(db);
  const rateLimitState = new RateLimitStateRepo(db);
  const streams = new RunStreamRegistry();
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  return { db, projects, runs, secrets, settings, mcpServers, rateLimitState, streams, projectId: p.id };
}

describe('auto-resume flow (dockerode stubbed)', () => {
  it('launch → awaiting_resume → resume sets FBI_RESUME_SESSION_ID', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const ctx = setup(runsDir);

    const now = Math.floor(Date.now() / 1000);
    const resetSec = now + 60;
    // First run: Claude hits limit, emits pipe-epoch, exits 1.
    // Second run: exits clean with push_exit=0.
    const { stub: docker, createdContainers } = makeStubDocker([
      {
        stdout: `Claude usage limit reached|${resetSec}\n`,
        exitCode: 1,
        resultJson: JSON.stringify({
          exit_code: 1, push_exit: 0, head_sha: 'abc', branch: 'b',
        }),
      },
      {
        stdout: 'ok\n',
        exitCode: 0,
        resultJson: JSON.stringify({
          exit_code: 0, push_exit: 0, head_sha: 'def', branch: 'b',
        }),
      },
    ]);

    // Pre-seed a session JSONL under the expected mount path so resume picks
    // up the session id.
    const mountDir = path.join(runsDir, '1', 'claude-projects', '-workspace');
    fs.mkdirSync(mountDir, { recursive: true });
    fs.writeFileSync(
      path.join(mountDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
      'line\n',
    );

    const orch = new Orchestrator({
      docker,
      config: {
        runsDir,
        dbPath: path.join(runsDir, 'db.sqlite'),
        webDir: runsDir, port: 0,
        gitAuthorName: 'x', gitAuthorEmail: 'y',
        hostSshAuthSock: '', hostClaudeDir: '',
        containerMemMb: 2048, containerCpus: 2, containerPids: 512,
        secretsKeyFile: '/dev/null',
      } as never,
      projects: ctx.projects, runs: ctx.runs, secrets: ctx.secrets,
      settings: ctx.settings, mcpServers: ctx.mcpServers, streams: ctx.streams,
      rateLimitState: ctx.rateLimitState,
    });

    // Bypass image build + devcontainer fetch by stubbing the private call.
    // The cleanest way: mock ImageBuilder.resolve via prototype replacement.
    vi.spyOn(
      (orch as unknown as { imageBuilder: { resolve: () => Promise<string> } }).imageBuilder,
      'resolve',
    ).mockResolvedValue('test-image');

    const run = ctx.runs.create({
      project_id: ctx.projectId, prompt: 'p',
      log_path_tmpl: (id) => path.join(runsDir, `${id}.log`),
    });
    await orch.launch(run.id);

    const after = ctx.runs.get(run.id)!;
    expect(after.state).toBe('awaiting_resume');
    expect(after.next_resume_at).toBe(resetSec * 1000);
    expect(after.resume_attempts).toBe(1);
    expect(after.claude_session_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    // Fire the resume directly.
    await orch.resume(run.id);

    const final = ctx.runs.get(run.id)!;
    expect(final.state).toBe('succeeded');

    // Second container's Env includes FBI_RESUME_SESSION_ID.
    expect(
      createdContainers[1].envSeen.some((e) =>
        e === 'FBI_RESUME_SESSION_ID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      ),
    ).toBe(true);
    // Second container's Binds includes the claude-projects mount.
    expect(
      createdContainers[1].bindsSeen.some((b) =>
        b.endsWith(':/home/agent/.claude/projects/'),
      ),
    ).toBe(true);
  });

  it('cap-exceeded on the next would-be-resume marks run failed with cap message', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const ctx = setup(runsDir);
    ctx.settings.update({ auto_resume_max_attempts: 1 });

    const resetSec = Math.floor(Date.now() / 1000) + 60;
    const { stub: docker } = makeStubDocker([
      // Run 1: limit hit (attempt 1 is allowed).
      {
        stdout: `Claude usage limit reached|${resetSec}\n`,
        exitCode: 1,
        resultJson: JSON.stringify({
          exit_code: 1, push_exit: 0, head_sha: '', branch: '',
        }),
      },
      // Resume: hits limit again → should exceed cap of 1.
      {
        stdout: `Claude usage limit reached|${resetSec + 3600}\n`,
        exitCode: 1,
        resultJson: JSON.stringify({
          exit_code: 1, push_exit: 0, head_sha: '', branch: '',
        }),
      },
    ]);

    const orch = new Orchestrator({
      docker,
      config: {
        runsDir, dbPath: path.join(runsDir, 'db.sqlite'),
        webDir: runsDir, port: 0,
        gitAuthorName: 'x', gitAuthorEmail: 'y',
        hostSshAuthSock: '', hostClaudeDir: '',
        containerMemMb: 2048, containerCpus: 2, containerPids: 512,
        secretsKeyFile: '/dev/null',
      } as never,
      projects: ctx.projects, runs: ctx.runs, secrets: ctx.secrets,
      settings: ctx.settings, mcpServers: ctx.mcpServers, streams: ctx.streams,
      rateLimitState: ctx.rateLimitState,
    });
    vi.spyOn(
      (orch as unknown as { imageBuilder: { resolve: () => Promise<string> } }).imageBuilder,
      'resolve',
    ).mockResolvedValue('test-image');

    const run = ctx.runs.create({
      project_id: ctx.projectId, prompt: 'p',
      log_path_tmpl: (id) => path.join(runsDir, `${id}.log`),
    });
    await orch.launch(run.id);
    expect(ctx.runs.get(run.id)!.state).toBe('awaiting_resume');
    await orch.resume(run.id);
    const final = ctx.runs.get(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.error).toMatch(/exceeded auto-resume cap \(1 attempts\)/);
  });
});
```

- [ ] **Step 2: Verify pass**

Run: `npm test -- src/server/orchestrator/autoResume.flow.test.ts`
Expected: both tests pass. No Docker required.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/autoResume.flow.test.ts
git commit -m "test(orchestrator): stubbed-docker flow tests for auto-resume + cap"
```

---

## Final verification

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all non-Docker-gated tests pass; Docker-gated ones pass or skip.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 0 errors. Fix any complaints inline with the same coding style as neighboring files.

- [ ] **Step 4: Review the diff against the spec**

Skim `docs/superpowers/specs/2026-04-22-auto-resume-design.md` against the staged changes. Every section's requirements should be traceable to a committed change. If a spec bullet is missing, open a follow-up task before declaring done.
