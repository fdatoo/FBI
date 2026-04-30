# `starting` Run State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `starting` `RunState` that covers the gap between a launch request (fresh run, manual Continue, or auto-resume) and Claude becoming visible in the container, so the UI shows responsive feedback the moment a Continue/launch happens.

**Architecture:** The orchestrator's `WaitingWatcher` is generalized to a `RuntimeStateWatcher` that polls two sentinel files (`/fbi-state/waiting`, `/fbi-state/prompted`) and derives `'starting' | 'running' | 'waiting'`. A new `prompted` sentinel is touched by Claude Code's existing `UserPromptSubmit` hook. The DB grows a small set of focused state-transition methods. The Continue API endpoint flips state to `starting` synchronously before kicking off the async container lifecycle, so the WS `state` message lands within milliseconds of the click.

**Tech Stack:** TypeScript, Vitest, Fastify, better-sqlite3, React, Tailwind, Playwright (manual verification only).

**Spec:** `docs/superpowers/specs/2026-04-24-starting-state-design.md`

---

## File map

**New / renamed:**
- `src/server/orchestrator/runtimeStateWatcher.ts` (rename of `waitingWatcher.ts`) — polls two sentinel files and emits derived state.
- `src/server/orchestrator/runtimeStateWatcher.test.ts` (rename of `waitingWatcher.test.ts`).

**Modified:**
- `src/shared/types.ts` — add `'starting'` to `RunState`.
- `src/server/orchestrator/index.ts` — `buildClaudeSettingsJson`, all four launch sites (`launch`, `resume`, `continueRun`, `recover`/reattach), expose `markStartingForContinueRequest` to API, replace `makeWaitingWatcher` with `makeRuntimeStateWatcher`.
- `src/server/orchestrator/claudeSettings.test.ts` — assert new compound `UserPromptSubmit` command.
- `src/server/orchestrator/continueEligibility.ts` — reject `starting` (and `queued`) runs.
- `src/server/orchestrator/continueEligibility.test.ts` — cover new ineligible states.
- `src/server/db/runs.ts` — replace `markStarted`/`markContinuing`/`markResuming`/`markRunningFromWaiting` with new methods.
- `src/server/api/runs.ts` — `/api/runs/:id/continue` flips state synchronously.
- `src/web/features/runs/RunHeader.tsx` — `TONE` covers `starting`; `canContinue` excludes it; Cancel button can't show during `starting`.
- `src/web/features/runs/RunRow.tsx` — `TONE` covers `starting`.
- `src/web/features/runs/RunsList.tsx` — `TONE_TEXT` covers `starting`; `running` count includes `starting` (or rename label).
- `src/web/features/runs/StateFilterButton.tsx` — `ORDER`/`DOT_TONE` cover `starting`.
- `src/web/features/runs/useRunsView.ts` — `ALL_STATES`/`ACTIVE_STATES` cover `starting`.
- `src/web/features/projects/ProjectList.tsx` — sidebar dot treats `starting` as active.

**Deleted (callers replaced):**
- None — files stay; methods rename within them.

---

## Conventions

- TDD throughout: write the failing test first, run, watch it fail, implement, run, watch it pass, commit.
- Keep each commit small (one logical change) so review is cheap.
- Test commands: `npx vitest run <path>` for one file, `npm run test` for all.
- Branch is already created (`feat/starting-state-resume`). Stay on it.

---

## Task 1: Add `'starting'` to `RunState`

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Edit the union type**

In `src/shared/types.ts`, replace lines 1–8:

```ts
export type RunState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'awaiting_resume'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
```

- [ ] **Step 2: Run the type checker**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: errors in any file that exhaustively switches on `RunState` and doesn't yet handle `starting`. We will fix each in subsequent tasks. Note the failing files — they're the implicit task list for the frontend pass.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "types: add 'starting' to RunState union"
```

---

## Task 2: Add `prompted` sentinel to the `UserPromptSubmit` hook

**Files:**
- Modify: `src/server/orchestrator/index.ts:1003-1015` (`buildClaudeSettingsJson`)
- Test: `src/server/orchestrator/claudeSettings.test.ts`

- [ ] **Step 1: Update the test (TDD — write the new assertion first)**

In `src/server/orchestrator/claudeSettings.test.ts`, replace the existing `UserPromptSubmit` assertion (lines 20–28) with:

```ts
it('wires UserPromptSubmit to remove /fbi-state/waiting and create /fbi-state/prompted', () => {
  const parsed = JSON.parse(buildClaudeSettingsJson());
  const ups = parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
  expect(ups).toEqual({
    type: 'command',
    command: 'rm -f /fbi-state/waiting && touch /fbi-state/prompted',
    timeout: 5,
  });
});
```

- [ ] **Step 2: Run the test, watch it fail**

Run: `npx vitest run src/server/orchestrator/claudeSettings.test.ts`
Expected: FAIL — the existing command is `'rm -f /fbi-state/waiting'`.

- [ ] **Step 3: Update `buildClaudeSettingsJson`**

In `src/server/orchestrator/index.ts`, find the `UserPromptSubmit` hook (around line 1010–1012) and change the command:

```ts
UserPromptSubmit: [
  { hooks: [{
    type: 'command',
    command: 'rm -f /fbi-state/waiting && touch /fbi-state/prompted',
    timeout: 5,
  }] },
],
```

Also update the comment block above (lines 997–1002) to mention the new sentinel:

```ts
// ~/.claude/settings.json injected into every run container. `hooks` wires
// Claude Code's Stop and UserPromptSubmit events to two /fbi-state/ sentinel
// files that RuntimeStateWatcher polls. Stop creates /fbi-state/waiting
// (turn ended). UserPromptSubmit removes /fbi-state/waiting (user replied)
// AND creates /fbi-state/prompted (sticky — Claude has accepted at least
// one prompt this container, so it's past the launch gap). Derived state:
//   waiting present                 -> 'waiting'
//   waiting absent, prompted present -> 'running'
//   both absent                      -> 'starting'
```

- [ ] **Step 4: Run the test, watch it pass**

Run: `npx vitest run src/server/orchestrator/claudeSettings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/claudeSettings.test.ts
git commit -m "orchestrator(hook): UserPromptSubmit also touches /fbi-state/prompted"
```

---

## Task 3: Replace `WaitingWatcher` with `RuntimeStateWatcher`

This is the biggest single piece — generalize the watcher to derive runtime state from two sentinel files.

**Files:**
- Create: `src/server/orchestrator/runtimeStateWatcher.ts`
- Create: `src/server/orchestrator/runtimeStateWatcher.test.ts`
- Delete: `src/server/orchestrator/waitingWatcher.ts`
- Delete: `src/server/orchestrator/waitingWatcher.test.ts`

- [ ] **Step 1: Write the new test file**

Create `src/server/orchestrator/runtimeStateWatcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeStateWatcher, type DerivedRuntimeState } from './runtimeStateWatcher.js';

