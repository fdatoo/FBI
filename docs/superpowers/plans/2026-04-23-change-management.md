# Change Management Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate Files + GitHub tabs into a commit-tree-rooted "Changes" tab, retire the gh-CLI merge path in favor of raw git operations, and add rebase/sync/squash/agent-polish operations with a project-level default merge strategy.

**Architecture:** Single `POST /api/runs/:id/history` endpoint dispatches four ops (`merge`/`sync`/`squash-local`/`polish`) to raw git — via `docker exec` in live containers, a transient `--rm` container for finished runs, or an agent sub-run on conflict/polish. Single `GET /api/runs/:id/changes` endpoint returns a unified payload (commits + uncommitted + integrations). Web `ChangesTab` replaces `FilesTab` + `GithubTab`.

**Tech Stack:** TypeScript, Fastify, dockerode, better-sqlite3, React, Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-04-23-change-management-design.md`

---

## File map

### New files
- `src/server/orchestrator/fbi-history-op.sh` — container-side shell dispatcher for all history ops
- `src/server/orchestrator/historyOp.ts` — typed op dispatcher (live + transient paths)
- `src/server/orchestrator/historyOp.test.ts` — unit tests
- `src/web/features/runs/ChangesTab.tsx` — unified replacement for FilesTab + GithubTab
- `src/web/features/runs/ChangesTab.test.tsx` — tests
- `src/web/features/runs/ChangesHeader.tsx` — action bar + ⋮ menu
- `src/web/features/runs/IntegrationStrip.tsx` — compact GitHub PR + CI summary
- `src/web/features/runs/CommitRow.tsx` — expandable commit node
- `src/web/features/runs/useHistoryOp.ts` — hook for posting history ops + navigation

### Modified files
- `src/shared/types.ts` — add `default_merge_strategy` on Project; `kind` / `kind_args_json` on Run; add `ChangesPayload`, `ChangeCommit`, `MergeStrategy`, `HistoryOp*`, `HistoryResult`
- `src/server/db/index.ts` — migrations for new columns
- `src/server/db/schema.sql` — new columns
- `src/server/db/projects.ts` — read/write `default_merge_strategy`
- `src/server/db/runs.ts` — `create()` accepts `parent_run_id` / `kind` / `kind_args_json`
- `src/server/github/gh.ts` — delete `mergeBranch()`
- `src/server/api/runs.ts` — delete `/github/merge`, `/files`, `/github`; add `/history`, `/changes`, `/commits/:sha/files`
- `src/server/orchestrator/index.ts` — add `execHistoryOp()` method; keep `execInContainer`; keep `GitStateWatcher`
- `src/server/orchestrator/snapshotScripts.ts` — also copy `fbi-history-op.sh`
- `src/server/logs/registry.ts` — replace `RunWsFilesMessage` with `RunWsChangesMessage`
- `src/web/lib/api.ts` — delete `mergeRunBranch`, `getRunFiles`; add `getRunChanges`, `getRunCommitFiles`, `postHistoryOp`
- `src/web/ui/primitives/Menu.tsx` — add grouped sections + checkmark support
- `src/web/features/runs/RunDrawer.tsx` — tab set `changes · tunnel · meta`
- `src/web/pages/RunDetail.tsx` — replace files+github polling/subscription with changes
- `src/web/pages/EditProject.tsx` — add default-merge-strategy dropdown
- `src/web/features/runs/usageBus.ts` — `publishFiles` → `publishChanges`
- `src/web/components/Terminal.tsx` — `publishFiles` → `publishChanges`

### Deleted files
- `src/web/features/runs/FilesTab.tsx`
- `src/web/features/runs/FilesTab.test.tsx`
- `src/web/features/runs/GithubTab.tsx`
- `src/web/features/runs/GithubTab.test.tsx`

---

## Task 1 — Types + DB migration

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts`
- Modify: `src/server/db/projects.ts`
- Modify: `src/server/db/runs.ts`

- [ ] **Step 1.1 — Add types**

In `src/shared/types.ts`:

Extend `Project` (after `pids_limit`):
```ts
default_merge_strategy: 'merge' | 'rebase' | 'squash';
```

Extend `Run` (after `parent_run_id`):
```ts
kind: 'work' | 'merge-conflict' | 'polish';
kind_args_json: string | null;
```

Add near the other exports:
```ts
export type MergeStrategy = 'merge' | 'rebase' | 'squash';

export type HistoryOp =
  | { op: 'merge'; strategy?: MergeStrategy }
  | { op: 'sync' }
  | { op: 'squash-local'; subject: string }
  | { op: 'polish' };

export type HistoryResult =
  | { kind: 'complete'; sha?: string }
  | { kind: 'agent'; child_run_id: number }
  | { kind: 'conflict'; child_run_id: number }
  | { kind: 'agent-busy' }
  | { kind: 'invalid'; message: string }
  | { kind: 'git-unavailable' };

export interface ChangeCommit {
  sha: string;
  subject: string;
  committed_at: number;
  pushed: boolean;
  files: FilesHeadEntry[];
  files_loaded: boolean;
}

export interface ChangesPayload {
  branch_name: string | null;
  branch_base: { base: string; ahead: number; behind: number } | null;
  commits: ChangeCommit[];
  uncommitted: FilesDirtyEntry[];
  integrations: {
    github?: {
      pr: { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string } | null;
      checks: {
        state: 'pending' | 'success' | 'failure';
        passed: number;
        failed: number;
        total: number;
        items: GithubCheckItem[];
      } | null;
    };
  };
}

export type RunWsChangesMessage = { type: 'changes' } & ChangesPayload;
```

**Delete** the old `RunWsFilesMessage` export. (It's renamed to `RunWsChangesMessage` with a slightly different shape.)

- [ ] **Step 1.2 — Schema updates**

In `src/server/db/schema.sql`, inside `CREATE TABLE projects`, after `pids_limit INTEGER`:
```sql
,
default_merge_strategy TEXT NOT NULL DEFAULT 'squash'
  CHECK (default_merge_strategy IN ('merge', 'rebase', 'squash'))
```

Inside `CREATE TABLE runs`, after `parent_run_id`:
```sql
,
kind TEXT NOT NULL DEFAULT 'work'
  CHECK (kind IN ('work', 'merge-conflict', 'polish')),
kind_args_json TEXT
```

- [ ] **Step 1.3 — Migrations**

In `src/server/db/index.ts` `migrate()`, after the existing `parent_run_id` block, append:

```ts
  // Project column: default_merge_strategy. Existing projects default to
  // 'merge' (preserves today's PR-merge-commit semantics); new projects get
  // 'squash' from the schema default.
  const projCols2 = new Set(
    (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>)
      .map((r) => r.name)
  );
  if (!projCols2.has('default_merge_strategy')) {
    db.exec(`ALTER TABLE projects ADD COLUMN default_merge_strategy TEXT NOT NULL DEFAULT 'merge' CHECK (default_merge_strategy IN ('merge', 'rebase', 'squash'))`);
  }
  if (!runCols.has('kind')) {
    db.exec(`ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'merge-conflict', 'polish'))`);
  }
  if (!runCols.has('kind_args_json')) {
    db.exec('ALTER TABLE runs ADD COLUMN kind_args_json TEXT');
  }
```

- [ ] **Step 1.4 — ProjectsRepo mapping**

In `src/server/db/projects.ts`:

Add to `ProjectRow`:
```ts
default_merge_strategy: 'merge' | 'rebase' | 'squash';
```

Add to `fromRow()` return:
```ts
default_merge_strategy: row.default_merge_strategy,
```

Add to `CreateProjectInput`:
```ts
default_merge_strategy?: 'merge' | 'rebase' | 'squash';
```

Update `create()` insert SQL + bindings (add the column and parameter):
```ts
// in the INSERT columns list (add after pids_limit,):
default_merge_strategy,
// in VALUES clause:
@default_merge_strategy,
// in stmt.run() params:
default_merge_strategy: input.default_merge_strategy ?? 'squash',
```

Update `update()` SQL + binding similarly:
```ts
// in SET list:
default_merge_strategy=@default_merge_strategy,
// in params:
default_merge_strategy: merged.default_merge_strategy,
```

- [ ] **Step 1.5 — RunsRepo create() accepts sub-run fields**

In `src/server/db/runs.ts`:

Extend `CreateRunInput`:
```ts
parent_run_id?: number;
kind?: 'work' | 'merge-conflict' | 'polish';
kind_args_json?: string;
```

Update `create()` insert:
```ts
const stub = this.db
  .prepare(
    `INSERT INTO runs (project_id, prompt, branch_name, state, log_path,
                       created_at, state_entered_at,
                       parent_run_id, kind, kind_args_json)
     VALUES (?, ?, ?, 'queued', '', ?, ?, ?, ?, ?)`
  )
  .run(
    input.project_id, input.prompt, branchHint, now, now,
    input.parent_run_id ?? null,
    input.kind ?? 'work',
    input.kind_args_json ?? null,
  );
```

(Confirm the existing insert shape — it currently writes `created_at` and `state_entered_at`; preserve those.)

- [ ] **Step 1.6 — Typecheck + test**

```
npm run typecheck
npm test -- --run src/server/db
```
Both should pass. Web tests will break temporarily (Run fixtures missing new fields) — that's fine; Task 2 covers it.

- [ ] **Step 1.7 — Commit**

```
git add -A
git commit -m "feat(types): default_merge_strategy on projects; kind+kind_args_json on runs; ChangesPayload"
```

---

## Task 2 — Update web Run fixtures

**Files:**
- Modify: every `*.test.tsx` / `*.test.ts` file that builds a `Run` literal

- [ ] **Step 2.1 — Find fixtures**

```
grep -rln "title_locked: 0" src/web
```

- [ ] **Step 2.2 — Add fields to each**

In each match, after `title_locked: 0,` append `kind: 'work', kind_args_json: null,`. `parent_run_id: null` is already there from a prior spec.

Files to update (known): `src/web/features/runs/RunUsage.test.tsx`, `src/web/features/runs/RunRow.test.tsx`, `src/web/features/runs/MetaTab.test.tsx`, `src/web/features/projects/ProjectList.test.tsx`, `src/web/features/runs/RunsList.test.tsx`, `src/web/features/runs/useRunsView.test.ts`, `src/web/hooks/useRunWatcher.test.tsx`.

Also find and update Project fixtures (`repo_url: 'r'` search), adding `default_merge_strategy: 'squash' as const,`:
```
grep -rln "devcontainer_override_json: null, instructions: null," src/web
```

- [ ] **Step 2.3 — Verify**

