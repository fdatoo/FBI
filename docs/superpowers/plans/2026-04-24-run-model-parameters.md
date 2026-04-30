# Run Model Parameters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-run `model`, `effort`, `subagent_model` controls to the New Run and Continue Run flows. Values persist on the run record, are injected into the container as env vars, and the New Run form remembers last-used values via browser localStorage.

**Architecture:** Three new nullable columns on `runs`. A small pure validator (`validateModelParams`) shared by the create-run and continue-run HTTP handlers. The orchestrator's `createContainerForRun` conditionally appends three env entries. A new `ModelParamsCollapse` React component wraps the three selects behind one click; it's reused on the New Run page (pre-filled from localStorage) and inside a new Continue Run dialog (pre-filled from the original run record). Continue mutates the existing run row in place — consistent with how `markContinuing` already works today.

**Tech Stack:** TypeScript · Vitest · Fastify · better-sqlite3 · React · @testing-library/react · Tailwind.

**Branch:** Work on `design/model-parameters-new-run` (already checked out with the design spec committed).

**Test command:** `npm test` (all vitest) / `npm run typecheck` (all three tsconfigs). Use filtered invocations like `npm test -- src/server/db/runs.test.ts` while iterating.

---

## File Map

**Server — new / modified:**
- `src/server/db/schema.sql` — add 3 columns to `runs` (new rows only; `migrate()` adds to existing DBs).
- `src/server/db/index.ts` — extend `migrate()` with three column-existence checks.
- `src/server/db/runs.ts` — extend `CreateRunInput`, update `create()`, add `updateModelParams()`.
- `src/server/db/runs.test.ts` — cover round-trip + update.
- `src/shared/types.ts` — add 3 optional fields to `Run`.
- `src/server/api/modelParams.ts` — **new.** Pure `validateModelParams` function + its types.
- `src/server/api/modelParams.test.ts` — **new.** Table-driven validator tests.
- `src/server/api/runs.ts` — accept 3 optional body fields on create + continue; call validator; persist/update.
- `src/server/api/runs.test.ts` — extend create + continue tests.
- `src/server/orchestrator/modelParamEnv.ts` — **new.** Pure helper that turns a `Run` into the three env-var entries.
- `src/server/orchestrator/modelParamEnv.test.ts` — **new.**
- `src/server/orchestrator/index.ts` — in `createContainerForRun`, spread the helper's result into `Env`.

**Web — new / modified:**
- `src/web/lib/api.ts` — extend `createRun` + `continueRun`.
- `src/web/components/ModelParamsCollapse.tsx` — **new.**
- `src/web/components/ModelParamsCollapse.test.tsx` — **new.**
- `src/web/pages/NewRun.tsx` — wire in `ModelParamsCollapse` + localStorage round-trip.
- `src/web/pages/NewRun.test.tsx` — if it exists, extend; otherwise leave manual smoke only.
- `src/web/components/ContinueRunDialog.tsx` — **new.**
- `src/web/pages/RunDetail.tsx` — open the dialog instead of calling continue directly.

---

## Task 1: DB — columns, migration, Run type

