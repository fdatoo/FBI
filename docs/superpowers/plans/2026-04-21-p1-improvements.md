# FBI Post-v1 P1 Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four independent P1 improvements from [`2026-04-21-p1-improvements-design.md`](../specs/2026-04-21-p1-improvements-design.md): per-container resource caps, recent-prompts dropdown, completion notifications, and Claude-owned branch naming + follow-up runs.

**Architecture:** Four self-contained phases, each of which leaves the app in a working state. Additive schema changes only (no destructive rewrites). TDD at the server/db/orchestrator layer; manual smoke for pure UI changes.

**Tech Stack:** Existing — Node 20+, TypeScript, Fastify, `@fastify/websocket`, `better-sqlite3`, `dockerode`, React 18, React Router 6, Vite, Tailwind, Vitest, Docker Engine.

**Phase order (spec §8):** Caps → Recent prompts → Notifications → Branch autonomy. Lowest blast radius first, highest last. Ship each phase independently.

---

## File Structure

Files created in this plan:

```
src/
  web/
    lib/
      notifications.ts        # NEW: permission / popup / title / favicon helpers  (Phase 3)
    hooks/
      useRunWatcher.ts        # NEW: global 5s run-state watcher                    (Phase 3)
    components/
      RecentPromptsDropdown.tsx  # NEW: compact recent-prompts dropdown             (Phase 2)
```

Files modified in this plan:

```
src/
  shared/types.ts                          # Project + Settings field additions
  server/
    config.ts                              # +3 container-cap env vars              (Phase 1)
    db/schema.sql                          # +3 project cols, +1 settings col       (Phase 1, 3)
    db/index.ts                            # migration for those 4 cols             (Phase 1, 3)
    db/projects.ts                         # read/write 3 cap cols                  (Phase 1)
    db/settings.ts                         # read/write notifications_enabled        (Phase 3)
    db/runs.ts                             # listRecentPrompts; new create sig;
                                           # markFinished accepts branch_name       (Phase 2, 4)
    api/projects.ts                        # +/api/projects/:id/prompts/recent      (Phase 2)
    api/runs.ts                            # POST accepts optional branch           (Phase 4)
    api/settings.ts                        # notifications_enabled passthrough      (Phase 3)
    orchestrator/index.ts                  # HostConfig caps; OOM; preamble;
                                           # branch overwrite on completion         (Phase 1, 4)
    orchestrator/result.ts                 # parse optional branch                  (Phase 4)
    orchestrator/supervisor.sh             # drop pre-checkout; HEAD fallback;
                                           # push HEAD; branch in result            (Phase 4)
  web/
    App.tsx                                # mount useRunWatcher                    (Phase 3)
    lib/api.ts                             # new calls; type updates                (Phase 1, 2, 3, 4)
    pages/
      EditProject.tsx                      # 3 cap inputs                           (Phase 1)
      NewRun.tsx                           # Branch field; recent dropdown;
                                           # ?branch= query param                   (Phase 2, 4)
      RunDetail.tsx                        # Follow up button                       (Phase 4)
      Settings.tsx                         # notifications toggle                   (Phase 3)
```

---

## Preflight

- [ ] **Step 0: Baseline**

Run: `npm test && npm run typecheck`
Expected: all green. Establishes a clean baseline so every later failure is attributable to this plan's changes.

---

## Phase 1 — Per-container resource caps

Additive only. Safe to ship standalone.

### Task 1.1: Extend `Config` with three container caps

**Files:**
- Modify: `src/server/config.ts`

- [ ] **Step 1: Add the three fields to the `Config` interface**

In `src/server/config.ts`, extend the interface:

```ts
export interface Config {
  // …existing fields…
  containerMemMb: number;
  containerCpus: number;
  containerPids: number;
}
```

- [ ] **Step 2: Add parsing with sensible defaults**

Inside `loadConfig()`, add before the closing brace of the returned object:

```ts
containerMemMb: Number(process.env.FBI_CONTAINER_MEM_MB ?? 4096),
containerCpus: Number(process.env.FBI_CONTAINER_CPUS ?? 2),
containerPids: Number(process.env.FBI_CONTAINER_PIDS ?? 4096),
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/config.ts
git commit -m "feat(config): add container mem/cpu/pids env vars"
```

---

### Task 1.2: Extend the `Project` shared type

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add the three optional cap fields**

In `src/shared/types.ts`, add to the `Project` interface:

```ts
export interface Project {
  // …existing fields…
  mem_mb: number | null;
  cpus: number | null;
  pids_limit: number | null;
}
```

- [ ] **Step 2: Verify typecheck fails where the new fields aren't populated**