describe('RuntimeStateWatcher', () => {
  let dir: string;
  let waiting: string;
  let prompted: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-rsw-'));
    waiting = path.join(dir, 'waiting');
    prompted = path.join(dir, 'prompted');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const mk = () => {
    const events: DerivedRuntimeState[] = [];
    const w = new RuntimeStateWatcher({
      waitingPath: waiting,
      promptedPath: prompted,
      onChange: (s) => events.push(s),
    });
    return { w, events };
  };

  it('emits starting on first poll when both files are absent', () => {
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['starting']);
  });

  it('emits running on first poll when only prompted is present (reattach mid-turn)', () => {
    fs.writeFileSync(prompted, '');
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['running']);
  });

  it('emits waiting on first poll when waiting is present (reattach at idle)', () => {
    fs.writeFileSync(waiting, '');
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['waiting']);
  });

  it('waiting wins when both files are present', () => {
    fs.writeFileSync(waiting, '');
    fs.writeFileSync(prompted, '');
    const { w, events } = mk();
    w.checkNow();
    expect(events).toEqual(['waiting']);
  });

  it('starting -> running when prompted appears', () => {
    const { w, events } = mk();
    w.checkNow();
    fs.writeFileSync(prompted, '');
    w.checkNow();
    expect(events).toEqual(['starting', 'running']);
  });

  it('starting -> waiting directly when Stop fires before any prompt (continue case)', () => {
    const { w, events } = mk();
    w.checkNow();
    fs.writeFileSync(waiting, '');
    w.checkNow();
    expect(events).toEqual(['starting', 'waiting']);
  });

  it('running -> waiting -> running over a turn', () => {
    fs.writeFileSync(prompted, '');
    const { w, events } = mk();
    w.checkNow();                       // running
    fs.writeFileSync(waiting, '');
    w.checkNow();                       // waiting
    fs.unlinkSync(waiting);
    w.checkNow();                       // running (prompted still present)
    expect(events).toEqual(['running', 'waiting', 'running']);
  });

  it('does not re-emit on identical successive polls', () => {
    fs.writeFileSync(prompted, '');
    const { w, events } = mk();
    w.checkNow();
    w.checkNow();
    w.checkNow();
    expect(events).toEqual(['running']);
  });

  it('start()/stop() drives polling', async () => {
    const events: DerivedRuntimeState[] = [];
    const w = new RuntimeStateWatcher({
      waitingPath: waiting, promptedPath: prompted, pollMs: 10,
      onChange: (s) => events.push(s),
    });
    w.start();
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(prompted, '');
    await new Promise((r) => setTimeout(r, 50));
    w.stop();
    expect(events).toEqual(['starting', 'running']);
  });

  it('stop() is idempotent and silent after', async () => {
    const events: DerivedRuntimeState[] = [];
    const w = new RuntimeStateWatcher({
      waitingPath: waiting, promptedPath: prompted, pollMs: 10,
      onChange: (s) => events.push(s),
    });
    w.start();
    w.stop();
    w.stop();
    fs.writeFileSync(prompted, '');
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(['starting']);  // first poll happened before stop
  });
});
```

- [ ] **Step 2: Run the test, watch it fail (file doesn't exist yet)**

Run: `npx vitest run src/server/orchestrator/runtimeStateWatcher.test.ts`
Expected: FAIL with import error — `runtimeStateWatcher.js` not found.

- [ ] **Step 3: Implement the watcher**

Create `src/server/orchestrator/runtimeStateWatcher.ts`:

```ts
import fs from 'node:fs';

export type DerivedRuntimeState = 'starting' | 'running' | 'waiting';

export interface RuntimeStateWatcherOptions {
  /** Path to the sentinel created by Claude Code's Stop hook. */
  waitingPath: string;
  /** Path to the sentinel created by Claude Code's UserPromptSubmit hook. */
  promptedPath: string;
  pollMs?: number;
  /** Fires on first poll AND on every change. */
  onChange: (state: DerivedRuntimeState) => void;
}

