# FBI Post-v1 P2 Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the eleven P2 items from [`2026-04-21-p2-improvements-design.md`](../specs/2026-04-21-p2-improvements-design.md): scale & visibility, pre-run transparency, safety caps + image GC, GitHub status + PR creation, file-level diff, and related runs.

**Architecture:** Six self-contained phases, each of which leaves the app in a working state. Additive schema changes only. TDD at the server/db/repo layer; manual smoke for pure-UI changes. GitHub access shells out to the host `gh` CLI — any GitHub-touching endpoint degrades gracefully when `gh` is missing or the repo isn't on GitHub.

**Tech Stack:** Existing — Node 20+, TypeScript, Fastify, `@fastify/websocket`, `better-sqlite3`, `dockerode`, React 18, React Router 6, Vite, Tailwind, Vitest, Docker Engine, host `gh` CLI.

**Phase order (spec §9):** Scale → Pre-run → Safety → GitHub → Diff → Related runs. Lowest blast radius first, highest last. Ship each phase independently.

---

## File Structure

Files created in this plan:

```
src/
  shared/
    composePrompt.ts            # NEW: preamble+global+instructions+prompt concat (Phase 2)
    composePrompt.test.ts       # NEW: parity with supervisor.sh              (Phase 2)
    parseGitHubRepo.ts          # NEW: SSH/HTTPS URL -> "OWNER/REPO"           (Phase 4)
    parseGitHubRepo.test.ts     # NEW                                          (Phase 4)
  server/
    api/
      config.ts                 # NEW: GET /api/config/defaults                (Phase 2)
    github/
      gh.ts                     # NEW: GhClient — thin wrapper around `gh`    (Phase 4)
      gh.test.ts                # NEW                                          (Phase 4)
    orchestrator/
      imageGc.ts                # NEW: ImageGc class + scheduler              (Phase 3)
      imageGc.test.ts           # NEW                                          (Phase 3)
  web/
    components/
      StateBadge.tsx            # (already exists; reused)
```

Files modified in this plan:

```
src/
  shared/types.ts                          # Project.last_run, Settings 5 new fields
  server/
    db/schema.sql                          # +5 settings columns                   (Phase 3)
    db/index.ts                            # migration for those columns           (Phase 3)
    db/projects.ts                         # list() includes last_run               (Phase 1)
    db/projects.test.ts                    # last_run assertions                    (Phase 1)
    db/runs.ts                             # listFiltered, listSiblings             (Phase 1, 6)
    db/runs.test.ts                        # new tests                              (Phase 1, 6)
    db/settings.ts                         # 5 new fields                           (Phase 3)
    db/settings.test.ts                    # new assertions                         (Phase 3)
    api/projects.ts                        # no handler changes; list now returns last_run
    api/runs.ts                            # pagination/filters; github/diff/siblings (Phase 1,4,5,6)
    api/runs.test.ts                       # new tests                              (Phase 1,4,5,6)
    api/settings.ts                        # new fields passthrough                 (Phase 3)
    orchestrator/index.ts                  # start/stop ImageGc scheduler on boot   (Phase 3)
    index.ts                               # wire config route + pass settings to gc (Phase 2,3)
  web/
    lib/api.ts                             # new client methods                     (All)
    pages/
      Runs.tsx                             # filters, search, pagination, URL state (Phase 1)
      Projects.tsx                         # last-run badge + running chip           (Phase 1)
      NewRun.tsx                           # preview, plugin list, soft cap dialog  (Phase 2, 3)
      RunDetail.tsx                        # GitHub card, diff, siblings            (Phase 4, 5, 6)
      Settings.tsx                         # concurrency + GC controls              (Phase 3)
    hooks/
      useRunWatcher.ts                     # expose running-by-project map          (Phase 1)
```

---

## Preflight

- [ ] **Step 0: Baseline**

Run: `npm test && npm run typecheck`
Expected: all green. Establishes a clean baseline so every later failure is attributable to this plan's changes.

---

## Phase 1 — Scale & visibility

Additive only. No schema changes. Safe to ship standalone.

### Task 1.1: `RunsRepo.listFiltered`