```
npm run typecheck
npm test -- --run
```
All pass. Commit.

```
git add -A
git commit -m "test(fixtures): add kind + default_merge_strategy to Run/Project literals"
```

---

## Task 3 — The history-op shell script

**Files:**
- Create: `src/server/orchestrator/fbi-history-op.sh`

- [ ] **Step 3.1 — Write script**

```sh
#!/usr/bin/env bash
# FBI history operation runner. Invoked inside a container (either a live run
# container via `docker exec` or a transient --rm container) to perform one
# git operation on behalf of the server.
#
# Env vars (required):
#   FBI_OP            one of: merge | sync | squash-local
#   FBI_BRANCH        branch name the operation targets (e.g. feat/x)
#   FBI_DEFAULT       default branch (e.g. main)
# Op-specific:
#   FBI_STRATEGY      for op=merge: merge | rebase | squash
#   FBI_SUBJECT       for op=squash-local or op=merge/strategy=squash: commit msg
#   FBI_RUN_ID        run id, for commit messages
#
# Output contract: write to stdout a single JSON line:
#   {"ok":true,"sha":"...","message":""}
#   {"ok":false,"reason":"conflict|gh-error","message":"..."}
# Non-zero exit on unexpected errors.

set -uo pipefail

: "${FBI_OP:?FBI_OP required}"
: "${FBI_BRANCH:?FBI_BRANCH required}"
: "${FBI_DEFAULT:?FBI_DEFAULT required}"

cd /workspace || { echo '{"ok":false,"reason":"gh-error","message":"no /workspace"}'; exit 2; }

emit() { printf '%s\n' "$1"; }

abort_and_exit() {
  local reason="$1"; local msg="$2"
  git merge --abort >/dev/null 2>&1 || true
  git rebase --abort >/dev/null 2>&1 || true
  emit "{\"ok\":false,\"reason\":\"${reason}\",\"message\":\"${msg//\"/\\\"}\"}"
  exit 0
}

run_merge() {
  local strategy="${FBI_STRATEGY:-merge}"
  git fetch origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "fetch failed"
  case "$strategy" in
    merge)
      git checkout "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "checkout default failed"
      git pull --ff-only origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "pull --ff-only failed"
      if ! git merge --no-ff "origin/$FBI_BRANCH" 2>&1; then abort_and_exit conflict "merge conflict"; fi
      git push origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "push failed"
      ;;
    rebase)
      git checkout "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "checkout branch failed"
      if ! git rebase "origin/$FBI_DEFAULT" 2>&1; then abort_and_exit conflict "rebase conflict"; fi
      git push --force-with-lease origin "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "force-push branch failed"
      git checkout "$FBI_DEFAULT" 2>&1
      git pull --ff-only origin "$FBI_DEFAULT" 2>&1
      git merge --ff-only "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "ff-merge failed"
      git push origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "push failed"
      ;;
    squash)
      local subject="${FBI_SUBJECT:-Merge branch $FBI_BRANCH (FBI run ${FBI_RUN_ID:-?})}"
      git checkout "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "checkout default failed"
      git pull --ff-only origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "pull --ff-only failed"
      if ! git merge --squash "origin/$FBI_BRANCH" 2>&1; then abort_and_exit conflict "squash conflict"; fi
      git commit -m "$subject" 2>&1 || abort_and_exit gh-error "commit failed"
      git push origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "push failed"
      ;;
    *) abort_and_exit gh-error "unknown strategy $strategy" ;;
  esac
  local sha
  sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
  emit "{\"ok\":true,\"sha\":\"$sha\",\"message\":\"\"}"
}

run_sync() {
  git fetch origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "fetch failed"
  git checkout "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "checkout branch failed"
  if ! git rebase "origin/$FBI_DEFAULT" 2>&1; then abort_and_exit conflict "rebase conflict"; fi
  git push --force-with-lease origin "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "force-push failed"
  local sha
  sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
  emit "{\"ok\":true,\"sha\":\"$sha\",\"message\":\"\"}"
}

run_squash_local() {
  : "${FBI_SUBJECT:?FBI_SUBJECT required for squash-local}"
  git fetch origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "fetch failed"
  git checkout "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "checkout branch failed"
  local base
  base="$(git merge-base HEAD "origin/$FBI_DEFAULT" 2>/dev/null)" || abort_and_exit gh-error "merge-base failed"
  git reset --soft "$base" 2>&1 || abort_and_exit gh-error "reset failed"
  git commit -m "$FBI_SUBJECT" 2>&1 || abort_and_exit gh-error "commit failed"
  git push --force-with-lease origin "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "force-push failed"
  local sha
  sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
  emit "{\"ok\":true,\"sha\":\"$sha\",\"message\":\"\"}"
}

case "$FBI_OP" in
  merge) run_merge ;;
  sync) run_sync ;;
  squash-local) run_squash_local ;;
  *) emit "{\"ok\":false,\"reason\":\"gh-error\",\"message\":\"unknown op $FBI_OP\"}"; exit 2 ;;
esac
```

- [ ] **Step 3.2 — Syntax check**

```
bash -n src/server/orchestrator/fbi-history-op.sh
```
Should print nothing.

- [ ] **Step 3.3 — Bundle it**

In `src/server/orchestrator/snapshotScripts.ts`, extend the signature:
```ts
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

In `src/server/orchestrator/index.ts`, near the other script constants (around line 40):
```ts
const HISTORY_OP = path.join(HERE, 'fbi-history-op.sh');
```

Update the `snapshotScripts()` callsite in `ensureScriptsDir()` to pass it:
```ts
snapshotScripts(dir, SUPERVISOR, FINALIZE_BRANCH, HISTORY_OP);
```

Update the run container's binds (in `createContainerForRun`) to mount the history-op script:
```ts
`${path.join(scriptsDir, 'fbi-history-op.sh')}:/usr/local/bin/fbi-history-op.sh:ro`,
```

- [ ] **Step 3.4 — Commit**

```
git add -A
git commit -m "feat(orchestrator): fbi-history-op.sh + bundle in container"
```

---

## Task 4 — `executeHistoryOp` helper (live path)

**Files:**
- Create: `src/server/orchestrator/historyOp.ts`
- Create: `src/server/orchestrator/historyOp.test.ts`

- [ ] **Step 4.1 — Test**

```ts
// src/server/orchestrator/historyOp.test.ts
import { describe, it, expect, vi } from 'vitest';
import { parseHistoryOpResult } from './historyOp.js';

describe('parseHistoryOpResult', () => {
  it('parses successful completion', () => {
    const r = parseHistoryOpResult('{"ok":true,"sha":"deadbeef","message":""}\n', 0);
    expect(r).toEqual({ kind: 'complete', sha: 'deadbeef' });
  });
  it('parses conflict', () => {
    const r = parseHistoryOpResult('{"ok":false,"reason":"conflict","message":"merge conflict"}\n', 0);
    expect(r).toEqual({ kind: 'conflict-detected', message: 'merge conflict' });
  });
  it('parses gh-error', () => {
    const r = parseHistoryOpResult('{"ok":false,"reason":"gh-error","message":"push failed"}\n', 0);
    expect(r).toEqual({ kind: 'gh-error', message: 'push failed' });
  });
  it('treats non-zero exit as gh-error when no JSON', () => {
    const r = parseHistoryOpResult('', 2);
    expect(r).toEqual({ kind: 'gh-error', message: 'exit code 2' });
  });
  it('handles multi-line output by taking the last JSON line', () => {
    const r = parseHistoryOpResult('progress…\n{"ok":true,"sha":"abc"}\n', 0);
    expect(r).toEqual({ kind: 'complete', sha: 'abc' });
  });
});
```

- [ ] **Step 4.2 — Implement**

```ts
// src/server/orchestrator/historyOp.ts
import type Docker from 'dockerode';
import { dockerExec } from './dockerExec.js';
import type { HistoryOp } from '../../shared/types.js';

export type ParsedOpResult =
  | { kind: 'complete'; sha: string }
  | { kind: 'conflict-detected'; message: string }
  | { kind: 'gh-error'; message: string };

export function parseHistoryOpResult(stdout: string, exitCode: number): ParsedOpResult {
  const lines = stdout.trim().split('\n').filter((l) => l.startsWith('{') && l.endsWith('}'));
  const last = lines.at(-1);
  if (!last) {
    return { kind: 'gh-error', message: `exit code ${exitCode}` };
  }
  try {
    const obj = JSON.parse(last) as { ok?: boolean; sha?: string; reason?: string; message?: string };
    if (obj.ok && typeof obj.sha === 'string') return { kind: 'complete', sha: obj.sha };
    if (obj.reason === 'conflict') return { kind: 'conflict-detected', message: obj.message ?? '' };
    return { kind: 'gh-error', message: obj.message ?? obj.reason ?? 'unknown' };
  } catch {
    return { kind: 'gh-error', message: `unparseable output: ${last.slice(0, 120)}` };
  }
}

export interface HistoryOpEnv {
  FBI_OP: string;
  FBI_BRANCH: string;
  FBI_DEFAULT: string;
  FBI_STRATEGY?: string;
  FBI_SUBJECT?: string;
  FBI_RUN_ID?: string;
}

export function buildEnv(runId: number, branch: string, defaultBranch: string, op: HistoryOp): HistoryOpEnv {
  const env: HistoryOpEnv = {
    FBI_OP: op.op,
    FBI_BRANCH: branch,
    FBI_DEFAULT: defaultBranch,
    FBI_RUN_ID: String(runId),
  };
  if (op.op === 'merge') env.FBI_STRATEGY = op.strategy ?? 'merge';
  if (op.op === 'merge' && op.strategy === 'squash') env.FBI_SUBJECT = `Merge branch '${branch}' (FBI run #${runId})`;
  if (op.op === 'squash-local') env.FBI_SUBJECT = op.subject;
  return env;
}

