# Claude-named Run Sessions Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude name each run's session — early (via sidecar file mid-run) and refined at end-of-run (via result JSON) — with user-editable rename that sticks via a lock flag.

**Architecture:** Add `title` / `title_locked` columns on `runs`. Orchestrator bind-mounts a per-run state dir to `/fbi-state/` in the container; supervisor preamble tells Claude to write the session name to `/fbi-state/session-name`. A host-side `TitleWatcher` (mirroring `UsageTailer`) polls that file and persists changes via `RunsRepo.updateTitle`, respecting the lock. End-of-run path also parses a new `title` field from `/tmp/result.json`. A `PATCH /api/runs/:id` endpoint lets the UI rename and set the lock. Typed WS frames push updates live. UI changes: RunRow label fallback, RunsList filter, RunHeader inline rename.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, React, Vitest, Docker.

**Spec:** [`docs/superpowers/specs/2026-04-22-claude-session-naming-design.md`](../specs/2026-04-22-claude-session-naming-design.md)

---

## Task 1: DB columns + `RunsRepo.updateTitle`

**Files:** `src/server/db/index.ts`, `src/server/db/runs.ts`, `src/server/db/runs.test.ts`

- [ ] **Step 1: Failing tests** — add a `describe('updateTitle')` block in `runs.test.ts` (use the file's existing `makeRepos()` helper). Five tests:

```typescript
describe('updateTitle', () => {
  it('sets title when row is unlocked (respectLock=true)', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, '  Fix auth race  ', { respectLock: true });
    const after = runs.get(run.id)!;
    expect((after as any).title).toBe('Fix auth race');
    expect((after as any).title_locked).toBe(0);
  });
  it('is a no-op when locked and respectLock=true', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, 'Original', { lock: true, respectLock: false });
    runs.updateTitle(run.id, 'Should not overwrite', { respectLock: true });
    expect((runs.get(run.id) as any).title).toBe('Original');
    expect((runs.get(run.id) as any).title_locked).toBe(1);
  });
  it('overwrites when respectLock=false and sets lock when lock=true', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, 'First', { respectLock: true });
    runs.updateTitle(run.id, 'User pick', { lock: true, respectLock: false });
    expect((runs.get(run.id) as any).title).toBe('User pick');
    expect((runs.get(run.id) as any).title_locked).toBe(1);
  });
  it('truncates titles longer than 80 chars', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, 'x'.repeat(200), { respectLock: true });
    expect((runs.get(run.id) as any).title).toHaveLength(80);
  });
  it('ignores empty-after-trim input', () => {
    const { runs, run } = setup();
    runs.updateTitle(run.id, '   ', { respectLock: true });
    expect((runs.get(run.id) as any).title).toBeNull();
  });
});
```

Substitute the file's actual setup helper name (it's `makeRepos()` in the existing file). Use `as any` on `get()` results since Task 2 adds the TS fields.

- [ ] **Step 2: Verify tests fail.** `npm test -- --run src/server/db/runs.test.ts`.

- [ ] **Step 3: Add migrations** in `src/server/db/index.ts` inside `migrate()`, inside the `runCols` block (after the token-columns loop, before the settings INSERT):

```typescript
  if (!runCols.has('title')) {
    db.exec('ALTER TABLE runs ADD COLUMN title TEXT');
  }
  if (!runCols.has('title_locked')) {
    db.exec('ALTER TABLE runs ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0');
  }
```

Do NOT modify `schema.sql`.

- [ ] **Step 4: Add `updateTitle`** to `RunsRepo` near `setClaudeSessionId`:

```typescript
  updateTitle(
    id: number,
    title: string,
    opts: { lock?: boolean; respectLock: boolean },
  ): void {
    const trimmed = title.trim().slice(0, 80);
    if (trimmed.length === 0) return;
    if (opts.respectLock) {
      this.db
        .prepare(`UPDATE runs SET title = ? WHERE id = ? AND title_locked = 0`)
        .run(trimmed, id);
    } else {
      const lockVal = opts.lock ? 1 : 0;
      this.db
        .prepare('UPDATE runs SET title = ?, title_locked = ? WHERE id = ?')
        .run(trimmed, lockVal, id);
    }
  }
```

- [ ] **Step 5: Tests pass.** `npm test -- --run src/server/db/runs.test.ts`.

- [ ] **Step 6: Commit.**

