# Safeguard Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current user-branch-plus-origin-mirror model with a host-side bare git repo per run (`/var/lib/agent-manager/runs/<id>/wip.git`) that always captures Claude's committed work, while keeping the user's typed branch as the only thing pushed to origin.

**Architecture:** Each run gets an FBI-internal bare git repo on the host, bind-mounted into the container at `/safeguard` and registered as a second remote. The post-commit hook backgrounds two pushes: one to the safeguard (always succeeds), one to origin (best-effort; result drives `run.mirror_status`). Origin is not polluted with `claude/run-<id>` branches unless the user explicitly types that name. The server reads Ship-tab state directly from the safeguard bare repo via a host-side ref watcher, retiring `GitStateWatcher`-in-container.

**Tech Stack:** Node / TypeScript (server), POSIX sh (container scripts), better-sqlite3, React / Vite (web), Fastify (API), `fs.watch` (host-side ref watch), vitest.

---

## File Structure

**New files (server)**
- `src/server/orchestrator/safeguardWatcher.ts` — host-side `fs.watch` on `<safeguard>/refs/heads/<branch>`; emits `FilesPayload` snapshots by reading the safeguard bare repo with `git`.
- `src/server/orchestrator/safeguardWatcher.test.ts` — unit tests using real bare repos on disk.
- `src/server/orchestrator/safeguardRepo.ts` — read-only helpers over a safeguard bare repo: list commits, read head, compute ahead/behind vs `origin/<base>` in a side workspace, list files in `HEAD`, list head-file numstat.
- `src/server/orchestrator/safeguardRepo.test.ts` — unit tests using real bare repos on disk.

**Modified files (server)**
- `src/shared/types.ts` — widen `MirrorStatus` to include `'local_only'`.
- `src/server/db/schema.sql` — widen `mirror_status` CHECK constraint to also allow `'local_only'`.
- `src/server/db/index.ts` — migration note: the CHECK can't be altered in place on SQLite. Instead, a rebuild is performed when the old narrow CHECK is detected.
- `src/server/db/runs.ts` — no change to the `setMirrorStatus` signature — the type widening in `types.ts` propagates.
- `src/server/api/runs.ts` — in run-create handler: call `orchestrator.wipRepo.init(runId)` eagerly (moved from `launch()`); add a concurrent-branch-409-unless-force check; in `/changes` handler: read commits + head + ahead/behind from `safeguardRepo` instead of from the live container; add `dismissMirrorBanner` endpoint; remove `stop-mirror` endpoint (replaced); remove uses of `orchestrator.getLastFiles`.
- `src/server/orchestrator/index.ts` — drop `GitStateWatcher` usage; wire `SafeguardWatcher`; add `/safeguard` bind-mount; drop `fbi-wip-snapshot.sh` / `fbi-resume-restore.sh` bind-mounts and build references; remove `FBI_BRANCH` fallback to `claude/run-<id>` when user chose something else (already partly there).
- `src/server/orchestrator/supervisor.sh` — drop `MIRROR_BRANCH` block; register `safeguard` remote in place of `fbi-wip`; on resume, fetch from safeguard and `checkout -B`; replace post-commit hook with safeguard+origin dual-push shape; detect no-remote projects and write `mirror_status=local_only`.
- `src/server/orchestrator/finalizeBranch.sh` — drop `fbi-wip-snapshot.sh` invocation; drop `wip_sha` field.
- `src/server/orchestrator/snapshotScripts.ts` — stop copying `fbi-wip-snapshot.sh` and `fbi-resume-restore.sh`.
- `src/server/orchestrator/historyOp.ts` / `fbi-history-op.sh` — on merge / sync / squash-local, fetch `<branch>` from the safeguard into the transient container via a second bind-mount, push to origin from there.
- `package.json` — remove two `cp` entries from `build:server`.

**Deleted files (server)**
- `src/server/orchestrator/fbi-wip-snapshot.sh`
- `src/server/orchestrator/fbi-wip-snapshot.test.ts`
- `src/server/orchestrator/fbi-resume-restore.sh`
- `src/server/orchestrator/fbi-resume-restore.test.ts`
- `src/server/orchestrator/gitStateWatcher.ts`
- `src/server/orchestrator/gitStateWatcher.test.ts`

**Modified files (web)**
- `src/web/features/runs/ship/MirrorStatusBanner.tsx` — handle `local_only` with a muted indicator + no buttons; Dismiss flips a local UI flag via new `useDismissibleBanner` hook-style prop (persisted in `localStorage` keyed by `runId`).
- `src/web/features/runs/ship/MirrorStatusBanner.test.tsx` — new cases for `local_only` and dismiss persistence.
- `src/web/features/runs/ship/ShipTab.tsx` — replace `api.clearRunBaseBranch` call with the local-persistence dismiss; render `MirrorStatusBanner` with the new `local_only` state.
- `src/web/lib/api.ts` — remove `clearRunBaseBranch`.

---

## Task 1 — Widen `MirrorStatus` type + DB check constraint

**Files:**
- Modify: `src/shared/types.ts:12`
- Modify: `src/server/db/schema.sql:50-51`
- Modify: `src/server/db/index.ts:149-160`
- Test: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write the failing DB migration test**

Add to `src/server/db/runs.test.ts` inside `describe('base_branch and mirror_status', ...)` or a new describe block:

```ts
it('accepts local_only as a valid mirror_status', () => {
  const { runs, project_id } = setup();
  const r = runs.create({
    project_id, prompt: 'x',
    log_path_tmpl: (id) => `/tmp/${id}.log`,
  });
  runs.setMirrorStatus(r.id, 'local_only');
  expect(runs.get(r.id)!.mirror_status).toBe('local_only');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/db/runs.test.ts -t "local_only"`
Expected: FAIL with a CHECK-constraint violation from SQLite (`CHECK constraint failed: mirror_status`).

- [ ] **Step 3: Widen the shared type**

Edit `src/shared/types.ts` line 12:

```ts
export type MirrorStatus = 'ok' | 'diverged' | 'local_only' | null;
```

- [ ] **Step 4: Update the schema.sql CHECK constraint**

Edit `src/server/db/schema.sql` lines 50-51:

```sql
  mirror_status TEXT
    CHECK (mirror_status IS NULL OR mirror_status IN ('ok','diverged','local_only')),
```

- [ ] **Step 5: Add the rebuild migration to `src/server/db/index.ts`**

Replace lines 149-160 with:

```ts
  const runsCols = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>)
      .map((r) => r.name)
  );
  if (!runsCols.has('base_branch')) {
    db.exec('ALTER TABLE runs ADD COLUMN base_branch TEXT');
  }
  if (!runsCols.has('mirror_status')) {
    db.exec("ALTER TABLE runs ADD COLUMN mirror_status TEXT");
  }
  // The mirror_status CHECK constraint cannot be altered in place (SQLite
  // ALTER TABLE does not support widening a CHECK). Detect the narrow shape
  // (no 'local_only' allowed) by attempting a write-with-rollback, and do
  // a column rebuild via a temp table if the narrow shape is present.
  try {
    db.exec("BEGIN; UPDATE runs SET mirror_status = 'local_only' WHERE 0; ROLLBACK;");
    const probe = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'",
    ).get() as { sql: string } | undefined;
    if (probe && probe.sql.includes("'ok','diverged')") && !probe.sql.includes('local_only')) {
      db.exec(`BEGIN;
        CREATE TABLE runs_new AS SELECT * FROM runs;
        DROP TABLE runs;
        CREATE TABLE runs (
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
          parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
          kind TEXT NOT NULL DEFAULT 'work'
            CHECK (kind IN ('work','merge-conflict','polish')),
          kind_args_json TEXT,
          base_branch TEXT,
          mirror_status TEXT
            CHECK (mirror_status IS NULL OR mirror_status IN ('ok','diverged','local_only')),
          model TEXT,
          effort TEXT,
          subagent_model TEXT
        );
        INSERT INTO runs SELECT * FROM runs_new;
        DROP TABLE runs_new;
        CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
        CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
        COMMIT;`);
    }
  } catch {
    // If probing fails for an unrelated reason, leave the column as-is; the
    // runtime will surface any actual constraint error.
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/server/db/runs.test.ts -t "local_only"`
Expected: PASS.

- [ ] **Step 7: Typecheck to verify the shared type widening compiles**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/server/db/schema.sql src/server/db/index.ts src/server/db/runs.test.ts
git commit -m "feat(types): add local_only MirrorStatus + widen CHECK via rebuild migration"
```

---

## Task 2 — Provision + delete safeguard bare repo on run lifecycle

**Files:**
- Modify: `src/server/api/runs.ts:190-232` (run-create handler) and `:234-244` (run-delete handler)
- Modify: `src/server/orchestrator/index.ts:317-323` (remove duplicate wipRepo.init in launch)
- Test: `src/server/api/runs.test.ts` (a new test file if none exists — see Step 0 below)

- [ ] **Step 0: Locate run-create test coverage (read-only)**

Run: `ls src/server/api/`
If `runs.test.ts` exists, extend it. Otherwise, create it in Step 1.

- [ ] **Step 1: Write the failing test for eager safeguard init**

Add to `src/server/api/runs.test.ts` (or create a standalone test `src/server/orchestrator/wipRepo.eager.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WipRepo } from '../orchestrator/wipRepo.js';