export async function runHistoryOpInContainer(
  container: Docker.Container,
  env: HistoryOpEnv,
  opts: { timeoutMs?: number } = {},
): Promise<ParsedOpResult> {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  // docker exec with env vars: the exec API accepts Env as an array.
  const { stdout, exitCode } = await dockerExec(
    container,
    ['/usr/local/bin/fbi-history-op.sh'],
    {
      timeoutMs: opts.timeoutMs ?? 60_000,
      env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    },
  );
  return parseHistoryOpResult(stdout, exitCode);
}
```

This requires `dockerExec` to accept an `env` option. Update `src/server/orchestrator/dockerExec.ts`:

```ts
export interface DockerExecOptions {
  timeoutMs?: number;
  workingDir?: string;
  env?: string[];
}
```

And in the `container.exec({...})` call, pass `Env: opts.env` when provided:
```ts
const exec = await container.exec({
  Cmd: cmd,
  AttachStdout: true,
  AttachStderr: true,
  ...(workingDir ? { WorkingDir: workingDir } : {}),
  ...(opts.env ? { Env: opts.env } : {}),
});
```

- [ ] **Step 4.3 — Run tests**

```
npm test -- --run src/server/orchestrator/historyOp.test.ts src/server/orchestrator/dockerExec.test.ts
```
Expect pass.

- [ ] **Step 4.4 — Commit**

```
git add -A
git commit -m "feat(orchestrator): parseHistoryOpResult + runHistoryOpInContainer"
```

---

## Task 5 — Transient merge container

**Files:**
- Modify: `src/server/orchestrator/historyOp.ts`
- Modify: `src/server/orchestrator/historyOp.test.ts`
- Modify: `src/server/orchestrator/index.ts` (expose helpers)

- [ ] **Step 5.1 — Test**

Append to `historyOp.test.ts`:

```ts
import { runHistoryOpInTransientContainer } from './historyOp.js';
import { PassThrough } from 'node:stream';

function frame(type: 1 | 2, payload: Buffer): Buffer {
  const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

describe('runHistoryOpInTransientContainer', () => {
  it('creates, runs, parses output, and removes the container', async () => {
    const logsStream = new PassThrough();
    setTimeout(() => {
      logsStream.write(frame(1, Buffer.from('{"ok":true,"sha":"cafebabe"}\n')));
      logsStream.end();
    }, 5);
    const container = {
      id: 'x',
      start: vi.fn().mockResolvedValue(undefined),
      logs: vi.fn().mockResolvedValue(logsStream),
      wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const docker = { createContainer: vi.fn().mockResolvedValue(container) };

    const r = await runHistoryOpInTransientContainer({
      docker: docker as never,
      image: 'ghcr.io/fynn-labs/fbi-git-base:latest',
      repoUrl: 'git@github.com:me/foo.git',
      env: { FBI_OP: 'sync', FBI_BRANCH: 'feat/x', FBI_DEFAULT: 'main', FBI_RUN_ID: '1' },
      sshSocket: '/tmp/sock',
      authorName: 'a', authorEmail: 'a@b', timeoutMs: 10_000,
    });

    expect(r).toEqual({ kind: 'complete', sha: 'cafebabe' });
    expect(container.remove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5.2 — Implement**

Append to `historyOp.ts`:

```ts
import type Docker from 'dockerode';

export interface TransientOpInput {
  docker: Docker;
  image: string;
  repoUrl: string;
  env: HistoryOpEnv;
  sshSocket: string;
  authorName: string;
  authorEmail: string;
  timeoutMs?: number;
}

export async function runHistoryOpInTransientContainer(
  input: TransientOpInput,
): Promise<ParsedOpResult> {
  const { docker, image, repoUrl, env, sshSocket, authorName, authorEmail, timeoutMs = 120_000 } = input;
  const name = `fbi-history-${env.FBI_RUN_ID}-${Date.now()}`;
  const envList = [
    `REPO_URL=${repoUrl}`,
    `GIT_AUTHOR_NAME=${authorName}`,
    `GIT_AUTHOR_EMAIL=${authorEmail}`,
    `SSH_AUTH_SOCK=/ssh-agent`,
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
  ];
  // Container does: clone repo into /workspace, then run the history op script.
  const cmd = [
    '/bin/sh', '-c',
    [
      'set -e',
      'cd /workspace',
      'git clone --quiet "$REPO_URL" . >/dev/null 2>&1',
      'git config user.name  "$GIT_AUTHOR_NAME"',
      'git config user.email "$GIT_AUTHOR_EMAIL"',
      '/usr/local/bin/fbi-history-op.sh',
    ].join('; '),
  ];
  const container = await docker.createContainer({
    Image: image,
    name,
    User: 'agent',
    Env: envList,
    Cmd: cmd,
    Tty: false,
    HostConfig: {
      AutoRemove: false,
      Binds: [
        `${sshSocket}:/ssh-agent`,
        `${process.env.FBI_HISTORY_OP_SH ?? '/usr/local/bin/fbi-history-op.sh'}:/usr/local/bin/fbi-history-op.sh:ro`,
      ],
    },
    WorkingDir: '/workspace',
  });

  const timer = setTimeout(() => { container.kill().catch(() => { /* */ }); }, timeoutMs);
  try {
    await container.start();
    const logsStream = await container.logs({ follow: true, stdout: true, stderr: true }) as unknown as NodeJS.ReadableStream;
    const outChunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      logsStream.on('data', (d: Buffer) => {
        buf = buf.length === 0 ? Buffer.from(d) : Buffer.concat([buf, d]);
        while (buf.length >= 8) {
          const kind = buf[0];
          const size = buf.readUInt32BE(4);
          if (buf.length < 8 + size) break;
          const payload = Buffer.from(buf.subarray(8, 8 + size));
          if (kind === 1) outChunks.push(payload);
          buf = Buffer.from(buf.subarray(8 + size));
        }
      });
      logsStream.on('end', () => resolve());
      logsStream.on('error', reject);
    });
    const result = await container.wait();
    return parseHistoryOpResult(Buffer.concat(outChunks).toString('utf8'), result.StatusCode ?? -1);
  } finally {
    clearTimeout(timer);
    await container.remove({ force: true, v: true }).catch(() => { /* */ });
  }
}
```

- [ ] **Step 5.3 — Expose from orchestrator**

In `src/server/orchestrator/index.ts`, add method (alongside `execInContainer`):

```ts
async execHistoryOp(runId: number, op: HistoryOp): Promise<ParsedOpResult> {
  const run = this.deps.runs.get(runId);
  if (!run) throw new Error('run not found');
  if (!run.branch_name) throw new Error('run has no branch');
  const project = this.deps.projects.get(run.project_id);
  if (!project) throw new Error('project missing');
  const env = buildEnv(runId, run.branch_name, project.default_branch, op);

  const active = this.active.get(runId);
  if (active) {
    return runHistoryOpInContainer(active.container, env);
  }
  // Finished run: transient container.
  const image = await this.imageBuilder.resolveByProjectId(project.id).catch(() => null);
  return runHistoryOpInTransientContainer({
    docker: this.deps.docker,
    image: image ?? 'ghcr.io/fynn-labs/fbi-git-base:latest',
    repoUrl: project.repo_url,
    env,
    sshSocket: this.deps.config.hostSshAuthSock,
    authorName: project.git_author_name ?? this.deps.config.gitAuthorName,
    authorEmail: project.git_author_email ?? this.deps.config.gitAuthorEmail,
  });
}
```

Import the helpers at the top of `index.ts`:
```ts
import { buildEnv, runHistoryOpInContainer, runHistoryOpInTransientContainer, type ParsedOpResult } from './historyOp.js';
import type { HistoryOp } from '../../shared/types.js';
```

Add `resolveByProjectId` to `ImageBuilder` (a reasonable behavior: look up cached image for project from settings / convention). If that method doesn't exist, skip the lookup and always use the base image:
```ts
// If ImageBuilder has no resolveByProjectId, fall back to base image directly:
const image = 'ghcr.io/fynn-labs/fbi-git-base:latest';
```

Choose the simpler path: use the base image always. Simpler to implement, predictable behavior. Update the method body to drop the lookup.

- [ ] **Step 5.4 — Run tests**

```
npm test -- --run src/server/orchestrator/historyOp.test.ts
```

- [ ] **Step 5.5 — Commit**

```
git add -A
git commit -m "feat(orchestrator): transient container for history ops; execHistoryOp method"
```

---

## Task 6 — Sub-run spawn helper

**Files:**
- Modify: `src/server/orchestrator/index.ts` (add `spawnSubRun`)

- [ ] **Step 6.1 — Implement**

In `src/server/orchestrator/index.ts`, add a method on the `Orchestrator` class:

```ts
/** Spawn a sub-run for merge-conflict resolution or commit polish.
 *  Inherits parent's project + branch; launches normally via launch(). */
async spawnSubRun(parentRunId: number, kind: 'merge-conflict' | 'polish', argsJson: string): Promise<number> {
  const parent = this.deps.runs.get(parentRunId);
  if (!parent) throw new Error(`parent run ${parentRunId} not found`);
  const prompt = renderSubRunPrompt(kind, parent, JSON.parse(argsJson) as Record<string, unknown>);
  const child = this.deps.runs.create({
    project_id: parent.project_id,
    prompt,
    branch_hint: parent.branch_name || undefined,
    log_path_tmpl: (id) => path.join(this.deps.config.runsDir, `${id}.log`),
    parent_run_id: parent.id,
    kind,
    kind_args_json: argsJson,
  });
  // Fire-and-forget — same pattern as POST /api/projects/:id/runs.
  void this.launch(child.id).catch((err) => {
    // swallow — the sub-run's log will record the failure
  });
  return child.id;
}

private static readonly SUB_RUN_TEMPLATES = {
  'merge-conflict': (p: Run, a: { branch: string; default: string; strategy: string }) =>
    `Resolve a merge conflict and complete the merge.\n` +
    `Branch: ${a.branch}\nTarget: ${a.default}\nStrategy: ${a.strategy}\n\n` +
    `Steps:\n` +
    `1. git fetch origin\n` +
    `2. git checkout ${a.default}\n` +
    `3. git pull --ff-only origin ${a.default}\n` +
    `4. git merge --no-ff ${a.branch}  (or --squash / rebase per strategy)\n` +
    `5. If conflicts: resolve them, git add, git commit.\n` +
    `6. git push origin ${a.default}\n` +
    `Report the final SHA when done.`,
  'polish': (p: Run, a: { branch: string; default: string }) =>
    `Polish the commits on branch ${a.branch}.\n\n` +
    `Use git interactive rebase (GIT_SEQUENCE_EDITOR=cat git rebase -i origin/${a.default}) to:\n` +
    `  1. Rewrite each commit's subject as a concise conventional-commits style summary.\n` +
    `  2. Ensure each commit body explains the "why" (not just the "what").\n` +
    `  3. Combine trivially-related "wip:" or "fix:" commits where appropriate.\n` +
    `DO NOT change code — only commit metadata.\n\n` +
    `Then: git push --force-with-lease origin ${a.branch}.\n` +
    `Write a one-line summary of what you did to /fbi-state/session-name.`,
} as const;

function renderSubRunPrompt(kind: 'merge-conflict' | 'polish', parent: Run, args: Record<string, unknown>): string {
  const tmpl = Orchestrator.SUB_RUN_TEMPLATES[kind];
  // Cast is safe: callers pass the shape expected by each template.
  return tmpl(parent, args as never);
}
```

- [ ] **Step 6.2 — Typecheck + smoke test**

```
npm run typecheck
```

No dedicated tests for this method since it's a thin wrapper over `runs.create` + `launch`. It'll be covered by integration tests of the history endpoint.

- [ ] **Step 6.3 — Commit**

```
git add -A
git commit -m "feat(orchestrator): spawnSubRun for merge-conflict / polish"
```

---

## Task 7 — `/api/runs/:id/history` endpoint

**Files:**
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/api/runs.test.ts`

- [ ] **Step 7.1 — Extend Deps + OrchestratorDep**

In `src/server/api/runs.ts` `interface OrchestratorDep`:

```ts
interface OrchestratorDep {
  writeStdin(runId: number, bytes: Uint8Array): void;
  getLastFiles(runId: number): FilesPayload | null;
  execInContainer(runId: number, cmd: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  execHistoryOp(runId: number, op: HistoryOp): Promise<ParsedOpResult>;
  spawnSubRun(parentRunId: number, kind: 'merge-conflict' | 'polish', argsJson: string): Promise<number>;
}
```

Import the types at the top:
```ts
import type { HistoryOp, HistoryResult, MergeStrategy } from '../../shared/types.js';
import type { ParsedOpResult } from '../orchestrator/historyOp.js';
```

Wire the new methods from `Orchestrator` in `src/server/index.ts` where `registerRunsRoutes` is called:
```ts
orchestrator: {
  writeStdin: (id, bytes) => orchestrator.writeStdin(id, bytes),
  getLastFiles: (id) => orchestrator.getLastFiles(id),
  execInContainer: (id, cmd, opts) => orchestrator.execInContainer(id, cmd, opts),
  execHistoryOp: (id, op) => orchestrator.execHistoryOp(id, op),
  spawnSubRun: (id, kind, argsJson) => orchestrator.spawnSubRun(id, kind, argsJson),
},
```

- [ ] **Step 7.2 — Add route**

Append to `registerRunsRoutes` (replace the old `/github/merge` route):

```ts
app.post('/api/runs/:id/history', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });
  if (!run.branch_name) {
    return reply.code(400).send({ kind: 'invalid', message: 'run has no branch' } satisfies HistoryResult);
  }
  const body = req.body as Partial<HistoryOp> | null;
  if (!body || typeof body !== 'object' || typeof (body as { op?: unknown }).op !== 'string') {
    return reply.code(400).send({ kind: 'invalid', message: 'op required' } satisfies HistoryResult);
  }
  const op = body as HistoryOp;

  // 'polish' is always agent-driven — no direct git path.
  if (op.op === 'polish') {
    const project = deps.projects.get(run.project_id);
    const argsJson = JSON.stringify({
      branch: run.branch_name,
      default: project?.default_branch ?? 'main',
    });
    const childId = await deps.orchestrator.spawnSubRun(runId, 'polish', argsJson);
    return { kind: 'agent', child_run_id: childId } satisfies HistoryResult;
  }

  // For merge/sync/squash-local: resolve strategy default, then dispatch.
  let resolved: HistoryOp = op;
  if (op.op === 'merge' && !op.strategy) {
    const project = deps.projects.get(run.project_id);
    resolved = { op: 'merge', strategy: project?.default_merge_strategy ?? 'squash' };
  }

  let result: ParsedOpResult;
  try {
    result = await deps.orchestrator.execHistoryOp(runId, resolved);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(503).send({ kind: 'git-unavailable', message: msg } satisfies HistoryResult);
  }

  if (result.kind === 'complete') {
    return { kind: 'complete', sha: result.sha } satisfies HistoryResult;
  }
  if (result.kind === 'conflict-detected') {
    const project = deps.projects.get(run.project_id);
    const strategy: MergeStrategy =
      resolved.op === 'merge' ? (resolved.strategy ?? 'merge') : 'merge';
    const argsJson = JSON.stringify({
      branch: run.branch_name,
      default: project?.default_branch ?? 'main',
      strategy,
    });
    const childId = await deps.orchestrator.spawnSubRun(runId, 'merge-conflict', argsJson);
    return { kind: 'conflict', child_run_id: childId } satisfies HistoryResult;
  }
  // gh-error
  return reply.code(500).send({ kind: 'invalid', message: result.message } satisfies HistoryResult);
});
```

- [ ] **Step 7.3 — Tests**

Add to `src/server/api/runs.test.ts` a new describe block:

```ts
describe('POST /api/runs/:id/history', () => {
  function setupRun() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({ name: 'p', repo_url: 'https://github.com/me/foo.git', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
    const r = runs.create({ project_id: p.id, prompt: 'x', branch_hint: 'feat/x', log_path_tmpl: (id) => `/tmp/${id}.log` });
    runs.markStarted(r.id, 'c');
    return { dir, projects, runs, run: runs.get(r.id)! };
  }

  it('merge: returns complete on successful op', async () => {
    const { dir, projects, runs, run } = setupRun();
    const app = Fastify();
    registerRunsRoutes(app, {
      runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
      launch: async () => {}, cancel: async () => {},
      fireResumeNow: () => {}, continueRun: async () => {},
      gh: stubGh,
      orchestrator: {
        ...stubOrchestrator,
        execHistoryOp: async () => ({ kind: 'complete' as const, sha: 'abc123' }),
      },
    });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/history`, payload: { op: 'merge' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'complete', sha: 'abc123' });
  });

  it('merge with conflict spawns a sub-run and returns conflict kind', async () => {
    const { dir, projects, runs, run } = setupRun();
    const spawned: Array<{ parent: number; kind: string }> = [];
    const app = Fastify();
    registerRunsRoutes(app, {
      runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
      launch: async () => {}, cancel: async () => {},
      fireResumeNow: () => {}, continueRun: async () => {},
      gh: stubGh,
      orchestrator: {
        ...stubOrchestrator,
        execHistoryOp: async () => ({ kind: 'conflict-detected' as const, message: 'conflict' }),
        spawnSubRun: async (parent, kind) => { spawned.push({ parent, kind }); return 99; },
      },
    });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/history`, payload: { op: 'merge' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'conflict', child_run_id: 99 });
    expect(spawned).toEqual([{ parent: run.id, kind: 'merge-conflict' }]);
  });

  it('polish always spawns a sub-run with agent kind', async () => {
    const { dir, projects, runs, run } = setupRun();
    const spawned: Array<{ parent: number; kind: string }> = [];
    const app = Fastify();
    registerRunsRoutes(app, {
      runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
      launch: async () => {}, cancel: async () => {},
      fireResumeNow: () => {}, continueRun: async () => {},
      gh: stubGh,
      orchestrator: {
        ...stubOrchestrator,
        spawnSubRun: async (parent, kind) => { spawned.push({ parent, kind }); return 88; },
      },
    });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/history`, payload: { op: 'polish' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'agent', child_run_id: 88 });
    expect(spawned).toEqual([{ parent: run.id, kind: 'polish' }]);
  });
});
```

Add `execHistoryOp` and `spawnSubRun` to `stubOrchestrator`:
```ts
execHistoryOp: async () => ({ kind: 'complete' as const, sha: 'deadbeef' }),
spawnSubRun: async () => 0,
```

- [ ] **Step 7.4 — Run tests**

```
npm test -- --run src/server/api/runs.test.ts
```

- [ ] **Step 7.5 — Commit**

```
git add -A
git commit -m "feat(api): POST /api/runs/:id/history dispatcher with conflict→sub-run"
```

---

## Task 8 — `/api/runs/:id/changes` endpoint

**Files:**
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/api/runs.test.ts`

