# Continue-run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-initiated "Continue" action that revives a `failed` or `cancelled` run by re-entering its saved Claude session (`claude --resume`), and fix the pre-existing auto-resume divergence where the new container always clones to default branch.

**Architecture:** Build on the existing auto-resume plumbing. Orchestrator gains `continueRun(runId)`; the DB gains `markContinuing`; a new pure module `continueEligibility` encapsulates the guard. Supervisor gains an optional `FBI_CHECKOUT_BRANCH` env var — passed by both the auto-resume path and the new continue path — so the in-container workspace matches the saved session's branch. A new `POST /api/runs/:id/continue` endpoint wires the UI button to the orchestrator.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Dockerode, React, Vitest.

---

## File map

**Create:**
- `src/server/orchestrator/continueEligibility.ts` — pure `check(run, runsDir)` helper.
- `src/server/orchestrator/continueEligibility.test.ts` — unit tests for the helper.
- `src/server/orchestrator/continueRun.flow.test.ts` — stubbed-docker flow test mirroring `autoResume.flow.test.ts`.

**Modify:**
- `src/server/db/runs.ts` — add `markContinuing(id, containerId)`.
- `src/server/db/runs.test.ts` — add coverage for the new method.
- `src/server/orchestrator/supervisor.sh` — honor `FBI_CHECKOUT_BRANCH`.
- `src/server/orchestrator/supervisor.test.ts` — two new cases for branch checkout.
- `src/server/orchestrator/index.ts` — extend `createContainerForRun` signature with `branchName`; add `continueRun()`; pass `branchName` from both `resume()` and `continueRun()`.
- `src/server/api/runs.ts` — add `POST /api/runs/:id/continue` route; wire `continueRun` into `Deps`.
- `src/server/api/runs.test.ts` — add coverage for the new route.
- `src/server/index.ts` — pass `orchestrator.continueRun` into the runs routes.
- `src/web/lib/api.ts` — add `continueRun(id)` client method.
- `src/web/features/runs/RunHeader.tsx` — add `onContinue` prop + button.
- `src/web/pages/RunDetail.tsx` — wire the handler to the api client.

---

## Task 1: DB — `markContinuing`

**Files:**
- Modify: `src/server/db/runs.ts`
- Test: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write the failing test**

Append at the end of the existing `describe('RunsRepo', …)` block in `src/server/db/runs.test.ts`:

```typescript
  it('markContinuing transitions failed → running, resets resume_attempts, clears finished state', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    runs.markAwaitingResume(run.id, { next_resume_at: 1, last_limit_reset_at: 1 });
    runs.markResuming(run.id, 'c2');
    runs.markFinished(run.id, { state: 'failed', error: 'boom', exit_code: 1 });

    const before = runs.get(run.id)!;
    expect(before.state).toBe('failed');
    expect(before.resume_attempts).toBe(1);
    expect(before.error).toBe('boom');
    expect(before.finished_at).not.toBeNull();

    runs.markContinuing(run.id, 'c3');

    const after = runs.get(run.id)!;
    expect(after.state).toBe('running');
    expect(after.container_id).toBe('c3');
    expect(after.resume_attempts).toBe(0);
    expect(after.error).toBeNull();
    expect(after.exit_code).toBeNull();
    expect(after.finished_at).toBeNull();
  });

  it('markContinuing also accepts cancelled as the source state', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    runs.markFinished(run.id, { state: 'cancelled' });
    runs.markContinuing(run.id, 'c2');
    expect(runs.get(run.id)!.state).toBe('running');
  });

  it('markContinuing refuses to transition from non-terminal states', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'c1');
    // Running → markContinuing must be a no-op.
    runs.markContinuing(run.id, 'c2');
    const after = runs.get(run.id)!;
    expect(after.container_id).toBe('c1');
    expect(after.state).toBe('running');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/server/db/runs.test.ts
```

Expected: 3 new tests fail with `runs.markContinuing is not a function`.

- [ ] **Step 3: Implement `markContinuing`**

Add the method to `RunsRepo` in `src/server/db/runs.ts`, just below `markResuming`:

