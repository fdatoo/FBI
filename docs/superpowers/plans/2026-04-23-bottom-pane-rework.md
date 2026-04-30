# Bottom-Pane Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Run Detail bottom pane into the primary run-control surface: live file changes, actionable GitHub tab (commits + PR + CI + merge), Meta tab that absorbs the right-side panel, vertical resize, and a silent post-commit hook so agents push mid-run.

**Architecture:** Server-side `GitStateWatcher` polls the live container via `docker exec` and broadcasts `files` WS events. GitHub endpoint is ungated and carries a commits list. A new `/github/merge` endpoint fast-paths via `gh api merges` and falls back to prompt-injection via the existing `writeStdin`. On the web, three tabs (FilesTab, GithubTab, MetaTab) replace today's four, the right-side `RunSidePanel` is deleted, and the drawer gains vertical resize wired to global localStorage.

**Tech Stack:** TypeScript, Fastify, dockerode, better-sqlite3, React, Vite, Vitest, Tailwind (tokenized), inline SVGs.

**Spec:** `docs/superpowers/specs/2026-04-23-bottom-pane-rework-design.md`

---

## File map

### New files
- `src/server/orchestrator/dockerExec.ts` — exec helper over dockerode
- `src/server/orchestrator/gitStateWatcher.ts` — polling watcher
- `src/web/ui/primitives/icons/ExternalLink.tsx` — inline-SVG icon
- `src/web/ui/data/DiffBlock.tsx` — inline diff renderer
- `src/web/features/runs/useBottomPaneHeight.ts` — localStorage-backed height hook
- `src/web/features/runs/MetaTab.tsx` — new consolidated tab
- Test files next to each of the above (`*.test.ts(x)`)

### Modified files
- `src/shared/types.ts` — add `parent_run_id` to `Run`, add `RunWsFilesMessage`, add `FilesPayload`, add `GithubPayload` (commits), add `MergeResponse`
- `src/server/logs/registry.ts` — include `RunWsFilesMessage` in `RunEvent`
- `src/server/github/gh.ts` — add `commitsOnBranch()`, `mergeBranch()`
- `src/server/orchestrator/supervisor.sh` — install post-commit hook
- `src/server/orchestrator/index.ts` — start/stop GitStateWatcher; retain last snapshot per run
- `src/server/api/runs.ts` — replace `/diff` with `/files`, add `/file-diff`, enhance `/github`, add `/github/merge`
- `src/server/db/index.ts` — migration for `parent_run_id`
- `src/web/lib/api.ts` — add `getRunFiles`, `getRunFileDiff`, `mergeRunBranch`; update `getRunGithub` return; remove `getRunDiff`
- `src/web/features/runs/FilesTab.tsx` — full rework (live view + inline diffs)
- `src/web/features/runs/GithubTab.tsx` — full rework (commits + actions)
- `src/web/features/runs/RunDrawer.tsx` — new tab set/order; plumb resize
- `src/web/ui/primitives/Drawer.tsx` — optional `height`/`onHeightChange` + drag handle
- `src/web/ui/primitives/index.ts` — export `ExternalLink`
- `src/web/pages/RunDetail.tsx` — drop `<aside>`, wire files stream, drop create-pr prop chain
- `src/web/pages/Design.tsx` — showcase entries for `ExternalLink`, `DiffBlock`

### Deleted files
- `src/web/features/runs/PromptTab.tsx`
- `src/web/features/runs/RunSidePanel.tsx`

---

## Task 1 — Types, schema, and DB migration

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db/index.ts`
- Modify: `src/server/logs/registry.ts`

- [ ] **Step 1.1 — Extend `Run` with `parent_run_id`**

In `src/shared/types.ts`, inside `interface Run`, add after `title_locked`:

```ts
  parent_run_id: number | null;
```

- [ ] **Step 1.2 — Add new WS + payload types**

After the existing `RunWsTitleMessage` definition in `src/shared/types.ts`, add:

```ts
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';

export interface FilesDirtyEntry {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface FilesHeadEntry {
  path: string;
  status: Exclude<FileStatus, 'U'>;
  additions: number;
  deletions: number;
}

export interface FilesPayload {
  dirty: FilesDirtyEntry[];
  head: { sha: string; subject: string } | null;
  headFiles: FilesHeadEntry[];
  branchBase: { base: string; ahead: number; behind: number } | null;
  /** true iff the server's data came from `docker exec` on a live container. */
  live: boolean;
}

export type RunWsFilesMessage = { type: 'files' } & FilesPayload;

export interface GithubCommit {
  sha: string;
  subject: string;
  committed_at: number; // unix seconds
  pushed: boolean;
}

export interface GithubCheckItem {
  name: string;
  status: 'pending' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled' | null;
  duration_ms: number | null;
}

export interface GithubPayload {
  pr: { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string } | null;
  checks: {
    state: 'pending' | 'success' | 'failure';
    passed: number;
    failed: number;
    total: number;
    items: GithubCheckItem[];
  } | null;
  commits: GithubCommit[];
  github_available: boolean;
}

export type MergeResponse =
  | { merged: true; sha: string }
  | { merged: false; reason: 'conflict'; agent: true }
  | { merged: false; reason: 'conflict' | 'agent-busy' | 'gh-not-available' | 'not-github' | 'no-branch' | 'no-pr'; agent?: false };

export interface FileDiffHunk {
  header: string;
  lines: Array<{ kind: 'ctx' | 'add' | 'del'; text: string }>;
}

export interface FileDiffPayload {
  path: string;
  ref: 'worktree' | string;
  hunks: FileDiffHunk[];
  truncated: boolean;
}
```

- [ ] **Step 1.3 — Register new WS event in `RunEvent`**

In `src/server/logs/registry.ts` change line 6–8 to:

```ts
import type {
  RunWsUsageMessage, RunWsTitleMessage, RunWsFilesMessage, GlobalStateMessage,
} from '../../shared/types.js';

export type RunEvent = RunWsUsageMessage | RunWsTitleMessage | RunWsFilesMessage;
```

- [ ] **Step 1.4 — Add DB migration**

In `src/server/db/index.ts`, inside `migrate()`, after the `title_locked` block (around line 109), append:

```ts
  if (!runCols.has('parent_run_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id)');
  }
```

- [ ] **Step 1.5 — Update `RunsRepo.get`/`listSiblings` to return the new column**

Search `src/server/db/runs.ts` for any `SELECT` statement that lists runs columns and ensure it uses `SELECT *` or explicitly includes `parent_run_id`. If explicit column lists are used, add `parent_run_id` to them. Update the Run row mapper to set `parent_run_id: row.parent_run_id ?? null`.

- [ ] **Step 1.6 — Run typecheck + existing tests**

Run:
```
npm run typecheck && npm test -- --run src/server
```
Expect all green.

- [ ] **Step 1.7 — Commit**

```
git add -A
git commit -m "feat(types): add FilesPayload, GithubPayload, MergeResponse; parent_run_id migration"
```

---

## Task 2 — `dockerExec` helper

**Files:**
- Create: `src/server/orchestrator/dockerExec.ts`
- Create: `src/server/orchestrator/dockerExec.test.ts`

- [ ] **Step 2.1 — Write the failing test**

Create `src/server/orchestrator/dockerExec.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { dockerExec } from './dockerExec.js';

function makeContainer(opts: { stdout?: Buffer; stderr?: Buffer; exitCode?: number; hang?: boolean }) {
  return {
    exec: vi.fn().mockResolvedValue({
      start: vi.fn().mockResolvedValue(makeStream(opts)),
      inspect: vi.fn().mockResolvedValue({ ExitCode: opts.exitCode ?? 0 }),
    }),
  };
}
function makeStream({ stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), hang = false }: { stdout?: Buffer; stderr?: Buffer; hang?: boolean }) {
  const { PassThrough } = require('node:stream');
  const s = new PassThrough();
  if (!hang) {
    // Emulate docker's multiplexed stream: [type, 0, 0, 0, size(4be)] + payload.
    setTimeout(() => {
      if (stdout.length) s.write(frame(1, stdout));
      if (stderr.length) s.write(frame(2, stderr));
      s.end();
    }, 5);
  }
  return s;
}
function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('dockerExec', () => {
  it('returns stdout/stderr and exit code on success', async () => {
    const c = makeContainer({ stdout: Buffer.from('hello\n'), exitCode: 0 });
    const r = await dockerExec(c as any, ['echo', 'hi']);
    expect(r.stdout).toBe('hello\n');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
  });

  it('captures stderr and non-zero exit', async () => {
    const c = makeContainer({ stderr: Buffer.from('nope\n'), exitCode: 2 });
    const r = await dockerExec(c as any, ['false']);
    expect(r.stderr).toBe('nope\n');
    expect(r.exitCode).toBe(2);
  });

  it('rejects with timeout', async () => {
    const c = makeContainer({ hang: true });
    await expect(dockerExec(c as any, ['sleep', '30'], { timeoutMs: 20 })).rejects.toThrow(/timeout/);
  });
});
```

- [ ] **Step 2.2 — Run and confirm failure**

```
npm test -- --run src/server/orchestrator/dockerExec.test.ts
```
Expect: fail — module not found.

- [ ] **Step 2.3 — Implement `dockerExec`**

Create `src/server/orchestrator/dockerExec.ts`:

```ts
import type Docker from 'dockerode';