- [ ] **Step 8.1 — Add route**

Replace the existing `/api/runs/:id/github` route AND the existing `/api/runs/:id/files` route with a single `/api/runs/:id/changes`:

```ts
const CHANGES_TTL_MS = 10_000;
const changesCache = new Map<number, { value: ChangesPayload; expiresAt: number }>();
function getChangesCached(runId: number): ChangesPayload | null {
  const e = changesCache.get(runId);
  if (!e || Date.now() > e.expiresAt) return null;
  return e.value;
}
function setChangesCached(runId: number, value: ChangesPayload): void {
  changesCache.set(runId, { value, expiresAt: Date.now() + CHANGES_TTL_MS });
}
function invalidateChanges(runId: number): void { changesCache.delete(runId); }

app.get('/api/runs/:id/changes', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });

  const cached = getChangesCached(runId);
  if (cached) return cached;

  const project = deps.projects.get(run.project_id);
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const ghAvail = await deps.gh.available();
  const live = deps.orchestrator.getLastFiles(runId);

  const commits: ChangeCommit[] = [];
  let ghPayload: ChangesPayload['integrations']['github'] | undefined;

  if (repo && ghAvail && run.branch_name) {
    const [pr, checks, ghCommits] = await Promise.all([
      deps.gh.prForBranch(repo, run.branch_name).catch(() => null),
      deps.gh.prChecks(repo, run.branch_name).catch(() => [] as Check[]),
      deps.gh.commitsOnBranch(repo, run.branch_name).catch(() => []),
    ]);
    for (const c of ghCommits) {
      commits.push({ sha: c.sha, subject: c.subject, committed_at: c.committed_at, pushed: true, files: [], files_loaded: false });
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
  }

  // If we have a live head commit that isn't in the gh list, prepend it as pushed:false.
  if (live?.head) {
    if (!commits.some((c) => c.sha === live.head!.sha)) {
      commits.unshift({
        sha: live.head.sha,
        subject: live.head.subject,
        committed_at: Math.floor(Date.now() / 1000),
        pushed: false,
        files: live.headFiles,
        files_loaded: true,
      });
    }
  }

  const payload: ChangesPayload = {
    branch_name: run.branch_name || null,
    branch_base: live?.branchBase ?? null,
    commits,
    uncommitted: live?.dirty ?? [],
    integrations: ghPayload ? { github: ghPayload } : {},
  };
  setChangesCached(runId, payload);
  return payload;
});

app.get('/api/runs/:id/commits/:sha/files', async (req, reply) => {
  const { id, sha } = req.params as { id: string; sha: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return reply.code(400).send({ error: 'invalid sha' });

  // Prefer docker exec on a live container — returns files for ANY commit.
  try {
    const r = await deps.orchestrator.execInContainer(runId, [
      'git', '-C', '/workspace', 'show', '--numstat', '--format=', sha,
    ], { timeoutMs: 5000 });
    if (r.exitCode === 0) return { files: parseNumstat(r.stdout) };
  } catch { /* no container — fall through */ }

  // Fallback: gh api compare parent..sha (approximate).
  const project = deps.projects.get(run.project_id);
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  if (!repo || !(await deps.gh.available())) return { files: [] };
  const files = await deps.gh.compareFiles(repo, `${sha}^`, sha).catch(() => []);
  return {
    files: files.map((f) => ({
      path: f.filename,
      status: f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M',
      additions: f.additions, deletions: f.deletions,
    })),
  };
});

function parseNumstat(raw: string): import('../../shared/types.js').FilesHeadEntry[] {
  const out: import('../../shared/types.js').FilesHeadEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [a, d, p] = line.split('\t');
    if (!p) continue;
    const adds = a === '-' ? 0 : Number.parseInt(a, 10) || 0;
    const dels = d === '-' ? 0 : Number.parseInt(d, 10) || 0;
    const status = dels === 0 && adds > 0 ? 'A' : 'M';
    out.push({ path: p, status, additions: adds, deletions: dels });
  }
  return out;
}
```

