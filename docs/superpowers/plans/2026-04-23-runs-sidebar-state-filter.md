# Runs sidebar — state filter, grouping, in-state timestamp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a state-filter popover, an optional group-by-state view, and an in-state-duration timestamp to the runs sidebar, backed by a new `state_entered_at` column on `runs`.

**Architecture:** One DB column plus updates to every state-mutating `RunsRepo` method → flows through the existing WS state-broadcast frame → consumed by a new `useRunsView` hook that manages filter/grouping + `localStorage` persistence → rendered by a new `StateFilterButton` popover, a modified `RunsFilter` row, and a modified `RunsList` that handles active-pinned flat mode or grouped-by-state mode.

**Tech Stack:** TypeScript, better-sqlite3, React 18, Vitest, React Testing Library, Tailwind with project tokens, existing WS stack in `src/server/logs/`.

**Reference spec:** `docs/superpowers/specs/2026-04-23-runs-sidebar-state-filter-design.md`

---

## File Structure

### Create

- `src/web/features/runs/useRunsView.ts` — hook: filter set, groupByState toggle, localStorage persistence, active-pinned / grouped ordering logic. Single responsibility: view state.
- `src/web/features/runs/useRunsView.test.ts` — hook tests.
- `src/web/features/runs/StateFilterButton.tsx` — icon-only trigger + anchored popover with state checkboxes and the group-by toggle. Pattern mirrors `src/web/ui/primitives/Menu.tsx` (outside-click + Escape close).
- `src/web/features/runs/StateFilterButton.test.tsx` — component tests.
- `src/web/features/runs/RunsList.test.tsx` — tests for grouped vs flat rendering, active-pinned divider, j/k navigation under a filter.

### Modify

- `src/server/db/schema.sql:28-43` — add `state_entered_at` column for fresh DBs.
- `src/server/db/index.ts:74-109` — idempotent migration that adds and backfills `state_entered_at` on existing DBs.
- `src/server/db/runs.ts:30-162` — every state-mutating method sets `state_entered_at`.
- `src/server/db/runs.test.ts` — new tests for `state_entered_at` across transitions.
- `src/shared/types.ts:29-56,91-97,179-187` — add `state_entered_at` to `Run`, `RunWsStateMessage`, `GlobalStateMessage`.
- `src/server/orchestrator/index.ts:126-142` — publish `state_entered_at` in `publishState`.
- `src/server/api/proxy.test.ts`, `src/server/api/ws.test.ts` — add the new field to literal `{ type: 'state', ... }` fixtures so types compile.
- `src/web/features/runs/RunsFilter.tsx` — accept view state, render input + `StateFilterButton` in one row.
- `src/web/features/runs/RunsList.tsx` — instantiate `useRunsView`, derive counts, render flat (with active-pinned divider) or grouped sections; keep j/k nav.
- `src/web/features/runs/RunRow.tsx:44` — use `state_entered_at` for the timestamp and extend the tooltip.
- `src/web/features/runs/RunRow.test.tsx:10-19` — add `state_entered_at` to the fixture run factory.

---

## Task 1: DB schema + migration + shared type for `state_entered_at`

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts`
- Modify: `src/shared/types.ts`
- Test: `src/server/db/runs.test.ts` (we extend it in later tasks; migration is validated by the existing bootstrap paths)

- [ ] **Step 1: Update `schema.sql` for fresh DBs**

In `src/server/db/schema.sql`, find the `CREATE TABLE IF NOT EXISTS runs (...)` block starting at line 28 and add `state_entered_at` alongside other `INTEGER NOT NULL` columns. The final table block should contain:

```sql
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  state TEXT NOT NULL,
  container_id TEXT,
  log_path TEXT NOT NULL,
  exit_code INTEGER,
  error TEXT,
  head_commit TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  state_entered_at INTEGER NOT NULL DEFAULT 0
);
```

(Copy the full existing block first — do not remove any unrelated columns.)

- [ ] **Step 2: Add idempotent migration**

In `src/server/db/index.ts`, after the existing `runs` migration block (around line 109, just before the TokenEater comment at line 111), add:

```ts
if (!runCols.has('state_entered_at')) {
  db.exec('ALTER TABLE runs ADD COLUMN state_entered_at INTEGER NOT NULL DEFAULT 0');
  db.exec(
    `UPDATE runs
        SET state_entered_at = COALESCE(finished_at, started_at, created_at)
      WHERE state_entered_at = 0`,
  );
}
```

- [ ] **Step 3: Update shared types**

In `src/shared/types.ts`:

Add `state_entered_at` to `Run` (after `created_at: number;` at line 42):

```ts
  state_entered_at: number;
```

Add it to `RunWsStateMessage` (around line 91):

```ts
export type RunWsStateMessage = {
  type: 'state';
  state: RunState;
  state_entered_at: number;
  next_resume_at: number | null;
  resume_attempts: number;
  last_limit_reset_at: number | null;
};
```

Add it to `GlobalStateMessage` (around line 179):

```ts
export interface GlobalStateMessage {
  type: 'state';
  run_id: number;
  project_id: number;
  state: RunState;
  state_entered_at: number;
  next_resume_at: number | null;
  resume_attempts: number;
  last_limit_reset_at: number | null;
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`
Expected: failures ONLY at call sites that now must include `state_entered_at` in `type: 'state'` literals (`src/server/orchestrator/index.ts`, `src/server/api/proxy.test.ts`, `src/server/api/ws.test.ts`). No other type errors. We fix those in Tasks 2 and 3.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts src/shared/types.ts
git commit -m "feat(db): add state_entered_at column + type plumbing"
```

---

## Task 2: Update `RunsRepo` to maintain `state_entered_at`

**Files:**
- Modify: `src/server/db/runs.ts`
- Test: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/server/db/runs.test.ts`:

```ts
describe('RunsRepo.state_entered_at', () => {
  let runs: RunsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepos();
    runs = r.runs;
    projectId = r.projectId;
  });

