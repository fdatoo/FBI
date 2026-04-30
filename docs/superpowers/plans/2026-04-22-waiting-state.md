# Waiting-state Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `waiting` run state that fires when Claude is idle at its TUI input prompt and returns to `running` on the next jsonl write, surfaced in the status bar, sidebar dot, run pill, and notifications.

**Architecture:** A new `WaitingMonitor` — structurally parallel to the existing `LimitMonitor` — runs alongside each container, fuses mount-dir idleness with a TTY-prompt regex, and drives `RunsRepo.markWaiting` / `markRunningFromWaiting`. A new global state channel on the web API feeds a refactored `useRunWatcher` that dispatches OS notifications on every state transition without polling.

**Tech Stack:** TypeScript, Fastify + `@fastify/websocket`, better-sqlite3, Vitest (+ happy-dom for web), React 18, Tailwind.

**Spec:** `docs/superpowers/specs/2026-04-22-waiting-state-design.md`

**Two scope reductions vs. spec:**
- `RunsFilter.tsx` is a plain text input today, with no state chips. The spec's "add waiting filter chip" bullet has nothing to extend — skipped per YAGNI. If state filter chips land later, add `waiting` then.
- `__fixtures__/claude-tui-prompt.bin` is deferred to post-Task 18. The regex in `waitingPrompt.ts` is validated against synthetic ANSI in Task 4's unit tests; real-capture fixtures are captured only if Task 18's manual verification exposes a regex miss.

---

## Task 1: Add `'waiting'` to `RunState`

**Files:**
- Modify: `src/shared/types.ts:1-7`

- [ ] **Step 1: Update the union**

Replace lines 1–7 of `src/shared/types.ts`:

```ts
export type RunState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'awaiting_resume'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
```

- [ ] **Step 2: Typecheck to find the exhaustiveness holes**

Run: `npm run typecheck`
Expected: failures in `RunRow.tsx`, `RunHeader.tsx` (both have `Record<Run['state'], PillTone>` maps) and nowhere else. Server compiles clean — only the tone maps care about the value set. **Do not fix the web maps yet** — Task 13 handles them; this step is purely to confirm the blast radius is what the spec predicts.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add 'waiting' to RunState"
```

---

## Task 2: Repo methods for `waiting` transitions

**Files:**
- Modify: `src/server/db/runs.ts:97-133`
- Test: `src/server/db/runs.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/server/db/runs.test.ts`:

```ts
describe('waiting-state transitions', () => {
  it('markWaiting flips running → waiting', () => {
    const { repo, id } = seedRunning();
    repo.markWaiting(id);
    expect(repo.get(id)!.state).toBe('waiting');
  });

  it('markWaiting is a no-op from non-running states', () => {
    const { repo, id } = seedQueued();
    repo.markWaiting(id);
    expect(repo.get(id)!.state).toBe('queued');
  });

  it('markRunningFromWaiting flips waiting → running', () => {
    const { repo, id } = seedRunning();
    repo.markWaiting(id);
    repo.markRunningFromWaiting(id);
    expect(repo.get(id)!.state).toBe('running');
  });

  it('markRunningFromWaiting is a no-op from non-waiting states', () => {
    const { repo, id } = seedRunning();
    repo.markRunningFromWaiting(id);
    expect(repo.get(id)!.state).toBe('running');
  });

  it('markAwaitingResume wins from waiting (rate-limit supersedes)', () => {
    const { repo, id } = seedRunning();
    repo.markWaiting(id);
    repo.markAwaitingResume(id, { next_resume_at: 42, last_limit_reset_at: 42 });
    expect(repo.get(id)!.state).toBe('awaiting_resume');
  });

  it('markWaiting + markRunningFromWaiting are idempotent', () => {
    const { repo, id } = seedRunning();
    repo.markWaiting(id);
    repo.markWaiting(id);
    expect(repo.get(id)!.state).toBe('waiting');
    repo.markRunningFromWaiting(id);
    repo.markRunningFromWaiting(id);
    expect(repo.get(id)!.state).toBe('running');
  });
});
```

Where `seedRunning` / `seedQueued` follow the same setup pattern the file already uses (open in-memory DB, insert a project, `repo.create(...)`, then `repo.markStarted(id, 'c1')` for running). Read the top of `runs.test.ts` to reuse the existing helpers; do **not** invent a parallel harness.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: new tests fail with `repo.markWaiting is not a function`.

- [ ] **Step 3: Implement the repo methods**

In `src/server/db/runs.ts`, insert after `markContinuing` (around line 150):

```ts
markWaiting(id: number): void {
  this.db
    .prepare(`UPDATE runs SET state='waiting' WHERE id=? AND state='running'`)
    .run(id);
}