**Delete** the old `/api/runs/:id/files` and `/api/runs/:id/github` routes. Keep `/api/runs/:id/github/pr` (Create PR) unchanged.

Import `ChangesPayload`, `ChangeCommit` from `'../../shared/types.js'`.

- [ ] **Step 8.2 — Test the 10s cache**

```ts
it('changes endpoint caches for 10s', async () => {
  const { dir, projects, runs, run } = setupRun();
  let ghCalls = 0;
  const app = Fastify();
  registerRunsRoutes(app, {
    runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
    launch: async () => {}, cancel: async () => {},
    fireResumeNow: () => {}, continueRun: async () => {},
    gh: { ...stubGh, commitsOnBranch: async () => { ghCalls++; return []; } },
    orchestrator: stubOrchestrator,
  });
  await app.inject({ method: 'GET', url: `/api/runs/${run.id}/changes` });
  await app.inject({ method: 'GET', url: `/api/runs/${run.id}/changes` });
  expect(ghCalls).toBe(1);
});
```

- [ ] **Step 8.3 — Run tests**

```
npm test -- --run src/server/api/runs.test.ts
```

- [ ] **Step 8.4 — Commit**

```
git add -A
git commit -m "feat(api): /changes endpoint + /commits/:sha/files (replacing /files and /github)"
```

---

## Task 9 — WS event rename `files` → `changes`

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/logs/registry.ts`
- Modify: `src/server/orchestrator/index.ts`
- Modify: `src/web/features/runs/usageBus.ts`
- Modify: `src/web/components/Terminal.tsx`

- [ ] **Step 9.1 — Types + registry**

In `src/shared/types.ts`, the `RunWsFilesMessage` export is **already replaced** by `RunWsChangesMessage` (Task 1). Make sure it's actually removed and the new type is there.

In `src/server/logs/registry.ts` line 6–8:
```ts
import type {
  RunWsUsageMessage, RunWsTitleMessage, RunWsChangesMessage, GlobalStateMessage,
} from '../../shared/types.js';

export type RunEvent = RunWsUsageMessage | RunWsTitleMessage | RunWsChangesMessage;
```

- [ ] **Step 9.2 — Orchestrator emit**

In `src/server/orchestrator/index.ts`, find the `GitStateWatcher` `onSnapshot` callback (both in `launch()` and `reattach()`). The current code is:
```ts
events.publish({ type: 'files', ...snap });
```

But `FilesPayload` ≠ `ChangesPayload`. We need to adapt the snapshot to the new shape. Simplest: **keep emitting FilesPayload-like data, but under a different event name** that the server-side `/changes` endpoint merges with gh data on read. Since the WS payload is intended to drive fast UI updates, we can emit partial ChangesPayload with just the live bits (no commits list from gh):

```ts
events.publish({
  type: 'changes',
  branch_name: null,          // web uses run.branch_name, not this — leave null
  branch_base: snap.branchBase,
  commits: [],                // gh-side, not from watcher
  uncommitted: snap.dirty,
  integrations: {},
});
```

The web subscription merges this with polled `/changes` data (polled payload has commits + integrations; WS update refreshes the "uncommitted" part in near-real time).

- [ ] **Step 9.3 — Web bus**

In `src/web/features/runs/usageBus.ts`, rename `publishFiles` → `publishChanges` and `subscribeFiles` → `subscribeChanges`. Change the listener signature to `(runId, payload: ChangesPayload)`:

```ts
import type {
  UsageSnapshot, RunWsStateMessage, RunWsTitleMessage, ChangesPayload,
} from '@shared/types.js';

type ChangesListener = (runId: number, payload: ChangesPayload) => void;
const changesListeners = new Set<ChangesListener>();

export function publishChanges(runId: number, payload: ChangesPayload): void {
  for (const l of changesListeners) l(runId, payload);
}
export function subscribeChanges(l: ChangesListener): () => void {
  changesListeners.add(l);
  return () => { changesListeners.delete(l); };
}
```

Delete `publishFiles` / `subscribeFiles`.

In `src/web/components/Terminal.tsx`, update the WS dispatcher:
```ts
else if (msg.type === 'changes') publishChanges(runId, msg as unknown as ChangesPayload);
```

Delete the old `files` handler line.

- [ ] **Step 9.4 — Typecheck**

```
npm run typecheck
```

Several web files will complain until `ChangesTab` + `RunDetail` are done — but server-side types should pass.

- [ ] **Step 9.5 — Commit**

```
git add -A
git commit -m "feat(ws): rename files event → changes; publish ChangesPayload shape"
```

---

## Task 10 — Web API client methods

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 10.1 — Replace methods**

In `src/web/lib/api.ts`:

Delete:
```ts
getRunGithub: ...
mergeRunBranch: ...
getRunFiles: ...
```

Keep: `getRunFileDiff`, `createRunPr`, `getRunSiblings`, plus all non-run APIs.

Add:
```ts
getRunChanges: (id: number) => request<ChangesPayload>(`/api/runs/${id}/changes`),

getRunCommitFiles: (id: number, sha: string) =>
  request<{ files: FilesHeadEntry[] }>(`/api/runs/${id}/commits/${encodeURIComponent(sha)}/files`),

postRunHistory: (id: number, op: HistoryOp) =>
  request<HistoryResult>(`/api/runs/${id}/history`, {
    method: 'POST',
    body: JSON.stringify(op),
  }),
```

Update the import:
```ts
import type {
  DailyUsage, ListeningPort, McpServer, Project, Run, RunUsageBreakdownRow, SecretName, Settings,
  UsageState, FileDiffPayload, ChangesPayload, HistoryOp, HistoryResult, FilesHeadEntry,
} from '@shared/types.js';
```

- [ ] **Step 10.2 — Typecheck**

Expected: errors in RunDetail.tsx, FilesTab.tsx, GithubTab.tsx (they still call the old API). That's covered by Tasks 11–15.

- [ ] **Step 10.3 — Commit**

```
git add -A
git commit -m "feat(web/api): getRunChanges, getRunCommitFiles, postRunHistory"
```

---

## Task 11 — Menu primitive: grouped sections + checkmarks

**Files:**
- Modify: `src/web/ui/primitives/Menu.tsx`
- Create: `src/web/ui/primitives/Menu.test.tsx`

- [ ] **Step 11.1 — Extend types**

```tsx
// src/web/ui/primitives/Menu.tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn.js';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  hint?: string;
}

export interface MenuSection {
  label?: string;
  items: readonly MenuItem[];
}

export interface MenuProps {
  trigger: ReactNode;
  /** Either flat items (legacy) OR grouped sections. */
  items?: readonly MenuItem[];
  sections?: readonly MenuSection[];
}