describe('WipRepo eager init', () => {
  it('creates the bare repo synchronously for a given runId', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
    const repo = new WipRepo(root);
    repo.init(42);
    expect(fs.existsSync(path.join(root, '42', 'wip.git', 'HEAD'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('remove() is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
    const repo = new WipRepo(root);
    repo.init(7);
    repo.remove(7);
    repo.remove(7);
    expect(fs.existsSync(path.join(root, '7'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (WipRepo already exists; tests just pin behavior)**

Run: `npx vitest run src/server/orchestrator/wipRepo.eager.test.ts`
Expected: PASS (because `WipRepo` is already shipped from the prior feature — these tests act as regression pins under the new lifecycle).

- [ ] **Step 3: Move `wipRepo.init()` to run-create in the API handler**

In `src/server/api/runs.ts`, the run-create handler is `app.post('/api/projects/:id/runs', ...)` starting at line 167. Add a `wipRepo` method to the `OrchestratorDep` interface (the orchestrator already exposes `orchestrator.wipRepo`; we thread it through `Deps`). Update the `Deps` / `OrchestratorDep` surface used here:

Replace `OrchestratorDep` interface (lines 33-40) with the addition of:

```ts
interface OrchestratorDep {
  writeStdin(runId: number, bytes: Uint8Array): void;
  getLastFiles(runId: number): FilesPayload | null;
  execInContainer(runId: number, cmd: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  execHistoryOp(runId: number, op: HistoryOp): Promise<ParsedOpResult>;
  spawnSubRun(parentRunId: number, kind: 'merge-conflict' | 'polish', argsJson: string): Promise<number>;
  deleteRun(runId: number): void;
  initSafeguard(runId: number): void;
}
```

In `src/server/index.ts` wiring, add the mapping:

```ts
  orchestrator: {
    writeStdin: (id, b) => orchestrator.writeStdin(id, b),
    getLastFiles: (id) => orchestrator.getLastFiles(id),
    execInContainer: (id, cmd, o) => orchestrator.execInContainer(id, cmd, o),
    execHistoryOp: (id, op) => orchestrator.execHistoryOp(id, op),
    spawnSubRun: (p, k, a) => orchestrator.spawnSubRun(p, k, a),
    deleteRun: (id) => orchestrator.deleteRun(id),
    initSafeguard: (id) => { orchestrator.wipRepo.init(id); },
  },
```

Then in `runs.ts` lines 220-229 (just after setting `effectiveBranch`), insert:

```ts
    // Provision the safeguard bare repo up-front. The run may never launch
    // (draft promotion failure below rolls it back), but having wip.git in
    // place is cheap and lets the /safeguard bind mount be ready synchronously
    // when the container starts.
    deps.orchestrator.initSafeguard(run.id);
```

And update the draft-promotion rollback block (currently at lines 207-216) to also remove the safeguard:

```ts
      } catch (err) {
        // Rollback: delete the run row, uploads, and the safeguard bare repo.
        deps.runs.delete(run.id);
        try {
          fs.rmSync(path.join(deps.runsDir, String(run.id)), { recursive: true, force: true });
        } catch { /* noop */ }
        app.log.error({ err }, 'draft promotion failed');
        return reply.code(422).send({ error: 'promotion_failed' });
      }
```

(The `fs.rmSync` of `<runsDir>/<id>` already covers `wip.git`; no additional call needed.)

- [ ] **Step 4: Remove the duplicate `wipRepo.init(runId)` from `launch()`**

In `src/server/orchestrator/index.ts` at line 323, delete the line:

```ts
    this.wipRepo.init(runId);
```

- [ ] **Step 5: Confirm `deleteRun` already calls `wipRepo.remove`**

Read `src/server/orchestrator/index.ts:957-963`. Confirmed — `deleteRun` already calls `this.wipRepo.remove(runId)` which does `rm -rf`. Keep as-is.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Run the test suite touched**

Run: `npx vitest run src/server/orchestrator/wipRepo.lifecycle.test.ts src/server/orchestrator/wipRepo.eager.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/server/api/runs.ts src/server/orchestrator/index.ts src/server/orchestrator/wipRepo.eager.test.ts src/server/index.ts
git commit -m "refactor(runs): init safeguard bare repo at run-create time"
```

---

## Task 3 — Bind-mount safeguard at `/safeguard` in container

**Files:**
- Modify: `src/server/orchestrator/index.ts:245-300` (container create, HostConfig.Binds) and `:258-267` (env list)
- Modify: `src/server/orchestrator/snapshotScripts.ts`
- Test: `src/server/orchestrator/dockerSocket.flow.test.ts` style — read-only; we add a new focused test

- [ ] **Step 1: Write the failing test for the bind mount shape**

Create `src/server/orchestrator/safeguardBind.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';

// Unit test: assert that a helper function producing the Binds entry
// returns `<runsDir>/<id>/wip.git:/safeguard:rw`.

import { buildSafeguardBind } from './safeguardBind.js';

describe('buildSafeguardBind', () => {
  it('maps a runId to the /safeguard bind-mount entry', () => {
    expect(buildSafeguardBind('/var/lib/agent-manager/runs', 42))
      .toBe('/var/lib/agent-manager/runs/42/wip.git:/safeguard:rw');
  });
  it('respects a host bind-prefix override', () => {
    expect(buildSafeguardBind('/srv/runs', 1, '/host/runs'))
      .toBe('/host/runs/1/wip.git:/safeguard:rw');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/orchestrator/safeguardBind.test.ts`
Expected: FAIL — `Cannot find module './safeguardBind.js'`.

- [ ] **Step 3: Create `src/server/orchestrator/safeguardBind.ts`**

```ts
import path from 'node:path';

/** Computes the docker `Binds` entry for a run's safeguard bare repo.
 *  Maps `<runsDir>/<id>/wip.git` to `/safeguard` inside the container.
 *  When the host daemon sees runs at a different path than the server
 *  process, pass `hostRunsDir` to rewrite the left-hand side. */
export function buildSafeguardBind(
  runsDir: string,
  runId: number,
  hostRunsDir?: string,
): string {
  const base = hostRunsDir ?? runsDir;
  return `${path.join(base, String(runId), 'wip.git')}:/safeguard:rw`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/orchestrator/safeguardBind.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the bind in `createContainerForRun`**

In `src/server/orchestrator/index.ts`, at the top add the import:

```ts
import { buildSafeguardBind } from './safeguardBind.js';
```

Inside `createContainerForRun`, in the `Binds` array (around line 277-295), replace the existing line:

```ts
          `${toBindHost(this.wipRepo.path(runId))}:/fbi-wip.git:rw`,
```

with:

```ts
          buildSafeguardBind(
            this.deps.config.runsDir,
            runId,
            this.deps.config.hostRunsDir,
          ),
```

Delete the two bind-mount lines (wip-snapshot + resume-restore scripts):

```
`${toBindHost(path.join(scriptsDir, 'fbi-wip-snapshot.sh'))}:/usr/local/bin/fbi-wip-snapshot.sh:ro`,
`${toBindHost(path.join(scriptsDir, 'fbi-resume-restore.sh'))}:/usr/local/bin/fbi-resume-restore.sh:ro`,
```

- [ ] **Step 6: Drop script-path constants `WIP_SNAPSHOT` and `RESUME_RESTORE`**

In `src/server/orchestrator/index.ts` lines 49-50, delete:

```ts
const WIP_SNAPSHOT = path.join(HERE, 'fbi-wip-snapshot.sh');
const RESUME_RESTORE = path.join(HERE, 'fbi-resume-restore.sh');
```

Update the call to `snapshotScripts` at line 154:

```ts
    snapshotScripts(dir, SUPERVISOR, FINALIZE_BRANCH, HISTORY_OP);
```

- [ ] **Step 7: Update `snapshotScripts` signature**

Replace `src/server/orchestrator/snapshotScripts.ts` with:

```ts
import fs from 'node:fs';
import path from 'node:path';

// Copies the entrypoint scripts into `destDir`. The copies — not the source
// paths — are what gets bind-mounted into the container, so host edits to
// the sources after this call don't reach the running container. Bash reads
// scripts by byte offset; a live bind that rewrites under a blocked shell
// produces mid-line reads and syntax errors on the next command.
export function snapshotScripts(
  destDir: string,
  srcSupervisor: string,
  srcFinalize: string,
  srcHistoryOp: string,
): void {
  fs.mkdirSync(destDir, { recursive: true });
  const sup = path.join(destDir, 'supervisor.sh');
  const fin = path.join(destDir, 'finalizeBranch.sh');
  const hist = path.join(destDir, 'fbi-history-op.sh');
  fs.copyFileSync(srcSupervisor, sup);
  fs.copyFileSync(srcFinalize, fin);
  fs.copyFileSync(srcHistoryOp, hist);
  fs.chmodSync(sup, 0o755);
  fs.chmodSync(fin, 0o755);
  fs.chmodSync(hist, 0o755);
}
```

- [ ] **Step 8: Update `snapshotScripts.test.ts`**

Read the file first, then adjust: it currently passes five paths. Reduce to three. Example replacement for the existing test:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotScripts } from './snapshotScripts.js';

describe('snapshotScripts', () => {
  it('copies the three scripts into destDir as executable', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-src-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-dst-'));
    const sup = path.join(src, 'supervisor.sh'); fs.writeFileSync(sup, '#!/bin/sh\n');
    const fin = path.join(src, 'finalizeBranch.sh'); fs.writeFileSync(fin, '#!/bin/sh\n');
    const hist = path.join(src, 'fbi-history-op.sh'); fs.writeFileSync(hist, '#!/bin/sh\n');
    snapshotScripts(dst, sup, fin, hist);
    for (const n of ['supervisor.sh', 'finalizeBranch.sh', 'fbi-history-op.sh']) {
      const p = path.join(dst, n);
      expect(fs.existsSync(p)).toBe(true);
      expect((fs.statSync(p).mode & 0o111)).not.toBe(0);
    }
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });
});
```

- [ ] **Step 9: Run tests**

Run: `npx vitest run src/server/orchestrator/safeguardBind.test.ts src/server/orchestrator/snapshotScripts.test.ts`
Expected: all pass.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/server/orchestrator/safeguardBind.ts src/server/orchestrator/safeguardBind.test.ts src/server/orchestrator/snapshotScripts.ts src/server/orchestrator/snapshotScripts.test.ts src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): bind-mount per-run safeguard bare repo at /safeguard"
```

---

## Task 4 — Rewrite `supervisor.sh`: safeguard remote + resume-from-safeguard + new post-commit hook

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh` (entire file)
- Modify: `src/server/orchestrator/supervisor.test.ts`
- Test: `src/server/orchestrator/supervisor.safeguard.test.ts` (new)

- [ ] **Step 1: Write a failing test for the new supervisor behavior (fresh run)**

Create `src/server/orchestrator/supervisor.safeguard.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_SRC = path.join(HERE, 'supervisor.sh');

interface Sandbox { root: string; fbi: string; fbiState: string; ws: string; safe: string; bin: string; tmp: string; script: string; gitLog: string }

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgsup-'));
  const fbi = path.join(root, 'sbx-fbi');
  const fbiState = path.join(root, 'sbx-fbi-state');
  const ws = path.join(root, 'sbx-ws');
  const safe = path.join(root, 'sbx-safe');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmpout');
  const gitLog = path.join(tmp, 'git.log');
  for (const d of [fbi, fbiState, ws, safe, bin, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Git stub: log every invocation, succeed for everything except look up of
  // `safeguard/<branch>` (simulate fresh: the branch does not yet exist on safeguard).
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
echo "$@" >> "${gitLog}"
case "$1" in
  rev-parse)
    for a in "$@"; do case "$a" in origin/*|safeguard/*) exit 1 ;; esac; done
    echo deadbeef; exit 0 ;;
  remote)
    [ "$2" = "get-url" ] && [ "$3" = "origin" ] && { echo git@example:x/y.git; exit 0; }
    exit 0 ;;
  clone|checkout|add|commit|push|config|fetch|init|symbolic-ref) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const finalizeStub = path.join(bin, 'finalize-stub.sh');
  fs.writeFileSync(finalizeStub, `#!/bin/sh
printf '{"exit_code":%d,"push_exit":0,"head_sha":"x","branch":"b"}\\n' "\${CLAUDE_EXIT:-0}" > "\${RESULT_PATH:-/tmp/result.json}"
exit 0
`, { mode: 0o755 });
  const src = fs.readFileSync(SUPERVISOR_SRC, 'utf8');
  const patched = src
    .replace(/\/usr\/local\/bin\/fbi-finalize-branch\.sh/g, finalizeStub)
    .replace(/\/tmp\/prompt\.txt\b/g, path.join(tmp, 'prompt.txt'))
    .replace(/\/tmp\/result\.json\b/g, path.join(tmp, 'result.json'))
    .replace(/\/safeguard\b/g, safe)
    .replace(/\/workspace\b/g, ws)
    .replace(/\/fbi-state\b/g, fbiState)
    .replace(/\/fbi\b/g, fbi);
  const script = path.join(root, 'supervisor.sh');
  fs.writeFileSync(script, patched, { mode: 0o755 });
  return { root, fbi, fbiState, ws, safe, bin, tmp, script, gitLog };
}

function run(sb: Sandbox, env: Record<string, string>) {
  return spawnSync('bash', [sb.script], {
    env: { PATH: `${sb.bin}:${process.env.PATH ?? ''}`, HOME: sb.root,
      RUN_ID: '3', REPO_URL: 'git@example:x/y.git', DEFAULT_BRANCH: 'main',
      GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', ...env },
    encoding: 'utf8',
  });
}

describe('supervisor.sh (safeguard model)', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => { try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* noop */ } });

  it('registers a safeguard remote pointing at /safeguard', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_BRANCH: 'feat/x' });
    expect(res.status).toBe(0);
    const log = fs.readFileSync(sb.gitLog, 'utf8');
    expect(log).toMatch(new RegExp(`remote add safeguard ${sb.safe.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
  });

  it('does NOT push claude/run-<id> to origin when FBI_BRANCH is set to a user branch', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_BRANCH: 'feat/x' });
    expect(res.status).toBe(0);
    const log = fs.readFileSync(sb.gitLog, 'utf8');
    expect(log).not.toMatch(/push .*origin .*claude\/run-3/);
  });

  it('installs a post-commit hook that pushes to safeguard and origin', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_BRANCH: 'feat/x' });
    expect(res.status).toBe(0);
    const hook = fs.readFileSync(path.join(sb.ws, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).toContain('push safeguard');
    expect(hook).toContain('force-with-lease');
    expect(hook).toContain('origin');
  });

  it('resume path fetches branch from safeguard and checkouts -B', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    // Simulate that safeguard has the branch. We re-patch the git stub by
    // setting an env var the stub reads:
    const res = run(sb, { FBI_BRANCH: 'feat/x', FBI_RESUME_SESSION_ID: 'sess-1', FBI_SAFEGUARD_HAS_BRANCH: '1' });
    expect(res.status).toBe(0);
    const log = fs.readFileSync(sb.gitLog, 'utf8');
    expect(log).toMatch(/fetch safeguard feat\/x/);
    expect(log).toMatch(/checkout -B feat\/x safeguard\/feat\/x/);
  });
});
```

Also extend the git stub in makeSandbox to honor `FBI_SAFEGUARD_HAS_BRANCH`:

```sh
  rev-parse)
    if [ -n "${FBI_SAFEGUARD_HAS_BRANCH:-}" ]; then
      for a in "$@"; do case "$a" in safeguard/*) exit 0 ;; esac; done
    fi
    for a in "$@"; do case "$a" in origin/*|safeguard/*) exit 1 ;; esac; done
    echo deadbeef; exit 0 ;;
```

- [ ] **Step 2: Run the new supervisor test to verify it fails**

Run: `npx vitest run src/server/orchestrator/supervisor.safeguard.test.ts`
Expected: FAIL — the current supervisor still uses `fbi-wip` and does not write `remote add safeguard` or the new post-commit hook.

- [ ] **Step 3: Rewrite `src/server/orchestrator/supervisor.sh`**

Replace the full file contents with:

```sh
#!/usr/bin/env bash
# FBI run container entrypoint. Mounted at /usr/local/bin/supervisor.sh.
#
# The agent's only branch is $PRIMARY_BRANCH (the user's typed branch, or
# claude/run-<id> if none was provided). Commits are pushed to:
#   - safeguard  (local bind-mount; always succeeds)
#   - origin     (best-effort; result drives /fbi-state/mirror-status)
#
# Required env vars (set by orchestrator):
#   RUN_ID, REPO_URL, DEFAULT_BRANCH,
#   GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL
# Optional:
#   FBI_BRANCH              user's typed branch (else claude/run-<id>)
#   FBI_MARKETPLACES        newline-separated plugin marketplace sources
#   FBI_PLUGINS             newline-separated plugin specs
#   FBI_RESUME_SESSION_ID   resume an existing session
#   Any project secret, injected as env var.
# Required mounts:
#   /ssh-agent              (host ssh-agent socket, RW)
#   /home/agent/.claude.json (host ~/.claude.json, RW — OAuth)
#   /fbi                    (injected via putArchive: preamble/instructions/global/prompt)
#   /safeguard              (host-side bare git repo for this run)
#   /fbi-state              (host-side dir; hook writes mirror-status here)
#
# Contract: at end, write /tmp/result.json with exit_code, push_exit, head_sha, branch.

set -euo pipefail

export SSH_AUTH_SOCK=/ssh-agent

if [ -n "${FBI_MARKETPLACES:-}" ]; then
    while IFS= read -r mkt; do
        [ -z "$mkt" ] && continue
        echo "[fbi] adding marketplace: $mkt"
        claude plugin marketplace add "$mkt" || echo "[fbi] warn: marketplace add failed: $mkt"
    done <<< "$FBI_MARKETPLACES"
fi
if [ -n "${FBI_PLUGINS:-}" ]; then
    while IFS= read -r plug; do
        [ -z "$plug" ] && continue
        echo "[fbi] installing plugin: $plug"
        claude plugin install "$plug" || echo "[fbi] warn: plugin install failed: $plug"
    done <<< "$FBI_PLUGINS"
fi

cd /workspace

git clone --recurse-submodules "$REPO_URL" . || { echo "clone failed"; exit 10; }

PRIMARY_BRANCH="${FBI_BRANCH:-claude/run-${RUN_ID}}"

# Detect whether the project has an origin remote. No-remote projects are
# supported; only safeguard pushes happen in that case.
HAS_ORIGIN=0
if git remote get-url origin >/dev/null 2>&1; then
    HAS_ORIGIN=1
fi

# Register the safeguard remote. Idempotent.
git remote add safeguard /safeguard 2>/dev/null \
    || git remote set-url safeguard /safeguard \
    || { echo "[fbi] fatal: could not register safeguard remote"; exit 14; }

# Checkout the primary branch. Resume mode prefers safeguard; fresh mode
# prefers origin; both fall back to creating the branch locally.
CHECKED_OUT=0
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    if git fetch --quiet safeguard "$PRIMARY_BRANCH" 2>/dev/null; then
        if git rev-parse --verify --quiet "safeguard/$PRIMARY_BRANCH" >/dev/null 2>&1; then
            git checkout -B "$PRIMARY_BRANCH" "safeguard/$PRIMARY_BRANCH" \
                || { echo "[fbi] fatal: could not restore from safeguard/$PRIMARY_BRANCH"; exit 13; }
            CHECKED_OUT=1
        fi
    fi
fi

if [ "$CHECKED_OUT" = "0" ]; then
    if [ "$HAS_ORIGIN" = "1" ] && git rev-parse --verify --quiet "origin/$PRIMARY_BRANCH" >/dev/null 2>&1; then
        git checkout -B "$PRIMARY_BRANCH" "origin/$PRIMARY_BRANCH" \
            || { echo "[fbi] fatal: could not switch to $PRIMARY_BRANCH"; exit 13; }
    else
        git checkout -b "$PRIMARY_BRANCH" \
            || { echo "[fbi] fatal: could not create branch $PRIMARY_BRANCH"; exit 13; }
        if [ "$HAS_ORIGIN" = "1" ]; then
            git push -u origin "$PRIMARY_BRANCH" \
                || echo "[fbi] warn: initial push of $PRIMARY_BRANCH to origin failed"
        fi
    fi
fi

git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Export HAS_ORIGIN so the hook subshell inherits it.
export HAS_ORIGIN

mkdir -p /fbi-state
# Pre-seed mirror-status for no-remote projects so the UI shows the muted
# indicator even before the first commit.
if [ "$HAS_ORIGIN" = "0" ]; then
    echo local_only > /fbi-state/mirror-status
fi

# Silent post-commit push hook.
#   - safeguard: always push; the hook's core durability guarantee.
#   - origin: only push when HAS_ORIGIN=1. force-with-lease detects external
#     divergence and surfaces it via /fbi-state/mirror-status.
mkdir -p .git/hooks
cat > .git/hooks/post-commit <<'HOOK'
#!/bin/sh
mkdir -p /fbi-state
BRANCH="$(git symbolic-ref --short HEAD)"

# Safeguard push — always runs, always succeeds (local bind).
(
  git push safeguard "HEAD:refs/heads/$BRANCH" > /tmp/last-safeguard-push.log 2>&1 \
    || echo "fatal: safeguard push failed" >&2
) &

# Origin push — best-effort. Skipped entirely when HAS_ORIGIN=0.
if [ "${HAS_ORIGIN:-0}" = "1" ]; then
  (
    if git push --recurse-submodules=on-demand --force-with-lease \
        origin "HEAD:refs/heads/$BRANCH" > /tmp/last-origin-push.log 2>&1; then
      echo ok > /fbi-state/mirror-status
    else
      echo diverged > /fbi-state/mirror-status
    fi
  ) &
else
  echo local_only > /fbi-state/mirror-status
fi
HOOK
chmod +x .git/hooks/post-commit

# Run the agent. Two modes:
#   fresh: compose /tmp/prompt.txt from /fbi/*.txt and stdin-pipe into claude.
#   resume: use $FBI_RESUME_SESSION_ID to continue an existing session.
set +e
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    echo "[fbi] resuming claude session $FBI_RESUME_SESSION_ID"
    touch /fbi-state/waiting
    claude --resume "$FBI_RESUME_SESSION_ID" --dangerously-skip-permissions
    CLAUDE_EXIT=$?
else
    : > /tmp/prompt.txt
    for section in preamble.txt global.txt instructions.txt; do
        if [ -s "/fbi/$section" ]; then
            cat "/fbi/$section" >> /tmp/prompt.txt
            printf '\n\n---\n\n' >> /tmp/prompt.txt
        fi
    done
    [ -f /fbi/prompt.txt ] || { echo "prompt.txt not found in /fbi"; exit 12; }
    cat /fbi/prompt.txt >> /tmp/prompt.txt
    touch /fbi-state/prompted
    claude --dangerously-skip-permissions < /tmp/prompt.txt
    CLAUDE_EXIT=$?
fi
set -e

CLAUDE_EXIT="$CLAUDE_EXIT" RESULT_PATH=/tmp/result.json \
    /usr/local/bin/fbi-finalize-branch.sh

exit $CLAUDE_EXIT
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run src/server/orchestrator/supervisor.safeguard.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the existing `supervisor.test.ts` to match the new model**

Edit `src/server/orchestrator/supervisor.test.ts` lines 90-145:
- Remove the `resumeStub` + the `fbi-resume-restore.sh` rewrite (`replace(/\/usr\/local\/bin\/fbi-resume-restore\.sh/g, resumeStub)`).
- Remove the `snapshotStub` + the `fbi-wip-snapshot.sh` rewrite.
- Add a `/safeguard\b` rewrite so the script's safeguard paths land in the sandbox: after the `workspace` rewrite add:

```ts
    .replace(/\/safeguard\b/g, safeguard)
```

and add `safeguard` to the Sandbox and `makeSandbox` (create and mkdir it same pattern as `workspace`).

Delete the three tests that reference `FBI_CHECKOUT_BRANCH` — supervisor.sh under the new model uses `FBI_BRANCH`, not `FBI_CHECKOUT_BRANCH`, and the behavior is now "checkout primary" not "checkout base then create claude/run-N". Replace with one test verifying that the primary branch is checked out:

```ts
  it('checks out the primary branch (FBI_BRANCH) from origin when it exists there', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_BRANCH: 'feat/x' });
    expect(res.status).toBe(0);
    const checkouts = fs.readFileSync(path.join(sb.tmpOut, 'checkouts.log'), 'utf8').trim().split('\n');
    expect(checkouts.some((l) => l.includes('feat/x'))).toBe(true);
  });
```

The exact shape of `checkouts.log` parsing depends on the stub; adapt the assertion to what the stub logs for `checkout -B feat/x origin/feat/x`.

- [ ] **Step 6: Run the full supervisor test group**

Run: `npx vitest run src/server/orchestrator/supervisor`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/orchestrator/supervisor.sh src/server/orchestrator/supervisor.safeguard.test.ts src/server/orchestrator/supervisor.test.ts
git commit -m "feat(orchestrator): supervisor.sh uses safeguard remote + safeguard-aware resume"
```

---

## Task 5 — Delete dead scripts + update build + `finalizeBranch.sh`

**Files:**
- Delete: `src/server/orchestrator/fbi-wip-snapshot.sh`
- Delete: `src/server/orchestrator/fbi-wip-snapshot.test.ts`
- Delete: `src/server/orchestrator/fbi-resume-restore.sh`
- Delete: `src/server/orchestrator/fbi-resume-restore.test.ts`
- Modify: `src/server/orchestrator/finalizeBranch.sh:24-53`
- Modify: `src/server/orchestrator/finalizeBranch.test.ts`
- Modify: `package.json:8`

- [ ] **Step 1: Delete the four files**

```bash
git rm src/server/orchestrator/fbi-wip-snapshot.sh \
       src/server/orchestrator/fbi-wip-snapshot.test.ts \
       src/server/orchestrator/fbi-resume-restore.sh \
       src/server/orchestrator/fbi-resume-restore.test.ts
```

- [ ] **Step 2: Update `finalizeBranch.sh` — drop snapshot invocation and wip_sha**

Replace the file contents with:

```sh
#!/usr/bin/env bash
# Decides whether to push / which branch to push at the end of an FBI run.
#
# Under the safeguard model the post-commit hook already pushes to safeguard
# and origin on every commit, so this script no longer manages pushes — it
# reports the already-observed push status for result.json. Kept as a
# separate file so it can be tested against git fixtures.
#
# Required env:
#   DEFAULT_BRANCH   name of the project's default branch (e.g. "main")
#   RUN_ID           numeric run id (logged only)
#   CLAUDE_EXIT      exit code of the claude process
#   RESULT_PATH      path to write the result JSON to

set -euo pipefail

: "${DEFAULT_BRANCH:?DEFAULT_BRANCH required}"
: "${RUN_ID:?RUN_ID required}"
: "${CLAUDE_EXIT:?CLAUDE_EXIT required}"
: "${RESULT_PATH:?RESULT_PATH required}"

git fetch --quiet origin "$DEFAULT_BRANCH" 2>/dev/null || true

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"

# Push exit is sourced from the last origin-push log (written by the post-
# commit hook). No-remote projects write no log; treat absent log as success.
PUSH_EXIT=0
if [ -f /tmp/last-origin-push.log ]; then
    if grep -qE '^!|rejected|error:' /tmp/last-origin-push.log 2>/dev/null; then
        PUSH_EXIT=1
    fi
fi

printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s","branch":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" "$CURRENT_BRANCH" > "$RESULT_PATH"
```

- [ ] **Step 3: Update `finalizeBranch.test.ts`**

Read the file at `src/server/orchestrator/finalizeBranch.test.ts` and remove any assertions about `wip_sha`, and any setup that populates `/tmp/last-snapshot.log` or pipes `last-push.log`. Replace `last-push.log` references with `last-origin-push.log` to match the new hook output-file name.

- [ ] **Step 4: Trim `build:server` in `package.json`**

Edit line 8 of `package.json` — remove the two `cp` entries for `fbi-wip-snapshot.sh` and `fbi-resume-restore.sh`. New value:

```json
    "build:server": "tsc -p tsconfig.server.json && cp src/server/db/schema.sql dist/server/db/schema.sql && cp src/server/orchestrator/supervisor.sh dist/server/orchestrator/supervisor.sh && cp src/server/orchestrator/finalizeBranch.sh dist/server/orchestrator/finalizeBranch.sh && cp src/server/orchestrator/fbi-history-op.sh dist/server/orchestrator/fbi-history-op.sh && cp src/server/orchestrator/Dockerfile.tmpl dist/server/orchestrator/Dockerfile.tmpl && cp src/server/orchestrator/postbuild.sh dist/server/orchestrator/postbuild.sh",
```

- [ ] **Step 5: Verify build still succeeds (produces no missing-file errors)**

Run: `npm run build:server`
Expected: exit 0.

- [ ] **Step 6: Run the finalize branch tests**

Run: `npx vitest run src/server/orchestrator/finalizeBranch`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(orchestrator): delete fbi-wip-snapshot/resume-restore; update finalize + build"
```

---

## Task 6 — Host-side safeguard watcher (replaces `GitStateWatcher`)

**Files:**
- Create: `src/server/orchestrator/safeguardRepo.ts`
- Create: `src/server/orchestrator/safeguardRepo.test.ts`
- Create: `src/server/orchestrator/safeguardWatcher.ts`
- Create: `src/server/orchestrator/safeguardWatcher.test.ts`
- Delete: `src/server/orchestrator/gitStateWatcher.ts`
- Delete: `src/server/orchestrator/gitStateWatcher.test.ts`
- Modify: `src/server/orchestrator/index.ts` (launch / resume / reattach)

- [ ] **Step 1: Write the failing test for `safeguardRepo`**

Create `src/server/orchestrator/safeguardRepo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeguardRepo } from './safeguardRepo.js';

function makeBareWithCommit(root: string): { bare: string; sha: string } {
  const bare = path.join(root, 'wip.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch', 'feat/x', bare]);
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--initial-branch', 'feat/x', work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'hi\n');
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'first']);
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', work, 'push', 'origin', 'feat/x']);
  const sha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { bare, sha };
}

describe('SafeguardRepo', () => {
  it('head() returns sha+subject for a branch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-'));
    const { bare, sha } = makeBareWithCommit(root);
    const r = new SafeguardRepo(bare);
    expect(r.head('feat/x')).toEqual({ sha, subject: 'first' });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('listCommits() returns the commits from base to head', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-'));
    const { bare } = makeBareWithCommit(root);
    const r = new SafeguardRepo(bare);
    const commits = r.listCommits('feat/x', '0000000000000000000000000000000000000000');
    expect(commits.length).toBe(1);
    expect(commits[0].subject).toBe('first');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refExists() is false for an unknown branch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-'));
    const { bare } = makeBareWithCommit(root);
    const r = new SafeguardRepo(bare);
    expect(r.refExists('nope/x')).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/orchestrator/safeguardRepo.test.ts`
Expected: FAIL — `Cannot find module './safeguardRepo.js'`.

- [ ] **Step 3: Implement `SafeguardRepo`**

Create `src/server/orchestrator/safeguardRepo.ts`:

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeCommit, FilesHeadEntry } from '../../shared/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function gitOpt(cwd: string, ...args: string[]): string | null {
  try { return git(cwd, ...args); } catch { return null; }
}

export class SafeguardRepo {
  constructor(private readonly bareDir: string) {}

  exists(): boolean {
    return fs.existsSync(path.join(this.bareDir, 'HEAD'));
  }

  refPath(branch: string): string {
    return path.join(this.bareDir, 'refs', 'heads', branch);
  }

  refExists(branch: string): boolean {
    if (!this.exists()) return false;
    const out = gitOpt(this.bareDir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
    return !!(out && out.trim().length > 0);
  }

  head(branch: string): { sha: string; subject: string } | null {
    if (!this.refExists(branch)) return null;
    const raw = gitOpt(this.bareDir, 'log', '-1', '--format=%H%x00%s', `refs/heads/${branch}`);
    if (!raw) return null;
    const nul = raw.indexOf('\0');
    if (nul < 0) return null;
    return { sha: raw.slice(0, nul), subject: raw.slice(nul + 1).replace(/\n+$/, '') };
  }

  /** Commits reachable from `branch` but not from `baseSha`, newest-first. */
  listCommits(branch: string, baseSha: string): ChangeCommit[] {
    if (!this.refExists(branch)) return [];
    const spec = /^[0-9a-f]{40}$/.test(baseSha)
      ? `${baseSha}..refs/heads/${branch}`
      : `refs/heads/${branch}`;
    const raw = gitOpt(this.bareDir, 'log', '--format=%H%x00%s%x00%ct', spec);
    if (!raw) return [];
    const commits: ChangeCommit[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [sha, subject, tsStr] = line.split('\0');
      if (!sha) continue;
      const committed_at = Number.parseInt(tsStr ?? '0', 10) || 0;
      commits.push({
        sha, subject: subject ?? '', committed_at, pushed: false,
        files: [], files_loaded: false, submodule_bumps: [],
      });
    }
    return commits;
  }

  headFiles(branch: string): FilesHeadEntry[] {
    if (!this.refExists(branch)) return [];
    const raw = gitOpt(this.bareDir, 'show', '--numstat', '--format=', `refs/heads/${branch}`);
    if (!raw) return [];
    const out: FilesHeadEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [a, d, p] = line.split('\t');
      if (!p) continue;
      const adds = a === '-' ? 0 : Number.parseInt(a, 10) || 0;
      const dels = d === '-' ? 0 : Number.parseInt(d, 10) || 0;
      const status: 'A' | 'M' = dels === 0 && adds > 0 ? 'A' : 'M';
      out.push({ path: p, status, additions: adds, deletions: dels });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/orchestrator/safeguardRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `SafeguardWatcher`**

Create `src/server/orchestrator/safeguardWatcher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeguardWatcher } from './safeguardWatcher.js';

function makeBare(root: string, branch: string): string {
  const bare = path.join(root, 'wip.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch', branch, bare]);
  return bare;
}

describe('SafeguardWatcher', () => {
  it('emits a snapshot on ref change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sgw-'));
    const bare = makeBare(root, 'feat/x');
    // Seed a ref by pushing from a working clone.
    const work = path.join(root, 'work');
    execFileSync('git', ['clone', bare, work]);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a'), '1');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'first']);
    const emitted: Array<{ sha: string }> = [];
    const w = new SafeguardWatcher({
      bareDir: bare, branch: 'feat/x',
      onSnapshot: (snap) => { emitted.push({ sha: snap.head?.sha ?? '' }); },
    });
    await w.start();
    execFileSync('git', ['-C', work, 'push', 'origin', 'feat/x']);
    await new Promise((r) => setTimeout(r, 250));
    await w.stop();
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[emitted.length - 1].sha).toMatch(/^[0-9a-f]{40}$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/server/orchestrator/safeguardWatcher.test.ts`
Expected: FAIL — `Cannot find module './safeguardWatcher.js'`.

- [ ] **Step 7: Implement `SafeguardWatcher`**

Create `src/server/orchestrator/safeguardWatcher.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { SafeguardRepo } from './safeguardRepo.js';
import type { FilesPayload } from '../../shared/types.js';

export interface SafeguardWatcherOptions {
  bareDir: string;
  branch: string;
  onSnapshot: (s: FilesPayload) => void;
  onError?: (reason: string) => void;
}

export class SafeguardWatcher {
  private watcher: fs.FSWatcher | null = null;
  private packedWatcher: fs.FSWatcher | null = null;
  private readonly repo: SafeguardRepo;
  private lastSha: string | null = null;
  private started = false;

  constructor(private readonly opts: SafeguardWatcherOptions) {
    this.repo = new SafeguardRepo(opts.bareDir);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.emit();  // initial snapshot so a listener sees the current state
    const refDir = path.join(this.opts.bareDir, 'refs', 'heads');
    fs.mkdirSync(refDir, { recursive: true });
    try {
      this.watcher = fs.watch(refDir, { recursive: false }, () => {
        // Fire on any change in refs/heads — we don't trust filenames to be
        // present across editor/mv operations git may perform.
        void this.emit();
      });
    } catch (e) {
      this.opts.onError?.(String(e));
    }
    // packed-refs: git may prune loose refs into packed-refs; watch that file
    // too so we don't miss an update that lands only there.
    const packedPath = path.join(this.opts.bareDir, 'packed-refs');
    try {
      this.packedWatcher = fs.watch(path.dirname(packedPath), (_ev, fn) => {
        if (fn === 'packed-refs') void this.emit();
      });
    } catch (e) {
      this.opts.onError?.(String(e));
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.watcher?.close(); this.watcher = null;
    this.packedWatcher?.close(); this.packedWatcher = null;
  }

  private async emit(): Promise<void> {
    const head = this.repo.head(this.opts.branch);
    const sha = head?.sha ?? null;
    if (sha === this.lastSha) return;
    this.lastSha = sha;
    const headFiles = this.repo.headFiles(this.opts.branch);
    const payload: FilesPayload = {
      dirty: [],  // under scope A we don't surface uncommitted
      head,
      headFiles,
      branchBase: null,  // caller computes ahead/behind from safeguard
      live: false,
      dirty_submodules: [],
    };
    this.opts.onSnapshot(payload);
  }
}
```

- [ ] **Step 8: Run the watcher test to verify it passes**

Run: `npx vitest run src/server/orchestrator/safeguardWatcher.test.ts`
Expected: PASS.

- [ ] **Step 9: Wire the watcher into `Orchestrator.launch()`, `resume()`, and `reattach()`**

In `src/server/orchestrator/index.ts`:

- Remove the import of `GitStateWatcher` (line 35).
- Add:

```ts
import { SafeguardWatcher } from './safeguardWatcher.js';
```

- In `launch()` (around line 347), replace the `gitWatcher` block with:

```ts
    let safeguardWatcher: SafeguardWatcher | null = null;
```

and later (around line 412):

```ts
      safeguardWatcher = new SafeguardWatcher({
        bareDir: this.wipRepo.path(runId),
        branch: run.branch_name || `claude/run-${runId}`,
        onSnapshot: (snap) => {
          this.lastFiles.set(runId, snap);
          const runNow = this.deps.runs.get(runId);
          events.publish({
            type: 'changes',
            branch_name: runNow?.branch_name || null,
            branch_base: null,
            commits: [],
            uncommitted: [],
            integrations: {},
            dirty_submodules: [],
            children: [],
          });
        },
      });
      await safeguardWatcher.start();
```

And in the `finally` at ~line 450-455:

```ts
      if (safeguardWatcher) await safeguardWatcher.stop();
```

- Do the symmetric replacement in `reattach()` around lines 1074-1097: `GitStateWatcher` → `SafeguardWatcher`.

- Remove `mirror_status`-from-snapshot logic entirely — the status now comes from `/fbi-state/mirror-status` via a new polling path. For now (simplest correct behavior) poll `/fbi-state/mirror-status` in the same watcher start-up: add a small file-based `MirrorStatusPoller` next to `SafeguardWatcher`:

Create `src/server/orchestrator/mirrorStatusPoller.ts`:

```ts
import fs from 'node:fs';
import { parseMirrorStatus } from './mirrorStatus.js';
import type { MirrorStatus } from '../../shared/types.js';

export interface MirrorStatusPollerOptions {
  path: string;
  pollMs?: number;
  onChange: (s: MirrorStatus) => void;
}

export class MirrorStatusPoller {
  private timer: NodeJS.Timeout | null = null;
  private last: MirrorStatus = null;

  constructor(private opts: MirrorStatusPollerOptions) {}

  start(): void {
    const tick = (): void => {
      let raw = '';
      try { raw = fs.readFileSync(this.opts.path, 'utf8'); } catch { /* absent */ }
      const cur = parseMirrorStatus(raw);
      if (cur !== this.last) {
        this.last = cur;
        this.opts.onChange(cur);
      }
      this.timer = setTimeout(tick, this.opts.pollMs ?? 1000);
    };
    tick();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
```

Widen `parseMirrorStatus` in `src/server/orchestrator/mirrorStatus.ts` to accept `local_only`:

```ts
import type { MirrorStatus } from '../../shared/types.js';

export function parseMirrorStatus(raw: string): MirrorStatus {
  const t = raw.trim();
  if (t === 'ok') return 'ok';
  if (t === 'diverged') return 'diverged';
  if (t === 'local_only') return 'local_only';
  return null;
}
```

In `launch()`, add:

```ts
      const mirrorPoller = new MirrorStatusPoller({
        path: `${this.stateDirFor(runId)}/mirror-status`,
        pollMs: 1000,
        onChange: (s) => {
          if (s !== undefined && s !== this.deps.runs.get(runId)?.mirror_status) {
            this.deps.runs.setMirrorStatus(runId, s);
          }
        },
      });
      mirrorPoller.start();
```

and in finally: `mirrorPoller.stop();` (scope the variable accordingly).

- [ ] **Step 10: Delete `gitStateWatcher.ts` and its tests**

```bash
git rm src/server/orchestrator/gitStateWatcher.ts src/server/orchestrator/gitStateWatcher.test.ts
```

The parser functions `parseGitState` and `parseSubmoduleStatus` are not imported elsewhere under the new model. Confirm with:

Run: `grep -rn "parseGitState\|parseSubmoduleStatus\|GitStateWatcher" src/ | grep -v safeguard`
Expected: no matches outside the (already-deleted) file.

- [ ] **Step 11: Update `mirrorStatus.test.ts`**

Read `src/server/orchestrator/mirrorStatus.test.ts` and add a case:

```ts
it('parses local_only', () => {
  expect(parseMirrorStatus('local_only')).toBe('local_only');
});
```

- [ ] **Step 12: Typecheck + full test sweep for orchestrator**

```bash
npm run typecheck
npx vitest run src/server/orchestrator/
```

Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): host-side SafeguardWatcher + MirrorStatusPoller replace in-container GitStateWatcher"
```

---

## Task 7 — `/changes` endpoint reads from safeguard

**Files:**
- Modify: `src/server/api/runs.ts:326-448` (the `/api/runs/:id/changes` handler)
- Test: `src/server/api/runs.changes.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/server/api/runs.changes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
// Existing server test harness pattern — import the setup from an existing
// runs.*.test.ts. If none exists, write an in-memory setup:
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('/api/runs/:id/changes', () => {
  it('returns commits from the safeguard bare repo when the live container is gone', async () => {
    // Arrange: create a bare, seed with a commit, wire a minimal RunsRepo
    // stub that returns a run with branch_name='feat/x' and no container.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chg-'));
    const bare = path.join(root, '1', 'wip.git');
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '--bare', '--initial-branch', 'feat/x', bare]);
    const work = path.join(root, 'w');
    execFileSync('git', ['clone', bare, work]);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a'), 'x');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'feat: hello']);
    execFileSync('git', ['-C', work, 'push', 'origin', 'feat/x']);

    // The concrete assertion is the essential contract — see Step 3 for
    // the route wiring via registerRunsRoutes.
    // Minimal in-memory setup:
    const app = Fastify();
    const runs = {
      get: (id: number) => id === 1
        ? { id: 1, project_id: 1, state: 'succeeded', branch_name: 'feat/x',
            mirror_status: null, base_branch: null } as any
        : undefined,
      listByParent: () => [],
      setBranchName: () => {},
    };
    const projects = { get: () => ({ id: 1, default_branch: 'main', repo_url: 'git@example:x/y.git' }) };
    const gh = { available: async () => false, prForBranch: async () => null, prChecks: async () => [], commitsOnBranch: async () => [], compareFiles: async () => [] };
    // Pull in registerRunsRoutes from the real module with a safeguardRepo dep.
    const mod = await import('./runs.js');
    mod.registerRunsRoutes(app as any, {
      runs: runs as any, projects: projects as any, gh: gh as any,
      streams: { getOrCreateEvents: () => ({ publish: () => {} }) } as any,
      runsDir: root, draftUploadsDir: root,
      launch: async () => {}, cancel: async () => {}, fireResumeNow: () => {},
      continueRun: async () => {}, markStartingForContinueRequest: () => {},
      orchestrator: {
        writeStdin: () => {}, getLastFiles: () => null,
        execInContainer: async () => ({ stdout: '', stderr: '', exitCode: 127 }),
        execHistoryOp: async () => ({ kind: 'gh-error', message: '' }),
        spawnSubRun: async () => 0, deleteRun: () => {}, initSafeguard: () => {},
      } as any,
      wipRepo: { exists: () => true, snapshotSha: () => null, parentSha: () => null,
        readSnapshotFiles: () => [], readSnapshotDiff: () => ({ path: '', ref: 'wip', hunks: [], truncated: false }),
        readSnapshotPatch: () => '', deleteWipRef: () => {},
      } as any,
    });

    const res = await app.inject({ method: 'GET', url: '/api/runs/1/changes' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.commits.length).toBe(1);
    expect(body.commits[0].subject).toBe('feat: hello');
    expect(body.commits[0].pushed).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/api/runs.changes.test.ts`
Expected: FAIL — handler currently expects `execInContainer` to work, returns 0 commits when container is gone.

- [ ] **Step 3: Wire `SafeguardRepo` into `registerRunsRoutes`**

In `src/server/api/runs.ts`:

- Add import at top:

```ts
import { SafeguardRepo } from '../orchestrator/safeguardRepo.js';
import path from 'node:path';
```

(`path` is already imported.)

- Replace the commit-population block in the `/changes` handler (around lines 354-417). The new shape:

```ts
    const commits: ChangeCommit[] = [];
    let ghPayload: ChangesPayload['integrations']['github'] | undefined;

    // Read commits from the safeguard bare repo. These are not-yet-pushed
    // from GitHub's POV until we hear back from gh; we set pushed=false for
    // everything from the safeguard and flip to true for those gh reports.
    const safeguard = new SafeguardRepo(path.join(deps.runsDir, String(runId), 'wip.git'));
    const safeguardCommits = run.branch_name ? safeguard.listCommits(run.branch_name, '') : [];

    if (repo && ghAvail && run.branch_name) {
      const [pr, checks, ghCommits] = await Promise.all([
        deps.gh.prForBranch(repo, run.branch_name).catch(() => null),
        deps.gh.prChecks(repo, run.branch_name).catch(() => [] as Check[]),
        deps.gh.commitsOnBranch(repo, run.branch_name).catch(() => []),
      ]);
      const ghShas = new Set(ghCommits.map((c) => c.sha));
      for (const c of ghCommits) {
        commits.push({
          sha: c.sha, subject: c.subject, committed_at: c.committed_at,
          pushed: true, files: [], files_loaded: false, submodule_bumps: [],
        });
      }
      // Add safeguard commits that GH hasn't reported yet (local-only).
      for (const c of safeguardCommits) {
        if (!ghShas.has(c.sha)) commits.push(c);
      }
      const passed = checks.filter((c) => c.conclusion === 'success').length;
      const failed = checks.filter((c) => c.conclusion === 'failure').length;
      const total = checks.length;
      const state = total === 0 ? null
        : failed > 0 ? 'failure'
        : checks.every((c) => c.status === 'completed') ? 'success'
        : 'pending';
      ghPayload = {
        pr: pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null,
        checks: total === 0 || state === null ? null : {
          state, passed, failed, total,
          items: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, duration_ms: null })),
        },
      };
    } else {
      // No gh / no repo: safeguard is the sole source.
      for (const c of safeguardCommits) commits.push(c);
    }