**Files:**
- Modify: `src/server/db/runs.ts`
- Modify: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/server/db/runs.test.ts`:

```ts
it('listFiltered filters by state', () => {
  const a = runs.create({ project_id: projectId, prompt: 'x',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  runs.create({ project_id: projectId, prompt: 'y',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  runs.markStarted(a.id, 'c');
  runs.markFinished(a.id, { state: 'succeeded', exit_code: 0, head_commit: 'h' });

  const res = runs.listFiltered({ state: 'succeeded', limit: 50, offset: 0 });
  expect(res.total).toBe(1);
  expect(res.items.map((r) => r.id)).toEqual([a.id]);
});

it('listFiltered supports pagination', () => {
  for (let i = 0; i < 5; i++) {
    runs.create({ project_id: projectId, prompt: `p${i}`,
      log_path_tmpl: (id) => `/tmp/${id}.log` });
  }
  const page1 = runs.listFiltered({ limit: 2, offset: 0 });
  const page2 = runs.listFiltered({ limit: 2, offset: 2 });
  expect(page1.total).toBe(5);
  expect(page1.items.length).toBe(2);
  expect(page2.items.length).toBe(2);
  expect(page1.items[0].id).not.toBe(page2.items[0].id);
});

it('listFiltered supports prompt search (case-insensitive)', () => {
  runs.create({ project_id: projectId, prompt: 'FIX LOGIN bug',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  runs.create({ project_id: projectId, prompt: 'unrelated',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  const res = runs.listFiltered({ q: 'fix login', limit: 50, offset: 0 });
  expect(res.total).toBe(1);
  expect(res.items[0].prompt).toBe('FIX LOGIN bug');
});

it('listFiltered scopes by project_id', () => {
  // make a second project
  const otherProj = new (require('./projects.js').ProjectsRepo)((runs as any).db)
    .create({ name: 'p2', repo_url: 'b', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
  runs.create({ project_id: projectId, prompt: 'a',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  runs.create({ project_id: otherProj.id, prompt: 'b',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  const res = runs.listFiltered({ project_id: projectId, limit: 50, offset: 0 });
  expect(res.total).toBe(1);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: FAIL — `listFiltered` does not exist.

- [ ] **Step 3: Implement**

In `src/server/db/runs.ts`, add:

```ts
export interface ListFilteredInput {
  state?: RunState;
  project_id?: number;
  q?: string;
  limit: number;
  offset: number;
}

listFiltered(input: ListFilteredInput): { items: Run[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.state) { where.push('state = ?'); params.push(input.state); }
  if (typeof input.project_id === 'number') { where.push('project_id = ?'); params.push(input.project_id); }
  if (input.q && input.q.trim() !== '') {
    where.push('LOWER(prompt) LIKE ?');
    params.push('%' + input.q.trim().toLowerCase() + '%');
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (this.db
    .prepare(`SELECT COUNT(*) AS n FROM runs ${whereSql}`)
    .get(...params) as { n: number }).n;

  const items = this.db
    .prepare(`SELECT * FROM runs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, input.limit, input.offset) as Run[];

  return { items, total };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(db): RunsRepo.listFiltered with state/project/q/pagination"
```

---

### Task 1.2: Update `GET /api/runs` for pagination + filters

**Files:**
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/api/runs.test.ts`

Response shape for the list endpoint changes from `Run[]` to `{ items, total }`. Keep backwards-compat path: the unparametrised `GET /api/runs` with no query params still returns `Run[]` via the existing `listAll()` path. Paged/filtered requests return `{ items, total }`. Decide at response-shape time based on presence of `limit` or `offset` in the query string.

- [ ] **Step 1: Write failing API tests**

Append to `src/server/api/runs.test.ts`:

```ts
it('GET /api/runs?limit=2&offset=0 returns paged shape', async () => {
  const { app, projects, runs } = makeApp();
  const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null });
  for (let i = 0; i < 3; i++) {
    runs.create({ project_id: p.id, prompt: `p${i}`,
      log_path_tmpl: (id) => `/tmp/${id}.log` });
  }
  const res = await app.inject({ method: 'GET', url: '/api/runs?limit=2&offset=0' });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { items: unknown[]; total: number };
  expect(body.total).toBe(3);
  expect(body.items.length).toBe(2);
});

it('GET /api/runs?state=succeeded&q=login filters', async () => {
  const { app, projects, runs } = makeApp();
  const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null });
  const r1 = runs.create({ project_id: p.id, prompt: 'fix login',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  runs.create({ project_id: p.id, prompt: 'other',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  runs.markStarted(r1.id, 'c');
  runs.markFinished(r1.id, { state: 'succeeded' });

  const res = await app.inject({ method: 'GET', url: '/api/runs?state=succeeded&q=login&limit=50&offset=0' });
  const body = res.json() as { items: Array<{ prompt: string }>; total: number };
  expect(body.total).toBe(1);
  expect(body.items[0].prompt).toBe('fix login');
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- src/server/api/runs.test.ts`
Expected: FAIL (shape mismatch).

- [ ] **Step 3: Implement**

Replace the existing `GET /api/runs` handler in `src/server/api/runs.ts`:

```ts
app.get('/api/runs', async (req) => {
  const q = req.query as {
    state?: string; project_id?: string; q?: string; limit?: string; offset?: string;
  };
  const paged = q.limit !== undefined || q.offset !== undefined;
  const state = (q.state === 'running' || q.state === 'queued' ||
    q.state === 'succeeded' || q.state === 'failed' || q.state === 'cancelled')
    ? q.state : undefined;

  if (!paged) {
    if (state) return deps.runs.listByState(state);
    return deps.runs.listAll();
  }

  const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
  const offset = Math.max(0, Number(q.offset ?? 0));
  const project_id = q.project_id ? Number(q.project_id) : undefined;
  return deps.runs.listFiltered({ state, project_id, q: q.q, limit, offset });
});
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- src/server/api/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/runs.ts src/server/api/runs.test.ts
git commit -m "feat(api): /api/runs pagination + state/project/q filters"
```

---

### Task 1.3: `ProjectsRepo.list` includes `last_run`

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/projects.ts`
- Modify: `src/server/db/projects.test.ts`

- [ ] **Step 1: Extend `Project` shared type**

In `src/shared/types.ts`, inside `Project`:

```ts
last_run?: { id: number; state: RunState; created_at: number } | null;
```

- [ ] **Step 2: Write a failing test**

Append to `src/server/db/projects.test.ts`:

```ts
it('list() attaches last_run when runs exist', () => {
  const p = repo.create({
    name: 'withruns', repo_url: 'u', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const runs = new (require('./runs.js').RunsRepo)((repo as any).db);
  const r = runs.create({ project_id: p.id, prompt: 'x',
    log_path_tmpl: (id: number) => `/tmp/${id}.log` });
  const listed = repo.list().find((x) => x.id === p.id)!;
  expect(listed.last_run).toBeTruthy();
  expect(listed.last_run!.id).toBe(r.id);
});

it('list() returns last_run null when no runs', () => {
  const p = repo.create({
    name: 'empty', repo_url: 'u', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const listed = repo.list().find((x) => x.id === p.id)!;
  expect(listed.last_run).toBeNull();
});
```

- [ ] **Step 3: Run — expect failure**

Run: `npm test -- src/server/db/projects.test.ts`
Expected: FAIL — `last_run` not present.

- [ ] **Step 4: Implement**

In `src/server/db/projects.ts`, add a helper and modify `list()` only (keep `get()` unchanged — we only need `last_run` in list views):

```ts
private lastRunFor(projectId: number):
  { id: number; state: RunState; created_at: number } | null {
  const row = this.db
    .prepare(`SELECT id, state, created_at FROM runs
              WHERE project_id = ? ORDER BY id DESC LIMIT 1`)
    .get(projectId) as { id: number; state: RunState; created_at: number } | undefined;
  return row ?? null;
}

list(): Project[] {
  const rows = this.db
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
    .all() as ProjectRow[];
  return rows.map((row) => ({ ...fromRow(row), last_run: this.lastRunFor(row.id) }));
}
```

Add the import of `RunState` type at the top:

```ts
import type { Project, RunState } from '../../shared/types.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- src/server/db/projects.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/server/db/projects.ts src/server/db/projects.test.ts
git commit -m "feat(db): ProjectsRepo.list includes last_run"
```

---

### Task 1.4: `/runs` UI — filters, search, pagination, URL sync

**Files:**
- Modify: `src/web/lib/api.ts`
- Modify: `src/web/pages/Runs.tsx`

- [ ] **Step 1: Extend api.listRuns to support the paged shape**

In `src/web/lib/api.ts`, add a new method (don't remove old `listRuns` — the run-watcher still uses it):

```ts
async listRunsPaged(params: {
  state?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  project_id?: number;
  q?: string;
  limit: number;
  offset: number;
}): Promise<{ items: Run[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.state) qs.set('state', params.state);
  if (typeof params.project_id === 'number') qs.set('project_id', String(params.project_id));
  if (params.q) qs.set('q', params.q);
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset));
  return request<{ items: Run[]; total: number }>(`/api/runs?${qs.toString()}`);
},
```

- [ ] **Step 2: Rewrite `src/web/pages/Runs.tsx`**

Replace the component body. Use `useSearchParams` for URL state. Page size fixed at 50.

```tsx
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Run, Project, RunState } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';

const PAGE_SIZE = 50;

export function RunsPage() {
  const [params, setParams] = useSearchParams();
  const state = (params.get('state') ?? '') as RunState | '';
  const projectId = params.get('project_id') ?? '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1));

  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [qDraft, setQDraft] = useState(q);

  useEffect(() => { void api.listProjects().then(setProjects); }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const r = await api.listRunsPaged({
        state: state || undefined,
        project_id: projectId ? Number(projectId) : undefined,
        q: q || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      if (!controller.signal.aborted) {
        setRuns(r.items); setTotal(r.total);
      }
    };
    void load();
    return () => controller.abort();
  }, [state, projectId, q, page]);

  // Debounce search input into URL
  useEffect(() => {
    const h = setTimeout(() => {
      if (qDraft !== q) updateParams({ q: qDraft || undefined, page: '1' });
    }, 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft]);

  function updateParams(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k); else next.set(k, v);
    }
    setParams(next);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Runs</h1>
      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-sm">State
          <select value={state} onChange={(e) => updateParams({ state: e.target.value || undefined, page: '1' })}
            className="ml-2 border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100">
            <option value="">All</option>
            <option value="queued">queued</option>
            <option value="running">running</option>
            <option value="succeeded">succeeded</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
        <label className="text-sm">Project
          <select value={projectId} onChange={(e) => updateParams({ project_id: e.target.value || undefined, page: '1' })}
            className="ml-2 border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100">
            <option value="">All</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm flex-1">Search
          <input value={qDraft} onChange={(e) => setQDraft(e.target.value)}
            placeholder="prompt text…"
            className="ml-2 w-full border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100" />
        </label>
      </div>

      <ul className="divide-y dark:divide-gray-700">
        {runs.map((r) => (
          <li key={r.id} className="py-2 flex items-center gap-3">
            <StateBadge state={r.state} />
            <Link to={`/runs/${r.id}`} className="text-blue-700 dark:text-blue-300">Run #{r.id}</Link>
            <span className="text-sm text-gray-500 truncate">{r.prompt}</span>
          </li>
        ))}
      </ul>

      {total === 0 && <p className="text-sm text-gray-500">No runs match.</p>}

      <div className="flex items-center gap-2 text-sm">
        <button disabled={page <= 1} onClick={() => updateParams({ page: String(page - 1) })}
          className="border rounded px-2 py-1 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200">←</button>
        <span>Page {page} of {pages}</span>
        <button disabled={page >= pages} onClick={() => updateParams({ page: String(page + 1) })}
          className="border rounded px-2 py-1 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200">→</button>
        <span className="text-gray-500 ml-auto">{total} total</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual smoke**

Run: `npm run dev`. Visit `/runs`. Filter by state, by project, search. Confirm URL updates (`?state=failed`). Reload — filters preserved. Pagination next/prev works.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/api.ts src/web/pages/Runs.tsx
git commit -m "feat(ui): /runs filters, search, pagination, URL state sync"
```

---

### Task 1.5: `/projects` — last-run badge + running chip

**Files:**
- Modify: `src/web/pages/Projects.tsx`
- Modify: `src/web/hooks/useRunWatcher.ts`

The watcher already polls `GET /api/runs?state=running` every 5s. Expose the running set to consumers via a module-level subscribable store so Projects.tsx can read it without taking ownership of the poll.

- [ ] **Step 1: Add running-by-project store to `useRunWatcher.ts`**

Append to `src/web/hooks/useRunWatcher.ts`:

```ts
type Listener = (map: Map<number, number>) => void;
let lastMap = new Map<number, number>();
const listeners = new Set<Listener>();

export function _publishRunning(map: Map<number, number>) {
  lastMap = map;
  for (const l of listeners) l(map);
}

export function useRunningCounts(): Map<number, number> {
  const [m, setM] = useState(lastMap);
  useEffect(() => {
    const l: Listener = (x) => setM(new Map(x));
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return m;
}
```

Modify the `tick` function in the same file to call `_publishRunning`:

```ts
const tick = async () => {
  try {
    const running = await api.listRuns('running');
    const nowIds = new Set(running.map((r) => r.id));
    const countsByProject = new Map<number, number>();
    for (const r of running) {
      countsByProject.set(r.project_id, (countsByProject.get(r.project_id) ?? 0) + 1);
    }
    _publishRunning(countsByProject);
    // …existing finishedIds logic unchanged…
```

Add `useState, useEffect` imports if not already present.

- [ ] **Step 2: Read the store from `Projects.tsx`**

In `src/web/pages/Projects.tsx`, at the top of the component:

```tsx
import { useRunningCounts } from '../hooks/useRunWatcher.js';
import { StateBadge } from '../components/StateBadge.js';
// …
const running = useRunningCounts();
```

In each project card, after the project name, render:

```tsx
{running.get(p.id) ? (
  <span className="ml-2 text-xs text-green-600 dark:text-green-400">
    ● {running.get(p.id)} running
  </span>
) : null}
{p.last_run && (
  <span className="ml-2 inline-flex items-center gap-1 text-xs">
    <StateBadge state={p.last_run.state} />
    <span className="text-gray-500">{relativeTime(p.last_run.created_at)}</span>
  </span>
)}
```

Add a `relativeTime` helper at the bottom of `Projects.tsx`:

```tsx
function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
```

- [ ] **Step 3: Ensure watcher runs even when not logged into notifications**

The watcher currently short-circuits when `enabled === false`. That blocks the running-chip feature from populating when notifications are off. Two options:

1. Always run the poll; only gate *the notification side-effect* on `enabled`. Preferred.
2. Run two hooks.

Pick option 1. In `useRunWatcher.ts`, move the `if (!enabled) return;` check down so that:

```ts
export function useRunWatcher(enabled: boolean) {
  const prev = useRef<Set<number>>(new Set());
  useEffect(() => {
    const dispose = enabled ? installFocusReset() : () => {};
    let stopped = false;
    const tick = async () => {
      try {
        const running = await api.listRuns('running');
        const nowIds = new Set(running.map((r) => r.id));
        const countsByProject = new Map<number, number>();
        for (const r of running) {
          countsByProject.set(r.project_id, (countsByProject.get(r.project_id) ?? 0) + 1);
        }
        _publishRunning(countsByProject);

        if (enabled) {
          const finishedIds: number[] = [];
          prev.current.forEach((id) => { if (!nowIds.has(id)) finishedIds.push(id); });
          prev.current = nowIds;
          for (const id of finishedIds) {
            // …existing notifyComplete logic…
          }
        } else {
          prev.current = nowIds;
        }
      } catch { /* swallow */ }
      if (!stopped) setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { stopped = true; dispose(); };
  }, [enabled]);
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual smoke**

Run: `npm run dev`. Visit `/`. Confirm last-run badge + relative time appear for projects with runs. Start a run; confirm "● 1 running" chip appears within 5s on the home page.

- [ ] **Step 6: Commit**

```bash
git add src/web/pages/Projects.tsx src/web/hooks/useRunWatcher.ts
git commit -m "feat(ui): /projects last-run badge + running chip; watcher publishes counts"
```

---

### Task 1.6: Phase 1 verification

- [ ] **Step 1: Full test suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

Phase 1 complete.

---

## Phase 2 — Pre-run transparency

### Task 2.1: `composePrompt` shared helper

**Files:**
- Create: `src/shared/composePrompt.ts`
- Create: `src/shared/composePrompt.test.ts`

Parity contract with supervisor.sh: `[preamble.txt, global.txt, instructions.txt]` sections joined by `\n\n---\n\n` separators, then a `\n\n---\n\n` separator, then the run prompt. Skip empty sections.

- [ ] **Step 1: Write failing test**

Create `src/shared/composePrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { composePrompt } from './composePrompt.js';

describe('composePrompt', () => {
  it('joins all four sections with --- separators', () => {
    const out = composePrompt({
      preamble: 'P', globalPrompt: 'G', instructions: 'I', runPrompt: 'R',
    });
    expect(out).toBe('P\n\n---\n\nG\n\n---\n\nI\n\n---\n\nR');
  });

  it('skips empty preamble/global/instructions; always keeps run prompt', () => {
    expect(composePrompt({ preamble: '', globalPrompt: '', instructions: '', runPrompt: 'R' })).toBe('R');
    expect(composePrompt({ preamble: 'P', globalPrompt: '', instructions: '', runPrompt: 'R' })).toBe('P\n\n---\n\nR');
    expect(composePrompt({ preamble: '', globalPrompt: 'G', instructions: 'I', runPrompt: 'R' })).toBe('G\n\n---\n\nI\n\n---\n\nR');
  });

  it('treats whitespace-only sections as empty', () => {
    expect(composePrompt({ preamble: '  \n', globalPrompt: '', instructions: '', runPrompt: 'R' })).toBe('R');
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- src/shared/composePrompt.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/shared/composePrompt.ts`:

```ts
export interface ComposePromptInput {
  preamble: string;
  globalPrompt: string;
  instructions: string;
  runPrompt: string;
}

export function composePrompt(input: ComposePromptInput): string {
  const parts = [input.preamble, input.globalPrompt, input.instructions]
    .filter((s) => s.trim().length > 0);
  parts.push(input.runPrompt);
  return parts.join('\n\n---\n\n');
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- src/shared/composePrompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/composePrompt.ts src/shared/composePrompt.test.ts
git commit -m "feat(shared): composePrompt helper"
```

---

### Task 2.2: `GET /api/config/defaults`

**Files:**
- Create: `src/server/api/config.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Create the route**

```ts
// src/server/api/config.ts
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

interface Deps { config: Config }

export function registerConfigRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/config/defaults', async () => ({
    defaultMarketplaces: deps.config.defaultMarketplaces,
    defaultPlugins: deps.config.defaultPlugins,
  }));
}
```

- [ ] **Step 2: Wire it in**

In `src/server/index.ts`, import and register:

```ts
import { registerConfigRoutes } from './api/config.js';
// …after existing registrations:
registerConfigRoutes(app, { config });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/api/config.ts src/server/index.ts
git commit -m "feat(api): /api/config/defaults"
```

---

### Task 2.3: `api.getConfigDefaults` client

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Add method**

Near the `getSettings` method, add:

```ts
getConfigDefaults: () => request<{ defaultMarketplaces: string[]; defaultPlugins: string[] }>(
  '/api/config/defaults'
),
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/web/lib/api.ts
git commit -m "feat(api-client): getConfigDefaults"
```

---

### Task 2.4: NewRun — composed-prompt preview + effective plugins

**Files:**
- Modify: `src/web/pages/NewRun.tsx`

The preview needs the project (for repo_url, default_branch, instructions) and global prompt. Fetch both on mount.

- [ ] **Step 1: Fetch project + settings on mount**

At the top of `NewRunPage`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Project, Settings } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RecentPromptsDropdown } from '../components/RecentPromptsDropdown.js';
import { composePrompt } from '@shared/composePrompt.js';

const [project, setProject] = useState<Project | null>(null);
const [settings, setSettings] = useState<Settings | null>(null);
const [defaults, setDefaults] = useState<{ defaultMarketplaces: string[]; defaultPlugins: string[] } | null>(null);

useEffect(() => {
  void api.getProject(pid).then(setProject);
  void api.getSettings().then(setSettings);
  void api.getConfigDefaults().then(setDefaults);
}, [pid]);
```

- [ ] **Step 2: Compose the preview with the same preamble the server uses**

Add inside the component body (after state declarations, before return):

```tsx
const preamble = project ? [
  `You are working in /workspace on ${project.repo_url}.`,
  `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
  branch.trim()
    ? `Create or check out a branch named \`${branch.trim()}\`,`
    : `Create or check out a branch appropriately named for this task,`,
  'do your work there, and leave all commits on that branch.',
  '',
].join('\n') : '';

const composed = project && settings ? composePrompt({
  preamble,
  globalPrompt: settings.global_prompt,
  instructions: project.instructions ?? '',
  runPrompt: prompt,
}) : '';
```

- [ ] **Step 3: Render preview + plugins list**

Inside the `<form>`, above the submit button:

```tsx
<details className="border rounded dark:border-gray-600">
  <summary className="cursor-pointer px-3 py-2 text-sm select-none">
    Preview what Claude will receive
  </summary>
  <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 dark:text-gray-200 max-h-96 overflow-auto">
    {composed || '(loading…)'}
  </pre>
</details>

{project && defaults && (() => {
  const marketplaces = dedup([...defaults.defaultMarketplaces, ...project.marketplaces]);
  const plugins      = dedup([...defaults.defaultPlugins, ...project.plugins]);
  if (marketplaces.length + plugins.length === 0) return null;
  return (
    <div className="text-xs text-gray-600 dark:text-gray-400">
      <span className="font-medium">Effective plugins:</span>{' '}
      {plugins.length ? plugins.join(' · ') : '(none)'}
      {' '}<span className="text-gray-400">({marketplaces.length} marketplaces, {plugins.length} plugins)</span>
    </div>
  );
})()}
```

Add helper at the bottom:

```tsx
function dedup<T>(xs: T[]): T[] { return [...new Set(xs)]; }
```

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add src/web/pages/NewRun.tsx
git commit -m "feat(ui): composed-prompt preview + effective plugins on NewRun"
```

---

### Task 2.5: Phase 2 verification

- [ ] **Step 1: Full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Manual smoke**

Run: `npm run dev`. Open a NewRun page. Type a prompt. Expand preview — see the fully composed text. Change the branch input — preview updates. Confirm plugins line shows effective set.

Phase 2 complete.

---

## Phase 3 — Safety (concurrency + image GC)

### Task 3.1: Schema + migration for 5 settings columns

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts`

- [ ] **Step 1: Update schema (fresh installs)**

In `src/server/db/schema.sql`, inside the `settings` CREATE TABLE body:

```sql
  concurrency_warn_at INTEGER NOT NULL DEFAULT 3,
  image_gc_enabled INTEGER NOT NULL DEFAULT 0,
  last_gc_at INTEGER,
  last_gc_count INTEGER,
  last_gc_bytes INTEGER,
```

Update the `INSERT OR IGNORE` to include them explicitly:

```sql
INSERT OR IGNORE INTO settings
  (id, global_prompt, notifications_enabled, concurrency_warn_at, image_gc_enabled, updated_at)
VALUES (1, '', 1, 3, 0, 0);
```

- [ ] **Step 2: Migration for existing DBs**

In `src/server/db/index.ts`, after the existing `notifications_enabled` migration, add:

```ts
if (!settingsCols.has('concurrency_warn_at')) {
  db.exec('ALTER TABLE settings ADD COLUMN concurrency_warn_at INTEGER NOT NULL DEFAULT 3');
}
if (!settingsCols.has('image_gc_enabled')) {
  db.exec('ALTER TABLE settings ADD COLUMN image_gc_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!settingsCols.has('last_gc_at')) {
  db.exec('ALTER TABLE settings ADD COLUMN last_gc_at INTEGER');
}
if (!settingsCols.has('last_gc_count')) {
  db.exec('ALTER TABLE settings ADD COLUMN last_gc_count INTEGER');
}
if (!settingsCols.has('last_gc_bytes')) {
  db.exec('ALTER TABLE settings ADD COLUMN last_gc_bytes INTEGER');
}
```

- [ ] **Step 3: Verify existing DB tests still pass**

Run: `npm test -- src/server/db/index.test.ts src/server/db/settings.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts
git commit -m "feat(db): settings columns for concurrency warn + image GC"
```

---

### Task 3.2: `SettingsRepo` — read/write new fields

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/settings.ts`
- Modify: `src/server/db/settings.test.ts`

- [ ] **Step 1: Extend `Settings` type**

In `src/shared/types.ts`:

```ts
export interface Settings {
  global_prompt: string;
  notifications_enabled: boolean;
  concurrency_warn_at: number;
  image_gc_enabled: boolean;
  last_gc_at: number | null;
  last_gc_count: number | null;
  last_gc_bytes: number | null;
  updated_at: number;
}
```

- [ ] **Step 2: Write failing tests**

Append to `src/server/db/settings.test.ts`:

```ts
it('reads defaults for new settings fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const settings = new SettingsRepo(db);
  const s = settings.get();
  expect(s.concurrency_warn_at).toBe(3);
  expect(s.image_gc_enabled).toBe(false);
  expect(s.last_gc_at).toBeNull();
});

it('updates concurrency_warn_at and image_gc_enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const settings = new SettingsRepo(db);
  settings.update({ concurrency_warn_at: 5, image_gc_enabled: true });
  const s = settings.get();
  expect(s.concurrency_warn_at).toBe(5);
  expect(s.image_gc_enabled).toBe(true);
});

it('records last GC stats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const settings = new SettingsRepo(db);
  settings.recordGc({ at: 1234, count: 3, bytes: 2048 });
  const s = settings.get();
  expect(s.last_gc_at).toBe(1234);
  expect(s.last_gc_count).toBe(3);
  expect(s.last_gc_bytes).toBe(2048);
});
```

- [ ] **Step 3: Run — expect failure**

Run: `npm test -- src/server/db/settings.test.ts`
Expected: FAIL.

- [ ] **Step 4: Rewrite `SettingsRepo`**

Replace `src/server/db/settings.ts`:

```ts
import type { DB } from './index.js';
import type { Settings } from '../../shared/types.js';

interface SettingsRow {
  id: number;
  global_prompt: string;
  notifications_enabled: number;
  concurrency_warn_at: number;
  image_gc_enabled: number;
  last_gc_at: number | null;
  last_gc_count: number | null;
  last_gc_bytes: number | null;
  updated_at: number;
}

export class SettingsRepo {
  constructor(private db: DB) {}

  get(): Settings {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as SettingsRow | undefined;
    if (!row) {
      const now = Date.now();
      this.db.prepare(
        `INSERT INTO settings (id, global_prompt, notifications_enabled, concurrency_warn_at, image_gc_enabled, updated_at)
         VALUES (1, '', 1, 3, 0, ?)`
      ).run(now);
      return this.get();
    }
    return {
      global_prompt: row.global_prompt,
      notifications_enabled: row.notifications_enabled === 1,
      concurrency_warn_at: row.concurrency_warn_at,
      image_gc_enabled: row.image_gc_enabled === 1,
      last_gc_at: row.last_gc_at,
      last_gc_count: row.last_gc_count,
      last_gc_bytes: row.last_gc_bytes,
      updated_at: row.updated_at,
    };
  }

  update(patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
    concurrency_warn_at?: number;
    image_gc_enabled?: boolean;
  }): Settings {
    const existing = this.get();
    const merged = {
      global_prompt: patch.global_prompt ?? existing.global_prompt,
      notifications_enabled: patch.notifications_enabled ?? existing.notifications_enabled,
      concurrency_warn_at: patch.concurrency_warn_at ?? existing.concurrency_warn_at,
      image_gc_enabled: patch.image_gc_enabled ?? existing.image_gc_enabled,
    };
    const now = Date.now();
    this.db.prepare(
      `UPDATE settings SET
        global_prompt = ?, notifications_enabled = ?,
        concurrency_warn_at = ?, image_gc_enabled = ?, updated_at = ?
       WHERE id = 1`
    ).run(
      merged.global_prompt,
      merged.notifications_enabled ? 1 : 0,
      merged.concurrency_warn_at,
      merged.image_gc_enabled ? 1 : 0,
      now,
    );
    return this.get();
  }

  recordGc(stats: { at: number; count: number; bytes: number }): void {
    this.db.prepare(
      'UPDATE settings SET last_gc_at = ?, last_gc_count = ?, last_gc_bytes = ? WHERE id = 1'
    ).run(stats.at, stats.count, stats.bytes);
  }
}
```

- [ ] **Step 5: Run — expect pass**

Run: `npm test -- src/server/db/settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/server/db/settings.ts src/server/db/settings.test.ts
git commit -m "feat(db): SettingsRepo concurrency + GC fields"
```

---

### Task 3.3: Settings API passthrough + `recordGc` exposure

**Files:**
- Modify: `src/server/api/settings.ts`

- [ ] **Step 1: Extend PATCH handler**

Replace the PATCH body type:

```ts
app.patch('/api/settings', async (req) => {
  const body = req.body as {
    global_prompt?: string;
    notifications_enabled?: boolean;
    concurrency_warn_at?: number;
    image_gc_enabled?: boolean;
  };
  return deps.settings.update(body);
});
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/server/api/settings.ts
git commit -m "feat(api): settings concurrency + GC passthrough"
```

---

### Task 3.4: `ImageGc` — reachability and sweep

**Files:**
- Create: `src/server/orchestrator/imageGc.ts`
- Create: `src/server/orchestrator/imageGc.test.ts`

The class accepts a dockerode-shaped client so we can test with a fake.

- [ ] **Step 1: Write failing tests**

Create `src/server/orchestrator/imageGc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ImageGc, type DockerLike } from './imageGc.js';
import { computeConfigHash } from './configHash.js';
import type { Project } from '../../shared/types.js';

function project(id: number, devcontainer: string | null, override: string | null): Project {
  return {
    id, name: `p${id}`, repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: override, instructions: null,
    git_author_name: null, git_author_email: null,
    marketplaces: [], plugins: [],
    mem_mb: null, cpus: null, pids_limit: null,
    created_at: 0, updated_at: 0,
  };
}

function fakeDocker(images: Array<{ id: string; tags: string[]; created: number }>,
  containers: Array<{ id: string; image_id: string }>): DockerLike {
  const removed: string[] = [];
  return {
    listImages: async () => images.map((i) => ({
      Id: i.id, RepoTags: i.tags, Created: i.created, Size: 1024,
    })),
    listContainers: async () => containers.map((c) => ({
      Id: c.id, ImageID: c.image_id,
    })),
    getImage: (ref: string) => ({
      remove: async () => { removed.push(ref); },
    }),
    _removed: removed,
  } as unknown as DockerLike & { _removed: string[] };
}

describe('ImageGc.sweep', () => {
  it('keeps reachable project images', async () => {
    const p = project(1, null, null);
    const hash = computeConfigHash({
      devcontainer_file: null, override_json: null,
      always: [], postbuild: '',
    });
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: [`fbi/p1:${hash}`], created: now - 90 * 86400 }],
      []
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(0);
    expect((docker as any)._removed).toEqual([]);
  });

  it('keeps images referenced by any container even if old', async () => {
    const p = project(1, null, null);
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: ['fbi/p99:orphan'], created: now - 90 * 86400 }],
      [{ id: 'c1', image_id: 'sha1' }]
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(0);
  });

  it('deletes unreachable fbi/ images older than 30 days', async () => {
    const p = project(1, null, null);
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: ['fbi/p99:orphan'], created: now - 31 * 86400 }],
      []
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(1);
    expect((docker as any)._removed).toEqual(['fbi/p99:orphan']);
  });

  it('keeps unreachable fbi/ images newer than 30 days', async () => {
    const p = project(1, null, null);
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: ['fbi/p99:recent'], created: now - 10 * 86400 }],
      []
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(0);
  });

  it('never touches non-fbi images', async () => {
    const p = project(1, null, null);
    const now = Math.floor(Date.now() / 1000);
    const docker = fakeDocker(
      [{ id: 'sha1', tags: ['ubuntu:24.04', 'node:20'], created: now - 90 * 86400 }],
      []
    );
    const gc = new ImageGc(docker, () => ({ always: [], postbuild: '' }));
    const res = await gc.sweep([p], now * 1000);
    expect(res.deletedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- src/server/orchestrator/imageGc.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/server/orchestrator/imageGc.ts`:

```ts
import type Docker from 'dockerode';
import type { Project } from '../../shared/types.js';
import { computeConfigHash } from './configHash.js';

const RETENTION_DAYS = 30;

export interface DockerLike {
  listImages: (opts?: object) => Promise<Array<{ Id: string; RepoTags?: string[] | null; Created: number; Size?: number }>>;
  listContainers: (opts?: { all: boolean }) => Promise<Array<{ Id: string; ImageID: string }>>;
  getImage: (ref: string) => { remove: (opts?: object) => Promise<void> };
}

export interface GcConfig {
  always: string[];
  postbuild: string;
}

export interface SweepResult {
  deletedCount: number;
  deletedBytes: number;
  errors: Array<{ tag: string; message: string }>;
}

export class ImageGc {
  constructor(
    private docker: DockerLike,
    private readConfig: () => GcConfig,
  ) {}

  async sweep(projects: Project[], nowMs: number): Promise<SweepResult> {
    const cfg = this.readConfig();
    const reachable = new Set<string>();
    for (const p of projects) {
      const hash = computeConfigHash({
        devcontainer_file: null, // project-level cache: we don't have the repo file here
        override_json: p.devcontainer_override_json,
        always: cfg.always,
        postbuild: cfg.postbuild,
      });
      reachable.add(`fbi/p${p.id}:${hash}`);
      reachable.add(`fbi/p${p.id}-base:${hash}`);
    }

    const containers = await this.docker.listContainers({ all: true });
    const usedImageIds = new Set(containers.map((c) => c.ImageID));

    const cutoffSec = Math.floor(nowMs / 1000) - RETENTION_DAYS * 86400;
    const images = await this.docker.listImages();
    const toDelete: Array<{ tag: string; size: number }> = [];

    for (const img of images) {
      if (usedImageIds.has(img.Id)) continue;
      const tags = img.RepoTags ?? [];
      const fbiTags = tags.filter((t) => t.startsWith('fbi/'));
      if (fbiTags.length === 0) continue;
      if (img.Created > cutoffSec) continue;
      // Only delete if ALL fbi tags on this image are unreachable
      if (fbiTags.every((t) => !reachable.has(t))) {
        for (const t of fbiTags) toDelete.push({ tag: t, size: img.Size ?? 0 });
      }
    }

    const errors: SweepResult['errors'] = [];
    let deletedBytes = 0;
    let deletedCount = 0;
    for (const { tag, size } of toDelete) {
      try {
        await this.docker.getImage(tag).remove({ force: false });
        deletedCount += 1;
        deletedBytes += size;
      } catch (err) {
        errors.push({ tag, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { deletedCount, deletedBytes, errors };
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- src/server/orchestrator/imageGc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/imageGc.ts src/server/orchestrator/imageGc.test.ts
git commit -m "feat(gc): ImageGc with reachability + retention sweep"
```

---

### Task 3.5: Scheduler + API endpoint + orchestrator wiring

**Files:**
- Modify: `src/server/orchestrator/index.ts`
- Modify: `src/server/api/runs.ts` (actually: new settings-adjacent route)
- Modify: `src/server/api/settings.ts`
- Modify: `src/server/index.ts`

We'll add a `POST /api/settings/run-gc` route and an internal scheduler that the orchestrator starts on boot.

- [ ] **Step 1: Add scheduler methods to `Orchestrator`**

In `src/server/orchestrator/index.ts`, add state + methods:

```ts
import { ImageGc } from './imageGc.js';
// …
private gcTimer: NodeJS.Timeout | null = null;
private gc: ImageGc;

// in constructor, after imageBuilder init:
this.gc = new ImageGc(this.deps.docker, () => ({
  always: ALWAYS_FROM_IMAGE_BUILDER,     // import or duplicate — see Step 2
  postbuild: POSTBUILD_FROM_IMAGE_BUILDER,
}));

async startGcScheduler(): Promise<void> {
  const s = this.deps.settings.get();
  if (s.image_gc_enabled) await this.runGcOnce();
  this.scheduleNextGc();
}

private scheduleNextGc(): void {
  if (this.gcTimer) clearTimeout(this.gcTimer);
  this.gcTimer = setTimeout(() => {
    void (async () => {
      const s = this.deps.settings.get();
      if (s.image_gc_enabled) await this.runGcOnce();
      this.scheduleNextGc();
    })();
  }, 24 * 60 * 60 * 1000);
}

async runGcOnce(): Promise<{ deletedCount: number; deletedBytes: number }> {
  const projects = this.deps.projects.list();
  const res = await this.gc.sweep(projects, Date.now());
  this.deps.settings.recordGc({
    at: Date.now(), count: res.deletedCount, bytes: res.deletedBytes,
  });
  return res;
}
```

- [ ] **Step 2: Export `ALWAYS` and `POSTBUILD` from `image.ts`**

In `src/server/orchestrator/image.ts`, change the `const ALWAYS = [...]` to `export const ALWAYS = [...]`, and change the `const POSTBUILD = fs.readFileSync(...)` to `export const POSTBUILD = fs.readFileSync(...)`.

In `src/server/orchestrator/index.ts`, import:

```ts
import { ALWAYS, POSTBUILD } from './image.js';
// use them in the GcConfig getter
```

- [ ] **Step 3: Add `POST /api/settings/run-gc`**

In `src/server/api/settings.ts`, extend `Deps`:

```ts
interface Deps {
  settings: SettingsRepo;
  runGc: () => Promise<{ deletedCount: number; deletedBytes: number }>;
}
```

And add the route:

```ts
app.post('/api/settings/run-gc', async () => {
  const res = await deps.runGc();
  return res;
});
```

- [ ] **Step 4: Wire in `src/server/index.ts`**

Adjust `registerSettingsRoutes` call:

```ts
registerSettingsRoutes(app, {
  settings,
  runGc: () => orchestrator.runGcOnce(),
});

await orchestrator.startGcScheduler();
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/image.ts \
        src/server/api/settings.ts src/server/index.ts
git commit -m "feat(gc): daily scheduler + /api/settings/run-gc"
```

---

### Task 3.6: Settings UI — concurrency + GC controls

**Files:**
- Modify: `src/web/lib/api.ts`
- Modify: `src/web/pages/Settings.tsx`

- [ ] **Step 1: Extend `api.updateSettings` + add `runGc`**

In `src/web/lib/api.ts`:

```ts
updateSettings: (patch: {
  global_prompt?: string;
  notifications_enabled?: boolean;
  concurrency_warn_at?: number;
  image_gc_enabled?: boolean;
}) => request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

runGc: () => request<{ deletedCount: number; deletedBytes: number }>(
  '/api/settings/run-gc', { method: 'POST', body: JSON.stringify({}) }),
```

- [ ] **Step 2: Add UI to `Settings.tsx`**

Add state + controls (partial — adjust to match existing pattern):

```tsx
const [warnAt, setWarnAt] = useState<number>(3);
const [gcEnabled, setGcEnabled] = useState<boolean>(false);
const [lastGc, setLastGc] = useState<{ at: number | null; count: number | null; bytes: number | null }>({ at: null, count: null, bytes: null });
const [runningGc, setRunningGc] = useState(false);

// in the effect that loads settings:
setWarnAt(s.concurrency_warn_at);
setGcEnabled(s.image_gc_enabled);
setLastGc({ at: s.last_gc_at, count: s.last_gc_count, bytes: s.last_gc_bytes });
```

In the form, above the submit button:

```tsx
<label className="block">
  <span className="block text-sm font-medium mb-1">
    Warn when starting a run with this many already in flight (0 = never warn)
  </span>
  <input type="number" min={0} value={warnAt}
    onChange={(e) => setWarnAt(Number(e.target.value))}
    className="w-32 border rounded px-2 py-1 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100" />
</label>

<label className="flex items-center gap-2">
  <input type="checkbox" checked={gcEnabled}
    onChange={(e) => setGcEnabled(e.target.checked)} />
  <span className="text-sm">Enable nightly image GC (keeps images used in the last 30 days)</span>
</label>

<div className="flex items-center gap-3">
  <button type="button" disabled={!gcEnabled || runningGc}
    onClick={async () => {
      setRunningGc(true);
      try {
        const res = await api.runGc();
        setLastGc({ at: Date.now(), count: res.deletedCount, bytes: res.deletedBytes });
      } finally { setRunningGc(false); }
    }}
    className="border rounded px-3 py-1 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200">
    {runningGc ? 'Running…' : 'Run GC now'}
  </button>
  {lastGc.at && (
    <span className="text-xs text-gray-500">
      Last: {new Date(lastGc.at).toLocaleString()} — {lastGc.count ?? 0} images, {Math.round((lastGc.bytes ?? 0) / 1e6)} MB
    </span>
  )}
</div>
```

In the submit handler, include `concurrency_warn_at: warnAt, image_gc_enabled: gcEnabled` in the `updateSettings` payload.

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/web/lib/api.ts src/web/pages/Settings.tsx
git commit -m "feat(ui): Settings concurrency warn + image GC controls"
```

---

### Task 3.7: NewRun — soft concurrency confirm

**Files:**
- Modify: `src/web/pages/NewRun.tsx`

- [ ] **Step 1: Gate the submit**

In the submit handler, after the early prompt-empty return and before `setSubmitting(true)`:

```ts
const warn = settings?.concurrency_warn_at ?? 0;
if (warn > 0) {
  const running = await api.listRuns('running').catch(() => []);
  if (running.length >= warn) {
    if (!window.confirm(`You already have ${running.length} run(s) in flight. Start another?`)) return;
  }
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/web/pages/NewRun.tsx
git commit -m "feat(ui): NewRun soft concurrency cap confirm"
```

---

### Task 3.8: Phase 3 verification

- [ ] **Step 1: Full test suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

Phase 3 complete.

---

## Phase 4 — GitHub surface (status + one-click PR)

### Task 4.1: `parseGitHubRepo` shared helper

**Files:**
- Create: `src/shared/parseGitHubRepo.ts`
- Create: `src/shared/parseGitHubRepo.test.ts`

- [ ] **Step 1: Tests**

```ts
// src/shared/parseGitHubRepo.test.ts
import { describe, it, expect } from 'vitest';
import { parseGitHubRepo } from './parseGitHubRepo.js';

describe('parseGitHubRepo', () => {
  it('parses SSH URL', () => {
    expect(parseGitHubRepo('git@github.com:me/foo.git')).toBe('me/foo');
    expect(parseGitHubRepo('git@github.com:me/foo')).toBe('me/foo');
  });
  it('parses HTTPS URL', () => {
    expect(parseGitHubRepo('https://github.com/me/foo.git')).toBe('me/foo');
    expect(parseGitHubRepo('https://github.com/me/foo')).toBe('me/foo');
  });
  it('returns null for non-github URLs', () => {
    expect(parseGitHubRepo('git@gitlab.com:me/foo.git')).toBeNull();
    expect(parseGitHubRepo('https://bitbucket.org/me/foo')).toBeNull();
    expect(parseGitHubRepo('')).toBeNull();
    expect(parseGitHubRepo('nonsense')).toBeNull();
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// src/shared/parseGitHubRepo.ts
export function parseGitHubRepo(url: string): string | null {
  if (!url) return null;
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- src/shared/parseGitHubRepo.test.ts
git add src/shared/parseGitHubRepo.ts src/shared/parseGitHubRepo.test.ts
git commit -m "feat(shared): parseGitHubRepo helper"
```

---

### Task 4.2: `GhClient` module

**Files:**
- Create: `src/server/github/gh.ts`
- Create: `src/server/github/gh.test.ts`

All methods use `execFile`; no shell-string interpolation.

- [ ] **Step 1: Tests (mock `node:child_process`)**

```ts
// src/server/github/gh.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GhClient } from './gh.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const cp = await import('node:child_process');
const execFile = cp.execFile as unknown as ReturnType<typeof vi.fn>;

function mockOk(stdout: string) {
  execFile.mockImplementationOnce((_bin, _args, _opts, cb) =>
    cb(null, { stdout, stderr: '' }));
}
function mockErr(code: number, stderr: string) {
  execFile.mockImplementationOnce((_bin, _args, _opts, cb) => {
    const err: Error & { code?: number } = new Error(stderr);
    err.code = code;
    cb(err, { stdout: '', stderr });
  });
}

describe('GhClient', () => {
  beforeEach(() => execFile.mockReset());

  it('available returns true when gh --version succeeds', async () => {
    mockOk('gh version 2.40.0');
    const gh = new GhClient();
    expect(await gh.available()).toBe(true);
  });

  it('available returns false when gh not on PATH', async () => {
    mockErr(127, 'gh: command not found');
    const gh = new GhClient();
    expect(await gh.available()).toBe(false);
  });

  it('prForBranch returns null when no PR', async () => {
    mockOk('[]');
    const gh = new GhClient();
    expect(await gh.prForBranch('me/foo', 'bar')).toBeNull();
  });

  it('prForBranch parses PR metadata', async () => {
    mockOk(JSON.stringify([{ number: 7, url: 'https://x', state: 'OPEN', title: 'T' }]));
    const gh = new GhClient();
    const pr = await gh.prForBranch('me/foo', 'bar');
    expect(pr).toEqual({ number: 7, url: 'https://x', state: 'OPEN', title: 'T' });
  });

  it('createPr posts gh pr create and parses url', async () => {
    mockOk('https://github.com/me/foo/pull/9\n');
    mockOk(JSON.stringify([{ number: 9, url: 'https://github.com/me/foo/pull/9', state: 'OPEN', title: 'T' }]));
    const gh = new GhClient();
    const pr = await gh.createPr('me/foo', { head: 'bar', base: 'main', title: 'T', body: 'B' });
    expect(pr.number).toBe(9);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/server/github/gh.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ex = promisify(execFile);

export interface Pr {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
}

export interface Check {
  name: string;
  status: 'pending' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled' | null;
}

export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'removed' | 'renamed';
}

export class GhClient {
  constructor(private bin: string = 'gh') {}

  async available(): Promise<boolean> {
    try {
      await ex(this.bin, ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async prForBranch(repo: string, branch: string): Promise<Pr | null> {
    const { stdout } = await ex(this.bin, [
      'pr', 'list', '--repo', repo, '--head', branch, '--state', 'all',
      '--json', 'number,url,state,title', '--limit', '1',
    ]);
    const arr = JSON.parse(stdout || '[]') as Pr[];
    return arr[0] ?? null;
  }

  async prChecks(repo: string, branch: string): Promise<Check[]> {
    try {
      const { stdout } = await ex(this.bin, [
        'pr', 'checks', branch, '--repo', repo, '--json', 'name,status,conclusion',
      ]);
      return JSON.parse(stdout || '[]') as Check[];
    } catch {
      return [];
    }
  }

  async createPr(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<Pr> {
    await ex(this.bin, [
      'pr', 'create', '--repo', repo,
      '--head', p.head, '--base', p.base,
      '--title', p.title, '--body', p.body,
    ]);
    const pr = await this.prForBranch(repo, p.head);
    if (!pr) throw new Error('created PR but could not re-fetch it');
    return pr;
  }

  async compareFiles(repo: string, base: string, head: string): Promise<FileChange[]> {
    const { stdout } = await ex(this.bin, [
      'api', `repos/${repo}/compare/${base}...${head}`,
      '--jq', '.files | map({filename, additions, deletions, status})',
    ]);
    return JSON.parse(stdout || '[]') as FileChange[];
  }
}

export class GhError extends Error {}
```

- [ ] **Step 3: Run tests + commit**

```bash
npm test -- src/server/github/gh.test.ts
git add src/server/github/gh.ts src/server/github/gh.test.ts
git commit -m "feat(github): GhClient wrapper + prForBranch/createPr/compareFiles"
```

---

### Task 4.3: GitHub API endpoints for runs

**Files:**
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/api/runs.test.ts`

Cache per-run for 10s in-memory.

- [ ] **Step 1: Extend `Deps` in `runs.ts`**

```ts
import type { GhClient, Pr, Check } from '../github/gh.js';
import type { ProjectsRepo } from '../db/projects.js';
import { parseGitHubRepo } from '../../shared/parseGitHubRepo.js';

interface Deps {
  runs: RunsRepo;
  projects: ProjectsRepo;
  gh: GhClient;
  runsDir: string;
  launch: (runId: number) => Promise<void>;
  cancel: (runId: number) => Promise<void>;
}
```

- [ ] **Step 2: Cache helper**

Near the top of `runs.ts`:

```ts
const GH_STATUS_TTL_MS = 10_000;
interface GhStatusCache { value: unknown; expiresAt: number }
const ghStatusCache = new Map<number, GhStatusCache>();
function getCached(runId: number): unknown | null {
  const e = ghStatusCache.get(runId);
  if (!e || Date.now() > e.expiresAt) return null;
  return e.value;
}
function setCached(runId: number, value: unknown): void {
  ghStatusCache.set(runId, { value, expiresAt: Date.now() + GH_STATUS_TTL_MS });
}
function invalidate(runId: number): void { ghStatusCache.delete(runId); }
```

- [ ] **Step 3: `GET /api/runs/:id/github`**

```ts
app.get('/api/runs/:id/github', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });

  const cached = getCached(runId);
  if (cached) return cached;

  const project = deps.projects.get(run.project_id);
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const available = await deps.gh.available();
  if (!available || !repo || !run.branch_name) {
    const payload = { pr: null, checks: null, github_available: available && !!repo };
    setCached(runId, payload);
    return payload;
  }

  const pr = await deps.gh.prForBranch(repo, run.branch_name).catch(() => null);
  const checks = await deps.gh.prChecks(repo, run.branch_name).catch(() => [] as Check[]);
  const passed = checks.filter((c) => c.conclusion === 'success').length;
  const failed = checks.filter((c) => c.conclusion === 'failure').length;
  const total = checks.length;
  const state = total === 0 ? null :
    (failed > 0 ? 'failure' :
     checks.every((c) => c.status === 'completed') ? 'success' : 'pending');

  const payload = {
    pr: pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null,
    checks: total === 0 ? null : { state, passed, failed, total },
    github_available: true,
  };
  setCached(runId, payload);
  return payload;
});
```

- [ ] **Step 4: `POST /api/runs/:id/github/pr`**

```ts
app.post('/api/runs/:id/github/pr', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });
  if (run.state !== 'succeeded' || !run.branch_name) {
    return reply.code(400).send({ error: 'run not eligible for PR' });
  }
  const project = deps.projects.get(run.project_id);
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  if (!project || !repo) return reply.code(400).send({ error: 'not a github project' });
  if (!(await deps.gh.available())) return reply.code(503).send({ error: 'gh-not-available' });
  const existing = await deps.gh.prForBranch(repo, run.branch_name).catch(() => null);
  if (existing) return reply.code(409).send({ error: 'PR already exists', pr: existing });

  const title = (run.prompt.split('\n')[0] ?? 'FBI run').slice(0, 72);
  const body = `${run.prompt}\n\n---\n🤖 Generated with FBI run #${runId}`;
  const pr = await deps.gh.createPr(repo, {
    head: run.branch_name, base: project.default_branch, title, body,
  });
  invalidate(runId);
  return pr;
});
```

- [ ] **Step 5: Wire `gh` and `projects` from `src/server/index.ts`**

```ts
import { GhClient } from './github/gh.js';
// …
const gh = new GhClient();
registerRunsRoutes(app, {
  runs, projects, gh,
  runsDir: config.runsDir,
  launch: (id) => orchestrator.launch(id),
  cancel: (id) => orchestrator.cancel(id),
});
```

- [ ] **Step 6: Update `makeApp()` in `runs.test.ts` to pass a stub `gh` + projects**

At the top of `runs.test.ts`, add a stub:

```ts
const stubGh = {
  available: async () => true,
  prForBranch: async () => null,
  prChecks: async () => [],
  createPr: async () => ({ number: 1, url: 'u', state: 'OPEN' as const, title: 't' }),
  compareFiles: async () => [],
};
```

And update `makeApp()` to pass `gh: stubGh` and `projects` into `registerRunsRoutes`. Update all existing tests as needed — most should keep passing unchanged.

- [ ] **Step 7: Tests + commit**

```bash
npm test -- src/server/api/runs.test.ts
git add src/server/api/runs.ts src/server/api/runs.test.ts src/server/index.ts
git commit -m "feat(api): /api/runs/:id/github + POST /github/pr with 10s cache"
```

---

### Task 4.4: RunDetail GitHub status card + PR client

**Files:**
- Modify: `src/web/lib/api.ts`
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Client methods**

In `src/web/lib/api.ts`:

```ts
getRunGithub: (id: number) => request<{
  pr: null | { number: number; url: string; state: 'OPEN'|'CLOSED'|'MERGED'; title: string };
  checks: null | { state: 'pending'|'success'|'failure'; passed: number; failed: number; total: number };
  github_available: boolean;
}>(`/api/runs/${id}/github`),

createRunPr: (id: number) => request<{ number: number; url: string; state: string; title: string }>(
  `/api/runs/${id}/github/pr`, { method: 'POST', body: JSON.stringify({}) }),
```

- [ ] **Step 2: Render the card in `RunDetail.tsx`**

```tsx
const [gh, setGh] = useState<Awaited<ReturnType<typeof api.getRunGithub>> | null>(null);
const [creatingPr, setCreatingPr] = useState(false);

useEffect(() => {
  if (!run || run.state !== 'succeeded') return;
  let alive = true;
  const load = async () => {
    try {
      const g = await api.getRunGithub(run.id);
      if (alive) setGh(g);
    } catch { /* ignore */ }
  };
  void load();
  const t = setInterval(load, 30_000);
  return () => { alive = false; clearInterval(t); };
}, [run?.id, run?.state]);
```

Under the terminal, render:

```tsx
{run.state === 'succeeded' && gh && (
  <div className="border rounded p-3 space-y-2 dark:border-gray-600">
    <h3 className="text-sm font-medium">GitHub status</h3>
    {!gh.github_available ? (
      <p className="text-xs text-gray-500">GitHub CLI not available or non-GitHub remote.</p>
    ) : (
      <>
        {gh.pr ? (
          <a href={gh.pr.url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-300 text-sm">
            PR #{gh.pr.number} — {gh.pr.title} [{gh.pr.state}]
          </a>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">No PR yet.</span>
            <button disabled={creatingPr}
              onClick={async () => {
                setCreatingPr(true);
                try { await api.createRunPr(run.id); const g = await api.getRunGithub(run.id); setGh(g); }
                catch (err) { alert(String(err)); }
                finally { setCreatingPr(false); }
              }}
              className="border rounded px-2 py-1 text-sm dark:border-gray-600 dark:text-gray-200">
              {creatingPr ? 'Creating…' : 'Create PR'}
            </button>
          </div>
        )}
        {gh.checks ? (
          <p className="text-xs">
            CI: <span className={
              gh.checks.state === 'success' ? 'text-green-600' :
              gh.checks.state === 'failure' ? 'text-red-600' : 'text-gray-500'
            }>{gh.checks.state}</span> ({gh.checks.passed}/{gh.checks.total} passed, {gh.checks.failed} failed)
          </p>
        ) : null}
      </>
    )}
  </div>
)}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/web/lib/api.ts src/web/pages/RunDetail.tsx
git commit -m "feat(ui): RunDetail GitHub status card + Create PR"
```

---

### Task 4.5: Phase 4 verification

- [ ] **Step 1: Tests + typecheck**

Run: `npm test && npm run typecheck`

Phase 4 complete.

---

## Phase 5 — File-level diff summary

### Task 5.1: `GET /api/runs/:id/diff`

**Files:**
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/api/runs.test.ts`

- [ ] **Step 1: Cache helper (60s)**

Add near the existing GH cache:

```ts
const DIFF_TTL_MS = 60_000;
const diffCache = new Map<number, { value: unknown; expiresAt: number }>();
function getDiffCached(runId: number): unknown | null {
  const e = diffCache.get(runId);
  if (!e || Date.now() > e.expiresAt) return null;
  return e.value;
}
function setDiffCached(runId: number, value: unknown): void {
  diffCache.set(runId, { value, expiresAt: Date.now() + DIFF_TTL_MS });
}
```

- [ ] **Step 2: Route**

```ts
app.get('/api/runs/:id/diff', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });

  const cached = getDiffCached(runId);
  if (cached) return cached;

  const project = deps.projects.get(run.project_id);
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const available = await deps.gh.available();
  if (!project || !repo || !run.branch_name || !available) {
    const payload = {
      base: project?.default_branch ?? '',
      head: run.branch_name,
      files: [],
      github_available: available && !!repo,
    };
    setDiffCached(runId, payload);
    return payload;
  }

  const files = await deps.gh
    .compareFiles(repo, project.default_branch, run.branch_name)
    .catch(() => []);
  const payload = {
    base: project.default_branch,
    head: run.branch_name,
    files,
    github_available: true,
  };
  setDiffCached(runId, payload);
  return payload;
});
```

- [ ] **Step 3: Commit**

```bash
git add src/server/api/runs.ts
git commit -m "feat(api): /api/runs/:id/diff with 60s cache"
```

---

### Task 5.2: RunDetail Files changed section

**Files:**
- Modify: `src/web/lib/api.ts`
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Client method**

```ts
getRunDiff: (id: number) => request<{
  base: string; head: string;
  files: Array<{ filename: string; additions: number; deletions: number; status: string }>;
  github_available: boolean;
}>(`/api/runs/${id}/diff`),
```

- [ ] **Step 2: Render**

In `RunDetail.tsx`, below the GitHub card:

```tsx
const [diff, setDiff] = useState<Awaited<ReturnType<typeof api.getRunDiff>> | null>(null);
useEffect(() => {
  if (!run || run.state !== 'succeeded') return;
  void api.getRunDiff(run.id).then(setDiff).catch(() => {});
}, [run?.id, run?.state]);

{run.state === 'succeeded' && diff && diff.github_available && (
  <details className="border rounded dark:border-gray-600">
    <summary className="cursor-pointer px-3 py-2 text-sm select-none">
      Files changed ({diff.files.length})
    </summary>
    {diff.files.length === 0 ? (
      <p className="px-3 py-2 text-xs text-gray-500">No files changed.</p>
    ) : (
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-gray-500"><th className="text-left px-2">Status</th><th className="text-left px-2">File</th><th className="text-right px-2">+</th><th className="text-right px-2">−</th></tr>
        </thead>
        <tbody>
          {diff.files.map((f) => {
            const repo = (() => {
              try { return new URL(gh?.pr?.url ?? '').pathname.split('/').slice(1, 3).join('/'); } catch { return null; }
            })();
            const href = repo ? `https://github.com/${repo}/blob/${diff.head}/${f.filename}` : '#';
            return (
              <tr key={f.filename}>
                <td className="px-2">{f.status[0].toUpperCase()}</td>
                <td className="px-2"><a href={href} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-300">{f.filename}</a></td>
                <td className="px-2 text-right text-green-600">{f.additions}</td>
                <td className="px-2 text-right text-red-600">{f.deletions}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    )}
  </details>
)}
```

Note: the `repo` derivation from `gh?.pr?.url` is a workaround for not plumbing the repo string to the client. If the PR doesn't exist yet we can't link the files to GitHub; fall back to `#` (or just not render as `<a>`). Acceptable for v1; a dedicated `repo` field on the diff response would be cleaner — file as follow-up.

- [ ] **Step 3: Commit**

```bash
git add src/web/lib/api.ts src/web/pages/RunDetail.tsx
git commit -m "feat(ui): RunDetail files-changed section"
```

Phase 5 complete.

---

## Phase 6 — Related runs

### Task 6.1: `RunsRepo.listSiblings`

**Files:**
- Modify: `src/server/db/runs.ts`
- Modify: `src/server/db/runs.test.ts`

- [ ] **Step 1: Test**

```ts
it('listSiblings returns other runs with the same prompt in the same project', () => {
  const a = runs.create({ project_id: projectId, prompt: 'X',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  const b = runs.create({ project_id: projectId, prompt: 'X',
    log_path_tmpl: (id) => `/tmp/${id}.log` });
  runs.create({ project_id: projectId, prompt: 'different',
    log_path_tmpl: (id) => `/tmp/${id}.log` });

  const siblings = runs.listSiblings(a.id, 10);
  expect(siblings.map((r) => r.id)).toEqual([b.id]);
});
```

- [ ] **Step 2: Implement**

```ts
listSiblings(runId: number, limit = 10): Run[] {
  const self = this.get(runId);
  if (!self) return [];
  return this.db
    .prepare(
      `SELECT * FROM runs
        WHERE project_id = ? AND prompt = ? AND id != ?
        ORDER BY id DESC LIMIT ?`
    )
    .all(self.project_id, self.prompt, self.id, limit) as Run[];
}
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- src/server/db/runs.test.ts
git add src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(db): RunsRepo.listSiblings"
```

---

### Task 6.2: `GET /api/runs/:id/siblings`

**Files:**
- Modify: `src/server/api/runs.ts`

- [ ] **Step 1: Route**

```ts
app.get('/api/runs/:id/siblings', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });
  return deps.runs.listSiblings(runId, 10);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/server/api/runs.ts
git commit -m "feat(api): /api/runs/:id/siblings"
```

---

### Task 6.3: RunDetail Related runs section

**Files:**
- Modify: `src/web/lib/api.ts`
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Client**

```ts
getRunSiblings: (id: number) => request<Run[]>(`/api/runs/${id}/siblings`),
```

- [ ] **Step 2: Render**

```tsx
const [siblings, setSiblings] = useState<Run[]>([]);
useEffect(() => {
  if (!run) return;
  void api.getRunSiblings(run.id).then(setSiblings).catch(() => setSiblings([]));
}, [run?.id]);

{siblings.length > 0 && (
  <details className="border rounded dark:border-gray-600">
    <summary className="cursor-pointer px-3 py-2 text-sm select-none">
      Related runs ({siblings.length})
    </summary>
    <ul className="px-3 py-2 divide-y text-sm dark:divide-gray-700">
      {siblings.map((s) => {
        const repo = project ? parseGitHubRepo(project.repo_url) : null;
        const compareUrl = repo && s.branch_name && run!.branch_name
          ? `https://github.com/${repo}/compare/${run!.branch_name}...${s.branch_name}`
          : null;
        return (
          <li key={s.id} className="py-1 flex items-center gap-2">
            <Link to={`/runs/${s.id}`} className="text-blue-600 dark:text-blue-300">Run #{s.id}</Link>
            <StateBadge state={s.state} />
            <span className="text-gray-500">{s.branch_name}</span>
            {compareUrl && (
              <a href={compareUrl} target="_blank" rel="noreferrer"
                 className="ml-auto border rounded px-2 py-0.5 text-xs dark:border-gray-600">
                Diff vs this
              </a>
            )}
          </li>
        );
      })}
    </ul>
  </details>
)}
```

Add these imports at the top of `RunDetail.tsx` if not present:

```tsx
import { Link } from 'react-router-dom';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';
import type { Project } from '@shared/types.js';
```

And fetch `project` on mount so the compare URL can be built:

```tsx
const [project, setProject] = useState<Project | null>(null);
useEffect(() => {
  if (!run) return;
  void api.getProject(run.project_id).then(setProject).catch(() => {});
}, [run?.project_id]);
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/web/lib/api.ts src/web/pages/RunDetail.tsx
git commit -m "feat(ui): RunDetail Related runs + compare URL"
```

---

### Task 6.4: Phase 6 verification

- [ ] **Step 1: Full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

Phase 6 complete.

---

## Closing

- [ ] **Step 1: Update the backlog doc**

Edit `docs/feature-gaps.md`:
- Flip status tags for categories A, B, C, D, E, F from `todo`/mixed to `shipped (P2)` / `todo (P3)`.
- Check all 11 P2 boxes: the six category-level items plus sub-bullets.
- Append to the changelog:

```
- YYYY-MM-DD — P2 pack shipped; scale & visibility, pre-run transparency, safety caps + image GC, GitHub status + PR creation, file-level diff, related runs.
```

- [ ] **Step 2: Final commit**

```bash
git add docs/feature-gaps.md
git commit -m "docs: mark P2 pack shipped"
```

---

## Self-review notes (retained for context)

- Every spec section maps to tasks:
  - Phase 1 (spec §2): Tasks 1.1–1.6
  - Phase 2 (spec §3): Tasks 2.1–2.5
  - Phase 3 (spec §4): Tasks 3.1–3.8
  - Phase 4 (spec §5): Tasks 4.1–4.5
  - Phase 5 (spec §6): Tasks 5.1–5.2
  - Phase 6 (spec §7): Tasks 6.1–6.4
  - §8 cross-cutting: addressed inline (schema migrations in Task 3.1; `gh` execFile discipline in Task 4.2; caching in Tasks 4.3/5.1; graceful degradation in Tasks 4.3/5.1; testing strategy matches per-phase).
  - §9 phase order: mirrored by plan phases.
- Type consistency spot-checks:
  - `RunsRepo.listFiltered` return `{ items, total }` matches API shape in Task 1.2 and client `listRunsPaged` in Task 1.4.
  - `Project.last_run` matches across Tasks 1.3 (repo), shared type, and UI consumption in Task 1.5.
  - `Settings` fields defined in Task 3.2 match the columns added in Task 3.1 and the `recordGc` exposure in Task 3.4.
  - `GhClient` method signatures defined in Task 4.2 match the call sites in Tasks 4.3 and 5.1.
  - `FileChange` shape matches the UI table in Task 5.2.
- No "TBD"/"similar to"/"see above" — every code step is concrete. Verification commands state expected outcomes.
