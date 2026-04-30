# Ship Tab + Submodule Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote shipping to its own `ship` tab (replacing the cramped `⋮` menu on the Changes tab), give it a strategy-aware split-button Merge + labeled History / Agent / Submodules / Links sections, and make submodules first-class in both Changes and Ship tabs (readable bumps, dirty-submodule rendering, per-submodule push action, `--recurse-submodules=on-demand` on post-commit + history ops).

**Architecture:** Server extends `GET /api/runs/:id/changes` to emit per-commit `submodule_bumps`, top-level `dirty_submodules`, and `children`. One new endpoint (`/submodule/:path/commits/:sha/files`) feeds lazy expansion. History endpoint accepts a new `op: 'push-submodule'`. The web rendering adds a `ship` tab (4 tabs total: `changes · ship · tunnel · meta`), split-button merge component backed by `localStorage['fbi.mergeStrategy']`, and submodule rows nested inside the Changes commit tree. Correctness win: post-commit hook + all fetch/push in `fbi-history-op.sh` gain `--recurse-submodules=on-demand`.

**Tech Stack:** TypeScript, Fastify, dockerode, React, Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-04-23-ship-tab-and-submodules-design.md`

---

## File map

### New files
- `src/web/features/runs/useMergeStrategy.ts` + test
- `src/web/features/runs/SplitButtonMerge.tsx` + test
- `src/web/features/runs/SubmoduleBumpRow.tsx`
- `src/web/features/runs/SubmoduleDirtyRow.tsx`
- `src/web/features/runs/ship/ShipTab.tsx` + test
- `src/web/features/runs/ship/ShipHeader.tsx`
- `src/web/features/runs/ship/MergePrimary.tsx`
- `src/web/features/runs/ship/HistorySection.tsx`
- `src/web/features/runs/ship/AgentSection.tsx`
- `src/web/features/runs/ship/SubmodulesSection.tsx`
- `src/web/features/runs/ship/LinksSection.tsx`
- `src/web/features/runs/ship/SubRunsSection.tsx`
- `src/web/features/runs/ship/computeShipDot.ts` + test

### Modified
- `src/shared/types.ts` — `SubmoduleBump`, `SubmoduleDirty`, `ChildRunSummary`, `HistoryOp` (+ `push-submodule`); extend `ChangeCommit`, `ChangesPayload`.
- `src/server/orchestrator/supervisor.sh` — post-commit hook adds `--recurse-submodules=on-demand`.
- `src/server/orchestrator/fbi-history-op.sh` — all fetch/push add `--recurse-submodules=on-demand`; new `run_push_submodule` case.
- `src/server/orchestrator/gitStateWatcher.ts` — parse submodule status; attach `dirty_submodules` to the payload.
- `src/server/api/runs.ts` — `/changes` populates `submodule_bumps`, `dirty_submodules`, `children`; new `/submodule/:path/commits/:sha/files` route; `/history` accepts new op.
- `src/server/db/runs.ts` — add `listByParent(parentRunId): Run[]`.
- `src/web/lib/api.ts` — `getRunSubmoduleCommitFiles`.
- `src/web/features/runs/RunDrawer.tsx` — add `'ship'` tab + dot-indicator props.
- `src/web/features/runs/ChangesTab.tsx` — strip action bar / integration strip; render submodule rows in commit tree.
- `src/web/features/runs/CommitRow.tsx` — accept `submoduleBumps`, render beneath files.
- `src/web/pages/RunDetail.tsx` — compute dot state; route `'ship'` to `ShipTab`.

### Deleted
- `src/web/features/runs/ChangesHeader.tsx` + test
- `src/web/features/runs/IntegrationStrip.tsx`

---

## Task 1 — Types + `RunsRepo.listByParent`

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/runs.ts`
- Create: `src/server/db/runs.listByParent.test.ts` (or extend an existing runs.ts test if one exists)

- [ ] **Step 1.1 — Add types**

In `src/shared/types.ts`, near the existing `ChangeCommit` / `ChangesPayload` exports, add:

```ts
export interface SubmoduleBump {
  path: string;
  url: string | null;
  from: string;
  to: string;
  commits: ChangeCommit[];
  commits_truncated: boolean;
}

export interface SubmoduleDirty {
  path: string;
  url: string | null;
  dirty: FilesDirtyEntry[];
  unpushed_commits: ChangeCommit[];
  unpushed_truncated: boolean;
}

export interface ChildRunSummary {
  id: number;
  kind: 'work' | 'merge-conflict' | 'polish';
  state: RunState;
  created_at: number;
}
```

Extend `ChangeCommit` (add field):
```ts
submodule_bumps: SubmoduleBump[];
```

Extend `ChangesPayload` (add two fields):
```ts
dirty_submodules: SubmoduleDirty[];
children: ChildRunSummary[];
```

Extend `HistoryOp` (add variant):
```ts
export type HistoryOp =
  | { op: 'merge'; strategy?: MergeStrategy }
  | { op: 'sync' }
  | { op: 'squash-local'; subject: string }
  | { op: 'polish' }
  | { op: 'push-submodule'; path: string };
```

- [ ] **Step 1.2 — Add `listByParent` to RunsRepo**

In `src/server/db/runs.ts` add near other list methods:

```ts
listByParent(parentRunId: number): Run[] {
  return this.db
    .prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY id ASC')
    .all(parentRunId) as Run[];
}
```

- [ ] **Step 1.3 — Test**

Either extend an existing `runs.test.ts` (if present) or inline a quick test in a new colocated file. If no `runs.test.ts` exists yet, add:

```ts
// src/server/db/runs.listByParent.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';
import { RunsRepo } from './runs.js';

describe('RunsRepo.listByParent', () => {
  it('returns children in id order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const parent = runs.create({ project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const child1 = runs.create({ project_id: p.id, prompt: 'c1',
      parent_run_id: parent.id, kind: 'polish',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const child2 = runs.create({ project_id: p.id, prompt: 'c2',
      parent_run_id: parent.id, kind: 'merge-conflict',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    const kids = runs.listByParent(parent.id);
    expect(kids.map((r) => r.id)).toEqual([child1.id, child2.id]);
  });

  it('returns [] when no children', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const parent = runs.create({ project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log` });
    expect(runs.listByParent(parent.id)).toEqual([]);
  });
});
```

- [ ] **Step 1.4 — Run**

```
npm run typecheck
npm test -- --run src/server/db
```

The types additions will cause web compile errors in code that relies on
the shape of `ChangesPayload` / `ChangeCommit`. Those will be caught by
tsc and are addressed in later tasks (the server /changes endpoint + UI).
At this stage, server side must remain green.

- [ ] **Step 1.5 — Commit**

```
git add -A
git commit -m "feat(types): SubmoduleBump/Dirty/ChildRunSummary; runs.listByParent"
```

---

## Task 2 — Push correctness: post-commit hook + history-op flags

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`
- Modify: `src/server/orchestrator/fbi-history-op.sh`

- [ ] **Step 2.1 — Post-commit hook**

In `src/server/orchestrator/supervisor.sh`, find the post-commit hook
installation block (search for `.git/hooks/post-commit`) and update the
`git push` line so the hook content becomes:

```sh
#!/bin/sh
( git push --recurse-submodules=on-demand -u origin HEAD > /tmp/last-push.log 2>&1 || true ) &
```

Everything else about the hook installation stays identical.

- [ ] **Step 2.2 — History-op fetches**

In `src/server/orchestrator/fbi-history-op.sh`, find the fetch line
(there should be a single `git ... fetch ... origin '+refs/heads/*:...'`
near the top). Replace it with:

```sh
if ! out=$(git -C /workspace fetch --quiet --recurse-submodules=on-demand origin '+refs/heads/*:refs/remotes/origin/*' 2>&1); then
  emit_fail gh-error "fetch failed: $out"
  exit 0
fi
```

In each `run_*` function, add `--recurse-submodules=on-demand` to every
`git push` in the script. Specifically these lines (verbatim replacement
— the variables stay the same):

- `git push origin "HEAD:refs/heads/$FBI_DEFAULT"` →
  `git push --recurse-submodules=on-demand origin "HEAD:refs/heads/$FBI_DEFAULT"`
- `git push --force-with-lease origin "HEAD:refs/heads/$FBI_BRANCH"` →
  `git push --recurse-submodules=on-demand --force-with-lease origin "HEAD:refs/heads/$FBI_BRANCH"`

Leave all `rebase`, `merge`, `checkout`, `commit`, `reset` invocations
untouched.

- [ ] **Step 2.3 — Verify shell**

```
sh -n src/server/orchestrator/fbi-history-op.sh
bash -n src/server/orchestrator/supervisor.sh
```

Both should print nothing.

- [ ] **Step 2.4 — Commit**

```
git add -A
git commit -m "fix(orchestrator): --recurse-submodules=on-demand on post-commit + history ops"
```

---

## Task 3 — `run_push_submodule` in history-op script

**Files:**
- Modify: `src/server/orchestrator/fbi-history-op.sh`