/**
 * Polls two sentinel files written by Claude Code hooks and derives a
 * runtime state. Fires `onChange` once on first poll (so reattach picks up
 * the current state) and again on every transition. Steady state is silent.
 *
 *   waiting present                  -> 'waiting'
 *   waiting absent, prompted present -> 'running'
 *   both absent                      -> 'starting'
 */
export class RuntimeStateWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private last: DerivedRuntimeState | null = null;
  private readonly pollMs: number;

  constructor(private opts: RuntimeStateWatcherOptions) {
    this.pollMs = opts.pollMs ?? 500;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      try { this.readOnce(); } catch { /* best-effort */ }
      this.timer = setTimeout(tick, this.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Synchronous poll — exposed for tests. */
  checkNow(): void { this.readOnce(); }

  private readOnce(): void {
    const waiting = fs.existsSync(this.opts.waitingPath);
    const prompted = fs.existsSync(this.opts.promptedPath);
    const derived: DerivedRuntimeState = waiting
      ? 'waiting'
      : prompted ? 'running' : 'starting';
    if (this.last === derived) return;
    this.last = derived;
    this.opts.onChange(derived);
  }
}
```

- [ ] **Step 4: Run the test, watch it pass**

Run: `npx vitest run src/server/orchestrator/runtimeStateWatcher.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Delete the old watcher and its test**

```bash
git rm src/server/orchestrator/waitingWatcher.ts src/server/orchestrator/waitingWatcher.test.ts
```

(The orchestrator still imports `WaitingWatcher` — we wire the new watcher in next. The TS build will fail until then; that's expected.)

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/runtimeStateWatcher.ts src/server/orchestrator/runtimeStateWatcher.test.ts
git commit -m "orchestrator: add RuntimeStateWatcher (derives state from two sentinels)"
```

---

## Task 4: Replace DB state-transition methods

**Files:**
- Modify: `src/server/db/runs.ts:97-168`
- Test: a small inline assertion in this task; broader DB tests covered by orchestrator flow tests (Tasks 5–7).

- [ ] **Step 1: Replace the methods**

In `src/server/db/runs.ts`, find lines 97–168 (the `markStarted` / `markAwaitingResume` / `markResuming` / `markContinuing` / `markWaiting` / `markRunningFromWaiting` block).

Replace `markStarted` (lines 97–104) with:

```ts
  /**
   * Fresh launch: queued -> starting. Records container id and started_at.
   * RuntimeStateWatcher will later transition starting -> running once the
   * `prompted` sentinel appears (Claude read the initial prompt).
   */
  markStartingFromQueued(id: number, containerId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs
            SET state='starting',
                container_id=?,
                started_at=?,
                state_entered_at=?
          WHERE id=? AND state='queued'`,
      )
      .run(containerId, now, now, id);
  }
```

Leave `markAwaitingResume` (lines 106–122) unchanged.

Replace `markResuming` (lines 124–137) with:

```ts
  /**
   * Auto-resume: awaiting_resume -> starting. Preserves resume_attempts
   * (markAwaitingResume already incremented it).
   */
  markStartingForResume(id: number, containerId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs
            SET state='starting',
                container_id=?,
                next_resume_at=NULL,
                started_at=COALESCE(started_at, ?),
                state_entered_at=?
          WHERE id=? AND state='awaiting_resume'`,
      )
      .run(containerId, now, now, id);
  }
```

Replace `markContinuing` (lines 139–156) with two methods:

```ts
  /**
   * User-initiated Continue, first call (from API endpoint). No container
   * exists yet. Resets resume_attempts and clears terminal-run residue.
   */
  markStartingForContinueRequest(id: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs
            SET state='starting',
                resume_attempts=0,
                next_resume_at=NULL,
                finished_at=NULL,
                exit_code=NULL,
                error=NULL,
                state_entered_at=?
          WHERE id=? AND state IN ('failed','cancelled','succeeded')`,
      )
      .run(now, id);
  }

  /**
   * User-initiated Continue, second call (from orchestrator after the
   * container exists). Records container id and refreshes state_entered_at.
   * Source-state guard is 'starting' — markStartingForContinueRequest must
   * have run first.
   */
  markStartingContainer(id: number, containerId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs
            SET container_id=?,
                started_at=COALESCE(started_at, ?),
                state_entered_at=?
          WHERE id=? AND state='starting'`,
      )
      .run(containerId, now, now, id);
  }
```

Replace `markWaiting` (lines 158–162) with widened guard:

```ts
  markWaiting(id: number): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='waiting', state_entered_at=?
          WHERE id=? AND state IN ('starting','running')`,
      )
      .run(Date.now(), id);
  }
```

Replace `markRunningFromWaiting` (lines 164–168) with:

```ts
  /**
   * RuntimeStateWatcher saw the `prompted` sentinel: Claude is processing
   * a prompt. Allowed from 'starting' (initial launch) or 'waiting'
   * (subsequent reply).
   */
  markRunning(id: number): void {
    this.db
      .prepare(
        `UPDATE runs
            SET state='running', state_entered_at=?
          WHERE id=? AND state IN ('starting','waiting')`,
      )
      .run(Date.now(), id);
  }
```

- [ ] **Step 2: Build the project**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: errors in `src/server/orchestrator/index.ts` referencing the old method names. We fix those in Tasks 5–7. Errors elsewhere (frontend) are from Task 1 and will be addressed in Tasks 11+.

- [ ] **Step 3: Commit**

```bash
git add src/server/db/runs.ts
git commit -m "db: split run-state transitions to support 'starting' state"
```