```typescript
  markContinuing(id: number, containerId: string): void {
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
                started_at=COALESCE(started_at, ?)
          WHERE id=? AND state IN ('failed','cancelled')`,
      )
      .run(containerId, Date.now(), id);
  }
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/server/db/runs.test.ts
```

Expected: all RunsRepo tests pass.

- [ ] **Step 5: Commit**

```
git add src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(runs-repo): markContinuing for continued failed/cancelled runs"
```

---

## Task 2: Orchestrator — eligibility helper

**Files:**
- Create: `src/server/orchestrator/continueEligibility.ts`
- Test: `src/server/orchestrator/continueEligibility.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/orchestrator/continueEligibility.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkContinueEligibility } from './continueEligibility.js';
import type { Run } from '../../shared/types.js';

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 42,
    project_id: 1,
    prompt: 'hi',
    branch_name: 'feat/x',
    state: 'failed',
    container_id: null,
    log_path: '/tmp/42.log',
    exit_code: 1,
    error: 'boom',
    head_commit: null,
    started_at: 1,
    finished_at: 2,
    created_at: 0,
    claude_session_id: 'sess-abc',
    resume_attempts: 0,
    next_resume_at: null,
    last_limit_reset_at: null,
    ...overrides,
  } as Run;
}

describe('checkContinueEligibility', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-elig-'));
  });
  afterEach(() => {
    try { fs.rmSync(runsDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const writeSession = (runId: number) => {
    const dir = path.join(runsDir, String(runId), 'claude-projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-abc.jsonl'), '{"x":1}\n');
  };

  it('accepts a failed run with session id and session files on disk', () => {
    writeSession(42);
    expect(checkContinueEligibility(baseRun(), runsDir)).toEqual({ ok: true });
  });

  it('accepts a cancelled run', () => {
    writeSession(42);
    expect(
      checkContinueEligibility(baseRun({ state: 'cancelled' }), runsDir),
    ).toEqual({ ok: true });
  });

  it('rejects a running run with wrong_state', () => {
    writeSession(42);
    const r = checkContinueEligibility(baseRun({ state: 'running' }), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('wrong_state');
  });

  it('rejects a succeeded run with wrong_state', () => {
    writeSession(42);
    const r = checkContinueEligibility(baseRun({ state: 'succeeded' }), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('wrong_state');
  });

  it('rejects when claude_session_id is null', () => {
    const r = checkContinueEligibility(
      baseRun({ claude_session_id: null }), runsDir,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_session');
  });

  it('rejects when session dir does not exist', () => {
    const r = checkContinueEligibility(baseRun(), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('session_files_missing');
  });

  it('rejects when session dir exists but contains no jsonl files', () => {
    const dir = path.join(runsDir, '42', 'claude-projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'other.txt'), 'nope');
    const r = checkContinueEligibility(baseRun(), runsDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('session_files_missing');
  });
});
```

- [ ] **Step 2: Verify test fails**

```
npx vitest run src/server/orchestrator/continueEligibility.test.ts
```

Expected: module-not-found error.

- [ ] **Step 3: Implement the helper**

Create `src/server/orchestrator/continueEligibility.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type { Run } from '../../shared/types.js';
import { runMountDir } from './sessionId.js';

export type ContinueEligibility =
  | { ok: true }
  | { ok: false; code: 'wrong_state' | 'no_session' | 'session_files_missing'; message: string };

/**
 * Gate for user-initiated "Continue" on a terminated run. Called by the
 * orchestrator before attempting to rehydrate a claude --resume container.
 * Pure: no side effects, no DB access, just fs.existsSync / readdirSync on
 * the per-run session mount directory.
 */
export function checkContinueEligibility(run: Run, runsDir: string): ContinueEligibility {
  if (run.state !== 'failed' && run.state !== 'cancelled') {
    return {
      ok: false,
      code: 'wrong_state',
      message: `run is ${run.state}; only failed or cancelled runs can be continued`,
    };
  }
  if (!run.claude_session_id) {
    return {
      ok: false,
      code: 'no_session',
      message: 'no claude session captured for this run',
    };
  }
  const dir = runMountDir(runsDir, run.id);
  let hasJsonl = false;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const walk = (root: string, ents: fs.Dirent[]): void => {
      for (const e of ents) {
        if (hasJsonl) return;
        const full = path.join(root, e.name);
        if (e.isDirectory()) {
          try { walk(full, fs.readdirSync(full, { withFileTypes: true })); } catch { /* noop */ }
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          hasJsonl = true;
        }
      }
    };
    walk(dir, entries);
  } catch {
    // dir missing entirely
  }
  if (!hasJsonl) {
    return {
      ok: false,
      code: 'session_files_missing',
      message: 'claude session files are no longer on disk',
    };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Verify it passes**

```
npx vitest run src/server/orchestrator/continueEligibility.test.ts
```

Expected: 7 passes.

- [ ] **Step 5: Commit**

```
git add src/server/orchestrator/continueEligibility.ts src/server/orchestrator/continueEligibility.test.ts
git commit -m "feat(orchestrator): pure eligibility check for continue-run"
```

---

## Task 3: Supervisor — `FBI_CHECKOUT_BRANCH` support

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`
- Test: `src/server/orchestrator/supervisor.test.ts`

- [ ] **Step 1: Extend the git stub to record checkouts**

At the top of `makeSandbox()` in `src/server/orchestrator/supervisor.test.ts`, replace the existing `git` stub with this version so the test can verify which branch was checked out:

```typescript
  // Stub git — tolerates the commands supervisor runs and produces the
  // outputs it reads back. Records `checkout` calls to a log file.
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh
case "$1" in
  clone) exit 0 ;;
  checkout)
    shift
    # Emit the final branch argument (last non-flag token) to the log.
    branch=""
    for a in "$@"; do
      case "$a" in -*) ;; *) branch="$a" ;; esac
    done
    echo "$branch" >> "${tmpOut}/checkouts.log"
    # Treat a branch named 'does-not-exist' as a missing ref.
    if [ "$branch" = "does-not-exist" ]; then exit 1; fi
    exit 0
    ;;
  config) exit 0 ;;
  add) exit 0 ;;
  commit) exit 0 ;;
  rev-parse)
    case "$2" in
      --abbrev-ref) echo "main" ;;
      HEAD) echo "deadbeef0000000000000000000000000000dead" ;;
      *) echo "deadbeef" ;;
    esac
    exit 0
    ;;
  push) exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