export interface DockerExecOptions {
  timeoutMs?: number;
  workingDir?: string;
}

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a command inside an already-running container via `docker exec`.
 *  Collects stdout/stderr (UTF-8) and the inspect-reported exit code. */
export async function dockerExec(
  container: Docker.Container,
  cmd: string[],
  opts: DockerExecOptions = {},
): Promise<DockerExecResult> {
  const { timeoutMs = 5000, workingDir } = opts;
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    ...(workingDir ? { WorkingDir: workingDir } : {}),
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  return await new Promise<DockerExecResult>((resolve, reject) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { (stream as unknown as { destroy?: () => void }).destroy?.(); } catch {/* */}
      reject(new Error(`dockerExec timeout after ${timeoutMs}ms: ${cmd.join(' ')}`));
    }, timeoutMs);

    demux(stream, (kind, chunk) => {
      (kind === 2 ? errChunks : outChunks).push(chunk);
    }, async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        const info = await exec.inspect();
        resolve({
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          exitCode: typeof info.ExitCode === 'number' ? info.ExitCode : -1,
        });
      } catch (e) { reject(e); }
    }, (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Docker multiplexes stdout/stderr over one TCP stream with an 8-byte header
// per frame: [type, 0, 0, 0, size32BE]. We can't rely on line boundaries.
function demux(
  stream: NodeJS.ReadableStream,
  onChunk: (kind: 1 | 2, payload: Buffer) => void,
  onEnd: () => void,
  onError: (e: Error) => void,
): void {
  let buf = Buffer.alloc(0);
  stream.on('data', (d: Buffer) => {
    buf = buf.length === 0 ? d : Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const kind = buf[0] as 1 | 2;
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      const payload = buf.subarray(8, 8 + size);
      onChunk(kind, Buffer.from(payload));
      buf = buf.subarray(8 + size);
    }
  });
  stream.on('end', onEnd);
  stream.on('error', onError);
}
```

- [ ] **Step 2.4 — Run tests**

```
npm test -- --run src/server/orchestrator/dockerExec.test.ts
```
Expect all pass.

- [ ] **Step 2.5 — Commit**

```
git add src/server/orchestrator/dockerExec.ts src/server/orchestrator/dockerExec.test.ts
git commit -m "feat(orchestrator): dockerExec helper"
```

---

## Task 3 — `GitStateWatcher`

**Files:**
- Create: `src/server/orchestrator/gitStateWatcher.ts`
- Create: `src/server/orchestrator/gitStateWatcher.test.ts`

- [ ] **Step 3.1 — Write the failing test**

Create `src/server/orchestrator/gitStateWatcher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseGitState } from './gitStateWatcher.js';

describe('parseGitState', () => {
  it('parses porcelain v1 -z with staged/unstaged', () => {
    // Two files: modified+staged, new untracked.
    const zlist = 'M  src/a.ts ?? src/b.ts ';
    const numstat = '5\t2\tsrc/a.ts\n-\t-\tsrc/b.ts\n';
    const show = '0\t0\t';  // head show not used here
    const log = '';          // empty repo → no head
    const ahead = '';
    const r = parseGitState({ zlist, numstat, show, log, aheadBehind: ahead });
    expect(r.dirty).toEqual([
      { path: 'src/a.ts', status: 'M', additions: 5, deletions: 2 },
      { path: 'src/b.ts', status: 'U', additions: 0, deletions: 0 },
    ]);
    expect(r.head).toBeNull();
    expect(r.branchBase).toBeNull();
  });

  it('parses head commit and headFiles from show --numstat', () => {
    const log = 'a3f2b19abc feat: extract parseBearer';
    const show = '8\t3\tsrc/x.ts\n22\t0\tsrc/y.ts\n';
    const r = parseGitState({ zlist: '', numstat: '', show, log, aheadBehind: '3\t0' });
    expect(r.head).toEqual({ sha: 'a3f2b19abc', subject: 'feat: extract parseBearer' });
    expect(r.headFiles).toEqual([
      { path: 'src/x.ts', status: 'M', additions: 8, deletions: 3 },
      { path: 'src/y.ts', status: 'A', additions: 22, deletions: 0 },
    ]);
    expect(r.branchBase).toEqual({ base: '', ahead: 0, behind: 3 });  // left-right counts: ahead=LEFT, behind=RIGHT but our command places HEAD as RIGHT (see impl)
  });
});
```

Note: `parseGitState` is a pure function exported next to the watcher class for testability.

- [ ] **Step 3.2 — Run, confirm failure**

- [ ] **Step 3.3 — Implement watcher + parser**

Create `src/server/orchestrator/gitStateWatcher.ts`:

```ts
import type Docker from 'dockerode';
import { dockerExec } from './dockerExec.js';
import type { FilesPayload, FilesDirtyEntry, FilesHeadEntry, FileStatus } from '../../shared/types.js';

export interface GitStateWatcherOptions {
  container: Docker.Container;
  defaultBranch: string;
  pollMs?: number;
  onSnapshot: (s: FilesPayload) => void;
  onError?: (reason: string) => void;
}

export class GitStateWatcher {
  private opts: Required<Omit<GitStateWatcherOptions, 'onError'>> & { onError: (reason: string) => void };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;

  constructor(opts: GitStateWatcherOptions) {
    this.opts = { pollMs: 2000, onError: () => {}, ...opts };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      if (!this.ticking) {
        this.ticking = true;
        try { await this.once(); } catch (e) { this.opts.onError(String(e)); }
        finally { this.ticking = false; }
      }
      if (this.running) this.timer = setTimeout(tick, this.opts.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private async once(): Promise<void> {
    const c = this.opts.container;
    const db = this.opts.defaultBranch;
    const script = [
      'set -e',
      'cd /workspace',
      'printf "__Z__"; git status --porcelain=v1 -z || true',
      'printf "__NS__"; git diff --numstat HEAD 2>/dev/null || true',
      'printf "__LG__"; git log -1 --format="%H%x00%s" 2>/dev/null || true',
      'printf "__SH__"; git show --numstat --format= HEAD 2>/dev/null || true',
      `printf "__AB__"; git rev-list --left-right --count refs/remotes/origin/${db}...HEAD 2>/dev/null || true`,
    ].join('; ');
    const r = await dockerExec(c, ['bash', '-lc', script], { timeoutMs: 5000 });
    if (r.exitCode !== 0) return;
    const parts = splitMarkers(r.stdout, ['__Z__', '__NS__', '__LG__', '__SH__', '__AB__']);
    const payload = parseGitState({
      zlist: parts['__Z__'] ?? '',
      numstat: parts['__NS__'] ?? '',
      log: parts['__LG__'] ?? '',
      show: parts['__SH__'] ?? '',
      aheadBehind: parts['__AB__'] ?? '',
      base: this.opts.defaultBranch,
    });
    this.opts.onSnapshot({ ...payload, live: true });
  }
}

function splitMarkers(s: string, markers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let rest = s;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const idx = rest.indexOf(m);
    if (idx < 0) continue;
    const after = rest.slice(idx + m.length);
    const next = markers.slice(i + 1).map((m2) => after.indexOf(m2)).filter((n) => n >= 0);
    const end = next.length ? Math.min(...next) : after.length;
    out[m] = after.slice(0, end);
    rest = after;
  }
  return out;
}

export interface ParseInput {
  zlist: string;
  numstat: string;
  log: string;
  show: string;
  aheadBehind: string;
  base?: string;
}

export function parseGitState(in_: ParseInput): Omit<FilesPayload, 'live'> {
  const byPath = new Map<string, { status: FileStatus; adds: number; dels: number }>();
  for (const entry of in_.zlist.split(' ')) {
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    const status = mapPorcelain(code);
    byPath.set(path, { status, adds: 0, dels: 0 });
  }
  for (const line of in_.numstat.split('\n')) {
    if (!line) continue;
    const [a, d, p] = line.split('\t');
    const row = byPath.get(p);
    if (!row) continue;
    row.adds = Number.parseInt(a, 10) || 0;
    row.dels = Number.parseInt(d, 10) || 0;
  }
  const dirty: FilesDirtyEntry[] = Array.from(byPath.entries()).map(([path, r]) => ({
    path, status: r.status, additions: r.adds, deletions: r.dels,
  }));

  let head: { sha: string; subject: string } | null = null;
  const log = in_.log.trim();
  if (log) {
    const nul = log.indexOf(' ');
    if (nul > 0) head = { sha: log.slice(0, nul), subject: log.slice(nul + 1) };
  }

  const headFiles: FilesHeadEntry[] = [];
  for (const line of in_.show.split('\n')) {
    if (!line) continue;
    const [a, d, p] = line.split('\t');
    if (!p) continue;
    const adds = a === '-' ? 0 : Number.parseInt(a, 10) || 0;
    const dels = d === '-' ? 0 : Number.parseInt(d, 10) || 0;
    const status: Exclude<FileStatus, 'U'> = adds > 0 && dels === 0 ? 'A' : 'M';
    headFiles.push({ path: p, status, additions: adds, deletions: dels });
  }

  let branchBase: FilesPayload['branchBase'] = null;
  const ab = in_.aheadBehind.trim();
  if (ab) {
    const [l, r] = ab.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(l) && Number.isFinite(r)) {
      // Command was `--count refs/remotes/origin/<base>...HEAD`, so LEFT is
      // origin/base→mergebase (behind) and RIGHT is HEAD→mergebase (ahead).
      branchBase = { base: in_.base ?? '', ahead: r, behind: l };
    }
  }