---

## Task 5: Wire the new watcher and DB methods into `launch` (fresh runs)

**Files:**
- Modify: `src/server/orchestrator/index.ts` (imports, `makeWaitingWatcher`, `launch` body)

- [ ] **Step 1: Update the import**

In `src/server/orchestrator/index.ts`, find line 33:

```ts
import { WaitingWatcher } from './waitingWatcher.js';
```

Replace with:

```ts
import { RuntimeStateWatcher, type DerivedRuntimeState } from './runtimeStateWatcher.js';
```

- [ ] **Step 2: Replace `makeWaitingWatcher` with `makeRuntimeStateWatcher`**

In `src/server/orchestrator/index.ts`, find the `makeWaitingWatcher` method (lines 706–718) and replace with:

```ts
  private makeRuntimeStateWatcher(runId: number): RuntimeStateWatcher {
    const stateDir = this.stateDirFor(runId);
    return new RuntimeStateWatcher({
      waitingPath: `${stateDir}/waiting`,
      promptedPath: `${stateDir}/prompted`,
      onChange: (state: DerivedRuntimeState) => {
        // 'starting' is set explicitly at launch sites — the watcher only
        // needs to drive the running/waiting transitions. The DB guards on
        // markRunning / markWaiting allow them from 'starting' too, so
        // there's no separate "first transition out of starting" branch.
        if (state === 'running') {
          this.deps.runs.markRunning(runId);
          this.publishState(runId);
        } else if (state === 'waiting') {
          this.deps.runs.markWaiting(runId);
          this.publishState(runId);
        }
      },
    });
  }
```

- [ ] **Step 3: Update `launch` to use the new types and methods**

In `src/server/orchestrator/index.ts`, find line 293:

```ts
let waitingWatcher: WaitingWatcher | null = null;
```

Replace with:

```ts
let runtimeWatcher: RuntimeStateWatcher | null = null;
```

Find line 322:

```ts
waitingWatcher = this.makeWaitingWatcher(runId);
```

Replace with:

```ts
runtimeWatcher = this.makeRuntimeStateWatcher(runId);
```

Find line 329:

```ts
waitingWatcher.start();
```

Replace with:

```ts
runtimeWatcher.start();
```

Find line 331:

```ts
this.deps.runs.markStarted(runId, container.id);
```

Replace with:

```ts
this.deps.runs.markStartingFromQueued(runId, container.id);
```

Find the `finally` block (around line 386):

```ts
if (waitingWatcher) waitingWatcher.stop();
```

Replace with:

```ts
if (runtimeWatcher) runtimeWatcher.stop();
```

- [ ] **Step 4: Run all orchestrator tests, find any breakage**

Run: `npx vitest run src/server/orchestrator/`
Expected: pre-existing flow tests may fail because they assert on `markStarted`/`'running'` states. Fix each one as needed:
- Tests that did `runs.get(...).state === 'running'` after launch should now expect `'starting'` (until the prompted sentinel appears).
- Tests using a fixture that touches `/fbi-state/waiting` should also touch `/fbi-state/prompted` if they expect `'running'`.

Read each failing test, understand what it asserts, and decide:
- If it's asserting "container started", change to expect `'starting'`.
- If it's asserting end-of-run state (`'succeeded'`/`'failed'`), no change.
- If it's asserting mid-run interactive state (`'running'`/`'waiting'`), the test needs to also create the `prompted` sentinel to drive `'starting' -> 'running'`.

Commit fixes alongside this task.