  it('sets state_entered_at on create (queued)', () => {
    const before = Date.now();
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    expect(run.state_entered_at).toBeGreaterThanOrEqual(before);
    expect(run.state_entered_at).toBeLessThanOrEqual(Date.now());
  });

  it('advances state_entered_at on each transition', async () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    const t0 = runs.get(run.id)!.state_entered_at;

    await new Promise((r) => setTimeout(r, 2));
    runs.markStarted(run.id, 'c1');
    const t1 = runs.get(run.id)!.state_entered_at;
    expect(t1).toBeGreaterThan(t0);

    await new Promise((r) => setTimeout(r, 2));
    runs.markWaiting(run.id);
    const t2 = runs.get(run.id)!.state_entered_at;
    expect(t2).toBeGreaterThan(t1);

    await new Promise((r) => setTimeout(r, 2));
    runs.markRunningFromWaiting(run.id);
    const t3 = runs.get(run.id)!.state_entered_at;
    expect(t3).toBeGreaterThan(t2);

    await new Promise((r) => setTimeout(r, 2));
    runs.markFinished(run.id, { state: 'succeeded', exit_code: 0 });
    const t4 = runs.get(run.id)!.state_entered_at;
    expect(t4).toBeGreaterThan(t3);
    expect(t4).toBe(runs.get(run.id)!.finished_at);
  });

  it('sets state_entered_at on markAwaitingResume and markResuming', async () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    const tRunning = runs.get(run.id)!.state_entered_at;

    await new Promise((r) => setTimeout(r, 2));
    runs.markAwaitingResume(run.id, { next_resume_at: Date.now() + 1000, last_limit_reset_at: null });
    const tAwaiting = runs.get(run.id)!.state_entered_at;
    expect(tAwaiting).toBeGreaterThan(tRunning);

    await new Promise((r) => setTimeout(r, 2));
    runs.markResuming(run.id, 'c2');
    const tResumed = runs.get(run.id)!.state_entered_at;
    expect(tResumed).toBeGreaterThan(tAwaiting);
  });
});
```

Note: the `finish` method exists (see the `FinishInput` type at the top of `runs.ts`); if its signature differs from the fixture above, adjust to match. If `finish` is currently missing a direct test helper, use whatever public method marks a run `succeeded`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/db/runs.test.ts`
Expected: new cases FAIL because the repo still returns `state_entered_at` as 0 from the schema default.

- [ ] **Step 3: Update `create`**

In `src/server/db/runs.ts`, modify the `INSERT` in `create()` (around lines 30-47) to include `state_entered_at`:

```ts
const stub = this.db
  .prepare(
    `INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at, state_entered_at)
     VALUES (?, ?, ?, 'queued', '', ?, ?)`
  )
  .run(input.project_id, input.prompt, branchHint, now, now);
```

- [ ] **Step 4: Update `markStarted`**

```ts
markStarted(id: number, containerId: string): void {
  const now = Date.now();
  this.db
    .prepare(
      "UPDATE runs SET state='running', container_id=?, started_at=?, state_entered_at=? WHERE id=?"
    )
    .run(containerId, now, now, id);
}
```

- [ ] **Step 5: Update `markAwaitingResume`**

```ts
markAwaitingResume(
  id: number,
  p: { next_resume_at: number; last_limit_reset_at: number | null },
): void {
  this.db
    .prepare(
      `UPDATE runs
          SET state='awaiting_resume',
              container_id=NULL,
              next_resume_at=?,
              last_limit_reset_at=?,
              resume_attempts = resume_attempts + 1,
              state_entered_at=?
        WHERE id=? AND state IN ('running','waiting')`,
    )
    .run(p.next_resume_at, p.last_limit_reset_at, Date.now(), id);
}
```

- [ ] **Step 6: Update `markResuming`**

```ts
markResuming(id: number, containerId: string): void {
  const now = Date.now();
  this.db
    .prepare(
      `UPDATE runs
          SET state='running',
              container_id=?,
              next_resume_at=NULL,
              started_at=COALESCE(started_at, ?),
              state_entered_at=?
        WHERE id=?`,
    )
    .run(containerId, now, now, id);
}
```