  return { dirty, head, headFiles, branchBase };
}

function mapPorcelain(code: string): FileStatus {
  if (code.startsWith('??')) return 'U';
  const c = code.trim();
  if (c.includes('A')) return 'A';
  if (c.includes('D')) return 'D';
  if (c.includes('R')) return 'R';
  return 'M';
}
```

- [ ] **Step 3.4 — Run tests**

```
npm test -- --run src/server/orchestrator/gitStateWatcher.test.ts
```
Expect pass.

- [ ] **Step 3.5 — Commit**

```
git add src/server/orchestrator/gitStateWatcher.ts src/server/orchestrator/gitStateWatcher.test.ts
git commit -m "feat(orchestrator): GitStateWatcher + parser"
```

---

## Task 4 — `gh.ts`: `commitsOnBranch` + `mergeBranch`

**Files:**
- Modify: `src/server/github/gh.ts`
- Create: `src/server/github/gh.test.ts` (if absent; otherwise extend)

- [ ] **Step 4.1 — Look for an existing `gh.test.ts`**

```
ls src/server/github
```
If `gh.test.ts` exists, extend it; otherwise create a new one with the `vi.mock('node:child_process')` pattern used elsewhere in the repo.

- [ ] **Step 4.2 — Write failing tests**

Write or append:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: (_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    queueMicrotask(() => cb(null, handle(args)));
  },
}));

let handle: (args: string[]) => { stdout: string; stderr: string } = () => ({ stdout: '', stderr: '' });

import { GhClient } from './gh.js';

describe('GhClient.commitsOnBranch', () => {
  it('returns parsed commit list', async () => {
    handle = (args) => {
      expect(args[0]).toBe('api');
      expect(args[1]).toMatch(/^\/repos\/owner\/repo\/commits\?sha=feat%2Ffoo&per_page=20$/);
      return {
        stdout: JSON.stringify([
          { sha: 'aaa', commit: { message: 'feat: x\n\ndetails', committer: { date: '2026-04-23T10:00:00Z' } } },
          { sha: 'bbb', commit: { message: 'test: y', committer: { date: '2026-04-23T10:05:00Z' } } },
        ]),
        stderr: '',
      };
    };
    const gh = new GhClient();
    const r = await gh.commitsOnBranch('owner/repo', 'feat/foo');
    expect(r).toEqual([
      { sha: 'aaa', subject: 'feat: x', committed_at: Date.parse('2026-04-23T10:00:00Z') / 1000, pushed: true },
      { sha: 'bbb', subject: 'test: y', committed_at: Date.parse('2026-04-23T10:05:00Z') / 1000, pushed: true },
    ]);
  });
});

describe('GhClient.mergeBranch', () => {
  it('returns merged:true with sha on 2xx', async () => {
    handle = () => ({ stdout: JSON.stringify({ sha: 'deadbeef' }), stderr: '' });
    const gh = new GhClient();
    const r = await gh.mergeBranch('owner/repo', 'feat/foo', 'main', 'msg');
    expect(r).toEqual({ merged: true, sha: 'deadbeef' });
  });

  it('returns merged:false reason=conflict on 409', async () => {
    handle = () => { const e = new Error('HTTP 409: Merge conflict') as Error & { stderr?: string };
      e.stderr = 'HTTP 409: Merge conflict'; throw e; };
    const gh = new GhClient();
    const r = await gh.mergeBranch('owner/repo', 'feat/foo', 'main', 'msg');
    expect(r).toEqual({ merged: false, reason: 'conflict' });
  });
});
```

- [ ] **Step 4.3 — Run, confirm failure**

- [ ] **Step 4.4 — Implement methods**

Append to `src/server/github/gh.ts` before the final `}` of the `GhClient` class:

```ts
  async commitsOnBranch(repo: string, branch: string): Promise<Array<{ sha: string; subject: string; committed_at: number; pushed: boolean }>> {
    const url = `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=20`;
    try {
      const { stdout } = await ex(this.bin, ['api', url]);
      const arr = JSON.parse(stdout || '[]') as Array<{ sha: string; commit: { message: string; committer: { date: string } } }>;
      return arr.map((c) => ({
        sha: c.sha,
        subject: (c.commit?.message ?? '').split('\n', 1)[0] ?? '',
        committed_at: Math.floor(Date.parse(c.commit?.committer?.date ?? '') / 1000) || 0,
        pushed: true,
      }));
    } catch {
      return [];
    }
  }

  async mergeBranch(
    repo: string, head: string, base: string, commit_message: string,
  ): Promise<{ merged: true; sha: string } | { merged: false; reason: 'conflict' | 'gh-error' }> {
    try {
      const { stdout } = await ex(this.bin, [
        'api', '-X', 'POST', `/repos/${repo}/merges`,
        '-f', `base=${base}`,
        '-f', `head=${head}`,
        '-f', `commit_message=${commit_message}`,
      ]);
      const obj = JSON.parse(stdout || '{}') as { sha?: string };
      if (!obj.sha) return { merged: false, reason: 'gh-error' };
      return { merged: true, sha: obj.sha };
    } catch (e) {
      const msg = String((e as Error & { stderr?: string }).stderr ?? (e as Error).message ?? e);
      if (/409/.test(msg) || /conflict/i.test(msg)) return { merged: false, reason: 'conflict' };
      return { merged: false, reason: 'gh-error' };
    }
  }
```

- [ ] **Step 4.5 — Run tests**

- [ ] **Step 4.6 — Commit**

```
git add src/server/github/gh.ts src/server/github/gh.test.ts
git commit -m "feat(gh): commitsOnBranch + mergeBranch"
```

---

## Task 5 — Post-commit push hook in supervisor

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`

- [ ] **Step 5.1 — Edit supervisor**

In `src/server/orchestrator/supervisor.sh`, between line 57 and the `# Run the agent` comment (around line 59), insert:

```sh

# Install silent background post-commit hook so agent commits push to the
# feature branch as they happen. Failures do not block commits.
mkdir -p .git/hooks
cat > .git/hooks/post-commit <<'HOOK'
#!/bin/sh
( git push -u origin HEAD > /tmp/last-push.log 2>&1 || true ) &
HOOK
chmod +x .git/hooks/post-commit
```

- [ ] **Step 5.2 — Verify shell syntax**

```
bash -n src/server/orchestrator/supervisor.sh
```

- [ ] **Step 5.3 — Commit**

```
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): install silent post-commit push hook"
```

---

## Task 6 — Wire `GitStateWatcher` into the orchestrator

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 6.1 — Hold last files snapshot per run**

Near the top of the orchestrator class (alongside `active`, `lastRateLimit`), add:

```ts
private lastFiles = new Map<number, import('../../shared/types.js').FilesPayload>();
```

Add a public accessor:

```ts
getLastFiles(runId: number): import('../../shared/types.js').FilesPayload | null {
  return this.lastFiles.get(runId) ?? null;
}
```

- [ ] **Step 6.2 — Start the watcher after `tailer.start()`**

In `launch()`, after `tailer.start()` (around line 329) and `titleWatcher.start()`, add:

```ts
      const gitWatcher = new GitStateWatcher({
        container,
        defaultBranch: project?.default_branch ?? 'main',
        pollMs: 2000,
        onSnapshot: (snap) => {
          this.lastFiles.set(runId, snap);
          events.publish({ type: 'files', ...snap });
        },
      });
      gitWatcher.start();
```

Import at the top of the file:

```ts
import { GitStateWatcher } from './gitStateWatcher.js';
```

Add `gitWatcher` to the `finally` block alongside existing watchers to ensure cleanup:

```ts
      if (gitWatcher) await gitWatcher.stop();
```

Declare `let gitWatcher: GitStateWatcher | null = null;` at the top of `launch()` next to other watcher declarations so the `finally` can see it.

- [ ] **Step 6.3 — Clear on release**

In the orchestrator method that releases per-run state (search for `this.deps.streams.release(runId)` and `this.active.delete(runId)`), also call `this.lastFiles.delete(runId)`.

- [ ] **Step 6.4 — Typecheck**

```
npm run typecheck
```

- [ ] **Step 6.5 — Commit**

```
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): start GitStateWatcher per run, retain last snapshot"
```

---

## Task 7 — API: replace `/diff` with `/files`; add `/file-diff`