```

Replace the block that populates `submodule_bumps` via `execInContainer` at lines 396-418 with an empty-array default:

```ts
    // Submodule bumps: under the safeguard model this data is not surfaced in
    // the real-time path (container may be gone; reading from safeguard would
    // require submodule objects we don't store there). Ship with empty arrays.
    for (const c of commits) c.submodule_bumps = [];
```

Replace the `uncommitted` field in the final payload with `[]`:

```ts
    const payload: ChangesPayload = {
      branch_name: run.branch_name || null,
      branch_base: null,  // recomputed below when we have a head sha
      commits,
      uncommitted: [],  // scope A — we don't surface uncommitted in the UI
      integrations: ghPayload ? { github: ghPayload } : {},
      dirty_submodules: [],
      children,
    };
```

Remove the `const live = deps.orchestrator.getLastFiles(runId);` line (around line 351) and any remaining `live?.…` reads in this handler.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/api/runs.changes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/api/runs.ts src/server/api/runs.changes.test.ts
git commit -m "feat(api): /changes reads commits from the safeguard bare repo"
```

---

## Task 8 — Concurrent-branch check at run-create

**Files:**
- Modify: `src/server/db/runs.ts` (add `listActiveByBranch` method)
- Modify: `src/server/api/runs.ts:167-232` (run-create handler)
- Test: `src/server/api/runs.concurrent.test.ts` (new)
- Test: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write a failing DB test for `listActiveByBranch`**