- [ ] **Step 3.1 — Add case + function**

At the bottom of the script, **before** the final `case "$FBI_OP"`
dispatch, add a new function:

```sh
run_push_submodule() {
  : "${FBI_PATH:?FBI_PATH required for push-submodule}"
  if [ ! -d "/workspace/$FBI_PATH/.git" ] && [ ! -f "/workspace/$FBI_PATH/.git" ]; then
    emit_fail gh-error "not a git repo: $FBI_PATH"
    exit 0
  fi
  if ! out=$(git -C "/workspace/$FBI_PATH" push origin HEAD 2>&1); then
    emit_fail gh-error "submodule push failed: $out"
    exit 0
  fi
  sha=$(git -C "/workspace/$FBI_PATH" rev-parse HEAD 2>/dev/null || echo '')
  emit_ok "$sha"
}
```

Add the dispatch case inside the existing `case "$FBI_OP"` block (with
the others):

```sh
  push-submodule) run_push_submodule ;;
```

**Important**: `run_push_submodule` must run BEFORE the script's current
worktree setup that `cd`s into `$WORK`. The existing script sets up the
worktree near the top, then runs the selected op. Restructure so the
worktree setup is skipped for `push-submodule`: wrap the worktree setup
in an `if` that excludes that op:

Find the block starting `WORK=$(mktemp -d)` and ending with `cd "$WORK"`.
Replace with:

```sh
# push-submodule doesn't need a worktree — it operates on the existing
# /workspace/<path> submodule clone directly.
if [ "$FBI_OP" != "push-submodule" ]; then
  WORK=$(mktemp -d)
  cleanup() {
    git -C /workspace worktree remove --force "$WORK" 2>/dev/null || rm -rf "$WORK"
  }
  trap cleanup EXIT

  if ! out=$(git -C /workspace fetch --quiet --recurse-submodules=on-demand origin '+refs/heads/*:refs/remotes/origin/*' 2>&1); then
    emit_fail gh-error "fetch failed: $out"
    exit 0
  fi

  if ! out=$(git -C /workspace worktree add --detach "$WORK" "origin/$FBI_DEFAULT" 2>&1); then
    emit_fail gh-error "worktree add failed: $out"
    exit 0
  fi

  cd "$WORK"
fi
```

- [ ] **Step 3.2 — Verify syntax**

```
sh -n src/server/orchestrator/fbi-history-op.sh
```

- [ ] **Step 3.3 — Commit**

```
git add -A
git commit -m "feat(orchestrator): push-submodule history op"
```

---

## Task 4 — `RunsRepo.listByParent` wiring + /history accepts new op

**Files:**
- Modify: `src/server/orchestrator/historyOp.ts`
- Modify: `src/server/orchestrator/index.ts` (accept new op in type)
- Modify: `src/server/api/runs.ts`

- [ ] **Step 4.1 — Extend `buildEnv`**

In `src/server/orchestrator/historyOp.ts`, update `buildEnv` to pass the
submodule path as `FBI_PATH`:

```ts
export interface HistoryOpEnv {
  FBI_OP: string;
  FBI_BRANCH: string;
  FBI_DEFAULT: string;
  FBI_STRATEGY?: string;
  FBI_SUBJECT?: string;
  FBI_RUN_ID?: string;
  FBI_PATH?: string;
}

export function buildEnv(runId: number, branch: string, defaultBranch: string, op: HistoryOp): HistoryOpEnv {
  const env: HistoryOpEnv = {
    FBI_OP: op.op,
    FBI_BRANCH: branch,
    FBI_DEFAULT: defaultBranch,
    FBI_RUN_ID: String(runId),
  };
  if (op.op === 'merge') env.FBI_STRATEGY = op.strategy ?? 'merge';
  if (op.op === 'merge' && op.strategy === 'squash') {
    env.FBI_SUBJECT = `Merge branch '${branch}' (FBI run #${runId})`;
  }
  if (op.op === 'squash-local') env.FBI_SUBJECT = op.subject;
  if (op.op === 'push-submodule') env.FBI_PATH = op.path;
  return env;
}
```

- [ ] **Step 4.2 — Route `push-submodule` in /history endpoint**

In `src/server/api/runs.ts`, find the `POST /api/runs/:id/history`
handler. The top of the handler dispatches `polish` to `spawnSubRun`.
Below that is `let resolved: HistoryOp = op;`. Extend the dispatch so
`push-submodule` is routed through `execHistoryOp` like other git ops.
Practically, the existing flow (`execHistoryOp(runId, resolved)`) works
for `push-submodule` too — the difference is only in the script. No
code change needed here IF the current handler passes through unknown
`op` values; verify that it doesn't reject. Looking at the spec's
description, the handler already dispatches anything except `'polish'`
to `execHistoryOp`. Confirm this in the file. If there's a whitelist,
add `'push-submodule'`.

- [ ] **Step 4.3 — Test**

Add a case in `runs.test.ts` that posts `{op:'push-submodule', path:'foo'}`
with a stubbed orchestrator returning `{kind:'complete', sha:'abc'}`:

```ts
it('push-submodule routes to execHistoryOp', async () => {
  const { dir, projects, runs, run } = setupRun();
  let received: unknown = null;
  const app = Fastify();
  registerRunsRoutes(app, {
    runs, projects, streams: new RunStreamRegistry(),
    runsDir: dir, draftUploadsDir: dir,
    launch: async () => {}, cancel: async () => {},
    fireResumeNow: () => {}, continueRun: async () => {},
    gh: stubGh,
    orchestrator: {
      ...stubOrchestrator,
      execHistoryOp: async (_rid, op) => { received = op; return { kind: 'complete', sha: 'abc' }; },
    },
  });
  const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/history`,
    payload: { op: 'push-submodule', path: 'foo' } });
  expect(res.statusCode).toBe(200);
  expect(received).toEqual({ op: 'push-submodule', path: 'foo' });
});
```

- [ ] **Step 4.4 — Run + commit**

```
npm run typecheck
npm test -- --run src/server/api/runs.test.ts
git add -A
git commit -m "feat(api): /history accepts op:'push-submodule'"
```

---

## Task 5 — GitStateWatcher: parse dirty submodules

**Files:**
- Modify: `src/server/orchestrator/gitStateWatcher.ts`
- Modify: `src/server/orchestrator/gitStateWatcher.test.ts`

- [ ] **Step 5.1 — Extend script**

The watcher currently issues a single shell pipeline with marker
separators. Add two more markers for submodule data:

Find the `const script = [ ... ].join('; ');` block. Append these
lines before `'exit 0'`:

```ts
`printf "__SM_STATUS__"; git submodule status 2>/dev/null`,
`printf "__SM_INFO__"; git config --file .gitmodules --get-regexp '^submodule\\\\..*\\\\.\\\\(path\\\\|url\\\\)$' 2>/dev/null`,
```

- [ ] **Step 5.2 — Parse**

In the `splitMarkers` call, add `'__SM_STATUS__'`, `'__SM_INFO__'` to
the marker list.

In `parseGitState` (or a new helper), parse them:

```ts
export interface RawSubmoduleDirty {
  path: string;
  url: string | null;
  dirty_paths: string[];  // we'll refine to FilesDirtyEntry via numstat in a follow-up; for v1 just paths
}

export function parseSubmoduleStatus(smStatus: string, smInfo: string): RawSubmoduleDirty[] {
  const urls = new Map<string, string>();  // path -> url
  // .gitmodules output rows are like: submodule.<name>.path foo  or  submodule.<name>.url https://...
  const byName: Record<string, { path?: string; url?: string }> = {};
  for (const line of smInfo.split('\n')) {
    if (!line) continue;
    const m = line.match(/^submodule\.(.+?)\.(path|url) (.+)$/);
    if (!m) continue;
    byName[m[1]] = byName[m[1]] ?? {};
    (byName[m[1]] as Record<string, string>)[m[2]] = m[3];
  }
  for (const info of Object.values(byName)) {
    if (info.path) urls.set(info.path, info.url ?? null as unknown as string);
  }

  // status format: `[ +-]<sha> <path> [<description>]`
  // '+' = differs from recorded  '-' = not initialized  ' ' = clean
  const out: RawSubmoduleDirty[] = [];
  for (const line of smStatus.split('\n')) {
    if (!line) continue;
    const marker = line[0];
    // parse path
    const rest = line.slice(42); // 1 (marker) + 40 (sha) + 1 (space)
    const path = rest.split(' ')[0];
    if (!path) continue;
    if (marker === '+' || marker === '-') {
      out.push({ path, url: urls.get(path) ?? null, dirty_paths: [] });
    }
  }
  return out;
}
```

For v1 we don't dive INTO each dirty submodule to list its files. That's
a follow-up (server would need to run `git -C <path> status --porcelain`
per dirty submodule, multiplying docker execs). For now, `dirty` in the
emitted `SubmoduleDirty` is `[]`, and `unpushed_commits` is `[]`. The UI
still surfaces the submodule with its path + a "dirty" indicator.

- [ ] **Step 5.3 — Thread into `FilesPayload`**

In `gitStateWatcher.ts`, extend `FilesPayload` emission (or its internal
snapshot shape — whatever the watcher currently produces) to include
`dirty_submodules: SubmoduleDirty[]`. If the watcher emits a local type
distinct from `FilesPayload`, add a field there and map it at the
publish site.

Current emission in `orchestrator/index.ts`:
```ts
this.lastFiles.set(runId, snap);
events.publish({
  type: 'changes',
  branch_name: runNow?.branch_name || null,
  ...
});
```

`snap` should gain `dirty_submodules` upstream. Touch
`gitStateWatcher.ts` to populate it from the parser, then just propagate.

- [ ] **Step 5.4 — Tests**

Add to `gitStateWatcher.test.ts`:

```ts
describe('parseSubmoduleStatus', () => {
  it('detects dirty submodules via + marker', () => {
    const status = ' a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9 docs (docs-a1)\n+abcdef0123456789abcdef0123456789abcdef01 cli/fbi-tunnel (fbi-tunnel-v1)\n';
    const info = 'submodule.cli-tunnel.path cli/fbi-tunnel\nsubmodule.cli-tunnel.url https://github.com/x/y\nsubmodule.docs.path docs\nsubmodule.docs.url https://github.com/x/z\n';
    const r = parseSubmoduleStatus(status, info);
    expect(r).toEqual([
      { path: 'cli/fbi-tunnel', url: 'https://github.com/x/y', dirty_paths: [] },
    ]);
  });
  it('returns [] on empty input', () => {
    expect(parseSubmoduleStatus('', '')).toEqual([]);
  });
});
```

- [ ] **Step 5.5 — Run + commit**

```
npm test -- --run src/server/orchestrator/gitStateWatcher.test.ts
npm run typecheck
git add -A
git commit -m "feat(orchestrator): GitStateWatcher parses dirty submodules"
```

---

## Task 6 — `/changes` endpoint: `submodule_bumps` per commit + `dirty_submodules` + `children`

**Files:**
- Modify: `src/server/api/runs.ts`

- [ ] **Step 6.1 — Compose submodule_bumps per commit**

For each commit returned by `gh.commitsOnBranch`, run:

```
git show <sha> --submodule=log --no-color
```

via `deps.orchestrator.execInContainer`. Parse output: lines starting
with `Submodule <path> <from>..<to>:` introduce a bump; subsequent lines
beginning with `>` are commits in that submodule.

Add a helper in `runs.ts` (near `parseNumstat`):

```ts
interface RawBump {
  path: string;
  from: string;
  to: string;
  subjects: Array<{ sha: string; subject: string }>;
}

function parseSubmoduleLog(raw: string): RawBump[] {
  const out: RawBump[] = [];
  let current: RawBump | null = null;
  for (const line of raw.split('\n')) {
    const header = line.match(/^Submodule (\S+) ([0-9a-f]+)\.\.([0-9a-f]+):?/);
    if (header) {
      current = { path: header[1], from: header[2], to: header[3], subjects: [] };
      out.push(current);
      continue;
    }
    const commit = line.match(/^  > ([0-9a-f]+) (.+)$/);
    if (current && commit) {
      current.subjects.push({ sha: commit[1], subject: commit[2] });
    }
  }
  return out;
}
```

In the `/changes` handler, for each commit in `commits` array, populate
`submodule_bumps`:

```ts
for (const c of commits) {
  c.submodule_bumps = [];
  try {
    const r = await deps.orchestrator.execInContainer(runId, [
      'git', '-C', '/workspace', 'show', c.sha, '--submodule=log', '--no-color',
    ], { timeoutMs: 3000 });
    if (r.exitCode === 0) {
      const raw = parseSubmoduleLog(r.stdout);
      c.submodule_bumps = raw.map((b) => ({
        path: b.path,
        url: null,  // filled below via .gitmodules if we have time — optional
        from: b.from,
        to: b.to,
        commits: b.subjects.slice(0, 20).map((s) => ({
          sha: s.sha, subject: s.subject, committed_at: 0, pushed: false,
          files: [], files_loaded: false, submodule_bumps: [],
        })),
        commits_truncated: b.subjects.length > 20,
      }));
    }
  } catch { /* live container gone; skip bumps for this commit */ }
}
```

`committed_at` can be 0 (we don't surface time-ago for inner commits
in v1). `pushed: false` is safe — the UI doesn't rely on it for inner
commits. `submodule_bumps: []` enforces the flatten-one-level rule.

- [ ] **Step 6.2 — Populate `dirty_submodules`**

From `live?.dirty_submodules ?? []` — the watcher emits it. Directly
assign to `payload.dirty_submodules`.

- [ ] **Step 6.3 — Populate `children`**

```ts
const children: ChildRunSummary[] = deps.runs.listByParent(runId).map((r) => ({
  id: r.id,
  kind: r.kind,
  state: r.state,
  created_at: r.created_at,
}));
```

Add to payload.

- [ ] **Step 6.4 — Type cleanup**

Import `ChildRunSummary`, `SubmoduleBump`, `SubmoduleDirty` from
`'../../shared/types.js'`. Update the `payload: ChangesPayload`
construction to include the three new fields.

- [ ] **Step 6.5 — Tests**

Add unit tests for `parseSubmoduleLog` in `runs.test.ts`:

```ts
describe('parseSubmoduleLog', () => {
  it('extracts a bump with commit subjects', () => {
    const raw =
      'commit abc\n' +
      'Author: x\n' +
      '\n' +
      '    feat: bump\n' +
      '\n' +
      'Submodule cli/tunnel aaa1111..bbb2222:\n' +
      '  > bbb2222 polish cli\n' +
      '  > ccc3333 fix bug\n';
    const r = parseSubmoduleLog(raw);
    expect(r).toEqual([{
      path: 'cli/tunnel', from: 'aaa1111', to: 'bbb2222',
      subjects: [
        { sha: 'bbb2222', subject: 'polish cli' },
        { sha: 'ccc3333', subject: 'fix bug' },
      ],
    }]);
  });
});
```

And a happy-path `/changes` test that returns a commit with a populated
`submodule_bumps`. Reuse the existing setup pattern (mock
`execInContainer` to return the raw show output).

- [ ] **Step 6.6 — Run + commit**

```
npm test -- --run src/server/api/runs.test.ts
git add -A
git commit -m "feat(api): /changes populates submodule_bumps, dirty_submodules, children"
```

---

## Task 7 — New endpoint: `/submodule/:path/commits/:sha/files`

**Files:**
- Modify: `src/server/api/runs.ts`

- [ ] **Step 7.1 — Add handler**

```ts
app.get('/api/runs/:id/submodule/:path/commits/:sha/files', async (req, reply) => {
  const { id, sha } = req.params as { id: string; sha: string; path: string };
  const runId = Number(id);
  const submodulePath = decodeURIComponent((req.params as { path: string }).path);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return reply.code(400).send({ error: 'invalid sha' });
  if (submodulePath.includes('..')) return reply.code(400).send({ error: 'invalid path' });

  try {
    const r = await deps.orchestrator.execInContainer(runId, [
      'git', '-C', `/workspace/${submodulePath}`, 'show', '--numstat', '--format=', sha,
    ], { timeoutMs: 5000 });
    if (r.exitCode === 0) return { files: parseNumstat(r.stdout) };
  } catch { /* no container */ }
  return { files: [] };
});
```

Note: the route's `:path` segment may contain slashes. Fastify supports
wildcard params but single `:path` only captures one segment. Use a
catch-all route instead:

```ts
app.get('/api/runs/:id/submodule/*', async (req, reply) => {
  const rawPath = (req.params as { '*': string })['*'];
  // expected: <submodule-path>/commits/<sha>/files
  const m = rawPath.match(/^(.+)\/commits\/([0-9a-f]{7,40})\/files$/);
  if (!m) return reply.code(404).send({ error: 'not found' });
  const [, submodulePath, sha] = m;
  // ... rest same as above
});
```

Use this version.

- [ ] **Step 7.2 — Test**

Add to `runs.test.ts`:

```ts
it('GET /api/runs/:id/submodule/<path>/commits/<sha>/files returns numstat', async () => {
  const { dir, projects, runs, run } = setupRun();
  const app = Fastify();
  registerRunsRoutes(app, {
    runs, projects, gh: stubGh, streams: new RunStreamRegistry(),
    runsDir: dir, draftUploadsDir: dir,
    launch: async () => {}, cancel: async () => {},
    fireResumeNow: () => {}, continueRun: async () => {},
    orchestrator: {
      ...stubOrchestrator,
      execInContainer: async () => ({ stdout: '3\t1\tfoo.ts\n', stderr: '', exitCode: 0 }),
    },
  });
  const res = await app.inject({
    method: 'GET',
    url: `/api/runs/${run.id}/submodule/cli%2Fmy-sub/commits/abc1234/files`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ files: [{ path: 'foo.ts', status: 'M', additions: 3, deletions: 1 }] });
});
```

- [ ] **Step 7.3 — Run + commit**

```
npm test -- --run src/server/api/runs.test.ts
git add -A
git commit -m "feat(api): /submodule/<path>/commits/:sha/files endpoint"
```

---

## Task 8 — Web API client

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 8.1 — Add method**

```ts
getRunSubmoduleCommitFiles: (id: number, submodulePath: string, sha: string) =>
  request<{ files: FilesHeadEntry[] }>(
    `/api/runs/${id}/submodule/${submodulePath.split('/').map(encodeURIComponent).join('/')}/commits/${encodeURIComponent(sha)}/files`
  ),
```

`postRunHistory` already accepts the generic `HistoryOp`, which now
includes `push-submodule` (from Task 1 type additions). No change to
the method body.

- [ ] **Step 8.2 — Typecheck + commit**

```
npm run typecheck
git add -A
git commit -m "feat(web/api): getRunSubmoduleCommitFiles"
```

---

## Task 9 — `useMergeStrategy` hook

**Files:**
- Create: `src/web/features/runs/useMergeStrategy.ts`
- Create: `src/web/features/runs/useMergeStrategy.test.ts`

- [ ] **Step 9.1 — Tests first**

```ts
// src/web/features/runs/useMergeStrategy.test.ts
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useMergeStrategy } from './useMergeStrategy.js';

describe('useMergeStrategy', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to projectDefault when localStorage empty', () => {
    const { result } = renderHook(() => useMergeStrategy('rebase'));
    expect(result.current.strategy).toBe('rebase');
  });

  it('reads persisted value and ignores projectDefault', () => {
    localStorage.setItem('fbi.mergeStrategy', 'squash');
    const { result } = renderHook(() => useMergeStrategy('merge'));
    expect(result.current.strategy).toBe('squash');
  });

  it('setStrategy updates and persists', () => {
    const { result } = renderHook(() => useMergeStrategy('squash'));
    act(() => result.current.setStrategy('rebase'));
    expect(result.current.strategy).toBe('rebase');
    expect(localStorage.getItem('fbi.mergeStrategy')).toBe('rebase');
  });

  it('ignores invalid persisted value and falls back', () => {
    localStorage.setItem('fbi.mergeStrategy', 'bogus');
    const { result } = renderHook(() => useMergeStrategy('squash'));
    expect(result.current.strategy).toBe('squash');
  });
});
```

- [ ] **Step 9.2 — Implement**

```ts
// src/web/features/runs/useMergeStrategy.ts
import { useCallback, useState } from 'react';
import type { MergeStrategy } from '@shared/types.js';

const KEY = 'fbi.mergeStrategy';

function readInitial(projectDefault: MergeStrategy): MergeStrategy {
  if (typeof window === 'undefined') return projectDefault;
  const raw = window.localStorage.getItem(KEY);
  if (raw === 'merge' || raw === 'rebase' || raw === 'squash') return raw;
  return projectDefault;
}

export interface UseMergeStrategy {
  strategy: MergeStrategy;
  setStrategy: (s: MergeStrategy) => void;
}

export function useMergeStrategy(projectDefault: MergeStrategy): UseMergeStrategy {
  const [strategy, setStrategyState] = useState<MergeStrategy>(() => readInitial(projectDefault));
  const setStrategy = useCallback((s: MergeStrategy) => {
    setStrategyState(s);
    try { window.localStorage.setItem(KEY, s); } catch { /* quota */ }
  }, []);
  return { strategy, setStrategy };
}
```

- [ ] **Step 9.3 — Run + commit**

```
npm test -- --run src/web/features/runs/useMergeStrategy.test.ts
git add -A
git commit -m "feat(runs): useMergeStrategy hook with global localStorage"
```

---

## Task 10 — `SplitButtonMerge` component

**Files:**
- Create: `src/web/features/runs/SplitButtonMerge.tsx`
- Create: `src/web/features/runs/SplitButtonMerge.test.tsx`

- [ ] **Step 10.1 — Test**

```tsx
// src/web/features/runs/SplitButtonMerge.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SplitButtonMerge } from './SplitButtonMerge.js';

describe('SplitButtonMerge', () => {
  beforeEach(() => localStorage.clear());

  it('label reflects the persisted strategy', () => {
    localStorage.setItem('fbi.mergeStrategy', 'rebase');
    render(<SplitButtonMerge busy={false} disabled={false}
      onMerge={vi.fn()} projectDefault="squash" />);
    expect(screen.getByRole('button', { name: /Merge with rebase/ })).toBeInTheDocument();
  });

  it('body click fires onMerge with current strategy', () => {
    const onMerge = vi.fn();
    render(<SplitButtonMerge busy={false} disabled={false}
      onMerge={onMerge} projectDefault="squash" />);
    fireEvent.click(screen.getByRole('button', { name: /Merge with squash/ }));
    expect(onMerge).toHaveBeenCalledWith('squash');
  });

  it('caret click opens popover; selecting item updates label without firing onMerge', () => {
    const onMerge = vi.fn();
    render(<SplitButtonMerge busy={false} disabled={false}
      onMerge={onMerge} projectDefault="squash" />);
    fireEvent.click(screen.getByLabelText('Choose strategy'));
    fireEvent.click(screen.getByText(/Rebase & fast-forward/));
    expect(onMerge).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Merge with rebase/ })).toBeInTheDocument();
    expect(localStorage.getItem('fbi.mergeStrategy')).toBe('rebase');
  });

  it('disabled prevents merge click', () => {
    const onMerge = vi.fn();
    render(<SplitButtonMerge busy={false} disabled={true}
      disabledReason="Nothing to merge"
      onMerge={onMerge} projectDefault="squash" />);
    const btn = screen.getByRole('button', { name: /Merge with squash/ });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('busy shows "Merging..." label', () => {
    render(<SplitButtonMerge busy={true} disabled={false}
      onMerge={vi.fn()} projectDefault="squash" />);
    expect(screen.getByRole('button', { name: /Merging/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 10.2 — Implement**

```tsx
// src/web/features/runs/SplitButtonMerge.tsx
import { useState, useRef, useEffect } from 'react';
import { useMergeStrategy } from './useMergeStrategy.js';
import type { MergeStrategy } from '@shared/types.js';

const LABEL: Record<MergeStrategy, string> = {
  merge: 'Merge with merge-commit',
  rebase: 'Merge with rebase',
  squash: 'Merge with squash',
};
const HINT: Record<MergeStrategy, string> = {
  merge: 'preserves history',
  rebase: 'linear history',
  squash: 'clean main',
};

export interface SplitButtonMergeProps {
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onMerge: (strategy: MergeStrategy) => void;
  projectDefault: MergeStrategy;
}

export function SplitButtonMerge({ busy, disabled, disabledReason, onMerge, projectDefault }: SplitButtonMergeProps) {
  const { strategy, setStrategy } = useMergeStrategy(projectDefault);
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

  const label = busy ? 'Merging…' : LABEL[strategy];
  return (
    <div ref={ref} className="relative inline-flex rounded-md overflow-hidden border border-accent bg-accent">
      <button
        type="button"
        onClick={() => onMerge(strategy)}
        disabled={disabled || busy}
        title={disabled ? disabledReason : undefined}
        className="px-3 py-1.5 text-[13px] font-medium text-bg bg-accent hover:bg-accent-strong disabled:opacity-50"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label="Choose strategy"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="px-2 py-1.5 text-[13px] text-bg bg-accent hover:bg-accent-strong border-l border-bg/30 disabled:opacity-50"
      >
        ▾
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 mt-1 z-[var(--z-palette)] min-w-[240px] bg-surface-raised border border-border-strong rounded-md shadow-popover py-1">
          {(['merge', 'rebase', 'squash'] as const).map((s) => (
            <button
              key={s}
              role="menuitem"
              onClick={() => { setStrategy(s); setOpen(false); }}
              className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-sm text-text hover:bg-surface"
            >
              <span className="w-3 inline-flex justify-center">
                {strategy === s ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M1.5 5 L4 7.5 L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </span>
              <span className="flex-1">{LABEL[s]}</span>
              <span className="text-[11px] text-text-faint">{HINT[s]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 10.3 — Run + commit**

```
npm test -- --run src/web/features/runs/SplitButtonMerge.test.tsx
git add -A
git commit -m "feat(runs): SplitButtonMerge component"
```

---

## Task 11 — `computeShipDot` helper

**Files:**
- Create: `src/web/features/runs/ship/computeShipDot.ts`
- Create: `src/web/features/runs/ship/computeShipDot.test.ts`

- [ ] **Step 11.1 — Test**

```ts
// src/web/features/runs/ship/computeShipDot.test.ts
import { describe, it, expect } from 'vitest';
import { computeShipDot } from './computeShipDot.js';
import type { ChangesPayload } from '@shared/types.js';

const base: ChangesPayload = {
  branch_name: 'feat/x',
  branch_base: { base: 'main', ahead: 0, behind: 0 },
  commits: [], uncommitted: [], dirty_submodules: [], children: [],
  integrations: {},
};

describe('computeShipDot', () => {
  it('no dot on a clean, up-to-date payload', () => {
    expect(computeShipDot(base)).toBe(null);
  });
  it('amber when behind > 0', () => {
    expect(computeShipDot({ ...base, branch_base: { base: 'main', ahead: 0, behind: 3 } })).toBe('amber');
  });
  it('accent when ahead > 0 and no PR', () => {
    expect(computeShipDot({ ...base, branch_base: { base: 'main', ahead: 2, behind: 0 } })).toBe('accent');
  });
  it('accent when ahead > 0 and PR open + CI passing', () => {
    expect(computeShipDot({
      ...base,
      branch_base: { base: 'main', ahead: 2, behind: 0 },
      integrations: { github: {
        pr: { number: 1, url: '#', state: 'OPEN', title: 't' },
        checks: { state: 'success', passed: 1, failed: 0, total: 1, items: [] },
      } },
    })).toBe('accent');
  });
  it('no dot when PR merged', () => {
    expect(computeShipDot({
      ...base,
      branch_base: { base: 'main', ahead: 2, behind: 0 },
      integrations: { github: {
        pr: { number: 1, url: '#', state: 'MERGED', title: 't' },
        checks: null,
      } },
    })).toBe(null);
  });
  it('amber trumps accent when both apply', () => {
    expect(computeShipDot({
      ...base,
      branch_base: { base: 'main', ahead: 2, behind: 3 },
    })).toBe('amber');
  });
  it('no dot when CI failing', () => {
    expect(computeShipDot({
      ...base,
      branch_base: { base: 'main', ahead: 2, behind: 0 },
      integrations: { github: {
        pr: { number: 1, url: '#', state: 'OPEN', title: 't' },
        checks: { state: 'failure', passed: 1, failed: 1, total: 2, items: [] },
      } },
    })).toBe(null);
  });
});
```

- [ ] **Step 11.2 — Implement**

```ts
// src/web/features/runs/ship/computeShipDot.ts
import type { ChangesPayload } from '@shared/types.js';

export type ShipDot = 'amber' | 'accent' | null;

export function computeShipDot(p: ChangesPayload): ShipDot {
  if (!p.branch_name) return null;
  const behind = p.branch_base?.behind ?? 0;
  const ahead = p.branch_base?.ahead ?? 0;
  if (behind > 0) return 'amber';
  const gh = p.integrations.github;
  const prMerged = gh?.pr?.state === 'MERGED';
  const checksOk = !gh?.checks || gh.checks.state === 'success';
  if (ahead > 0 && !prMerged && checksOk) return 'accent';
  return null;
}
```

- [ ] **Step 11.3 — Run + commit**

```
npm test -- --run src/web/features/runs/ship/computeShipDot.test.ts
git add -A
git commit -m "feat(runs): computeShipDot helper"
```

---

## Task 12 — Ship tab sections (Header, MergePrimary, History, Agent)

**Files:**
- Create: `src/web/features/runs/ship/ShipHeader.tsx`
- Create: `src/web/features/runs/ship/MergePrimary.tsx`
- Create: `src/web/features/runs/ship/HistorySection.tsx`
- Create: `src/web/features/runs/ship/AgentSection.tsx`

- [ ] **Step 12.1 — ShipHeader**

```tsx
// src/web/features/runs/ship/ShipHeader.tsx
import type { ChangesPayload, RunState } from '@shared/types.js';
import { ExternalLink } from '@ui/primitives/icons/ExternalLink.js';

export interface ShipHeaderProps {
  changes: ChangesPayload;
  runState: RunState;
}

export function ShipHeader({ changes, runState }: ShipHeaderProps) {
  const ahead = changes.branch_base?.ahead ?? 0;
  const behind = changes.branch_base?.behind ?? 0;
  const base = changes.branch_base?.base ?? 'main';
  const pr = changes.integrations.github?.pr;
  const checks = changes.integrations.github?.checks;
  const isMerged = pr?.state === 'MERGED';
  const isClosed = pr?.state === 'CLOSED' && !isMerged;

  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border text-[13px] text-text-dim">
        <span className="font-mono text-text">{changes.branch_name}</span>
        <span className="text-text-faint">·</span>
        <span className="font-mono text-[12px] text-ok">{ahead} ahead</span>
        <span className="font-mono text-[12px] text-text-faint">/</span>
        <span className={`font-mono text-[12px] ${behind > 0 ? 'text-warn font-medium' : 'text-text-faint'}`}>{behind} behind</span>
        <span className="font-mono text-[12px] text-text-faint">{base}</span>
        {pr && (
          <>
            <span className="text-text-faint">·</span>
            <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong inline-flex items-center gap-1">
              PR #{pr.number} <ExternalLink />
            </a>
          </>
        )}
        {checks && (
          <>
            <span className="text-text-faint">·</span>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${checks.state === 'failure' ? 'bg-fail' : checks.state === 'pending' ? 'bg-warn animate-pulse' : 'bg-ok'}`} />
            <span className="text-[12px]">ci {checks.passed}/{checks.total}</span>
          </>
        )}
      </div>
      {isMerged && (
        <div className="mx-4 my-3 px-3 py-2 rounded-md bg-ok-subtle border border-ok/40 text-[13px] text-ok">
          ✓ Shipped · merged as <span className="font-mono">{/* sha of merge commit unknown in this payload; show PR state only */}</span>
        </div>
      )}
      {isClosed && (
        <div className="mx-4 my-3 px-3 py-2 rounded-md bg-warn-subtle border border-warn/40 text-[13px] text-warn">
          PR closed (not merged)
        </div>
      )}
      {/* reference runState for future banners (e.g. run state indicators) */}
      {runState === 'failed' && (
        <div className="mx-4 my-3 px-3 py-2 rounded-md bg-fail-subtle border border-fail/40 text-[13px] text-fail">
          Run failed — review output before merging.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 12.2 — MergePrimary**

```tsx
// src/web/features/runs/ship/MergePrimary.tsx
import { SplitButtonMerge } from '../SplitButtonMerge.js';
import type { ChangesPayload, MergeStrategy } from '@shared/types.js';

export interface MergePrimaryProps {
  changes: ChangesPayload;
  projectDefault: MergeStrategy;
  busy: boolean;
  onMerge: (strategy: MergeStrategy) => void;
}

export function MergePrimary({ changes, projectDefault, busy, onMerge }: MergePrimaryProps) {
  const ahead = changes.branch_base?.ahead ?? 0;
  const disabled = ahead === 0 || !changes.branch_name;
  const disabledReason = !changes.branch_name
    ? "This run didn't produce a branch."
    : ahead === 0
      ? 'Nothing to merge.'
      : undefined;

  return (
    <div className="mx-4 my-3 px-4 py-4 rounded-md border border-accent-subtle bg-accent-subtle/40">
      <div className="text-[13px] font-semibold text-text mb-1">Merge to main</div>
      <div className="text-[12px] text-text-dim mb-3">
        Combine this branch into {changes.branch_base?.base ?? 'main'} using the strategy you pick.
      </div>
      <div className="flex items-center gap-3">
        <SplitButtonMerge
          busy={busy} disabled={disabled} disabledReason={disabledReason}
          onMerge={onMerge} projectDefault={projectDefault}
        />
      </div>
      <div className="text-[11px] text-text-faint mt-2">Strategy persists across projects.</div>
    </div>
  );
}
```

- [ ] **Step 12.3 — HistorySection**

```tsx
// src/web/features/runs/ship/HistorySection.tsx
import type { ChangesPayload } from '@shared/types.js';

export interface HistorySectionProps {
  changes: ChangesPayload;
  busy: boolean;
  onSync: () => void;
  onSquashLocal: (subject: string) => void;
}

export function HistorySection({ changes, busy, onSync, onSquashLocal }: HistorySectionProps) {
  const behind = changes.branch_base?.behind ?? 0;
  const commitCount = changes.commits.length;
  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">History</h3>
      <div className="space-y-2">
        <ActionRow
          highlighted={behind > 0}
          button={<button type="button" onClick={onSync} disabled={busy}
            className="px-3 py-1 rounded-md border border-border-strong bg-surface text-[12px] text-text hover:bg-surface-raised disabled:opacity-50">
              Sync with main
            </button>}
          desc={<>Rebase this branch onto <b>{changes.branch_base?.base ?? 'main'}</b> and force-push. Useful when main moved during your run.</>}
        />
        {commitCount >= 2 && (
          <ActionRow
            button={<button type="button"
              onClick={() => {
                const subj = window.prompt('Squashed commit subject:', '');
                if (subj) onSquashLocal(subj);
              }}
              disabled={busy}
              className="px-3 py-1 rounded-md border border-border-strong bg-surface text-[12px] text-text hover:bg-surface-raised disabled:opacity-50">
                Squash local {commitCount}→1
              </button>}
            desc={<>Combine your {commitCount} commits into 1 on the feature branch. Cleans up before you merge.</>}
          />
        )}
      </div>
    </section>
  );
}

function ActionRow({ button, desc, highlighted }: {
  button: React.ReactNode; desc: React.ReactNode; highlighted?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 px-2 py-2 rounded-md ${highlighted ? 'bg-warn-subtle border-l-2 border-warn -ml-0.5' : ''}`}>
      <div className="flex-shrink-0">{button}</div>
      <div className="text-[12px] text-text-dim flex-1 pt-1">{desc}</div>
    </div>
  );
}
```

- [ ] **Step 12.4 — AgentSection**

```tsx
// src/web/features/runs/ship/AgentSection.tsx
export interface AgentSectionProps {
  busy: boolean;
  commitsCount: number;
  onPolish: () => void;
}

export function AgentSection({ busy, commitsCount, onPolish }: AgentSectionProps) {
  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">Agent actions</h3>
      <div className="flex items-start gap-3 px-2 py-2">
        <div className="flex-shrink-0">
          <button type="button" onClick={onPolish}
            disabled={busy || commitsCount === 0}
            className="px-3 py-1 rounded-md border border-attn/50 bg-attn-subtle text-[12px] text-attn hover:bg-attn-subtle/70 disabled:opacity-50">
              ✦ Polish commit messages
            </button>
        </div>
        <div className="text-[12px] text-text-dim flex-1 pt-1">
          Spawn an agent sub-run that rewrites each commit's subject and body without touching code.
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 12.5 — Typecheck + commit**

```
npm run typecheck
git add -A
git commit -m "feat(runs): ShipHeader, MergePrimary, HistorySection, AgentSection"
```

---

## Task 13 — Ship tab: SubmodulesSection, LinksSection, SubRunsSection

**Files:**
- Create: `src/web/features/runs/ship/SubmodulesSection.tsx`
- Create: `src/web/features/runs/ship/LinksSection.tsx`
- Create: `src/web/features/runs/ship/SubRunsSection.tsx`

- [ ] **Step 13.1 — SubmodulesSection**

```tsx
// src/web/features/runs/ship/SubmodulesSection.tsx
import type { ChangesPayload } from '@shared/types.js';

export interface SubmodulesSectionProps {
  changes: ChangesPayload;
  busy: boolean;
  onPushSubmodule: (path: string) => void;
}

export function SubmodulesSection({ changes, busy, onPushSubmodule }: SubmodulesSectionProps) {
  // Aggregate: unique submodule paths seen in dirty_submodules + all commits' bumps.
  const rows = new Map<string, { path: string; status: string; needsPush: boolean }>();
  for (const s of changes.dirty_submodules) {
    const needsPush = s.unpushed_commits.length > 0;
    const bits: string[] = [];
    if (s.unpushed_commits.length > 0) bits.push(`${s.unpushed_commits.length} local commits unpushed`);
    if (s.dirty.length > 0) bits.push(`${s.dirty.length} dirty files`);
    rows.set(s.path, { path: s.path, status: bits.join(' · ') || 'dirty', needsPush });
  }
  for (const c of changes.commits) {
    for (const b of c.submodule_bumps) {
      if (!rows.has(b.path)) {
        rows.set(b.path, { path: b.path, status: `bumped in ${c.sha.slice(0, 7)}`, needsPush: false });
      }
    }
  }
  if (rows.size === 0) return null;

  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">Submodules</h3>
      <div className="space-y-1">
        {Array.from(rows.values()).map((r) => (
          <div key={r.path} className="flex items-center gap-3 px-2 py-1.5 text-[12px]">
            <span className="font-mono text-text">📦 {r.path}</span>
            <span className="text-text-faint">·</span>
            <span className="text-text-dim flex-1">{r.status}</span>
            {r.needsPush && (
              <button type="button" onClick={() => onPushSubmodule(r.path)}
                disabled={busy}
                className="px-2 py-0.5 rounded-md border border-border-strong bg-surface text-[11px] text-text hover:bg-surface-raised disabled:opacity-50">
                  Push submodule
                </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 13.2 — LinksSection**

```tsx
// src/web/features/runs/ship/LinksSection.tsx
import type { ChangesPayload, Project } from '@shared/types.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';
import { ExternalLink } from '@ui/primitives/icons/ExternalLink.js';

export interface LinksSectionProps {
  changes: ChangesPayload;
  project: Project | null;
  creatingPr: boolean;
  onCreatePr: () => void;
}

export function LinksSection({ changes, project, creatingPr, onCreatePr }: LinksSectionProps) {
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const pr = changes.integrations.github?.pr;
  const branchHref = repo && changes.branch_name
    ? `https://github.com/${repo}/tree/${encodeURIComponent(changes.branch_name)}`
    : null;
  const anyLink = !!pr || !!branchHref || !!changes.branch_name;
  if (!anyLink && !(changes.integrations.github && !pr)) return null;

  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">Links</h3>
      <div className="flex items-center gap-3 text-[12px]">
        {changes.integrations.github && !pr && changes.branch_name && (
          <button type="button" onClick={onCreatePr} disabled={creatingPr}
            className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised disabled:opacity-50">
              {creatingPr ? 'Creating PR…' : 'Create PR'}
            </button>
        )}
        {pr && (
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong inline-flex items-center gap-1">
            View PR #{pr.number} <ExternalLink />
          </a>
        )}
        {branchHref && (
          <a href={branchHref} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong inline-flex items-center gap-1">
            Branch on GitHub <ExternalLink />
          </a>
        )}
        {changes.branch_name && (
          <button type="button"
            onClick={() => { void navigator.clipboard.writeText(changes.branch_name ?? ''); }}
            className="text-text-faint hover:text-text">
              copy branch name
          </button>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 13.3 — SubRunsSection**

```tsx
// src/web/features/runs/ship/SubRunsSection.tsx
import { Link } from 'react-router-dom';
import type { ChangesPayload } from '@shared/types.js';

export interface SubRunsSectionProps {
  children: ChangesPayload['children'];
}

export function SubRunsSection({ children }: SubRunsSectionProps) {
  if (children.length === 0) return null;
  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">Sub-runs</h3>
      <div className="space-y-1">
        {children.map((c) => (
          <Link key={c.id} to={`/runs/${c.id}`}
            className="flex items-center gap-2 px-2 py-1 text-[12px] text-text-dim hover:text-text hover:bg-surface-raised rounded-md">
            <span className="text-text-faint">↳</span>
            <span className="font-mono">#{c.id}</span>
            <span className="text-text-faint">{c.kind}</span>
            <span className="text-text-faint">·</span>
            <span>{c.state}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 13.4 — Typecheck + commit**

```
npm run typecheck
git add -A
git commit -m "feat(runs): ship SubmodulesSection, LinksSection, SubRunsSection"
```

---

## Task 14 — `ShipTab` — stitch it together

**Files:**
- Create: `src/web/features/runs/ship/ShipTab.tsx`
- Create: `src/web/features/runs/ship/ShipTab.test.tsx`

- [ ] **Step 14.1 — Implement**

```tsx
// src/web/features/runs/ship/ShipTab.tsx
import { ShipHeader } from './ShipHeader.js';
import { MergePrimary } from './MergePrimary.js';
import { HistorySection } from './HistorySection.js';
import { AgentSection } from './AgentSection.js';
import { SubmodulesSection } from './SubmodulesSection.js';
import { LinksSection } from './LinksSection.js';
import { SubRunsSection } from './SubRunsSection.js';
import { useHistoryOp } from '../useHistoryOp.js';
import type { ChangesPayload, MergeStrategy, Project, Run } from '@shared/types.js';

export interface ShipTabProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload | null;
  onCreatePr: () => void;
  creatingPr: boolean;
  onReload: () => void;
}

export function ShipTab({ run, project, changes, onCreatePr, creatingPr, onReload }: ShipTabProps) {
  const { busy, msg, run: runOp } = useHistoryOp(run.id, onReload);

  if (!changes) return <p className="p-4 text-[13px] text-text-faint">Loading ship data…</p>;
  if (!changes.branch_name) return <p className="p-4 text-[13px] text-text-faint">This run didn't produce a branch.</p>;

  const defaultStrategy: MergeStrategy = project?.default_merge_strategy ?? 'squash';

  return (
    <div>
      <ShipHeader changes={changes} runState={run.state} />
      {msg && <p className="px-4 py-1 text-[12px] text-text-dim bg-surface-raised border-y border-border">{msg}</p>}
      <MergePrimary
        changes={changes}
        projectDefault={defaultStrategy}
        busy={busy}
        onMerge={(strategy) => runOp({ op: 'merge', strategy })}
      />
      <HistorySection
        changes={changes}
        busy={busy}
        onSync={() => runOp({ op: 'sync' })}
        onSquashLocal={(subject) => runOp({ op: 'squash-local', subject })}
      />
      <AgentSection
        busy={busy}
        commitsCount={changes.commits.length}
        onPolish={() => runOp({ op: 'polish' })}
      />
      <SubmodulesSection
        changes={changes}
        busy={busy}
        onPushSubmodule={(path) => runOp({ op: 'push-submodule', path })}
      />
      <LinksSection
        changes={changes}
        project={project}
        creatingPr={creatingPr}
        onCreatePr={onCreatePr}
      />
      <SubRunsSection children={changes.children} />
    </div>
  );
}
```

- [ ] **Step 14.2 — Test**

```tsx
// src/web/features/runs/ship/ShipTab.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { ShipTab } from './ShipTab.js';
import type { ChangesPayload, Run, Project } from '@shared/types.js';

const run = { id: 1, state: 'running', branch_name: 'feat/x', project_id: 1, prompt: '', title: null } as unknown as Run;
const project = { id: 1, repo_url: 'git@github.com:me/foo.git', default_merge_strategy: 'squash' } as unknown as Project;
const base: ChangesPayload = {
  branch_name: 'feat/x',
  branch_base: { base: 'main', ahead: 2, behind: 0 },
  commits: [], uncommitted: [], dirty_submodules: [], children: [],
  integrations: {},
};

function renderTab(c: ChangesPayload | null) {
  return render(
    <MemoryRouter>
      <ShipTab run={run} project={project} changes={c}
        onCreatePr={vi.fn()} creatingPr={false} onReload={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('ShipTab', () => {
  it('loading state when changes null', () => {
    renderTab(null);
    expect(screen.getByText(/Loading ship/i)).toBeInTheDocument();
  });

  it('no-branch state', () => {
    renderTab({ ...base, branch_name: null });
    expect(screen.getByText(/didn't produce a branch/i)).toBeInTheDocument();
  });

  it('normal state: header + primary merge + history + links all visible', () => {
    renderTab(base);
    expect(screen.getByText(/Merge to main/)).toBeInTheDocument();
    expect(screen.getByText(/Sync with main/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Merge with squash/ })).toBeInTheDocument();
  });

  it('renders submodule section only when there are dirty or bumped submodules', () => {
    renderTab(base);
    expect(screen.queryByText(/^Submodules$/)).not.toBeInTheDocument();
    renderTab({ ...base, dirty_submodules: [{ path: 'foo', url: null, dirty: [], unpushed_commits: [
      { sha: 'abcd', subject: 'wip', committed_at: 0, pushed: false, files: [], files_loaded: false, submodule_bumps: [] },
    ], unpushed_truncated: false }] });
    expect(screen.getAllByText(/Submodules/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/📦 foo/)).toBeInTheDocument();
    expect(screen.getByText(/Push submodule/)).toBeInTheDocument();
  });

  it('renders Shipped banner on MERGED PR', () => {
    renderTab({
      ...base,
      integrations: { github: {
        pr: { number: 1, url: '#', state: 'MERGED', title: 't' },
        checks: null,
      } },
    });
    expect(screen.getByText(/Shipped/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 14.3 — Run + commit**

```
npm test -- --run src/web/features/runs/ship/ShipTab.test.tsx
git add -A
git commit -m "feat(runs): ShipTab composed from section components"
```

---

## Task 15 — Submodule rows in the Changes commit tree

**Files:**
- Create: `src/web/features/runs/SubmoduleBumpRow.tsx`
- Create: `src/web/features/runs/SubmoduleDirtyRow.tsx`
- Modify: `src/web/features/runs/CommitRow.tsx`

- [ ] **Step 15.1 — SubmoduleBumpRow**

```tsx
// src/web/features/runs/SubmoduleBumpRow.tsx
import { useState } from 'react';
import type { SubmoduleBump } from '@shared/types.js';

export interface SubmoduleBumpRowProps {
  runId: number;
  bump: SubmoduleBump;
}

export function SubmoduleBumpRow({ bump }: SubmoduleBumpRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1 pl-10 text-[12px] text-left hover:bg-surface-raised border-b border-border/40">
        <Chevron open={open} />
        <span className="text-[14px]">📦</span>
        <span className="font-mono text-text flex-1 truncate">{bump.path}</span>
        <span className="font-mono text-[11px] text-text-faint">{bump.from.slice(0, 7)} → {bump.to.slice(0, 7)}</span>
      </button>
      {open && (
        <div className="bg-surface-sunken pl-6">
          {bump.commits.length === 0 && (
            <p className="p-2 pl-10 text-[11px] text-text-faint">No commits reported.</p>
          )}
          {bump.commits.map((c) => (
            <div key={c.sha} className="flex items-center gap-2 px-3 py-1 pl-10 text-[12px] border-b border-border/40">
              <span className="font-mono text-text-faint">{c.sha.slice(0, 7)}</span>
              <span className="text-text truncate flex-1">{c.subject}</span>
            </div>
          ))}
          {bump.commits_truncated && (
            <p className="px-3 py-1 pl-10 text-[11px] text-text-faint">… more commits (truncated at 20)</p>
          )}
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

- [ ] **Step 15.2 — SubmoduleDirtyRow**

```tsx
// src/web/features/runs/SubmoduleDirtyRow.tsx
import { useState } from 'react';
import type { SubmoduleDirty } from '@shared/types.js';

export interface SubmoduleDirtyRowProps {
  submod: SubmoduleDirty;
}

export function SubmoduleDirtyRow({ submod }: SubmoduleDirtyRowProps) {
  const [open, setOpen] = useState(false);
  const parts: string[] = [];
  if (submod.dirty.length > 0) parts.push(`${submod.dirty.length} dirty files`);
  if (submod.unpushed_commits.length > 0) parts.push(`${submod.unpushed_commits.length} local commits`);
  const summary = parts.join(' · ') || 'dirty';
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1 text-[12px] text-left hover:bg-surface-raised border-b border-border/40">
        <Chevron open={open} />
        <span className="text-[14px]">📦</span>
        <span className="font-mono text-text flex-1 truncate">{submod.path}</span>
        <span className="text-[11px] text-text-faint">{summary}</span>
      </button>
      {open && (
        <div className="bg-surface-sunken pl-6">
          {submod.dirty.map((f) => (
            <div key={`d:${f.path}`} className="flex items-center gap-2 px-3 py-1 pl-10 text-[12px] border-b border-border/40">
              <span className="font-mono text-[10px] text-warn bg-warn-subtle px-1 rounded">{f.status}</span>
              <span className="font-mono text-text truncate flex-1">{f.path}</span>
            </div>
          ))}
          {submod.unpushed_commits.map((c) => (
            <div key={`c:${c.sha}`} className="flex items-center gap-2 px-3 py-1 pl-10 text-[12px] border-b border-border/40">
              <span className="font-mono text-text-faint">{c.sha.slice(0, 7)}</span>
              <span className="text-text truncate flex-1">{c.subject}</span>
            </div>
          ))}
          {submod.unpushed_truncated && (
            <p className="px-3 py-1 pl-10 text-[11px] text-text-faint">… more commits (truncated at 20)</p>
          )}
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

- [ ] **Step 15.3 — Extend CommitRow**

In `src/web/features/runs/CommitRow.tsx`, add an optional prop
`submoduleBumps?: SubmoduleBump[]`. Render each bump row **after** the
file list (inside the expanded body):

```tsx
import { SubmoduleBumpRow } from './SubmoduleBumpRow.js';
import type { SubmoduleBump, ... } from '@shared/types.js';

// In props:
submoduleBumps?: SubmoduleBump[];

// Inside the `{open && ...}` block, after the file list:
{props.submoduleBumps?.map((b) => (
  <SubmoduleBumpRow key={`bump:${b.path}`} runId={runId} bump={b} />
))}
```

- [ ] **Step 15.4 — Run + commit**

```
npm run typecheck
git add -A
git commit -m "feat(runs): SubmoduleBumpRow, SubmoduleDirtyRow; CommitRow renders bumps"
```

---

## Task 16 — ChangesTab: strip action bar + integration strip; render submodule rows

**Files:**
- Modify: `src/web/features/runs/ChangesTab.tsx`

- [ ] **Step 16.1 — Rewrite ChangesTab**

```tsx
// src/web/features/runs/ChangesTab.tsx
import { CommitRow } from './CommitRow.js';
import { SubmoduleDirtyRow } from './SubmoduleDirtyRow.js';
import type { ChangesPayload, Project, Run } from '@shared/types.js';

export interface ChangesTabProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload | null;
}

export function ChangesTab({ run, changes }: ChangesTabProps) {
  if (!changes) return <p className="p-3 text-[13px] text-text-faint">Loading changes…</p>;
  if (!changes.branch_name) return <p className="p-3 text-[13px] text-text-faint">This run didn't produce a branch.</p>;

  const ahead = changes.branch_base?.ahead ?? 0;
  const behind = changes.branch_base?.behind ?? 0;
  const base = changes.branch_base?.base ?? 'main';
  const empty = changes.commits.length === 0 && changes.uncommitted.length === 0 && changes.dirty_submodules.length === 0;

  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-surface-raised text-[12px]">
        <span className="font-mono text-text">{changes.branch_name}</span>
        <span className="text-text-faint">·</span>
        <span className="font-mono text-ok">{ahead} ahead</span>
        <span className="font-mono text-text-faint">/</span>
        <span className={`font-mono ${behind > 0 ? 'text-warn font-medium' : 'text-text-faint'}`}>{behind} behind</span>
        <span className="font-mono text-text-faint">{base}</span>
      </div>

      {empty ? (
        <p className="p-3 text-[13px] text-text-faint">No changes yet. The agent hasn't committed anything.</p>
      ) : (
        <div>
          {(changes.uncommitted.length > 0 || changes.dirty_submodules.length > 0) && (
            <CommitRow
              runId={run.id}
              sha="uncommitted"
              shortSha={null}
              pushed={null}
              subject={`Uncommitted (${changes.uncommitted.length}${changes.dirty_submodules.length ? ` + ${changes.dirty_submodules.length} submodule${changes.dirty_submodules.length === 1 ? '' : 's'}` : ''})`}
              fileCount={changes.uncommitted.length + changes.dirty_submodules.length}
              relativeTime="working tree"
              uncommitted
              defaultOpen
              initialFiles={changes.uncommitted}
              initialFilesLoaded
            />
          )}
          {changes.dirty_submodules.length > 0 && (
            <div className="bg-surface-sunken">
              {changes.dirty_submodules.map((s) => (
                <SubmoduleDirtyRow key={s.path} submod={s} />
              ))}
            </div>
          )}
          {changes.commits.map((c) => (
            <CommitRow
              key={c.sha}
              runId={run.id}
              sha={c.sha}
              shortSha={c.sha.slice(0, 7)}
              pushed={c.pushed}
              subject={c.subject}
              fileCount={c.files_loaded ? c.files.length : null}
              relativeTime={relativeTime(c.committed_at)}
              initialFiles={c.files_loaded ? c.files : undefined}
              initialFilesLoaded={c.files_loaded}
              submoduleBumps={c.submodule_bumps}
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

- [ ] **Step 16.2 — Run + commit**

```
npm run typecheck
git add -A
git commit -m "feat(runs): ChangesTab — strip actions, add submodule rendering"
```

---

## Task 17 — RunDrawer: add `'ship'` tab + dot indicator

**Files:**
- Modify: `src/web/features/runs/RunDrawer.tsx`

- [ ] **Step 17.1 — Rewrite**

```tsx
// src/web/features/runs/RunDrawer.tsx
import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';
import type { ShipDot } from './ship/computeShipDot.js';

export type RunTab = 'changes' | 'ship' | 'tunnel' | 'meta';

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  changesCount: number;
  portsCount: number | null;
  shipDot: ShipDot;
  height: number;
  onHeightChange: (h: number) => void;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({
  open, onToggle, changesCount, portsCount, shipDot,
  height, onHeightChange, children,
}: RunDrawerProps) {
  const [tab, setTab] = useState<RunTab>('changes');
  const pickTab = (next: RunTab): void => {
    setTab(next);
    if (!open) onToggle(true);
  };
  const shipLabel = (
    <span className="inline-flex items-center gap-1.5">
      ship
      {shipDot && (
        <span
          aria-label={shipDot === 'amber' ? 'branch is stale' : 'ready to ship'}
          className={`inline-block w-1.5 h-1.5 rounded-full ${shipDot === 'amber' ? 'bg-warn' : 'bg-accent'}`}
        />
      )}
    </span>
  );
  return (
    <Drawer
      open={open}
      onToggle={onToggle}
      height={height}
      onHeightChange={onHeightChange}
      header={
        <Tabs
          value={tab}
          onChange={pickTab}
          tabs={[
            { value: 'changes', label: 'changes', count: changesCount },
            { value: 'ship', label: shipLabel as unknown as string },
            { value: 'tunnel', label: 'tunnel', count: portsCount ?? undefined },
            { value: 'meta', label: 'meta' },
          ]}
        />
      }
    >
      <div className="h-full overflow-auto">{children(tab)}</div>
    </Drawer>
  );
}
```

Note: `Tabs` currently expects `label: string`. If it rejects
`ReactNode`, widen the `Tabs` primitive's label type to
`string | ReactNode`. That's a tiny change (`src/web/ui/primitives/Tabs.tsx`).

- [ ] **Step 17.2 — Typecheck + commit**

```
npm run typecheck
git add -A
git commit -m "feat(runs): RunDrawer adds ship tab with dot indicator"
```

---

## Task 18 — RunDetail: compute dot, route `'ship'` to ShipTab

**Files:**
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 18.1 — Wire**

Add import + usage:

```tsx
import { ShipTab } from '../features/runs/ship/ShipTab.js';
import { computeShipDot, type ShipDot } from '../features/runs/ship/computeShipDot.js';
```

Compute `shipDot` alongside `changesCount`:

```tsx
const shipDot: ShipDot = changes ? computeShipDot(changes) : null;
```

Pass to `<RunDrawer ... shipDot={shipDot} ...>`.

Update the tab render switch:

```tsx
{(t) =>
  t === 'changes' ? <ChangesTab run={run} project={project} changes={changes} /> :
  t === 'ship'    ? <ShipTab run={run} project={project} changes={changes}
                             onCreatePr={onCreatePr} creatingPr={creatingPr} onReload={onReload} /> :
  t === 'tunnel'  ? <TunnelTab runId={run.id} runState={run.state}
                               origin={window.location.origin} ports={ports} /> :
                    <MetaTab run={run} siblings={siblings} />
}
```

Remove the `onCreatePr`/`creatingPr`/`onReload` props from the ChangesTab
callsite (ChangesTab now only needs `run, project, changes`).

- [ ] **Step 18.2 — Typecheck + commit**

```
npm run typecheck
git add -A
git commit -m "feat(web): RunDetail routes ship tab + computes dot indicator"
```

---

## Task 19 — Cleanup: delete ChangesHeader + IntegrationStrip

**Files:**
- Delete: `src/web/features/runs/ChangesHeader.tsx`
- Delete: `src/web/features/runs/ChangesHeader.test.tsx`
- Delete: `src/web/features/runs/IntegrationStrip.tsx`

- [ ] **Step 19.1 — Remove**

```
rm src/web/features/runs/ChangesHeader.tsx src/web/features/runs/ChangesHeader.test.tsx
rm src/web/features/runs/IntegrationStrip.tsx
grep -rln "ChangesHeader\|IntegrationStrip" src/web
```

Expect no matches.

- [ ] **Step 19.2 — Full test suite**

```
npm run typecheck
npm test -- --run
```

- [ ] **Step 19.3 — Commit**

```
git add -A
git commit -m "chore(web): remove ChangesHeader and IntegrationStrip"
```

---

## Task 20 — End-to-end verification (dev server + Playwright)

- [ ] **Step 20.1 — Start dev server**

```
scripts/dev.sh
```

- [ ] **Step 20.2 — Smoke checks**

1. Run exists, Ship tab present in the tab bar (4 tabs).
2. Ship tab renders with status line, primary merge card, history section, agent section, links.
3. Split button label matches `localStorage['fbi.mergeStrategy']` (set to a value first to check).
4. Caret opens popover; picking a strategy updates button label; localStorage updates; merge does NOT fire.
5. Body click fires `/api/runs/:id/history` with the right body.
6. Sync button highlights amber when `behind > 0` (manually create a conflict on main in the test repo).
7. Project with a submodule: bump it → Submodules section appears on Ship; bump renders as `📦 path · abc → def` inside a commit on Changes; click expands to show commits in the submodule.
8. Dot indicator on the `ship` tab appears amber when behind > 0; accent when ahead > 0 and no blocking PR/CI.
9. Delete a ChangesHeader / IntegrationStrip reference by grep → none.

- [ ] **Step 20.3 — Final sweep**

```
npm run typecheck
npm test -- --run
npm run build
```

Expect green.

- [ ] **Step 20.4 — Commit any fallout**

```
git status
git add -A
git commit -m "chore: verification pass"
```

---

## Self-review

- [ ] Spec §1 (Tab set) — Task 17
- [ ] Spec §2 (Changes tab: action bar removed) — Task 16, Task 19
- [ ] Spec §3 (Ship tab layout) — Tasks 12, 13, 14
- [ ] Spec §4 (State machine) — Task 12 (ShipHeader banners), Task 14 (test covers states)
- [ ] Spec §5 (Data model) — Task 1
- [ ] Spec §6 (Server changes) — Tasks 2, 3, 4, 5, 6, 7
- [ ] Spec §7 (UI details) — Tasks 9, 10, 14, 15, 16
- [ ] Spec §8 (Persistence) — Task 9
- [ ] Spec §9 (Files list) — all tasks collectively
- [ ] Spec §10 (Testing) — colocated with each task
- [ ] Spec §11 (Rollout) — natural task ordering (push-hook fix in Task 2, UI later)
- [ ] No placeholders. Every step has concrete code.
- [ ] Type / property names consistent: `submodule_bumps` / `dirty_submodules` / `children` used the same everywhere.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-ship-tab-and-submodules.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints

Which approach?