**Files:**
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/index.ts` (wires routes with deps — check where orchestrator is passed)
- Create/extend: `src/server/api/runs.test.ts` (use the existing setup helper)

- [ ] **Step 7.1 — Expand `Deps` and route registration**

Add to `Deps` in `src/server/api/runs.ts`:

```ts
  orchestrator: {
    writeStdin(runId: number, bytes: Uint8Array): void;
    getLastFiles(runId: number): FilesPayload | null;
    execInContainer?: (runId: number, cmd: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
```

Extend `GhDeps` with the two new methods:

```ts
  commitsOnBranch(repo: string, branch: string): Promise<Array<{ sha: string; subject: string; committed_at: number; pushed: boolean }>>;
  mergeBranch(repo: string, head: string, base: string, commit_message: string): Promise<
    { merged: true; sha: string } | { merged: false; reason: 'conflict' | 'gh-error' }
  >;
```

In the top-level wiring file (`src/server/index.ts` or wherever `registerRunsRoutes` is called), pass the orchestrator alongside existing deps. Add `execInContainer` method on the orchestrator that looks up the active container and calls `dockerExec`:

In `src/server/orchestrator/index.ts`, add a public method:

```ts
async execInContainer(runId: number, cmd: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const a = this.active.get(runId);
  if (!a) throw new Error('container not active');
  const { dockerExec } = await import('./dockerExec.js');
  return dockerExec(a.container, cmd, opts);
}
```

- [ ] **Step 7.2 — Delete `/diff` route and `diffCache`**

Delete the entire `/api/runs/:id/diff` handler (lines ~211-245) and the `DIFF_TTL_MS`/`diffCache`/`getDiffCached`/`setDiffCached` block.

- [ ] **Step 7.3 — Implement `/files`**

Add:

```ts
app.get('/api/runs/:id/files', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });

  // Live path: return the orchestrator's last snapshot if the container is
  // active. It's kept fresh by GitStateWatcher; 2s cadence is good enough.
  const live = deps.orchestrator.getLastFiles(runId);
  if (live) return live;

  // Finished-run path: fall back to gh api compare.
  const project = deps.projects.get(run.project_id);
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const available = await deps.gh.available();
  if (!project || !repo || !run.branch_name || !available) {
    return {
      dirty: [], head: null, headFiles: [], branchBase: null, live: false,
    } satisfies FilesPayload;
  }
  const files = await deps.gh.compareFiles(repo, project.default_branch, run.branch_name).catch(() => []);
  const headFiles = files.map((f) => ({
    path: f.filename,
    status: (f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M') as 'A'|'D'|'M'|'R',
    additions: f.additions,
    deletions: f.deletions,
  }));
  return {
    dirty: [],
    head: null,
    headFiles,
    branchBase: { base: project.default_branch, ahead: files.length > 0 ? 1 : 0, behind: 0 },
    live: false,
  } satisfies FilesPayload;
});
```

Import `FilesPayload` from shared types at the top of the file.

- [ ] **Step 7.4 — Implement `/file-diff`**

Add:

```ts
app.get('/api/runs/:id/file-diff', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const q = req.query as { path?: string; ref?: string };
  if (!q.path) return reply.code(400).send({ error: 'path required' });
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });
  const safePath = q.path.replace(/[^\w./@+-]/g, '');
  if (safePath !== q.path) return reply.code(400).send({ error: 'invalid path' });
  const ref = q.ref ?? 'worktree';
  const cmd = ref === 'worktree'
    ? ['git', '-C', '/workspace', 'diff', '--', safePath]
    : ['git', '-C', '/workspace', 'show', `${ref}`, '--', safePath];
  try {
    const r = await deps.orchestrator.execInContainer!(runId, cmd, { timeoutMs: 5000 });
    const parsed = parseUnifiedDiff(r.stdout, safePath, ref);
    return parsed;
  } catch (e) {
    return reply.code(409).send({ error: 'no container', message: (e as Error).message });
  }
});

function parseUnifiedDiff(
  raw: string, path: string, ref: string,
): import('../../shared/types.js').FileDiffPayload {
  const MAX = 256 * 1024;
  const truncated = raw.length > MAX;
  const body = truncated ? raw.slice(0, MAX) : raw;
  const hunks: Array<{ header: string; lines: Array<{ kind: 'ctx'|'add'|'del'; text: string }> }> = [];
  let current: typeof hunks[number] | null = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.lines.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-') && !line.startsWith('---')) current.lines.push({ kind: 'del', text: line.slice(1) });
    else if (line.startsWith(' ')) current.lines.push({ kind: 'ctx', text: line.slice(1) });
  }
  return { path, ref: ref === 'worktree' ? 'worktree' : ref, hunks, truncated };
}
```

- [ ] **Step 7.5 — Tests for `/files` fast path**

In `src/server/api/runs.test.ts` (extend), add a test where `deps.orchestrator.getLastFiles(runId)` returns a prepared payload and the route returns that payload verbatim.

- [ ] **Step 7.6 — Run tests**

- [ ] **Step 7.7 — Commit**

```
git add src/server/api/runs.ts src/server/api/runs.test.ts src/server/orchestrator/index.ts src/server/index.ts
git commit -m "feat(api): /files (replacing /diff) and /file-diff"
```

---

## Task 8 — API: enhance `/github`, add `/github/merge`

**Files:**
- Modify: `src/server/api/runs.ts`
- Extend: `src/server/api/runs.test.ts`

- [ ] **Step 8.1 — Extend `/github` return shape (commits; per-check items)**

In the existing `/api/runs/:id/github` handler, **remove** the `run.state !== 'succeeded'` gate if present (there isn't one in the server today — the UI gated it; double-check).

Replace the `checks` aggregation block with:

```ts
    const passed = checks.filter((c) => c.conclusion === 'success').length;
    const failed = checks.filter((c) => c.conclusion === 'failure').length;
    const total = checks.length;
    const state = total === 0 ? null :
      (failed > 0 ? 'failure' :
       checks.every((c) => c.status === 'completed') ? 'success' : 'pending');
    const checksPayload = total === 0 ? null : {
      state, passed, failed, total,
      items: checks.map((c) => ({
        name: c.name, status: c.status, conclusion: c.conclusion,
        duration_ms: null,  // gh pr checks doesn't expose timing directly
      })),
    };

    const commits = await deps.gh.commitsOnBranch(repo, run.branch_name).catch(() => []);
```

Change the returned payload:

```ts
    const payload: GithubPayload = {
      pr: pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null,
      checks: checksPayload,
      commits,
      github_available: true,
    };
```

Update the "not available" branch to return the same shape with empty `commits`.

Import `GithubPayload` from shared types.

- [ ] **Step 8.2 — Add `/github/merge`**

Append to the routes block:

```ts
app.post('/api/runs/:id/github/merge', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runId = Number(id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not found' });
  const project = deps.projects.get(run.project_id);
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  if (!project || !repo) return reply.code(400).send({ merged: false, reason: 'not-github' });
  if (!run.branch_name) return reply.code(400).send({ merged: false, reason: 'no-branch' });
  if (!(await deps.gh.available())) return reply.code(503).send({ merged: false, reason: 'gh-not-available' });

  const msg = `Merge branch '${run.branch_name}' (FBI run #${runId})`;
  const r = await deps.gh.mergeBranch(repo, run.branch_name, project.default_branch, msg);
  if (r.merged) {
    invalidate(runId);
    return { merged: true, sha: r.sha } satisfies MergeResponse;
  }
  if (r.reason !== 'conflict') {
    return reply.code(500).send({ merged: false, reason: 'gh-error' });
  }

  // Conflict. If the run's container is alive (running/waiting), inject a
  // merge prompt via stdin. Else report agent-busy.
  if (run.state !== 'running' && run.state !== 'waiting') {
    return reply.code(409).send({ merged: false, reason: 'agent-busy' });
  }
  const prompt =
    `Merge branch ${run.branch_name} into ${project.default_branch}, ` +
    `resolve conflicts, and push ${project.default_branch}. Steps:\n` +
    `1. git fetch origin\n` +
    `2. git checkout ${project.default_branch}\n` +
    `3. git pull --ff-only origin ${project.default_branch}\n` +
    `4. git merge --no-ff ${run.branch_name}\n` +
    `5. If conflicts: resolve, git add, git commit.\n` +
    `6. git push origin ${project.default_branch}\n`;
  try {
    deps.orchestrator.writeStdin(runId, Buffer.from(prompt + '\n'));
    return { merged: false, reason: 'conflict', agent: true } satisfies MergeResponse;
  } catch {
    return reply.code(409).send({ merged: false, reason: 'agent-busy' });
  }
});
```

Import `MergeResponse` from shared types.

- [ ] **Step 8.3 — Tests**

Extend `runs.test.ts`:

- Mock `gh.mergeBranch` to return `{ merged: true, sha: 'abc' }`; POST `/github/merge`; expect 200 with that body.
- Mock `gh.mergeBranch` to return `{ merged: false, reason: 'conflict' }`, set run.state='running', stub `orchestrator.writeStdin` as vi.fn(); expect 200 `{ merged: false, reason: 'conflict', agent: true }` and `writeStdin` called with the prompt text.
- Same but run.state='succeeded' → expect 409 `agent-busy`.

- [ ] **Step 8.4 — Run tests**

- [ ] **Step 8.5 — Commit**

```
git add src/server/api/runs.ts src/server/api/runs.test.ts
git commit -m "feat(api): enhance /github with commits; add /github/merge"
```

---

## Task 9 — Web API client updates

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 9.1 — Update imports**

Add to the import:

```ts
import type {
  DailyUsage, ListeningPort, McpServer, Project, Run, RunUsageBreakdownRow,
  SecretName, Settings, UsageState, FilesPayload, FileDiffPayload,
  GithubPayload, MergeResponse,
} from '@shared/types.js';
```

- [ ] **Step 9.2 — Replace `getRunDiff` with `getRunFiles`; add new methods; tighten `getRunGithub`**

Delete:

```ts
getRunDiff: (id: number) => request<{
  base: string; head: string;
  files: Array<...>;
  github_available: boolean;
}>(`/api/runs/${id}/diff`),
```

Add:

```ts
getRunFiles: (id: number) => request<FilesPayload>(`/api/runs/${id}/files`),