**Files:**
- Modify: `src/server/db/schema.sql` (end of `CREATE TABLE runs`, ~line 43)
- Modify: `src/server/db/index.ts:117` (end of `migrate()`'s runs-column block, after the `parent_run_id` migration)
- Modify: `src/shared/types.ts` (the `Run` interface, ~lines 29-58)
- Test: `src/server/db/runs.test.ts` (add tests near the existing `create` tests)

- [ ] **Step 1: Write the failing DB round-trip test**

Append to `src/server/db/runs.test.ts` (inside the existing `describe('RunsRepo', …)`):

```typescript
  it('round-trips model, effort, subagent_model on create', () => {
    const run = runs.create({
      project_id: projectId,
      prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
      model: 'opus',
      effort: 'xhigh',
      subagent_model: 'haiku',
    });
    const got = runs.get(run.id)!;
    expect(got.model).toBe('opus');
    expect(got.effort).toBe('xhigh');
    expect(got.subagent_model).toBe('haiku');
  });

  it('stores nulls when model params are omitted', () => {
    const run = runs.create({
      project_id: projectId,
      prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    const got = runs.get(run.id)!;
    expect(got.model).toBeNull();
    expect(got.effort).toBeNull();
    expect(got.subagent_model).toBeNull();
  });

  it('updateModelParams overwrites the three columns', () => {
    const run = runs.create({
      project_id: projectId,
      prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
      model: 'sonnet',
      effort: 'high',
      subagent_model: null,
    });
    runs.updateModelParams(run.id, {
      model: 'opus',
      effort: 'max',
      subagent_model: 'sonnet',
    });
    const got = runs.get(run.id)!;
    expect(got.model).toBe('opus');
    expect(got.effort).toBe('max');
    expect(got.subagent_model).toBe('sonnet');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/server/db/runs.test.ts`

Expected: all three new tests fail (TypeScript errors: `model` not in `CreateRunInput`, `updateModelParams` doesn't exist; at runtime: unknown column).

- [ ] **Step 3: Add the schema columns**

In `src/server/db/schema.sql`, locate the `CREATE TABLE IF NOT EXISTS runs (...)` block (lines 28–43). Add three new columns *before* the closing paren, after `state_entered_at`:

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
  state_entered_at INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  effort TEXT,
  subagent_model TEXT
);
```

- [ ] **Step 4: Add migration entries**

In `src/server/db/index.ts`, inside `migrate()`, just before the `// --- TokenEater usage migration ---` comment (around line 122), append:

```typescript
  if (!runCols.has('model')) {
    db.exec('ALTER TABLE runs ADD COLUMN model TEXT');
  }
  if (!runCols.has('effort')) {
    db.exec('ALTER TABLE runs ADD COLUMN effort TEXT');
  }
  if (!runCols.has('subagent_model')) {
    db.exec('ALTER TABLE runs ADD COLUMN subagent_model TEXT');
  }
```

- [ ] **Step 5: Extend the Run type**

In `src/shared/types.ts`, inside the `Run` interface (around lines 29-58), add three fields (place them at the end of the interface):

```typescript
  model: string | null;
  effort: string | null;
  subagent_model: string | null;
```

- [ ] **Step 6: Extend CreateRunInput and RunsRepo**

In `src/server/db/runs.ts`:

- Update `CreateRunInput` (lines 4–9):

```typescript
export interface CreateRunInput {
  project_id: number;
  prompt: string;
  branch_hint?: string;
  log_path_tmpl: (id: number) => string;
  model?: string | null;
  effort?: string | null;
  subagent_model?: string | null;
}
```

- Update `create()` (lines 30–47) to include the three columns in the INSERT:

```typescript
  create(input: CreateRunInput): Run {
    return this.db.transaction(() => {
      const now = Date.now();
      const branchHint = input.branch_hint ?? '';
      const stub = this.db
        .prepare(
          `INSERT INTO runs
             (project_id, prompt, branch_name, state, log_path,
              created_at, state_entered_at,
              model, effort, subagent_model)
           VALUES (?, ?, ?, 'queued', '', ?, ?, ?, ?, ?)`
        )
        .run(
          input.project_id,
          input.prompt,
          branchHint,
          now,
          now,
          input.model ?? null,
          input.effort ?? null,
          input.subagent_model ?? null,
        );
      const id = Number(stub.lastInsertRowid);
      const logPath = input.log_path_tmpl(id);
      this.db
        .prepare('UPDATE runs SET log_path = ? WHERE id = ?')
        .run(logPath, id);
      return this.get(id)!;
    })();
  }
```

- Add an `updateModelParams` method. Place it directly after `create()`:

```typescript
  updateModelParams(
    id: number,
    p: { model: string | null; effort: string | null; subagent_model: string | null },
  ): void {
    this.db
      .prepare('UPDATE runs SET model = ?, effort = ?, subagent_model = ? WHERE id = ?')
      .run(p.model, p.effort, p.subagent_model, id);
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- src/server/db/runs.test.ts`

Expected: all tests PASS (including existing ones — no regressions).

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`

Expected: clean (no errors).

- [ ] **Step 9: Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts src/server/db/runs.ts src/server/db/runs.test.ts src/shared/types.ts
git commit -m "feat(runs): add model/effort/subagent_model columns"
```

---

## Task 2: Validation function

**Files:**
- Create: `src/server/api/modelParams.ts`
- Test:   `src/server/api/modelParams.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/api/modelParams.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateModelParams } from './modelParams.js';

describe('validateModelParams', () => {
  it('accepts all fields absent', () => {
    expect(validateModelParams({}).ok).toBe(true);
  });

  it.each([
    { model: 'sonnet' as const },
    { model: 'opus' as const },
    { model: 'haiku' as const },
    { effort: 'low' as const },
    { effort: 'medium' as const },
    { effort: 'high' as const },
    { effort: 'max' as const },
    { subagent_model: 'sonnet' as const },
    { model: 'opus' as const, effort: 'xhigh' as const, subagent_model: 'haiku' as const },
    { model: 'sonnet' as const, effort: 'max' as const },
    { effort: 'high' as const },
  ])('accepts valid combination %o', (input) => {
    const r = validateModelParams(input);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown model', () => {
    const r = validateModelParams({ model: 'turbo' as unknown as 'sonnet' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/model/);
  });

  it('rejects unknown effort', () => {
    const r = validateModelParams({ effort: 'enormous' as unknown as 'max' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown subagent_model', () => {
    const r = validateModelParams({ subagent_model: 'mini' as unknown as 'haiku' });
    expect(r.ok).toBe(false);
  });

  it('rejects effort + haiku', () => {
    const r = validateModelParams({ model: 'haiku', effort: 'high' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/haiku/i);
  });

  it('rejects xhigh + sonnet', () => {
    const r = validateModelParams({ model: 'sonnet', effort: 'xhigh' as 'max' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/xhigh/i);
  });

  it('rejects xhigh + haiku (haiku rule wins first)', () => {
    const r = validateModelParams({ model: 'haiku', effort: 'xhigh' as 'max' });
    expect(r.ok).toBe(false);
  });

  it('accepts xhigh + opus', () => {
    const r = validateModelParams({ model: 'opus', effort: 'xhigh' });
    expect(r.ok).toBe(true);
  });

  it('accepts effort without model (model absent)', () => {
    // Server-side is permissive; UI prevents odd combos, server ignores unset model.
    const r = validateModelParams({ effort: 'high' });
    expect(r.ok).toBe(true);
  });

  it('treats null values identically to undefined', () => {
    expect(validateModelParams({ model: null, effort: null, subagent_model: null }).ok).toBe(true);
    expect(validateModelParams({ model: 'opus', effort: null, subagent_model: null }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/server/api/modelParams.test.ts`

Expected: FAIL — file `./modelParams.js` not found.

- [ ] **Step 3: Implement the validator**

Create `src/server/api/modelParams.ts`:

```typescript
export type ModelAlias = 'sonnet' | 'opus' | 'haiku';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelParams {
  model?: ModelAlias;
  effort?: EffortLevel;
  subagent_model?: ModelAlias;
}

const MODELS: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku']);
const EFFORTS: ReadonlySet<string> = new Set([
  'low', 'medium', 'high', 'xhigh', 'max',
]);

export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

export function validateModelParams(p: {
  model?: string | null;
  effort?: string | null;
  subagent_model?: string | null;
}): ValidationResult {
  // Treat null and undefined identically as "not provided". This matches how
  // the client may serialize an unset value (either dropped or explicit null).
  const model = p.model ?? undefined;
  const effort = p.effort ?? undefined;
  const subagent = p.subagent_model ?? undefined;

  if (model !== undefined && !MODELS.has(model)) {
    return { ok: false, message: `invalid model: ${model}` };
  }
  if (effort !== undefined && !EFFORTS.has(effort)) {
    return { ok: false, message: `invalid effort: ${effort}` };
  }
  if (subagent !== undefined && !MODELS.has(subagent)) {
    return { ok: false, message: `invalid subagent_model: ${subagent}` };
  }
  if (effort !== undefined && model === 'haiku') {
    return { ok: false, message: 'effort is not supported on haiku' };
  }
  if (effort === 'xhigh' && model !== undefined && model !== 'opus') {
    return { ok: false, message: 'xhigh effort is only supported on opus' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/server/api/modelParams.test.ts`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/modelParams.ts src/server/api/modelParams.test.ts
git commit -m "feat(runs): add model/effort validator"
```

---

## Task 3: Orchestrator env-var helper

**Files:**
- Create: `src/server/orchestrator/modelParamEnv.ts`
- Test:   `src/server/orchestrator/modelParamEnv.test.ts`

This is a pure function so we can unit-test it without touching Docker.

- [ ] **Step 1: Write the failing test**

Create `src/server/orchestrator/modelParamEnv.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { modelParamEnvEntries } from './modelParamEnv.js';

describe('modelParamEnvEntries', () => {
  it('returns empty array when all three fields are null', () => {
    expect(
      modelParamEnvEntries({ model: null, effort: null, subagent_model: null })
    ).toEqual([]);
  });

  it('emits ANTHROPIC_MODEL when model is set', () => {
    expect(
      modelParamEnvEntries({ model: 'opus', effort: null, subagent_model: null })
    ).toEqual(['ANTHROPIC_MODEL=opus']);
  });

  it('emits CLAUDE_CODE_EFFORT_LEVEL when effort is set', () => {
    expect(
      modelParamEnvEntries({ model: null, effort: 'xhigh', subagent_model: null })
    ).toEqual(['CLAUDE_CODE_EFFORT_LEVEL=xhigh']);
  });

  it('emits CLAUDE_CODE_SUBAGENT_MODEL when subagent_model is set', () => {
    expect(
      modelParamEnvEntries({ model: null, effort: null, subagent_model: 'sonnet' })
    ).toEqual(['CLAUDE_CODE_SUBAGENT_MODEL=sonnet']);
  });

  it('emits all three when all three are set', () => {
    expect(
      modelParamEnvEntries({
        model: 'opus', effort: 'high', subagent_model: 'haiku',
      })
    ).toEqual([
      'ANTHROPIC_MODEL=opus',
      'CLAUDE_CODE_EFFORT_LEVEL=high',
      'CLAUDE_CODE_SUBAGENT_MODEL=haiku',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/server/orchestrator/modelParamEnv.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/server/orchestrator/modelParamEnv.ts`:

```typescript
export interface ModelParamFields {
  model: string | null;
  effort: string | null;
  subagent_model: string | null;
}

export function modelParamEnvEntries(run: ModelParamFields): string[] {
  const entries: string[] = [];
  if (run.model) entries.push(`ANTHROPIC_MODEL=${run.model}`);
  if (run.effort) entries.push(`CLAUDE_CODE_EFFORT_LEVEL=${run.effort}`);
  if (run.subagent_model) entries.push(`CLAUDE_CODE_SUBAGENT_MODEL=${run.subagent_model}`);
  return entries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/server/orchestrator/modelParamEnv.test.ts`

Expected: all PASS.

- [ ] **Step 5: Wire the helper into createContainerForRun**

In `src/server/orchestrator/index.ts`:

- Near the other orchestrator-local imports at the top of the file, add:

```typescript
import { modelParamEnvEntries } from './modelParamEnv.js';
```

- Inside `createContainerForRun` (after line 228, after the `projectSecrets` spread, still inside the `Env:` array), append the helper's result:

```typescript
        ...Object.entries(projectSecrets).map(([k, v]) => `${k}=${v}`),
        ...modelParamEnvEntries(run),
      ],
```

The `run` variable is already in scope (bound at line 181: `const run = this.deps.runs.get(runId)!;`).

- [ ] **Step 6: Run typecheck + full suite**

Run: `npm run typecheck && npm test`

Expected: clean and green.

- [ ] **Step 7: Commit**

```bash
git add src/server/orchestrator/modelParamEnv.ts src/server/orchestrator/modelParamEnv.test.ts src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): inject model/effort env vars"
```

---

## Task 4: API — create-run accepts model params

**Files:**
- Modify: `src/server/api/runs.ts` (create-run handler, ~lines 117–152)
- Modify: `src/server/api/runs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/server/api/runs.test.ts` (after an existing create-run test — search for `POST /api/projects/:id/runs` and add nearby):

```typescript
describe('POST /api/projects/:id/runs — model params', () => {
  it('persists model, effort, subagent_model when provided', async () => {
    const { app, projectId, runs } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runs`,
      payload: {
        prompt: 'do thing',
        model: 'opus',
        effort: 'xhigh',
        subagent_model: 'sonnet',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: number };
    const row = runs.get(body.id)!;
    expect(row.model).toBe('opus');
    expect(row.effort).toBe('xhigh');
    expect(row.subagent_model).toBe('sonnet');
  });

  it('stores NULLs when model params are omitted', async () => {
    const { app, projectId, runs } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runs`,
      payload: { prompt: 'do thing' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: number };
    const row = runs.get(body.id)!;
    expect(row.model).toBeNull();
    expect(row.effort).toBeNull();
    expect(row.subagent_model).toBeNull();
  });

  it('returns 400 on invalid model', async () => {
    const { app, projectId } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runs`,
      payload: { prompt: 'x', model: 'turbo' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on effort + haiku', async () => {
    const { app, projectId } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runs`,
      payload: { prompt: 'x', model: 'haiku', effort: 'high' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on xhigh + sonnet', async () => {
    const { app, projectId } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runs`,
      payload: { prompt: 'x', model: 'sonnet', effort: 'xhigh' },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/server/api/runs.test.ts`

Expected: all five new tests FAIL (fields dropped / 400s not produced).

- [ ] **Step 3: Update the create-run handler**

In `src/server/api/runs.ts`, locate the create-run handler (around line 117) and:

- At the top of the file, add:

```typescript
import { validateModelParams } from './modelParams.js';
```

- Replace the handler body. Before the change, the handler reads roughly:

```typescript
  app.post('/api/projects/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { prompt: string; branch?: string; draft_token?: string };
    const hint = (body.branch ?? '').trim();
    const token = typeof body.draft_token === 'string' ? body.draft_token : '';
    if (token.length > 0 && !isDraftToken(token)) {
      return reply.code(400).send({ error: 'invalid_token' });
    }
    const run = deps.runs.create({
      project_id: Number(id),
      prompt: body.prompt,
      branch_hint: hint === '' ? undefined : hint,
      log_path_tmpl: (rid) => path.join(deps.runsDir, `${rid}.log`),
    });
    // ... rest unchanged (draft file moves, launch, return run)
  });
```

Change the body type and call-site:

```typescript
  app.post('/api/projects/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      prompt: string;
      branch?: string;
      draft_token?: string;
      model?: string | null;
      effort?: string | null;
      subagent_model?: string | null;
    };
    const hint = (body.branch ?? '').trim();
    const token = typeof body.draft_token === 'string' ? body.draft_token : '';
    if (token.length > 0 && !isDraftToken(token)) {
      return reply.code(400).send({ error: 'invalid_token' });
    }
    const verdict = validateModelParams({
      model: body.model,
      effort: body.effort,
      subagent_model: body.subagent_model,
    });
    if (!verdict.ok) {
      return reply.code(400).send({ error: verdict.message });
    }
    const run = deps.runs.create({
      project_id: Number(id),
      prompt: body.prompt,
      branch_hint: hint === '' ? undefined : hint,
      log_path_tmpl: (rid) => path.join(deps.runsDir, `${rid}.log`),
      model: body.model ?? null,
      effort: body.effort ?? null,
      subagent_model: body.subagent_model ?? null,
    });
    // ... rest unchanged
  });
```

Leave the rest of the handler (draft file handling, `launch`, return value) untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/server/api/runs.test.ts`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/runs.ts src/server/api/runs.test.ts
git commit -m "feat(api): accept model/effort/subagent_model on run creation"
```

---

## Task 5: API — continue-run accepts model params

**Files:**
- Modify: `src/server/api/runs.ts` (continue-run handler, ~lines 197–213)
- Modify: `src/server/api/runs.test.ts`

Continue mutates the existing run row (consistent with `markContinuing` which reuses the row). Params in the request override what's on disk.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/api/runs.test.ts`:

```typescript
describe('POST /api/runs/:id/continue — model params', () => {
  function makeContinuableRun(runs: RunsRepo, projectId: number, seed?: {
    model?: string | null; effort?: string | null; subagent_model?: string | null;
  }) {
    const run = runs.create({
      project_id: projectId,
      prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
      model: seed?.model ?? null,
      effort: seed?.effort ?? null,
      subagent_model: seed?.subagent_model ?? null,
    });
    // Simulate a finished run so checkContinueEligibility passes.
    // If test harness helpers don't expose this, use markStarted then markFinished.
    runs.markStarted(run.id, 'c1');
    runs.markFinished(run.id, { state: 'failed', exit_code: 1 });
    return run;
  }

  it('updates the run row with new params before firing continue', async () => {
    const { app, projectId, runs } = setup();
    const run = makeContinuableRun(runs, projectId, {
      model: 'sonnet', effort: 'high', subagent_model: null,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/continue`,
      payload: { model: 'opus', effort: 'xhigh', subagent_model: 'haiku' },
    });
    expect(res.statusCode).toBe(204);
    const after = runs.get(run.id)!;
    expect(after.model).toBe('opus');
    expect(after.effort).toBe('xhigh');
    expect(after.subagent_model).toBe('haiku');
  });

  it('explicit null clears a previously-set param', async () => {
    const { app, projectId, runs } = setup();
    const run = makeContinuableRun(runs, projectId, {
      model: 'sonnet', effort: 'high', subagent_model: null,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/continue`,
      payload: { model: null, effort: null, subagent_model: null },
    });
    expect(res.statusCode).toBe(204);
    const after = runs.get(run.id)!;
    expect(after.model).toBeNull();
    expect(after.effort).toBeNull();
    expect(after.subagent_model).toBeNull();
  });

  it('empty body clears all params (UI always sends full state; empty body is an edge case)', async () => {
    const { app, projectId, runs } = setup();
    const run = makeContinuableRun(runs, projectId, {
      model: 'sonnet', effort: 'high', subagent_model: null,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/continue`,
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    const after = runs.get(run.id)!;
    expect(after.model).toBeNull();
    expect(after.effort).toBeNull();
    expect(after.subagent_model).toBeNull();
  });

  it('returns 400 on invalid combination (haiku + effort)', async () => {
    const { app, projectId, runs } = setup();
    const run = makeContinuableRun(runs, projectId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/continue`,
      payload: { model: 'haiku', effort: 'high' },
    });
    expect(res.statusCode).toBe(400);
    const after = runs.get(run.id)!;
    expect(after.model).toBeNull();
  });
});
```

*Note: if `checkContinueEligibility` requires the log file to exist, create an empty file at `run.log_path` before posting. Inspect `src/server/orchestrator/continueEligibility.ts` and adjust the helper accordingly if the test returns 409 instead of 204.*

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/server/api/runs.test.ts`

Expected: the three new tests FAIL.

- [ ] **Step 3: Update the continue handler**

In `src/server/api/runs.ts`, replace the `/api/runs/:id/continue` handler (lines 197–213) with:

```typescript
  app.post('/api/runs/:id/continue', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      model?: string | null;
      effort?: string | null;
      subagent_model?: string | null;
    };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    const verdict = checkContinueEligibility(run, deps.runsDir);
    if (!verdict.ok) {
      return reply.code(409).send({ code: verdict.code, message: verdict.message });
    }
    const valid = validateModelParams({
      model: body.model,
      effort: body.effort,
      subagent_model: body.subagent_model,
    });
    if (!valid.ok) {
      return reply.code(400).send({ error: valid.message });
    }
    // Continue is "the dialog is source of truth": always overwrite. The UI
    // pre-fills the dialog from the current run so unchanged fields round-trip.
    deps.runs.updateModelParams(run.id, {
      model: body.model ?? null,
      effort: body.effort ?? null,
      subagent_model: body.subagent_model ?? null,
    });
    void deps.continueRun(run.id).catch((err) => {
      app.log.error({ err }, 'continueRun failed');
    });
    return reply.code(204).send();
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/server/api/runs.test.ts`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/runs.ts src/server/api/runs.test.ts
git commit -m "feat(api): accept model/effort/subagent_model on continue"
```

---

## Task 6: Web API client

**Files:**
- Modify: `src/web/lib/api.ts` (lines ~116–132)

Pure code change — UI tests in later tasks will cover end-to-end.

- [ ] **Step 1: Update `createRun` and `continueRun`**

Replace the existing `createRun` and `continueRun` entries in the exported `api` object:

```typescript
  createRun: (
    projectId: number,
    prompt: string,
    branch?: string,
    draftToken?: string,
    modelParams?: {
      model: string | null;
      effort: string | null;
      subagent_model: string | null;
    },
  ) =>
    request<Run>(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        branch: branch && branch.trim() !== '' ? branch.trim() : undefined,
        draft_token: draftToken ?? undefined,
        // Spread so null values serialize as null (server treats null === unset).
        ...(modelParams ?? {}),
      }),
    }),

  continueRun: (
    id: number,
    modelParams?: {
      model: string | null;
      effort: string | null;
      subagent_model: string | null;
    },
  ) =>
    request<void>(`/api/runs/${id}/continue`, {
      method: 'POST',
      body: JSON.stringify(modelParams ?? {}),
    }),
```

Note: passing `undefined` in a serialized JSON omits the field entirely (`JSON.stringify` drops undefined values), which matches the server's "undefined means don't overwrite" semantics on continue.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: clean. If anything else imports `api.createRun` or `api.continueRun` positionally, the extra optional trailing argument is a non-breaking change.

- [ ] **Step 3: Commit**

```bash
git add src/web/lib/api.ts
git commit -m "feat(web): extend createRun/continueRun with model params"
```

---

## Task 7: `ModelParamsCollapse` component

**Files:**
- Create: `src/web/components/ModelParamsCollapse.tsx`
- Create: `src/web/components/ModelParamsCollapse.test.tsx`

First-time component — keep it self-contained. Confirm primitive import paths by opening `src/web/ui/primitives/index.ts` and `src/web/ui/patterns/FormRow.tsx` once before writing; use whichever paths those files export. If `Select` / `FormRow` don't exist with the expected shape, substitute native `<select>` + a simple labeled `<div>`.

- [ ] **Step 1: Write the failing tests**

Create `src/web/components/ModelParamsCollapse.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelParamsCollapse } from './ModelParamsCollapse.js';

describe('ModelParamsCollapse', () => {
  const nullParams = { model: null, effort: null, subagent_model: null };

  it('renders a summary line with "default" / "inherit" when all values are null', () => {
    render(<ModelParamsCollapse value={nullParams} onChange={() => {}} />);
    const summary = screen.getByTestId('modelparams-summary');
    expect(summary.textContent).toMatch(/default/);
    expect(summary.textContent).toMatch(/inherit/);
  });

  it('renders concrete values in the summary when set', () => {
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: 'xhigh', subagent_model: 'sonnet' }}
        onChange={() => {}}
      />,
    );
    const summary = screen.getByTestId('modelparams-summary');
    expect(summary.textContent).toMatch(/opus/);
    expect(summary.textContent).toMatch(/xhigh/);
    expect(summary.textContent).toMatch(/sonnet/);
  });

  it('is collapsed by default; clicking the header expands the controls', () => {
    render(<ModelParamsCollapse value={nullParams} onChange={() => {}} />);
    expect(screen.queryByTestId('modelparams-model-select')).toBeNull();
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    expect(screen.getByTestId('modelparams-model-select')).toBeInTheDocument();
  });

  it('effort options match the selected model — opus includes xhigh', () => {
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: null, subagent_model: null }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    const effort = screen.getByTestId('modelparams-effort-select') as HTMLSelectElement;
    const values = Array.from(effort.options).map((o) => o.value);
    expect(values).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('effort options exclude xhigh when model is sonnet', () => {
    render(
      <ModelParamsCollapse
        value={{ model: 'sonnet', effort: null, subagent_model: null }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    const effort = screen.getByTestId('modelparams-effort-select') as HTMLSelectElement;
    const values = Array.from(effort.options).map((o) => o.value);
    expect(values).toEqual(['', 'low', 'medium', 'high', 'max']);
  });

  it('disables effort when model = haiku', () => {
    render(
      <ModelParamsCollapse
        value={{ model: 'haiku', effort: null, subagent_model: null }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    const effort = screen.getByTestId('modelparams-effort-select') as HTMLSelectElement;
    expect(effort.disabled).toBe(true);
  });

  it('clears effort when model switches to haiku', () => {
    const onChange = vi.fn();
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: 'xhigh', subagent_model: null }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    fireEvent.change(screen.getByTestId('modelparams-model-select'), {
      target: { value: 'haiku' },
    });
    expect(onChange).toHaveBeenCalledWith({
      model: 'haiku',
      effort: null,
      subagent_model: null,
    });
  });

  it('clears effort when it becomes invalid (opus+xhigh → sonnet)', () => {
    const onChange = vi.fn();
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: 'xhigh', subagent_model: null }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    fireEvent.change(screen.getByTestId('modelparams-model-select'), {
      target: { value: 'sonnet' },
    });
    expect(onChange).toHaveBeenCalledWith({
      model: 'sonnet',
      effort: null,
      subagent_model: null,
    });
  });

  it('emits onChange with the new effort value', () => {
    const onChange = vi.fn();
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: null, subagent_model: null }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    fireEvent.change(screen.getByTestId('modelparams-effort-select'), {
      target: { value: 'high' },
    });
    expect(onChange).toHaveBeenCalledWith({
      model: 'opus',
      effort: 'high',
      subagent_model: null,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/web/components/ModelParamsCollapse.test.tsx`

Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement the component**

Create `src/web/components/ModelParamsCollapse.tsx`:

```typescript
import { useState } from 'react';

export interface ModelParamsValue {
  model: string | null;
  effort: string | null;
  subagent_model: string | null;
}

const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
  { value: 'haiku', label: 'haiku' },
] as const;

const SUBAGENT_OPTIONS = [
  { value: '', label: 'Inherit' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
  { value: 'haiku', label: 'haiku' },
] as const;

function effortOptionsFor(model: string | null): string[] {
  if (model === 'haiku') return [];
  if (model === 'opus') return ['low', 'medium', 'high', 'xhigh', 'max'];
  return ['low', 'medium', 'high', 'max']; // sonnet or default/unset
}

function effortStillValid(model: string | null, effort: string | null): boolean {
  if (effort === null) return true;
  const allowed = effortOptionsFor(model);
  return allowed.includes(effort);
}

export function ModelParamsCollapse(props: {
  value: ModelParamsValue;
  onChange: (v: ModelParamsValue) => void;
}): JSX.Element {
  const { value, onChange } = props;
  const [expanded, setExpanded] = useState(false);

  const summary =
    `${value.model ?? 'default'} · effort: ${value.effort ?? 'default'} · ` +
    `subagent: ${value.subagent_model ?? 'inherit'}`;

  const effortDisabled = value.model === 'haiku';
  const effortChoices = effortOptionsFor(value.model);

  function setModel(next: string | null): void {
    const effort = effortStillValid(next, value.effort) ? value.effort : null;
    onChange({ model: next, effort, subagent_model: value.subagent_model });
  }
  function setEffort(next: string | null): void {
    onChange({ model: value.model, effort: next, subagent_model: value.subagent_model });
  }
  function setSubagent(next: string | null): void {
    onChange({ model: value.model, effort: value.effort, subagent_model: next });
  }

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        type="button"
        data-testid="modelparams-toggle"
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-surface-hover"
      >
        <span className="inline-block w-3">{expanded ? '▾' : '▸'}</span>
        <span className="font-medium">Model & effort</span>
        <span
          data-testid="modelparams-summary"
          className="text-text-dim text-sm"
        >
          · {summary}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-3 bg-surface-subtle">
          <label className="flex items-center gap-3">
            <span className="w-32 text-sm text-text-dim">Model</span>
            <select
              data-testid="modelparams-model-select"
              value={value.model ?? ''}
              onChange={(e) => setModel(e.target.value === '' ? null : e.target.value)}
              className="border border-border rounded px-2 py-1"
            >
              {MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-3">
            <span className="w-32 text-sm text-text-dim">Effort</span>
            <select
              data-testid="modelparams-effort-select"
              value={value.effort ?? ''}
              disabled={effortDisabled}
              onChange={(e) => setEffort(e.target.value === '' ? null : e.target.value)}
              className="border border-border rounded px-2 py-1"
            >
              <option value="">Default</option>
              {effortChoices.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            {effortDisabled && (
              <span className="text-xs text-text-dim">Not supported on Haiku</span>
            )}
          </label>
          <label className="flex items-center gap-3">
            <span className="w-32 text-sm text-text-dim">Subagent model</span>
            <select
              data-testid="modelparams-subagent-select"
              value={value.subagent_model ?? ''}
              onChange={(e) => setSubagent(e.target.value === '' ? null : e.target.value)}
              className="border border-border rounded px-2 py-1"
            >
              {SUBAGENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/web/components/ModelParamsCollapse.test.tsx`

Expected: all PASS. If an assertion fails because the summary string order doesn't match, tighten the test or tweak the template string — both are trivial fixes.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/ModelParamsCollapse.tsx src/web/components/ModelParamsCollapse.test.tsx
git commit -m "feat(web): add ModelParamsCollapse component"
```

---

## Task 8: NewRun page — wire in the collapse + localStorage

**Files:**
- Modify: `src/web/pages/NewRun.tsx`

- [ ] **Step 1: Add state, localStorage round-trip, and the component**

In `src/web/pages/NewRun.tsx`:

- Add imports near the top:

```typescript
import { ModelParamsCollapse, type ModelParamsValue } from '../components/ModelParamsCollapse.js';
```

- Define a constant for the localStorage key at module scope (above the component):

```typescript
const LS_KEY = 'fbi.newRun.lastModelParams';

function loadModelParams(): ModelParamsValue {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { model: null, effort: null, subagent_model: null };
    const parsed = JSON.parse(raw) as Partial<ModelParamsValue>;
    return {
      model: parsed.model ?? null,
      effort: parsed.effort ?? null,
      subagent_model: parsed.subagent_model ?? null,
    };
  } catch {
    return { model: null, effort: null, subagent_model: null };
  }
}
```

- Inside `NewRunPage`, add state using the loader as the lazy initial value:

```typescript
  const [modelParams, setModelParams] = useState<ModelParamsValue>(loadModelParams);
```

- Update `submit()` to pass modelParams and persist on success. Locate the line `const run = await api.createRun(pid, prompt, branch || undefined, draftToken ?? undefined);` and replace it + add the localStorage write immediately after:

```typescript
      const run = await api.createRun(
        pid,
        prompt,
        branch || undefined,
        draftToken ?? undefined,
        modelParams,
      );
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(modelParams));
      } catch {
        // storage unavailable — harmless, move on
      }
```

- In the JSX, insert the component directly below the existing Branch `FormRow`. Use the same container spacing (`space-y-4` parent already exists):

```tsx
      <ModelParamsCollapse value={modelParams} onChange={setModelParams} />
```

- [ ] **Step 2: Typecheck + full test suite**

Run: `npm run typecheck && npm test`

Expected: clean and green. Existing NewRun behaviour (prompt / branch / submit / nav) is unchanged.

- [ ] **Step 3: Manual browser check**

Run the dev server per README instructions:

```bash
scripts/dev.sh   # or npm run dev
```

Open the New Run page in a browser. Verify:
- The "Model & effort" header appears below the Branch field.
- Collapsed summary reads `default · effort: default · subagent: inherit`.
- Expanding shows three dropdowns.
- Selecting `haiku` disables the Effort dropdown and clears its value.
- Selecting `opus` then setting Effort=xhigh, then flipping Model back to sonnet, clears Effort.
- After submitting a run, refreshing the New Run page preserves the chosen values (localStorage).

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/NewRun.tsx
git commit -m "feat(web): wire model params into NewRun form"
```

---

## Task 9: Continue Run — dialog + RunDetail wiring

**Files:**
- Create: `src/web/components/ContinueRunDialog.tsx`
- Modify: `src/web/pages/RunDetail.tsx` (kontinue flow, ~lines 194–209)

Before writing the dialog, open `src/web/ui/primitives/` to find whichever modal / dialog primitive is in use. If there isn't one, implement the dialog as a simple absolute-positioned overlay div — the rest of the app has at least one `alert()` for continue errors today, so a first-party dialog here is an improvement. The snippet below uses a minimal inline modal to avoid assuming a primitive exists.

- [ ] **Step 1: Create the dialog component**

Create `src/web/components/ContinueRunDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Run } from '@shared/types.js';
import { ModelParamsCollapse, type ModelParamsValue } from './ModelParamsCollapse.js';

export function ContinueRunDialog(props: {
  run: Run;
  open: boolean;
  onClose: () => void;
  onSubmit: (params: ModelParamsValue) => Promise<void> | void;
}): JSX.Element | null {
  const { run, open, onClose, onSubmit } = props;
  const [value, setValue] = useState<ModelParamsValue>({
    model: run.model,
    effort: run.effort,
    subagent_model: run.subagent_model,
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValue({
        model: run.model,
        effort: run.effort,
        subagent_model: run.subagent_model,
      });
    }
  }, [open, run.id, run.model, run.effort, run.subagent_model]);

  if (!open) return null;

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    try {
      await onSubmit(value);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="continue-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg shadow-lg p-6 w-full max-w-md space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Continue run</h2>
        <p className="text-sm text-text-dim">
          Model params are pre-filled from this run. Change any to override on resume.
        </p>
        <ModelParamsCollapse value={value} onChange={setValue} />
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            className="px-3 py-1 rounded border border-border"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1 rounded bg-accent text-accent-foreground disabled:opacity-50"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Continuing…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update RunDetail to open the dialog**

In `src/web/pages/RunDetail.tsx`:

- Add imports near the top:

```typescript
import { ContinueRunDialog } from '../components/ContinueRunDialog.js';
```

- Add state where the other `useState`s for the page live:

```typescript
  const [continueOpen, setContinueOpen] = useState(false);
```

- Replace the existing `kontinue` function (around line 194) with:

```typescript
  function openContinueDialog(): void {
    if (!run) return;
    setContinueOpen(true);
  }

  async function onContinueConfirm(params: {
    model: string | null;
    effort: string | null;
    subagent_model: string | null;
  }): Promise<void> {
    if (!run) return;
    try {
      await api.continueRun(run.id, params);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const m = raw.match(/^HTTP \d+:\s*(.+)$/);
      let shown = raw;
      if (m) {
        try {
          const parsed = JSON.parse(m[1]) as { message?: string };
          if (parsed.message) shown = parsed.message;
        } catch { /* leave raw */ }
      }
      alert(shown);
    }
  }
```

- Replace any existing reference to `kontinue` in the JSX with `openContinueDialog`.

- Mount the dialog in the render tree (near the bottom, inside the main return):

```tsx
{run && (
  <ContinueRunDialog
    run={run}
    open={continueOpen}
    onClose={() => setContinueOpen(false)}
    onSubmit={onContinueConfirm}
  />
)}
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `npm run typecheck && npm test`

Expected: clean and green. No existing behaviour regresses (the dialog only appears when opened).

- [ ] **Step 4: Manual browser check**

On any finished run, click Continue:
- Dialog appears with current run's model params pre-filled.
- Change a value → click Continue → DB row reflects new params and a new container starts.
- Cancel closes the dialog without mutating the run.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/ContinueRunDialog.tsx src/web/pages/RunDetail.tsx
git commit -m "feat(web): continue-run dialog with model params override"
```

---

## Task 10: End-to-end smoke + final verification

- [ ] **Step 1: Run full suite one more time**

Run: `npm run typecheck && npm test && npm run lint`

Expected: all clean. Any lint warnings we introduced should be fixed inline.

- [ ] **Step 2: Manual smoke test with a real container**

Start a dev server. Create a new run with `Model=opus` and `Effort=high`. Immediately after the container starts, run:

```bash
docker ps --filter label=fbi --format '{{.ID}} {{.Names}}'
docker exec <container-id> env | grep -E 'ANTHROPIC_MODEL|CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_SUBAGENT_MODEL'
```

Expected output:
```
ANTHROPIC_MODEL=opus
CLAUDE_CODE_EFFORT_LEVEL=high
```
(no `CLAUDE_CODE_SUBAGENT_MODEL` line since subagent was left at Inherit).

Let the run finish. Click Continue, change Model to `sonnet`, submit. After the new container starts, re-run the `env` grep — `ANTHROPIC_MODEL` should now read `sonnet`.

- [ ] **Step 3: Final commit if needed**

If the smoke revealed anything to fix (e.g. a typo in the env var name), fix it and commit:

```bash
git add -p
git commit -m "fix: ..."
```

If nothing needs changing, no commit is required.

---

## Rollback

Every change is additive. To roll back cleanly:
- Revert the commits on this branch (`git revert`).
- The new columns are NULL for all existing rows and ignored by all pre-change code paths, so leaving them in the schema after a revert is harmless.