export function Menu({ trigger, items, sections }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const resolved: readonly MenuSection[] = sections ?? (items ? [{ items }] : []);

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

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div role="menu"
          className="absolute right-0 mt-1 z-[var(--z-palette)] min-w-[220px] bg-surface-raised border border-border-strong rounded-md shadow-popover py-1">
          {resolved.map((s, i) => (
            <div key={i}>
              {i > 0 && <div className="border-t border-border my-1" role="separator" />}
              {s.label && (
                <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-[0.08em] text-text-faint">
                  {s.label}
                </div>
              )}
              {s.items.map((it) => (
                <button
                  key={it.id}
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => { setOpen(false); it.onSelect(); }}
                  className={cn(
                    'w-full text-left flex items-center gap-2 px-3 py-1.5 text-sm transition-colors duration-fast ease-out',
                    it.danger ? 'text-fail hover:bg-fail-subtle' : 'text-text hover:bg-surface',
                    it.disabled && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <span className="w-3 inline-flex justify-center">
                    {it.checked ? (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="M1.5 5 L4 7.5 L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="flex-1">{it.label}</span>
                  {it.hint && <span className="text-[11px] text-text-faint">{it.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 11.2 — Test**

```tsx
// src/web/ui/primitives/Menu.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Menu } from './Menu.js';

describe('Menu', () => {
  it('renders grouped sections with labels and separators', () => {
    render(<Menu trigger={<button>open</button>} sections={[
      { label: 'A', items: [{ id: '1', label: 'one', onSelect: () => {} }] },
      { label: 'B', items: [{ id: '2', label: 'two', onSelect: () => {} }] },
    ]} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
  });

  it('renders a check mark for checked items', () => {
    render(<Menu trigger={<button>open</button>} items={[
      { id: '1', label: 'one', checked: true, onSelect: () => {} },
      { id: '2', label: 'two', onSelect: () => {} },
    ]} />);
    fireEvent.click(screen.getByText('open'));
    const one = screen.getByText('one').closest('button')!;
    const two = screen.getByText('two').closest('button')!;
    expect(one.querySelector('svg')).not.toBeNull();
    expect(two.querySelector('svg')).toBeNull();
  });

  it('supports flat items (legacy API)', () => {
    const onSelect = vi.fn();
    render(<Menu trigger={<button>open</button>} items={[
      { id: '1', label: 'click me', onSelect },
    ]} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('click me'));
    expect(onSelect).toHaveBeenCalled();
  });
});
```

- [ ] **Step 11.3 — Run + commit**

```
npm test -- --run src/web/ui/primitives/Menu.test.tsx
git add -A
git commit -m "feat(ui): Menu supports grouped sections + checkmarks"
```

---

## Task 12 — `ChangesHeader` (action bar)

**Files:**
- Create: `src/web/features/runs/ChangesHeader.tsx`
- Create: `src/web/features/runs/ChangesHeader.test.tsx`

- [ ] **Step 12.1 — Implement**

```tsx
// src/web/features/runs/ChangesHeader.tsx
import { Menu, type MenuSection } from '@ui/primitives/Menu.js';
import type { ChangesPayload, MergeStrategy, Project, Run } from '@shared/types.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';

export interface ChangesHeaderProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload;
  creatingPr: boolean;
  merging: boolean;
  onCreatePr: () => void;
  onMerge: (strategy?: MergeStrategy) => void;
  onSync: () => void;
  onSquashLocal: (subject: string) => void;
  onPolish: () => void;
}

export function ChangesHeader({
  run, project, changes, creatingPr, merging,
  onCreatePr, onMerge, onSync, onSquashLocal, onPolish,
}: ChangesHeaderProps) {
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const branchHref = repo && changes.branch_name
    ? `https://github.com/${repo}/tree/${encodeURIComponent(changes.branch_name)}`
    : undefined;

  const behind = changes.branch_base?.behind ?? 0;
  const ahead = changes.branch_base?.ahead ?? 0;
  const active = run.state === 'running' || run.state === 'waiting' || run.state === 'succeeded';
  const canMerge = active && !!changes.branch_name;
  const canCreatePr = !!changes.integrations.github && !changes.integrations.github.pr && !!changes.branch_name;

  const sections: MenuSection[] = [
    {
      label: 'Merge strategy',
      items: [
        { id: 'merge', label: 'Merge commit',
          checked: project?.default_merge_strategy === 'merge',
          onSelect: () => onMerge('merge') },
        { id: 'rebase', label: 'Rebase & fast-forward',
          checked: project?.default_merge_strategy === 'rebase',
          onSelect: () => onMerge('rebase') },
        { id: 'squash', label: 'Squash & merge',
          checked: project?.default_merge_strategy === 'squash',
          onSelect: () => onMerge('squash') },
      ],
    },
    {
      label: 'History',
      items: [
        { id: 'sync', label: 'Sync branch with main', hint: 'rebase',
          disabled: !changes.branch_name, onSelect: onSync },
        { id: 'squash-local', label: 'Squash local commits',
          disabled: changes.commits.length < 2,
          onSelect: () => {
            const subj = window.prompt('Squashed commit subject:', run.title ?? (run.prompt.split('\n')[0] ?? '').slice(0, 72));
            if (subj) onSquashLocal(subj);
          } },
        { id: 'polish', label: 'Polish commits with agent', hint: 'sub-run',
          disabled: changes.commits.length === 0, onSelect: onPolish },
      ],
    },
    {
      label: 'Misc',
      items: [
        { id: 'copy', label: 'Copy branch name',
          disabled: !changes.branch_name,
          onSelect: () => { if (changes.branch_name) void navigator.clipboard.writeText(changes.branch_name); } },
        { id: 'open', label: 'Open branch on GitHub ↗',
          disabled: !branchHref,
          onSelect: () => { if (branchHref) window.open(branchHref, '_blank', 'noreferrer'); } },
      ],
    },
  ];

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-surface-raised">
      {changes.branch_name ? (
        branchHref
          ? <a href={branchHref} target="_blank" rel="noreferrer" className="font-mono text-[13px] text-accent hover:text-accent-strong">{changes.branch_name}</a>
          : <span className="font-mono text-[13px] text-text">{changes.branch_name}</span>
      ) : <span className="text-[13px] text-text-faint">no branch</span>}
      <span className="text-text-faint">·</span>
      <span className="font-mono text-[12px] text-ok">{ahead} ahead</span>
      <span className="font-mono text-[12px] text-text-faint">/</span>
      <span className={`font-mono text-[12px] ${behind > 0 ? 'text-warn font-medium' : 'text-text-faint'}`}>{behind} behind</span>
      <span className="text-text-faint font-mono text-[12px]">main</span>

      <span className="flex-1" />

      {behind > 0 && (
        <button type="button" onClick={onSync} disabled={merging}
          className="px-3 py-1 text-[12px] rounded-md border border-warn/50 bg-warn-subtle text-warn hover:bg-warn-subtle/70 disabled:opacity-50 animate-pulse">
          Sync with main ↓
        </button>
      )}
      {canMerge && (
        <button type="button" onClick={() => onMerge()} disabled={merging}
          className="px-3 py-1 text-[12px] rounded-md bg-accent text-bg hover:bg-accent-strong disabled:opacity-50 font-medium">
          {merging ? 'Merging…' : 'Merge to main'}
        </button>
      )}
      {canCreatePr && (
        <button type="button" onClick={onCreatePr} disabled={creatingPr}
          className="px-3 py-1 text-[12px] rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised disabled:opacity-50">
          {creatingPr ? 'Creating PR…' : 'Create PR'}
        </button>
      )}
      <Menu
        trigger={<button type="button" aria-label="More actions" className="px-2 py-1 text-[13px] text-text-faint hover:text-text">⋮</button>}
        sections={sections}
      />
    </div>
  );
}
```

- [ ] **Step 12.2 — Test**

```tsx
// src/web/features/runs/ChangesHeader.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChangesHeader } from './ChangesHeader.js';
import type { ChangesPayload, Run, Project } from '@shared/types.js';

const run = { id: 1, state: 'running', branch_name: 'feat/x', project_id: 1, prompt: 'do it', title: null } as unknown as Run;
const project = { id: 1, repo_url: 'git@github.com:me/foo.git', default_merge_strategy: 'squash' } as unknown as Project;
const baseChanges: ChangesPayload = {
  branch_name: 'feat/x',
  branch_base: { base: 'main', ahead: 4, behind: 0 },
  commits: [], uncommitted: [], integrations: {},
};

describe('ChangesHeader', () => {
  const handlers = {
    onCreatePr: vi.fn(), onMerge: vi.fn(), onSync: vi.fn(),
    onSquashLocal: vi.fn(), onPolish: vi.fn(),
  };

  it('shows Sync button when behind > 0', () => {
    render(<ChangesHeader run={run} project={project} changes={{ ...baseChanges, branch_base: { base: 'main', ahead: 4, behind: 3 } }}
      creatingPr={false} merging={false} {...handlers} />);
    expect(screen.getByText(/Sync with main/)).toBeInTheDocument();
  });

  it('hides Sync when up to date', () => {
    render(<ChangesHeader run={run} project={project} changes={baseChanges}
      creatingPr={false} merging={false} {...handlers} />);
    expect(screen.queryByText(/Sync with main/)).not.toBeInTheDocument();
  });

  it('menu: strategy checkmark follows project default', () => {
    render(<ChangesHeader run={run} project={project} changes={baseChanges}
      creatingPr={false} merging={false} {...handlers} />);
    fireEvent.click(screen.getByLabelText('More actions'));
    const squash = screen.getByText('Squash & merge').closest('button')!;
    const merge = screen.getByText('Merge commit').closest('button')!;
    expect(squash.querySelector('svg')).not.toBeNull();
    expect(merge.querySelector('svg')).toBeNull();
  });

  it('Merge button calls onMerge without strategy (uses project default)', () => {
    const onMerge = vi.fn();
    render(<ChangesHeader run={run} project={project} changes={baseChanges}
      creatingPr={false} merging={false} {...handlers} onMerge={onMerge} />);
    fireEvent.click(screen.getByText('Merge to main'));
    expect(onMerge).toHaveBeenCalledWith(undefined);
  });
});
```

- [ ] **Step 12.3 — Run + commit**

```
npm test -- --run src/web/features/runs/ChangesHeader.test.tsx
git add -A
git commit -m "feat(runs): ChangesHeader action bar + ⋮ menu"
```

---

## Task 13 — `IntegrationStrip`

**Files:**
- Create: `src/web/features/runs/IntegrationStrip.tsx`

- [ ] **Step 13.1 — Implement**

```tsx
// src/web/features/runs/IntegrationStrip.tsx
import type { ChangesPayload } from '@shared/types.js';
import { ExternalLink } from '@ui/primitives/icons/ExternalLink.js';

export interface IntegrationStripProps {
  integrations: ChangesPayload['integrations'];
}

export function IntegrationStrip({ integrations }: IntegrationStripProps) {
  if (!integrations.github) return null;
  const { pr, checks } = integrations.github;
  const dot = checks?.state === 'failure' ? 'bg-fail'
    : checks?.state === 'pending' ? 'bg-warn animate-pulse'
    : 'bg-ok';
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[12px] text-text-faint border-b border-border">
      <span>github</span>
      {pr && (
        <>
          <span>·</span>
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong inline-flex items-center gap-1">
            PR #{pr.number} — {pr.title} <ExternalLink />
          </a>
          <span className={`ml-1 px-1.5 py-0 rounded-sm text-[10px] font-semibold uppercase ${pr.state === 'MERGED' ? 'bg-ok-subtle text-ok' : pr.state === 'OPEN' ? 'bg-run-subtle text-run' : 'bg-surface-raised text-text-dim'}`}>
            {pr.state.toLowerCase()}
          </span>
        </>
      )}
      {checks && (
        <>
          <span>·</span>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
          <span>ci {checks.passed}/{checks.total}</span>
        </>
      )}
    </div>
  );
}
```

No dedicated tests — covered by ChangesTab tests.

- [ ] **Step 13.2 — Commit**

```
git add -A
git commit -m "feat(runs): IntegrationStrip (compact GitHub PR + CI)"
```

---

## Task 14 — `CommitRow` with lazy file loading

**Files:**
- Create: `src/web/features/runs/CommitRow.tsx`

- [ ] **Step 14.1 — Implement**

```tsx
// src/web/features/runs/CommitRow.tsx
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { DiffBlock } from '@ui/data/DiffBlock.js';
import { Pill, type PillTone } from '@ui/primitives/Pill.js';
import type { ChangeCommit, FileDiffPayload, FilesDirtyEntry, FilesHeadEntry } from '@shared/types.js';

type FileRow = FilesDirtyEntry | FilesHeadEntry;
type DiffState = FileDiffPayload | 'loading' | 'error';

const STATUS_TONE: Record<string, PillTone> = {
  M: 'warn', A: 'ok', D: 'fail', R: 'attn', U: 'wait',
};

export interface CommitRowProps {
  runId: number;
  sha: string;                       // use 'uncommitted' for the synthetic node
  subject: string;
  shortSha: string | null;           // null for uncommitted
  pushed: boolean | null;            // null for uncommitted
  fileCount: number;
  relativeTime: string;
  uncommitted?: boolean;
  defaultOpen?: boolean;
  initialFiles?: FileRow[];
  initialFilesLoaded?: boolean;
}

export function CommitRow({
  runId, sha, subject, shortSha, pushed, fileCount, relativeTime,
  uncommitted, defaultOpen, initialFiles, initialFilesLoaded,
}: CommitRowProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [files, setFiles] = useState<FileRow[] | null>(initialFilesLoaded ? (initialFiles ?? []) : null);
  const [loadErr, setLoadErr] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, DiffState>>({});

  async function toggleOpen(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (next && files === null) {
      if (uncommitted) {
        // Uncommitted files come from the live ChangesPayload — should be set via initialFiles.
        setFiles([]);
        return;
      }
      try {
        const r = await api.getRunCommitFiles(runId, sha);
        setFiles(r.files);
      } catch {
        setLoadErr(true);
      }
    }
  }

  async function toggleFile(path: string): Promise<void> {
    const key = path;
    const existing = expanded[key];
    if (existing && existing !== 'loading') {
      setExpanded((e) => { const n = { ...e }; delete n[key]; return n; });
      return;
    }
    setExpanded((e) => ({ ...e, [key]: 'loading' }));
    try {
      const d = await api.getRunFileDiff(runId, path, uncommitted ? 'worktree' : sha);
      setExpanded((e) => ({ ...e, [key]: d }));
    } catch {
      setExpanded((e) => ({ ...e, [key]: 'error' }));
    }
  }

  return (
    <div>
      <button type="button" onClick={toggleOpen}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left border-b border-border hover:bg-surface-raised ${uncommitted ? 'border-l-2 border-l-accent bg-accent-subtle/10' : ''}`}>
        <Chevron open={open} />
        {pushed !== null && <span className={`w-1.5 h-1.5 rounded-full ${pushed ? 'bg-ok' : 'bg-text-faint'}`}
          title={pushed ? 'pushed to origin' : 'local only — not yet pushed'} />}
        {shortSha && <span className="font-mono text-[11px] text-text-faint bg-surface-raised px-1.5 py-0.5 rounded">{shortSha}</span>}
        <span className={`flex-1 truncate ${uncommitted ? 'italic' : ''}`}>{subject}</span>
        <span className="text-[11px] text-text-faint font-mono">{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
        <span className="text-[11px] text-text-faint">{relativeTime}</span>
      </button>
      {open && (
        <div className="bg-surface-sunken">
          {loadErr && <p className="p-2 text-[12px] text-fail">Failed to load files.</p>}
          {files === null && !loadErr && <p className="p-2 text-[12px] text-text-faint">Loading…</p>}
          {files && files.map((f) => {
            const d = expanded[f.path];
            return (
              <div key={f.path}>
                <button type="button" onClick={() => toggleFile(f.path)}
                  className="w-full flex items-center gap-2 px-3 py-1 pl-10 text-[12px] text-left hover:bg-surface-raised border-b border-border/40">
                  <Chevron open={!!d && d !== 'loading'} />
                  <Pill tone={STATUS_TONE[f.status] ?? 'wait'}>{f.status}</Pill>
                  <span className="font-mono text-text flex-1 truncate">{f.path}</span>
                  {'additions' in f && f.additions > 0 && <span className="font-mono text-[11px] text-ok">+{f.additions}</span>}
                  {'deletions' in f && f.deletions > 0 && <span className="font-mono text-[11px] text-fail">-{f.deletions}</span>}
                </button>
                {d === 'loading' && <p className="px-3 py-1 pl-10 text-[11px] text-text-faint">Loading diff…</p>}
                {d === 'error' && <p className="px-3 py-1 pl-10 text-[11px] text-fail">Failed.</p>}
                {d && typeof d === 'object' && <DiffBlock hunks={d.hunks} truncated={d.truncated} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"
      className={`text-text-faint transition-transform duration-fast ease-out ${open ? 'rotate-90' : ''}`}>
      <path d="M3.5 2 L7 5 L3.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
```

- [ ] **Step 14.2 — Commit (tests come with ChangesTab)**

```
git add -A
git commit -m "feat(runs): CommitRow with lazy file loading + inline diffs"
```

---

## Task 15 — `useHistoryOp` hook + `ChangesTab`

**Files:**
- Create: `src/web/features/runs/useHistoryOp.ts`
- Create: `src/web/features/runs/ChangesTab.tsx`
- Create: `src/web/features/runs/ChangesTab.test.tsx`

- [ ] **Step 15.1 — Hook**

```ts
// src/web/features/runs/useHistoryOp.ts
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import type { HistoryOp, HistoryResult } from '@shared/types.js';

export function useHistoryOp(runId: number, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const nav = useNavigate();

  const run = useCallback(async (op: HistoryOp): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const r: HistoryResult = await api.postRunHistory(runId, op);
      if (r.kind === 'complete') {
        setMsg(r.sha ? `Done (${r.sha.slice(0, 7)})` : 'Done');
        onDone?.();
      } else if (r.kind === 'agent' || r.kind === 'conflict') {
        const label = r.kind === 'conflict' ? 'Conflict — delegated' : 'Delegated to agent';
        setMsg(`${label} (run #${r.child_run_id}) — click to view`);
        setTimeout(() => nav(`/runs/${r.child_run_id}`), 1200);
      } else if (r.kind === 'agent-busy') {
        setMsg('Agent not available — try again when the run is live.');
      } else if (r.kind === 'invalid') {
        setMsg(`Invalid: ${r.message}`);
      } else if (r.kind === 'git-unavailable') {
        setMsg('Git operation failed.');
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }, [runId, onDone, nav]);

  return { busy, msg, run };
}
```

- [ ] **Step 15.2 — ChangesTab**

```tsx
// src/web/features/runs/ChangesTab.tsx
import { ChangesHeader } from './ChangesHeader.js';
import { IntegrationStrip } from './IntegrationStrip.js';
import { CommitRow } from './CommitRow.js';
import { useHistoryOp } from './useHistoryOp.js';
import type { ChangesPayload, MergeStrategy, Project, Run } from '@shared/types.js';

export interface ChangesTabProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload | null;
  onCreatePr: () => void;
  creatingPr: boolean;
  onReload: () => void;
}

export function ChangesTab({ run, project, changes, onCreatePr, creatingPr, onReload }: ChangesTabProps) {
  const { busy, msg, run: runOp } = useHistoryOp(run.id, onReload);

  if (!changes) return <p className="p-3 text-[13px] text-text-faint">Loading changes…</p>;
  if (!changes.branch_name) return <p className="p-3 text-[13px] text-text-faint">This run didn't produce a branch.</p>;

  const empty = changes.commits.length === 0 && changes.uncommitted.length === 0;

  return (
    <div>
      <ChangesHeader
        run={run} project={project} changes={changes}
        creatingPr={creatingPr} merging={busy}
        onCreatePr={onCreatePr}
        onMerge={(strategy?: MergeStrategy) => runOp({ op: 'merge', strategy })}
        onSync={() => runOp({ op: 'sync' })}
        onSquashLocal={(subject) => runOp({ op: 'squash-local', subject })}
        onPolish={() => runOp({ op: 'polish' })}
      />
      <IntegrationStrip integrations={changes.integrations} />
      {msg && <p className="px-3 py-1 text-[12px] text-text-dim bg-surface-raised border-b border-border">{msg}</p>}

      {empty ? (
        <p className="p-3 text-[13px] text-text-faint">No changes yet. The agent hasn't committed anything.</p>
      ) : (
        <div>
          {changes.uncommitted.length > 0 && (
            <CommitRow
              runId={run.id}
              sha="uncommitted"
              shortSha={null}
              pushed={null}
              subject={`Uncommitted (${changes.uncommitted.length})`}
              fileCount={changes.uncommitted.length}
              relativeTime="working tree"
              uncommitted
              defaultOpen
              initialFiles={changes.uncommitted}
              initialFilesLoaded
            />
          )}
          {changes.commits.map((c) => (
            <CommitRow
              key={c.sha}
              runId={run.id}
              sha={c.sha}
              shortSha={c.sha.slice(0, 7)}
              pushed={c.pushed}
              subject={c.subject}
              fileCount={c.files_loaded ? c.files.length : 0}
              relativeTime={relativeTime(c.committed_at)}
              initialFiles={c.files_loaded ? c.files : undefined}
              initialFilesLoaded={c.files_loaded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function relativeTime(unixSeconds: number): string {
  const diffMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

- [ ] **Step 15.3 — Tests**

```tsx
// src/web/features/runs/ChangesTab.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { ChangesTab } from './ChangesTab.js';
import type { ChangesPayload, Run, Project } from '@shared/types.js';

const run = { id: 1, state: 'running', branch_name: 'feat/x', project_id: 1, prompt: '', title: null } as unknown as Run;
const project = { id: 1, repo_url: 'git@github.com:me/foo.git', default_merge_strategy: 'squash' } as unknown as Project;
const base: ChangesPayload = {
  branch_name: 'feat/x', branch_base: { base: 'main', ahead: 2, behind: 0 },
  commits: [], uncommitted: [], integrations: {},
};

function renderTab(changes: ChangesPayload | null) {
  return render(
    <MemoryRouter>
      <ChangesTab run={run} project={project} changes={changes}
        onCreatePr={vi.fn()} creatingPr={false} onReload={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('ChangesTab', () => {
  it('shows loading state when changes is null', () => {
    renderTab(null);
    expect(screen.getByText(/Loading changes/i)).toBeInTheDocument();
  });
  it('shows empty state when no commits and no uncommitted', () => {
    renderTab(base);
    expect(screen.getByText(/No changes yet/i)).toBeInTheDocument();
  });
  it('renders Uncommitted synthetic row when there are dirty files', () => {
    renderTab({ ...base, uncommitted: [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }] });
    expect(screen.getByText(/Uncommitted \(1\)/)).toBeInTheDocument();
  });
  it('renders commits', () => {
    renderTab({ ...base, commits: [
      { sha: 'abcdef0123', subject: 'feat: x', committed_at: Math.floor(Date.now()/1000) - 60, pushed: true, files: [], files_loaded: false },
    ] });
    expect(screen.getByText('feat: x')).toBeInTheDocument();
    expect(screen.getByText('abcdef0')).toBeInTheDocument();
  });
  it('hides integration strip when no github data', () => {
    renderTab(base);
    expect(screen.queryByText(/^github/)).not.toBeInTheDocument();
  });
  it('renders integration strip when github payload present', () => {
    renderTab({
      ...base,
      integrations: {
        github: { pr: { number: 3, url: '#', state: 'OPEN', title: 't' },
          checks: { state: 'success', passed: 1, failed: 0, total: 1, items: [] } },
      },
    });
    expect(screen.getByText(/PR #3/)).toBeInTheDocument();
    expect(screen.getByText(/ci 1\/1/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 15.4 — Run + commit**

```
npm test -- --run src/web/features/runs/ChangesTab.test.tsx
git add -A
git commit -m "feat(runs): ChangesTab + useHistoryOp"
```

---

## Task 16 — `RunDrawer` tab set `changes · tunnel · meta`

**Files:**
- Modify: `src/web/features/runs/RunDrawer.tsx`

- [ ] **Step 16.1 — Update**

```tsx
// src/web/features/runs/RunDrawer.tsx (replace relevant parts)
export type RunTab = 'changes' | 'tunnel' | 'meta';

// In the Tabs props:
tabs={[
  { value: 'changes', label: 'changes', count: changesCount },
  { value: 'tunnel', label: 'tunnel', count: portsCount ?? undefined },
  { value: 'meta', label: 'meta' },
]}
```

Rename prop `filesCount` → `changesCount` throughout.

- [ ] **Step 16.2 — Commit**

```
git add -A
git commit -m "feat(runs): RunDrawer new tab set (changes · tunnel · meta)"
```

---

## Task 17 — `RunDetail` wiring

**Files:**
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 17.1 — Rewire**

Replace the files/github effects + state with:

```tsx
import { ChangesTab } from '../features/runs/ChangesTab.js';
import type { ChangesPayload } from '@shared/types.js';
import { subscribeChanges } from '../features/runs/usageBus.js';

// Remove:
//   import { FilesTab } ...
//   import { GithubTab } ...
//   [gh, setGh] useState
//   [files, setFiles] useState
//   subscribeFiles subscription
//   getRunGithub polling
//   getRunFiles initial fetch

// Replace with:
const [changes, setChanges] = useState<ChangesPayload | null>(null);

useEffect(() => {
  return subscribeChanges((id, payload) => {
    if (id !== runId) return;
    setChanges((prev) => {
      // WS update brings live working-tree + branch-base. Preserve commits +
      // integrations from polled data.
      if (!prev) return payload;
      return {
        ...prev,
        branch_base: payload.branch_base,
        uncommitted: payload.uncommitted,
      };
    });
  });
}, [runId]);

useEffect(() => {
  if (!run) return;
  let alive = true;
  const load = async (): Promise<void> => {
    try { const c = await api.getRunChanges(run.id); if (alive) setChanges(c); } catch { /* */ }
  };
  void load();
  const t = setInterval(load, 10_000);
  return () => { alive = false; clearInterval(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [run?.id]);

async function onCreatePr(): Promise<void> {
  if (!run) return;
  setCreatingPr(true);
  try {
    await api.createRunPr(run.id);
    const c = await api.getRunChanges(run.id);
    setChanges(c);
  } catch (e) { alert(String(e)); }
  finally { setCreatingPr(false); }
}

async function onReload(): Promise<void> {
  if (!run) return;
  try { const c = await api.getRunChanges(run.id); setChanges(c); } catch { /* */ }
}
```

Replace the tab render switch:

```tsx
{(t) =>
  t === 'changes' ? <ChangesTab run={run} project={project} changes={changes}
    onCreatePr={onCreatePr} creatingPr={creatingPr} onReload={onReload} /> :
  t === 'tunnel' ? <TunnelTab runId={run.id} runState={run.state} origin={window.location.origin} ports={ports} /> :
  <MetaTab run={run} siblings={siblings} />
}
```

Count prop:
```tsx
changesCount={(changes?.uncommitted.length ?? 0) + (changes?.commits.length ?? 0)}
```

- [ ] **Step 17.2 — Typecheck + run**

```
npm run typecheck
npm test -- --run
```

- [ ] **Step 17.3 — Commit**

```
git add -A
git commit -m "feat(web): RunDetail consumes unified /changes + subscribeChanges"
```

---

## Task 18 — Delete obsolete files + dead API + `MergeResponse`

**Files:**
- Delete: `src/web/features/runs/FilesTab.tsx`
- Delete: `src/web/features/runs/FilesTab.test.tsx`
- Delete: `src/web/features/runs/GithubTab.tsx`
- Delete: `src/web/features/runs/GithubTab.test.tsx`
- Modify: `src/shared/types.ts` — delete `MergeResponse`, delete `FilesPayload`-only export if nothing else uses it (keep if `RunWsChangesMessage` internals reuse the dirty/head entry types)
- Modify: `src/server/github/gh.ts` — delete `mergeBranch` method
- Modify: `src/server/api/runs.ts` — verify no dead references

- [ ] **Step 18.1 — Delete dead files**

```
rm src/web/features/runs/FilesTab.tsx src/web/features/runs/FilesTab.test.tsx
rm src/web/features/runs/GithubTab.tsx src/web/features/runs/GithubTab.test.tsx
```

- [ ] **Step 18.2 — Remove `mergeBranch` from gh client**

In `src/server/github/gh.ts`, delete the `async mergeBranch(...)` method entirely (the method body spanning ~20 lines). Also remove its test cases from `src/server/github/gh.test.ts` (`'mergeBranch returns merged:true...'`, `'mergeBranch returns merged:false reason=conflict...'`, `'mergeBranch returns reason=gh-error...'`).

Remove from `GhDeps` in `src/server/api/runs.ts`:
```ts
mergeBranch(...)  // delete this line
```

Remove from stub in `src/server/api/runs.test.ts`:
```ts
mergeBranch: async () => (...)  // delete from stubGh
```

- [ ] **Step 18.3 — Remove `MergeResponse` type + `mergeRunBranch` helper**

In `src/shared/types.ts`, delete the `MergeResponse` export entirely.

In `src/web/lib/api.ts`: already removed `mergeRunBranch` in Task 10. Verify the `MergeResponse` import is also gone.

- [ ] **Step 18.4 — Typecheck + test**

```
grep -rln "MergeResponse\|mergeBranch\|mergeRunBranch\|FilesTab\|GithubTab" src
```
Expected: only hits inside the deleted file list (none, since we deleted them). Fix any stragglers.

```
npm run typecheck
npm test -- --run
```
All pass.

- [ ] **Step 18.5 — Commit**

```
git add -A
git commit -m "chore: remove FilesTab, GithubTab, MergeResponse, gh.mergeBranch"
```

---

## Task 19 — Project settings UI: default merge strategy

**Files:**
- Modify: `src/web/pages/EditProject.tsx`

- [ ] **Step 19.1 — Add field**

Add state near other useState calls:
```tsx
const [mergeStrategy, setMergeStrategy] = useState<'merge' | 'rebase' | 'squash'>('squash');
```

Hydrate from loaded project:
```tsx
setMergeStrategy(p.default_merge_strategy);
```

Add a new `Section` near the existing sections (between Git and Agent):
```tsx
<Section title="Default merge strategy">
  <FormRow label="When shipping to main">
    <Select value={mergeStrategy} onChange={(e) => setMergeStrategy(e.target.value as 'merge' | 'rebase' | 'squash')}>
      <option value="merge">Merge commit — preserves branch history</option>
      <option value="rebase">Rebase &amp; fast-forward — linear history</option>
      <option value="squash">Squash &amp; merge — single commit on main</option>
    </Select>
  </FormRow>
</Section>
```

Include it in the save payload:
```tsx
await api.updateProject(pid, {
  // ...existing fields
  default_merge_strategy: mergeStrategy,
});
```

Also add to the `NewProject` page similarly (find `src/web/pages/NewProject.tsx`, mirror the field — default value `'squash'` for new projects).

- [ ] **Step 19.2 — Verify**

```
npm run typecheck
npm run build
```

- [ ] **Step 19.3 — Commit**

```
git add -A
git commit -m "feat(web): default merge strategy in project settings"
```

---

## Task 20 — End-to-end verification

- [ ] **Step 20.1 — Start dev server**

```
scripts/dev.sh
```

- [ ] **Step 20.2 — Browser walkthrough (Playwright)**

Navigate to a project with a live run.

1. Open the run. Bottom pane shows tabs `changes · tunnel · meta`.
2. Changes tab: commits tree renders. Uncommitted section present if agent is mid-edit.
3. Header shows branch name + ahead/behind. Branch link works.
4. If behind > 0: amber "Sync with main" button appears (manually create a conflicting commit on origin/main to test).
5. Click `[Merge to main]`. Verify result toast; commit appears on main on GitHub.
6. ⋮ menu: all sections render; strategy checkmark follows project default; selecting non-default strategy triggers merge with override.
7. Create a PR → integration strip populates. Merge button still visible while PR is open.
8. Merge via PR → integration strip updates to `merged`; Merge button remains (vibecoding: sync/squash-local still allowed post-merge). (That's fine — primary button still works if branch has unpushed work.)
9. Force a conflict: on the live container, check out main in a second clone, commit + push a conflicting change, then click Merge on the feature branch. Verify "Conflict — delegated (run #N)" toast; navigate to the sub-run; verify it's kind='merge-conflict' with the templated prompt.
10. Click Polish commits with agent. Verify new sub-run spawns with kind='polish'.
11. Settings: change default merge strategy; verify menu checkmark updates.

- [ ] **Step 20.3 — Final sweep**

```
npm run typecheck
npm test -- --run
npm run build
```
All green.

```
git status
# commit any verification fallout
```

---

## Self-review checklist

- [ ] Spec §1 (`default_merge_strategy`): Task 1, Task 19
- [ ] Spec §2 (Changes tab): Tasks 10, 12, 13, 14, 15, 16, 17
- [ ] Spec §3 (⋮ menu): Task 11, Task 12
- [ ] Spec §4 (history endpoint + shell ops): Tasks 3, 4, 5, 7
- [ ] Spec §5 (transient merge containers): Task 5
- [ ] Spec §6 (sub-runs via kind/kind_args_json): Tasks 1, 6, 7
- [ ] Spec §7 (retirement of gh-CLI merge path): Task 18
- [ ] Spec §8 (`/changes` endpoint): Task 8
- [ ] Spec §9 (WS rename): Task 9
- [ ] Spec §10 (tests): all Task N steps
- [ ] Spec §11 (force-with-lease, no modals, project settings UI): Tasks 3 (script uses force-with-lease), 19 (settings UI); no modals — ChangesTab uses inline status message

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-change-management.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints

Which approach?