- [ ] **Step 5: Run the build**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: errors only in `resume`, `continueRun`, and `recover` paths (Tasks 6, 7, 8). No new errors elsewhere in the orchestrator.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/__fixtures__ src/server/orchestrator/*.test.ts
git commit -m "orchestrator(launch): use RuntimeStateWatcher and 'starting' state"
```

---

## Task 6: Wire `continueRun` to the new state machine

**Files:**
- Modify: `src/server/orchestrator/index.ts:606-675` (`continueRun`)

- [ ] **Step 1: Replace the eligibility check at the top of `continueRun`**

By the time `continueRun` runs, the API endpoint (Task 9) has already validated eligibility and flipped state to `'starting'`. The existing `checkContinueEligibility(run, runsDir)` call would now reject `'starting'` (its whitelist only covers `failed`/`cancelled`/`succeeded`), which we must NOT relax — the API needs that whitelist to keep double-click protection working.

In `src/server/orchestrator/index.ts:609-610`, replace:

```ts
const verdict = checkContinueEligibility(run, this.deps.config.runsDir);
if (!verdict.ok) throw new ContinueNotEligibleError(verdict.code, verdict.message);
```

With:

```ts
// API endpoint has already validated eligibility and flipped to 'starting'.
// Bail defensively if state is no longer 'starting' (e.g., a cancel raced us).
if (run.state !== 'starting') {
  throw new ContinueNotEligibleError(
    'wrong_state',
    `continueRun: expected state 'starting' (set by API), got '${run.state}'`,
  );
}
```

- [ ] **Step 2: Replace the watcher and state call inside `continueRun`**

In `src/server/orchestrator/index.ts:642`:

```ts
const waitingWatcher = this.makeWaitingWatcher(runId);
```

Replace with:

```ts
const runtimeWatcher = this.makeRuntimeStateWatcher(runId);
```

In line 646:

```ts
waitingWatcher.start();
```

Replace with:

```ts
runtimeWatcher.start();
```

In line 648:

```ts
this.deps.runs.markContinuing(runId, container.id);
```

Replace with:

```ts
this.deps.runs.markStartingContainer(runId, container.id);
```

(`markStartingContainer`'s SQL guard requires `state='starting'` — which Step 1 just verified.)

In line 664:

```ts
waitingWatcher.stop();
```

Replace with:

```ts
runtimeWatcher.stop();
```

- [ ] **Step 3: Update `continueRun.flow.test.ts`**

Open `src/server/orchestrator/continueRun.flow.test.ts`. Tests that call `continueRun` directly (without going through the API endpoint) must now first call `repo.markStartingForContinueRequest(id)` to set state to `'starting'`, otherwise the new defensive check in Step 1 will throw.

Find tests that:
- Call `await orch.continueRun(id)` directly: prepend `repo.markStartingForContinueRequest(id)`.
- Assert the state after `continueRun`'s `markStartingContainer` call is `'running'`: change to expect `'starting'`. To exercise the `'starting' -> 'running'` transition, the test fixture must also touch `/fbi-state/prompted`.

Run: `npx vitest run src/server/orchestrator/continueRun.flow.test.ts`
Expected: PASS after fixes. Adjust expected states until green.

- [ ] **Step 4: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/continueRun.flow.test.ts
git commit -m "orchestrator(continueRun): use RuntimeStateWatcher and 'starting' state"
```

---

## Task 7: Wire `resume` (auto-resume) to the new state machine

**Files:**
- Modify: `src/server/orchestrator/index.ts:506-604` (`resume`)

- [ ] **Step 1: Replace the watcher and state call inside `resume`**

In `src/server/orchestrator/index.ts:572`:

```ts
const waitingWatcher = this.makeWaitingWatcher(runId);
```

Replace with:

```ts
const runtimeWatcher = this.makeRuntimeStateWatcher(runId);
```

In line 576:

```ts
waitingWatcher.start();
```

Replace with:

```ts
runtimeWatcher.start();
```

In line 578:

```ts
this.deps.runs.markResuming(runId, container.id);
```

Replace with:

```ts
this.deps.runs.markStartingForResume(runId, container.id);
```

In line 594:

```ts
waitingWatcher.stop();
```

Replace with:

```ts
runtimeWatcher.stop();
```

- [ ] **Step 2: Run auto-resume tests**

Run: `npx vitest run src/server/orchestrator/autoResume.test.ts src/server/orchestrator/autoResume.flow.test.ts`
Expected: PASS after fixing any assertions on the post-resume state (`'running'` -> `'starting'`).

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/autoResume*.test.ts
git commit -m "orchestrator(resume): use RuntimeStateWatcher and 'starting' state"
```

---

## Task 8: Wire `recover` (reattach) to the new state machine

**Files:**
- Modify: `src/server/orchestrator/index.ts` around line 860 (the reattach path)

- [ ] **Step 1: Replace the watcher reference in the reattach path**

Find line 860:

```ts
const waitingWatcher = this.makeWaitingWatcher(runId);
```

Replace with:

```ts
const runtimeWatcher = this.makeRuntimeStateWatcher(runId);
```

Find any subsequent `waitingWatcher.start()` / `waitingWatcher.stop()` in the same function (search from line 860 forward) and rename to `runtimeWatcher`.

- [ ] **Step 2: Verify no `WaitingWatcher` references remain**

Run: `grep -rn 'WaitingWatcher\|waitingWatcher' src/server/`
Expected: zero matches.

- [ ] **Step 3: Run the full server build**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors in `src/server/`. Frontend errors from Task 1 still pending (Tasks 11–15).

- [ ] **Step 4: Run all orchestrator tests**

Run: `npx vitest run src/server/orchestrator/`
Expected: PASS, including `reattach.flow.test.ts`. If it fails, the reattach test may be asserting a state of `'running'` post-recover — adjust to expect whatever the watcher derives from the actual sentinel files in the test fixture.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/reattach.flow.test.ts
git commit -m "orchestrator(recover): use RuntimeStateWatcher on reattach"
```

---

## Task 9: Make `POST /api/runs/:id/continue` flip state synchronously

**Files:**
- Modify: `src/server/api/runs.ts:36-48` (Deps), `src/server/api/runs.ts:197-213` (endpoint)
- Modify: `src/server/index.ts:108-115` (wire new dep)
- Modify: `src/server/orchestrator/index.ts` (expose helper)

The orchestrator's `publishState` is `private`. Add a thin public method that the API can call: it flips state to `starting` via the DB and broadcasts via `publishState`.

- [ ] **Step 1: Add the public helper on the orchestrator**

In `src/server/orchestrator/index.ts`, just below the `private publishState(runId: number)` method (around line 165), add:

```ts
  /**
   * Public wrapper for the API endpoint: synchronously flips a terminated
   * run to `starting` and broadcasts the state change. The async
   * continueRun lifecycle (container creation, etc.) is kicked off
   * separately by the endpoint as fire-and-forget.
   */
  markStartingForContinueRequest(runId: number): void {
    this.deps.runs.markStartingForContinueRequest(runId);
    this.publishState(runId);
  }