(Note: `started_at` is still COALESCE-preserved; `state_entered_at` is unconditionally refreshed — this is the intentional behavior described in the spec's Risks section.)

- [ ] **Step 7: Update `markContinuing`**

```ts
markContinuing(id: number, containerId: string): void {
  const now = Date.now();
  this.db
    .prepare(
      `UPDATE runs
          SET state='running',
              container_id=?,
              resume_attempts=0,
              next_resume_at=NULL,
              finished_at=NULL,
              exit_code=NULL,
              error=NULL,
              started_at=COALESCE(started_at, ?),
              state_entered_at=?
        WHERE id=? AND state IN ('failed','cancelled','succeeded')`,
    )
    .run(containerId, now, now, id);
}
```

- [ ] **Step 8: Update `markWaiting`**

```ts
markWaiting(id: number): void {
  this.db
    .prepare(`UPDATE runs SET state='waiting', state_entered_at=? WHERE id=? AND state='running'`)
    .run(Date.now(), id);
}
```

- [ ] **Step 9: Update `markRunningFromWaiting`**

```ts
markRunningFromWaiting(id: number): void {
  this.db
    .prepare(`UPDATE runs SET state='running', state_entered_at=? WHERE id=? AND state='waiting'`)
    .run(Date.now(), id);
}
```

- [ ] **Step 10: Update `markFinished`**

In `src/server/db/runs.ts` around line 205, replace the `markFinished` body so both `finished_at` and `state_entered_at` are set from the same `now`:

```ts
markFinished(id: number, f: FinishInput): void {
  if (f.branch_name !== undefined && f.branch_name !== null && f.branch_name !== '') {
    this.db
      .prepare('UPDATE runs SET branch_name = ? WHERE id = ?')
      .run(f.branch_name, id);
  }
  const now = Date.now();
  this.db
    .prepare(
      `UPDATE runs SET state=?, container_id=NULL, exit_code=?, error=?,
       head_commit=?, finished_at=?, state_entered_at=? WHERE id=?`
    )
    .run(
      f.state,
      f.exit_code ?? null,
      f.error ?? null,
      f.head_commit ?? null,
      now,
      now,
      id,
    );
}
```

No other terminal-state helpers exist in `runs.ts`; `markFinished` covers `succeeded`, `failed`, and `cancelled`.

- [ ] **Step 11: Run tests to verify they pass**

Run: `npx vitest run src/server/db/runs.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 12: Commit**

```bash
git add src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(db): maintain state_entered_at across every run state transition"
```

---

## Task 3: Broadcast `state_entered_at` over WS

**Files:**
- Modify: `src/server/orchestrator/index.ts`
- Modify: `src/server/api/proxy.test.ts`
- Modify: `src/server/api/ws.test.ts`

- [ ] **Step 1: Update `publishState` in the orchestrator**

In `src/server/orchestrator/index.ts`, modify the `publishState` method (around line 126) to include `state_entered_at`:

```ts
private publishState(runId: number): void {
  const run = this.deps.runs.get(runId);
  if (!run) return;
  const frame = {
    type: 'state' as const,
    state: run.state,
    state_entered_at: run.state_entered_at,
    next_resume_at: run.next_resume_at,
    resume_attempts: run.resume_attempts,
    last_limit_reset_at: run.last_limit_reset_at,
  };
  this.deps.streams.getOrCreateState(runId).publish(frame);
  this.deps.streams.getGlobalStates().publish({
    ...frame,
    run_id: runId,
    project_id: run.project_id,
  });
}
```

- [ ] **Step 2: Fix `proxy.test.ts` fixtures**

Every `publish({ type: 'state', ... })` call in `src/server/api/proxy.test.ts` (lines around 140, 170, 197, 209, 226, 238, 258, 280) must include `state_entered_at`. Replacement:

```ts
// before:
streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
// after:
streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', state_entered_at: Date.now(), next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
```

Apply to every such literal. For the ones that use `type: 'state', state: 'succeeded'` / `'awaiting_resume'` / etc., use the same `state_entered_at: Date.now()`.

- [ ] **Step 3: Fix `ws.test.ts` fixture**

In `src/server/api/ws.test.ts:160`, the literal `type: 'state' as const,` is at the start of a message object. Add `state_entered_at: Date.now(),` next to `state: ...`.

- [ ] **Step 4: Run server tests**

Run: `npx vitest run src/server`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/api/proxy.test.ts src/server/api/ws.test.ts
git commit -m "feat(orchestrator): broadcast state_entered_at in state frames"
```

---

## Task 4: `useRunsView` hook

**Files:**
- Create: `src/web/features/runs/useRunsView.ts`
- Create: `src/web/features/runs/useRunsView.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/web/features/runs/useRunsView.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRunsView, STORAGE_KEY, applyRunsView } from './useRunsView.js';
import type { Run, RunState } from '@shared/types.js';

function mkRun(id: number, state: RunState, createdAt: number): Run {
  return {
    id, project_id: 1, prompt: '', branch_name: '',
    state, container_id: null, log_path: '', exit_code: null,
    error: null, head_commit: null, started_at: null, finished_at: null,
    created_at: createdAt, state_entered_at: createdAt,
    resume_attempts: 0, next_resume_at: null,
    claude_session_id: null, last_limit_reset_at: null,
    tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0,
    tokens_total: 0, usage_parse_errors: 0,
    title: null, title_locked: 0,
  };
}

describe('useRunsView', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to empty filter and grouping off', () => {
    const { result } = renderHook(() => useRunsView());
    expect(result.current.filter.size).toBe(0);
    expect(result.current.groupByState).toBe(false);
  });

  it('persists toggleState to localStorage', () => {
    const { result } = renderHook(() => useRunsView());
    act(() => result.current.toggleState('running'));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.filter).toEqual(['running']);
  });

  it('rehydrates filter and groupByState', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filter: ['failed'], groupByState: true }));
    const { result } = renderHook(() => useRunsView());
    expect([...result.current.filter]).toEqual(['failed']);
    expect(result.current.groupByState).toBe(true);
  });

  it('drops unknown states on rehydrate', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filter: ['running', 'bogus'], groupByState: false }));
    const { result } = renderHook(() => useRunsView());
    expect([...result.current.filter]).toEqual(['running']);
  });

  it('falls back to defaults on invalid JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const { result } = renderHook(() => useRunsView());
    expect(result.current.filter.size).toBe(0);
    expect(result.current.groupByState).toBe(false);
  });

  it('clearFilter empties the set', () => {
    const { result } = renderHook(() => useRunsView());
    act(() => result.current.toggleState('running'));
    act(() => result.current.toggleState('waiting'));
    act(() => result.current.clearFilter());
    expect(result.current.filter.size).toBe(0);
  });
});

describe('applyRunsView', () => {
  const runs: Run[] = [
    mkRun(1, 'succeeded', 1000),
    mkRun(2, 'running',   2000),
    mkRun(3, 'failed',    3000),
    mkRun(4, 'waiting',   4000),
    mkRun(5, 'queued',    5000),
    mkRun(6, 'running',   6000),
  ];

  it('flat mode pins active states above rest, each sorted created_at DESC', () => {
    const out = applyRunsView(runs, { filter: new Set(), groupByState: false });
    expect(out.mode).toBe('flat');
    if (out.mode !== 'flat') return;
    expect(out.active.map((r) => r.id)).toEqual([6, 4, 2]); // running(6), waiting(4), running(2), but sorted created_at desc
    expect(out.rest.map((r) => r.id)).toEqual([5, 3, 1]);
  });

  it('grouped mode emits sections in fixed order with within-section created_at DESC', () => {
    const out = applyRunsView(runs, { filter: new Set(), groupByState: true });
    expect(out.mode).toBe('grouped');
    if (out.mode !== 'grouped') return;
    expect(out.groups.map((g) => g.state)).toEqual(['running', 'waiting', 'queued', 'succeeded', 'failed']);
    expect(out.groups.find((g) => g.state === 'running')!.runs.map((r) => r.id)).toEqual([6, 2]);
  });

  it('respects filter in flat mode', () => {
    const out = applyRunsView(runs, { filter: new Set<RunState>(['failed']), groupByState: false });
    expect(out.mode).toBe('flat');
    if (out.mode !== 'flat') return;
    expect(out.active).toEqual([]);
    expect(out.rest.map((r) => r.id)).toEqual([3]);
  });

  it('omits empty sections in grouped mode', () => {
    const out = applyRunsView([mkRun(1, 'running', 1), mkRun(2, 'failed', 2)], { filter: new Set(), groupByState: true });
    expect(out.mode).toBe('grouped');
    if (out.mode !== 'grouped') return;
    expect(out.groups.map((g) => g.state)).toEqual(['running', 'failed']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/web/features/runs/useRunsView.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the hook**

Create `src/web/features/runs/useRunsView.ts`:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Run, RunState } from '@shared/types.js';

export const STORAGE_KEY = 'fbi.runs.view.v1';

const ALL_STATES: readonly RunState[] = [
  'running', 'waiting', 'awaiting_resume', 'queued', 'succeeded', 'failed', 'cancelled',
];

const ACTIVE_STATES = new Set<RunState>(['running', 'waiting', 'awaiting_resume']);

const STATE_SET = new Set<string>(ALL_STATES);

interface StoredView {
  filter: RunState[];
  groupByState: boolean;
}

function loadStored(): StoredView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { filter: [], groupByState: false };
    const parsed = JSON.parse(raw) as Partial<StoredView>;
    const filter = Array.isArray(parsed.filter)
      ? parsed.filter.filter((s): s is RunState => typeof s === 'string' && STATE_SET.has(s))
      : [];
    const groupByState = typeof parsed.groupByState === 'boolean' ? parsed.groupByState : false;
    return { filter, groupByState };
  } catch {
    return { filter: [], groupByState: false };
  }
}

function saveStored(v: StoredView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* localStorage may be unavailable in some embedded contexts — ignore */
  }
}

export type RunsViewResult =
  | { mode: 'flat'; active: readonly Run[]; rest: readonly Run[] }
  | { mode: 'grouped'; groups: readonly { state: RunState; runs: readonly Run[] }[] };

export interface RunsView {
  filter: ReadonlySet<RunState>;
  groupByState: boolean;
  toggleState(s: RunState): void;
  clearFilter(): void;
  setGroupByState(v: boolean): void;
}

export function useRunsView(): RunsView {
  const [state, setState] = useState<StoredView>(() => loadStored());
  const filterSet = useMemo(() => new Set<RunState>(state.filter), [state.filter]);

  useEffect(() => { saveStored(state); }, [state]);

  const toggleState = useCallback((s: RunState) => {
    setState((prev) => {
      const next = new Set(prev.filter);
      if (next.has(s)) next.delete(s); else next.add(s);
      return { ...prev, filter: [...next] };
    });
  }, []);

  const clearFilter = useCallback(() => {
    setState((prev) => ({ ...prev, filter: [] }));
  }, []);

  const setGroupByState = useCallback((v: boolean) => {
    setState((prev) => ({ ...prev, groupByState: v }));
  }, []);

  return { filter: filterSet, groupByState: state.groupByState, toggleState, clearFilter, setGroupByState };
}

export function applyRunsView(
  runs: readonly Run[],
  view: { filter: ReadonlySet<RunState>; groupByState: boolean },
): RunsViewResult {
  const filtered = view.filter.size === 0 ? runs : runs.filter((r) => view.filter.has(r.state));
  const sorted = [...filtered].sort((a, b) => b.created_at - a.created_at);

  if (view.groupByState) {
    const groups = ALL_STATES
      .map((state) => ({ state, runs: sorted.filter((r) => r.state === state) }))
      .filter((g) => g.runs.length > 0);
    return { mode: 'grouped', groups };
  }

  const active = sorted.filter((r) => ACTIVE_STATES.has(r.state));
  const rest = sorted.filter((r) => !ACTIVE_STATES.has(r.state));
  return { mode: 'flat', active, rest };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/web/features/runs/useRunsView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/features/runs/useRunsView.ts src/web/features/runs/useRunsView.test.ts
git commit -m "feat(ui): useRunsView — filter + grouping + active-pinned ordering"
```

---

## Task 5: `StateFilterButton` component

**Files:**
- Create: `src/web/features/runs/StateFilterButton.tsx`
- Create: `src/web/features/runs/StateFilterButton.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/web/features/runs/StateFilterButton.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StateFilterButton } from './StateFilterButton.js';
import type { RunState } from '@shared/types.js';

function mkView(over: Partial<{ filter: Set<RunState>; groupByState: boolean }> = {}) {
  return {
    filter: over.filter ?? new Set<RunState>(),
    groupByState: over.groupByState ?? false,
    toggleState: vi.fn(),
    clearFilter: vi.fn(),
    setGroupByState: vi.fn(),
  };
}

const emptyCounts = {
  running: 0, waiting: 0, awaiting_resume: 0, queued: 0,
  succeeded: 0, failed: 0, cancelled: 0,
} as const;

describe('StateFilterButton', () => {
  it('shows no badge when filter is empty', () => {
    render(<StateFilterButton view={mkView()} counts={emptyCounts} />);
    expect(screen.queryByTestId('state-filter-badge')).toBeNull();
  });

  it('shows badge with filter size when filter is non-empty', () => {
    render(<StateFilterButton view={mkView({ filter: new Set<RunState>(['running', 'waiting']) })} counts={emptyCounts} />);
    expect(screen.getByTestId('state-filter-badge')).toHaveTextContent('2');
  });

  it('opens popover on click, closes on Escape', () => {
    render(<StateFilterButton view={mkView()} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    expect(screen.getByRole('checkbox', { name: /running/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('checkbox', { name: /running/i })).toBeNull();
  });

  it('toggleState called on checkbox change', () => {
    const view = mkView();
    render(<StateFilterButton view={view} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /running/i }));
    expect(view.toggleState).toHaveBeenCalledWith('running');
  });

  it('clearFilter called on "clear" click', () => {
    const view = mkView({ filter: new Set<RunState>(['running']) });
    render(<StateFilterButton view={view} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(view.clearFilter).toHaveBeenCalled();
  });

  it('"clear" is hidden when filter is empty', () => {
    const empty = mkView();
    render(<StateFilterButton view={empty} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  it('setGroupByState called on group toggle', () => {
    const view = mkView();
    render(<StateFilterButton view={view} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /group by state/i }));
    expect(view.setGroupByState).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/web/features/runs/StateFilterButton.test.tsx`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the component**

Create `src/web/features/runs/StateFilterButton.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { RunState } from '@shared/types.js';
import type { RunsView } from './useRunsView.js';
import { IconButton } from '@ui/primitives/IconButton.js';
import { Checkbox } from '@ui/primitives/Checkbox.js';
import { cn } from '@ui/cn.js';

const ORDER: readonly { state: RunState; label: string; tone: string }[] = [
  { state: 'running',         label: 'running',   tone: 'bg-run'    },
  { state: 'waiting',         label: 'waiting',   tone: 'bg-attn'   },
  { state: 'awaiting_resume', label: 'awaiting',  tone: 'bg-warn'   },
  { state: 'queued',          label: 'queued',    tone: 'bg-wait'   },
  { state: 'succeeded',       label: 'succeeded', tone: 'bg-ok'     },
  { state: 'failed',          label: 'failed',    tone: 'bg-fail'   },
  { state: 'cancelled',       label: 'cancelled', tone: 'bg-neutral'},
];

export type StateCounts = Record<RunState, number>;

export interface StateFilterButtonProps {
  view: RunsView;
  counts: StateCounts;
}

export function StateFilterButton({ view, counts }: StateFilterButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filterCount = view.filter.size;
  const active = filterCount > 0;

  return (
    <div ref={ref} className="relative inline-block">
      <IconButton
        aria-label="Filter by state"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative',
          active && 'bg-accent-subtle text-accent border border-accent',
        )}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 5h16l-6 8v6l-4-2v-4z" />
        </svg>
        {active && (
          <span
            data-testid="state-filter-badge"
            className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-[3px] text-[10px] leading-[14px] rounded-full bg-accent text-bg font-bold text-center"
          >
            {filterCount}
          </span>
        )}
      </IconButton>

      {open && (
        <div
          role="dialog"
          aria-label="Filter states"
          className="absolute right-0 mt-1 z-[var(--z-palette)] w-[220px] bg-surface-raised border border-border-strong rounded-md shadow-popover p-1.5"
        >
          <div className="flex items-center justify-between px-2 pb-1.5 mb-1 border-b border-border">
            <span className="text-[11px] uppercase tracking-[0.08em] text-text-faint">Filter states</span>
            {active && (
              <button
                type="button"
                onClick={() => view.clearFilter()}
                className="text-[11px] text-text-dim hover:text-text"
              >
                clear
              </button>
            )}
          </div>
          <ul className="space-y-0.5">
            {ORDER.map(({ state, label, tone }) => {
              const checked = view.filter.has(state);
              const id = `state-filter-${state}`;
              return (
                <li key={state}>
                  <label htmlFor={id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-surface cursor-pointer font-mono text-[12px] text-text">
                    <Checkbox id={id} aria-label={label} checked={checked} onChange={() => view.toggleState(state)} />
                    <span className={cn('w-[6px] h-[6px] rounded-full', tone)} />
                    <span className="flex-1">{label}</span>
                    <span className="text-[11px] text-text-faint">{counts[state]}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 pt-1.5 border-t border-border px-2 py-1">
            <label htmlFor="group-by-state" className="flex items-center gap-2 text-[12px] text-text cursor-pointer">
              <Checkbox
                id="group-by-state"
                aria-label="Group by state"
                checked={view.groupByState}
                onChange={(v) => view.setGroupByState(v)}
              />
              <span>Group by state</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Ensure tone background classes resolve in Tailwind**

The popover uses `bg-run`, `bg-wait`, `bg-attn`, `bg-warn`, `bg-ok`, `bg-fail`, `bg-neutral`. Inspect `tailwind.config.ts`:

Run: `grep -nE "run|wait|attn|warn|ok:|fail|neutral" /workspace/tailwind.config.ts`

If any of `run`, `wait`, `attn`, `warn`, `ok`, `fail`, `neutral` are missing as `bg-*` utilities, add them to the `theme.extend.colors` block using the corresponding CSS variables (e.g. `run: 'var(--run)'`). Do NOT inline hex. Mirror whichever pattern the config already uses for the tones that do exist. If all tones are already present (as the existing `Pill` implementation suggests), this step is a no-op.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/web/features/runs/StateFilterButton.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/features/runs/StateFilterButton.tsx src/web/features/runs/StateFilterButton.test.tsx tailwind.config.ts
git commit -m "feat(ui): StateFilterButton — popover with state checkboxes and group toggle"
```

---

## Task 6: Rework `RunsFilter` into a row

**Files:**
- Modify: `src/web/features/runs/RunsFilter.tsx`

- [ ] **Step 1: Read the current `RunsFilter`**

Confirm the current file is the 19-line input wrapper seen in the design spec. It will be extended to host the new button.

- [ ] **Step 2: Replace with the extended version**

Replace `src/web/features/runs/RunsFilter.tsx` contents:

```tsx
import { Input } from '@ui/primitives/Input.js';
import { StateFilterButton, type StateCounts } from './StateFilterButton.js';
import type { RunsView } from './useRunsView.js';

export interface RunsFilterProps {
  value: string;
  onChange: (v: string) => void;
  view: RunsView;
  counts: StateCounts;
}

export function RunsFilter({ value, onChange, view, counts }: RunsFilterProps) {
  return (
    <div className="p-2 border-b border-border bg-surface flex items-center gap-2">
      <Input
        className="flex-1 min-w-0"
        placeholder="Filter by prompt / branch / id…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <StateFilterButton view={view} counts={counts} />
    </div>
  );
}
```

- [ ] **Step 3: Commit (tests exercise this via RunsList tests in Task 7)**

```bash
git add src/web/features/runs/RunsFilter.tsx
git commit -m "feat(ui): RunsFilter — compose search input with StateFilterButton"
```

---

## Task 7: Rework `RunsList` with view state, active-pinning, and grouping

**Files:**
- Modify: `src/web/features/runs/RunsList.tsx`
- Create: `src/web/features/runs/RunsList.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/web/features/runs/RunsList.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RunsList } from './RunsList.js';
import { STORAGE_KEY } from './useRunsView.js';
import type { Run, RunState } from '@shared/types.js';

function mkRun(id: number, state: RunState, createdAt: number, title = `run-${id}`): Run {
  return {
    id, project_id: 1, prompt: '', branch_name: '',
    state, container_id: null, log_path: '', exit_code: null,
    error: null, head_commit: null, started_at: null, finished_at: null,
    created_at: createdAt, state_entered_at: createdAt,
    resume_attempts: 0, next_resume_at: null,
    claude_session_id: null, last_limit_reset_at: null,
    tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0,
    tokens_total: 0, usage_parse_errors: 0,
    title, title_locked: 0,
  };
}

function runs(): Run[] {
  return [
    mkRun(1, 'succeeded', 1000),
    mkRun(2, 'running',   2000),
    mkRun(3, 'failed',    3000),
    mkRun(4, 'waiting',   4000),
    mkRun(5, 'queued',    5000),
    mkRun(6, 'running',   6000),
  ];
}

describe('RunsList', () => {
  beforeEach(() => localStorage.clear());

  it('renders Active divider when active runs exist in flat mode', () => {
    render(
      <MemoryRouter>
        <RunsList runs={runs()} toHref={(r) => `/runs/${r.id}`} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Active · 3/)).toBeInTheDocument();
  });

  it('does not render Active divider when no active runs', () => {
    const only = [mkRun(1, 'succeeded', 1), mkRun(2, 'failed', 2)];
    render(<MemoryRouter><RunsList runs={only} toHref={(r) => `/runs/${r.id}`} /></MemoryRouter>);
    expect(screen.queryByText(/Active · /)).toBeNull();
  });

  it('groups by state in fixed order when grouping is on', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filter: [], groupByState: true }));
    render(<MemoryRouter><RunsList runs={runs()} toHref={(r) => `/runs/${r.id}`} /></MemoryRouter>);
    const labels = screen.getAllByTestId('runs-group-label').map((el) => el.textContent);
    // fixed order: running, waiting, awaiting_resume, queued, succeeded, failed, cancelled
    expect(labels).toEqual([
      expect.stringMatching(/running · 2/),
      expect.stringMatching(/waiting · 1/),
      expect.stringMatching(/queued · 1/),
      expect.stringMatching(/succeeded · 1/),
      expect.stringMatching(/failed · 1/),
    ]);
  });

  it('filters to a single state', () => {
    render(<MemoryRouter><RunsList runs={runs()} toHref={(r) => `/runs/${r.id}`} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /failed/i }));
    expect(screen.getByText('run-3')).toBeInTheDocument();
    expect(screen.queryByText('run-1')).toBeNull();
    expect(screen.queryByText('run-2')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/web/features/runs/RunsList.test.tsx`
Expected: FAIL — current RunsList has no view integration.

- [ ] **Step 3: Replace `RunsList` implementation**

Replace `src/web/features/runs/RunsList.tsx` contents:

```tsx
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RunsFilter } from './RunsFilter.js';
import { RunRow } from './RunRow.js';
import { useRunsView, applyRunsView } from './useRunsView.js';
import type { StateCounts } from './StateFilterButton.js';
import type { Run, RunState } from '@shared/types.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';

export interface RunsListProps {
  runs: readonly Run[];
  toHref: (r: Run) => string;
  currentId?: number | null;
}

const TONE_TEXT: Record<RunState, string> = {
  running: 'text-run',
  waiting: 'text-attn',
  awaiting_resume: 'text-warn',
  queued: 'text-wait',
  succeeded: 'text-ok',
  failed: 'text-fail',
  cancelled: 'text-neutral',
};

export function RunsList({ runs, toHref, currentId }: RunsListProps) {
  const [filter, setFilter] = useState('');
  const view = useRunsView();
  const nav = useNavigate();

  const textFiltered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return runs;
    return runs.filter((r) =>
      String(r.id).includes(q) ||
      (r.title ?? '').toLowerCase().includes(q) ||
      (r.branch_name ?? '').toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q),
    );
  }, [runs, filter]);

  const counts: StateCounts = useMemo(() => {
    const base: StateCounts = {
      running: 0, waiting: 0, awaiting_resume: 0, queued: 0,
      succeeded: 0, failed: 0, cancelled: 0,
    };
    for (const r of textFiltered) base[r.state]++;
    return base;
  }, [textFiltered]);

  const result = useMemo(
    () => applyRunsView(textFiltered, { filter: view.filter, groupByState: view.groupByState }),
    [textFiltered, view.filter, view.groupByState],
  );

  // Flatten for keyboard navigation so j/k walks the same order the user sees.
  const flatForNav: readonly Run[] = useMemo(() => {
    if (result.mode === 'flat') return [...result.active, ...result.rest];
    return result.groups.flatMap((g) => g.runs);
  }, [result]);

  const stateRef = useRef({ flatForNav, currentId, toHref, nav });
  stateRef.current = { flatForNav, currentId, toHref, nav };

  function step(dir: 1 | -1): void {
    const { flatForNav: list, currentId: cur, toHref: href, nav: n } = stateRef.current;
    if (list.length === 0) return;
    const idx = cur == null ? -1 : list.findIndex((r) => r.id === cur);
    const nextIdx = idx < 0 ? (dir === 1 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
    n(href(list[nextIdx]));
  }

  useKeyBinding({ chord: 'j', handler: () => step(1), description: 'Next run' }, []);
  useKeyBinding({ chord: 'k', handler: () => step(-1), description: 'Previous run' }, []);

  const running = runs.filter((r) => r.state === 'running').length;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Runs</h2>
        <span className="font-mono text-[12px] text-text-faint">{runs.length} · {running} running</span>
      </div>
      <RunsFilter value={filter} onChange={setFilter} view={view} counts={counts} />
      <div className="flex-1 min-h-0 overflow-auto">
        {result.mode === 'flat' ? (
          <>
            {result.active.length > 0 && (
              <div className="px-3 py-1 text-[11px] uppercase tracking-[0.08em] text-text-faint border-b border-border">
                Active · {result.active.length}
              </div>
            )}
            {result.active.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
            {result.rest.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
          </>
        ) : (
          result.groups.map((g) => (
            <div key={g.state}>
              <div
                data-testid="runs-group-label"
                className={`px-3 py-1 text-[11px] uppercase tracking-[0.08em] border-b border-border bg-surface ${TONE_TEXT[g.state]}`}
              >
                {g.state} · {g.runs.length}
              </div>
              {g.runs.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/web/features/runs/RunsList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run full web test suite as a smoke check**

Run: `npx vitest run src/web/features/runs`
Expected: PASS across `useRunsView`, `StateFilterButton`, `RunsList`, `RunRow`, and existing tests under `src/web/features/runs/`.

- [ ] **Step 6: Commit**

```bash
git add src/web/features/runs/RunsList.tsx src/web/features/runs/RunsList.test.tsx
git commit -m "feat(ui): RunsList — active-pinned, group-by-state, j/k over visible order"
```

---

## Task 8: `RunRow` uses `state_entered_at`

**Files:**
- Modify: `src/web/features/runs/RunRow.tsx`
- Modify: `src/web/features/runs/RunRow.test.tsx`

- [ ] **Step 1: Update the test fixture factory**

In `src/web/features/runs/RunRow.test.tsx`'s `mkRun` helper (lines 10-19), add the new field so it matches the updated `Run` type:

```ts
function mkRun(over: Partial<Run>): Run {
  return {
    id: 1, project_id: 1, prompt: 'do the thing', branch_name: 'branch-x',
    state: 'running', container_id: null, log_path: '/tmp/x', exit_code: null,
    error: null, head_commit: null, started_at: null, finished_at: null,
    created_at: Date.now(), state_entered_at: Date.now(),
    resume_attempts: 0, next_resume_at: null,
    claude_session_id: null, last_limit_reset_at: null,
    tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0,
    tokens_total: 0, usage_parse_errors: 0,
    title: null, title_locked: 0,
    ...over,
  };
}
```

- [ ] **Step 2: Add a test for the in-state timestamp**

Append to `src/web/features/runs/RunRow.test.tsx`:

```tsx
describe('RunRow timestamp', () => {
  it('uses state_entered_at for the rendered relative time', () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    render(
      <MemoryRouter>
        <RunRow run={mkRun({ state: 'running', state_entered_at: fiveMinAgo, created_at: Date.now() })} to="/runs/1" />
      </MemoryRouter>,
    );
    const time = screen.getByRole('time') ?? document.querySelector('time');
    expect(time).not.toBeNull();
    expect(time!.textContent).toMatch(/5m/);
    expect(time!.getAttribute('title') ?? '').toContain('running');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/web/features/runs/RunRow.test.tsx`
Expected: FAIL — `RunRow` currently passes `created_at` and has no state in the tooltip.

- [ ] **Step 4: Update `RunRow`**

In `src/web/features/runs/RunRow.tsx`, replace line 44 (the `<TimestampRelative iso={...} />`):

```tsx
<time
  dateTime={new Date(run.state_entered_at).toISOString()}
  title={`entered ${run.state} at ${new Date(run.state_entered_at).toLocaleString()}`}
  className="font-mono text-[13px] text-text-faint"
>
  {formatRelative(run.state_entered_at)}
</time>
```

Add the helper at the bottom of the file (or extract shared formatter from `TimestampRelative` if you prefer; inlining is fine here to keep the tooltip customization local):

```ts
function formatRelative(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 10) return 'now';
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}
```

Remove the `import { TimestampRelative } from '@ui/data/TimestampRelative.js';` line if no longer used in this file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/web/features/runs/RunRow.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full web smoke check**

Run: `npx vitest run src/web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/features/runs/RunRow.tsx src/web/features/runs/RunRow.test.tsx
git commit -m "feat(ui): RunRow — timestamp reflects time since current state"
```

---

## Task 9: Typecheck + server test sweep + manual Playwright verification

**Files:** none modified in this task; verifying end-to-end.

- [ ] **Step 1: Full typecheck**

Run: `npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors.

- [ ] **Step 2: Full test sweep**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 3: Start the dev server**

Run: `scripts/dev.sh` (in a background shell or separate terminal — the script should background itself).

- [ ] **Step 4: Manual UI verification with Playwright MCP**

From a browser (or the Playwright MCP server), open the app and verify:

- **Default view:** runs list shows `Active · N` divider only if runs with `running` / `waiting` / `awaiting_resume` exist, active runs above the divider-less rest.
- **Filter:** click the funnel icon next to the search input → popover opens with 7 state rows + counts + group-by toggle. Check `running`; list filters to running runs; funnel button shows a `1` badge and accent styling. `clear` link empties the filter.
- **Group by state:** check the toggle; list collapses into labeled sections in the fixed order. Uncheck; reverts to flat active-pinned.
- **Persistence:** reload the page. Filter selection and group-by state persist.
- **Timestamp:** for a `running` run, the row timestamp reflects `state_entered_at`. Hover → tooltip includes the state name. After a run completes, the timestamp resets to the completion time.
- **Keyboard:** `j` / `k` walks the visible order in whichever mode is active.

- [ ] **Step 5: Commit any fixes as regressions uncovered**

If manual verification uncovers regressions not caught by tests, fix them inline with a regression test added first.

- [ ] **Step 6: Final commit if anything changed**

```bash
git status
# if anything uncommitted:
git add -p   # stage deliberately
git commit -m "fix(ui): <specific regression>"
```

---

## Notes for the engineer

- **Active set is fixed:** `running`, `waiting`, `awaiting_resume`. Do not include `queued` — the spec is explicit about this.
- **Grouping supersedes active-pinning.** When `groupByState` is on, don't also apply the active-pinned hoist; the group order already handles it.
- **Counts semantics:** counts in the popover reflect runs visible to the text-search filter, not the filter-by-state selection. So e.g. if text search is `foo` and state filter is `{running}`, the popover still shows `succeeded: 5` among the `foo`-matching runs.
- **`markResuming` deliberately resets `state_entered_at`** while `started_at` stays COALESCE-preserved. This is the spec's Risks note in action; don't "fix" it.
- **No lucide-react dep** — the funnel icon is inline SVG.
- **Do not inline hex colors.** All colors via tokens. If a `bg-*` or `text-*` tone class is missing, add it to `tailwind.config.ts`, not inline.
- **Active pinning plus filtering:** if the user filters to `{succeeded}`, there are no active runs, so no "Active" divider renders — correct behavior.