```

- [ ] **Step 2: Write the failing tests**

Append two tests inside the existing `describe('supervisor.sh', …)` block in `src/server/orchestrator/supervisor.test.ts`:

```typescript
  it('checks out FBI_CHECKOUT_BRANCH when set', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_CHECKOUT_BRANCH: 'feature/x' });
    expect(res.status).toBe(0);
    const checkouts = fs.readFileSync(path.join(sb.tmpOut, 'checkouts.log'), 'utf8').trim().split('\n');
    expect(checkouts[0]).toBe('feature/x');
  });

  it('falls through to DEFAULT_BRANCH when the requested branch is missing on remote', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, { FBI_CHECKOUT_BRANCH: 'does-not-exist' });
    expect(res.status).toBe(0);
    const checkouts = fs.readFileSync(path.join(sb.tmpOut, 'checkouts.log'), 'utf8').trim().split('\n');
    expect(checkouts[0]).toBe('does-not-exist');
    expect(checkouts[1]).toBe('main');
  });

  it('checks out DEFAULT_BRANCH when FBI_CHECKOUT_BRANCH is unset', () => {
    fs.writeFileSync(path.join(sb.fbi, 'prompt.txt'), 'hi');
    const res = run(sb, {});
    expect(res.status).toBe(0);
    const checkouts = fs.readFileSync(path.join(sb.tmpOut, 'checkouts.log'), 'utf8').trim().split('\n');
    expect(checkouts[0]).toBe('main');
  });