```

- [ ] **Step 2: Add the new dep to `src/server/api/runs.ts`**

In `src/server/api/runs.ts`, find the `Deps` interface (lines 36–48). Add a field after `continueRun`:

```ts
interface Deps {
  // ... existing fields ...
  continueRun: (runId: number) => Promise<void>;
  markStartingForContinueRequest: (runId: number) => void;  // NEW
  orchestrator: OrchestratorDep;
}
```

- [ ] **Step 3: Wire the dep in `src/server/index.ts`**

In `src/server/index.ts`, find lines 108–115 (the orchestrator deps wiring). Add after the `continueRun` line:

```ts
    continueRun: (id) => orchestrator.continueRun(id),
    markStartingForContinueRequest: (id) => orchestrator.markStartingForContinueRequest(id),
```

- [ ] **Step 4: Update the endpoint to flip state synchronously**

In `src/server/api/runs.ts`, replace the `/api/runs/:id/continue` handler (lines 197–213) with:

```ts
  app.post('/api/runs/:id/continue', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    // Synchronous eligibility check so 409s don't pay the latency of the
    // orchestrator's full container-start sequence.
    const verdict = checkContinueEligibility(run, deps.runsDir);
    if (!verdict.ok) {
      return reply.code(409).send({ code: verdict.code, message: verdict.message });
    }
    // Flip to 'starting' synchronously so the UI's WS state message lands
    // within milliseconds of the click — before Docker is even called.
    // continueEligibility's source-state check rejects 'starting', so a
    // double-click is a clean 409.
    deps.markStartingForContinueRequest(run.id);
    // Fire-and-forget: continueRun runs the entire container lifecycle, so
    // awaiting it would block the HTTP response for the duration of the run.
    void deps.continueRun(run.id).catch((err) => {
      app.log.error({ err }, 'continueRun failed');
    });
    return reply.code(204).send();
  });
```

- [ ] **Step 5: Add an endpoint test (or extend an existing one)**

Look for `src/server/api/runs.test.ts`. If it exists, add a test:

```ts
it('POST /api/runs/:id/continue flips state to starting synchronously', async () => {
  // ... setup a run in 'succeeded' state with a claude_session_id ...
  const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/continue` });
  expect(res.statusCode).toBe(204);
  // State must already be 'starting' by the time the response returns —
  // before the async continueRun has any chance to do work.
  const after = repo.get(run.id)!;
  expect(after.state).toBe('starting');
});
```

If `runs.test.ts` doesn't exist, add this assertion to whichever test file already exercises `/api/runs/:id/continue` (search: `grep -rln "/api/runs.*continue" src/server/api/`).

Run the test, verify it passes.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/api/runs.ts src/server/index.ts src/server/api/runs.test.ts
git commit -m "api(continue): flip run state to 'starting' synchronously"
```

---

## Task 10: Reject `starting` (and `queued`) in `continueEligibility`

**Files:**
- Modify: `src/server/orchestrator/continueEligibility.ts`
- Test: `src/server/orchestrator/continueEligibility.test.ts`

- [ ] **Step 1: Add the failing test**

In `src/server/orchestrator/continueEligibility.test.ts`, add:

```ts
it('rejects runs already in starting state (double-click guard)', () => {
  const run = makeRun({ state: 'starting', claude_session_id: 'abc' });
  const verdict = checkContinueEligibility(run, runsDir);
  expect(verdict).toEqual({
    ok: false,
    code: 'wrong_state',
    message: 'run is starting; only terminated runs can be continued',
  });
});
```

(Use whatever `makeRun` helper the existing tests use; check the file for the pattern.)

- [ ] **Step 2: Run the test, watch it fail**

Run: `npx vitest run src/server/orchestrator/continueEligibility.test.ts`
Expected: FAIL — current code returns `ok: true` because `starting` doesn't match the rejected list, but actually the existing check is whitelist (`failed`/`cancelled`/`succeeded`), so it WILL return `wrong_state`. Verify the failure message matches expectations; if the test passes already, skip the implementation step.

- [ ] **Step 3: Confirm or fix**

Re-read `src/server/orchestrator/continueEligibility.ts:17-23`:

```ts
if (run.state !== 'failed' && run.state !== 'cancelled' && run.state !== 'succeeded') {
  return {
    ok: false,
    code: 'wrong_state',
    message: `run is ${run.state}; only terminated runs can be continued`,
  };
}
```

This is a whitelist — `starting` is already rejected, no code change needed. The test from Step 1 should already pass.

- [ ] **Step 4: Commit (test only, if no code change)**

```bash
git add src/server/orchestrator/continueEligibility.test.ts
git commit -m "test: assert checkContinueEligibility rejects 'starting' state"
```

---

## Task 11: Surface `starting` in `RunHeader`

**Files:**
- Modify: `src/web/features/runs/RunHeader.tsx:9-12`, `28-31`, `110-117`

- [ ] **Step 1: Add `'starting'` to the TONE map**

In `src/web/features/runs/RunHeader.tsx`, replace lines 9–12:

```tsx
const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', starting: 'run', running: 'run', waiting: 'attn', awaiting_resume: 'warn',
  succeeded: 'ok', failed: 'fail', cancelled: 'wait',
};
```

(The `'run'` Pill tone already has `animate-pulse` and the right colors. Reusing it for `'starting'` keeps the design tokens aligned.)

- [ ] **Step 2: Exclude `starting` from `canContinue` and the followup gate**

Replace lines 28–31:

```tsx
const canFollowUp =
  run.state !== 'running' && run.state !== 'waiting' && run.state !== 'queued' &&
  run.state !== 'starting' && run.state !== 'awaiting_resume' && !!run.branch_name;
const canContinue = run.state === 'failed' || run.state === 'cancelled' || run.state === 'succeeded';
const continueDisabled = !run.claude_session_id;
```

(`canContinue` is already a whitelist of terminal states, so `'starting'` is already excluded — no change needed there.)

- [ ] **Step 3: Make Cancel button visible during `starting` too**

Replace line 110:

```tsx
{(run.state === 'running' || run.state === 'waiting' || run.state === 'awaiting_resume' || run.state === 'starting') && (
  <Button variant="danger" size="sm" onClick={onCancel}>Cancel</Button>
)}
```

And line 117 (the Delete menu item's `disabled`):

```tsx
disabled: run.state === 'running' || run.state === 'waiting' || run.state === 'awaiting_resume' || run.state === 'starting',
```

- [ ] **Step 4: Run the type check on the web project**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: errors in remaining frontend files that exhaustively switch on `RunState`. We address each in Tasks 12–15.

- [ ] **Step 5: Commit**

```bash
git add src/web/features/runs/RunHeader.tsx
git commit -m "web(RunHeader): render 'starting' state with pulsing run-tone pill"
```

---

## Task 12: Surface `starting` in `RunRow` and `RunsList`

**Files:**
- Modify: `src/web/features/runs/RunRow.tsx:11-19`
- Modify: `src/web/features/runs/RunsList.tsx:16-24`, `42-49`, `78`

- [ ] **Step 1: `RunRow` TONE map**

In `src/web/features/runs/RunRow.tsx`, replace lines 11–19:

```tsx
const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait',
  starting: 'run',
  running: 'run',
  waiting: 'attn',
  awaiting_resume: 'warn',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'wait',
};
```

- [ ] **Step 2: `RunsList` TONE_TEXT map**

In `src/web/features/runs/RunsList.tsx`, replace lines 16–24:

```tsx
const TONE_TEXT: Record<RunState, string> = {
  starting: 'text-run',
  running: 'text-run',
  waiting: 'text-attn',
  awaiting_resume: 'text-warn',
  queued: 'text-text-faint',
  succeeded: 'text-ok',
  failed: 'text-fail',
  cancelled: 'text-text-faint',
};
```

- [ ] **Step 3: `RunsList` counts**

In `src/web/features/runs/RunsList.tsx`, replace lines 42–49:

```tsx
const counts: StateCounts = useMemo(() => {
  const base: StateCounts = {
    starting: 0, running: 0, waiting: 0, awaiting_resume: 0, queued: 0,
    succeeded: 0, failed: 0, cancelled: 0,
  };
  for (const r of textFiltered) base[r.state]++;
  return base;
}, [textFiltered]);
```

And in line 78, fold `starting` into the running count for the header:

```tsx
const running = runs.filter((r) => r.state === 'running' || r.state === 'starting').length;
```

- [ ] **Step 4: Run the web type check**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: errors only in `StateFilterButton`, `useRunsView`, `ProjectList` (Tasks 13–14).

- [ ] **Step 5: Commit**

```bash
git add src/web/features/runs/RunRow.tsx src/web/features/runs/RunsList.tsx
git commit -m "web(RunsList): include 'starting' in state tones and active count"
```

---

## Task 13: Surface `starting` in the state filter and view model

**Files:**
- Modify: `src/web/features/runs/StateFilterButton.tsx:8-26`
- Modify: `src/web/features/runs/useRunsView.ts:6-10`

- [ ] **Step 1: Add `starting` to the filter `ORDER` and `DOT_TONE`**

In `src/web/features/runs/StateFilterButton.tsx`, replace lines 8–26:

```tsx
const ORDER: readonly { state: RunState; label: string }[] = [
  { state: 'starting',        label: 'starting'  },
  { state: 'running',         label: 'running'   },
  { state: 'waiting',         label: 'waiting'   },
  { state: 'awaiting_resume', label: 'awaiting'  },
  { state: 'queued',          label: 'queued'    },
  { state: 'succeeded',       label: 'succeeded' },
  { state: 'failed',          label: 'failed'    },
  { state: 'cancelled',       label: 'cancelled' },
];