getRunFileDiff: (id: number, path: string, ref: string = 'worktree') =>
  request<FileDiffPayload>(`/api/runs/${id}/file-diff?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`),

mergeRunBranch: (id: number) =>
  request<MergeResponse>(`/api/runs/${id}/github/merge`, { method: 'POST', body: JSON.stringify({}) }),
```

Change `getRunGithub`'s return type:

```ts
getRunGithub: (id: number) => request<GithubPayload>(`/api/runs/${id}/github`),
```

- [ ] **Step 9.3 — Typecheck (will surface callsites that need updating)**

```
npm run typecheck
```

Expected errors: places that called `getRunDiff`, or destructured the old `getRunGithub` shape. **Leave these broken for now** — they'll all be fixed in Task 17 (GithubTab) and Task 18 (FilesTab). Continue.

- [ ] **Step 9.4 — Commit**

```
git add src/web/lib/api.ts
git commit -m "feat(web/api): getRunFiles, getRunFileDiff, mergeRunBranch; GithubPayload"
```

---

## Task 10 — `ExternalLink` inline-SVG primitive

**Files:**
- Create: `src/web/ui/primitives/icons/ExternalLink.tsx`
- Modify: `src/web/ui/primitives/index.ts`
- Modify: `src/web/pages/Design.tsx` (showcase entry)

- [ ] **Step 10.1 — Create icon**

```tsx
// src/web/ui/primitives/icons/ExternalLink.tsx
import { cn } from '../../cn.js';

export interface ExternalLinkProps {
  className?: string;
  size?: number;
}

export function ExternalLink({ className, size = 12 }: ExternalLinkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={cn('inline-block align-[-1px]', className)}
    >
      <path
        d="M4.5 2.5 H2.5 V9.5 H9.5 V7.5 M7 2.5 H9.5 V5 M9.5 2.5 L6 6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

- [ ] **Step 10.2 — Export from primitives index**

Add to `src/web/ui/primitives/index.ts`:

```ts
export { ExternalLink } from './icons/ExternalLink.js';
```

- [ ] **Step 10.3 — Showcase entry**

In `src/web/pages/Design.tsx`, find the primitives showcase section and add:

```tsx
<section>
  <h3>ExternalLink</h3>
  <a href="#" className="text-accent">Open docs <ExternalLink /></a>
</section>
```

Import `ExternalLink` at the top.

- [ ] **Step 10.4 — Commit**

```
git add src/web/ui/primitives/icons/ExternalLink.tsx src/web/ui/primitives/index.ts src/web/pages/Design.tsx
git commit -m "feat(ui): ExternalLink icon primitive"
```

---

## Task 11 — `DiffBlock` data primitive

**Files:**
- Create: `src/web/ui/data/DiffBlock.tsx`
- Create: `src/web/ui/data/DiffBlock.test.tsx`
- Modify: `src/web/pages/Design.tsx`

- [ ] **Step 11.1 — Test**

```tsx
// src/web/ui/data/DiffBlock.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffBlock } from './DiffBlock.js';

describe('DiffBlock', () => {
  it('renders hunks with add/del/ctx lines', () => {
    render(<DiffBlock hunks={[{
      header: '@@ -1,3 +1,3 @@',
      lines: [
        { kind: 'ctx', text: 'a' },
        { kind: 'del', text: 'b' },
        { kind: 'add', text: 'c' },
      ],
    }]} />);
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeInTheDocument();
    expect(screen.getByText(/^\+/).textContent).toContain('c');
    expect(screen.getByText(/^-/).textContent).toContain('b');
  });

  it('shows a truncated banner when requested', () => {
    render(<DiffBlock hunks={[]} truncated />);
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 11.2 — Implement**

```tsx
// src/web/ui/data/DiffBlock.tsx
import { cn } from '../cn.js';
import type { FileDiffHunk } from '@shared/types.js';

export interface DiffBlockProps {
  hunks: FileDiffHunk[];
  truncated?: boolean;
  className?: string;
}

export function DiffBlock({ hunks, truncated, className }: DiffBlockProps) {
  return (
    <div className={cn('font-mono text-[12px]', className)}>
      {hunks.map((h, i) => (
        <div key={i} className="border-t border-border">
          <div className="px-3 py-0.5 text-text-faint bg-surface-raised">{h.header}</div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              className={cn(
                'px-3 whitespace-pre',
                l.kind === 'add' ? 'bg-ok-subtle text-ok' :
                l.kind === 'del' ? 'bg-fail-subtle text-fail' :
                'text-text-dim',
              )}
            >
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}{l.text}
            </div>
          ))}
        </div>
      ))}
      {truncated && (
        <div className="px-3 py-1 text-text-faint text-[12px] border-t border-border">
          diff truncated — open on GitHub
        </div>
      )}
    </div>
  );
}
```

If `bg-ok-subtle`/`bg-fail-subtle` tokens don't exist, add them to `src/web/ui/tokens.css` first. Check existing tokens before introducing new ones; fall back to `bg-accent/5` style only if a real token doesn't fit.

- [ ] **Step 11.3 — Showcase entry**

In `Design.tsx`:

```tsx
<section>
  <h3>DiffBlock</h3>
  <DiffBlock hunks={[{ header: '@@ -1,3 +1,3 @@', lines: [
    { kind: 'ctx', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'c' },
  ] }]} />
</section>
```

- [ ] **Step 11.4 — Run test, commit**

```
npm test -- --run src/web/ui/data/DiffBlock.test.tsx
git add src/web/ui/data/DiffBlock.tsx src/web/ui/data/DiffBlock.test.tsx src/web/pages/Design.tsx src/web/ui/tokens.css
git commit -m "feat(ui): DiffBlock data primitive"
```

---

## Task 12 — `useBottomPaneHeight` hook

**Files:**
- Create: `src/web/features/runs/useBottomPaneHeight.ts`
- Create: `src/web/features/runs/useBottomPaneHeight.test.ts`

- [ ] **Step 12.1 — Test**

```ts
// src/web/features/runs/useBottomPaneHeight.test.ts
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useBottomPaneHeight, MIN_HEIGHT, clampHeight } from './useBottomPaneHeight.js';

describe('useBottomPaneHeight', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to ~35vh', () => {
    const { result } = renderHook(() => useBottomPaneHeight());
    expect(result.current.height).toBeGreaterThan(0);
  });

  it('persists set value', () => {
    const { result } = renderHook(() => useBottomPaneHeight());
    act(() => result.current.setHeight(300));
    expect(localStorage.getItem('fbi.bottomPaneHeight')).toBe('300');
  });

  it('clamps to min', () => {
    expect(clampHeight(50, 1000)).toBe(MIN_HEIGHT);
  });
});
```

- [ ] **Step 12.2 — Implement**

```ts
// src/web/features/runs/useBottomPaneHeight.ts
import { useCallback, useEffect, useState } from 'react';

export const MIN_HEIGHT = 120;
const KEY = 'fbi.bottomPaneHeight';

export function clampHeight(value: number, viewportHeight: number): number {
  const max = Math.max(MIN_HEIGHT + 40, viewportHeight - 200);
  return Math.max(MIN_HEIGHT, Math.min(value, max));
}

function readInitial(): number {
  if (typeof window === 'undefined') return 280;
  const raw = window.localStorage.getItem(KEY);
  if (raw == null) return Math.round(window.innerHeight * 0.35);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return Math.round(window.innerHeight * 0.35);
  return clampHeight(parsed, window.innerHeight);
}