```

- [ ] **Step 3: Verify they fail**

```
npx vitest run src/server/orchestrator/supervisor.test.ts
```

Expected: the first two new tests fail (checkouts don't match).

- [ ] **Step 4: Update supervisor.sh**

Replace the `git checkout "$DEFAULT_BRANCH"` line in `src/server/orchestrator/supervisor.sh`:

```bash
git clone --recurse-submodules "$REPO_URL" . || { echo "clone failed"; exit 10; }
if [ -n "${FBI_CHECKOUT_BRANCH:-}" ]; then
    git checkout "$FBI_CHECKOUT_BRANCH" \
      || { echo "[fbi] warn: branch $FBI_CHECKOUT_BRANCH not found on remote; using $DEFAULT_BRANCH"; \
           git checkout "$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }; }
else
    git checkout "$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }
fi
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
```

- [ ] **Step 5: Verify tests pass**

```
npx vitest run src/server/orchestrator/supervisor.test.ts
```

Expected: all supervisor tests pass (6 total).

- [ ] **Step 6: Commit**

```
git add src/server/orchestrator/supervisor.sh src/server/orchestrator/supervisor.test.ts
git commit -m "feat(supervisor): honor FBI_CHECKOUT_BRANCH with fallback to default"
```

---

## Task 4: Orchestrator — pass `branchName` through `createContainerForRun`

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 1: Extend the signature**

In `src/server/orchestrator/index.ts`, find `createContainerForRun` and change its options type and env wiring. Replace the current options parameter and the env array bit that has `FBI_RESUME_SESSION_ID` with:

```typescript
  private async createContainerForRun(
    runId: number,
    opts: { resumeSessionId: string | null; branchName: string | null },
    onBytes: (chunk: Uint8Array) => void,
  ): Promise<{ container: Docker.Container; imageTag: string; projectSecrets: Record<string, string>; authCleanup: () => void }> {
```

And in the `Env` array (where `...(opts.resumeSessionId ? ...` currently lives), replace that single line with:

```typescript
        ...(opts.resumeSessionId ? [`FBI_RESUME_SESSION_ID=${opts.resumeSessionId}`] : []),
        ...(opts.branchName ? [`FBI_CHECKOUT_BRANCH=${opts.branchName}`] : []),
```

- [ ] **Step 2: Update callers**

In the same file:

- In `launch()`, change the call:
  ```typescript
      const { container, projectSecrets } = await this.createContainerForRun(
        runId, { resumeSessionId: null, branchName: null }, onBytes,
      );
  ```
- In `resume()`, change the call:
  ```typescript
      const { container } = await this.createContainerForRun(
        runId, {
          resumeSessionId: sessionId,
          branchName: run.branch_name && run.branch_name.length > 0 ? run.branch_name : null,
        }, onBytes,
      );
  ```

- [ ] **Step 3: Verify nothing broke**

```
npm run typecheck && npx vitest run src/server/orchestrator/
```

Expected: typecheck clean, all orchestrator tests still pass (auto-resume flow test continues to exercise the resume call).

- [ ] **Step 4: Commit**

```
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): plumb branchName through createContainerForRun"
```

---

## Task 5: Orchestrator — `continueRun()` flow

**Files:**
- Modify: `src/server/orchestrator/index.ts`
- Create: `src/server/orchestrator/continueRun.flow.test.ts`

- [ ] **Step 1: Write the failing flow test**

Create `src/server/orchestrator/continueRun.flow.test.ts` — uses the same stubbed-docker helpers as `autoResume.flow.test.ts`. This file re-declares the helpers (kept local rather than shared to avoid a shared test-util module):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Docker from 'dockerode';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { SecretsRepo } from '../db/secrets.js';
import { SettingsRepo } from '../db/settings.js';
import { McpServersRepo } from '../db/mcpServers.js';
import { RateLimitStateRepo } from '../db/rateLimitState.js';
import { UsageRepo } from '../db/usage.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { Orchestrator } from './index.js';
import { runMountDir } from './sessionId.js';
import type { Config } from '../config.js';

vi.mock('./image.js', () => ({
  ImageBuilder: class { async resolve() { return 'stub:latest'; } },
  ALWAYS: [],
  POSTBUILD: '',
}));
vi.mock('./gitAuth.js', () => ({
  SshAgentForwarding: class {
    describe() { return 'stub-auth'; }
    mounts() { return []; }
    env() { return {}; }
  },
}));

async function makeResultTar(
  exitCode: number, pushExit: number, headSha: string, branch: string,
): Promise<NodeJS.ReadableStream> {
  const tarStream = await import('tar-stream');
  const pack = tarStream.pack();
  const content = JSON.stringify({ exit_code: exitCode, push_exit: pushExit, head_sha: headSha, branch });
  pack.entry({ name: 'result.json' }, content);
  pack.finalize();
  return pack as unknown as NodeJS.ReadableStream;
}

interface ContainerCapture {
  createdEnv: string[][];
}

function makeSuccessContainer(): Docker.Container {
  const attachStream = new PassThrough();
  let resultTar: NodeJS.ReadableStream | undefined;
  return {
    id: 'continue-container',
    putArchive: async () => {},
    attach: async () => attachStream,
    start: async () => {
      resultTar = await makeResultTar(0, 0, 'cafe', 'feat/keep-going');
      attachStream.push(Buffer.from('[fbi] run succeeded\n'));
      attachStream.push(null);
    },
    wait: async () => ({ StatusCode: 0 }),
    inspect: async () => ({ State: { OOMKilled: false } }),
    getArchive: async () => resultTar!,
    remove: async () => {},
  } as unknown as Docker.Container;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-cont-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const secrets = new SecretsRepo(db, Buffer.alloc(32));
  const settings = new SettingsRepo(db);
  const mcpServers = new McpServersRepo(db);
  const rateLimitState = new RateLimitStateRepo(db);
  const usage = new UsageRepo(db);
  const streams = new RunStreamRegistry();
  const p = projects.create({
    name: 't', repo_url: 'git@example:o/r.git', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const config: Config = {
    port: 0, dbPath: path.join(dir, 'db.sqlite'), runsDir: dir,
    containerMemMb: 512, containerCpus: 1, containerPids: 100,
    hostSshAuthSock: '', gitAuthorName: 'T', gitAuthorEmail: 't@t',
    hostClaudeDir: dir, secretsKeyFile: path.join(dir, 'k'), webDir: dir,
  } as unknown as Config;
  return {
    dir, runs, projects, settings, p, streams,
    makeOrchestrator: (docker: Docker) => new Orchestrator({
      docker, config, projects, runs, secrets, settings, mcpServers, streams, rateLimitState, usage,
    }),
  };
}

describe('Orchestrator.continueRun', () => {
  it('revives a failed run with a captured session and transitions failed → running → succeeded', async () => {
    const { dir, runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'keep going',
      branch_hint: 'feat/keep-going',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `cont-${id}.log`),
    });
    // Walk the run through a full failure cycle.
    runs.markStarted(run.id, 'c1');
    runs.setClaudeSessionId(run.id, 'sess-xyz');
    runs.markFinished(run.id, { state: 'failed', error: 'OOM' });
    // Plant the session JSONL on disk so eligibility passes.
    const sessDir = runMountDir(dir, run.id);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'sess-xyz.jsonl'), '{"x":1}\n');

    const capture: ContainerCapture = { createdEnv: [] };
    const mockDocker = {
      createContainer: vi.fn().mockImplementation(async (spec: { Env: string[] }) => {
        capture.createdEnv.push(spec.Env);
        return makeSuccessContainer();
      }),
    } as unknown as Docker;

    const orch = makeOrchestrator(mockDocker);
    await orch.continueRun(run.id);

    const final = runs.get(run.id)!;
    expect(final.state).toBe('succeeded');
    expect(final.resume_attempts).toBe(0);
    expect(final.error).toBeNull();
    // The env passed to createContainer must carry both the session id and branch name.
    const env = capture.createdEnv[0];
    expect(env).toContain('FBI_RESUME_SESSION_ID=sess-xyz');
    expect(env).toContain('FBI_CHECKOUT_BRANCH=feat/keep-going');
  });

  it('rejects a run without a captured session id', async () => {
    const { runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `cont-${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.markFinished(run.id, { state: 'failed' });
    const orch = makeOrchestrator({ createContainer: vi.fn() } as unknown as Docker);
    await expect(orch.continueRun(run.id)).rejects.toThrow(/no_session/);
  });

  it('rejects a succeeded run', async () => {
    const { runs, p, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `cont-${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.setClaudeSessionId(run.id, 'sess-ok');
    runs.markFinished(run.id, { state: 'succeeded' });
    const orch = makeOrchestrator({ createContainer: vi.fn() } as unknown as Docker);
    await expect(orch.continueRun(run.id)).rejects.toThrow(/wrong_state/);
  });
});
```

- [ ] **Step 2: Verify the tests fail**

```
npx vitest run src/server/orchestrator/continueRun.flow.test.ts
```

Expected: TypeScript/runtime error because `orch.continueRun` doesn't exist yet.

- [ ] **Step 3: Add the error class and method**

In `src/server/orchestrator/index.ts`, add the import and method.

Add to the imports near the top (below the existing `import { LimitMonitor } …` / `nudgeClaudeToExit` lines):

```typescript
import { checkContinueEligibility } from './continueEligibility.js';
```

Add a new exported error class at the top of the file, right after the imports and the `const HERE …` / `const SUPERVISOR …` lines:

```typescript
export class ContinueNotEligibleError extends Error {
  constructor(public readonly code: 'wrong_state' | 'no_session' | 'session_files_missing', message: string) {
    super(`${code}: ${message}`);
    this.name = 'ContinueNotEligibleError';
  }
}
```

Add the method to `Orchestrator`, right after the existing `resume()` method:

```typescript
  async continueRun(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const verdict = checkContinueEligibility(run, this.deps.config.runsDir);
    if (!verdict.ok) throw new ContinueNotEligibleError(verdict.code, verdict.message);

    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => { store.append(chunk); broadcaster.publish(chunk); };
    onBytes(Buffer.from(`\n[fbi] continuing from session ${run.claude_session_id}\n`));

    try {
      const { container } = await this.createContainerForRun(
        runId, {
          resumeSessionId: run.claude_session_id,
          branchName: run.branch_name && run.branch_name.length > 0 ? run.branch_name : null,
        }, onBytes,
      );

      const projectSecrets = this.deps.secrets.decryptAll(run.project_id);
      const effectiveMcps = this.deps.mcpServers.listEffective(run.project_id);
      const claudeJson = buildContainerClaudeJson(
        this.deps.config.hostClaudeDir, effectiveMcps, projectSecrets,
      );
      await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);
      await injectFiles(
        container, '/home/agent/.claude',
        { 'settings.json': JSON.stringify({ skipDangerousModePermissionPrompt: true }) },
        1000,
      );

      const attach = await container.attach({
        stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
      });
      const limitMonitor = this.makeLimitMonitor(runId, container, attach, onBytes);
      attach.on('data', (c: Buffer) => { limitMonitor.feedLog(c); onBytes(c); });
      await container.start();
      limitMonitor.start();
      this.active.set(runId, { container, attachStream: attach });
      this.deps.runs.markContinuing(runId, container.id);
      this.publishState(runId);

      try {
        await this.awaitAndComplete(runId, container, onBytes, store, broadcaster);
      } finally {
        limitMonitor.stop();
      }
    } catch (err) {
      if (err instanceof ContinueNotEligibleError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] continue error: ${msg}\n`));
      this.deps.runs.markFinished(runId, { state: 'failed', error: `continue failed: ${msg}` });
      this.publishState(runId);
      this.active.delete(runId);
      store.close(); broadcaster.end(); this.deps.streams.release(runId);
    }
  }