Run: `npm run typecheck`
Expected: errors in `src/server/db/projects.ts` (fromRow doesn't populate new fields) — that's intentional, we'll fix it next.

(Do not commit yet.)

---

### Task 1.3: Add `projects` cap columns to schema and migrate

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts`

- [ ] **Step 1: Update `schema.sql` (fresh installs)**

Append these three column definitions inside the `CREATE TABLE IF NOT EXISTS projects (...)` body, before the trailing `created_at`/`updated_at` lines:

```sql
  mem_mb INTEGER,
  cpus REAL,
  pids_limit INTEGER,
```

- [ ] **Step 2: Add migration for existing databases**

In `src/server/db/index.ts`, inside `migrate()` after the `plugins_json` block and before the `INSERT OR IGNORE` on settings, add:

```ts
if (!cols.has('mem_mb')) {
  db.exec('ALTER TABLE projects ADD COLUMN mem_mb INTEGER');
}
if (!cols.has('cpus')) {
  db.exec('ALTER TABLE projects ADD COLUMN cpus REAL');
}
if (!cols.has('pids_limit')) {
  db.exec('ALTER TABLE projects ADD COLUMN pids_limit INTEGER');
}
```

- [ ] **Step 3: Verify the schema compiles at install time**

Run: `npm test -- src/server/db/index.test.ts`
Expected: PASS (existing tests must continue to pass — this is an additive migration).

If tests fail because `db/index.test.ts` opens a DB and asserts column count or similar, update the test to accept the new columns.

- [ ] **Step 4: Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts
git commit -m "feat(db): add per-project resource-cap columns"
```

---

### Task 1.4: Wire cap columns through `ProjectsRepo`

**Files:**
- Modify: `src/server/db/projects.ts`
- Modify: `src/server/db/projects.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `src/server/db/projects.test.ts` (the file already has a `tmpDb()` helper and a `beforeEach` that assigns `repo: ProjectsRepo`):

```ts
it('stores and reads resource caps', () => {
  const p = repo.create({
    name: 'capped',
    repo_url: 'u',
    default_branch: 'main',
    devcontainer_override_json: null,
    instructions: null,
    git_author_name: null,
    git_author_email: null,
    mem_mb: 2048,
    cpus: 1.5,
    pids_limit: 256,
  });
  expect(p.mem_mb).toBe(2048);
  expect(p.cpus).toBe(1.5);
  expect(p.pids_limit).toBe(256);

  repo.update(p.id, { mem_mb: null, cpus: null, pids_limit: null });
  const cleared = repo.get(p.id)!;
  expect(cleared.mem_mb).toBeNull();
  expect(cleared.cpus).toBeNull();
  expect(cleared.pids_limit).toBeNull();
});

it('defaults resource caps to null when omitted', () => {
  const p = repo.create({
    name: 'defaulted',
    repo_url: 'u',
    default_branch: 'main',
    devcontainer_override_json: null,
    instructions: null,
    git_author_name: null,
    git_author_email: null,
  });
  expect(p.mem_mb).toBeNull();
  expect(p.cpus).toBeNull();
  expect(p.pids_limit).toBeNull();
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm test -- src/server/db/projects.test.ts`
Expected: FAIL — `mem_mb` etc. do not flow through.

- [ ] **Step 3: Extend `CreateProjectInput`, `ProjectRow`, `fromRow`, `create`, `update`**

In `src/server/db/projects.ts`:

Add to `CreateProjectInput`:
```ts
  mem_mb?: number | null;
  cpus?: number | null;
  pids_limit?: number | null;
```

Add to `ProjectRow`:
```ts
  mem_mb: number | null;
  cpus: number | null;
  pids_limit: number | null;
```

In `fromRow`, add:
```ts
    mem_mb: row.mem_mb,
    cpus: row.cpus,
    pids_limit: row.pids_limit,
```

In `create`, extend the INSERT column list and VALUES to include the three new columns, pulling from `input.mem_mb ?? null` etc.:

```ts
const stmt = this.db.prepare(
  `INSERT INTO projects
    (name, repo_url, default_branch, devcontainer_override_json,
     instructions, git_author_name, git_author_email,
     marketplaces_json, plugins_json,
     mem_mb, cpus, pids_limit,
     created_at, updated_at)
   VALUES (@name, @repo_url, @default_branch, @devcontainer_override_json,
           @instructions, @git_author_name, @git_author_email,
           @marketplaces_json, @plugins_json,
           @mem_mb, @cpus, @pids_limit,
           @now, @now)`
);
stmt.run({
  // …existing fields…
  mem_mb: input.mem_mb ?? null,
  cpus: input.cpus ?? null,
  pids_limit: input.pids_limit ?? null,
  now,
});
```

In `update`, extend the UPDATE statement and the `.run({...})` payload the same way:

```ts
`UPDATE projects SET
  name=@name, repo_url=@repo_url, default_branch=@default_branch,
  devcontainer_override_json=@devcontainer_override_json,
  instructions=@instructions,
  git_author_name=@git_author_name, git_author_email=@git_author_email,
  marketplaces_json=@marketplaces_json,
  plugins_json=@plugins_json,
  mem_mb=@mem_mb, cpus=@cpus, pids_limit=@pids_limit,
  updated_at=@updated_at
 WHERE id=@id`
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm test -- src/server/db/projects.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/projects.ts src/server/db/projects.test.ts
git commit -m "feat(db): read/write project resource caps"
```

---

### Task 1.5: Pass caps through the Projects API

**Files:**
- Modify: `src/server/api/projects.ts`

The body types should accept the three new optional fields on both POST and PATCH — the current handler forwards `req.body` verbatim for PATCH and builds an explicit payload for POST.

- [ ] **Step 1: Update POST handler's body type and `projects.create(...)` call**

In `src/server/api/projects.ts`, extend the POST body type:

```ts
const body = req.body as {
  // …existing fields…
  mem_mb?: number | null;
  cpus?: number | null;
  pids_limit?: number | null;
};
```

And pass through to `projects.create`:

```ts
const created = deps.projects.create({
  // …existing fields…
  mem_mb: body.mem_mb ?? null,
  cpus: body.cpus ?? null,
  pids_limit: body.pids_limit ?? null,
});
```

The existing PATCH handler already forwards `req.body` as `Record<string, unknown>`; no change needed.

- [ ] **Step 2: Verify existing API tests still pass**

Run: `npm test -- src/server/api/projects.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/server/api/projects.ts
git commit -m "feat(api): accept resource caps on project create"
```

---

### Task 1.6: Apply caps to the Docker container + detect OOM

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 1: Resolve effective caps at container-create time**

In `src/server/orchestrator/index.ts`, inside `launch()` just before the `docker.createContainer` call, add:

```ts
const memMb = project.mem_mb ?? this.deps.config.containerMemMb;
const cpus  = project.cpus   ?? this.deps.config.containerCpus;
const pids  = project.pids_limit ?? this.deps.config.containerPids;
```

- [ ] **Step 2: Pass caps into `HostConfig`**

Extend the existing `HostConfig` object in the `createContainer` call to include:

```ts
HostConfig: {
  AutoRemove: false,
  Memory:   memMb * 1024 * 1024,
  NanoCpus: Math.round(cpus * 1e9),
  PidsLimit: pids,
  Binds: [ /* …unchanged… */ ],
},
```

- [ ] **Step 3: Detect OOM on container exit (both `launch()` and `reattach()`)**

Currently the code does `const waitRes = await container.wait()` and then parses `result.json`. After `container.wait()` resolves, inspect the container once to check the OOM flag:

```ts
const waitRes = await container.wait();
const inspect = await container.inspect().catch(() => null);
const oomKilled = Boolean(inspect?.State?.OOMKilled);
```

Then, where the `error` message is computed on failure, prefer the OOM message when `oomKilled` is true:

```ts
error:
  state === 'failed'
    ? oomKilled
      ? `container OOM (memory cap ${memMb} MB)`
      : parsed
        ? parsed.push_exit !== 0
          ? `git push failed (code ${parsed.push_exit})`
          : `agent exit ${parsed.exit_code}`
        : `container exit ${waitRes.StatusCode}`
    : null,
```

Apply the same pattern in `reattach()` — the three lines to inspect, plus the conditional OOM message in its `error` computation. `reattach()` doesn't have `memMb` in scope; re-resolve it there the same way as step 1 (pull from the run's project row).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): apply resource caps and detect OOM"
```

---

### Task 1.7: Expose caps in the Edit Project UI

**Files:**
- Modify: `src/web/pages/EditProject.tsx`
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Update `api.updateProject` to include the three fields**

In `src/web/lib/api.ts`, extend the `updateProject` payload type to accept `mem_mb`, `cpus`, `pids_limit` (each nullable number). The existing signature likely uses a structural type of the patch body; mirror the server side.

- [ ] **Step 2: Add three inputs and an optional-number helper to `EditProject.tsx`**

In `src/web/pages/EditProject.tsx`, import or inline this helper:

```tsx
function NumberField({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="w-full border rounded px-2 py-1 font-mono dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
      />
    </label>
  );
}
```

Add three fields after the Git author block and before the Instructions area:

```tsx
<NumberField label="Memory cap (MB) — blank = global default"
             value={p.mem_mb} onChange={(v) => setP({ ...p, mem_mb: v })} />
<NumberField label="CPUs — blank = global default"
             value={p.cpus} onChange={(v) => setP({ ...p, cpus: v })} />
<NumberField label="Pids limit — blank = global default"
             value={p.pids_limit} onChange={(v) => setP({ ...p, pids_limit: v })} />
```

Include the three fields in the `api.updateProject(...)` call:

```tsx
await api.updateProject(pid, {
  // …existing fields…
  mem_mb: p.mem_mb,
  cpus: p.cpus,
  pids_limit: p.pids_limit,
});
```

- [ ] **Step 3: Manual smoke**

Run: `npm run dev` in one terminal, open http://localhost:5173, create/edit a project, set `mem_mb=2048`, save, reload, confirm the value round-trips.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/EditProject.tsx src/web/lib/api.ts
git commit -m "feat(ui): resource cap inputs on Edit Project"
```

---

### Task 1.8: Phase 1 verification

- [ ] **Step 1: Full test suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Manual OOM smoke (optional)**

With Docker available, create a project with `mem_mb=64`, start a run that does anything non-trivial, verify the run ends with state `failed` and `error` containing `container OOM`.

Phase 1 complete.

---

## Phase 2 — Recent prompts dropdown

### Task 2.1: Add `listRecentPrompts` to `RunsRepo`

**Files:**
- Modify: `src/server/db/runs.ts`
- Modify: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `src/server/db/runs.test.ts`:

```ts
it('listRecentPrompts returns distinct prompts newest-first with limit', () => {
  const mk = (prompt: string) =>
    runs.create({
      project_id: projectId,
      prompt,
      branch_name_tmpl: (id) => `b-${id}`,
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
  mk('alpha');
  mk('beta');
  mk('alpha'); // dup — should dedupe and re-surface alpha as newest
  mk('gamma');

  const recent = runs.listRecentPrompts(projectId, 10);
  expect(recent.map((r) => r.prompt)).toEqual(['gamma', 'alpha', 'beta']);
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: FAIL — method does not exist.

- [ ] **Step 3: Implement `listRecentPrompts`**

Add to `RunsRepo` in `src/server/db/runs.ts`:

```ts
listRecentPrompts(
  projectId: number,
  limit = 10
): { prompt: string; last_used_at: number; run_id: number }[] {
  return this.db
    .prepare(
      `SELECT prompt,
              MAX(created_at) AS last_used_at,
              MAX(id)         AS run_id
         FROM runs
        WHERE project_id = ?
        GROUP BY prompt
        ORDER BY last_used_at DESC
        LIMIT ?`
    )
    .all(projectId, limit) as {
      prompt: string;
      last_used_at: number;
      run_id: number;
    }[];
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(db): listRecentPrompts"
```

---

### Task 2.2: Expose `/api/projects/:id/prompts/recent`

**Files:**
- Modify: `src/server/api/projects.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Thread the `runs` repo into `registerProjectRoutes`**

In `src/server/api/projects.ts`, extend the `Deps` interface:

```ts
import type { RunsRepo } from '../db/runs.js';

interface Deps {
  projects: ProjectsRepo;
  secrets: SecretsRepo;
  runs: RunsRepo;
}
```

- [ ] **Step 2: Register the route inside `registerProjectRoutes`**

Add near the other routes:

```ts
app.get('/api/projects/:id/prompts/recent', async (req) => {
  const { id } = req.params as { id: string };
  const limit = Math.min(
    50,
    Math.max(1, Number((req.query as { limit?: string }).limit ?? 10))
  );
  return deps.runs.listRecentPrompts(Number(id), limit);
});
```

- [ ] **Step 3: Pass `runs` in from `src/server/index.ts`**

In `src/server/index.ts`, update the `registerProjectRoutes` call to pass `runs`:

```ts
registerProjectRoutes(app, { projects, secrets, runs });
```

- [ ] **Step 4: Add an API test**

Update the existing `makeApp()` helper in `src/server/api/projects.test.ts` to thread the `runs` repo:

```ts
import { RunsRepo } from '../db/runs.js';

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const secrets = new SecretsRepo(db, crypto.randomBytes(32));
  const runs = new RunsRepo(db);
  const app = Fastify();
  registerProjectRoutes(app, { projects, secrets, runs });
  return { app, projects, runs };
}
```

And update existing tests that previously did `const app = makeApp()` to `const { app } = makeApp()`. Append the new test:

```ts
it('GET /api/projects/:id/prompts/recent returns distinct prompts newest-first', async () => {
  const { app, projects, runs } = makeApp();
  const p = projects.create({
    name: 'x', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  runs.create({
    project_id: p.id,
    prompt: 'alpha',
    branch_name_tmpl: (id) => `b-${id}`,
    log_path_tmpl: (id) => `/tmp/${id}.log`,
  });
  runs.create({
    project_id: p.id,
    prompt: 'beta',
    branch_name_tmpl: (id) => `b-${id}`,
    log_path_tmpl: (id) => `/tmp/${id}.log`,
  });
  const res = await app.inject({
    method: 'GET',
    url: `/api/projects/${p.id}/prompts/recent?limit=10`,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { prompt: string }[];
  expect(body.map((x) => x.prompt)).toEqual(['beta', 'alpha']);
});
```

Note: at this point in the plan (Phase 2, before Task 4.2), `RunsRepo.create` still takes `branch_name_tmpl` — so this test's usage is correct. Task 4.2 will change that call shape; when you get there, update this test accordingly (drop `branch_name_tmpl`).

- [ ] **Step 5: Run the test — expect pass**

Run: `npm test -- src/server/api/projects.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/api/projects.ts src/server/index.ts src/server/api/projects.test.ts
git commit -m "feat(api): GET /projects/:id/prompts/recent"
```

---

### Task 2.3: Add `api.getRecentPrompts` client wrapper

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Add method**

In `src/web/lib/api.ts`, add:

```ts
async getRecentPrompts(
  projectId: number,
  limit = 10
): Promise<{ prompt: string; last_used_at: number; run_id: number }[]> {
  const r = await fetch(
    `/api/projects/${projectId}/prompts/recent?limit=${limit}`
  );
  if (!r.ok) throw new Error(`GET prompts/recent failed: ${r.status}`);
  return r.json();
},
```

(Match the style of the surrounding `api` object — if it's a plain object literal, use object-method syntax; if a class, use method syntax.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/lib/api.ts
git commit -m "feat(api-client): getRecentPrompts"
```

---

### Task 2.4: Recent prompts dropdown component + NewRun wiring

**Files:**
- Create: `src/web/components/RecentPromptsDropdown.tsx`
- Modify: `src/web/pages/NewRun.tsx`

- [ ] **Step 1: Create the component**

New file `src/web/components/RecentPromptsDropdown.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

interface Props {
  projectId: number;
  onPick: (prompt: string) => void;
}

export function RecentPromptsDropdown({ projectId, onPick }: Props) {
  const [items, setItems] = useState<
    { prompt: string; last_used_at: number; run_id: number }[]
  >([]);

  useEffect(() => {
    let alive = true;
    void api.getRecentPrompts(projectId, 10).then((xs) => {
      if (alive) setItems(xs);
    });
    return () => { alive = false; };
  }, [projectId]);

  if (items.length === 0) return null;

  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">Recent prompts</span>
      <select
        className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        defaultValue=""
        onChange={(e) => {
          const idx = Number(e.target.value);
          if (Number.isFinite(idx) && items[idx]) {
            onPick(items[idx].prompt);
            e.currentTarget.value = '';
          }
        }}
      >
        <option value="" disabled>Load a previous prompt…</option>
        {items.map((it, idx) => (
          <option key={it.run_id} value={idx}>
            {it.prompt.slice(0, 80).replace(/\s+/g, ' ')}
            {it.prompt.length > 80 ? '…' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
```

- [ ] **Step 2: Wire into `NewRun.tsx`**

In `src/web/pages/NewRun.tsx`, import and render the dropdown above the textarea:

```tsx
import { RecentPromptsDropdown } from '../components/RecentPromptsDropdown.js';

// …inside the <form>, above the <textarea>:
<RecentPromptsDropdown projectId={pid} onPick={setPrompt} />
```

- [ ] **Step 3: Manual smoke**

Run: `npm run dev`, open a project with prior runs, verify the dropdown appears, selecting an entry fills the textarea, and an empty-project does not render the dropdown.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/RecentPromptsDropdown.tsx src/web/pages/NewRun.tsx
git commit -m "feat(ui): recent prompts dropdown on New Run"
```

Phase 2 complete.

---

## Phase 3 — Completion notifications

### Task 3.1: Add `notifications_enabled` column and repo support

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts`
- Modify: `src/server/db/settings.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/settings.test.ts` (or append to whichever test file covers `SettingsRepo`)

- [ ] **Step 1: Extend `Settings` type**

In `src/shared/types.ts`:

```ts
export interface Settings {
  global_prompt: string;
  notifications_enabled: boolean;
  updated_at: number;
}
```

- [ ] **Step 2: Add schema column (fresh installs)**

In `src/server/db/schema.sql`, inside the settings CREATE TABLE body, add:

```sql
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
```

Update the `INSERT OR IGNORE` if it enumerates columns — keep existing seed behavior:

```sql
INSERT OR IGNORE INTO settings (id, global_prompt, notifications_enabled, updated_at)
VALUES (1, '', 1, 0);
```

- [ ] **Step 3: Migrate existing DBs**

In `src/server/db/index.ts` `migrate()`, after the existing projects-column block, add:

```ts
const settingsCols = new Set(
  (db.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>)
    .map((r) => r.name)
);
if (!settingsCols.has('notifications_enabled')) {
  db.exec(
    'ALTER TABLE settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1'
  );
}
```

- [ ] **Step 4: Write a failing test**

Create `src/server/db/settings.test.ts` (the file does not exist):

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { SettingsRepo } from './settings.js';

describe('SettingsRepo', () => {
  it('reads and updates notifications_enabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    expect(settings.get().notifications_enabled).toBe(true);
    settings.update({ notifications_enabled: false });
    expect(settings.get().notifications_enabled).toBe(false);
  });
});
```

- [ ] **Step 5: Update `SettingsRepo`**

In `src/server/db/settings.ts`:

Extend `SettingsRow`:
```ts
interface SettingsRow {
  id: number;
  global_prompt: string;
  notifications_enabled: number;
  updated_at: number;
}
```

Update `get()`:
```ts
get(): Settings {
  const row = this.db
    .prepare('SELECT * FROM settings WHERE id = 1')
    .get() as SettingsRow | undefined;
  if (!row) {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO settings (id, global_prompt, notifications_enabled, updated_at) VALUES (1, ?, 1, ?)'
      )
      .run('', now);
    return { global_prompt: '', notifications_enabled: true, updated_at: now };
  }
  return {
    global_prompt: row.global_prompt,
    notifications_enabled: row.notifications_enabled === 1,
    updated_at: row.updated_at,
  };
}
```

Update `update()`:
```ts
update(patch: {
  global_prompt?: string;
  notifications_enabled?: boolean;
}): Settings {
  const existing = this.get();
  const merged = {
    global_prompt: patch.global_prompt ?? existing.global_prompt,
    notifications_enabled:
      patch.notifications_enabled ?? existing.notifications_enabled,
    updated_at: Date.now(),
  };
  this.db
    .prepare(
      'UPDATE settings SET global_prompt = ?, notifications_enabled = ?, updated_at = ? WHERE id = 1'
    )
    .run(
      merged.global_prompt,
      merged.notifications_enabled ? 1 : 0,
      merged.updated_at
    );
  return merged;
}
```

- [ ] **Step 6: Run tests — expect pass**

Run: `npm test -- src/server/db/settings.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts src/server/db/settings.ts \
        src/server/db/settings.test.ts src/shared/types.ts
git commit -m "feat(db,settings): notifications_enabled column"
```

---

### Task 3.2: Pass `notifications_enabled` through the Settings API

**Files:**
- Modify: `src/server/api/settings.ts`

- [ ] **Step 1: Accept the new field on the PATCH handler**

Replace the body of the `app.patch('/api/settings', …)` handler in `src/server/api/settings.ts`:

```ts
app.patch('/api/settings', async (req) => {
  const body = req.body as {
    global_prompt?: string;
    notifications_enabled?: boolean;
  };
  return deps.settings.update({
    global_prompt: body.global_prompt,
    notifications_enabled: body.notifications_enabled,
  });
});
```

GET returns the full `Settings` shape (now including the new field automatically), so it needs no change.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/api/settings.ts
git commit -m "feat(api): settings notifications_enabled passthrough"
```

---

### Task 3.3: Settings page toggle

**Files:**
- Modify: `src/web/lib/api.ts`
- Modify: `src/web/pages/Settings.tsx`

- [ ] **Step 1: Update `api.getSettings`/`updateSettings` types to include the new field**

In `src/web/lib/api.ts`, extend the Settings type or shape returned. Adapt to existing style.

- [ ] **Step 2: Add toggle to Settings page**

In `src/web/pages/Settings.tsx`, add a second piece of state and a checkbox. Minimal diff:

```tsx
const [enabled, setEnabled] = useState<boolean>(true);
// …inside the effect, after setPrompt:
setEnabled(s.notifications_enabled);

// …inside the form, above the submit button:
<label className="flex items-center gap-2">
  <input
    type="checkbox"
    checked={enabled}
    onChange={(e) => setEnabled(e.target.checked)}
  />
  <span className="text-sm">Enable run-completion notifications</span>
</label>
```

Include `notifications_enabled: enabled` in the `api.updateSettings(...)` call.

- [ ] **Step 3: Manual smoke**

Run: `npm run dev`, open `/settings`, toggle off, save, reload — toggle should remain off.

- [ ] **Step 4: Commit**

```bash
git add src/web/lib/api.ts src/web/pages/Settings.tsx
git commit -m "feat(ui): settings notifications toggle"
```

---

### Task 3.4: Notification helpers

**Files:**
- Create: `src/web/lib/notifications.ts`

- [ ] **Step 1: Implement the helpers**

```ts
// src/web/lib/notifications.ts
// Browser-only helpers for completion notifications:
//   ensurePermission() — request Notification permission if `default`.
//   notifyComplete()   — fire the three side effects: OS popup, tab title, favicon.
//
// The three side effects are independent and safe to call when the tab is
// focused (in that case the title/favicon are reset on the next focus event,
// which usually fires immediately since we're already focused).

let unread = 0;
const origTitle = typeof document !== 'undefined' ? document.title : 'FBI';
let faviconLink: HTMLLinkElement | null = null;

function getFaviconLink(): HTMLLinkElement | null {
  if (faviconLink) return faviconLink;
  faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  return faviconLink;
}

function drawFaviconWithDot(color: string): string {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111827';              // slate-900 background so the dot reads
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(22, 10, 7, 0, Math.PI * 2);
  ctx.fill();
  return c.toDataURL('image/png');
}

export async function ensurePermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'default') {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

export async function notifyComplete(run: {
  id: number;
  state: 'succeeded' | 'failed' | 'cancelled';
  project_name?: string;
}): Promise<void> {
  const color =
    run.state === 'succeeded' ? '#22c55e' :
    run.state === 'failed'    ? '#ef4444' :
    '#9ca3af';
  const label = `${run.state === 'succeeded' ? '✓' : run.state === 'failed' ? '✗' : '⊘'} Run #${run.id}`;

  // 1. OS popup
  const perm = await ensurePermission();
  if (perm === 'granted') {
    new Notification(label, {
      body: run.project_name ? `Project: ${run.project_name}` : 'Run finished',
      tag: `fbi-run-${run.id}`,
    });
  }

  // 2. Tab title (only if the tab isn't focused)
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    unread += 1;
    document.title = `(${unread}) ${origTitle}`;
  }

  // 3. Favicon dot
  const link = getFaviconLink();
  if (link) link.href = drawFaviconWithDot(color);
}

export function installFocusReset(): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => {
    if (document.visibilityState === 'visible') {
      unread = 0;
      document.title = origTitle;
      const link = getFaviconLink();
      if (link) link.href = '/favicon.ico';
    }
  };
  document.addEventListener('visibilitychange', handler);
  window.addEventListener('focus', handler);
  return () => {
    document.removeEventListener('visibilitychange', handler);
    window.removeEventListener('focus', handler);
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/lib/notifications.ts
git commit -m "feat(notifications): permission + popup + title + favicon helpers"
```

---

### Task 3.5: Global run watcher hook

**Files:**
- Create: `src/web/hooks/useRunWatcher.ts`

- [ ] **Step 1: Implement the hook**

```ts
// src/web/hooks/useRunWatcher.ts
// Polls /api/runs every POLL_MS and fires notifyComplete() for any run that
// was in `running` on the previous tick and is not in this tick's running set.
// The *shared* nature of this watcher means any open FBI tab handles any run.
import { useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { notifyComplete, installFocusReset } from '../lib/notifications.js';

const POLL_MS = 5000;

export function useRunWatcher(enabled: boolean) {
  const prev = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    const dispose = installFocusReset();
    let stopped = false;
    const tick = async () => {
      try {
        const running = await api.listRuns('running');       // see step 2
        const nowIds = new Set(running.map((r) => r.id));
        const finishedIds: number[] = [];
        prev.current.forEach((id) => {
          if (!nowIds.has(id)) finishedIds.push(id);
        });
        prev.current = nowIds;
        for (const id of finishedIds) {
          const run = await api.getRun(id);
          if (run && (run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled')) {
            const proj = await api.getProject(run.project_id).catch(() => null);
            await notifyComplete({
              id: run.id,
              state: run.state,
              project_name: proj?.name,
            });
          }
        }
      } catch { /* swallow — next tick will retry */ }
      if (!stopped) setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { stopped = true; dispose(); };
  }, [enabled]);
}
```

- [ ] **Step 2: Extend `api.listRuns` to accept an optional `state` filter**

In `src/web/lib/api.ts`, update `listRuns` to accept an optional state parameter and append `?state=` when present. The existing GET `/api/runs` endpoint returns all runs; if it does not yet accept `?state=` as a query param, add that handling server-side in `src/server/api/runs.ts` (one-line change: read `req.query.state`, filter via `runs.listByState` when present).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/hooks/useRunWatcher.ts src/web/lib/api.ts src/server/api/runs.ts
git commit -m "feat(notifications): useRunWatcher + /api/runs?state= filter"
```

---

### Task 3.6: Mount the watcher globally

**Files:**
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Fetch settings on mount and pass `enabled` to the hook**

In `src/web/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useRunWatcher } from './hooks/useRunWatcher.js';
import { api } from './lib/api.js';

// Inside the root component:
const [notifEnabled, setNotifEnabled] = useState(false);
useEffect(() => {
  void api.getSettings().then((s) => setNotifEnabled(s.notifications_enabled));
}, []);
useRunWatcher(notifEnabled);
```

Place the two lines at the top of the component body. The hook short-circuits when `enabled` is false, so polling starts only once the settings request resolves.

- [ ] **Step 2: Manual smoke**

Run: `npm run dev`, kick off a trivial run, close the tab to a background state, verify (1) OS popup when it completes, (2) tab title changes to `(1) …`, (3) favicon shows a dot. Toggle notifications off in Settings, confirm no popups fire.

- [ ] **Step 3: Commit**

```bash
git add src/web/App.tsx
git commit -m "feat(notifications): mount global run watcher"
```

Phase 3 complete.

---

## Phase 4 — Claude-owned branch naming + follow-up runs

This is the highest-blast-radius phase. Commits inside it should leave the suite green at every step; if something breaks, stop and investigate before moving on.

### Task 4.1: `ContainerResult` gains optional `branch`

**Files:**
- Modify: `src/server/orchestrator/result.ts`
- Modify: `src/server/orchestrator/result.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `src/server/orchestrator/result.test.ts`:

```ts
it('parses optional branch field', () => {
  const r = parseResultJson(
    '{"exit_code":0,"push_exit":0,"head_sha":"abc","branch":"fix-login"}'
  );
  expect(r?.branch).toBe('fix-login');
});

it('accepts absence of branch field', () => {
  const r = parseResultJson(
    '{"exit_code":0,"push_exit":0,"head_sha":"abc"}'
  );
  expect(r).not.toBeNull();
  expect(r?.branch).toBeUndefined();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- src/server/orchestrator/result.test.ts`
Expected: FAIL — `branch` not on type.

- [ ] **Step 3: Update `ContainerResult` and `parseResultJson`**

In `src/server/orchestrator/result.ts`:

```ts
export interface ContainerResult {
  exit_code: number;
  push_exit: number;
  head_sha: string;
  branch?: string;
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
      return result;
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- src/server/orchestrator/result.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/result.ts src/server/orchestrator/result.test.ts
git commit -m "feat(result): optional branch field"
```

---

### Task 4.2: Reshape `RunsRepo.create` to accept a branch hint

**Files:**
- Modify: `src/server/db/runs.ts`
- Modify: `src/server/db/runs.test.ts`
- Modify: `src/server/api/runs.ts`

- [ ] **Step 1: Update `CreateRunInput` and `create()`**

In `src/server/db/runs.ts`, replace `CreateRunInput`:

```ts
export interface CreateRunInput {
  project_id: number;
  prompt: string;
  branch_hint?: string;                 // NEW: operator hint; '' or omitted = Claude decides
  log_path_tmpl: (id: number) => string;
}
```

Replace `create()`:

```ts
create(input: CreateRunInput): Run {
  return this.db.transaction(() => {
    const now = Date.now();
    const branchHint = input.branch_hint ?? '';
    const stub = this.db
      .prepare(
        `INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at)
         VALUES (?, ?, ?, 'queued', '', ?)`
      )
      .run(input.project_id, input.prompt, branchHint, now);
    const id = Number(stub.lastInsertRowid);
    const logPath = input.log_path_tmpl(id);
    this.db
      .prepare('UPDATE runs SET log_path = ? WHERE id = ?')
      .run(logPath, id);
    return this.get(id)!;
  })();
}
```

- [ ] **Step 2: Update the existing `runs.test.ts`**

The existing `creates a queued run with computed fields` test uses `branch_name_tmpl: (id) => \`claude/run-${id}\``. Replace with:

```ts
it('creates a queued run with empty branch when no hint given', () => {
  const run = runs.create({
    project_id: projectId,
    prompt: 'hello',
    log_path_tmpl: (id) => `/tmp/runs/${id}.log`,
  });
  expect(run.state).toBe('queued');
  expect(run.branch_name).toBe('');
  expect(run.log_path).toBe(`/tmp/runs/${run.id}.log`);
});

it('stores a branch hint on create', () => {
  const run = runs.create({
    project_id: projectId,
    prompt: 'hi',
    branch_hint: 'fix-login-bug',
    log_path_tmpl: (id) => `/tmp/runs/${id}.log`,
  });
  expect(run.branch_name).toBe('fix-login-bug');
});
```

Update any other test in the file that uses `branch_name_tmpl`: drop the field, don't assert on `branch_name` unless relevant.

- [ ] **Step 3: Update the one call-site in `src/server/api/runs.ts`**

Replace the `POST /api/projects/:id/runs` handler body:

```ts
app.post('/api/projects/:id/runs', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { prompt: string; branch?: string };
  const hint = (body.branch ?? '').trim();
  const run = deps.runs.create({
    project_id: Number(id),
    prompt: body.prompt,
    branch_hint: hint === '' ? undefined : hint,
    log_path_tmpl: (rid) => path.join(deps.runsDir, `${rid}.log`),
  });
  void deps.launch(run.id).catch((err) => app.log.error({ err }, 'launch failed'));
  reply.code(201);
  return run;
});
```

Remove the `branch_name_tmpl` line entirely.

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- src/server/db/runs.test.ts src/server/api/runs.test.ts`
Expected: PASS. If `runs.test.ts` (API) asserts on specific branch_name values, loosen those to allow empty string / stop asserting the old format.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/runs.ts src/server/db/runs.test.ts src/server/api/runs.ts
git commit -m "feat(runs): optional branch_hint on create"
```

---

### Task 4.3: `markFinished` can overwrite `branch_name`

**Files:**
- Modify: `src/server/db/runs.ts`
- Modify: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `src/server/db/runs.test.ts`:

```ts
it('markFinished can overwrite branch_name', () => {
  const run = runs.create({
    project_id: projectId,
    prompt: 'x',
    log_path_tmpl: (id) => `/tmp/${id}.log`,
  });
  runs.markStarted(run.id, 'c');
  runs.markFinished(run.id, {
    state: 'succeeded',
    exit_code: 0,
    head_commit: 'deadbeef',
    branch_name: 'fix-login-bug',
  });
  expect(runs.get(run.id)!.branch_name).toBe('fix-login-bug');
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: FAIL — `branch_name` not on `FinishInput`.

- [ ] **Step 3: Extend `FinishInput` and the UPDATE**

In `src/server/db/runs.ts`:

```ts
export interface FinishInput {
  state: Extract<RunState, 'succeeded' | 'failed' | 'cancelled'>;
  exit_code?: number | null;
  error?: string | null;
  head_commit?: string | null;
  branch_name?: string | null;       // NEW
}

markFinished(id: number, f: FinishInput): void {
  if (f.branch_name !== undefined && f.branch_name !== null && f.branch_name !== '') {
    this.db
      .prepare('UPDATE runs SET branch_name = ? WHERE id = ?')
      .run(f.branch_name, id);
  }
  this.db
    .prepare(
      `UPDATE runs SET state=?, container_id=NULL, exit_code=?, error=?,
       head_commit=?, finished_at=? WHERE id=?`
    )
    .run(
      f.state,
      f.exit_code ?? null,
      f.error ?? null,
      f.head_commit ?? null,
      Date.now(),
      id
    );
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(runs): markFinished can overwrite branch_name"
```

---

### Task 4.4: Rewrite `supervisor.sh`

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`

- [ ] **Step 1: Replace the branch/clone/push block**

Replace the existing `cd /workspace` through the final `printf /tmp/result.json` block with the following:

```bash
cd /workspace

git clone --recurse-submodules "$REPO_URL" . || { echo "clone failed"; exit 10; }
git checkout "$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Compose the final prompt: global + project instructions + run prompt.
: > /tmp/prompt.txt
for section in global.txt instructions.txt; do
    if [ -s "/fbi/$section" ]; then
        cat "/fbi/$section" >> /tmp/prompt.txt
        printf '\n\n---\n\n' >> /tmp/prompt.txt
    fi
done
[ -f /fbi/prompt.txt ] || { echo "prompt.txt not found in /fbi"; exit 12; }
cat /fbi/prompt.txt >> /tmp/prompt.txt

# Run the agent.
set +e
claude --dangerously-skip-permissions < /tmp/prompt.txt
CLAUDE_EXIT=$?
set -e

# Capture uncommitted work.
git add -A
git commit -m "wip: claude run $RUN_ID" 2>/dev/null || true

# Detect current branch. If Claude never branched, create the fallback so we
# never push to the default branch.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ]; then
    CURRENT_BRANCH="claude/run-$RUN_ID"
    git checkout -b "$CURRENT_BRANCH"
    echo "[fbi] claude didn't branch; pushing to fallback $CURRENT_BRANCH"
fi

PUSH_EXIT=0
git push -u origin "$CURRENT_BRANCH" || PUSH_EXIT=$?

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s","branch":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" "$CURRENT_BRANCH" > /tmp/result.json

exit $CLAUDE_EXIT
```

Update the header comment block at the top of the file to reflect the new contract (drop the "git clone + checkout -b $BRANCH_NAME" claim; note "Claude owns branching").

- [ ] **Step 2: Verify `build:server` copies the file**

Run: `npm run build:server`
Expected: PASS, with `dist/server/orchestrator/supervisor.sh` present.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): claude owns branching, push HEAD"
```

---

### Task 4.5: Orchestrator preamble, branch overwrite, hint passthrough

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 1: Compose the branch preamble**

Near the top of `launch()` (after loading `project`), compute the preamble:

```ts
const branchHint = run.branch_name;  // '' or a hint
const preamble = [
  `You are working in /workspace on ${project.repo_url}.`,
  `Its default branch is ${project.default_branch}. Do NOT commit to ${project.default_branch}.`,
  branchHint
    ? `Create or check out a branch named \`${branchHint}\`,`
    : `Create or check out a branch appropriately named for this task,`,
  'do your work there, and leave all commits on that branch.',
  '',
].join('\n');
```

- [ ] **Step 2: Inject the preamble as a fourth file in `/fbi`**

The current injection writes `prompt.txt`, `instructions.txt`, `global.txt`. Add `preamble.txt` and update `supervisor.sh` to include it:

In `index.ts`:
```ts
await injectFiles(container, '/fbi', {
  'prompt.txt': run.prompt ?? '',
  'instructions.txt': project.instructions ?? '',
  'global.txt': globalPrompt,
  'preamble.txt': preamble,
});
```

In `supervisor.sh`, update the composition loop to include `preamble.txt` first:

```bash
for section in preamble.txt global.txt instructions.txt; do
```

(Apply this `supervisor.sh` edit in the same commit as the orchestrator change.)

- [ ] **Step 3: Overwrite `runs.branch_name` on completion**

After `parseResultJson(...)` and before the `markFinished` call, compute the branch and pass it through:

```ts
const branchFromResult =
  (parsed?.branch && parsed.branch.length > 0) ? parsed.branch : null;

this.deps.runs.markFinished(runId, {
  state,
  exit_code: parsed?.exit_code ?? waitRes.StatusCode,
  head_commit: parsed?.head_sha ?? null,
  branch_name: branchFromResult,
  error: /* …existing computation… */,
});
```

Do the same in the `reattach()` path.

- [ ] **Step 4: Stop passing a pre-computed branch name into container env**

Remove the `BRANCH_NAME=${run.branch_name}` line from the `Env` array in `createContainer`. Supervisor no longer reads it.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/supervisor.sh
git commit -m "feat(orchestrator): branch preamble and post-run branch overwrite"
```

---

### Task 4.6: NewRun branch input + `?branch=` query param

**Files:**
- Modify: `src/web/pages/NewRun.tsx`
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Extend `api.createRun` to send `branch`**

In `src/web/lib/api.ts`, update `createRun`:

```ts
async createRun(projectId: number, prompt: string, branch?: string): Promise<Run> {
  const r = await fetch(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, branch: branch && branch.trim() !== '' ? branch.trim() : undefined }),
  });
  if (!r.ok) throw new Error(`POST runs failed: ${r.status}`);
  return r.json();
},
```

- [ ] **Step 2: Read `?branch=` and add an input field**

In `src/web/pages/NewRun.tsx`:

```tsx
import { useSearchParams } from 'react-router-dom';
// …
const [searchParams] = useSearchParams();
const [branch, setBranch] = useState(searchParams.get('branch') ?? '');

// Inside the <form>, above the textarea:
<label className="block">
  <span className="block text-sm font-medium mb-1">Branch name (optional)</span>
  <input
    value={branch}
    onChange={(e) => setBranch(e.target.value)}
    placeholder="leave blank to let Claude choose"
    className="w-full border rounded px-3 py-2 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
  />
</label>
```

Update the submit handler to pass the branch:

```tsx
const run = await api.createRun(pid, prompt, branch);
```

- [ ] **Step 3: Manual smoke**

Run: `npm run dev`. Open `/projects/:id/runs/new` — field appears, blank placeholder visible. Open `/projects/:id/runs/new?branch=foo` — field pre-filled with `foo`.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/NewRun.tsx src/web/lib/api.ts
git commit -m "feat(ui): branch input + ?branch= on NewRun"
```

---

### Task 4.7: Follow-up button on RunDetail

**Files:**
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Add the button**

In `src/web/pages/RunDetail.tsx`, inside the existing action-button row (the div around the Cancel/Delete buttons), add this between Cancel and Delete:

```tsx
{run.state !== 'running' && run.state !== 'queued' && run.branch_name && (
  <button
    onClick={() =>
      nav(
        `/projects/${run.project_id}/runs/new?branch=${encodeURIComponent(run.branch_name!)}`
      )
    }
    className="border px-3 py-1 rounded dark:border-gray-600 dark:text-gray-200"
  >
    Follow up
  </button>
)}
```

- [ ] **Step 2: Manual smoke**

Run a quick run end-to-end. After completion, click "Follow up" — expect a new `/runs/new?branch=...` URL and the Branch field pre-filled. Confirm the button is hidden while the run is `running` or `queued`, and when `branch_name` is empty.

- [ ] **Step 3: Commit**

```bash
git add src/web/pages/RunDetail.tsx
git commit -m "feat(ui): follow-up button on RunDetail"
```

---

### Task 4.8: Phase 4 verification

- [ ] **Step 1: Full test suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Manual end-to-end smoke**

With Docker available:
1. Start a run with the Branch field blank; confirm Claude creates its own branch and RunDetail shows that branch name on completion.
2. Start a run with the Branch field set to `experiment`; confirm the branch used is `experiment`.
3. Start a run whose prompt explicitly tries to commit to `main`; confirm the supervisor fallback kicks in, the run still succeeds, and the branch recorded is `claude/run-<id>`.
4. Click Follow up on a completed run; confirm the Branch field pre-fills.

Phase 4 complete.

---

## Closing

- [ ] **Step 1: Update the backlog doc**

Edit `docs/feature-gaps.md`: flip the status of sections A, B, and D P1 lines from `specing` to `shipped`. Check the four P1 `[ ]` boxes. Append to the changelog:

```
- YYYY-MM-DD — P1 pack shipped; branch autonomy, recent prompts, notifications, and resource caps live.
```

- [ ] **Step 2: Final commit**

```bash
git add docs/feature-gaps.md
git commit -m "docs: mark P1 pack shipped"
```

---

## Self-review notes (retained for context)

- Every spec section (§2, §3, §4, §5, §6, §7, §8) maps to tasks:
  - §2 (branch autonomy) → Tasks 4.1–4.7
  - §3 (recent prompts) → Tasks 2.1–2.4
  - §4 (notifications) → Tasks 3.1–3.6
  - §5 (resource caps) → Tasks 1.1–1.7
  - §6 (consolidated changes) → rolled into the phases above
  - §7 (open questions) → Favicon impl addressed in Task 3.4; permission UX in Task 3.4; supervisor in-flight compat handled by the orchestrator's existing recovery path (marks as failed — no cross-version runs in practice); CPU visibility remains out of scope.
  - §8 (suggested order) → this plan's phase order matches.
- Type consistency spot-checks: `FinishInput.branch_name` (§4.3) matches `parseResultJson.branch` (§4.1) and the supervisor's result JSON shape (§4.4). `api.getRecentPrompts` return shape matches `RunsRepo.listRecentPrompts`.
- No "TBD"/"TODO"/"similar to". Every code step has concrete code. Every command has an expected outcome.