Add to `src/server/db/runs.test.ts`:

```ts
describe('listActiveByBranch', () => {
  it('returns non-terminal runs matching the branch', () => {
    const { runs, project_id } = setup();
    const a = runs.create({ project_id, prompt: 'a', log_path_tmpl: (i) => `/tmp/${i}.log` });
    runs.setBranchName(a.id, 'feat/x');
    // Force into a non-terminal state (running).
    runs.markStartingFromQueued(a.id, 'c1');
    runs.markRunning(a.id);
    const b = runs.create({ project_id, prompt: 'b', log_path_tmpl: (i) => `/tmp/${i}.log` });
    runs.setBranchName(b.id, 'feat/x');
    runs.markStartingFromQueued(b.id, 'c2');
    runs.markFinished(b.id, { state: 'succeeded' });
    const matches = runs.listActiveByBranch(project_id, 'feat/x');
    expect(matches.map((r) => r.id)).toEqual([a.id]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/server/db/runs.test.ts -t "listActiveByBranch"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement `listActiveByBranch`**

Add to `src/server/db/runs.ts` (before the closing `}` of the class):

```ts
  listActiveByBranch(projectId: number, branchName: string): Run[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
          WHERE project_id = ? AND branch_name = ?
            AND state NOT IN ('succeeded','failed','cancelled','resume_failed')
          ORDER BY id DESC`
      )
      .all(projectId, branchName) as Run[];
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/db/runs.test.ts -t "listActiveByBranch"`
Expected: PASS.

- [ ] **Step 5: Write failing test for the 409 response**

Create `src/server/api/runs.concurrent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

describe('POST /api/projects/:id/runs — concurrent-branch guard', () => {
  it('returns 409 when a non-terminal run already holds the branch; 201 with { force: true }', async () => {
    const app = Fastify();
    const active = [{ id: 5, state: 'running', branch_name: 'feat/x' } as any];
    const runs = {
      create: () => ({ id: 99, project_id: 1, state: 'queued', branch_name: '' }),
      listActiveByBranch: (_p: number, b: string) => (b === 'feat/x' ? active : []),
      setBranchName: () => {},
      setBaseBranch: () => {},
      delete: () => {},
      get: () => ({ id: 99, project_id: 1, state: 'queued', branch_name: 'feat/x' } as any),
    };
    const projects = { get: () => ({ id: 1, default_branch: 'main' }) };
    const mod = await import('./runs.js');
    mod.registerRunsRoutes(app as any, {
      runs: runs as any, projects: projects as any,
      gh: { available: async () => false } as any,
      streams: { getOrCreateEvents: () => ({ publish: () => {} }) } as any,
      runsDir: '/tmp/x', draftUploadsDir: '/tmp/x',
      launch: async () => {}, cancel: async () => {}, fireResumeNow: () => {},
      continueRun: async () => {}, markStartingForContinueRequest: () => {},
      orchestrator: {
        writeStdin: () => {}, getLastFiles: () => null,
        execInContainer: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        execHistoryOp: async () => ({ kind: 'complete', sha: '' }),
        spawnSubRun: async () => 0, deleteRun: () => {}, initSafeguard: () => {},
      } as any,
      wipRepo: {} as any,
    });
    const r1 = await app.inject({ method: 'POST', url: '/api/projects/1/runs',
      payload: { prompt: 'p', branch: 'feat/x' } });
    expect(r1.statusCode).toBe(409);
    expect(r1.json()).toMatchObject({ error: 'branch_in_use' });
    const r2 = await app.inject({ method: 'POST', url: '/api/projects/1/runs',
      payload: { prompt: 'p', branch: 'feat/x', force: true } });
    expect(r2.statusCode).toBe(201);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/server/api/runs.concurrent.test.ts`
Expected: FAIL — no 409 branch exists yet.

- [ ] **Step 7: Extend the `Deps` type**

In `src/server/api/runs.ts`, widen the `runs` dep shape with `listActiveByBranch` by adding to the existing `Deps` interface (line 52-66):

The existing field uses `runs: RunsRepo;` (the full repo) — the new method is part of the repo, so nothing to add here at the type level. Just use it.

- [ ] **Step 8: Implement the guard in `app.post('/api/projects/:id/runs', ...)`**

In `src/server/api/runs.ts` at the top of the run-create handler, before `deps.runs.create` (line 190), insert:

```ts
    const projectId = Number(id);
    const force = (body as { force?: unknown }).force === true;
    if (hint !== '' && !force) {
      const active = deps.runs.listActiveByBranch(projectId, hint);
      if (active.length > 0) {
        return reply.code(409).send({
          error: 'branch_in_use',
          active_run_id: active[0].id,
          message: `Run #${active[0].id} is already using branch "${hint}". Pass { force: true } to start another run on the same branch anyway.`,
        });
      }
    }
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run src/server/api/runs.concurrent.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/server/db/runs.ts src/server/db/runs.test.ts src/server/api/runs.ts src/server/api/runs.concurrent.test.ts
git commit -m "feat(api): 409 on run create when another active run holds the branch (force=true override)"
```

---

## Task 9 — `dismissMirrorBanner` + `MirrorStatusBanner` UI handles `local_only`

**Files:**
- Modify: `src/server/api/runs.ts` (remove `/stop-mirror`; no replacement endpoint — dismissal is client-side)
- Modify: `src/web/lib/api.ts:283-286` (remove `clearRunBaseBranch`)
- Modify: `src/web/features/runs/ship/MirrorStatusBanner.tsx`
- Modify: `src/web/features/runs/ship/MirrorStatusBanner.test.tsx`
- Modify: `src/web/features/runs/ship/ShipTab.tsx`
- Modify: `src/web/features/runs/ship/ShipTab.test.tsx`

Dismissal design choice: **client-side localStorage, keyed by run+current-head-sha**. Rationale: the spec says dismissal is about silencing the banner for this run without touching server state. Keying on `run + current head sha` makes the dismissal auto-expire when the next commit lands — matching the spec's "subsequent successful push auto-clears" behavior. No DB migration needed; no server round-trip.

- [ ] **Step 1: Write the failing test for `MirrorStatusBanner` local_only rendering**

Replace `src/web/features/runs/ship/MirrorStatusBanner.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MirrorStatusBanner } from './MirrorStatusBanner.js';