const DOT_TONE: Record<RunState, string> = {
  starting:        'bg-run',
  running:         'bg-run',
  waiting:         'bg-attn',
  awaiting_resume: 'bg-warn',
  queued:          'bg-text-faint',
  succeeded:       'bg-ok',
  failed:          'bg-fail',
  cancelled:       'bg-text-faint',
};
```

- [ ] **Step 2: Add `starting` to view sets**

In `src/web/features/runs/useRunsView.ts`, replace lines 6–10:

```ts
const ALL_STATES: readonly RunState[] = [
  'starting', 'running', 'waiting', 'awaiting_resume', 'queued', 'succeeded', 'failed', 'cancelled',
];

const ACTIVE_STATES = new Set<RunState>(['starting', 'running', 'waiting', 'awaiting_resume', 'queued']);
```

- [ ] **Step 3: Run the web type check**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: errors only in `ProjectList` (Task 14).

- [ ] **Step 4: Run the existing related tests**

Run: `npx vitest run src/web/features/runs/StateFilterButton.test.tsx src/web/features/runs/RunsList.test.tsx`
Expected: PASS, or one or two assertions that need an updated `counts` literal — fix to include `starting: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/web/features/runs/StateFilterButton.tsx src/web/features/runs/useRunsView.ts src/web/features/runs/*.test.tsx
git commit -m "web(filter+view): include 'starting' in filter, dots, and active group"
```

---

## Task 14: Surface `starting` in `ProjectList` sidebar dot

**Files:**
- Modify: `src/web/features/projects/ProjectList.tsx:16-17`

- [ ] **Step 1: Inspect the surrounding logic**

Open `src/web/features/projects/ProjectList.tsx` and read lines 1–40 to understand how `hasRunning`/`hasWaiting` drive the project's status dot.

- [ ] **Step 2: Treat `starting` as `running` for the dot**

In `src/web/features/projects/ProjectList.tsx`, replace lines 16–17:

```tsx
const hasRunning = runs.some((r) => r.project_id === p.id && (r.state === 'running' || r.state === 'starting'));
const hasWaiting = runs.some((r) => r.project_id === p.id && r.state === 'waiting');
```

- [ ] **Step 3: Run the web type check end-to-end**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: zero errors.

- [ ] **Step 4: Run the project list tests**

Run: `npx vitest run src/web/features/projects/ProjectList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/features/projects/ProjectList.tsx
git commit -m "web(ProjectList): include 'starting' in active-dot logic"
```

---

## Task 15: Update the Design showcase

**Files:**
- Modify: `src/web/pages/Design.tsx:54-59`

- [ ] **Step 1: Add the `starting` Pill example**

In `src/web/pages/Design.tsx`, locate the Pills section (around lines 54–59) and add a `starting` example between `succeeded` and `running` (or wherever group ordering puts it):

```tsx
<Pill tone="ok">succeeded</Pill>
<Pill tone="run">starting</Pill>
<Pill tone="run">running</Pill>
<Pill tone="attn">waiting</Pill>
<Pill tone="fail">failed</Pill>
<Pill tone="warn">cancelled</Pill>
<Pill tone="wait">queued</Pill>
```

- [ ] **Step 2: Verify it builds and renders**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/pages/Design.tsx
git commit -m "web(design): add 'starting' Pill example to showcase"
```

---

## Task 16: Run the full test suite

- [ ] **Step 1: Run everything**

Run: `npm run test`
Expected: PASS. Investigate any failure — most likely a test fixture that hardcoded a `RunState` literal record without `starting`.

- [ ] **Step 2: Run the type check across all configs**

Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`
Expected: zero errors across all four configs.

- [ ] **Step 3: Commit any test-fixture fixes**

```bash
git add -A
git commit -m "test: cover 'starting' in remaining state-record fixtures"
```

(Skip if no changes were needed.)

---

## Task 17: Manual verification with Playwright

**Goal:** Verify the user-visible behavior matches the spec — Continue button click flips the pill to "starting" immediately, button hides during the gap, and the pill transitions correctly to "waiting" once Claude is ready.

- [ ] **Step 1: Start the dev server**

Run: `scripts/dev.sh` in a background shell.

- [ ] **Step 2: Set up a test scenario**

Open the app in the browser (Playwright MCP). Find a finished run that has a `claude_session_id` (look for one in `succeeded` state from a recent project). If none exists, run a quick one-prompt new run, wait for it to complete, then use it.

- [ ] **Step 3: Verify the synchronous flip**

Navigate to the run's detail page. Click the **Continue** button. Within ~100 ms:
- The pill should change from `succeeded` (green) to `starting` (pulsing).
- The Continue button should disappear.
- The Cancel button should appear.

If the pill stays on `succeeded` for more than ~100 ms, the synchronous flip in the API endpoint isn't taking effect — check Task 9.

- [ ] **Step 4: Verify the transition to waiting**

Wait for the container to start and Claude to resume (typically 3–8 seconds). The pill should transition `starting` -> `waiting` (orange/attn, pulsing) once Claude hits the prompt. Continue does NOT pipe a prompt into Claude, so it should land directly at `waiting`, not `running`.

- [ ] **Step 5: Verify double-click protection**

Trigger another Continue (re-enter the run via URL or fresh-load). Quickly click Continue, then click again. The second click should land while the run is in `starting` — server should respond `409` for the second click. Check the network tab.

- [ ] **Step 6: Verify fresh-run path**

Start a brand-new run with a short prompt (e.g., "say hello and exit"). Watch the pill on the runs list:
- queued (gray) -> starting (pulsing) -> running (pulsing) -> waiting (orange) or succeeded (green).

The `starting` -> `running` transition should fire as soon as Claude reads the prompt (UserPromptSubmit -> `prompted` sentinel).

- [ ] **Step 7: Note any UI rough edges**

If the `starting` pill flickers between values, sticks too long, or the button states are wrong, file the observations and fix in a follow-up task. Don't claim success on visual issues that aren't actually working.

- [ ] **Step 8: Stop the dev server and commit any final fixes**

```bash
git add -A
git status
# Commit only if there are actual fixes from manual testing
```

---

## Notes / Risks

- The test for `RuntimeStateWatcher` uses real `setTimeout`s and filesystem reads. If they're flaky in CI, switch to fake timers — but for a 500ms poll with 50ms waits, real timers are usually fine.
- `markStartingForContinueRequest` is called by the API before any container exists. The orchestrator's later `markStartingContainer` call has guard `state='starting'` so it must run after — which it does, because `continueRun` is fire-and-forget after the API returns.
- For an in-flight container started by an older binary (no `prompted` sentinel hook), the watcher's first poll will derive `starting` even though Claude is alive. The DB guards prevent state regression: `markRunning` only fires if state is `'starting'` or `'waiting'`, and the persisted DB state from before the upgrade is `'running'` or `'waiting'`, so the watcher's `'starting'` derivation is silently absorbed (no DB write happens until the next legitimate transition). Verified in Task 8 step 4.