markRunningFromWaiting(id: number): void {
  this.db
    .prepare(`UPDATE runs SET state='running' WHERE id=? AND state='waiting'`)
    .run(id);
}
```

And tighten the existing `markAwaitingResume` (around line 105–120) by appending a state guard to its WHERE clause so it only fires from an active live state (accepting both `running` and `waiting`):

```ts
markAwaitingResume(
  id: number,
  p: { next_resume_at: number; last_limit_reset_at: number | null },
): void {
  this.db
    .prepare(
      `UPDATE runs
          SET state='awaiting_resume',
              container_id=NULL,
              next_resume_at=?,
              last_limit_reset_at=?,
              resume_attempts = resume_attempts + 1
        WHERE id=? AND state IN ('running','waiting')`,
    )
    .run(p.next_resume_at, p.last_limit_reset_at, id);
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test -- src/server/db/runs.test.ts`
Expected: all green, including the new ones.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/runs.ts src/server/db/runs.test.ts
git commit -m "feat(db): markWaiting / markRunningFromWaiting + guarded markAwaitingResume"
```

---

## Task 3: Extract `sumJsonlSizes` into `mountActivity.ts`

**Files:**
- Create: `src/server/orchestrator/mountActivity.ts`
- Modify: `src/server/orchestrator/limitMonitor.ts:1-3, 104-123`
- Test: `src/server/orchestrator/mountActivity.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/server/orchestrator/mountActivity.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sumJsonlSizes } from './mountActivity.js';

describe('sumJsonlSizes', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-mount-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('returns 0 for an empty dir', () => {
    expect(sumJsonlSizes(dir)).toBe(0);
  });

  it('sums .jsonl file sizes across nested dirs', () => {
    fs.writeFileSync(path.join(dir, 'a.jsonl'), 'x'.repeat(10));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'b.jsonl'), 'y'.repeat(7));
    fs.writeFileSync(path.join(dir, 'nested', 'ignore.txt'), 'z'.repeat(5));
    expect(sumJsonlSizes(dir)).toBe(17);
  });

  it('returns 0 when the dir does not exist', () => {
    expect(sumJsonlSizes(path.join(dir, 'missing'))).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- src/server/orchestrator/mountActivity.test.ts`
Expected: `Cannot find module './mountActivity.js'`.

- [ ] **Step 3: Create the module**

Create `src/server/orchestrator/mountActivity.ts` with the exact body currently in `limitMonitor.ts:110-123`:

```ts
import fs from 'node:fs';
import path from 'node:path';

export function sumJsonlSizes(root: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return 0; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) { total += sumJsonlSizes(full); continue; }
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { total += fs.statSync(full).size; } catch { /* missing */ }
    }
  }
  return total;
}
```

- [ ] **Step 4: Update `limitMonitor.ts` to use the shared helper**

In `src/server/orchestrator/limitMonitor.ts`:
- Add `import { sumJsonlSizes } from './mountActivity.js';` at the top.
- Remove the `fs` and `path` imports (they're no longer used there).
- Delete the in-file `sumJsonlSizes` at lines 110–123.

- [ ] **Step 5: Run all orchestrator tests**

Run: `npm test -- src/server/orchestrator`
Expected: all green (existing LimitMonitor tests still pass; new mountActivity tests pass).

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/mountActivity.ts src/server/orchestrator/mountActivity.test.ts src/server/orchestrator/limitMonitor.ts
git commit -m "refactor(orchestrator): extract sumJsonlSizes into mountActivity"
```

---

## Task 4: `containsWaitingPrompt` helper

**Files:**
- Create: `src/server/orchestrator/waitingPrompt.ts`
- Test: `src/server/orchestrator/waitingPrompt.test.ts`

This is the regex heuristic, isolated so the WaitingMonitor test can stay focused on timing.

- [ ] **Step 1: Write failing test**

Create `src/server/orchestrator/waitingPrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { containsWaitingPrompt } from './waitingPrompt.js';

describe('containsWaitingPrompt', () => {
  it('matches a bordered TUI prompt at tail', () => {
    const s = 'some earlier output\n│ > ';
    expect(containsWaitingPrompt(s)).toBe(true);
  });

  it('matches a plain "> " prompt line at tail', () => {
    const s = 'some earlier output\n> ';
    expect(containsWaitingPrompt(s)).toBe(true);
  });

  it('does not match when the line has text after the prompt', () => {
    const s = 'some earlier output\n> typed this much';
    expect(containsWaitingPrompt(s)).toBe(false);
  });

  it('does not match a mid-turn transcript line that contains ">"', () => {
    const s = 'I found that 3 > 2 is true, proceeding with the plan\n';
    expect(containsWaitingPrompt(s)).toBe(false);
  });

  it('tolerates trailing whitespace / newlines after the prompt', () => {
    const s = 'some earlier output\n│ > \n\n   ';
    expect(containsWaitingPrompt(s)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- src/server/orchestrator/waitingPrompt.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

Create `src/server/orchestrator/waitingPrompt.ts`:

```ts
// Claude Code's TUI input prompt, rendered once the assistant has finished its
// turn, presents a line that (after ANSI stripping and trimming trailing
// whitespace) ends with "> " — either bare or inside the box border.
//
// We only match when there is nothing after the prompt marker on that line,
// so mid-turn output that happens to contain ">" (e.g. "3 > 2") never matches.
const WAITING_PROMPT_RES: ReadonlyArray<RegExp> = [
  /(^|\n)[ \t]*[│|][ \t]*>[ \t]*$/,
  /(^|\n)[ \t]*>[ \t]*$/,
];

export function containsWaitingPrompt(stripped: string): boolean {
  const trimmed = stripped.replace(/[\s⠀]+$/u, '');
  return WAITING_PROMPT_RES.some((re) => re.test(trimmed));
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/server/orchestrator/waitingPrompt.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/waitingPrompt.ts src/server/orchestrator/waitingPrompt.test.ts
git commit -m "feat(orchestrator): containsWaitingPrompt helper"
```

---

## Task 5: `WaitingMonitor` class

**Files:**
- Create: `src/server/orchestrator/waitingMonitor.ts`
- Test: `src/server/orchestrator/waitingMonitor.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/orchestrator/waitingMonitor.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WaitingMonitor } from './waitingMonitor.js';

const PROMPT_BYTES = Buffer.from('\x1b[2m│\x1b[0m \x1b[1m> \x1b[0m');

describe('WaitingMonitor', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-wait-mon-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  const touch = (bytes = 100) => {
    fs.appendFileSync(path.join(dir, 'session.jsonl'), 'x'.repeat(bytes));
  };

  it('does not fire before warmup, even when idle + prompt match', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);
    time = 10_000;
    mon.checkNow();
    expect(entered).toBe(0);
    mon.stop();
  });

  it('fires onEnter once both signals hold past warmup', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);
    time = 30_000;                // past warmup AND past idleMs of silence
    mon.checkNow();
    expect(entered).toBe(1);
    mon.checkNow();               // stays entered; no duplicate onEnter
    expect(entered).toBe(1);
    mon.stop();
  });

  it('does not fire when the TTY tail has no prompt', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(Buffer.from('reading file foo.ts...\n'));
    time = 30_000;
    mon.checkNow();
    expect(entered).toBe(0);
    mon.stop();
  });

  it('does not fire when mount-dir is still active', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);
    time = 25_000;
    touch();                      // fresh write: mount dir still active
    mon.checkNow();
    expect(entered).toBe(0);
    mon.stop();
  });

  it('fires onExit on the first jsonl write after entering', () => {
    let time = 0;
    let entered = 0, exited = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => { exited++; },
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);
    time = 30_000;
    mon.checkNow();
    expect(entered).toBe(1);

    time = 32_000;
    touch();                      // user typed; Claude is working again
    mon.checkNow();
    expect(exited).toBe(1);
    mon.stop();
  });

  it('toggles multiple times across a single lifetime', () => {
    let time = 0;
    let entered = 0, exited = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => { exited++; },
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(PROMPT_BYTES);

    time = 30_000; mon.checkNow();
    expect(entered).toBe(1);

    time = 32_000; touch(); mon.checkNow();
    expect(exited).toBe(1);

    // Second idle period — requires idleMs of silence again.
    time = 45_000; mon.feedLog(PROMPT_BYTES); mon.checkNow();
    expect(entered).toBe(2);

    mon.stop();
  });

  it('feedLog tolerates ANSI escapes in the prompt frame', () => {
    let time = 0;
    let entered = 0;
    const mon = new WaitingMonitor({
      mountDir: dir,
      warmupMs: 20_000, idleMs: 8_000, checkMs: 2_000,
      onEnter: () => { entered++; }, onExit: () => {},
      now: () => time,
    });
    touch();
    mon.start();
    mon.feedLog(Buffer.from('\x1b[K\x1b[2J\x1b[H\x1b[2m│\x1b[0m \x1b[1m> \x1b[0m'));
    time = 30_000; mon.checkNow();
    expect(entered).toBe(1);
    mon.stop();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- src/server/orchestrator/waitingMonitor.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement the monitor**

Create `src/server/orchestrator/waitingMonitor.ts`:

```ts
import { stripAnsi } from './resumeDetector.js';
import { sumJsonlSizes } from './mountActivity.js';
import { containsWaitingPrompt } from './waitingPrompt.js';

export interface WaitingMonitorOptions {
  /** Dir to watch for Claude Code's session JSONL writes (activity signal). */
  mountDir: string;
  /** Rolling ANSI-stripped TTY buffer size, in bytes. */
  logBufferBytes?: number;
  /** Required idle time on mount dir before declaring waiting. */
  idleMs?: number;
  /** Absolute warmup after start() before firing is allowed. */
  warmupMs?: number;
  /** Check cadence. */
  checkMs?: number;
  onEnter: () => void;
  onExit: () => void;
  now?: () => number;
}

/**
 * Watches the container's TTY stream + Claude's session JSONL activity to
 * detect when the run has idled at the TUI input prompt (→ onEnter), and
 * when it resumes work (→ onExit). Fused two-signal design mirrors
 * LimitMonitor so the same mental model applies to both detectors.
 */
export class WaitingMonitor {
  private buf = '';
  private startedAt = 0;
  private lastActivityAt = 0;
  private lastTotalSize = 0;
  private inWaiting = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly logBufferBytes: number;
  private readonly idleMs: number;
  private readonly warmupMs: number;
  private readonly checkMs: number;
  private readonly now: () => number;

  constructor(private opts: WaitingMonitorOptions) {
    this.logBufferBytes = opts.logBufferBytes ?? 16 * 1024;
    this.idleMs = opts.idleMs ?? 8_000;
    this.warmupMs = opts.warmupMs ?? 20_000;
    this.checkMs = opts.checkMs ?? 2_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    this.lastTotalSize = sumJsonlSizes(this.opts.mountDir);
    const tick = () => {
      if (!this.timer) return;
      try { this.check(); } catch { /* best-effort */ }
      this.timer = setTimeout(tick, this.checkMs);
    };
    this.timer = setTimeout(tick, this.checkMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  feedLog(chunk: Uint8Array): void {
    const text = Buffer.from(chunk).toString('utf8');
    const stripped = stripAnsi(text);
    if (stripped.length === 0) return;
    this.buf = (this.buf + stripped).slice(-this.logBufferBytes);
  }

  checkNow(): void { this.check(); }

  private check(): void {
    const now = this.now();
    const size = sumJsonlSizes(this.opts.mountDir);
    const grew = size > this.lastTotalSize;
    if (grew) {
      this.lastActivityAt = now;
      this.lastTotalSize = size;
      if (this.inWaiting) {
        this.inWaiting = false;
        this.opts.onExit();
      }
      return;
    }

    if (this.inWaiting) return;                       // already waiting; nothing to do
    if (now - this.startedAt < this.warmupMs) return;
    if (now - this.lastActivityAt < this.idleMs) return;
    if (!containsWaitingPrompt(this.buf)) return;

    this.inWaiting = true;
    this.opts.onEnter();
  }
}
```

- [ ] **Step 4: Run tests to pass**

Run: `npm test -- src/server/orchestrator/waitingMonitor.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/waitingMonitor.ts src/server/orchestrator/waitingMonitor.test.ts
git commit -m "feat(orchestrator): WaitingMonitor two-signal detector"
```

---

## Task 6: Wire `WaitingMonitor` into `launch`

**Files:**
- Modify: `src/server/orchestrator/index.ts:29-31, 227-293, 549-566`

- [ ] **Step 1: Import the class**

At top of `src/server/orchestrator/index.ts`, near the existing `LimitMonitor` import:

```ts
import { WaitingMonitor } from './waitingMonitor.js';
```

- [ ] **Step 2: Add the factory**

Directly after `makeLimitMonitor` (around line 566), add:

```ts
private makeWaitingMonitor(
  runId: number,
  onBytes: (chunk: Uint8Array) => void,
): WaitingMonitor {
  return new WaitingMonitor({
    mountDir: this.mountDirFor(runId),
    onEnter: () => {
      this.deps.runs.markWaiting(runId);
      this.publishState(runId);
      onBytes(Buffer.from('\n[fbi] waiting for user input\n'));
    },
    onExit: () => {
      this.deps.runs.markRunningFromWaiting(runId);
      this.publishState(runId);
      onBytes(Buffer.from('\n[fbi] user responded; resuming\n'));
    },
  });
}
```

- [ ] **Step 3: Wire into `launch`**

In `launch` (around line 227):
- Declare a waiting monitor alongside the limit monitor: `let waitingMonitor: WaitingMonitor | null = null;`
- Right after `limitMonitor = this.makeLimitMonitor(...)` (~line 255), add: `waitingMonitor = this.makeWaitingMonitor(runId, onBytes);`
- In the `attach.on('data', ...)` handler at line 256, also call `waitingMonitor!.feedLog(c);` after `limitMonitor!.feedLog(c);`.
- After `limitMonitor.start();` (~line 258) add: `waitingMonitor.start();`
- In the `finally { if (tailer) ...; if (limitMonitor) limitMonitor.stop(); }` block (~line 291), add `if (waitingMonitor) waitingMonitor.stop();`.

- [ ] **Step 4: Typecheck + run orchestrator tests**

Run: `npm run typecheck && npm test -- src/server/orchestrator`
Expected: typecheck clean; all orchestrator tests pass (no new behavior asserted yet — integration tests live in Task 9).

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): wire WaitingMonitor into launch"
```

---

## Task 7: Wire `WaitingMonitor` into `resume` and `continueRun`

**Files:**
- Modify: `src/server/orchestrator/index.ts:403-476, 481-537`

- [ ] **Step 1: `resume` path**

Locate the resume implementation (search for `async resume(` starting at line ~403). Apply the same five-point wiring as Task 6:
1. Declare `let waitingMonitor: WaitingMonitor | null = null;`
2. After `limitMonitor = this.makeLimitMonitor(...)`, `waitingMonitor = this.makeWaitingMonitor(runId, onBytes);`
3. Extend the `attach.on('data')` handler to call `waitingMonitor!.feedLog(c)`.
4. After `limitMonitor.start()`, `waitingMonitor.start()`.
5. In the matching `finally` block, `if (waitingMonitor) waitingMonitor.stop();`.

- [ ] **Step 2: `continueRun` path**

Same five-point wiring in `continueRun` (~line 481). `continueRun` already constructs `limitMonitor` directly inline (see `index.ts:515-527`) — mirror that inline construction: declare `waitingMonitor` next to `limitMonitor`, feed it in `attach.on('data')`, start it after the limit monitor, and stop it in the matching `finally`.

- [ ] **Step 3: Typecheck + run all tests**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): wire WaitingMonitor into resume + continueRun"
```

---

## Task 8: Extend `cancel` and `recover` for `waiting`

**Files:**
- Modify: `src/server/orchestrator/index.ts:588-630, 629-665`

- [ ] **Step 1: `cancel` — verify, no change needed**

Read `cancel()` at `src/server/orchestrator/index.ts:588-607`. The live-container branch (the one after the `awaiting_resume` early-return) gates on `active.get(runId)` existence, **not** on `run.state`, so cancelling from `'waiting'` already works: `container.stop()` fires, the `await container.wait()` in `awaitAndComplete` resolves, and the run is marked `'cancelled'` as normal. Confirm by reading the code; make no change.

- [ ] **Step 2: `recover`**

In `recover` (~line 629–665), the loop today iterates `this.deps.runs.listByState('running')`. Replace with a loop over both states:

```ts
const live = [
  ...this.deps.runs.listByState('running'),
  ...this.deps.runs.listByState('waiting'),
];
for (const run of live) {
  /* existing body */
}
```

`reattach` doesn't know about `WaitingMonitor` yet; we need to construct one there too. Locate `reattach` (called from `recover`) and apply the same wiring from Task 6 — declare, attach-feed, start, stop-in-finally.

- [ ] **Step 3: Typecheck + run all tests**

Run: `npm run typecheck && npm test -- src/server/orchestrator`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): handle 'waiting' in cancel + recover"
```

---

## Task 9: Orchestrator flow test — rate-limit wins from `waiting`

**Files:**
- Create: `src/server/orchestrator/waiting.flow.test.ts`

Style reference: `src/server/orchestrator/autoResume.flow.test.ts` (178 lines; uses real sqlite + stubbed docker).

- [ ] **Step 1: Write the failing test**

Create `src/server/orchestrator/waiting.flow.test.ts` using the same harness shape as `autoResume.flow.test.ts`. Test cases:

1. After `markWaiting(id)`, an immediate `markAwaitingResume(id, {...})` transitions the run to `'awaiting_resume'` (repo-level test, no docker — belongs here to co-locate the waiting-state flow invariants, but can reuse the repo harness from Task 2).
2. `recover()` over a DB run in state `'waiting'` with a container_id that exists reattaches (stubbed docker) and constructs fresh LimitMonitor + WaitingMonitor. Assert both monitors are `.start()`ed — verify by injecting spies, or (simpler) by asserting the timer count / the fact that a subsequent `nudgeClaudeToExit` fires when the stub feeds a rate-limit blob. If the existing `autoResume.flow.test.ts` harness doesn't expose a way to feed bytes, write the smaller test that simply asserts `recover` doesn't throw and the run stays in `'waiting'` in the DB (state is re-derived on next monitor tick, which the test won't drive without a real container).

Pick the subset of assertions you can make with the existing harness; do **not** invent new docker stubbing infra beyond what `autoResume.flow.test.ts` already uses.

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- src/server/orchestrator/waiting.flow.test.ts`

- [ ] **Step 3: Implementation is already in Tasks 2 + 6–8**

Expected outcome: the repo transition test passes on existing code (Task 2 already implemented this). The `recover` test passes once Task 8's `listByState('waiting')` inclusion is in place. If either fails, fix in-place.

- [ ] **Step 4: Commit**

```bash
git add src/server/orchestrator/waiting.flow.test.ts
git commit -m "test(orchestrator): waiting → awaiting_resume + recover over waiting"
```

---

## Task 10: Global state channel — server side

**Files:**
- Modify: `src/server/logs/registry.ts:1-44`
- Modify: `src/server/orchestrator/index.ts:112-122`
- Modify: `src/server/api/ws.ts:1-124`
- Test: `src/server/logs/registry.test.ts`, `src/server/api/ws.test.ts`

- [ ] **Step 1: Define the global state frame type**

In `src/shared/types.ts`, add after the existing `RunWsStateMessage`:

```ts
export interface GlobalStateMessage {
  type: 'state';
  run_id: number;
  project_id: number;
  state: RunState;
  next_resume_at: number | null;
  resume_attempts: number;
  last_limit_reset_at: number | null;
}
```

- [ ] **Step 2: Add `getGlobalStates()` to the registry**

In `src/server/logs/registry.ts`:

```ts
import type { GlobalStateMessage } from '../../shared/types.js';
// ... existing imports ...

export class RunStreamRegistry {
  // ... existing fields ...
  private globalStates = new TypedBroadcaster<GlobalStateMessage>();

  getGlobalStates(): TypedBroadcaster<GlobalStateMessage> {
    return this.globalStates;
  }
  // ... existing methods ...
}
```

- [ ] **Step 3: Publish from `Orchestrator.publishState`**

In `src/server/orchestrator/index.ts` at `publishState` (line 112–122):

```ts
private publishState(runId: number): void {
  const run = this.deps.runs.get(runId);
  if (!run) return;
  const frame = {
    type: 'state' as const,
    state: run.state,
    next_resume_at: run.next_resume_at,
    resume_attempts: run.resume_attempts,
    last_limit_reset_at: run.last_limit_reset_at,
  };
  this.deps.streams.getOrCreateState(runId).publish(frame);
  this.deps.streams.getGlobalStates().publish({
    ...frame,
    run_id: runId,
    project_id: run.project_id,
  });
}
```

- [ ] **Step 4: New WS route `/api/ws/states`**

Append a second route handler to `src/server/api/ws.ts`:

```ts
app.get('/api/ws/states', { websocket: true }, (socket: WebSocket) => {
  const unsub = deps.streams.getGlobalStates().subscribe((frame) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  });
  socket.on('close', () => { unsub(); });
});
```

- [ ] **Step 5: Write minimal WS integration test**

Extend `src/server/api/ws.test.ts` (or create it if missing) with a test that opens `/api/ws/states`, has the orchestrator-stub call `publishState`, and asserts the client receives one JSON frame per transition. Follow the existing ws.test.ts patterns — do NOT invent a new harness.

- [ ] **Step 6: Run tests**

Run: `npm test -- src/server/logs src/server/api/ws.test.ts src/server/orchestrator`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/server/logs/registry.ts src/server/orchestrator/index.ts src/server/api/ws.ts src/server/api/ws.test.ts
git commit -m "feat(api): global state channel /api/ws/states"
```

---

## Task 11: UI tokens — `--attn`

**Files:**
- Modify: `src/web/ui/tokens.css`

- [ ] **Step 1: Add the tokens**

In `src/web/ui/tokens.css`, alongside the other tone tokens (both palettes):

```css
/* dark palette — near --warn block, around line 23 */
--attn: #fbbf24;
--attn-subtle: #2a1c07;

/* light palette — near --warn block, around line 89 */
--attn: #b45309;
--attn-subtle: #fffbeb;
```

- [ ] **Step 2: Extend Tailwind config**

Check `tailwind.config.ts` for how other tones are exposed (`bg-ok`, `text-warn`, etc.). Add `attn` and `attn-subtle` to the same places (commonly `theme.extend.colors`), mirroring the shape used for `warn`.

- [ ] **Step 3: Verify**

Run `npm run build:web` — it must succeed. Then look at `src/web/ui/primitives/Pill.tsx`'s existing token usage to confirm the new tokens resolve (the real assertion comes in Task 12).

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/tokens.css tailwind.config.ts
git commit -m "feat(ui): add --attn / --attn-subtle tokens"
```

---

## Task 12: Primitives — `'attn'` tone in StatusDot, Pill, Design showcase

**Files:**
- Modify: `src/web/ui/primitives/StatusDot.tsx`
- Modify: `src/web/ui/primitives/Pill.tsx`
- Modify: `src/web/pages/Design.tsx`
- Test: `src/web/ui/primitives/Pill.test.tsx` (extend existing)

- [ ] **Step 1: Extend Pill tests first**

Locate the existing `Pill.test.tsx` describe block. Add:

```tsx
it('renders an attn-toned pill', () => {
  const { getByTestId } = render(<Pill data-testid="p" tone="attn">waiting</Pill>);
  const el = getByTestId('p');
  expect(el).toHaveAttribute('data-tone', 'attn');
  expect(el.className).toContain('text-attn');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- src/web/ui/primitives/Pill.test.tsx`
Expected: type/assertion failure — `'attn'` is not assignable to `PillTone`.

- [ ] **Step 3: Extend `StatusDot`**

In `src/web/ui/primitives/StatusDot.tsx`:

```ts
export type DotTone = 'ok' | 'run' | 'attn' | 'fail' | 'warn';

const DOT: Record<DotTone, string> = {
  ok: 'bg-ok',
  run: 'bg-run shadow-[0_0_6px_var(--run)] animate-pulse',
  attn: 'bg-attn shadow-[0_0_6px_var(--attn)] animate-pulse',
  fail: 'bg-fail',
  warn: 'bg-warn',
};
```

- [ ] **Step 4: Extend `Pill`**

In `src/web/ui/primitives/Pill.tsx`:

```ts
export type PillTone = 'ok' | 'run' | 'attn' | 'fail' | 'warn' | 'wait';

const TONES: Record<PillTone, string> = {
  ok: 'bg-ok-subtle text-ok border-ok',
  run: 'bg-run-subtle text-run border-run animate-pulse',
  attn: 'bg-attn-subtle text-attn border-attn animate-pulse',
  fail: 'bg-fail-subtle text-fail border-fail',
  warn: 'bg-warn-subtle text-warn border-warn',
  wait: 'bg-surface-raised text-text-dim border-border-strong',
};
```

- [ ] **Step 5: Add to Design showcase**

In `src/web/pages/Design.tsx`, find the existing block where pills and dots are rendered (grep for `tone="run"` to locate). Add sibling entries for `tone="attn"` alongside each existing tone's showcase — for consistency, one `<Pill tone="attn">attn</Pill>` and one `<StatusDot tone="attn" />` placed next to the `warn` entries.

- [ ] **Step 6: Run tests**

Run: `npm test -- src/web/ui/primitives`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/web/ui/primitives/StatusDot.tsx src/web/ui/primitives/Pill.tsx src/web/ui/primitives/Pill.test.tsx src/web/pages/Design.tsx
git commit -m "feat(ui): 'attn' tone on StatusDot, Pill, Design showcase"
```

---

## Task 13: Run-level surfaces — RunRow, RunHeader, RunSidePanel

**Files:**
- Modify: `src/web/features/runs/RunRow.tsx:12-19`
- Modify: `src/web/features/runs/RunHeader.tsx:6-9, 20-21, 41-45`
- Modify: `src/web/features/runs/RunSidePanel.tsx:9-12`

- [ ] **Step 1: Update `RunRow` TONE map**

In `src/web/features/runs/RunRow.tsx`:

```ts
const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait',
  running: 'run',
  waiting: 'attn',
  awaiting_resume: 'warn',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'warn',
};
```

- [ ] **Step 1b: Update `RunSidePanel` TONE map**

In `src/web/features/runs/RunSidePanel.tsx:9-12`, add `waiting: 'attn'` to the map (same shape as RunRow / RunHeader):

```ts
const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', running: 'run', waiting: 'attn', awaiting_resume: 'warn',
  succeeded: 'ok', failed: 'fail', cancelled: 'warn',
};
```

- [ ] **Step 2: Update `RunHeader` TONE map + action gating**

In `src/web/features/runs/RunHeader.tsx`:

```ts
const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', running: 'run', waiting: 'attn', awaiting_resume: 'warn',
  succeeded: 'ok', failed: 'fail', cancelled: 'warn',
};
```

And extend the existing live-state gates so `'waiting'` is treated like `'running'`:

```ts
const canFollowUp = run.state !== 'running' && run.state !== 'waiting'
                 && run.state !== 'queued' && run.state !== 'awaiting_resume'
                 && !!run.branch_name;
// Cancel button:
{(run.state === 'running' || run.state === 'waiting' || run.state === 'awaiting_resume')
  && <Button variant="danger" size="sm" onClick={onCancel}>Cancel</Button>}
// Delete menu disabled:
{ id: 'delete', label: 'Delete run', danger: true, onSelect: onDelete,
  disabled: run.state === 'running' || run.state === 'waiting' || run.state === 'awaiting_resume' },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. (This closes the exhaustiveness holes opened in Task 1 step 2.)

- [ ] **Step 4: Commit**

```bash
git add src/web/features/runs/RunRow.tsx src/web/features/runs/RunHeader.tsx src/web/features/runs/RunSidePanel.tsx
git commit -m "feat(ui): render 'waiting' in RunRow + RunHeader + RunSidePanel"
```

---

## Task 14: Sidebar dot precedence — `hasWaiting` beats `hasRunning`

**Files:**
- Modify: `src/web/App.tsx:30-35`
- Modify: `src/web/ui/shell/Sidebar.tsx` (prop threading only)
- Modify: `src/web/features/projects/ProjectList.tsx:6-38`

There are two dot-rendering sites: `Sidebar.tsx:48` (reads pre-computed `p.hasRunning` from App's `projectRows`) and `ProjectList.tsx:16,28` (derives `hasRunning` itself on the Projects page). Both need the new flag.

- [ ] **Step 1: Extend `projectRows` in `App.tsx`**

Replace lines 30–35:

```tsx
const projectRows = projects.map((p) => ({
  id: p.id,
  name: p.name,
  runs: runs.filter((r) => r.project_id === p.id).length,
  hasRunning: runs.some((r) => r.project_id === p.id && r.state === 'running'),
  hasWaiting: runs.some((r) => r.project_id === p.id && r.state === 'waiting'),
}));
```

- [ ] **Step 2: Thread `hasWaiting` through `Sidebar.tsx`**

In `src/web/ui/shell/Sidebar.tsx` add `hasWaiting: boolean;` to the project row prop interface (line ~11), and replace the dot render (line ~48) with the same precedence:

```tsx
{p.hasWaiting ? <StatusDot tone="attn" aria-label="waiting for input" />
 : p.hasRunning ? <StatusDot tone="run" aria-label="running" />
 : null}
```

If `AppShell` re-declares its project-row type between App.tsx and Sidebar.tsx, add `hasWaiting: boolean;` there too.

- [ ] **Step 3: Update `ProjectList.tsx`**

Keep the existing `runs` prop; add a sibling derivation right below the existing `hasRunning`:

```tsx
const hasRunning = runs.some((r) => r.project_id === p.id && r.state === 'running');
const hasWaiting = runs.some((r) => r.project_id === p.id && r.state === 'waiting');
```

Replace the existing `{hasRunning && <StatusDot ... />}` render (line ~28) with:

```tsx
{hasWaiting ? <StatusDot tone="attn" aria-label="waiting for input" />
 : hasRunning ? <StatusDot tone="run" aria-label="running" />
 : null}
```

- [ ] **Step 4: Test the precedence**

Extend or create `src/web/features/projects/ProjectList.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectList } from './ProjectList.js';

const BASE_PROJECT = {
  id: 1, name: 'p', repo_url: 'git@h:o/r.git', default_branch: 'main',
  devcontainer_override_json: null, instructions: null,
  git_author_name: null, git_author_email: null,
  marketplaces: [], plugins: [], mem_mb: null, cpus: null, pids_limit: null,
  created_at: 0, updated_at: 0,
} as const;

const mkRun = (patch: Partial<{ state: string }>): any => ({
  id: 1, project_id: 1, prompt: '', branch_name: '', state: 'running',
  container_id: null, log_path: '', exit_code: null, error: null,
  head_commit: null, started_at: 0, finished_at: null, created_at: 0,
  resume_attempts: 0, next_resume_at: null, claude_session_id: null,
  last_limit_reset_at: null, tokens_input: 0, tokens_output: 0,
  tokens_cache_read: 0, tokens_cache_create: 0, tokens_total: 0,
  usage_parse_errors: 0, ...patch,
});

describe('ProjectList sidebar dot', () => {
  it('renders attn dot when any run of the project is waiting', () => {
    const { container } = render(
      <MemoryRouter>
        <ProjectList
          projects={[BASE_PROJECT]}
          runs={[mkRun({ state: 'running' }), mkRun({ state: 'waiting' })]}
        />
      </MemoryRouter>,
    );
    const dot = container.querySelector('[data-tone]');
    expect(dot?.getAttribute('data-tone')).toBe('attn');
  });

  it('renders run dot when running but not waiting', () => {
    const { container } = render(
      <MemoryRouter>
        <ProjectList
          projects={[BASE_PROJECT]}
          runs={[mkRun({ state: 'running' })]}
        />
      </MemoryRouter>,
    );
    const dot = container.querySelector('[data-tone]');
    expect(dot?.getAttribute('data-tone')).toBe('run');
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- src/web/features/projects`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/web/App.tsx src/web/ui/shell/Sidebar.tsx src/web/features/projects/ProjectList.tsx src/web/features/projects/ProjectList.test.tsx
git commit -m "feat(ui): sidebar dot precedence — waiting beats running"
```

---

## Task 15: Status bar — `N waiting` count, hidden at zero

**Files:**
- Modify: `src/web/App.tsx:27-54`

- [ ] **Step 1: Compute the count**

Right below the existing `const active = ...` line (27):

```tsx
const waiting = runs.filter((r) => r.state === 'waiting').length;
```

Thread `waiting` into `<StatusRegistrations>`:

```tsx
<StatusRegistrations active={active} waiting={waiting} today={today} />
```

- [ ] **Step 2: Register a toggle-on-demand item**

In `StatusRegistrations`, extend the props and useEffect. Because we want the item to **disappear** at zero (not render empty), gate the registration on `waiting > 0`:

```tsx
function StatusRegistrations({ active, waiting, today }: {
  active: number; waiting: number; today: number;
}) {
  useEffect(() => {
    const off1 = statusRegistry.register({ id: 'conn', side: 'left', order: 0,
      render: () => <>● <span className="text-ok">connected</span></> });
    const off2 = statusRegistry.register({ id: 'active', side: 'left', order: 1,
      render: () => <>{active} <span className="text-run">running</span></> });
    const off3 = statusRegistry.register({ id: 'today', side: 'left', order: 3,
      render: () => <>{today} today</> });
    const offRL = statusRegistry.register({ id: 'ratelimit', side: 'right', order: 0,
      render: () => <RateLimitPill /> });
    return () => { off1(); off2(); off3(); offRL(); };
  }, [active, today]);

  // Waiting item is mounted only when > 0 so the bar collapses its gap.
  useEffect(() => {
    if (waiting === 0) return;
    return statusRegistry.register({
      id: 'waiting', side: 'left', order: 2,
      render: () => <>{waiting} <span className="text-attn">waiting</span></>,
    });
  }, [waiting]);

  return null;
}
```

- [ ] **Step 3: Verify in dev**

Run `scripts/dev.sh`. With no waiting runs, confirm the bar reads `N running · N today`. Keep the dev server running into Task 17.

- [ ] **Step 4: Commit**

```bash
git add src/web/App.tsx
git commit -m "feat(ui): status bar 'waiting' count, hidden at zero"
```

---

## Task 16: `notifyWaiting` + `clearWaitingBadge`

**Files:**
- Modify: `src/web/lib/notifications.ts`

- [ ] **Step 1: Extend the module**

Replace `src/web/lib/notifications.ts` with (or add — the existing code stays largely intact):

```ts
let unread = 0;
const origTitle = typeof document !== 'undefined' ? document.title : 'FBI';
let faviconLink: HTMLLinkElement | null = null;
const waitingRuns = new Set<number>();     // runs currently waiting with hidden tab

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
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(22, 10, 7, 0, Math.PI * 2);
  ctx.fill();
  return c.toDataURL('image/png');
}

export async function ensurePermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

// Attention token's dark-palette hex, used to tint the favicon dot.
const ATTN_COLOR = '#fbbf24';

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

  const perm = await ensurePermission();
  if (perm === 'granted') {
    new Notification(label, {
      body: run.project_name ? `Project: ${run.project_name}` : 'Run finished',
      tag: `fbi-run-${run.id}`,
    });
  }

  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    unread += 1;
    document.title = `(${unread}) ${origTitle}`;
  }

  const link = getFaviconLink();
  if (link) link.href = drawFaviconWithDot(color);
}

export async function notifyWaiting(run: {
  id: number;
  project_name?: string;
}): Promise<void> {
  const perm = await ensurePermission();
  if (perm === 'granted') {
    new Notification(`⧖ Run #${run.id}`, {
      body: run.project_name
        ? `Waiting for input · ${run.project_name}`
        : 'Waiting for input',
      tag: `fbi-run-${run.id}-waiting`,
    });
  }

  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    if (!waitingRuns.has(run.id)) {
      waitingRuns.add(run.id);
      unread += 1;
      document.title = `(${unread}) ${origTitle}`;
    }
  }

  const link = getFaviconLink();
  if (link) link.href = drawFaviconWithDot(ATTN_COLOR);
}

export function clearWaitingBadge(runId: number): void {
  if (!waitingRuns.delete(runId)) return;
  unread = Math.max(0, unread - 1);
  if (typeof document !== 'undefined') {
    document.title = unread > 0 ? `(${unread}) ${origTitle}` : origTitle;
  }
}

export function installFocusReset(): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => {
    if (document.visibilityState === 'visible') {
      unread = 0;
      waitingRuns.clear();
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

- [ ] **Step 2: Commit**

```bash
git add src/web/lib/notifications.ts
git commit -m "feat(ui): notifyWaiting + clearWaitingBadge"
```

---

## Task 17: Refactor `useRunWatcher` to WS-driven

**Files:**
- Rewrite: `src/web/hooks/useRunWatcher.ts`
- Modify: `src/web/lib/api.ts` (add `listRuns()` if it doesn't already expose all runs)

- [ ] **Step 1: Write failing tests**

Create `src/web/hooks/useRunWatcher.test.ts`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

// Mock notifications dispatch to count calls
vi.mock('../lib/notifications.js', () => ({
  notifyComplete: vi.fn(),
  notifyWaiting: vi.fn(),
  clearWaitingBadge: vi.fn(),
  installFocusReset: vi.fn(() => () => {}),
}));

// Mock api.listRuns to return a controllable snapshot
vi.mock('../lib/api.js', () => ({
  api: { listRuns: vi.fn(async () => []) },
}));

/* Use a minimal fake WebSocket implementation + the useRunWatcher hook. */
```

Test cases:
- Initial seed: `listRuns` returns two runs (one running, one succeeded); no notification dispatched during seed.
- After seed: WS delivers `{run_id:1, state:'waiting', project_id:1, ...}` → `notifyWaiting` called once.
- After that: WS delivers `{run_id:1, state:'running', ...}` → `clearWaitingBadge(1)` called; `notifyWaiting` NOT called again.
- Terminal transition: WS delivers `{run_id:1, state:'succeeded', ...}` → `notifyCompleteById` equivalent called.
- `enabled=false`: neither notification fires, but `_publishCounts` is still called (sidebar still needs live counts).

The fake WebSocket can be a class exposed as `globalThis.WebSocket` in the test:

```ts
class FakeSocket {
  onopen?: () => void;
  onmessage?: (ev: { data: string }) => void;
  onclose?: () => void;
  close() { this.onclose?.(); }
  fire(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- src/web/hooks/useRunWatcher.test.ts`
Expected: failures — current `useRunWatcher` still polls.

- [ ] **Step 3: Rewrite `useRunWatcher`**

Replace `src/web/hooks/useRunWatcher.ts` with:

```ts
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  notifyComplete, notifyWaiting, clearWaitingBadge, installFocusReset,
} from '../lib/notifications.js';
import type { RunState } from '@shared/types.js';

type Listener = (map: Map<number, number>) => void;
let lastMap = new Map<number, number>();     // running counts per project (back-compat)
let lastWaitingMap = new Map<number, number>();
const listeners = new Set<Listener>();
const waitingListeners = new Set<Listener>();

export function _publishRunning(map: Map<number, number>) {
  lastMap = map;
  for (const l of listeners) l(map);
}
export function _publishWaiting(map: Map<number, number>) {
  lastWaitingMap = map;
  for (const l of waitingListeners) l(map);
}

export function useRunningCounts(): Map<number, number> {
  const [m, setM] = useState(lastMap);
  useEffect(() => {
    const l: Listener = (x) => setM(new Map(x));
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return m;
}

export function useWaitingCounts(): Map<number, number> {
  const [m, setM] = useState(lastWaitingMap);
  useEffect(() => {
    const l: Listener = (x) => setM(new Map(x));
    waitingListeners.add(l);
    return () => { waitingListeners.delete(l); };
  }, []);
  return m;
}

interface GlobalStateFrame {
  type: 'state';
  run_id: number;
  project_id: number;
  state: RunState;
}

const isTerminal = (s: RunState) =>
  s === 'succeeded' || s === 'failed' || s === 'cancelled';

function statesUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/ws/states`;
}

function publishCountsFromMap(runs: Map<number, { state: RunState; project_id: number }>) {
  const running = new Map<number, number>();
  const waiting = new Map<number, number>();
  for (const { state, project_id } of runs.values()) {
    if (state === 'running') running.set(project_id, (running.get(project_id) ?? 0) + 1);
    else if (state === 'waiting') waiting.set(project_id, (waiting.get(project_id) ?? 0) + 1);
  }
  _publishRunning(running);
  _publishWaiting(waiting);
}

export function useRunWatcher(enabled: boolean) {
  const projectNames = useRef(new Map<number, string>());   // for notif bodies

  useEffect(() => {
    const dispose = enabled ? installFocusReset() : () => {};
    const runs = new Map<number, { state: RunState; project_id: number }>();
    let seeding = true;
    let ws: WebSocket | null = null;
    let stopped = false;

    const seed = async () => {
      seeding = true;
      try {
        const all = await api.listRuns();
        runs.clear();
        for (const r of all) runs.set(r.id, { state: r.state, project_id: r.project_id });
        publishCountsFromMap(runs);
      } catch { /* swallow; reconnect retry will re-seed */ }
      seeding = false;
    };

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(statesUrl());
      ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data as string) as GlobalStateFrame;
        const prev = runs.get(msg.run_id)?.state;
        runs.set(msg.run_id, { state: msg.state, project_id: msg.project_id });
        publishCountsFromMap(runs);
        if (seeding || !enabled) return;
        if (prev === 'running' && msg.state === 'waiting') {
          const proj = await api.getProject(msg.project_id).catch(() => null);
          void notifyWaiting({ id: msg.run_id, project_name: proj?.name });
        } else if (prev === 'waiting' && msg.state !== 'waiting') {
          clearWaitingBadge(msg.run_id);
        }
        if (isTerminal(msg.state)) {
          const proj = await api.getProject(msg.project_id).catch(() => null);
          void notifyComplete({
            id: msg.run_id,
            state: msg.state as 'succeeded' | 'failed' | 'cancelled',
            project_name: proj?.name,
          });
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setTimeout(() => { void seed().then(connect); }, 1000);
      };
    };

    void seed().then(connect);
    return () => {
      stopped = true;
      ws?.close();
      dispose();
    };
  }, [enabled]);
}
```

(If `api.listRuns()` does not currently return all runs regardless of state, extend it — minimal change; check `src/web/lib/api.ts` for the existing signature. The legacy polling called `api.listRuns('running')` — now we need the unfiltered list.)

- [ ] **Step 4: Run tests**

Run: `npm test -- src/web/hooks`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/web/hooks/useRunWatcher.ts src/web/hooks/useRunWatcher.test.ts src/web/lib/api.ts
git commit -m "feat(ui): useRunWatcher — WS-driven, seeds + dispatches waiting/complete"
```

---

## Task 18: Manual UI verification

**Files:** none — this is a smoke-test checkpoint.

- [ ] **Step 1: Start dev**

Run: `scripts/dev.sh`
Open: http://localhost:5173

- [ ] **Step 2: Start a fresh run**

Kick off any run against a test project. Wait for the container to start and Claude to hit its TUI prompt (typically ~30–60 s after the run starts; `warmupMs` gate is 20 s).

- [ ] **Step 3: Verify waiting signals**

Within a few seconds of Claude reaching the input prompt:

- **Sidebar**: the project's dot turns amber (not blue).
- **Status bar**: `1 waiting` appears to the right of `N running`.
- **RunRow** (in the run list): pill reads `waiting` in amber.
- **OS notification**: fires (`⧖ Run #N`).

- [ ] **Step 4: Verify round-trip**

Type any character into the run's terminal view. Within ~2–4 seconds:

- Sidebar dot reverts to blue.
- Status bar `1 waiting` disappears.
- Run pill reads `running`.
- Title badge (if the tab was hidden) decrements.

- [ ] **Step 5: Verify notifications kill-switch**

Flip `notifications_enabled` off in Settings. Repeat step 3 — confirm no OS notification and no title-badge increment, but sidebar + status bar still update.

- [ ] **Step 6: Commit nothing; log findings**

If any of the above fail, open a task-local notes file and capture exact symptoms before returning to Tasks 5–8 to refine the detector thresholds or regex.

---

## File map

Server:
- `src/shared/types.ts` — RunState + GlobalStateMessage
- `src/server/db/runs.ts`, `runs.test.ts` — waiting transitions
- `src/server/orchestrator/waitingPrompt.ts` (+ test) — regex helper
- `src/server/orchestrator/mountActivity.ts` (+ test) — extracted helper
- `src/server/orchestrator/waitingMonitor.ts` (+ test) — detector
- `src/server/orchestrator/waiting.flow.test.ts` — integration
- `src/server/orchestrator/limitMonitor.ts` — reuses sumJsonlSizes
- `src/server/orchestrator/index.ts` — wire monitor, extend cancel/recover, publish global state
- `src/server/logs/registry.ts` — getGlobalStates
- `src/server/api/ws.ts`, `ws.test.ts` — /api/ws/states route

Web:
- `src/web/ui/tokens.css`, `tailwind.config.ts` — --attn tokens
- `src/web/ui/primitives/StatusDot.tsx`, `Pill.tsx`, `Pill.test.tsx` — attn tone
- `src/web/pages/Design.tsx` — showcase entries
- `src/web/features/runs/RunRow.tsx`, `RunHeader.tsx` — waiting rendering + action gating
- `src/web/features/projects/ProjectList.tsx`, `ProjectList.test.tsx` — dot precedence
- `src/web/App.tsx`, `src/web/ui/shell/Sidebar.tsx` — prop threading, status bar
- `src/web/hooks/useRunWatcher.ts`, `useRunWatcher.test.ts` — WS-driven
- `src/web/lib/notifications.ts` — notifyWaiting, clearWaitingBadge
- `src/web/lib/api.ts` — listRuns() unfiltered (if needed)