export function useBottomPaneHeight() {
  const [height, setHeightState] = useState<number>(() => readInitial());

  const setHeight = useCallback((next: number) => {
    setHeightState((prev) => {
      const clamped = clampHeight(next, typeof window !== 'undefined' ? window.innerHeight : 1000);
      if (clamped !== prev) {
        try { window.localStorage.setItem(KEY, String(clamped)); } catch { /* quota; ignore */ }
      }
      return clamped;
    });
  }, []);

  useEffect(() => {
    const onResize = () => setHeightState((h) => clampHeight(h, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { height, setHeight };
}
```

- [ ] **Step 12.3 — Run, commit**

```
npm test -- --run src/web/features/runs/useBottomPaneHeight.test.ts
git add src/web/features/runs/useBottomPaneHeight.ts src/web/features/runs/useBottomPaneHeight.test.ts
git commit -m "feat(runs): useBottomPaneHeight hook"
```

---

## Task 13 — Drawer resize support

**Files:**
- Modify: `src/web/ui/primitives/Drawer.tsx`

- [ ] **Step 13.1 — Add `height`/`onHeightChange`/`resizable` props**

Rewrite `Drawer` as:

```tsx
import { useRef, type PointerEvent, type ReactNode } from 'react';
import { cn } from '../cn.js';

export interface DrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  header: ReactNode;
  children?: ReactNode;
  className?: string;
  /** When provided together with `onHeightChange`, renders a top drag handle. */
  height?: number;
  onHeightChange?: (next: number) => void;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
      className={cn('transition-transform duration-fast ease-out', open ? 'rotate-0' : 'rotate-180')}>
      <path d="M3 4.5 L6 7.5 L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Drawer({ open, onToggle, header, children, className, height, onHeightChange }: DrawerProps) {
  const startY = useRef(0);
  const startH = useRef(0);
  const resizable = open && typeof height === 'number' && typeof onHeightChange === 'function';

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizable) return;
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    startY.current = e.clientY;
    startH.current = height!;
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizable) return;
    if ((e.buttons & 1) === 0) return;
    const delta = startY.current - e.clientY;
    onHeightChange!(startH.current + delta);
  };

  return (
    <div className={cn('border-t border-border-strong bg-surface flex flex-col', className)}>
      {resizable && (
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          className="h-1.5 -mb-px cursor-ns-resize bg-border hover:bg-border-strong"
          title="Drag to resize"
        />
      )}
      <div className="flex items-center px-3 py-1.5">
        <div className="flex-1 min-w-0 font-mono text-[13px] text-text-dim">{header}</div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
          onClick={() => onToggle(!open)}
          className="ml-2 flex items-center justify-center w-7 h-7 rounded-md text-text-faint hover:text-text hover:bg-surface-raised transition-colors duration-fast ease-out"
        >
          <Chevron open={open} />
        </button>
      </div>
      {open && (
        <div style={resizable ? { height: Math.max(0, height! - 30) } : undefined} className="overflow-auto">
          {children}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 13.2 — Typecheck**

- [ ] **Step 13.3 — Commit**

```
git add src/web/ui/primitives/Drawer.tsx
git commit -m "feat(ui): Drawer supports vertical resize"
```

---

## Task 14 — `FilesTab` rework

**Files:**
- Replace contents: `src/web/features/runs/FilesTab.tsx`
- Create: `src/web/features/runs/FilesTab.test.tsx`

- [ ] **Step 14.1 — Replace component**

```tsx
// src/web/features/runs/FilesTab.tsx
import { useEffect, useState } from 'react';
import { api } from '@web/lib/api.js';
import { DiffBlock } from '@ui/data/DiffBlock.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { Pill } from '@ui/primitives/Pill.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';
import type { FilesPayload, FileDiffPayload, Project, RunState } from '@shared/types.js';

export interface FilesTabProps {
  runId: number;
  files: FilesPayload | null;
  project: Project | null;
  runState: RunState;
}

const STATUS_TONE = { M: 'warn', A: 'ok', D: 'fail', R: 'attn', U: 'wait' } as const;

export function FilesTab({ runId, files, project, runState }: FilesTabProps) {
  const [expanded, setExpanded] = useState<Record<string, FileDiffPayload | 'loading' | 'error'>>({});

  const toggle = async (key: string, path: string, ref: string) => {
    setExpanded((e) => {
      if (e[key] && e[key] !== 'loading') { const { [key]: _, ...rest } = e; return rest; }
      return { ...e, [key]: 'loading' };
    });
    try {
      const d = await api.getRunFileDiff(runId, path, ref);
      setExpanded((e) => ({ ...e, [key]: d }));
    } catch {
      setExpanded((e) => ({ ...e, [key]: 'error' }));
    }
  };

  if (!files) {
    if (runState === 'queued') return <p className="p-3 text-[13px] text-text-faint">Run queued — no files yet.</p>;
    return <LoadingState label="Loading files…" />;
  }

  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const branchHref = repo && files.branchBase
    ? `https://github.com/${repo}/tree/${files.head?.sha ?? ''}`
    : undefined;

  return (
    <div>
      {files.branchBase && (
        <div className="flex items-center gap-3 px-3 py-2 text-[12px] text-text-dim border-b border-border">
          {branchHref ? (
            <a href={branchHref} target="_blank" rel="noreferrer" className="text-accent">branch</a>
          ) : <span>branch</span>}
          <span className="font-mono text-text">{/* placeholder; actual branch name comes from parent */}</span>
          <span className="text-text-faint">·</span>
          <span><span className="text-ok">{files.branchBase.ahead} ahead</span> / <span className="text-text-faint">{files.branchBase.behind} behind</span></span>
          {!files.live && <span className="ml-auto text-text-faint">snapshot</span>}
        </div>
      )}

      {files.dirty.length > 0 && (
        <>
          <SectionLabel>Uncommitted ({files.dirty.length})</SectionLabel>
          {files.dirty.map((f) => {
            const key = `w:${f.path}`;
            const row = expanded[key];
            return (
              <div key={key}>
                <FileRow
                  path={f.path} status={f.status} additions={f.additions} deletions={f.deletions}
                  open={!!row && row !== 'loading'}
                  onClick={() => toggle(key, f.path, 'worktree')}
                />
                {row === 'loading' && <p className="p-2 text-[12px] text-text-faint">Loading diff…</p>}
                {row === 'error' && <p className="p-2 text-[12px] text-fail">Failed to load diff.</p>}
                {row && typeof row === 'object' && <DiffBlock hunks={row.hunks} truncated={row.truncated} />}
              </div>
            );
          })}
        </>
      )}

      {files.head && files.headFiles.length > 0 && (
        <>
          <SectionLabel>Last commit</SectionLabel>
          <div className="px-3 py-1 text-[12px]">
            <span className="text-text-faint font-mono">{files.head.sha.slice(0, 7)}</span>
            <span className="ml-2 text-text">{files.head.subject}</span>
          </div>
          {files.headFiles.map((f) => {
            const key = `h:${f.path}`;
            const row = expanded[key];
            return (
              <div key={key}>
                <FileRow
                  path={f.path} status={f.status} additions={f.additions} deletions={f.deletions}
                  open={!!row && row !== 'loading'}
                  onClick={() => toggle(key, f.path, files.head!.sha)}
                />
                {row && typeof row === 'object' && <DiffBlock hunks={row.hunks} truncated={row.truncated} />}
              </div>
            );
          })}
        </>
      )}

      {files.dirty.length === 0 && (!files.head || files.headFiles.length === 0) && (
        <p className="p-3 text-[13px] text-text-faint">No file changes yet.</p>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-text-faint bg-surface-raised border-t border-b border-border">{children}</div>;
}

function FileRow({ path, status, additions, deletions, open, onClick }: {
  path: string; status: 'M'|'A'|'D'|'R'|'U'; additions: number; deletions: number; open: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1 text-[13px] hover:bg-surface-raised border-b border-border text-left">
      <span className={`font-mono inline-block w-3 ${open ? 'rotate-90' : ''} transition-transform`}>▸</span>
      <Pill tone={STATUS_TONE[status]}>{status}</Pill>
      <span className="font-mono text-text flex-1 truncate">{path}</span>
      <span className="font-mono text-[12px] text-ok">+{additions}</span>
      <span className="font-mono text-[12px] text-fail">-{deletions}</span>
    </button>
  );
}
```

(The chevron glyph `▸` is a placeholder — **replace with the same inline SVG pattern as `Drawer`'s `Chevron`** if this fails review. For now leave as-is.)

Actually — per the spec's "no unicode arrows" rule, use an inline SVG. Update `FileRow` to use an inline SVG chevron identical in shape to `Drawer`'s internal `Chevron` (pointing right when `!open`, rotated when `open`). Inline the SVG directly; don't add another primitive.

- [ ] **Step 14.2 — Tests**

```tsx
// src/web/features/runs/FilesTab.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FilesTab } from './FilesTab.js';
import type { FilesPayload } from '@shared/types.js';

const base: FilesPayload = { dirty: [], head: null, headFiles: [], branchBase: null, live: true };

describe('FilesTab', () => {
  it('empty state when no changes', () => {
    render(<FilesTab runId={1} files={base} project={null} runState="running" />);
    expect(screen.getByText(/no file changes yet/i)).toBeInTheDocument();
  });

  it('shows dirty rows', () => {
    render(<FilesTab runId={1} files={{ ...base, dirty: [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }] }} project={null} runState="running" />);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('+3')).toBeInTheDocument();
  });

  it('shows last commit and headFiles', () => {
    render(<FilesTab runId={1}
      files={{ ...base, head: { sha: 'a3f2b19abc', subject: 'feat: x' }, headFiles: [{ path: 'src/b.ts', status: 'A', additions: 10, deletions: 0 }] }}
      project={null} runState="succeeded" />);
    expect(screen.getByText('feat: x')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('loading state when files null and run running', () => {
    render(<FilesTab runId={1} files={null} project={null} runState="running" />);
    expect(screen.getByText(/loading files/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 14.3 — Run tests, commit**

```
npm test -- --run src/web/features/runs/FilesTab.test.tsx
git add src/web/features/runs/FilesTab.tsx src/web/features/runs/FilesTab.test.tsx
git commit -m "feat(runs): FilesTab live view with inline diffs"
```

---

## Task 15 — `GithubTab` rework

**Files:**
- Replace contents: `src/web/features/runs/GithubTab.tsx`
- Create: `src/web/features/runs/GithubTab.test.tsx`

- [ ] **Step 15.1 — Replace component**

```tsx
// src/web/features/runs/GithubTab.tsx
import { useState } from 'react';
import { Pill } from '@ui/primitives/Pill.js';
import { ExternalLink } from '@ui/primitives/icons/ExternalLink.js';
import { api } from '@web/lib/api.js';
import type { GithubPayload, Run } from '@shared/types.js';

export interface GithubTabProps {
  run: Run;
  github: GithubPayload | null;
  onCreatePr: () => void;
  onMerged: () => void;           // called after successful server-side merge to refresh
  creatingPr: boolean;
}

export function GithubTab({ run, github, onCreatePr, onMerged, creatingPr }: GithubTabProps) {
  const [merging, setMerging] = useState(false);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);

  if (!github) return <p className="p-3 text-[13px] text-text-faint">Loading…</p>;
  if (!github.github_available) {
    return (
      <div>
        <p className="p-3 text-[13px] text-text-faint">GitHub CLI not available or non-GitHub remote.</p>
        {github.commits.length > 0 && <CommitsSection commits={github.commits} branch={run.branch_name} />}
      </div>
    );
  }

  async function onMergeClick() {
    setMerging(true); setMergeMsg(null);
    try {
      const r = await api.mergeRunBranch(run.id);
      if (r.merged) {
        setMergeMsg(`Merged as ${r.sha.slice(0, 7)}`);
        onMerged();
      } else if (r.reason === 'conflict' && 'agent' in r && r.agent) {
        setMergeMsg('Conflicts — delegated to agent');
      } else {
        setMergeMsg(`Merge failed: ${r.reason}`);
      }
    } catch (e) { setMergeMsg(String(e)); }
    finally { setMerging(false); }
  }

  const canMerge = !!github.pr && (run.state === 'running' || run.state === 'waiting' || run.state === 'succeeded');
  const canCreatePr = !github.pr && !!run.branch_name;

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        {canCreatePr && (
          <button type="button" onClick={onCreatePr} disabled={creatingPr}
            className="px-3 py-1 text-[13px] bg-accent text-bg rounded-md disabled:opacity-50">
            {creatingPr ? 'Creating PR…' : 'Create PR'}
          </button>
        )}
        {canMerge && (
          <button type="button" onClick={onMergeClick} disabled={merging}
            className="px-3 py-1 text-[13px] bg-accent text-bg rounded-md disabled:opacity-50">
            {merging ? 'Merging…' : 'Merge to main'}
          </button>
        )}
        {github.pr && (
          <a href={github.pr.url} target="_blank" rel="noreferrer"
            className="ml-auto text-[13px] text-accent flex items-center gap-1">
            View PR <ExternalLink />
          </a>
        )}
      </div>

      {mergeMsg && <p className="px-3 py-1 text-[12px] text-text-dim">{mergeMsg}</p>}

      <Section label="Pull request">
        {github.pr ? (
          <div className="px-3 py-2 text-[13px]">
            <span className="font-mono text-text-faint">#{github.pr.number}</span>
            <span className="ml-2 text-text">{github.pr.title}</span>
            <Pill tone={github.pr.state === 'MERGED' ? 'ok' : github.pr.state === 'OPEN' ? 'run' : 'wait'} className="ml-2">
              {github.pr.state.toLowerCase()}
            </Pill>
          </div>
        ) : <p className="px-3 py-2 text-[13px] text-text-faint">No PR yet.</p>}
      </Section>

      {github.checks && (
        <Section label={`CI (${github.checks.passed}/${github.checks.total} passed)`}>
          {github.checks.items.map((c) => (
            <div key={c.name} className="flex items-center gap-2 px-3 py-1 text-[13px] border-b border-border">
              <Pill tone={c.conclusion === 'success' ? 'ok' : c.conclusion === 'failure' ? 'fail' : 'wait'}>
                {c.conclusion ?? c.status}
              </Pill>
              <span className="font-mono">{c.name}</span>
            </div>
          ))}
        </Section>
      )}

      {github.commits.length > 0 && <CommitsSection commits={github.commits} branch={run.branch_name} />}
    </div>
  );
}

function CommitsSection({ commits, branch }: { commits: GithubPayload['commits']; branch: string }) {
  return (
    <Section label={`Commits on ${branch} (${commits.length})`}>
      {commits.map((c) => (
        <div key={c.sha} className="flex items-center gap-2 px-3 py-1 text-[13px] border-b border-border">
          <span className={`w-1.5 h-1.5 rounded-full ${c.pushed ? 'bg-ok' : 'bg-text-faint'}`} title={c.pushed ? 'pushed' : 'not yet pushed'} />
          <span className="font-mono text-text-faint">{c.sha.slice(0, 7)}</span>
          <span className="text-text flex-1 truncate">{c.subject}</span>
        </div>
      ))}
    </Section>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-text-faint bg-surface-raised border-t border-b border-border">
        {label}
      </div>
      {children}
    </section>
  );
}
```

- [ ] **Step 15.2 — Tests**

```tsx
// src/web/features/runs/GithubTab.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GithubTab } from './GithubTab.js';
import type { Run, GithubPayload } from '@shared/types.js';

const baseRun = { id: 1, state: 'running', branch_name: 'feat/x' } as unknown as Run;
const basePayload: GithubPayload = { pr: null, checks: null, commits: [], github_available: true };

describe('GithubTab', () => {
  it('shows Create PR when no PR exists', () => {
    render(<GithubTab run={baseRun} github={basePayload} onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText('Create PR')).toBeInTheDocument();
  });

  it('shows Merge to main when PR exists and run is running', () => {
    render(<GithubTab run={baseRun}
      github={{ ...basePayload, pr: { number: 3, url: '#', state: 'OPEN', title: 't' } }}
      onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText('Merge to main')).toBeInTheDocument();
  });

  it('lists commits with pushed dot', () => {
    render(<GithubTab run={baseRun}
      github={{ ...basePayload, commits: [{ sha: 'abcdef0', subject: 'feat: x', committed_at: 1, pushed: true }] }}
      onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText('feat: x')).toBeInTheDocument();
    expect(screen.getByText('abcdef0')).toBeInTheDocument();
  });

  it('non-github shows only commits fallback', () => {
    render(<GithubTab run={baseRun}
      github={{ ...basePayload, github_available: false, commits: [] }}
      onCreatePr={vi.fn()} onMerged={vi.fn()} creatingPr={false} />);
    expect(screen.getByText(/non-github remote/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 15.3 — Commit**

```
git add src/web/features/runs/GithubTab.tsx src/web/features/runs/GithubTab.test.tsx
git commit -m "feat(runs): GithubTab actions + commits list"
```

---

## Task 16 — `MetaTab`

**Files:**
- Create: `src/web/features/runs/MetaTab.tsx`
- Create: `src/web/features/runs/MetaTab.test.tsx`

- [ ] **Step 16.1 — Implement**

```tsx
// src/web/features/runs/MetaTab.tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Pill, type PillTone } from '@ui/primitives/index.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import { TimestampRelative } from '@ui/data/TimestampRelative.js';
import type { Run } from '@shared/types.js';
import { RunUsage } from './RunUsage.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', running: 'run', waiting: 'attn', awaiting_resume: 'warn',
  succeeded: 'ok', failed: 'fail', cancelled: 'warn',
};

function formatReset(ms: number | null): string | null {
  if (ms == null) return null;
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'any moment';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export interface MetaTabProps {
  run: Run;
  siblings: readonly Run[];
}

export function MetaTab({ run, siblings }: MetaTabProps) {
  return (
    <div className="p-2">
      <Group label="Info">
        <Row label="project"><Link to={`/projects/${run.project_id}`} className="text-accent"><CodeBlock>#{run.project_id}</CodeBlock></Link></Row>
        <Row label="started"><TimestampRelative iso={new Date(run.created_at).toISOString()} /></Row>
        {run.branch_name && <Row label="branch"><CodeBlock>{run.branch_name}</CodeBlock></Row>}
      </Group>

      {run.state === 'awaiting_resume' && (
        <Group label="Auto-resume">
          {run.next_resume_at != null && (
            <Row label="resumes in"><span className="font-mono text-warn">{formatReset(run.next_resume_at)}</span></Row>
          )}
          <Row label="attempts"><span className="font-mono">{run.resume_attempts}</span></Row>
        </Group>
      )}

      <RunUsage run={run} />

      {siblings.length > 0 && (
        <Group label="Related">
          {siblings.map((s) => (
            <Link key={s.id} to={`/runs/${s.id}`} className="flex items-center gap-1 text-[13px] text-text-dim hover:text-text py-0.5">
              <span className="font-mono">#{s.id}</span>
              <Pill tone={TONE[s.state]}>{s.state}</Pill>
              <span className="truncate text-text-faint">{s.branch_name}</span>
            </Link>
          ))}
        </Group>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] uppercase tracking-wider text-text-faint">Prompt</summary>
        <div className="mt-2"><CodeBlock>{run.prompt}</CodeBlock></div>
      </details>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint pb-1 border-b border-border mb-1">{label}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-center gap-1 text-[13px] text-text-dim py-0.5"><span className="text-text-faint">{label}</span><span className="ml-auto">{children}</span></div>;
}
```

- [ ] **Step 16.2 — Test**

```tsx
// src/web/features/runs/MetaTab.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { MetaTab } from './MetaTab.js';
import type { Run } from '@shared/types.js';

const run = { id: 1, project_id: 7, prompt: 'do a thing', branch_name: 'feat/x', state: 'running', created_at: Date.now(), next_resume_at: null, resume_attempts: 0, title: null, title_locked: 0, tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0, tokens_total: 0, usage_parse_errors: 0, head_commit: null, started_at: null, finished_at: null, container_id: null, exit_code: null, error: null, log_path: '', claude_session_id: null, last_limit_reset_at: null, parent_run_id: null } as unknown as Run;

describe('MetaTab', () => {
  it('renders project and branch', () => {
    render(<MemoryRouter><MetaTab run={run} siblings={[]} /></MemoryRouter>);
    expect(screen.getByText(/#7/)).toBeInTheDocument();
    expect(screen.getByText('feat/x')).toBeInTheDocument();
  });

  it('has a collapsed Prompt section', () => {
    render(<MemoryRouter><MetaTab run={run} siblings={[]} /></MemoryRouter>);
    const summary = screen.getByText('Prompt');
    expect(summary).toBeInTheDocument();
    // Prompt is inside <details>, collapsed — text may still be in DOM; check open attribute.
    const details = summary.closest('details');
    expect(details?.open).toBe(false);
  });
});
```

- [ ] **Step 16.3 — Commit**

```
git add src/web/features/runs/MetaTab.tsx src/web/features/runs/MetaTab.test.tsx
git commit -m "feat(runs): MetaTab consolidating side-panel content"
```

---

## Task 17 — `RunDrawer` new tab set and resize wiring

**Files:**
- Modify: `src/web/features/runs/RunDrawer.tsx`

- [ ] **Step 17.1 — Replace contents**

```tsx
// src/web/features/runs/RunDrawer.tsx
import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';

export type RunTab = 'files' | 'github' | 'tunnel' | 'meta';

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  filesCount: number;
  portsCount: number | null;
  height: number;
  onHeightChange: (h: number) => void;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({ open, onToggle, filesCount, portsCount, height, onHeightChange, children }: RunDrawerProps) {
  const [tab, setTab] = useState<RunTab>('files');
  const pickTab = (next: RunTab) => { setTab(next); if (!open) onToggle(true); };
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
            { value: 'files', label: 'files', count: filesCount },
            { value: 'github', label: 'github' },
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

- [ ] **Step 17.2 — Commit**

```
git add src/web/features/runs/RunDrawer.tsx
git commit -m "feat(runs): RunDrawer new tab set + resize props"
```

---

## Task 18 — `RunDetail` integration

**Files:**
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 18.1 — Replace imports and state**

Update imports, removing `RunSidePanel` and `PromptTab`, adding `MetaTab` and `useBottomPaneHeight` and the new types:

```tsx
import { FilesTab } from '@web/features/runs/FilesTab.js';
import { GithubTab } from '@web/features/runs/GithubTab.js';
import { TunnelTab } from '@web/features/runs/TunnelTab.js';
import { MetaTab } from '@web/features/runs/MetaTab.js';
import { RunDrawer } from '@web/features/runs/RunDrawer.js';
import { useBottomPaneHeight } from '@web/features/runs/useBottomPaneHeight.js';
import type { FilesPayload, GithubPayload } from '@shared/types.js';
```

Replace the `diff` state with `files: FilesPayload | null`. Change the `gh` state type to `GithubPayload | null`. Change the existing `diff` polling effect to poll `api.getRunFiles(run.id)` at the existing cadence; additionally subscribe to `files` WS events via the existing socket's message handler (or the existing event subscription point — check how `usage`/`title` events are consumed in the `RunTerminal` or a sibling; if only `RunTerminal` subscribes today, you'll need to expose a secondary subscription: wire it through a custom hook `useRunEvents(runId)` that subscribes to the same socket and returns the latest `files` payload).

Implementation detail: subscribe to files events via a small hook added at `src/web/features/runs/useRunFiles.ts` that opens its own `EventSource`-style subscription using the existing websocket helper the project uses. If a shared event-subscription helper already exists (check `RunTerminal.tsx`), reuse it; do not open a second socket.

- [ ] **Step 18.2 — Remove `<aside>` wrapper**

Replace the main layout block so the terminal + drawer use the full width:

```tsx
return (
  <div className="h-full flex flex-col min-h-0">
    <RunHeader run={run} onCancel={cancel} onDelete={remove} onContinue={kontinue} onRenamed={setRun} />
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0"><RunTerminal runId={run.id} interactive={interactive} /></div>
      <RunDrawer
        open={drawerOpen} onToggle={setDrawerOpen}
        filesCount={(files?.dirty.length ?? 0) + (files?.headFiles.length ?? 0)}
        portsCount={run.state === 'running' || run.state === 'waiting' ? ports.length : null}
        height={height}
        onHeightChange={setHeight}
      >
        {(t) => t === 'files'  ? <FilesTab runId={run.id} files={files} project={project} runState={run.state} />
             : t === 'github'  ? <GithubTab run={run} github={gh} onCreatePr={createPr} onMerged={async () => { const g = await api.getRunGithub(run.id); setGh(g); }} creatingPr={creatingPr} />
             : t === 'tunnel'  ? <TunnelTab runId={run.id} runState={run.state} origin={window.location.origin} ports={ports} />
             : <MetaTab run={run} siblings={siblings} />}
      </RunDrawer>
    </div>
  </div>
);
```

Remove the `<RunSidePanel ...>` usage and any `onCreatePr` props being passed to anything other than `GithubTab`.

- [ ] **Step 18.3 — Plumb `useBottomPaneHeight`**

Near the top of the component:

```tsx
const { height, setHeight } = useBottomPaneHeight();
```

- [ ] **Step 18.4 — Typecheck + smoke test**

```
npm run typecheck
npm test -- --run src/web
```

- [ ] **Step 18.5 — Commit**

```
git add src/web/pages/RunDetail.tsx src/web/features/runs/useRunFiles.ts
git commit -m "feat(web): integrate new tabs, drop side panel, wire resize"
```

---

## Task 19 — Delete `PromptTab` and `RunSidePanel`

- [ ] **Step 19.1 — Delete files and references**

```
rm src/web/features/runs/PromptTab.tsx src/web/features/runs/RunSidePanel.tsx
grep -rn "PromptTab\|RunSidePanel" src/web
```

The `grep` should return nothing. If it does, update the callers.

- [ ] **Step 19.2 — Typecheck**

```
npm run typecheck && npm test -- --run
```

- [ ] **Step 19.3 — Commit**

```
git add -A
git commit -m "chore(web): remove PromptTab and RunSidePanel"
```

---

## Task 20 — End-to-end verification via `scripts/dev.sh` + Playwright

- [ ] **Step 20.1 — Start dev server**

```
scripts/dev.sh
```

- [ ] **Step 20.2 — Manual checks via Playwright MCP**

Open a run in the browser and step through:

1. Run starts; bottom pane's **files** tab populates within a few seconds (dirty section empty, last commit populates after first agent commit).
2. Click a file row — inline diff expands; diff lines visible.
3. Switch to **github** tab — commits section lists agent commits with green `pushed` dots.
4. Before the run finishes: click **Create PR**. Refresh — commits and CI appear.
5. **Merge to main** button enabled while PR exists. Click it (fast path). Expect toast-like message "Merged as abcdef0".
6. Simulate conflict (manually create a conflicting commit on `main` in the test repo). Click Merge — expect "Conflicts — delegated to agent"; terminal shows Claude starting merge work.
7. Switch to **meta** tab — Info, Usage, Related, collapsible Prompt all present.
8. Drag resize handle between terminal and tab bar — pane grows/shrinks; reload page; height persists.
9. Side panel is gone; layout is full-width.

- [ ] **Step 20.3 — Final sweep**

```
npm run typecheck
npm test -- --run
npm run build
```

Expect all green.

- [ ] **Step 20.4 — Commit any doc/test fallout**

```
git status
git add -A
git commit -m "chore: verification pass"
```

---

## Self-review checklist

- [ ] Spec §1 (post-commit hook): Task 5
- [ ] Spec §2 (Files tab + /files + /file-diff + GitStateWatcher): Tasks 2, 3, 6, 7, 14
- [ ] Spec §3 (GitHub tab + commits + merge): Tasks 4, 8, 15
- [ ] Spec §4 (Meta tab replacing side panel): Tasks 16, 18, 19
- [ ] Spec §5 (resize): Tasks 12, 13, 17, 18
- [ ] No unicode arrows in shipped code: ExternalLink primitive (Task 10); FilesTab chevron must use inline SVG per Task 14 note
- [ ] `parent_run_id` column + migration: Task 1
- [ ] `DiffBlock` primitive: Task 11
- [ ] All tab order / count badges match spec: Task 17