```

- [ ] **Step 4: Verify tests pass**

```
npx vitest run src/server/orchestrator/continueRun.flow.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Regression check**

```
npx vitest run src/server/orchestrator/ && npm run typecheck
```

Expected: all orchestrator tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```
git add src/server/orchestrator/index.ts src/server/orchestrator/continueRun.flow.test.ts
git commit -m "feat(orchestrator): continueRun for failed/cancelled runs with a saved session"
```

---

## Task 6: HTTP — `POST /api/runs/:id/continue`

**Files:**
- Modify: `src/server/api/runs.ts`
- Test: `src/server/api/runs.test.ts`
- Modify: `src/server/index.ts` (wire the orchestrator method)

- [ ] **Step 1: Write failing route tests**

Append to `src/server/api/runs.test.ts`:

```typescript
  it('POST /api/runs/:id/continue returns 404 for unknown run', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/runs/9999/continue' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/runs/:id/continue forwards to the orchestrator and returns 204', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const proj = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: proj.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(dir, `${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.setClaudeSessionId(run.id, 'sess');
    runs.markFinished(run.id, { state: 'failed' });

    const continued: number[] = [];
    const app = Fastify();
    registerRunsRoutes(app, {
      runs, projects, gh: stubGh, runsDir: dir,
      launch: async () => {}, cancel: async () => {},
      fireResumeNow: () => {},
      continueRun: async (id: number) => { continued.push(id); },
    });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/continue` });
    expect(res.statusCode).toBe(204);
    expect(continued).toEqual([run.id]);
  });

  it('POST /api/runs/:id/continue returns 409 with code when ineligible', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const proj = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: proj.id, prompt: 'x',
      log_path_tmpl: (id) => path.join(dir, `${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.markFinished(run.id, { state: 'failed' });
    const app = Fastify();
    registerRunsRoutes(app, {
      runs, projects, gh: stubGh, runsDir: dir,
      launch: async () => {}, cancel: async () => {},
      fireResumeNow: () => {},
      continueRun: async () => {
        const { ContinueNotEligibleError } = await import('../orchestrator/index.js');
        throw new ContinueNotEligibleError('no_session', 'no claude session');
      },
    });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/continue` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'no_session', message: 'no claude session' });
  });
```

Also update the three existing `registerRunsRoutes(app, { … })` calls in the same file to include `continueRun: async (_id: number) => {},` alongside the existing `fireResumeNow`. (Two are in `setup()` and `makeApp()` at the top; after this task both call sites need the new field.)

- [ ] **Step 2: Verify they fail**

```
npx vitest run src/server/api/runs.test.ts
```

Expected: compile/test errors because `continueRun` is not in `Deps`.

- [ ] **Step 3: Implement the route**

In `src/server/api/runs.ts`:

Extend the `Deps` interface:

```typescript
interface Deps {
  runs: RunsRepo;
  projects: ProjectsRepo;
  gh: GhDeps;
  runsDir: string;
  launch: (runId: number) => Promise<void>;
  cancel: (runId: number) => Promise<void>;
  fireResumeNow: (runId: number) => void;
  continueRun: (runId: number) => Promise<void>;
}
```

Add the route immediately after the existing `POST /api/runs/:id/resume-now` block:

```typescript
  app.post('/api/runs/:id/continue', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    try {
      await deps.continueRun(run.id);
      return reply.code(204).send();
    } catch (err) {
      const { ContinueNotEligibleError } = await import('../orchestrator/index.js');
      if (err instanceof ContinueNotEligibleError) {
        return reply.code(409).send({ code: err.code, message: err.message.replace(/^[^:]+:\s*/, '') });
      }
      app.log.error({ err }, 'continueRun failed');
      return reply.code(500).send({ message: err instanceof Error ? err.message : String(err) });
    }
  });
```

- [ ] **Step 4: Wire the orchestrator method into the server**

In `src/server/index.ts`, update the `registerRunsRoutes` call to pass the new method:

```typescript
  registerRunsRoutes(app, {
    runs, projects, gh,
    runsDir: config.runsDir,
    launch: (id) => orchestrator.launch(id),
    cancel: (id) => orchestrator.cancel(id),
    fireResumeNow: (id) => orchestrator.fireResumeNow(id),
    continueRun: (id) => orchestrator.continueRun(id),
  });
```

- [ ] **Step 5: Verify tests pass**

```
npx vitest run src/server/api/runs.test.ts && npm run typecheck
```

Expected: all runs-routes tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```
git add src/server/api/runs.ts src/server/api/runs.test.ts src/server/index.ts
git commit -m "feat(api): POST /api/runs/:id/continue"
```

---

## Task 7: Web — API client method

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Add the client method**

Append to the `api` object in `src/web/lib/api.ts`, next to `deleteRun`:

```typescript
  continueRun: (id: number) =>
    request<void>(`/api/runs/${id}/continue`, { method: 'POST' }),
```

- [ ] **Step 2: Verify compile**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```
git add src/web/lib/api.ts
git commit -m "feat(web-api): continueRun client method"
```

---

## Task 8: Web — `RunHeader` Continue button

**Files:**
- Modify: `src/web/features/runs/RunHeader.tsx`
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Add the prop and button to `RunHeader`**

Replace the existing `RunHeaderProps` and `RunHeader` body in `src/web/features/runs/RunHeader.tsx`:

```typescript
export interface RunHeaderProps {
  run: Run;
  onCancel: () => void;
  onDelete: () => void;
  onContinue: () => void;
}

export function RunHeader({ run, onCancel, onDelete, onContinue }: RunHeaderProps) {
  const nav = useNavigate();
  const canFollowUp = run.state !== 'running' && run.state !== 'queued' && run.state !== 'awaiting_resume' && !!run.branch_name;
  const canContinue = run.state === 'failed' || run.state === 'cancelled';
  const continueDisabled = !run.claude_session_id;
  return (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-border-strong bg-surface">
      <h1 className="text-[16px] font-semibold">Run #{run.id}</h1>
      <Pill tone={TONE[run.state]}>{run.state}</Pill>
      {run.branch_name && <CodeBlock>{run.branch_name}{run.head_commit ? `@${run.head_commit.slice(0,8)}` : ''}</CodeBlock>}
      <div className="ml-auto flex gap-1.5">
        {canContinue && (
          <Button
            variant="primary"
            size="sm"
            onClick={onContinue}
            disabled={continueDisabled}
            title={continueDisabled ? 'No session captured — start a new run instead' : undefined}
          >
            Continue
          </Button>
        )}
        {canFollowUp && <Button variant="ghost" size="sm" onClick={() => nav(`/projects/${run.project_id}/runs/new?branch=${encodeURIComponent(run.branch_name!)}`)}>Follow up</Button>}
        {(run.state === 'running' || run.state === 'awaiting_resume') && <Button variant="danger" size="sm" onClick={onCancel}>Cancel</Button>}
        <Menu
          trigger={<Button variant="ghost" size="sm">More ▾</Button>}
          items={[
            { id: 'delete', label: 'Delete run', danger: true, onSelect: onDelete, disabled: run.state === 'running' || run.state === 'awaiting_resume' },
          ]}
        />
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Wire the handler in `RunDetail`**

In `src/web/pages/RunDetail.tsx`, add `kontinue` handler near `cancel`/`remove`:

```typescript
  async function kontinue() {
    if (!run) return;
    try { await api.continueRun(run.id); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }
```

(`kontinue` sidesteps the JS reserved word `continue`.)

Update the `<RunHeader … />` tag to pass the new prop:

```tsx
      <RunHeader run={run} onCancel={cancel} onDelete={remove} onContinue={kontinue} />
```

- [ ] **Step 3: Typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Verify unit tests still pass**

```
npx vitest run
```

Expected: 315 tests pass (existing 312 + 3 new DB tests + 7 eligibility + 3 flow + 3 supervisor + 3 API = full suite updated numbers; the important thing is zero failures).

- [ ] **Step 5: Commit**

```
git add src/web/features/runs/RunHeader.tsx src/web/pages/RunDetail.tsx
git commit -m "feat(ui): Continue button on RunHeader for failed/cancelled runs"
```

---

## Task 9: Manual smoke + final sweep

**Files:** none modified unless issues surface.

- [ ] **Step 1: Run the full test suite and typecheck and lint**

```
npx vitest run && npm run typecheck && npm run lint
```

Expected: all tests pass, typecheck clean, lint shows no new errors (pre-existing warnings in unrelated files are acceptable).

- [ ] **Step 2: Smoke test in dev**

Start the dev server:

```
./scripts/dev.sh
```

In a browser:
1. Start a run that fails quickly (e.g., an empty repo or a prompt that makes Claude error).
2. On the RunDetail page, confirm the **Continue** button is visible.
3. If `claude_session_id` is null (very fast failure), confirm the button is disabled with the tooltip.
4. Click Continue. Confirm the log stream picks up `[fbi] continuing from session …` and state transitions back to `running`.
5. Confirm the new container checks out the run's branch (visible in the log tail).

- [ ] **Step 3: If smoke reveals a gap, add a test and fix**

No placeholder steps — if something breaks, diagnose using the systematic-debugging skill and add a regression test before merging.

- [ ] **Step 4: Final commit / nothing to commit**

If anything changed in step 3, commit it with a descriptive message. Otherwise proceed to PR.

---

## Notes for the implementer

- **TDD strictness:** every task that creates or modifies logic follows red → green → commit. Don't batch multiple unrelated changes in one commit.
- **The flow test file redeclares helper functions** (`makeResultTar`, `setup`, etc.) that also exist in `autoResume.flow.test.ts`. This is intentional: no shared test-utility module today, duplication is preferable to premature extraction. If a third flow test appears, extract then.
- **`kontinue` function name** is deliberate — `continue` is reserved. Alternatives considered: `onContinue`/`doContinue`. `kontinue` keeps the call site reading like the button action.
- **HTTP 409 body shape** matches what the spec promises: `{ code, message }`, no `error` field. Keep the message short — the UI uses it in an alert/toast.
- **No DB migration is needed.** All columns used (`resume_attempts`, `claude_session_id`, `finished_at`, `exit_code`, `error`) already exist.
- **Auto-resume still uses the branch too:** Task 4 wires `run.branch_name` into the existing `resume()` path, so a rate-limit-then-resume sequence now also checks out the pushed branch. The auto-resume flow test (`autoResume.flow.test.ts`) must remain green after Task 4.