describe('MirrorStatusBanner', () => {
  beforeEach(() => { localStorage.clear(); });

  it('renders nothing when status is "ok"', () => {
    const { container } = render(
      <MirrorStatusBanner status="ok" branch="feat/x" runId={1} headSha="abc" onRebase={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders diverged state with Sync and Dismiss actions', () => {
    const onRebase = vi.fn();
    render(<MirrorStatusBanner status="diverged" branch="feat/x" runId={1} headSha="abc" onRebase={onRebase} />);
    expect(screen.getByText(/diverged on origin/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /sync/i }));
    expect(onRebase).toHaveBeenCalled();
  });

  it('Dismiss hides the banner until the head sha changes', () => {
    const { rerender, container } = render(
      <MirrorStatusBanner status="diverged" branch="feat/x" runId={1} headSha="abc" onRebase={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    rerender(<MirrorStatusBanner status="diverged" branch="feat/x" runId={1} headSha="abc" onRebase={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    // New head sha: banner re-appears.
    rerender(<MirrorStatusBanner status="diverged" branch="feat/x" runId={1} headSha="def" onRebase={vi.fn()} />);
    expect(screen.getByText(/diverged on origin/i)).toBeTruthy();
  });

  it('renders a muted, button-less indicator when status is "local_only"', () => {
    render(<MirrorStatusBanner status="local_only" branch="feat/x" runId={1} headSha="abc" onRebase={vi.fn()} />);
    expect(screen.getByText(/No remote configured/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sync/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/web/features/runs/ship/MirrorStatusBanner.test.tsx`
Expected: FAIL — banner has old API (`baseBranch` / `onStop`) and no `local_only` path.

- [ ] **Step 3: Rewrite `MirrorStatusBanner.tsx`**

Replace the file with:

```tsx
import { useState, useEffect } from 'react';
import type { MirrorStatus } from '@shared/types.js';

export interface MirrorStatusBannerProps {
  status: MirrorStatus;
  branch: string | null;
  runId: number;
  headSha: string | null;
  onRebase: () => void;
}

function dismissKey(runId: number): string { return `fbi.mirrorBanner.dismissed.${runId}`; }

/** Persist { sha: string } to localStorage; Dismiss sets it; when the head
 *  sha changes we recompute isDismissed and automatically show again. */
export function MirrorStatusBanner({ status, branch, runId, headSha, onRebase }: MirrorStatusBannerProps) {
  const [dismissedSha, setDismissedSha] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(dismissKey(runId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { sha?: string };
      return typeof parsed.sha === 'string' ? parsed.sha : null;
    } catch { return null; }
  });

  // Clear dismissal whenever the head sha changes — mirrors "next successful push auto-clears".
  useEffect(() => {
    if (dismissedSha && headSha && dismissedSha !== headSha) {
      setDismissedSha(null);
      try { localStorage.removeItem(dismissKey(runId)); } catch { /* noop */ }
    }
  }, [headSha, dismissedSha, runId]);

  if (status === 'ok' || status === null) return null;

  if (status === 'local_only') {
    return (
      <section className="px-4 py-2 border-b border-border bg-surface-raised text-[12px] text-text-dim">
        No remote configured — commits saved locally only.
      </section>
    );
  }

  // diverged
  if (!branch) return null;
  const isDismissed = dismissedSha !== null && dismissedSha === headSha;
  if (isDismissed) return null;

  return (
    <section className="px-4 py-3 border-b border-border bg-warn-subtle/20 border-l-2 border-l-warn text-[13px]">
      <div className="font-semibold text-text">
        ⚠ Branch <code className="font-mono">{branch}</code> diverged on origin.
      </div>
      <p className="mt-1 text-text-dim">
        Someone pushed commits we don't have locally. Sync to integrate, or dismiss to keep trying.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={onRebase}
          className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Sync & retry
        </button>
        <button type="button"
          onClick={() => {
            const sha = headSha ?? '';
            setDismissedSha(sha);
            try { localStorage.setItem(dismissKey(runId), JSON.stringify({ sha })); } catch { /* noop */ }
          }}
          className="text-text-faint hover:text-text">
          Dismiss
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/web/features/runs/ship/MirrorStatusBanner.test.tsx`
Expected: PASS.

- [ ] **Step 5: Update `ShipTab.tsx` to pass the new props and stop calling `clearRunBaseBranch`**

In `src/web/features/runs/ship/ShipTab.tsx`, replace the `<MirrorStatusBanner … />` block (lines 32-41) with:

```tsx
      <MirrorStatusBanner
        status={run.mirror_status}
        branch={run.branch_name}
        runId={run.id}
        headSha={run.head_commit}
        onRebase={() => void runOp({ op: 'sync' })}
      />
```

Remove the `import { api } from '../../../lib/api.js';` at line 10.

- [ ] **Step 6: Update `ShipTab.test.tsx` to reflect new props**

Read `src/web/features/runs/ship/ShipTab.test.tsx` — the existing tests don't directly inspect the banner props, so the fix is to ensure `run.head_commit` is present on the mock. Add to the `run` mock (line 7):

```ts
const run = { id: 1, state: 'running', branch_name: 'feat/x', project_id: 1, prompt: '', title: null, head_commit: null, mirror_status: 'ok' } as unknown as Run;
```

- [ ] **Step 7: Remove `clearRunBaseBranch` from `src/web/lib/api.ts`**

Delete lines 283-286.

- [ ] **Step 8: Remove the `/stop-mirror` server route**

In `src/server/api/runs.ts`, delete the block `app.post('/api/runs/:id/stop-mirror', ...)` (lines 649-656).

- [ ] **Step 9: Run the web tests**

Run: `npx vitest run src/web/features/runs/ship/`
Expected: all pass.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/web/features/runs/ship/ src/web/lib/api.ts src/server/api/runs.ts
git commit -m "feat(ui): MirrorStatusBanner handles local_only; Dismiss is client-local with auto-expire"
```

---

## Task 10 — Merge / PR flow reads safeguard before origin push

**Files:**
- Modify: `src/server/orchestrator/historyOp.ts` (transient container path)
- Modify: `src/server/orchestrator/fbi-history-op.sh` (sync / merge / squash-local start with `git fetch safeguard`)
- Modify: `src/server/orchestrator/index.ts` (pass safeguard bind to transient container)
- Test: `src/server/orchestrator/historyOp.test.ts`

- [ ] **Step 1: Write a failing test asserting `runHistoryOpInTransientContainer` binds the safeguard**

Add to `src/server/orchestrator/historyOp.test.ts`:

```ts
it('transient container binds the safeguard bare repo at /safeguard', async () => {
  const captured: any[] = [];
  const docker = {
    createContainer: async (spec: any) => {
      captured.push(spec);
      return {
        start: async () => {},
        logs: async () => {
          const stream: any = require('node:stream').Readable.from([]);
          return stream;
        },
        wait: async () => ({ StatusCode: 0 }),
        remove: async () => {},
        kill: async () => {},
      };
    },
  } as any;
  await runHistoryOpInTransientContainer({
    docker, image: 'x', repoUrl: 'git@example:x/y.git',
    historyOpScriptPath: '/tmp/fbi-history-op.sh',
    env: { FBI_OP: 'sync', FBI_BRANCH: 'feat/x', FBI_DEFAULT: 'main', FBI_RUN_ID: '7' },
    sshSocket: '/tmp/ssh',
    safeguardPath: '/var/lib/agent-manager/runs/7/wip.git',
    authorName: 'a', authorEmail: 'a@b',
  });
  const binds = captured[0].HostConfig.Binds as string[];
  expect(binds).toContain('/var/lib/agent-manager/runs/7/wip.git:/safeguard:rw');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/orchestrator/historyOp.test.ts -t "safeguard"`
Expected: FAIL — `safeguardPath` is not a parameter.

- [ ] **Step 3: Add `safeguardPath` to `TransientOpInput`**

Edit `src/server/orchestrator/historyOp.ts` interface `TransientOpInput`:

```ts
export interface TransientOpInput {
  docker: Docker;
  image: string;
  repoUrl: string;
  historyOpScriptPath: string;
  env: HistoryOpEnv;
  sshSocket: string;
  authorName: string;
  authorEmail: string;
  safeguardPath: string;
  timeoutMs?: number;
}
```

And in `runHistoryOpInTransientContainer`, add to the `Binds` array:

```ts
      Binds: [
        `${sshSocket}:/ssh-agent`,
        `${historyOpScriptPath}:/usr/local/bin/fbi-history-op.sh:ro`,
        `${input.safeguardPath}:/safeguard:rw`,
      ],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/orchestrator/historyOp.test.ts -t "safeguard"`
Expected: PASS.

- [ ] **Step 5: Thread `safeguardPath` from `Orchestrator.execHistoryOp`**

In `src/server/orchestrator/index.ts` at the `execHistoryOp` tail (the transient-container branch, around line 867-876):

```ts
    // Finished run: transient container.
    return runHistoryOpInTransientContainer({
      docker: this.deps.docker,
      image: 'alpine/git:latest',
      repoUrl: project.repo_url,
      historyOpScriptPath: HISTORY_OP,
      env,
      sshSocket: this.deps.config.hostSshAuthSock,
      safeguardPath: this.wipRepo.path(runId),
      authorName: project.git_author_name ?? this.deps.config.gitAuthorName,
      authorEmail: project.git_author_email ?? this.deps.config.gitAuthorEmail,
    });
```

- [ ] **Step 6: Update `fbi-history-op.sh` to prefer safeguard for branch sources**

Edit `src/server/orchestrator/fbi-history-op.sh`. Add at the top of the non-`push-submodule` branch, before the `fetch origin` call (around line 53):

```sh
  # Prefer the safeguard's view of the run branch over origin's (safeguard is
  # the canonical source of Claude's committed work under the safeguard
  # design; origin may be stale or behind).
  if [ -d /safeguard ] && git -C /workspace remote add safeguard /safeguard 2>/dev/null \
       || git -C /workspace remote set-url safeguard /safeguard 2>/dev/null; then
    if out=$(git -C /workspace fetch --quiet safeguard "$FBI_BRANCH" 2>&1); then
      git -C /workspace update-ref "refs/remotes/origin/$FBI_BRANCH" "safeguard/$FBI_BRANCH" 2>/dev/null || :
    else
      : # safeguard didn't have the branch — fall through to origin fetch below
    fi
  fi
```

(The alias to `origin/<branch>` keeps all the existing `origin/$FBI_BRANCH` refs used later in `run_merge`/`run_sync` working without further changes.)

- [ ] **Step 7: Update the transient-container `cmd`**

No change needed in the shell command invocation; the `git remote` operations happen inside `/workspace` which `fbi-history-op.sh` already has.

- [ ] **Step 8: Write a failing script test for the safeguard-first behavior**

Create `src/server/orchestrator/fbi-history-op.safeguard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = path.join(HERE, 'fbi-history-op.sh');

describe('fbi-history-op.sh safeguard preference', () => {
  it('fetches the run branch from /safeguard before origin for FBI_OP=sync', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-'));
    const ws = path.join(root, 'ws');
    const safe = path.join(root, 'wip.git');
    const originBare = path.join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch', 'main', originBare]);
    execFileSync('git', ['init', '--bare', '--initial-branch', 'feat/x', safe]);
    execFileSync('git', ['clone', originBare, ws]);
    execFileSync('git', ['-C', ws, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', ws, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(ws, 'a'), '1');
    execFileSync('git', ['-C', ws, 'add', '.']);
    execFileSync('git', ['-C', ws, 'commit', '-m', 'init']);
    execFileSync('git', ['-C', ws, 'push', 'origin', 'HEAD:refs/heads/main']);
    // Seed the safeguard with a commit on feat/x.
    const seed = path.join(root, 'seed');
    execFileSync('git', ['clone', safe, seed]);
    execFileSync('git', ['-C', seed, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', seed, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(seed, 'b'), '2');
    execFileSync('git', ['-C', seed, 'add', '.']);
    execFileSync('git', ['-C', seed, 'commit', '-m', 'feat: from claude']);
    execFileSync('git', ['-C', seed, 'push', 'origin', 'HEAD:refs/heads/feat/x']);
    // Patch SCRIPT_SRC to treat /workspace=ws, /safeguard=safe.
    const src = fs.readFileSync(SCRIPT_SRC, 'utf8')
      .replace(/\/workspace\b/g, ws)
      .replace(/\/safeguard\b/g, safe);
    const script = path.join(root, 'hop.sh');
    fs.writeFileSync(script, src, { mode: 0o755 });
    const res = spawnSync('bash', [script], {
      env: { ...process.env, FBI_OP: 'sync', FBI_BRANCH: 'feat/x', FBI_DEFAULT: 'main', FBI_RUN_ID: '7',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t' },
      encoding: 'utf8',
    });
    expect(res.stdout).toContain('"ok":true');
    // Verify origin received the safeguard commit (the sync op force-pushes feat/x to origin).
    const origBranches = execFileSync('git', ['-C', originBare, 'branch', '--list'], { encoding: 'utf8' });
    expect(origBranches).toContain('feat/x');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run src/server/orchestrator/fbi-history-op.safeguard.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck + commit**

```bash
npm run typecheck
git add src/server/orchestrator/historyOp.ts src/server/orchestrator/historyOp.test.ts src/server/orchestrator/index.ts src/server/orchestrator/fbi-history-op.sh src/server/orchestrator/fbi-history-op.safeguard.test.ts
git commit -m "feat(historyOp): merge/sync prefer safeguard over origin as the run-branch source"
```

---

## Task 11 — Remove legacy branch-migration path + dead references

**Files:**
- Modify: `src/server/orchestrator/index.ts:587-604` (the "migrate legacy runs" block in `resume`)
- Modify: `src/server/api/runs.ts:336-342` (self-heal block in `/changes`)
- Modify: `src/server/orchestrator/index.ts:309-314` (`branchPreambleLines`)

- [ ] **Step 1: Remove the resume-time migration in `resume()`**

Delete lines 593-604 of `src/server/orchestrator/index.ts` (the `if (run.branch_name && !run.branch_name.startsWith('claude/run-'))` block). Under the new model the user's branch is primary — no migration.

- [ ] **Step 2: Remove the `self-heal` block in `/changes`**

Delete lines 337-342 of `src/server/api/runs.ts` (the `run.branch_name === claudeBranch && run.base_branch …` block). Not applicable under the new model.

- [ ] **Step 3: Relax `branchPreambleLines`**

Replace `branchPreambleLines` in `src/server/orchestrator/index.ts` (lines 309-314) with:

```ts
  private branchPreambleLines(runId: number, branchName: string | null): string[] {
    const branch = branchName && branchName.length > 0 ? branchName : `claude/run-${runId}`;
    return [
      `You are working on branch \`${branch}\`. Make all commits here.`,
      `Do NOT push to or modify any other branch.`,
    ];
  }
```

Update both call sites to pass `run.branch_name`:
- Line 333: `...this.branchPreambleLines(run.id, run.branch_name),`
- Line 631: `...this.branchPreambleLines(run.id, run.branch_name),`

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Run the orchestrator + api test suite**

```bash
npx vitest run src/server/orchestrator src/server/api
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/api/runs.ts
git commit -m "chore: drop claude/run-N migration + self-heal paths obsolete under safeguard model"
```

---

## Task 12 — Concurrent-branch UI prompt (optional UX polish)

**Files:**
- Modify: `src/web/features/runs/NewRunForm.tsx` (or equivalent — locate via grep)
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Locate the run-create form**

Run: `grep -rln "branch.*prompt\|POST.*runs\|new run" src/web/features/runs/ | head`
Identify the file — it is the component that posts to `/api/projects/:id/runs`.

- [ ] **Step 2: Extend `api.createRun` (or equivalent) to accept `force: boolean`**

In `src/web/lib/api.ts`, find the `createRun` method and widen its input type + pass `force` through. Concrete change depends on the shape of the existing method — add a `force?: boolean` field.

- [ ] **Step 3: Handle the 409 in the form**

In the run-create form's submit handler, on a 409 with `error === 'branch_in_use'`, display a `confirm()` dialog:

```ts
if (err.status === 409 && err.body?.error === 'branch_in_use') {
  if (window.confirm(err.body.message + '\nProceed anyway?')) {
    return createRun({ ...input, force: true });
  }
  return;
}
```

- [ ] **Step 4: Add a test (happy-path only — confirm polish is optional)**

Create `src/web/features/runs/NewRunForm.concurrent.test.tsx` with a minimal render + mock fetch that returns 409, spying `window.confirm` → true, and asserting the second call carries `force: true`.

- [ ] **Step 5: Run tests + typecheck**

```bash
npx vitest run src/web/
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ui): confirm dialog on 409 branch_in_use during run create"
```

---

## Task 13 — End-to-end verification + cleanup pass

**Files:**
- Read-only: entire repo

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: exit 0. Fix any issues inline.

- [ ] **Step 4: Full build**

Run: `npm run build`
Expected: exit 0; no missing-file errors from the `build:server` `cp` commands.

- [ ] **Step 5: Grep for leftover references**

```bash
grep -rn "fbi-wip-snapshot\|fbi-resume-restore\|MIRROR_BRANCH\|claude/run-\${RUN_ID}\|stop-mirror\|clearRunBaseBranch\|GitStateWatcher\|fbi-wip\.git\|/fbi-wip" src/ scripts/ package.json
```

Expected: no output (every match should be in deleted files only).

- [ ] **Step 6: Grep for the migration-checklist coverage**

Skim the spec's "Changes required" list items 1-10 against the plan:

- Item 1 (supervisor MIRROR_BRANCH drop + safeguard remote + resume fetch) → Task 4.
- Item 2 (post-commit hook replacement) → Task 4.
- Item 3 (orchestrator safeguard provision + bind-mount, drop env) → Tasks 2 + 3.
- Item 4 (remove snapshot / resume-restore scripts) → Task 5.
- Item 5 (GitStateWatcher → safeguard watcher) → Task 6.
- Item 6 (`/changes` reads from safeguard) → Task 7.
- Item 7 (MirrorStatusBanner dismiss refactor) → Task 9.
- Item 8 (run-delete removes wip.git) → already in place; verified in Task 2 Step 5.
- Item 9 (concurrent-branch check) → Task 8 + Task 12.
- Item 10 (`local_only` handling end-to-end) → Tasks 1, 4 (supervisor writes local_only), 6 (poller reflects into DB), 9 (UI).

No items are missing.

- [ ] **Step 7: Commit a no-op doc cross-ref if any issues surfaced**

Only if lint / build / grep turned up anything:

```bash
git add -A
git commit -m "chore: final cleanup for safeguard store migration"
```