```bash
git add src/server/db/index.ts src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(db): title + title_locked columns and updateTitle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Shared types

**Files:** `src/shared/types.ts`

- [ ] **Step 1:** In `export interface Run`, after `usage_parse_errors`, add:

```typescript
  title: string | null;
  title_locked: 0 | 1;
```

- [ ] **Step 2:** At bottom of the file, after `RunWsRateLimitMessage`, add:

```typescript
export type RunWsTitleMessage = {
  type: 'title';
  title: string | null;
  title_locked: 0 | 1;
};
```

- [ ] **Step 3: Typecheck.** `npm run typecheck` — expected clean (Task 1 used `as any` in tests).

- [ ] **Step 4: Commit.**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): Run.title / title_locked + RunWsTitleMessage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Result JSON `title` field

**Files:** `src/server/orchestrator/result.ts`, `src/server/orchestrator/result.test.ts`

- [ ] **Step 1: Failing tests** — add to the existing `describe('parseResultJson')` block:

```typescript
  it('extracts a title when present', () => {
    const r = parseResultJson(JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'abc', title: 'Fix auth race' }));
    expect(r?.title).toBe('Fix auth race');
  });
  it('trims and truncates title to 80 chars', () => {
    const r = parseResultJson(JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'abc', title: '   ' + 'x'.repeat(200) + '   ' }));
    expect(r?.title).toHaveLength(80);
  });
  it('omits title when empty or whitespace', () => {
    const r = parseResultJson(JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'abc', title: '  ' }));
    expect(r?.title).toBeUndefined();
  });
  it('parses successfully when title is absent', () => {
    const r = parseResultJson(JSON.stringify({ exit_code: 0, push_exit: 0, head_sha: 'abc' }));
    expect(r).not.toBeNull();
    expect(r?.title).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail.**

- [ ] **Step 3: Implement.** Replace `src/server/orchestrator/result.ts` with:

```typescript
export interface ContainerResult {
  exit_code: number;
  push_exit: number;
  head_sha: string;
  branch?: string;
  title?: string;
}

export function parseResultJson(text: string): ContainerResult | null {
  try {
    const obj = JSON.parse(text.trim());
    if (
      typeof obj.exit_code === 'number' &&
      typeof obj.push_exit === 'number' &&
      typeof obj.head_sha === 'string'
    ) {
      const result: ContainerResult = {
        exit_code: obj.exit_code,
        push_exit: obj.push_exit,
        head_sha: obj.head_sha,
      };
      if (typeof obj.branch === 'string' && obj.branch.length > 0) {
        result.branch = obj.branch;
      }
      if (typeof obj.title === 'string') {
        const t = obj.title.trim().slice(0, 80);
        if (t.length > 0) result.title = t;
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Tests pass.**

- [ ] **Step 5: Commit.**

```bash
git add src/server/orchestrator/result.ts src/server/orchestrator/result.test.ts
git commit -m "feat(orchestrator): parseResultJson extracts optional title

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `TitleWatcher` module

**Files:** create `src/server/orchestrator/titleWatcher.ts` and `.test.ts`

- [ ] **Step 1: Failing tests** — create `titleWatcher.test.ts` with 7 tests. Use `fs.mkdtempSync` for isolated dirs; poll `30ms` with `sleep(100–120)` windows.

```typescript
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TitleWatcher } from './titleWatcher.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-titlew-')); }
async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

describe('TitleWatcher', () => {
  it('does not fire before the file appears', async () => {
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: path.join(tmp(), 'session-name'), pollMs: 30, onTitle, onError: () => {} });
    w.start(); await sleep(100); await w.stop();
    expect(onTitle).not.toHaveBeenCalled();
  });
  it('fires once with trimmed+truncated value when the file appears', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, '   Fix auth race   ');
    await sleep(120); await w.stop();
    expect(onTitle).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledWith('Fix auth race');
  });
  it('de-duplicates identical values', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'Alpha'); await sleep(100);
    fs.writeFileSync(p, 'Alpha'); await sleep(100); await w.stop();
    expect(onTitle).toHaveBeenCalledTimes(1);
  });
  it('fires again when the value changes', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'Alpha'); await sleep(100);
    fs.writeFileSync(p, 'Beta'); await sleep(100); await w.stop();
    expect(onTitle.mock.calls.map((c) => c[0])).toEqual(['Alpha', 'Beta']);
  });
  it('truncates to 80 chars', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, 'x'.repeat(200)); await sleep(100); await w.stop();
    expect(onTitle.mock.calls[0][0]).toHaveLength(80);
  });
  it('skips empty-after-trim content', async () => {
    const p = path.join(tmp(), 'session-name');
    const onTitle = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError: () => {} });
    w.start();
    fs.writeFileSync(p, '   \n  '); await sleep(100);
    fs.writeFileSync(p, 'Real name'); await sleep(100); await w.stop();
    expect(onTitle).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledWith('Real name');
  });
  it('forwards non-ENOENT read errors to onError', async () => {
    const p = path.join(tmp(), 'session-name');
    fs.mkdirSync(p);  // make it a directory → EISDIR
    const onTitle = vi.fn();
    const onError = vi.fn();
    const w = new TitleWatcher({ path: p, pollMs: 30, onTitle, onError });
    w.start(); await sleep(100); await w.stop();
    expect(onTitle).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2:** Run tests to verify they fail.

- [ ] **Step 3: Implement** `src/server/orchestrator/titleWatcher.ts`:

```typescript
import fs from 'node:fs';

export interface TitleWatcherOptions {
  path: string;
  pollMs?: number;
  onTitle: (title: string) => void;
  onError: (reason: string) => void;
}

export class TitleWatcher {
  private opts: Required<Omit<TitleWatcherOptions, 'onTitle' | 'onError'>> & TitleWatcherOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastEmitted: string | null = null;

  constructor(opts: TitleWatcherOptions) {
    this.opts = { pollMs: 1000, ...opts };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      try { this.readOnce(); } catch (e) { this.opts.onError(String(e)); }
      this.timer = setTimeout(tick, this.opts.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.readOnce(); } catch (e) { this.opts.onError(String(e)); }
  }

  private readOnce(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.opts.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;  // forwarded to onError by tick-level catch
    }
    const trimmed = raw.trim().slice(0, 80);
    if (trimmed.length === 0) return;
    if (trimmed === this.lastEmitted) return;
    this.lastEmitted = trimmed;
    this.opts.onTitle(trimmed);
  }
}
```

- [ ] **Step 4:** Tests pass (7/7).

- [ ] **Step 5: Commit.**

```bash
git add src/server/orchestrator/titleWatcher.ts src/server/orchestrator/titleWatcher.test.ts
git commit -m "feat(orchestrator): TitleWatcher polling sidecar file

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Orchestrator wiring

**Files:** `src/server/orchestrator/sessionId.ts`, `sessionId.test.ts`, `src/server/logs/registry.ts`, `src/server/orchestrator/index.ts`

The orchestrator has multiple live-container code paths today: `launch`, `resume`, `reattach`, and (per the recent continue-run feature) possibly `continueRun`. Every path that creates a `UsageTailer` is a candidate for a `TitleWatcher` alongside it. Verify which paths instantiate `UsageTailer` by grepping first, and mirror the pattern in each.

- [ ] **Step 1: Add helper + test.** In `sessionId.ts` add:

```typescript
export function runStateDir(runsDir: string, runId: number): string {
  return path.join(runsDir, String(runId), 'state');
}
```

And in `sessionId.test.ts`:

```typescript
describe('runStateDir', () => {
  it('returns {runsDir}/{id}/state', () => {
    expect(runStateDir('/var/lib/fbi/runs', 7)).toBe('/var/lib/fbi/runs/7/state');
  });
});
```

- [ ] **Step 2: Extend `RunEvent` union.** In `src/server/logs/registry.ts`:

```typescript
import type { RunWsUsageMessage, RunWsRateLimitMessage, RunWsTitleMessage } from '../../shared/types.js';
export type RunEvent = RunWsUsageMessage | RunWsRateLimitMessage | RunWsTitleMessage;
```

- [ ] **Step 3: Orchestrator helpers + helper method.** In `src/server/orchestrator/index.ts`:

Imports:
```typescript
import { scanSessionId, runMountDir, runStateDir } from './sessionId.js';
import { TitleWatcher } from './titleWatcher.js';
```

Near `mountDirFor` / `ensureMountDir`, add:
```typescript
  private stateDirFor(runId: number): string {
    return runStateDir(this.deps.config.runsDir, runId);
  }
  private ensureStateDir(runId: number): string {
    const dir = this.stateDirFor(runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
    return dir;
  }
```

Near `publishState`, add the helper that folds the 5 repeated call sites into one:
```typescript
  private publishTitleUpdate(runId: number, title: string): void {
    this.deps.runs.updateTitle(runId, title, { respectLock: true });
    const after = this.deps.runs.get(runId);
    this.deps.streams.getOrCreateEvents(runId).publish({
      type: 'title',
      title: after?.title ?? null,
      title_locked: (after?.title_locked ?? 0) as 0 | 1,
    });
  }
```

- [ ] **Step 4: Bind mount.** In `createContainerForRun`'s `Binds:` array, after the existing claude-projects bind, add:

```typescript
          `${this.ensureStateDir(runId)}:/fbi-state/`,
```

- [ ] **Step 5: Preamble.** In every place the fresh-start preamble is constructed (search for `You are working in /workspace on`), append these lines before the trailing blank line:

```typescript
      '',
      'As soon as you understand the task, write a short name (4–8 words,',
      'imperative, no trailing punctuation) describing this session to',
      '`/fbi-state/session-name`. You may overwrite it later if your',
      'understanding changes. Also include a refined `title` field in the',
      'final result JSON.',
```

- [ ] **Step 6: TitleWatcher in each live-container path.** For each path that instantiates a `UsageTailer`, add an adjacent `TitleWatcher`. Find them with:

```bash
grep -n "new UsageTailer\|await tailer.stop" src/server/orchestrator/index.ts
```

For each site, declare `let titleWatcher: TitleWatcher | null = null;` in the same scope as `tailer`, then after `tailer.start()`:

```typescript
      titleWatcher = new TitleWatcher({
        path: `${this.stateDirFor(runId)}/session-name`,
        pollMs: 1000,
        onTitle: (t) => this.publishTitleUpdate(runId, t),
        onError: () => { /* swallow — best effort */ },
      });
      titleWatcher.start();
```

And in the same `finally`:
```typescript
      if (titleWatcher) await titleWatcher.stop();
```

If a path uses a `const tailer = new UsageTailer(...)` shape (no nullable), mirror with `const titleWatcher = new TitleWatcher(...)`. Stay close to the sibling's shape.

- [ ] **Step 7: Finish-path title updates.** For every place `parseResultJson` is called followed by `markFinished`, add AFTER the `markFinished` call:

```typescript
    if (parsed?.title) {
      this.publishTitleUpdate(runId, parsed.title);
    }
```

Do NOT add this block to error-path `markFinished` calls that have no `parsed` in scope.

- [ ] **Step 8: Typecheck + test suite.** `npm run typecheck && npm test -- --run`. Expected: clean typecheck, no regressions.

- [ ] **Step 9: Commit.**

```bash
git add src/server/orchestrator/sessionId.ts src/server/orchestrator/sessionId.test.ts \
       src/server/orchestrator/index.ts src/server/logs/registry.ts
git commit -m "feat(orchestrator): bind-mount state dir, wire TitleWatcher, preamble + finish-path title updates

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `PATCH /api/runs/:id`

**Files:** `src/server/api/runs.ts`, `src/server/api/runs.test.ts`

- [ ] **Step 1: Failing tests.** In `runs.test.ts`, add a nested `describe('PATCH /api/runs/:id')` with 4 tests. Use the file's existing helper (`makeApp()` or equivalent) + create a run manually:

```typescript
describe('PATCH /api/runs/:id', () => {
  function setupWithRun() {
    const { app, projects, runs } = makeApp();
    const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null, git_author_name: null, git_author_email: null });
    const run = runs.create({ project_id: p.id, prompt: 'hi',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    return { app, runs, run };
  }
  it('updates title and sets the lock', async () => {
    const { app, runs, run } = setupWithRun();
    const res = await app.inject({ method: 'PATCH', url: `/api/runs/${run.id}`, payload: { title: '  New name  ' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe('New name');
    expect(body.title_locked).toBe(1);
  });
  it('returns 404 for unknown run', async () => {
    const { app } = setupWithRun();
    const res = await app.inject({ method: 'PATCH', url: '/api/runs/99999', payload: { title: 'x' } });
    expect(res.statusCode).toBe(404);
  });
  it('rejects empty title after trim', async () => {
    const { app, run } = setupWithRun();
    const res = await app.inject({ method: 'PATCH', url: `/api/runs/${run.id}`, payload: { title: '   ' } });
    expect(res.statusCode).toBe(400);
  });
  it('rejects titles longer than 120 chars', async () => {
    const { app, run } = setupWithRun();
    const res = await app.inject({ method: 'PATCH', url: `/api/runs/${run.id}`, payload: { title: 'x'.repeat(121) } });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2:** Run tests → fail.

- [ ] **Step 3: Implement** in `src/server/api/runs.ts` after the DELETE handler:

```typescript
  app.patch('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { title?: unknown };
    const raw = typeof body?.title === 'string' ? body.title : '';
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 120) {
      return reply.code(400).send({ error: 'invalid title' });
    }
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'not found' });
    deps.runs.updateTitle(runId, trimmed, { lock: true, respectLock: false });
    return deps.runs.get(runId)!;
  });
```

- [ ] **Step 4:** Tests pass.

- [ ] **Step 5: Commit.**

```bash
git add src/server/api/runs.ts src/server/api/runs.test.ts
git commit -m "feat(api): PATCH /api/runs/:id renames and locks title

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Client `api.renameRun`

**Files:** `src/web/lib/api.ts`

- [ ] **Step 1:** Add a method on the `api` object after `deleteRun`:

```typescript
  renameRun: (id: number, title: string) =>
    request<Run>(`/api/runs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
```

- [ ] **Step 2: Typecheck clean.**

- [ ] **Step 3: Commit.**

```bash
git add src/web/lib/api.ts
git commit -m "feat(web): api.renameRun client

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: RunRow label + RunsList filter

**Files:** `src/web/features/runs/RunRow.tsx`, `RunsList.tsx`, new `RunRow.test.tsx`

- [ ] **Step 1: Failing test** at `src/web/features/runs/RunRow.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RunRow } from './RunRow.js';
import type { Run } from '@shared/types.js';

function mkRun(over: Partial<Run>): Run {
  return {
    id: 1, project_id: 1, prompt: 'do the thing', branch_name: 'branch-x',
    state: 'running', container_id: null, log_path: '/tmp/x', exit_code: null,
    error: null, head_commit: null, started_at: null, finished_at: null,
    created_at: Date.now(), resume_attempts: 0, next_resume_at: null,
    claude_session_id: null, last_limit_reset_at: null,
    tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0,
    tokens_total: 0, usage_parse_errors: 0,
    title: null, title_locked: 0,
    ...over,
  };
}

describe('RunRow label fallback', () => {
  it('prefers title when present', () => {
    render(<MemoryRouter><RunRow run={mkRun({ title: 'Refactor auth middleware' })} to="/runs/1" /></MemoryRouter>);
    expect(screen.getByText('Refactor auth middleware')).toBeInTheDocument();
  });
  it('falls back to branch when title is null', () => {
    render(<MemoryRouter><RunRow run={mkRun({ title: null, branch_name: 'feat/x' })} to="/runs/1" /></MemoryRouter>);
    expect(screen.getByText('feat/x')).toBeInTheDocument();
  });
  it('falls back to first line of prompt when title and branch are empty', () => {
    render(<MemoryRouter><RunRow run={mkRun({ title: null, branch_name: '', prompt: 'first line\nsecond' })} to="/runs/1" /></MemoryRouter>);
    expect(screen.getByText('first line')).toBeInTheDocument();
  });
});
```

The Run shape above matches the current `Run` interface post-Task 2. If any field is missing or renamed when you reach this task, update the mock to match.

- [ ] **Step 2: Update `RunRow.tsx`** line ~27:

Before: `const label = run.branch_name || run.prompt.split('\n')[0] || 'untitled';`
After:  `const label = run.title || run.branch_name || run.prompt.split('\n')[0] || 'untitled';`

- [ ] **Step 3: Update `RunsList.tsx`** filter (the `runs.filter((r) => ...)` body inside `useMemo`). Add `title` to the substring-match chain:

```typescript
      String(r.id).includes(q) ||
      (r.title ?? '').toLowerCase().includes(q) ||
      (r.branch_name ?? '').toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q),
```

- [ ] **Step 4: Tests pass.**

- [ ] **Step 5: Commit.**

```bash
git add src/web/features/runs/RunRow.tsx src/web/features/runs/RunsList.tsx src/web/features/runs/RunRow.test.tsx
git commit -m "feat(web): RunRow label + RunsList filter prefer title

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: RunHeader inline rename

**Files:** `src/web/features/runs/RunHeader.tsx`

The current `RunHeader.tsx` has a Continue button (added recently). Preserve its props (`run`, `onCancel`, `onDelete`, `onContinue`) and button layout. Add rename support.

- [ ] **Step 1: Replace the component** with the version below. It:
  - Adds an optional `onRenamed?: (run: Run) => void` prop.
  - Renders `Run #{id} — {display}` where the display text is an inline-editable button.
  - Double-click OR single-click enters edit mode (keyboard-accessible).
  - Enter saves, Escape cancels, onBlur commits UNLESS focus moves to a sibling button in the same header (uses `relatedTarget`).
  - Keeps the editor open on API failure.
  - Fires `onRenamed` with the full returned `Run`.

```typescript
import { useState } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Pill, Menu, Input, type PillTone } from '@ui/primitives/index.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import type { Run } from '@shared/types.js';
import { api } from '../../lib/api.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', running: 'run', awaiting_resume: 'warn',
  succeeded: 'ok', failed: 'fail', cancelled: 'warn',
};

export interface RunHeaderProps {
  run: Run;
  onCancel: () => void;
  onDelete: () => void;
  onContinue: () => void;
  onRenamed?: (run: Run) => void;
}

export function RunHeader({ run, onCancel, onDelete, onContinue, onRenamed }: RunHeaderProps) {
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const display = run.title || run.branch_name || run.prompt.split('\n')[0] || 'untitled';
  const canFollowUp =
    run.state !== 'running' && run.state !== 'queued' && run.state !== 'awaiting_resume' && !!run.branch_name;
  const canContinue = run.state === 'failed' || run.state === 'cancelled' || run.state === 'succeeded';
  const continueDisabled = !run.claude_session_id;

  function startEdit() {
    setDraft(run.title ?? '');
    setEditing(true);
  }

  async function commit() {
    const t = draft.trim();
    if (t.length === 0 || t.length > 120) { setEditing(false); return; }
    try {
      const updated = await api.renameRun(run.id, t);
      onRenamed?.(updated);
      setEditing(false);
    } catch {
      // Leave the editor open so the user sees their unsaved draft.
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
  }

  function onBlur(e: React.FocusEvent<HTMLInputElement>) {
    const nextFocus = e.relatedTarget as HTMLElement | null;
    if (nextFocus && e.currentTarget.closest('header')?.contains(nextFocus)) {
      setEditing(false);
      return;
    }
    void commit();
  }

  return (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-border-strong bg-surface">
      <h1 className="text-[16px] font-semibold flex items-center gap-2 min-w-0">
        <span className="shrink-0">Run #{run.id}</span>
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={onBlur}
            onKeyDown={onKey}
            aria-label="Rename session"
            className="h-7 text-[16px] font-sans"
          />
        ) : (
          <button
            type="button"
            onClick={startEdit}
            onDoubleClick={startEdit}
            aria-label={`Rename run: ${display}`}
            title="Click to rename"
            className="truncate text-left font-semibold hover:underline decoration-dotted"
          >
            — {display}
          </button>
        )}
      </h1>
      <Pill tone={TONE[run.state]}>{run.state}</Pill>
      {run.branch_name && (
        <CodeBlock>{run.branch_name}{run.head_commit ? `@${run.head_commit.slice(0, 8)}` : ''}</CodeBlock>
      )}
      <div className="ml-auto flex gap-1.5">
        {canContinue && (
          <Button
            variant="primary" size="sm" onClick={onContinue} disabled={continueDisabled}
            title={continueDisabled ? 'No session captured — start a new run instead' : undefined}
          >
            Continue
          </Button>
        )}
        {canFollowUp && (
          <Button variant="ghost" size="sm"
            onClick={() => nav(`/projects/${run.project_id}/runs/new?branch=${encodeURIComponent(run.branch_name!)}`)}>
            Follow up
          </Button>
        )}
        {(run.state === 'running' || run.state === 'awaiting_resume') && (
          <Button variant="danger" size="sm" onClick={onCancel}>Cancel</Button>
        )}
        <Menu
          trigger={<Button variant="ghost" size="sm">More ▾</Button>}
          items={[
            { id: 'delete', label: 'Delete run', danger: true, onSelect: onDelete,
              disabled: run.state === 'running' || run.state === 'awaiting_resume' },
          ]}
        />
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Typecheck + test suite** pass.

- [ ] **Step 3: Commit.**

```bash
git add src/web/features/runs/RunHeader.tsx
git commit -m "feat(web): inline rename in RunHeader

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Live WS title frame consumption

**Files:** wherever the web side consumes typed run events (likely `src/web/lib/ws.ts` and/or `src/web/features/runs/usageBus.ts` on the current tree)

- [ ] **Step 1: Find the existing typed-event consumer.** Grep:

```bash
grep -rn "type: 'usage'\|type: 'rate_limit'\|RunWsUsageMessage" src/web | head -20
```

- [ ] **Step 2: Add a `title` handler** mirroring the existing `usage` / `rate_limit` dispatch. The minimum-viable behavior is to re-fetch the run via `api.getRun(id)` on a `title` frame (and patch the relevant react-query or local state). If the existing bus already supports partial-run patches, use that instead.

The frame shape is:
```typescript
{ type: 'title'; title: string | null; title_locked: 0 | 1 }
```

- [ ] **Step 3: Manual E2E smoke test.** With `scripts/dev.sh` running, start a run, then:

```bash
echo "Test Session Name" > <runsDir>/<runId>/state/session-name
```

Expected: within ~1 second, the list row and RunHeader show "Test Session Name" without a refresh.

- [ ] **Step 4: Commit.**

```bash
git add <whichever files you touched>
git commit -m "feat(web): apply live title updates from WS frames

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Docker-gated integration test

**Files:** `src/server/orchestrator/title.integration.test.ts`

- [ ] **Step 1:** Model on `usage.integration.test.ts`. Two tests:

```typescript
import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { TitleWatcher } from './titleWatcher.js';

async function dockerAvailable(): Promise<boolean> {
  try { await new Docker().ping(); return true; } catch { return false; }
}

describe('title integration (Docker-gated)', () => {
  it('captures a session-name written from a container', async () => {
    if (!(await dockerAvailable())) return;
    const docker = new Docker();
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-title-int-'));
    const stateDir = path.join(hostDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o777 });

    const db = openDb(path.join(hostDir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
    const run = runs.create({ project_id: p.id, prompt: 'hi',
      log_path_tmpl: (id) => path.join(hostDir, `${id}.log`) });

    const watcher = new TitleWatcher({
      path: path.join(stateDir, 'session-name'), pollMs: 100,
      onTitle: (t) => runs.updateTitle(run.id, t, { respectLock: true }),
      onError: () => {},
    });
    watcher.start();

    const container = await docker.createContainer({
      Image: 'alpine:3',
      Cmd: ['sh', '-c', `printf 'Fix auth race' > /fbi-state/session-name`],
      HostConfig: { AutoRemove: false, Binds: [`${stateDir}:/fbi-state/`] },
    });
    await container.start();
    await container.wait();
    await container.remove({ force: true, v: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();

    expect((runs.get(run.id) as any).title).toBe('Fix auth race');
    expect((runs.get(run.id) as any).title_locked).toBe(0);
  }, 30_000);

  it('user-locked title is not overwritten', async () => {
    if (!(await dockerAvailable())) return;
    const docker = new Docker();
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-title-int-lock-'));
    const stateDir = path.join(hostDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o777 });

    const db = openDb(path.join(hostDir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
    const run = runs.create({ project_id: p.id, prompt: 'hi',
      log_path_tmpl: (id) => path.join(hostDir, `${id}.log`) });
    runs.updateTitle(run.id, 'User pick', { lock: true, respectLock: false });

    const watcher = new TitleWatcher({
      path: path.join(stateDir, 'session-name'), pollMs: 100,
      onTitle: (t) => runs.updateTitle(run.id, t, { respectLock: true }),
      onError: () => {},
    });
    watcher.start();

    const container = await docker.createContainer({
      Image: 'alpine:3',
      Cmd: ['sh', '-c', `printf 'Claude draft' > /fbi-state/session-name`],
      HostConfig: { AutoRemove: false, Binds: [`${stateDir}:/fbi-state/`] },
    });
    await container.start();
    await container.wait();
    await container.remove({ force: true, v: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();

    expect((runs.get(run.id) as any).title).toBe('User pick');
    expect((runs.get(run.id) as any).title_locked).toBe(1);
  }, 30_000);
});
```

- [ ] **Step 2: Run it.** Pass if Docker available, skip if not.

- [ ] **Step 3: Final typecheck + test suite.**

- [ ] **Step 4: Commit.**

```bash
git add src/server/orchestrator/title.integration.test.ts
git commit -m "test(orchestrator): Docker-gated title capture + lock integration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
