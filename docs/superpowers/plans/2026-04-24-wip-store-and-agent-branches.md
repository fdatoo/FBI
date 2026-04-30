# WIP Store + Agent-Owned Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the non-fast-forward push failure mode, preserve uncommitted work across container teardown, and keep the user's feature-branch workflow (CI / PR / preview) working — by splitting durability (local bare repo per run) from handoff (agent-owned `claude/run-N` branches on origin) with a best-effort mirror to the user's branch.

**Architecture:** Each run owns an ephemeral `/workspace/.git` inside the container and a durable bare `wip.git` on the host bind-mounted as `/fbi-wip.git`. Snapshot daemon inside the container force-pushes working-tree snapshots to `fbi-wip/wip` every 30 s; real commits always go to `origin/claude/run-N` (sole writer → fast-forward always); when the run was started against a user feature branch, the post-commit hook also mirrors to that branch, recording status for the UI. Resume starts a fresh container, fetches `fbi-wip`, and applies the snapshot via `read-tree`.

**Tech Stack:** Node / TypeScript (server), POSIX sh (container scripts), better-sqlite3, React / Vite (web), Fastify (API), vitest.

---

## File Structure

**New files (server)**
- `src/server/orchestrator/wipRepo.ts` — bare repo manager (init / path / exists / remove / readSnapshotFiles / readSnapshotDiff / readSnapshotPatch).
- `src/server/orchestrator/wipRepo.test.ts` — unit tests.
- `src/server/orchestrator/fbi-wip-snapshot.sh` — container-side snapshot script; single responsibility.
- `src/server/orchestrator/fbi-resume-restore.sh` — container-side resume restore; separated from `supervisor.sh` for testability.
- `src/server/orchestrator/fbi-wip-snapshot.test.ts` — shell test using local git fixtures (no docker).
- `src/server/orchestrator/fbi-resume-restore.test.ts` — shell test using local git fixtures.
- `src/server/orchestrator/mirrorStatus.ts` — reads `/fbi-state/mirror-status` from the running container and reflects into `runs.mirror_status`.
- `src/server/orchestrator/mirrorStatus.test.ts` — unit tests.

**New files (web)**
- `src/web/features/runs/WipSection.tsx` — Changes-tab section showing the WIP snapshot diff.
- `src/web/features/runs/WipSection.test.tsx`
- `src/web/features/runs/ResumeFailedBanner.tsx` — blocking banner when run state is `resume_failed`.
- `src/web/features/runs/ResumeFailedBanner.test.tsx`
- `src/web/features/runs/ship/MirrorStatusBanner.tsx` — yellow banner in the Ship tab when mirror has diverged.
- `src/web/features/runs/ship/MirrorStatusBanner.test.tsx`

**Modified files (server)**
- `src/server/db/schema.sql` — add `runs.base_branch`, `runs.mirror_status`; expand the state enum usage to include `resume_failed` at the application level (schema has `state TEXT NOT NULL` with no CHECK).
- `src/server/db/index.ts` — `migrate()`: add columns idempotently.
- `src/server/db/runs.ts` — extend `Run` type and CRUD to carry `base_branch`, `mirror_status`.
- `src/server/orchestrator/snapshotScripts.ts` — also copy `fbi-wip-snapshot.sh` and `fbi-resume-restore.sh`.
- `src/server/orchestrator/supervisor.sh` — pre-create `claude/run-N`; register `fbi-wip` remote; spawn snapshot daemon; post-commit hook writes mirror status; invoke `fbi-resume-restore.sh` on resume.
- `src/server/orchestrator/finalizeBranch.sh` — drop the wip commit + origin push; invoke one final `fbi-wip-snapshot.sh`; write `wip_sha` into `result.json`.
- `src/server/orchestrator/index.ts` — call `wipRepo.init` on run creation, add two Binds, call `wipRepo.remove` on deletion; handle new `resume_failed` state from `result.json`.
- `src/server/orchestrator/historyOp.ts` / `fbi-history-op.sh` — add `mirror-rebase` op.
- `src/server/api/runs.ts` — four new WIP endpoints; use `run.base_branch ?? project.default_branch` where the merge/PR/changes code reads the base branch.
- `src/shared/types.ts` — add `MirrorStatus`, `WipPayload`, extend `Run` + `HistoryOp`.
- `package.json` — `build:server` also copies `fbi-wip-snapshot.sh` and `fbi-resume-restore.sh`.

**Modified files (web)**
- `src/web/lib/api.ts` — four new WIP methods + mirror-rebase history-op entry.
- `src/web/features/runs/ChangesTab.tsx` — render `WipSection` when not-live + `ResumeFailedBanner` when applicable.
- `src/web/features/runs/ship/ShipTab.tsx` — render `MirrorStatusBanner` above sections.

---

## Task 1 — DB schema migration + shared types

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts`
- Modify: `src/server/db/runs.ts`
- Modify: `src/shared/types.ts`
- Test: `src/server/db/runs.test.ts`

- [ ] **Step 1.1 — Add columns to `schema.sql` (for fresh installs).**

Edit `src/server/db/schema.sql` — inside the `CREATE TABLE IF NOT EXISTS runs (...)` block, append before the closing paren:

```sql
  base_branch TEXT,
  mirror_status TEXT
    CHECK (mirror_status IS NULL OR mirror_status IN ('ok','diverged'))
```

- [ ] **Step 1.2 — Add idempotent migrations to `migrate()` in `src/server/db/index.ts`.**

Find the existing `ALTER TABLE runs` block (search for `resume_attempts`). After the last existing `runs` migration, add:

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
```

(Note: ALTER TABLE in SQLite can't add a CHECK constraint to an existing column; we rely on application-level validation for migrated DBs, matching the file's existing pattern.)

- [ ] **Step 1.3 — Extend the `Run` type and CRUD in `src/server/db/runs.ts`.**

Find the `Run` interface (currently has `branch_name`, `state`, etc.). Add:

```ts
export type MirrorStatus = 'ok' | 'diverged' | null;

export interface Run {
  // ... existing fields ...
  base_branch: string | null;
  mirror_status: MirrorStatus;
}
```

Find the mapping function (search for `function toRun` or the inline SELECT projection). Wherever the code maps a DB row into a `Run`, include:

```ts
base_branch: row.base_branch ?? null,
mirror_status: (row.mirror_status as MirrorStatus) ?? null,
```

Add two new methods on the `runs` object:

```ts
  setBaseBranch(id: number, baseBranch: string | null): void {
    db.prepare('UPDATE runs SET base_branch = ? WHERE id = ?')
      .run(baseBranch, id);
  },
  setMirrorStatus(id: number, status: MirrorStatus): void {
    db.prepare('UPDATE runs SET mirror_status = ? WHERE id = ?')
      .run(status, id);
  },
```

- [ ] **Step 1.4 — Extend shared types in `src/shared/types.ts`.**

Add:

```ts
export type MirrorStatus = 'ok' | 'diverged' | null;

export interface WipPayload {
  snapshot_sha: string;
  parent_sha: string;
  files: FilesDirtyEntry[];   // same entry shape as uncommitted
}

// Extend HistoryOp discriminated union with:
//   | { op: 'mirror-rebase' }
```

Find the existing `Run` interface (probably imports from server or is declared standalone for wire use). If it's shared, add:

```ts
  base_branch: string | null;
  mirror_status: MirrorStatus;
```

Also add a new run state literal (if the Run `state` is typed as a union of string literals; otherwise leave as string): `| 'resume_failed'`.

- [ ] **Step 1.5 — Write the failing DB test**

Append to `src/server/db/runs.test.ts`:

```ts
it('persists base_branch and mirror_status', () => {
  const r = runs.create({ project_id: p.id, prompt: 'x', branch_name: 'claude/run-1', state: 'queued', log_path: '/tmp/l' });
  expect(runs.get(r.id)!.base_branch).toBeNull();
  expect(runs.get(r.id)!.mirror_status).toBeNull();

  runs.setBaseBranch(r.id, 'feat/x');
  runs.setMirrorStatus(r.id, 'diverged');

  const fresh = runs.get(r.id)!;
  expect(fresh.base_branch).toBe('feat/x');
  expect(fresh.mirror_status).toBe('diverged');
});
```

- [ ] **Step 1.6 — Run tests**

Run: `npx vitest run src/server/db/runs.test.ts`
Expected: the new test PASSES (because migrate() has added the columns and the CRUD supports them).

- [ ] **Step 1.7 — Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts src/server/db/runs.ts src/server/db/runs.test.ts src/shared/types.ts
git commit -m "feat(db): runs.base_branch + runs.mirror_status + resume_failed state"
```

---

## Task 2 — `wipRepo.ts` module

**Files:**
- Create: `src/server/orchestrator/wipRepo.ts`
- Create: `src/server/orchestrator/wipRepo.test.ts`

- [ ] **Step 2.1 — Write the failing test**

Create `src/server/orchestrator/wipRepo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WipRepo } from './wipRepo.js';

let root: string;
let repo: WipRepo;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wipRepo-'));
  repo = new WipRepo(root);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('WipRepo', () => {
  it('init creates a bare repo with a writable refs dir', () => {
    const p = repo.init(42);
    expect(fs.existsSync(path.join(p, 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(p, 'refs', 'heads'))).toBe(true);
    expect(repo.exists(42)).toBe(true);
  });

  it('init is idempotent', () => {
    const a = repo.init(42);
    const b = repo.init(42);
    expect(a).toBe(b);
  });

  it('remove is idempotent and deletes the repo', () => {
    repo.init(42);
    repo.remove(42);
    expect(repo.exists(42)).toBe(false);
    repo.remove(42); // no throw
  });

  it('readSnapshotFiles returns empty when no wip ref', () => {
    repo.init(42);
    expect(repo.readSnapshotFiles(42)).toEqual([]);
  });

  it('readSnapshotFiles returns dirty entries when a snapshot exists', () => {
    const bare = repo.init(42);
    // Seed a commit manually via git plumbing.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wip-seed-'));
    execFileSync('git', ['init', '--initial-branch', 'main', work]);
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'base']);
    fs.writeFileSync(path.join(work, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'snapshot']);
    execFileSync('git', ['-C', work, 'push', bare, '+HEAD:refs/heads/wip']);

    const files = repo.readSnapshotFiles(42);
    expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    const aEntry = files.find((f) => f.path === 'a.txt')!;
    expect(aEntry.status).toBe('M');
    const bEntry = files.find((f) => f.path === 'b.txt')!;
    expect(bEntry.status).toBe('A');
    fs.rmSync(work, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2.2 — Run to verify failure**

Run: `npx vitest run src/server/orchestrator/wipRepo.test.ts`
Expected: FAIL — `Cannot find module './wipRepo.js'`.

- [ ] **Step 2.3 — Implement the module**

Create `src/server/orchestrator/wipRepo.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FilesDirtyEntry, FileDiffPayload } from '../../shared/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

export class WipRepo {
  constructor(private readonly baseDir: string) {}

  path(runId: number): string {
    return path.join(this.baseDir, String(runId), 'wip.git');
  }

  exists(runId: number): boolean {
    return fs.existsSync(path.join(this.path(runId), 'HEAD'));
  }

  init(runId: number): string {
    const p = this.path(runId);
    if (this.exists(runId)) return p;
    fs.mkdirSync(p, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch', 'wip', p]);
    // Make writable by group so both the FBI server user and the container's
    // agent user (with a matching GID, same mechanism as docker-socket
    // forwarding at 35edb0f) can push.
    execFileSync('git', ['-C', p, 'config', 'core.sharedRepository', 'group']);
    return p;
  }

  remove(runId: number): void {
    const p = this.path(runId);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* idempotent */ }
    // Also remove parent if empty.
    const parent = path.dirname(p);
    try { fs.rmdirSync(parent); } catch { /* non-empty or missing — both fine */ }
  }

  private snapshotSha(runId: number): string | null {
    if (!this.exists(runId)) return null;
    try {
      return git(this.path(runId), 'rev-parse', '--verify', '-q', 'refs/heads/wip').trim() || null;
    } catch {
      return null;
    }
  }

  parentSha(runId: number): string | null {
    const snap = this.snapshotSha(runId);
    if (!snap) return null;
    try { return git(this.path(runId), 'rev-parse', `${snap}^`).trim(); } catch { return null; }
  }

  readSnapshotFiles(runId: number): FilesDirtyEntry[] {
    const snap = this.snapshotSha(runId);
    if (!snap) return [];
    const out = git(this.path(runId), 'show', '--no-color', '--name-status', '--format=', snap);
    return out.split('\n').filter(Boolean).map((line) => {
      const [statusRaw, ...rest] = line.split('\t');
      const status = statusRaw[0] ?? 'M';
      return { path: rest.join('\t'), status, additions: 0, deletions: 0 };
    });
  }

  readSnapshotDiff(runId: number, filePath: string): FileDiffPayload {
    const snap = this.snapshotSha(runId);
    if (!snap) return { hunks: [], truncated: false };
    const parent = this.parentSha(runId);
    const out = git(
      this.path(runId), 'diff', '--no-color', '--no-ext-diff', '-U3',
      `${parent}..${snap}`, '--', filePath,
    );
    // Reuse the existing diff parser if one exists at this point; otherwise
    // ship the raw patch and let the caller parse. For minimum viable MVP,
    // return one "hunk" with the whole patch text so the DiffBlock renders
    // something useful. (Swap for proper hunk parsing in a follow-up.)
    return { hunks: out ? [{ header: '@@', lines: out.split('\n') }] : [], truncated: false };
  }

  readSnapshotPatch(runId: number): string {
    const snap = this.snapshotSha(runId);
    if (!snap) return '';
    const parent = this.parentSha(runId);
    return git(this.path(runId), 'format-patch', '--stdout', `${parent}..${snap}`);
  }
}
```

**Note on diff parsing:** If `src/server/api/runs.ts` already has a `parsePatchIntoHunks` helper for the existing `/file` endpoint, import and reuse it in `readSnapshotDiff` instead of the placeholder single-hunk representation. Grep for `hunks` in `src/server/api/runs.ts` before implementing — use the existing parser.

- [ ] **Step 2.4 — Run tests**

Run: `npx vitest run src/server/orchestrator/wipRepo.test.ts`
Expected: PASS.

- [ ] **Step 2.5 — Commit**

```bash
git add src/server/orchestrator/wipRepo.ts src/server/orchestrator/wipRepo.test.ts
git commit -m "feat(orchestrator): wipRepo module for per-run bare WIP repos"
```

---

## Task 3 — `fbi-wip-snapshot.sh`

**Files:**
- Create: `src/server/orchestrator/fbi-wip-snapshot.sh`
- Create: `src/server/orchestrator/fbi-wip-snapshot.test.ts`

- [ ] **Step 3.1 — Write the failing test**

Create `src/server/orchestrator/fbi-wip-snapshot.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'fbi-wip-snapshot.sh');

interface Fixture {
  root: string;
  work: string;
  bare: string;
}

function g(cwd: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
}

function setup(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'wip.git');
  fs.mkdirSync(work);
  execFileSync('git', ['init', '--initial-branch', 'main', work]);
  execFileSync('git', ['init', '--bare', '--initial-branch', 'wip', bare]);
  g(work, 'config', 'user.name', 'T');
  g(work, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'base');
  g(work, 'remote', 'add', 'fbi-wip', bare);
  return { root, work, bare };
}

function run(work: string): { code: number; stdout: string } {
  // Run the script in a sandbox; /workspace is hardcoded in the script so
  // we spawn a sh that first cds to `work` and runs it with WORKSPACE= set
  // via a small wrapper. Simpler: edit the script at test time to accept an
  // override via env FBI_WORKSPACE (see implementation in 3.2 — the script
  // respects $FBI_WORKSPACE if set).
  const r = spawnSync(SCRIPT, [], {
    cwd: work, env: { ...process.env, FBI_WORKSPACE: work, FBI_RUN_ID: '7' }, encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout.trim() };
}

describe('fbi-wip-snapshot.sh', () => {
  let fx: Fixture;
  beforeEach(() => { fx = setup(); });
  afterEach(() => { fs.rmSync(fx.root, { recursive: true, force: true }); });

  it('no-op when tree is clean', () => {
    const r = run(fx.work);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.noop).toBe(true);
  });

  it('snapshots staged, unstaged, and untracked into fbi-wip/wip', () => {
    fs.writeFileSync(path.join(fx.work, 'a.txt'), 'dirty\n');
    fs.writeFileSync(path.join(fx.work, 'new.txt'), 'n\n');
    const r = run(fx.work);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.sha).toMatch(/^[0-9a-f]{40}$/);

    // wip ref exists on the bare repo
    const wipSha = g(fx.bare, 'rev-parse', 'refs/heads/wip');
    expect(wipSha).toBe(j.sha);

    // Working tree, HEAD, and index are unchanged
    const head = g(fx.work, 'rev-parse', 'HEAD');
    expect(head).not.toBe(wipSha);
    expect(fs.readFileSync(path.join(fx.work, 'a.txt'), 'utf8')).toBe('dirty\n');
    expect(fs.readFileSync(path.join(fx.work, 'new.txt'), 'utf8')).toBe('n\n');
    const status = g(fx.work, 'status', '--porcelain');
    expect(status).toContain(' M a.txt');
    expect(status).toContain('?? new.txt');
  });

  it('returns structured failure and exit 0 when push fails', () => {
    fs.writeFileSync(path.join(fx.work, 'a.txt'), 'dirty\n');
    // Point fbi-wip at a non-existent path
    g(fx.work, 'remote', 'set-url', 'fbi-wip', path.join(fx.root, 'missing'));
    const r = run(fx.work);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(false);
    expect(j.reason).toBe('push');
  });
});
```

- [ ] **Step 3.2 — Run to verify failure**

Run: `npx vitest run src/server/orchestrator/fbi-wip-snapshot.test.ts`
Expected: FAIL — script file does not exist.

- [ ] **Step 3.3 — Implement the script**

Create `src/server/orchestrator/fbi-wip-snapshot.sh`:

```sh
#!/bin/sh
# FBI WIP snapshot. Captures the current working tree into a commit object
# and force-pushes it to fbi-wip/wip. Does not touch HEAD, the real index,
# or the working tree.
#
# Env vars:
#   FBI_WORKSPACE   workspace dir (default: /workspace). For testability.
#   FBI_RUN_ID      run id (logged only).
#
# Output contract: one JSON line on stdout:
#   {"ok":true,"sha":"...","noop":false}
#   {"ok":true,"sha":"<last>","noop":true}
#   {"ok":false,"reason":"no-workspace"|"push"|"other","message":"..."}
# Exit 0 always (non-zero reserved for unreachable preconditions).

set -u

WS="${FBI_WORKSPACE:-/workspace}"
cd "$WS" 2>/dev/null || { printf '%s\n' '{"ok":false,"reason":"no-workspace"}'; exit 0; }

# Nothing to snapshot?
if [ -z "$(git status --porcelain)" ]; then
  last=$(git rev-parse --verify -q refs/remotes/fbi-wip/wip 2>/dev/null || echo '')
  printf '{"ok":true,"sha":"%s","noop":true}\n' "$last"
  exit 0
fi

parent=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ -z "$parent" ]; then
  printf '%s\n' '{"ok":false,"reason":"no-head"}'
  exit 0
fi

# Build the snapshot tree in a temporary index so the real index is untouched.
GIT_DIR_ABS=$(git rev-parse --git-dir)
tmp_index=$(mktemp)
# Seed the temp index from the real one if present so write-tree captures both
# staged and unstaged + untracked in one tree.
if [ -f "$GIT_DIR_ABS/index" ]; then
  cp "$GIT_DIR_ABS/index" "$tmp_index"
else
  rm -f "$tmp_index"
fi

if ! out=$(GIT_INDEX_FILE="$tmp_index" git add -A 2>&1); then
  rm -f "$tmp_index"
  esc=$(printf '%s' "$out" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"ok":false,"reason":"index","message":"%s"}\n' "$esc"
  exit 0
fi

tree=$(GIT_INDEX_FILE="$tmp_index" git write-tree 2>/dev/null || echo '')
rm -f "$tmp_index"
if [ -z "$tree" ]; then
  printf '%s\n' '{"ok":false,"reason":"write-tree"}'
  exit 0
fi

msg="fbi wip snapshot run=${FBI_RUN_ID:-?} ts=$(date -u +%s)"
commit=$(printf '%s\n' "$msg" | git commit-tree "$tree" -p "$parent" 2>/dev/null || echo '')
if [ -z "$commit" ]; then
  printf '%s\n' '{"ok":false,"reason":"commit-tree"}'
  exit 0
fi

if ! out=$(git push --force --quiet fbi-wip "$commit:refs/heads/wip" 2>&1); then
  esc=$(printf '%s' "$out" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"ok":false,"reason":"push","message":"%s"}\n' "$esc"
  exit 0
fi

# Update the local remote-tracking ref for ergonomics.
git update-ref refs/remotes/fbi-wip/wip "$commit" 2>/dev/null || :

printf '{"ok":true,"sha":"%s","noop":false}\n' "$commit"
exit 0
```

Mark executable: `chmod +x src/server/orchestrator/fbi-wip-snapshot.sh`.

- [ ] **Step 3.4 — Run tests**

Run: `npx vitest run src/server/orchestrator/fbi-wip-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 3.5 — Commit**

```bash
git add src/server/orchestrator/fbi-wip-snapshot.sh src/server/orchestrator/fbi-wip-snapshot.test.ts
git commit -m "feat(orchestrator): fbi-wip-snapshot.sh captures working tree to wip.git"
```

---

## Task 4 — Distribute the script: `snapshotScripts.ts` + `package.json`

**Files:**
- Modify: `src/server/orchestrator/snapshotScripts.ts`
- Modify: `src/server/orchestrator/snapshotScripts.test.ts`
- Modify: `package.json`

- [ ] **Step 4.1 — Extend `snapshotScripts.ts`.**

Find the existing `snapshotScripts` function signature — it takes `destDir, srcSupervisor, srcFinalize, srcHistoryOp`. Extend it:

```ts
export function snapshotScripts(
  destDir: string,
  srcSupervisor: string,
  srcFinalize: string,
  srcHistoryOp: string,
  srcWipSnapshot: string,
  srcResumeRestore: string,
): void {
  fs.mkdirSync(destDir, { recursive: true });
  const sup = path.join(destDir, 'supervisor.sh');
  const fin = path.join(destDir, 'finalizeBranch.sh');
  const hist = path.join(destDir, 'fbi-history-op.sh');
  const snap = path.join(destDir, 'fbi-wip-snapshot.sh');
  const restore = path.join(destDir, 'fbi-resume-restore.sh');
  fs.copyFileSync(srcSupervisor, sup);
  fs.copyFileSync(srcFinalize, fin);
  fs.copyFileSync(srcHistoryOp, hist);
  fs.copyFileSync(srcWipSnapshot, snap);
  fs.copyFileSync(srcResumeRestore, restore);
  fs.chmodSync(sup, 0o755);
  fs.chmodSync(fin, 0o755);
  fs.chmodSync(hist, 0o755);
  fs.chmodSync(snap, 0o755);
  fs.chmodSync(restore, 0o755);
}
```

- [ ] **Step 4.2 — Update the test.**

Find the existing `snapshotScripts.test.ts`. Add assertions for the two new files:

```ts
expect(fs.readFileSync(path.join(dest, 'fbi-wip-snapshot.sh'), 'utf8')).toBe('#!/bin/sh\necho snap\n');
expect(fs.statSync(path.join(dest, 'fbi-wip-snapshot.sh')).mode & 0o111).not.toBe(0);
expect(fs.readFileSync(path.join(dest, 'fbi-resume-restore.sh'), 'utf8')).toBe('#!/bin/sh\necho restore\n');
expect(fs.statSync(path.join(dest, 'fbi-resume-restore.sh')).mode & 0o111).not.toBe(0);
```

Update the call sites in the existing tests to pass the two new source paths (create tiny temp fixtures in the test itself).

- [ ] **Step 4.3 — Update all production callers.**

Run: `grep -rn "snapshotScripts(" src/server` — should surface the single caller in `index.ts`. Update it to pass the two new paths (the `HISTORY_OP` constant pattern — add `WIP_SNAPSHOT` and `RESUME_RESTORE` alongside):

```ts
const WIP_SNAPSHOT = path.join(HERE, 'fbi-wip-snapshot.sh');
const RESUME_RESTORE = path.join(HERE, 'fbi-resume-restore.sh');
// ... at the call site:
snapshotScripts(scriptsDir, SUPERVISOR, FINALIZE_BRANCH, HISTORY_OP, WIP_SNAPSHOT, RESUME_RESTORE);
```

*(Note: `fbi-resume-restore.sh` is created in Task 11. Until then, the file won't exist and dev servers will fail to start new runs. Create a stub now — empty `#!/bin/sh\n` with executable bit — so the snapshot call succeeds. Task 11 replaces it.)*

```bash
printf '#!/bin/sh\n# stub — replaced in Task 11\n' > src/server/orchestrator/fbi-resume-restore.sh
chmod +x src/server/orchestrator/fbi-resume-restore.sh
```

- [ ] **Step 4.4 — Update `package.json` build:server.**

Edit the `build:server` script to append two more `cp` commands after the `finalizeBranch.sh` copy:

```
 && cp src/server/orchestrator/fbi-wip-snapshot.sh dist/server/orchestrator/fbi-wip-snapshot.sh
 && cp src/server/orchestrator/fbi-resume-restore.sh dist/server/orchestrator/fbi-resume-restore.sh
```

- [ ] **Step 4.5 — Run tests + build**

```bash
npx vitest run src/server/orchestrator/snapshotScripts.test.ts
npm run build:server
ls dist/server/orchestrator/fbi-wip-snapshot.sh dist/server/orchestrator/fbi-resume-restore.sh
```

Expected: tests pass; both .sh files appear in `dist/`.

- [ ] **Step 4.6 — Commit**

```bash
git add src/server/orchestrator/snapshotScripts.ts src/server/orchestrator/snapshotScripts.test.ts src/server/orchestrator/fbi-resume-restore.sh package.json src/server/orchestrator/index.ts
git commit -m "feat(build): distribute fbi-wip-snapshot.sh and fbi-resume-restore.sh"
```

---

## Task 5 — Orchestrator: wipRepo lifecycle + container binds

**Files:**
- Modify: `src/server/orchestrator/index.ts`
- Test: `src/server/orchestrator/wipRepo.lifecycle.test.ts` (new)

- [ ] **Step 5.1 — Wire `WipRepo` into the orchestrator.**

At the top of `src/server/orchestrator/index.ts`, import:

```ts
import { WipRepo } from './wipRepo.js';
```

Add to the `OrchestratorDeps` (or directly as a class field if the codebase uses field-based wiring — match the surrounding style):

```ts
  wipRepo: WipRepo;
```

In the `Orchestrator` constructor / factory, instantiate:

```ts
this.wipRepo = new WipRepo(path.join(this.deps.config.runsDir, ''));
// WipRepo.path(runId) produces `<runsDir>/<id>/wip.git` — same convention as
// the existing per-run directories created by `ensureRunDir(runId)`.
```

- [ ] **Step 5.2 — Init on run creation.**

Find the run-creation code path (search `ensureRunDir(` or the spot where `runs.create(...)` is called). Right after the run row is inserted and its directory is created, add:

```ts
this.wipRepo.init(run.id);
```

- [ ] **Step 5.3 — Add the two Binds in `createContainerForRun`.**

Find the `Binds:` array in `createContainerForRun` (near `scriptsDir`, `claude-projects`, `state`, etc.). Append:

```ts
`${path.join(scriptsDir, 'fbi-wip-snapshot.sh')}:/usr/local/bin/fbi-wip-snapshot.sh:ro`,
`${path.join(scriptsDir, 'fbi-resume-restore.sh')}:/usr/local/bin/fbi-resume-restore.sh:ro`,
`${this.wipRepo.path(runId)}:/fbi-wip.git:rw`,
```

- [ ] **Step 5.4 — Remove on run deletion.**

Find `deleteRun(runId)` (search `runs.delete` or `deleteRun`). Right after the DB delete, add:

```ts
this.deps.wipRepo?.remove(runId) ?? this.wipRepo.remove(runId);
```

(Match the surrounding style; a direct `this.wipRepo.remove(runId)` works.)

- [ ] **Step 5.5 — Write lifecycle test**

Create `src/server/orchestrator/wipRepo.lifecycle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WipRepo } from './wipRepo.js';

describe('WipRepo lifecycle integration', () => {
  it('is torn down by remove after init', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiplc-'));
    const repo = new WipRepo(root);
    const p = repo.init(99);
    expect(fs.existsSync(p)).toBe(true);
    repo.remove(99);
    expect(fs.existsSync(p)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

Run: `npx vitest run src/server/orchestrator/wipRepo.lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5.6 — Typecheck + commit**

```bash
npm run typecheck
git add -A
git commit -m "feat(orchestrator): wipRepo init on create, remove on delete, bind mounts"
```

---

## Task 6 — `supervisor.sh`: pre-create `claude/run-N` + `fbi-wip` remote

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`
- Test: `src/server/orchestrator/supervisor.test.ts` (existing; update assertions)

- [ ] **Step 6.1 — Replace the branch-creation block.**

In `supervisor.sh`, find the `if [ -n "${FBI_CHECKOUT_BRANCH:-}" ]; then ... fi` block (about line 49). Replace with:

```sh
# Check out the user's branch for context if they specified one.
if [ -n "${FBI_CHECKOUT_BRANCH:-}" ]; then
    git checkout "$FBI_CHECKOUT_BRANCH" \
      || { echo "[fbi] warn: branch $FBI_CHECKOUT_BRANCH not found on remote; using $DEFAULT_BRANCH"; \
           git checkout "$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }; }
else
    git checkout "$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }
fi

# Pre-create the agent-owned branch. Sole writer: this container. Fast-forward
# pushes are guaranteed — no divergence on this ref.
AGENT_BRANCH="claude/run-$RUN_ID"
if ! git rev-parse --verify --quiet "origin/$AGENT_BRANCH" >/dev/null; then
    git checkout -b "$AGENT_BRANCH"
    # Push immediately so the UI has a target and GitHub knows about the branch.
    git push -u origin "$AGENT_BRANCH" || echo "[fbi] warn: initial push of $AGENT_BRANCH failed"
else
    # Branch already exists remotely (this is a resume). Land on it.
    git checkout -B "$AGENT_BRANCH" "origin/$AGENT_BRANCH"
fi

# Register the WIP remote so the snapshot daemon can push to it.
git remote add fbi-wip /fbi-wip.git 2>/dev/null || git remote set-url fbi-wip /fbi-wip.git
```

- [ ] **Step 6.2 — Update the preamble.**

Edit `src/server/orchestrator/index.ts` — find the `preamble` array construction (search `You are working in /workspace`). Replace the two branch-instruction lines with:

```ts
      `You are working on branch \`claude/run-${run.id}\`. Make all commits here.`,
      `Do NOT push to or modify any other branch.`,
```

Remove the conditional `branchHint` logic (no longer needed — FBI owns the branch).

- [ ] **Step 6.3 — Update supervisor.test.ts assertions.**

Find the existing `supervisor.test.ts` tests that cover branch-checkout behavior. Update any expectations that assumed commits land on `FBI_CHECKOUT_BRANCH`; the new expectation is `claude/run-$RUN_ID`.

If the existing test coverage is thin or can't run without mocking more, add a minimal integration test (new file `supervisor.branch.test.ts`) that simulates the branch-creation logic against a sandbox:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('supervisor.sh branch creation (extracted lines)', () => {
  // Extract-and-run pattern: we'll test the *logic* in isolation by shelling
  // out to a tiny helper that mirrors the supervisor block.
  it('creates claude/run-N at DEFAULT_BRANCH tip when no remote agent branch exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supbr-'));
    const bare = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '--bare', '--initial-branch', 'main', bare]);
    execFileSync('git', ['clone', bare, work]);
    // Seed a commit on main.
    fs.writeFileSync(path.join(work, 'x'), 'y');
    execFileSync('git', ['-C', work, 'config', 'user.name', 'T']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'base']);
    execFileSync('git', ['-C', work, 'push', 'origin', 'main']);

    // Simulate the block.
    const runId = '42';
    const agent = `claude/run-${runId}`;
    execFileSync('git', ['-C', work, 'checkout', '-b', agent]);
    execFileSync('git', ['-C', work, 'push', '-u', 'origin', agent]);

    const branches = execFileSync('git', ['-C', bare, 'branch', '--list'], { encoding: 'utf8' });
    expect(branches).toContain(agent);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 6.4 — Run existing supervisor tests and the new one**

```bash
npx vitest run src/server/orchestrator/supervisor.test.ts src/server/orchestrator/supervisor.branch.test.ts
```

- [ ] **Step 6.5 — Commit**

```bash
git add src/server/orchestrator/supervisor.sh src/server/orchestrator/supervisor.test.ts src/server/orchestrator/supervisor.branch.test.ts src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): pre-create claude/run-N and register fbi-wip remote"
```

---

## Task 7 — `supervisor.sh`: spawn snapshot daemon

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`

- [ ] **Step 7.1 — Add the daemon and trap.**

In `supervisor.sh`, right after the `fbi-wip` remote registration (end of Task 6's block), before the `git config user.name` lines, add:

```sh
# Snapshot daemon. Captures working-tree state every 30s and pushes to
# fbi-wip/wip. Non-fatal on failure. Killed by the trap below at exit.
(
  while true; do
    sleep 30
    out=$(/usr/local/bin/fbi-wip-snapshot.sh 2>&1)
    printf '%s\n' "$out" > /tmp/last-snapshot.log
    # Mirror to /fbi-state so GitStateWatcher-equivalent server code can read it.
    mkdir -p /fbi-state
    printf '%s\n' "$out" > /fbi-state/snapshot-status 2>/dev/null || :
  done
) &
FBI_SNAPSHOT_PID=$!
trap 'kill "$FBI_SNAPSHOT_PID" 2>/dev/null || :' EXIT
```

- [ ] **Step 7.2 — One final snapshot in finalize (done in Task 10).**

Flag-noting step; actual edits happen in Task 10. Don't modify `finalizeBranch.sh` yet.

- [ ] **Step 7.3 — Run typecheck (no new TS) + commit**

```bash
npm run typecheck
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(orchestrator): supervisor.sh spawns snapshot daemon"
```

---

## Task 8 — `supervisor.sh`: post-commit hook with mirror push + status file

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`
- Modify: `src/server/orchestrator/index.ts` — pass `FBI_BASE_BRANCH` env var
- Modify: `src/server/orchestrator/historyOp.ts` — not in this task but env plumbing is related

- [ ] **Step 8.1 — Update the post-commit hook block.**

Find the existing post-commit hook write in `supervisor.sh` (the `cat > .git/hooks/post-commit <<'HOOK'` block). Replace the whole heredoc with:

```sh
cat > .git/hooks/post-commit <<'HOOK'
#!/bin/sh
# Primary push: agent-owned branch (sole writer — always fast-forward).
( git push --recurse-submodules=on-demand origin HEAD > /tmp/last-push.log 2>&1 || true ) &

# Mirror push: to the user's feature branch, best-effort.
if [ -n "${FBI_BASE_BRANCH:-}" ] \
   && [ "$FBI_BASE_BRANCH" != "$DEFAULT_BRANCH" ] \
   && [ "$FBI_BASE_BRANCH" != "claude/run-${RUN_ID}" ]; then
  (
    if git push --recurse-submodules=on-demand origin "HEAD:refs/heads/$FBI_BASE_BRANCH" > /tmp/last-mirror.log 2>&1; then
      mkdir -p /fbi-state
      echo ok > /fbi-state/mirror-status
    else
      mkdir -p /fbi-state
      echo diverged > /fbi-state/mirror-status
    fi
  ) &
fi
HOOK
chmod +x .git/hooks/post-commit
```

- [ ] **Step 8.2 — Plumb `FBI_BASE_BRANCH` from the orchestrator.**

In `src/server/orchestrator/index.ts`, find where container env vars are built (the `Env:` list that receives `DEFAULT_BRANCH`, `RUN_ID`, etc.). Add:

```ts
        ...(run.base_branch ? [`FBI_BASE_BRANCH=${run.base_branch}`] : []),
```

- [ ] **Step 8.3 — Set `base_branch` at run creation.**

Find the run-creation code path. Right after `runs.create(...)`, if a branch was specified, persist it:

```ts
if (opts.baseBranch) {
  this.deps.runs.setBaseBranch(run.id, opts.baseBranch);
}
```

Source of `opts.baseBranch`: this is whatever the caller (HTTP handler or internal caller) passes in. The API layer for "start run" currently accepts a `branch` (for `FBI_CHECKOUT_BRANCH`) — plumb that through as `base_branch` too. The two are the same concept at run-creation time.

- [ ] **Step 8.4 — Manual smoke**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 8.5 — Commit**

```bash
git add src/server/orchestrator/supervisor.sh src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): mirror push in post-commit hook + /fbi-state/mirror-status"
```

---

## Task 9 — `mirrorStatus.ts`: poll the container, reflect into DB

**Files:**
- Create: `src/server/orchestrator/mirrorStatus.ts`
- Create: `src/server/orchestrator/mirrorStatus.test.ts`
- Modify: `src/server/orchestrator/gitStateWatcher.ts` — read the status file on each tick

- [ ] **Step 9.1 — Write the failing test**

Create `src/server/orchestrator/mirrorStatus.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseMirrorStatus } from './mirrorStatus.js';

describe('parseMirrorStatus', () => {
  it('returns ok for literal "ok"', () => {
    expect(parseMirrorStatus('ok\n')).toBe('ok');
  });
  it('returns diverged for literal "diverged"', () => {
    expect(parseMirrorStatus('diverged\n')).toBe('diverged');
  });
  it('returns null for anything else', () => {
    expect(parseMirrorStatus('')).toBeNull();
    expect(parseMirrorStatus('garbage')).toBeNull();
  });
});
```

- [ ] **Step 9.2 — Run to verify failure**

Run: `npx vitest run src/server/orchestrator/mirrorStatus.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 9.3 — Implement**

Create `src/server/orchestrator/mirrorStatus.ts`:

```ts
import type { MirrorStatus } from '../../shared/types.js';

export function parseMirrorStatus(raw: string): MirrorStatus {
  const t = raw.trim();
  if (t === 'ok') return 'ok';
  if (t === 'diverged') return 'diverged';
  return null;
}
```

- [ ] **Step 9.4 — Wire into `gitStateWatcher.ts`.**

Find the `docker exec` call in `gitStateWatcher.ts` that reads git state markers. Extend the shell snippet to also `cat /fbi-state/mirror-status 2>/dev/null`, emit a marker like `__MIRROR__` before the content, and in the parser append the parsed MirrorStatus to the snapshot object. Then, in the watcher's `onSnapshot` handler, call:

```ts
if (snapshot.mirrorStatus !== runs.get(runId)?.mirror_status) {
  runs.setMirrorStatus(runId, snapshot.mirrorStatus);
}
```

*(This reuses the already-polling watcher; no new polling channel added.)*

- [ ] **Step 9.5 — Run tests + typecheck**

```bash
npx vitest run src/server/orchestrator/mirrorStatus.test.ts src/server/orchestrator/gitStateWatcher.test.ts
npm run typecheck
```

- [ ] **Step 9.6 — Commit**

```bash
git add src/server/orchestrator/mirrorStatus.ts src/server/orchestrator/mirrorStatus.test.ts src/server/orchestrator/gitStateWatcher.ts
git commit -m "feat(orchestrator): track mirror_status via /fbi-state and reflect into DB"
```

---

## Task 10 — `finalizeBranch.sh`: simplify (drop wip commit, add final snapshot)

**Files:**
- Modify: `src/server/orchestrator/finalizeBranch.sh`
- Modify: `src/server/orchestrator/finalizeBranch.test.ts`

- [ ] **Step 10.1 — Replace the script body (after the env-guard prelude).**

Starting from the line `# Capture uncommitted work on whatever branch we're on.`, replace everything through the final `printf` with:

```sh
# Take one final WIP snapshot so unsaved work is preserved even if the
# periodic daemon missed the last edit.
if [ -x /usr/local/bin/fbi-wip-snapshot.sh ]; then
    /usr/local/bin/fbi-wip-snapshot.sh > /tmp/last-snapshot.log 2>&1 || :
fi

# Refresh the remote default branch so already-merged detection works.
git fetch --quiet origin "$DEFAULT_BRANCH" 2>/dev/null || true

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"

# Read WIP sha (if any) from the log.
WIP_SHA=""
if [ -f /tmp/last-snapshot.log ]; then
    # last-snapshot.log is a single JSON line: {"ok":true,"sha":"..."}
    WIP_SHA=$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' /tmp/last-snapshot.log | tail -n 1)
fi

# Push exit is sourced from the last post-commit hook's log so we don't
# re-push from here — the hook has been keeping origin up to date.
PUSH_EXIT=0
if [ -f /tmp/last-push.log ]; then
    if grep -qE '^!|rejected|error:' /tmp/last-push.log 2>/dev/null; then
        PUSH_EXIT=1
    fi
fi

printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s","branch":"%s","wip_sha":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" "$CURRENT_BRANCH" "$WIP_SHA" > "$RESULT_PATH"
```

- [ ] **Step 10.2 — Update `finalizeBranch.test.ts`.**

The existing tests assert on the `wip: claude run N` commit and the push to origin. Remove those assertions. Add:

```ts
it('includes wip_sha in result JSON when a snapshot was taken', () => {
  // seed a fake /tmp/last-snapshot.log inside the sandbox before invoking
  // the script; assert the parsed result JSON.
});

it('does not create a wip: commit', () => {
  // assert git log doesn't contain a 'wip:' commit after finalize.
});
```

Flesh these out using the sandbox pattern already established in the file.

- [ ] **Step 10.3 — Run tests**

```bash
npx vitest run src/server/orchestrator/finalizeBranch.test.ts
```

- [ ] **Step 10.4 — Commit**

```bash
git add src/server/orchestrator/finalizeBranch.sh src/server/orchestrator/finalizeBranch.test.ts
git commit -m "feat(orchestrator): finalizeBranch delegates WIP to snapshot, no wip commit"
```

---

## Task 11 — `fbi-resume-restore.sh` + test

**Files:**
- Replace stub: `src/server/orchestrator/fbi-resume-restore.sh`
- Create: `src/server/orchestrator/fbi-resume-restore.test.ts`

- [ ] **Step 11.1 — Write the failing test**

Create `src/server/orchestrator/fbi-resume-restore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'fbi-resume-restore.sh');

function g(cwd: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
}

interface Fx { root: string; work: string; bare: string; wipRepo: string; resultPath: string; }

function setup(): Fx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const wipRepo = path.join(root, 'wip.git');
  const resultPath = path.join(root, 'result.json');
  execFileSync('git', ['init', '--bare', '--initial-branch', 'main', bare]);
  execFileSync('git', ['init', '--initial-branch', 'main', work]);
  g(work, 'config', 'user.name', 'T'); g(work, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  g(work, 'add', '.'); g(work, 'commit', '-m', 'base');
  g(work, 'remote', 'add', 'origin', bare);
  g(work, 'checkout', '-b', 'claude/run-1');
  g(work, 'push', '-u', 'origin', 'claude/run-1');
  execFileSync('git', ['init', '--bare', '--initial-branch', 'wip', wipRepo]);
  g(work, 'remote', 'add', 'fbi-wip', wipRepo);
  return { root, work, bare, wipRepo, resultPath };
}

function run(fx: Fx): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(SCRIPT, [], {
    cwd: fx.work,
    env: { ...process.env, FBI_WORKSPACE: fx.work, FBI_RUN_ID: '1', FBI_AGENT_BRANCH: 'claude/run-1', FBI_RESULT_PATH: fx.resultPath },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

describe('fbi-resume-restore.sh', () => {
  let fx: Fx;
  beforeEach(() => { fx = setup(); });
  afterEach(() => { fs.rmSync(fx.root, { recursive: true, force: true }); });

  it('no-op when wip ref does not exist', () => {
    const r = run(fx);
    expect(r.code).toBe(0);
    // working tree unchanged
    expect(fs.readFileSync(path.join(fx.work, 'a.txt'), 'utf8')).toBe('base\n');
  });

  it('restores snapshot tree on top of claude/run-N', () => {
    // Seed a snapshot in wip.git: tree has a.txt=modified, new.txt added.
    const seed = fs.mkdtempSync(path.join(fx.root, 'seed-'));
    execFileSync('git', ['clone', fx.bare, seed]);
    g(seed, 'config', 'user.name', 'T'); g(seed, 'config', 'user.email', 't@t');
    g(seed, 'checkout', 'claude/run-1');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(seed, 'new.txt'), 'hi\n');
    g(seed, 'add', '.'); g(seed, 'commit', '-m', 'snap');
    g(seed, 'push', fx.wipRepo, '+HEAD:refs/heads/wip');

    const r = run(fx);
    expect(r.code).toBe(0);
    // a.txt overwritten, new.txt present
    expect(fs.readFileSync(path.join(fx.work, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(fs.readFileSync(path.join(fx.work, 'new.txt'), 'utf8')).toBe('hi\n');
    // HEAD is still claude/run-1 (the snapshot's parent)
    const head = g(fx.work, 'rev-parse', 'HEAD');
    expect(head).toBe(g(fx.bare, 'rev-parse', 'claude/run-1'));
  });

  it('writes resume_failed result.json when origin diverged', () => {
    // Seed an unrelated commit onto origin/claude/run-1.
    const alt = fs.mkdtempSync(path.join(fx.root, 'alt-'));
    execFileSync('git', ['clone', fx.bare, alt]);
    g(alt, 'config', 'user.name', 'T'); g(alt, 'config', 'user.email', 't@t');
    g(alt, 'checkout', 'claude/run-1');
    fs.writeFileSync(path.join(alt, 'orphan'), 'x');
    g(alt, 'add', '.'); g(alt, 'commit', '-m', 'orphan');
    g(alt, 'push', '--force', 'origin', 'claude/run-1');
    g(fx.work, 'fetch', 'origin'); // refresh local view

    // Seed a snapshot whose parent is the *old* claude/run-1 tip.
    const seed = fs.mkdtempSync(path.join(fx.root, 'seed-'));
    execFileSync('git', ['init', '--initial-branch', 'main', seed]);
    g(seed, 'config', 'user.name', 'T'); g(seed, 'config', 'user.email', 't@t');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'base\n');
    g(seed, 'add', '.'); g(seed, 'commit', '-m', 'fake-base');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'changed\n');
    g(seed, 'add', '.'); g(seed, 'commit', '-m', 'snap');
    g(seed, 'push', fx.wipRepo, '+HEAD:refs/heads/wip');

    const r = run(fx);
    expect(r.code).not.toBe(0);
    const result = JSON.parse(fs.readFileSync(fx.resultPath, 'utf8'));
    expect(result.stage).toBe('restore');
    expect(result.error).toBe('diverged');
  });
});
```

- [ ] **Step 11.2 — Run to verify failure**

Run: `npx vitest run src/server/orchestrator/fbi-resume-restore.test.ts`
Expected: FAIL — script is a stub.

- [ ] **Step 11.3 — Implement**

Replace the contents of `src/server/orchestrator/fbi-resume-restore.sh`:

```sh
#!/bin/sh
# FBI resume restore. Fetches fbi-wip and overlays the snapshot tree onto
# claude/run-N's tip (which should equal origin's). Fails loudly on
# divergence.
#
# Env vars:
#   FBI_WORKSPACE       default: /workspace
#   FBI_AGENT_BRANCH    e.g. "claude/run-42"
#   FBI_RESULT_PATH     where to write failure JSON (default: /tmp/result.json)
#   FBI_RUN_ID          logged only
set -u

WS="${FBI_WORKSPACE:-/workspace}"
cd "$WS" 2>/dev/null || exit 2
AGENT="${FBI_AGENT_BRANCH:?FBI_AGENT_BRANCH required}"
RESULT_PATH="${FBI_RESULT_PATH:-/tmp/result.json}"

# Fetch WIP.
git fetch --quiet fbi-wip 2>/dev/null || {
  # No remote wip ref — nothing to restore, exit cleanly.
  exit 0
}

if ! git rev-parse --verify -q refs/remotes/fbi-wip/wip >/dev/null; then
  # wip ref absent — fresh resume, nothing to restore.
  exit 0
fi

snap=$(git rev-parse refs/remotes/fbi-wip/wip)
parent=$(git rev-parse "${snap}^" 2>/dev/null || echo '')
if [ -z "$parent" ]; then
  printf '{"stage":"restore","error":"no-parent","snapshot_sha":"%s"}\n' "$snap" > "$RESULT_PATH"
  exit 3
fi

# Verify origin/$AGENT is an ancestor of the snapshot's parent.
if ! git merge-base --is-ancestor "origin/$AGENT" "$parent" 2>/dev/null; then
  origin_tip=$(git rev-parse "origin/$AGENT" 2>/dev/null || echo '')
  printf '{"stage":"restore","error":"diverged","parent_sha":"%s","snapshot_sha":"%s","origin_tip":"%s"}\n' \
    "$parent" "$snap" "$origin_tip" > "$RESULT_PATH"
  exit 4
fi

# Reset to the snapshot's parent (fast-forwarding past any unpushed real commits).
git reset --hard "$parent" || {
  printf '{"stage":"restore","error":"reset-failed"}\n' > "$RESULT_PATH"
  exit 5
}

# Push any unpushed real commits up to parent so origin catches up.
# This no-ops if origin/$AGENT == parent.
git push --quiet origin "$AGENT" 2>/dev/null || :

# Overlay the snapshot tree into index + working tree. HEAD stays at parent.
if ! git read-tree --reset -u "$snap" 2>/dev/null; then
  printf '{"stage":"restore","error":"read-tree-failed"}\n' > "$RESULT_PATH"
  exit 6
fi

# Success — no result.json write (supervisor.sh will write the happy-path one).
exit 0
```

- [ ] **Step 11.4 — Run tests**

```bash
npx vitest run src/server/orchestrator/fbi-resume-restore.test.ts
```

Expected: all three cases PASS.

- [ ] **Step 11.5 — Commit**

```bash
git add src/server/orchestrator/fbi-resume-restore.sh src/server/orchestrator/fbi-resume-restore.test.ts
git commit -m "feat(orchestrator): fbi-resume-restore.sh restores WIP or fails loud"
```

---

## Task 12 — `supervisor.sh`: invoke resume restore

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`

- [ ] **Step 12.1 — Call the restore script right after clone + checkout.**

In `supervisor.sh`, after the `git remote add fbi-wip ...` line and BEFORE spawning the snapshot daemon, add:

```sh
# If this is a resume, restore the WIP snapshot. The script no-ops when
# there's nothing to restore (fresh run) and exits non-zero with a
# structured /tmp/result.json when the restore can't apply cleanly.
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
  FBI_WORKSPACE=/workspace \
  FBI_AGENT_BRANCH="$AGENT_BRANCH" \
  FBI_RESULT_PATH=/tmp/result.json \
  FBI_RUN_ID="$RUN_ID" \
  /usr/local/bin/fbi-resume-restore.sh
  RESTORE_EXIT=$?
  if [ "$RESTORE_EXIT" != "0" ]; then
    echo "[fbi] resume restore failed (exit $RESTORE_EXIT); see /tmp/result.json"
    exit "$RESTORE_EXIT"
  fi
fi
```

- [ ] **Step 12.2 — Typecheck + commit**

```bash
npm run typecheck
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(orchestrator): supervisor.sh invokes resume restore on resume"
```

---

## Task 13 — Orchestrator reacts to `resume_failed` `result.json`

**Files:**
- Modify: `src/server/orchestrator/index.ts`
- Test: `src/server/orchestrator/resumeFailed.test.ts` (new)

- [ ] **Step 13.1 — Write the failing test**

Create `src/server/orchestrator/resumeFailed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyResultJson } from './result.js';
// If `result.js` doesn't exist yet, create the helper in step 13.2 below.

describe('classifyResultJson', () => {
  it('returns resume_failed when stage=="restore" and error is set', () => {
    const r = classifyResultJson(JSON.stringify({
      stage: 'restore', error: 'diverged', parent_sha: 'a', snapshot_sha: 'b', origin_tip: 'c',
    }));
    expect(r.kind).toBe('resume_failed');
    expect(r.error).toBe('diverged');
  });
  it('returns completed for normal finalize', () => {
    const r = classifyResultJson(JSON.stringify({
      exit_code: 0, push_exit: 0, head_sha: 'h', branch: 'claude/run-1', wip_sha: '',
    }));
    expect(r.kind).toBe('completed');
  });
});
```

Run: `npx vitest run src/server/orchestrator/resumeFailed.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 13.2 — Implement the classifier.**

`src/server/orchestrator/result.ts` already exists. Add to it (don't overwrite existing exports; append):

```ts
export type ResultClassification =
  | { kind: 'completed'; exit_code: number; push_exit: number; head_sha: string; branch: string; wip_sha: string }
  | { kind: 'resume_failed'; error: string; parent_sha?: string; snapshot_sha?: string; origin_tip?: string }
  | { kind: 'unparseable'; raw: string };

export function classifyResultJson(raw: string): ResultClassification {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j.stage === 'restore' && typeof j.error === 'string') {
      return {
        kind: 'resume_failed',
        error: j.error,
        parent_sha: j.parent_sha as string | undefined,
        snapshot_sha: j.snapshot_sha as string | undefined,
        origin_tip: j.origin_tip as string | undefined,
      };
    }
    if (typeof j.exit_code === 'number') {
      return {
        kind: 'completed',
        exit_code: j.exit_code as number,
        push_exit: (j.push_exit as number) ?? 0,
        head_sha: (j.head_sha as string) ?? '',
        branch: (j.branch as string) ?? '',
        wip_sha: (j.wip_sha as string) ?? '',
      };
    }
    return { kind: 'unparseable', raw };
  } catch {
    return { kind: 'unparseable', raw };
  }
}
```

- [ ] **Step 13.3 — Use it in the orchestrator.**

Find the code that reads `/tmp/result.json` after container exit (search for `result.json` in `index.ts`). Replace the ad-hoc JSON parse with `classifyResultJson`. When kind is `'resume_failed'`, call `runs.markFinished(runId, { state: 'resume_failed', error: <string describing the failure mode>, finished_at: Date.now() })`.

- [ ] **Step 13.4 — Run tests + typecheck**

```bash
npx vitest run src/server/orchestrator/resumeFailed.test.ts
npm run typecheck
```

- [ ] **Step 13.5 — Commit**

```bash
git add src/server/orchestrator/result.ts src/server/orchestrator/resumeFailed.test.ts src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): classify result.json; set resume_failed state on restore error"
```

---

## Task 14 — `fbi-history-op.sh`: `mirror-rebase` op

**Files:**
- Modify: `src/server/orchestrator/fbi-history-op.sh`
- Modify: `src/shared/types.ts` (`HistoryOp` union, already done in Task 1)
- Modify: `src/server/api/runs.ts` (dispatch)
- Modify: `src/server/orchestrator/historyOp.ts` (`buildEnv`)

- [ ] **Step 14.1 — Add the op to the script.**

In `fbi-history-op.sh`, add a new function before the final `case "$FBI_OP" in` dispatch:

```sh
run_mirror_rebase() {
    : "${FBI_BASE_BRANCH:?FBI_BASE_BRANCH required for mirror-rebase}"
    # Fetch both branches.
    if ! out=$(git -C /workspace fetch --quiet origin "$FBI_BASE_BRANCH" "$FBI_BRANCH" 2>&1); then
        emit_fail gh-error "fetch failed: $out"
        exit 0
    fi
    cd /workspace
    # Check out the agent branch and rebase it onto the user branch.
    if ! git checkout --detach "origin/$FBI_BRANCH" 2>/dev/null; then
        emit_fail gh-error "checkout branch failed"
        exit 0
    fi
    if ! out=$(git rebase "origin/$FBI_BASE_BRANCH" 2>&1); then
        git rebase --abort 2>/dev/null
        emit_fail conflict "rebase conflict: $out"
        exit 0
    fi
    rebased=$(git rev-parse HEAD)
    # Force-push the rebased agent branch.
    if ! out=$(git push --force-with-lease origin "HEAD:refs/heads/$FBI_BRANCH" 2>&1); then
        emit_fail gh-error "push agent branch failed: $out"
        exit 0
    fi
    # Now fast-forward the mirror.
    if ! out=$(git push origin "$rebased:refs/heads/$FBI_BASE_BRANCH" 2>&1); then
        emit_fail gh-error "mirror push failed: $out"
        exit 0
    fi
    emit_ok "$rebased"
}
```

In the dispatch switch at the bottom, add:

```sh
  mirror-rebase) run_mirror_rebase ;;
```

- [ ] **Step 14.2 — `buildEnv` plumbing.**

In `src/server/orchestrator/historyOp.ts`, extend `HistoryOpEnv`:

```ts
  FBI_BASE_BRANCH?: string;
```

And in `buildEnv`:

```ts
if (op.op === 'mirror-rebase') env.FBI_BASE_BRANCH = run.base_branch ?? '';
```

(Note: the existing signature of `buildEnv` may not have `run` in scope — adjust the caller or pass base_branch as an extra param. Match the surrounding style.)

- [ ] **Step 14.3 — API dispatch.**

In `src/server/api/runs.ts`, find the `/api/runs/:id/history` handler. Add the `'mirror-rebase'` op to the validation and dispatch — no op-specific args beyond the op string.

- [ ] **Step 14.4 — Unit test in `historyOp.test.ts`.**

Append:

```ts
it('parses mirror-rebase success', () => {
  const r = parseHistoryOpResult('{"ok":true,"sha":"abc"}\n', 0);
  expect(r).toEqual({ kind: 'complete', sha: 'abc' });
});
```

(It's the same parsing path; the test documents intent.)

- [ ] **Step 14.5 — Run tests + typecheck**

```bash
npx vitest run src/server/orchestrator/historyOp.test.ts
npm run typecheck
```

- [ ] **Step 14.6 — Commit**

```bash
git add src/server/orchestrator/fbi-history-op.sh src/server/orchestrator/historyOp.ts src/server/orchestrator/historyOp.test.ts src/server/api/runs.ts src/shared/types.ts
git commit -m "feat(orchestrator): mirror-rebase history op"
```

---

## Task 15 — WIP API endpoints

**Files:**
- Modify: `src/server/api/runs.ts`

- [ ] **Step 15.1 — Add the four endpoints.**

At the end of the runs route-registration function, add:

```ts
  app.get('/api/runs/:id/wip', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!deps.wipRepo.exists(id)) return { ok: false, reason: 'no-wip' };
    const snapshotSha = deps.wipRepo.snapshotSha(id);
    if (!snapshotSha) return { ok: false, reason: 'no-wip' };
    const files = deps.wipRepo.readSnapshotFiles(id);
    if (files.length === 0) return { ok: false, reason: 'no-wip' };
    const parentSha = deps.wipRepo.parentSha(id) ?? '';
    return { ok: true, snapshot_sha: snapshotSha, parent_sha: parentSha, files };
  });

  app.get('/api/runs/:id/wip/file', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const filePath = (req.query as { path?: string }).path ?? '';
    if (!filePath) return { hunks: [], truncated: false };
    return deps.wipRepo.readSnapshotDiff(id, filePath);
  });

  app.post('/api/runs/:id/wip/discard', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!deps.wipRepo.exists(id)) return reply.code(404).send({ ok: false });
    deps.wipRepo.deleteWipRef(id); // add this method to WipRepo
    return { ok: true };
  });

  app.get('/api/runs/:id/wip/patch', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!deps.wipRepo.exists(id)) return reply.code(404).send('');
    const patch = deps.wipRepo.readSnapshotPatch(id);
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="run-${id}-wip.patch"`);
    return patch;
  });
```

- [ ] **Step 15.2 — Promote `snapshotSha` to public and add `deleteWipRef`.**

In `src/server/orchestrator/wipRepo.ts`:

```ts
snapshotSha(runId: number): string | null {
  if (!this.exists(runId)) return null;
  try { return git(this.path(runId), 'rev-parse', '--verify', '-q', 'refs/heads/wip').trim() || null; }
  catch { return null; }
}

deleteWipRef(runId: number): void {
  if (!this.exists(runId)) return;
  try { execFileSync('git', ['-C', this.path(runId), 'update-ref', '-d', 'refs/heads/wip']); } catch { /* idempotent */ }
}
```

(And remove the `private` keyword in front of the existing `snapshotSha`.)

- [ ] **Step 15.3 — API test.**

Extend `src/server/api/runs.test.ts` (or create one if not present for this feature) with a small happy-path test that seeds a `wip.git` via `WipRepo` and hits `/api/runs/:id/wip` via fastify's inject.

- [ ] **Step 15.4 — Run tests + typecheck**

```bash
npx vitest run src/server/api
npm run typecheck
```

- [ ] **Step 15.5 — Commit**

```bash
git add src/server/api/runs.ts src/server/orchestrator/wipRepo.ts src/server/api/runs.test.ts
git commit -m "feat(api): /api/runs/:id/wip endpoints (files, file diff, discard, patch)"
```

---

## Task 16 — Base branch in `/changes` and ship ops

**Files:**
- Modify: `src/server/api/runs.ts`

- [ ] **Step 16.1 — `/changes`: use `run.base_branch ?? project.default_branch`.**

Search `/changes` handler for `default_branch` references. Replace the read with:

```ts
const baseBranch = run.base_branch ?? project.default_branch;
```

And use `baseBranch` wherever `project.default_branch` was used for ahead/behind/compare.

Also, in the response, set `branch_base.base = baseBranch`.

- [ ] **Step 16.2 — Ship ops: dispatcher.**

In the handler for `POST /api/runs/:id/history`, wherever the op-specific `FBI_DEFAULT` env is derived, use `run.base_branch ?? project.default_branch`.

Grep `FBI_DEFAULT=` to find all the spots.

- [ ] **Step 16.3 — Typecheck + commit**

```bash
npm run typecheck
git add src/server/api/runs.ts
git commit -m "feat(api): base_branch drives /changes + history-op dispatch"
```

---

## Task 17 — Web API client methods

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 17.1 — Add methods.**

At the end of the `api` object (or equivalent pattern in the existing file), add:

```ts
async getRunWip(id: number): Promise<{ ok: true; snapshot_sha: string; parent_sha: string; files: FilesDirtyEntry[] } | { ok: false; reason: 'no-wip' }> {
  const r = await fetch(`/api/runs/${id}/wip`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<{ ok: true; snapshot_sha: string; parent_sha: string; files: FilesDirtyEntry[] } | { ok: false; reason: 'no-wip' }>;
},
async getRunWipFile(id: number, path: string): Promise<FileDiffPayload> {
  const r = await fetch(`/api/runs/${id}/wip/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<FileDiffPayload>;
},
async discardRunWip(id: number): Promise<void> {
  const r = await fetch(`/api/runs/${id}/wip/discard`, { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
},
downloadRunWipPatch(id: number): string {
  return `/api/runs/${id}/wip/patch`;  // used as href for download
},
```

- [ ] **Step 17.2 — Typecheck + commit**

```bash
npm run typecheck
git add src/web/lib/api.ts
git commit -m "feat(web): api client methods for WIP endpoints"
```

---

## Task 18 — `WipSection` component + `ChangesTab` integration

**Files:**
- Create: `src/web/features/runs/WipSection.tsx`
- Create: `src/web/features/runs/WipSection.test.tsx`
- Modify: `src/web/features/runs/ChangesTab.tsx`

- [ ] **Step 18.1 — Write the failing test**

Create `src/web/features/runs/WipSection.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WipSection } from './WipSection.js';

describe('WipSection', () => {
  it('renders nothing when payload.ok is false', () => {
    const { container } = render(<WipSection runId={1} payload={{ ok: false, reason: 'no-wip' }} />);
    expect(container.firstChild).toBeNull();
  });
  it('renders a file list with the "Unsaved changes" header', () => {
    render(<WipSection runId={1} payload={{
      ok: true, snapshot_sha: 'abc', parent_sha: 'def',
      files: [{ path: 'a.txt', status: 'M', additions: 0, deletions: 0 }],
    }} />);
    expect(screen.getByText(/Unsaved changes/i)).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
  });
});
```

Run: `npx vitest run src/web/features/runs/WipSection.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 18.2 — Implement.**

Create `src/web/features/runs/WipSection.tsx`:

```tsx
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { DiffBlock } from '@ui/data/DiffBlock.js';
import { Pill, type PillTone } from '@ui/primitives/Pill.js';
import type { FilesDirtyEntry, FileDiffPayload } from '@shared/types.js';

export interface WipPayload {
  ok: true; snapshot_sha: string; parent_sha: string; files: FilesDirtyEntry[];
}
export type WipProps = { runId: number; payload: WipPayload | { ok: false; reason: 'no-wip' } };

const TONE: Record<string, PillTone> = { M: 'warn', A: 'ok', D: 'fail' };

export function WipSection({ runId, payload }: WipProps) {
  const [open, setOpen] = useState<Record<string, FileDiffPayload | 'loading' | 'error'>>({});
  if (!payload.ok) return null;

  const toggle = async (p: string): Promise<void> => {
    if (open[p] && open[p] !== 'loading') { setOpen((o) => { const n = { ...o }; delete n[p]; return n; }); return; }
    setOpen((o) => ({ ...o, [p]: 'loading' }));
    try { const d = await api.getRunWipFile(runId, p); setOpen((o) => ({ ...o, [p]: d })); }
    catch { setOpen((o) => ({ ...o, [p]: 'error' })); }
  };

  return (
    <div className="border-l-2 border-l-warn bg-warn-subtle/20">
      <div className="px-3 py-1.5 text-[13px] font-semibold text-text">
        Unsaved changes
        <span className="ml-2 text-[11px] font-normal text-text-faint">will be restored on resume</span>
      </div>
      {payload.files.map((f) => {
        const d = open[f.path];
        return (
          <div key={f.path}>
            <button type="button" onClick={() => void toggle(f.path)}
              className="w-full flex items-center gap-2 px-3 py-1 pl-6 text-[12px] text-left hover:bg-surface-raised border-b border-border/40">
              <Pill tone={TONE[f.status] ?? 'wait'}>{f.status}</Pill>
              <span className="font-mono text-text flex-1 truncate">{f.path}</span>
            </button>
            {d === 'loading' && <p className="px-3 py-1 pl-6 text-[11px] text-text-faint">Loading…</p>}
            {d === 'error' && <p className="px-3 py-1 pl-6 text-[11px] text-fail">Failed.</p>}
            {d && typeof d === 'object' && <DiffBlock hunks={d.hunks} truncated={d.truncated} />}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 18.3 — Integrate into `ChangesTab`.**

In `src/web/features/runs/ChangesTab.tsx`, accept a new optional prop `wip` and render below the commits if present and not null. Extend the props:

```tsx
export interface ChangesTabProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload | null;
  wip?: { ok: true; snapshot_sha: string; parent_sha: string; files: FilesDirtyEntry[] } | { ok: false; reason: 'no-wip' } | null;
}
```

Render:

```tsx
{wip && <WipSection runId={run.id} payload={wip} />}
```

Then in `RunDetail.tsx`, fetch wip via `api.getRunWip(runId)` when the run is not live (`state !== 'running' && state !== 'waiting'`) and pass the result down.

- [ ] **Step 18.4 — Run tests + typecheck**

```bash
npx vitest run src/web/features/runs/WipSection.test.tsx src/web/features/runs/ChangesTab.test.tsx
npm run typecheck
```

- [ ] **Step 18.5 — Commit**

```bash
git add src/web/features/runs/WipSection.tsx src/web/features/runs/WipSection.test.tsx src/web/features/runs/ChangesTab.tsx src/web/pages/RunDetail.tsx
git commit -m "feat(web): WipSection in Changes tab for offline WIP browsing"
```

---

## Task 19 — `MirrorStatusBanner` + `ShipTab` integration

**Files:**
- Create: `src/web/features/runs/ship/MirrorStatusBanner.tsx`
- Create: `src/web/features/runs/ship/MirrorStatusBanner.test.tsx`
- Modify: `src/web/features/runs/ship/ShipTab.tsx`

- [ ] **Step 19.1 — Write the failing test**

Create `src/web/features/runs/ship/MirrorStatusBanner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MirrorStatusBanner } from './MirrorStatusBanner.js';

describe('MirrorStatusBanner', () => {
  it('renders nothing when status is not "diverged"', () => {
    const { container } = render(
      <MirrorStatusBanner status="ok" baseBranch="feat/x" runId={1} onRebase={vi.fn()} onStop={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });
  it('renders with actions when status is "diverged"', () => {
    const onRebase = vi.fn(); const onStop = vi.fn();
    render(<MirrorStatusBanner status="diverged" baseBranch="feat/x" runId={1} onRebase={onRebase} onStop={onStop} />);
    expect(screen.getByText(/Mirror to/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /rebase/i }));
    expect(onRebase).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /stop mirroring/i }));
    expect(onStop).toHaveBeenCalled();
  });
});
```

Run to verify failure.

- [ ] **Step 19.2 — Implement**

Create `src/web/features/runs/ship/MirrorStatusBanner.tsx`:

```tsx
import type { MirrorStatus } from '@shared/types.js';

export interface MirrorStatusBannerProps {
  status: MirrorStatus;
  baseBranch: string | null;
  runId: number;
  onRebase: () => void;
  onStop: () => void;
}

export function MirrorStatusBanner({ status, baseBranch, onRebase, onStop }: MirrorStatusBannerProps) {
  if (status !== 'diverged' || !baseBranch) return null;
  return (
    <section className="px-4 py-3 border-b border-border bg-warn-subtle/20 border-l-2 border-l-warn text-[13px]">
      <div className="font-semibold text-text">⚠ Mirror to <code className="font-mono">{baseBranch}</code> is out of sync.</div>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={onRebase}
          className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Rebase & retry
        </button>
        <button type="button" onClick={onStop}
          className="text-text-faint hover:text-text">
          Stop mirroring
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 19.3 — Integrate into `ShipTab`.**

Edit `src/web/features/runs/ship/ShipTab.tsx`. Import and render at the top:

```tsx
import { MirrorStatusBanner } from './MirrorStatusBanner.js';
import { useHistoryOp } from '../useHistoryOp.js';
```

Add a `mirrorOp` hook instance; pass handlers:

```tsx
const mirror = useHistoryOp(run.id, onReload);
// ...
<MirrorStatusBanner
  status={run.mirror_status}
  baseBranch={run.base_branch}
  runId={run.id}
  onRebase={() => void mirror.run({ op: 'mirror-rebase' })}
  onStop={async () => {
    await api.clearRunBaseBranch(run.id); // add this helper — POST /api/runs/:id/stop-mirror
    onReload();
  }}
/>
```

Add the `/api/runs/:id/stop-mirror` endpoint server-side (in `src/server/api/runs.ts`) that calls `runs.setBaseBranch(id, null); runs.setMirrorStatus(id, null);` and returns `{ ok: true }`. Add the matching `api.clearRunBaseBranch(id)` web client helper.

- [ ] **Step 19.4 — Run tests + typecheck**

```bash
npx vitest run src/web/features/runs/ship/MirrorStatusBanner.test.tsx
npm run typecheck
```

- [ ] **Step 19.5 — Commit**

```bash
git add -A
git commit -m "feat(web): MirrorStatusBanner in Ship tab with rebase & stop actions"
```

---

## Task 20 — `ResumeFailedBanner` + `ChangesTab` integration

**Files:**
- Create: `src/web/features/runs/ResumeFailedBanner.tsx`
- Create: `src/web/features/runs/ResumeFailedBanner.test.tsx`
- Modify: `src/web/features/runs/ChangesTab.tsx`

- [ ] **Step 20.1 — Write the failing test**

Create `src/web/features/runs/ResumeFailedBanner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResumeFailedBanner } from './ResumeFailedBanner.js';

describe('ResumeFailedBanner', () => {
  it('renders three actions and wires handlers', () => {
    const onDownload = vi.fn(); const onDiscard = vi.fn(); const onCancel = vi.fn();
    render(<ResumeFailedBanner patchHref="/x" onDiscard={onDiscard} onCancel={onCancel} parent="abc" origin="def" />);
    expect(screen.getByText(/Couldn't restore unsaved changes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
```

Run to verify failure.

- [ ] **Step 20.2 — Implement**

Create `src/web/features/runs/ResumeFailedBanner.tsx`:

```tsx
export interface ResumeFailedBannerProps {
  patchHref: string;
  onDiscard: () => void;
  onCancel: () => void;
  parent?: string;
  origin?: string;
}

export function ResumeFailedBanner({ patchHref, onDiscard, onCancel, parent, origin }: ResumeFailedBannerProps) {
  return (
    <div className="p-3 border-b border-border bg-fail-subtle/20 border-l-2 border-l-fail text-[13px]">
      <div className="font-semibold text-text">⚠ Couldn't restore unsaved changes</div>
      <p className="mt-1 text-text-dim">
        The origin branch diverged from the snapshot's parent.
        {parent && origin && (<>  Snapshot parent: <code className="font-mono">{parent.slice(0,7)}</code>, origin tip: <code className="font-mono">{origin.slice(0,7)}</code>.</>)}
      </p>
      <div className="mt-2 flex items-center gap-3">
        <a href={patchHref} className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Download WIP as patch
        </a>
        <button type="button" onClick={onDiscard}
          className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Discard WIP and resume fresh
        </button>
        <button type="button" onClick={onCancel} className="text-text-faint hover:text-text">Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 20.3 — Integrate in `ChangesTab`.**

Render at the very top of the `ChangesTab` JSX when `run.state === 'resume_failed'`:

```tsx
{run.state === 'resume_failed' && (
  <ResumeFailedBanner
    patchHref={api.downloadRunWipPatch(run.id)}
    onDiscard={async () => { await api.discardRunWip(run.id); await api.continueRun(run.id); }}
    onCancel={() => nav(-1)}
  />
)}
```

(`nav` from react-router; import if not already.)

- [ ] **Step 20.4 — Run tests + typecheck**

```bash
npx vitest run src/web/features/runs/ResumeFailedBanner.test.tsx src/web/features/runs/ChangesTab.test.tsx
npm run typecheck
```

- [ ] **Step 20.5 — Commit**

```bash
git add -A
git commit -m "feat(web): ResumeFailedBanner for resume_failed state"
```

---

## Task 21 — Migration: first resume of legacy runs

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 21.1 — On first resume of a non-`claude/*` run, rename to `claude/run-N` server-side.**

Find `resume(runId)`. Near the top, before creating the new container, add:

```ts
const run = this.deps.runs.get(runId);
if (run && run.branch_name && !run.branch_name.startsWith('claude/run-')) {
  // Legacy run: adopt the new branch policy. The old branch on origin is
  // left untouched; we'll create claude/run-N from the same tip during
  // supervisor.sh's branch-creation step (it will resolve "branch does
  // not exist on origin" and create locally at HEAD).
  const oldBranch = run.branch_name;
  this.deps.runs.setBaseBranch(runId, oldBranch);
  this.deps.runs.update(runId, { branch_name: `claude/run-${runId}` });
  // Emit a log line into the run's log so the UI makes sense of the switch.
  const store = new LogStore(run.log_path);
  store.append(Buffer.from(`\n[fbi] migrating run to agent-owned branch claude/run-${runId}; original branch "${oldBranch}" kept as mirror target\n`));
}
```

Also: `supervisor.sh` Task 6 already handles "agent branch doesn't exist on remote → create from current HEAD", so no shell change needed.

- [ ] **Step 21.2 — Typecheck + commit**

```bash
npm run typecheck
git add -A
git commit -m "feat(orchestrator): migrate legacy runs to claude/run-N on first resume"
```

---

## Task 22 — End-to-end verification

- [ ] **Step 22.1 — Start the dev server.**

```bash
scripts/dev.sh
```

- [ ] **Step 22.2 — Verify fresh-run path.**

1. Create a new project or pick an existing one. Start a fresh run.
2. Confirm the container is created; `docker inspect` shows a bind for `wip.git`.
3. Let the agent make a commit; `git log` on the bare wip repo on the host shows snapshots appearing every ~30 s.
4. Finalize the run. `result.json` contains `wip_sha`.

- [ ] **Step 22.3 — Verify resume restore.**

1. Start a run; make uncommitted changes (e.g., have Claude create a file it doesn't commit).
2. `docker kill` the container mid-run.
3. Click "Continue". The new container restores the file.
4. Confirm the agent's working tree shows the un-stashed file on resume.

- [ ] **Step 22.4 — Verify resume-failed UI.**

1. Start a run; let it make one commit.
2. On the host, force-push origin/claude/run-N to an unrelated SHA: `git push --force origin <other>:claude/run-N`.
3. Click "Continue". The run should land in `resume_failed` state.
4. Changes tab shows the `ResumeFailedBanner` with three actions. Click "Discard WIP and resume fresh"; verify a new container starts and the banner goes away.

- [ ] **Step 22.5 — Verify mirror.**

1. Start a run against a feature branch (e.g., set `FBI_CHECKOUT_BRANCH=terminal-robust-redesign` via the UI's "branch" option).
2. Let it commit. Confirm the commit lands on both `origin/claude/run-N` and `origin/terminal-robust-redesign`.
3. Externally push an unrelated commit to `origin/terminal-robust-redesign`.
4. Have Claude make another commit. The primary push succeeds; the mirror push fails.
5. Ship tab shows the yellow `MirrorStatusBanner`. Click "Rebase & retry"; verify mirror reattaches.

- [ ] **Step 22.6 — Final sweep**

```bash
npm run typecheck
npm test -- --run
npm run build:server
```

Expected: all green. The build step should produce `dist/server/orchestrator/fbi-wip-snapshot.sh` and `dist/server/orchestrator/fbi-resume-restore.sh`.

- [ ] **Step 22.7 — Commit any fallout**

```bash
git status
git add -A
git commit -m "chore: verification pass"
```

---

## Spec Coverage Checklist

- [x] Spec §Problem → addressed by the two-space model (Tasks 2–11).
- [x] Spec §Goals #1 (failure mode impossible) — Task 6 pre-creates claude/run-N; post-commit push is always fast-forward; Task 8 moves mirror failures out of the primary push path.
- [x] Spec §Goals #2 (persistence) — Tasks 3, 7, 10.
- [x] Spec §Goals #3 (mirror) — Tasks 8, 9, 14, 19.
- [x] Spec §Goals #4 (UI surface) — Tasks 15, 17, 18, 20.
- [x] Spec §Goals #5 (fail loud) — Tasks 11, 13, 20.
- [x] Spec §Branch Policy (claude/run-N, mirror) — Task 6, 8.
- [x] Spec §DB schema additions — Task 1.
- [x] Spec §Migration for existing runs — Task 21.
- [x] Spec §Components §wipRepo.ts — Task 2.
- [x] Spec §Components §fbi-wip-snapshot.sh — Task 3.
- [x] Spec §Components §Snapshot daemon — Task 7.
- [x] Spec §Data Flow §Run-start — Tasks 5, 6, 7.
- [x] Spec §Data Flow §During the run — Task 8.
- [x] Spec §Data Flow §Clean finalize — Task 10.
- [x] Spec §Data Flow §Resume — Tasks 11, 12, 13.
- [x] Spec §Data Flow §Resume-failure UI — Task 20.
- [x] Spec §Data Flow §Delete run — Task 5 (wipRepo.remove on delete).
- [x] Spec §Error Handling — covered throughout (Tasks 3, 7, 9, 11, 13).
- [x] Spec §Testing — every task ships unit/shell/web tests as appropriate.
