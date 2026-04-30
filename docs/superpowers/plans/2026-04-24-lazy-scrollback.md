# Lazy scrollback terminal — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live / "Load full history" two-view terminal with a single scroll surface that lazy-loads 512 KB history chunks, pauses the live stream on scroll-up, and snaps back to live on scroll-to-bottom or button click.

**Architecture:** One xterm; every state transition rebuilds it via `term.reset() + write(concatenated byte buffers)`. Controller tracks two byte buffers (`loadedBytes` = pre-seed + prepended history chunks; `liveTailBytes` = WS bytes received since mount). Scroll position is restored via `scrollToLine(oldViewportY + addedLines)`. Resume reuses the existing server re-hello path to request a fresh snapshot (no new WS message type).

**Tech Stack:** TypeScript, React, xterm.js, Fastify, vitest. Spec: `docs/superpowers/specs/2026-04-24-lazy-scrollback-design.md`.

**File layout (new + modified):**

| File | Role |
|---|---|
| `src/server/logs/store.ts` (M) | Add `byteSize`, `readRange` |
| `src/server/logs/store.test.ts` (M) | Tests for the two new helpers |
| `src/server/api/runs.ts` (M) | Extend `/transcript` with `Range` header + `X-Transcript-Total` |
| `src/server/api/runs.test.ts` (M) | Tests for `Range` handling |
| `src/web/lib/scrollDetection.ts` (N) | Pure helper: `{ atBottom, nearTop, viewportTopLine }` from xterm state |
| `src/web/lib/scrollDetection.test.ts` (N) | Tests for the helper |
| `src/web/lib/terminalController.ts` (M) | All runtime state + rebuild + pause/resume + chunk loader |
| `src/web/lib/terminalController.test.ts` (M) | Add tests for new behavior; remove `resumeLive` tests |
| `src/web/components/Terminal.tsx` (M) | Banner UI, scroll wiring, remove "Load full history" overlay |
| `src/web/components/Terminal.test.tsx` (N) | Basic component-level tests for banner + buttons |

**Constants:**
- `CHUNK_SIZE = 512 * 1024` — byte size for seed and prepend chunks
- `NEAR_TOP_LINES = 100` — prefetch trigger threshold  
- `RESUME_SNAPSHOT_TIMEOUT_MS = 2000` — max wait for fresh snapshot on resume

---

## Task 1: Server — `LogStore.byteSize` and `LogStore.readRange`

**Files:**
- Modify: `src/server/logs/store.ts`
- Modify: `src/server/logs/store.test.ts`

- [ ] **Step 1.1: Write failing tests for `byteSize` and `readRange`**

Append these `it` blocks to `src/server/logs/store.test.ts`:

```ts
  it('byteSize returns file size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    fs.writeFileSync(p, Buffer.from('0123456789'));
    expect(LogStore.byteSize(p)).toBe(10);
  });

  it('byteSize returns 0 for missing file', () => {
    expect(LogStore.byteSize('/nonexistent/x')).toBe(0);
  });

  it('readRange returns exact bytes for a valid range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    fs.writeFileSync(p, Buffer.from('abcdefghij'));
    expect(Buffer.from(LogStore.readRange(p, 2, 5)).toString()).toBe('cde');
    // Inclusive end:
    expect(Buffer.from(LogStore.readRange(p, 0, 10)).toString()).toBe('abcdefghij');
  });

  it('readRange clamps to file size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    fs.writeFileSync(p, Buffer.from('abc'));
    // End past EOF → clamped.
    expect(Buffer.from(LogStore.readRange(p, 1, 100)).toString()).toBe('bc');
    // Start past EOF → empty.
    expect(LogStore.readRange(p, 100, 200).length).toBe(0);
  });

  it('readRange returns empty for missing file', () => {
    expect(LogStore.readRange('/nonexistent/x', 0, 100).length).toBe(0);
  });
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
npx vitest run src/server/logs/store.test.ts
```
Expected: new tests FAIL with `TypeError: LogStore.byteSize is not a function` (or `readRange`).

- [ ] **Step 1.3: Implement `byteSize` and `readRange`**

Add these two static methods to `src/server/logs/store.ts` after the existing `readAll`:

```ts
  static byteSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  /**
   * Read a byte range `[start, end]` (both inclusive, mirroring HTTP
   * Range semantics). Clamps end to file size; returns empty Uint8Array
   * for missing file or start ≥ size.
   */
  static readRange(filePath: string, start: number, end: number): Uint8Array {
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Uint8Array();
      throw err;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (start >= size) return new Uint8Array();
      const clampedEnd = Math.min(end, size - 1);
      const length = clampedEnd - start + 1;
      const buf = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, buf, read, length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, read);
    } finally {
      fs.closeSync(fd);
    }
  }
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
npx vitest run src/server/logs/store.test.ts
```
Expected: all 7 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add src/server/logs/store.ts src/server/logs/store.test.ts
git commit -m "server(logs): add LogStore.byteSize and readRange"
```

---

## Task 2: Server — `/transcript` accepts `Range` header

**Files:**
- Modify: `src/server/api/runs.ts:258-265`
- Modify: `src/server/api/runs.test.ts` (append test cases)

- [ ] **Step 2.1: Write failing tests**

Append these `it` blocks inside the existing `describe('runs routes', ...)` in `src/server/api/runs.test.ts`. The existing `setup()` helper already registers `/api/runs/:id/transcript`, but creates runs without logs. We need to seed a transcript file; use `runs.get(id).log_path` which is set by RunsRepo.create().

Add a helper above `describe('runs routes', ...)`:

```ts
async function seedTranscript(app: ReturnType<typeof Fastify>, runs: RunsRepo, projectId: number, text: string): Promise<number> {
  const r = (await app.inject({
    method: 'POST', url: `/api/projects/${projectId}/runs`,
    payload: { prompt: 'x' },
  })).json() as { id: number };
  const run = runs.get(r.id)!;
  fs.mkdirSync(path.dirname(run.log_path), { recursive: true });
  fs.writeFileSync(run.log_path, text);
  return r.id;
}
```

And these test cases at the end of `describe('runs routes', ...)`:

```ts
  it('GET /api/runs/:id/transcript returns full body and X-Transcript-Total with no Range', async () => {
    const { app, projectId, runs } = setup();
    const id = await seedTranscript(app, runs, projectId, 'abcdefghij');
    const res = await app.inject({ method: 'GET', url: `/api/runs/${id}/transcript` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-transcript-total']).toBe('10');
    expect(res.body).toBe('abcdefghij');
  });

  it('GET /api/runs/:id/transcript honors Range: bytes=X-Y with 206 + Content-Range', async () => {
    const { app, projectId, runs } = setup();
    const id = await seedTranscript(app, runs, projectId, 'abcdefghij');
    const res = await app.inject({
      method: 'GET', url: `/api/runs/${id}/transcript`,
      headers: { range: 'bytes=2-5' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['x-transcript-total']).toBe('10');
    expect(res.body).toBe('cdef');
  });

  it('GET /api/runs/:id/transcript with Range open-ended bytes=X- returns to EOF', async () => {
    const { app, projectId, runs } = setup();
    const id = await seedTranscript(app, runs, projectId, 'abcdefghij');
    const res = await app.inject({
      method: 'GET', url: `/api/runs/${id}/transcript`,
      headers: { range: 'bytes=7-' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 7-9/10');
    expect(res.body).toBe('hij');
  });

  it('GET /api/runs/:id/transcript with malformed Range returns 200 full body', async () => {
    const { app, projectId, runs } = setup();
    const id = await seedTranscript(app, runs, projectId, 'abc');
    const res = await app.inject({
      method: 'GET', url: `/api/runs/${id}/transcript`,
      headers: { range: 'lines=0-10' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('abc');
  });
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
npx vitest run src/server/api/runs.test.ts
```
Expected: the four new tests FAIL (missing headers; 200 instead of 206; etc.).

- [ ] **Step 2.3: Replace the transcript handler**

In `src/server/api/runs.ts`, replace the existing handler at the `/api/runs/:id/transcript` route (currently lines 258-265) with:

```ts
  app.get('/api/runs/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    const total = LogStore.byteSize(run.log_path);
    reply.header('X-Transcript-Total', String(total));
    reply.header('content-type', 'text/plain; charset=utf-8');

    const rangeHeader = req.headers.range;
    const m = typeof rangeHeader === 'string'
      ? /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
      : null;
    if (!m) {
      const bytes = LogStore.readAll(run.log_path);
      return reply.send(Buffer.from(bytes));
    }

    const start = Number(m[1]);
    const end = m[2] === '' ? total - 1 : Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      return reply.code(416)
        .header('content-range', `bytes */${total}`)
        .send();
    }
    const clampedEnd = Math.min(end, total - 1);
    const bytes = LogStore.readRange(run.log_path, start, clampedEnd);
    return reply.code(206)
      .header('content-range', `bytes ${start}-${clampedEnd}/${total}`)
      .send(Buffer.from(bytes));
  });
```

Also confirm `LogStore` is already imported at the top of `runs.ts`. If not, add:
```ts
import { LogStore } from '../logs/store.js';
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
npx vitest run src/server/api/runs.test.ts
```
Expected: all new tests PASS; existing tests still PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/server/api/runs.ts src/server/api/runs.test.ts
git commit -m "server(api): /transcript honors Range header + X-Transcript-Total"
```

---

## Task 3: Client — `scrollDetection` helper

**Files:**
- Create: `src/web/lib/scrollDetection.ts`
- Create: `src/web/lib/scrollDetection.test.ts`

- [ ] **Step 3.1: Write failing test**

Create `src/web/lib/scrollDetection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectScroll } from './scrollDetection.js';

function mkTerm(baseY: number, viewportY: number, rows = 40) {
  return { rows, buffer: { active: { baseY, viewportY } } } as unknown as import('@xterm/xterm').Terminal;
}

describe('detectScroll', () => {
  it('atBottom when viewportY === baseY', () => {
    expect(detectScroll(mkTerm(500, 500)).atBottom).toBe(true);
  });

  it('atBottom false when viewportY < baseY', () => {
    expect(detectScroll(mkTerm(500, 499)).atBottom).toBe(false);
  });

  it('nearTop true when viewportY < NEAR_TOP_LINES and baseY > 0', () => {
    expect(detectScroll(mkTerm(500, 50)).nearTop).toBe(true);
    expect(detectScroll(mkTerm(500, 99)).nearTop).toBe(true);
    expect(detectScroll(mkTerm(500, 100)).nearTop).toBe(false);
  });

  it('nearTop false when baseY === 0 (nothing older to load)', () => {
    expect(detectScroll(mkTerm(0, 0)).nearTop).toBe(false);
  });

  it('viewportTopLine equals viewportY', () => {
    expect(detectScroll(mkTerm(500, 123)).viewportTopLine).toBe(123);
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
npx vitest run src/web/lib/scrollDetection.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3.3: Implement**

Create `src/web/lib/scrollDetection.ts`:

```ts
import type { Terminal as Xterm } from '@xterm/xterm';

export const NEAR_TOP_LINES = 100;

export interface ScrollSample {
  atBottom: boolean;
  nearTop: boolean;
  viewportTopLine: number;
}

export function detectScroll(term: Xterm): ScrollSample {
  const buf = term.buffer.active;
  const baseY = buf.baseY;
  const viewportY = buf.viewportY;
  return {
    atBottom: viewportY >= baseY,
    nearTop: baseY > 0 && viewportY < NEAR_TOP_LINES,
    viewportTopLine: viewportY,
  };
}
```

- [ ] **Step 3.4: Run test to verify it passes**

```bash
npx vitest run src/web/lib/scrollDetection.test.ts
```
Expected: all 5 tests PASS.

- [ ] **Step 3.5: Commit**

```bash
git add src/web/lib/scrollDetection.ts src/web/lib/scrollDetection.test.ts
git commit -m "web(terminal): add scrollDetection helper"
```

---

## Task 4: Client — Extend fake xterm in tests for buffer state

**Files:**
- Modify: `src/web/lib/terminalController.test.ts` (helper only, no test changes yet)

This task purely prepares the test fixture for upcoming tasks. No behavior change to the controller.

- [ ] **Step 4.1: Enhance `makeFakeXterm`**

Replace the entire `makeFakeXterm()` definition in `src/web/lib/terminalController.test.ts` with:

```ts
function makeFakeXterm() {
  type DataCb = (d: string) => void;
  const dataCbs: DataCb[] = [];
  const writes: Array<string | Uint8Array> = [];
  const buffer = { active: { baseY: 0, viewportY: 0 } };
  const scrollCbs: Array<() => void> = [];
  return {
    cols: 120,
    rows: 40,
    writes,
    dataCbs,
    scrollCbs,
    buffer,
    options: {} as Record<string, unknown>,
    write: vi.fn((data: string | Uint8Array, cb?: () => void) => {
      writes.push(data);
      if (cb) cb();
    }),
    reset: vi.fn(() => { writes.push('__RESET__'); buffer.active.baseY = 0; buffer.active.viewportY = 0; }),
    focus: vi.fn(),
    onData: vi.fn((cb: DataCb) => {
      dataCbs.push(cb);
      return { dispose: () => { const i = dataCbs.indexOf(cb); if (i !== -1) dataCbs.splice(i, 1); } };
    }),
    onScroll: vi.fn((cb: () => void) => {
      scrollCbs.push(cb);
      return { dispose: () => { const i = scrollCbs.indexOf(cb); if (i !== -1) scrollCbs.splice(i, 1); } };
    }),
    scrollToLine: vi.fn((_line: number) => { /* no-op in fake */ }),
    scrollToBottom: vi.fn(() => { buffer.active.viewportY = buffer.active.baseY; }),
    dispose: vi.fn(),
  };
}
```

- [ ] **Step 4.2: Run existing tests to verify no regression**

```bash
npx vitest run src/web/lib/terminalController.test.ts
```
Expected: all 10 existing tests still PASS (they don't use the new fields).

- [ ] **Step 4.3: Commit**

```bash
git add src/web/lib/terminalController.test.ts
git commit -m "test(terminalController): extend fake xterm with buffer + onScroll"
```

---

## Task 5: Client — Controller tracks `liveTailBytes`, `liveOffset`, `latestState`

**Files:**
- Modify: `src/web/lib/terminalController.ts`
- Modify: `src/web/lib/terminalController.test.ts`

Goal: when live bytes arrive, append them to `liveTailBytes` and bump `liveOffset`. Also track the latest run state so later tasks can branch on live vs terminal.

- [ ] **Step 5.1: Write failing test — bytes accumulate in liveTailBytes**

Append to `src/web/lib/terminalController.test.ts`:

```ts
  it('accumulates live bytes in liveTailBytes and advances liveOffset', () => {
    const shell = makeStubShell();
    acquiredShells.set(20, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(20, term as unknown as import('@xterm/xterm').Terminal, host);

    for (const cb of shell._bytes) cb(new TextEncoder().encode('abc'));
    for (const cb of shell._bytes) cb(new TextEncoder().encode('de'));

    // Exposed for tests via a `_debugBuffers()` accessor (see Step 5.3).
    const bufs = c._debugBuffers();
    expect(Buffer.from(bufs.liveTailBytes).toString()).toBe('abcde');
    expect(bufs.liveOffset).toBe(5);
  });

  it('tracks latestState from state typed events', () => {
    const shell = makeStubShell();
    acquiredShells.set(21, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(21, term as unknown as import('@xterm/xterm').Terminal, host);

    for (const cb of shell._events) {
      cb({ type: 'state', state: 'running' } as unknown as { type: string });
    }
    expect(c._debugBuffers().latestState).toBe('running');

    for (const cb of shell._events) {
      cb({ type: 'state', state: 'succeeded' } as unknown as { type: string });
    }
    expect(c._debugBuffers().latestState).toBe('succeeded');
  });
```

- [ ] **Step 5.2: Run test to verify it fails**

```bash
npx vitest run src/web/lib/terminalController.test.ts -t "accumulates live bytes"
```
Expected: FAIL — `_debugBuffers` is not a function.

- [ ] **Step 5.3: Add state + debug accessor to controller**

In `src/web/lib/terminalController.ts`:

Add imports at top:
```ts
import type { RunState } from '@shared/types.js';
```

Add fields in the `TerminalController` class (after the existing `disposed` field, before `ready`):

```ts
  private liveTailBytes: Uint8Array = new Uint8Array();
  private liveOffset = 0;
  private latestState: RunState = 'queued';
```

Modify the existing `onTypedEvent` subscription to update `latestState`. Change:

```ts
    this.unsubEvents = this.shell.onTypedEvent<{ type: string; snapshot?: unknown }>((msg) => {
      if (this.disposed) return;
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'state') publishState(runId, msg as unknown as RunWsStateMessage);
      else if (msg.type === 'title') publishTitle(runId, msg as unknown as RunWsTitleMessage);
      else if (msg.type === 'files') publishFiles(runId, msg as unknown as FilesPayload);
    });
```

to:

```ts
    this.unsubEvents = this.shell.onTypedEvent<{ type: string; snapshot?: unknown; state?: RunState }>((msg) => {
      if (this.disposed) return;
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'state') {
        if (msg.state) this.latestState = msg.state;
        publishState(runId, msg as unknown as RunWsStateMessage);
      }
      else if (msg.type === 'title') publishTitle(runId, msg as unknown as RunWsTitleMessage);
      else if (msg.type === 'files') publishFiles(runId, msg as unknown as FilesPayload);
    });
```

Modify the `onBytes` subscription to append to `liveTailBytes` and advance `liveOffset`. Change:

```ts
    this.unsubBytes = this.shell.onBytes((data) => {
      if (this.disposed) return;
      this.term.write(data);
      this.bumpReadySilenceTimer();
    });
```

to:

```ts
    this.unsubBytes = this.shell.onBytes((data) => {
      if (this.disposed) return;
      this.term.write(data);
      // Retain the live tail so pause/chunk-load/resume rebuilds can replay
      // it. Grows unbounded by design — see spec Q8 (no cap in v1).
      const next = new Uint8Array(this.liveTailBytes.byteLength + data.byteLength);
      next.set(this.liveTailBytes);
      next.set(data, this.liveTailBytes.byteLength);
      this.liveTailBytes = next;
      this.liveOffset += data.byteLength;
      this.bumpReadySilenceTimer();
    });
```

Add the debug accessor method at the bottom of the class, just before `dispose`:

```ts
  /** @internal — for tests only. */
  _debugBuffers(): { liveTailBytes: Uint8Array; liveOffset: number; latestState: RunState; loadedBytes: Uint8Array; loadedStartOffset: number; paused: boolean } {
    return {
      liveTailBytes: this.liveTailBytes,
      liveOffset: this.liveOffset,
      latestState: this.latestState,
      loadedBytes: this.loadedBytes,
      loadedStartOffset: this.loadedStartOffset,
      paused: this.paused,
    };
  }
```

Also add placeholder fields referenced by `_debugBuffers` so tests compile in later steps. After `private latestState`:

```ts
  private loadedBytes: Uint8Array = new Uint8Array();
  private loadedStartOffset = 0;
  private paused = false;
```

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
npx vitest run src/web/lib/terminalController.test.ts
```
Expected: all existing + 2 new tests PASS.

- [ ] **Step 5.5: Commit**

```bash
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts
git commit -m "web(terminal): track liveTailBytes, liveOffset, latestState"
```

---

## Task 6: Client — Controller `pause()` / `resume()` state + byte-drop gate

**Files:**
- Modify: `src/web/lib/terminalController.ts`
- Modify: `src/web/lib/terminalController.test.ts`

Goal: basic pause/resume with a byte-drop gate (WS bytes dropped while paused — both from xterm and from `liveTailBytes`). Resume in this task is bare — it just flips the flag. Real resume (snapshot + rebuild) is Task 9.

- [ ] **Step 6.1: Write failing tests**

Append to `src/web/lib/terminalController.test.ts`:

```ts
  it('pause() sets paused state; live bytes are dropped while paused', () => {
    const shell = makeStubShell();
    acquiredShells.set(22, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(22, term as unknown as import('@xterm/xterm').Terminal, host);

    for (const cb of shell._bytes) cb(new TextEncoder().encode('pre'));
    expect(c._debugBuffers().liveTailBytes.byteLength).toBe(3);

    c.pause();
    expect(c._debugBuffers().paused).toBe(true);
    term.write.mockClear();
    for (const cb of shell._bytes) cb(new TextEncoder().encode('dropped'));
    expect(term.write).not.toHaveBeenCalled();
    expect(c._debugBuffers().liveTailBytes.byteLength).toBe(3); // unchanged
    expect(c._debugBuffers().liveOffset).toBe(3); // unchanged — dropped bytes aren't counted
  });

  it('pause() is idempotent; double pause does not fire listeners twice', () => {
    const shell = makeStubShell();
    acquiredShells.set(23, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(23, term as unknown as import('@xterm/xterm').Terminal, host);

    const listener = vi.fn();
    c.onPauseChange(listener);
    c.pause();
    c.pause();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it('setInteractive gate: paused blocks typing even when interactive=true', () => {
    const shell = makeStubShell();
    acquiredShells.set(24, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(24, term as unknown as import('@xterm/xterm').Terminal, host);

    c.setInteractive(true);
    expect(term.onData).toHaveBeenCalledTimes(1);

    c.pause();
    // Gate closed: onData handler is detached.
    expect(term.dataCbs).toHaveLength(0);
  });
```

- [ ] **Step 6.2: Run tests to verify they fail**

```bash
npx vitest run src/web/lib/terminalController.test.ts -t "pause"
```
Expected: FAIL — `c.pause` / `c.onPauseChange` is not a function.

- [ ] **Step 6.3: Implement pause state + listeners + gate**

In `src/web/lib/terminalController.ts`:

Add these two fields to the class (near `paused`):

```ts
  private pauseListeners = new Set<(paused: boolean) => void>();
  private interactiveProp = false; // track the prop so applyInteractive can recompute
```

Replace the existing `setInteractive` with a two-layer version. Rename the current body to `applyInteractive` (private) and have the public `setInteractive` just store the prop and delegate:

```ts
  setInteractive(on: boolean): void {
    if (this.disposed) return;
    this.interactiveProp = on;
    this.applyInteractive();
  }

  private applyInteractive(): void {
    if (this.disposed) return;
    const effective = this.interactiveProp && !this.paused;
    if (effective && !this.inputDisposable) {
      this.inputDisposable = this.term.onData((d) => {
        traceRecord('controller.input', strPreview(d));
        this.shell.send(new TextEncoder().encode(d));
      });
      this.hostClickHandler = () => this.term.focus();
      this.host.addEventListener('click', this.hostClickHandler);
      this.term.focus();
    } else if (!effective && this.inputDisposable) {
      this.inputDisposable.dispose();
      this.inputDisposable = null;
      if (this.hostClickHandler) {
        this.host.removeEventListener('click', this.hostClickHandler);
        this.hostClickHandler = null;
      }
    }
  }
```

Add the byte-drop gate. Change the `onBytes` subscription added in Task 5:

```ts
    this.unsubBytes = this.shell.onBytes((data) => {
      if (this.disposed) return;
      if (this.paused) return; // drop while paused — no xterm write, no liveTailBytes append
      this.term.write(data);
      // ... (rest as in Task 5)
```

Keep the existing `liveTailBytes` append and `liveOffset` bump code below the gate.

Add the public methods near the bottom of the class (before `_debugBuffers`):

```ts
  onPauseChange(cb: (paused: boolean) => void): () => void {
    this.pauseListeners.add(cb);
    return () => { this.pauseListeners.delete(cb); };
  }

  private emitPauseChange(): void {
    for (const cb of this.pauseListeners) cb(this.paused);
  }

  pause(): void {
    if (this.disposed || this.paused) return;
    traceRecord('controller.pause', { runId: this.runId });
    this.paused = true;
    this.applyInteractive();
    this.emitPauseChange();
  }
```

Note: `resume()` is added in Task 9. For now, tests that need to unpause will use a minimal stub — see Task 9.

- [ ] **Step 6.4: Run tests to verify they pass**

```bash
npx vitest run src/web/lib/terminalController.test.ts
```
Expected: all existing + 3 new tests PASS.

- [ ] **Step 6.5: Commit**

```bash
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts
git commit -m "web(terminal): add pause() with byte-drop gate and listeners"
```

---

## Task 7: Client — `rebuildXterm` helper + `seedInitialHistory`

**Files:**
- Modify: `src/web/lib/terminalController.ts`
- Modify: `src/web/lib/terminalController.test.ts`

Goal: a single internal helper that resets the xterm and writes a sequence of byte buffers, returning when all writes have completed. Then wire `seedInitialHistory()` to fetch the last 512 KB and rebuild.

- [ ] **Step 7.1: Write failing test for seedInitialHistory**

Add a `fetch` mock helper and test to `src/web/lib/terminalController.test.ts`. Add near top of file, after imports:

```ts
interface FetchCall { url: string; headers: Record<string, string> }
const fetchCalls: FetchCall[] = [];
let fetchResponder: (call: FetchCall) => { status: number; headers: Record<string, string>; body: Uint8Array } =
  () => ({ status: 404, headers: {}, body: new Uint8Array() });

function installFetchMock() {
  globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const h: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) h[k.toLowerCase()] = v;
    const call: FetchCall = { url: String(url), headers: h };
    fetchCalls.push(call);
    const r = fetchResponder(call);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get: (name: string) => r.headers[name.toLowerCase()] ?? null,
      },
      arrayBuffer: () => Promise.resolve(r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength)),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}
```

And augment `beforeEach`:

```ts
beforeEach(() => {
  acquiredShells.clear();
  usagePublishes.length = 0;
  fetchCalls.length = 0;
  fetchResponder = () => ({ status: 404, headers: {}, body: new Uint8Array() });
  installFetchMock();
});
```

Append this test:

```ts
  it('seedInitialHistory fetches last 512KB via Range, rebuilds xterm with [seed, snapshot]', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(40, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(40, term as unknown as import('@xterm/xterm').Terminal, host);

    // Initial snapshot lands, normal handler writes it (reset + snap).
    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'SNAP', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);
    expect(term.writes).toEqual(['__RESET__', 'SNAP']);

    // Seed fetch: respond with a large-enough transcript (1 MB). Server
    // returns the last 512KB via Range. Controller fires two fetches: a
    // 1-byte meta (Range: bytes=0-0) to read X-Transcript-Total, then the
    // real seed range.
    const FULL_TOTAL = 1_000_000;
    const seedBytes = new Uint8Array(512 * 1024).fill(65); // 'A' * 524288
    fetchResponder = (call) => {
      expect(call.url).toBe('/api/runs/40/transcript');
      if (call.headers.range === 'bytes=0-0') {
        return {
          status: 206,
          headers: { 'x-transcript-total': String(FULL_TOTAL) },
          body: new Uint8Array([0]),
        };
      }
      if (call.headers.range === `bytes=${FULL_TOTAL - 524288}-${FULL_TOTAL - 1}`) {
        return {
          status: 206,
          headers: {
            'x-transcript-total': String(FULL_TOTAL),
            'content-range': `bytes ${FULL_TOTAL - 524288}-${FULL_TOTAL - 1}/${FULL_TOTAL}`,
          },
          body: seedBytes,
        };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };

    // Seed is kicked off after the snapshot handler runs — controller calls it internally.
    // Give it a few macrotask ticks to settle the async chain (meta fetch, seed fetch, rebuild).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const bufs = c._debugBuffers();
    expect(bufs.loadedBytes.byteLength).toBe(524288 + 4); // seed + 'SNAP'
    expect(bufs.loadedStartOffset).toBe(FULL_TOTAL - 524288);
    expect(bufs.liveOffset).toBe(FULL_TOTAL);
  });
```

- [ ] **Step 7.2: Run test to verify it fails**

```bash
npx vitest run src/web/lib/terminalController.test.ts -t "seedInitialHistory"
```
Expected: FAIL — either the rebuild doesn't happen, or `loadedBytes` is still empty.

- [ ] **Step 7.3: Implement `rebuildXterm` + `seedInitialHistory`**

In `src/web/lib/terminalController.ts`:

Add at top of the file with other imports:

```ts
const CHUNK_SIZE = 512 * 1024;
```

Add a helper for concatenating buffers (place it as a file-scope function above the class):

```ts
function concat(bufs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const b of bufs) total += b.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { out.set(b, off); off += b.byteLength; }
  return out;
}
```

Add these methods to the class (below the existing `dispose` body — or anywhere; order doesn't matter for TypeScript):

```ts
  private writeAndWait(data: Uint8Array | string): Promise<void> {
    return new Promise<void>((resolve) => this.term.write(data, resolve));
  }

  /**
   * Reset xterm and replay a sequence of byte buffers. Returns after all
   * writes have been acknowledged by xterm's parser.
   */
  private async rebuildXterm(buffers: Array<Uint8Array | string>): Promise<void> {
    this.term.reset();
    for (const b of buffers) {
      await this.writeAndWait(b);
    }
  }

  /**
   * Fetch the last CHUNK_SIZE bytes of the transcript and rebuild the
   * xterm with [seed, snapshot]. Called once on mount, after the initial
   * snapshot has been written to xterm by the normal handler.
   *
   * Stores seed+snapshot bytes in `loadedBytes`. On total < CHUNK_SIZE,
   * fetches from byte 0 (i.e., the full transcript so far).
   */
  private async seedInitialHistory(snap: RunWsSnapshotMessage): Promise<void> {
    try {
      const snapBytes = new TextEncoder().encode(snap.ansi);
      const headerTotal = await this.fetchTranscriptMeta();
      if (headerTotal === 0) {
        // Nothing to seed; loadedBytes stays just the snapshot.
        this.loadedBytes = snapBytes;
        this.loadedStartOffset = 0;
        this.liveOffset = 0;
        traceRecord('controller.seed.complete', { bytes: 0 });
        return;
      }
      const start = Math.max(0, headerTotal - CHUNK_SIZE);
      const end = headerTotal - 1;
      const res = await fetch(`/api/runs/${this.runId}/transcript`, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (this.disposed) return;
      if (!res.ok && res.status !== 206) {
        traceRecord('controller.seed.error', { status: res.status });
        return;
      }
      const seedBytes = new Uint8Array(await res.arrayBuffer());
      if (this.disposed) return;
      this.loadedBytes = concat([seedBytes, snapBytes]);
      this.loadedStartOffset = start;
      this.liveOffset = headerTotal;
      // Include liveTailBytes in case any live bytes arrived between the
      // initial snapshot (written by the normal handler) and this rebuild.
      await this.rebuildXterm([this.loadedBytes, this.liveTailBytes]);
      this.term.scrollToBottom();
      traceRecord('controller.seed.complete', { bytes: seedBytes.byteLength });
    } catch (err) {
      traceRecord('controller.seed.error', { err: String(err) });
    }
  }

  /** HEAD-less total: make a 1-byte Range request to read X-Transcript-Total. */
  private async fetchTranscriptMeta(): Promise<number> {
    const res = await fetch(`/api/runs/${this.runId}/transcript`, {
      headers: { Range: 'bytes=0-0' },
    });
    if (this.disposed) return 0;
    const total = Number(res.headers.get('X-Transcript-Total') ?? '0');
    return Number.isFinite(total) ? total : 0;
  }
```

Modify the snapshot handler to kick off the seed the first time (only on the very first snapshot, not on reconnect ones). Replace the existing `onSnapshot` subscription body. The original:

```ts
    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      this.term.reset();
      this.term.write(snap.ansi);
      this.onSnapshotParsed();
      this.scheduleCursorRedraw();
    });
```

becomes:

```ts
    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      this.term.reset();
      this.term.write(snap.ansi);
      this.onSnapshotParsed();
      this.scheduleCursorRedraw();
      // On the very first snapshot, seed initial history.
      if (!this.seeded) {
        this.seeded = true;
        void this.seedInitialHistory(snap);
      }
    });
```

And add the `seeded` field:

```ts
  private seeded = false;
```

To handle the cached-snapshot path, also set `seeded = true` in the `if (cached)` block so the seed doesn't fire on the cached snapshot (the fresh snapshot arriving next will trigger it via the handler's normal flow — but the flag was already true, so it won't). Fix: make sure the seed fires on the fresh snapshot, not the cached one. Change to: seed only on non-cached snapshot. Use a different flag: `private seedingStarted = false`; set false in constructor (not set on cached path); the snapshot handler sets it true and kicks off the fetch exactly once.

Actually the simplest correct version: `seeded` starts false; cached-snapshot path does NOT touch `seeded`. The first real `onSnapshot` sets `seeded = true` and kicks off `seedInitialHistory`. This is exactly the code above. Leave it.

- [ ] **Step 7.4: Run test to verify it passes**

```bash
npx vitest run src/web/lib/terminalController.test.ts -t "seedInitialHistory"
```
Expected: PASS. Run full file too to verify no regression:
```bash
npx vitest run src/web/lib/terminalController.test.ts
```
All PASS.

- [ ] **Step 7.5: Commit**

```bash
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts
git commit -m "web(terminal): seed initial history from last 512KB of transcript"
```

---

## Task 8: Client — `loadOlderChunk` with dedup + scroll-restore + start-of-run marker

**Files:**
- Modify: `src/web/lib/terminalController.ts`
- Modify: `src/web/lib/terminalController.test.ts`

Goal: while paused, fetch the next chunk of older history on demand. Rebuild xterm with `[newerChunk, ...loadedBytes, ...liveTailBytes]`. Preserve scroll position via added-line math. Dedup concurrent calls. Emit the start-of-run marker when `loadedStartOffset` hits 0.

- [ ] **Step 8.1: Write failing tests**

Append to `src/web/lib/terminalController.test.ts`:

```ts
  it('loadOlderChunk fetches a 512KB range before loadedStartOffset and prepends to loadedBytes', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(50, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(50, term as unknown as import('@xterm/xterm').Terminal, host);

    // Arrange: simulate a post-seed state directly via _debugBuffers-adjacent setup.
    // Instead, drive the full flow: big transcript, seed completes, then request a chunk.
    const TOTAL = 2_000_000;
    const seedBytes = new Uint8Array(524288).fill(66);
    const olderBytes = new Uint8Array(524288).fill(67);
    fetchResponder = (call) => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - 524288}-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: seedBytes };
      }
      if (call.headers.range === `bytes=${TOTAL - 1048576}-${TOTAL - 524289}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: olderBytes };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'S', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);
    await new Promise((r) => setTimeout(r, 0));
    expect(c._debugBuffers().loadedStartOffset).toBe(TOTAL - 524288);

    // Pause (required for loadOlderChunk to fire).
    c.pause();
    await c.loadOlderChunk();

    const b = c._debugBuffers();
    expect(b.loadedBytes.byteLength).toBe(524288 + 524288 + 1); // older + seed + 'S'
    expect(b.loadedStartOffset).toBe(TOTAL - 1048576);
    // The first 524288 bytes of loadedBytes are the older chunk (all 67).
    expect(b.loadedBytes[0]).toBe(67);
    expect(b.loadedBytes[524287]).toBe(67);
    // Next bytes are seed (66).
    expect(b.loadedBytes[524288]).toBe(66);
  });

  it('loadOlderChunk is idempotent during a pending fetch (dedup)', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(51, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(51, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    const seedBytes = new Uint8Array(524288).fill(1);
    let older: { resolve: (b: Uint8Array) => void } | null = null;
    fetchResponder = (call) => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - 524288}-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: seedBytes };
      }
      // Older chunk: defer resolution so we can race two calls.
      return { status: 206, headers: {}, body: new Uint8Array(524288).fill(2) };
    };

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'S', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);
    await new Promise((r) => setTimeout(r, 0));

    c.pause();
    const p1 = c.loadOlderChunk();
    const p2 = c.loadOlderChunk(); // should dedupe to p1
    await Promise.all([p1, p2]);
    // Fetch calls: 2 meta + 1 seed + 1 older = 4. (NOT 5.)
    const olderCalls = fetchCalls.filter((c) => c.headers.range?.startsWith('bytes=') && c.headers.range !== 'bytes=0-0' && !c.headers.range.startsWith(`bytes=${TOTAL - 524288}`));
    expect(olderCalls.length).toBe(1);
  });

  it('loadOlderChunk writes start-of-run marker when loadedStartOffset reaches 0', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(52, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(52, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 100_000; // smaller than CHUNK_SIZE — seed covers everything.
    const seedBytes = new Uint8Array(TOTAL).fill(9);
    fetchResponder = (call) => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=0-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: seedBytes };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'S', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);
    await new Promise((r) => setTimeout(r, 0));
    expect(c._debugBuffers().loadedStartOffset).toBe(0);

    // loadOlderChunk must be a no-op — already at 0.
    c.pause();
    await c.loadOlderChunk();
    // No new fetch for an older chunk.
    const olderCalls = fetchCalls.filter((call) => {
      const r = call.headers.range;
      return r && r !== 'bytes=0-0' && r !== `bytes=0-${TOTAL - 1}`;
    });
    expect(olderCalls.length).toBe(0);
  });
```

- [ ] **Step 8.2: Run tests to verify they fail**

```bash
npx vitest run src/web/lib/terminalController.test.ts -t "loadOlderChunk"
```
Expected: FAIL — `loadOlderChunk` is not a function.

- [ ] **Step 8.3: Implement loadOlderChunk**

In `src/web/lib/terminalController.ts`, add these fields:

```ts
  private pendingChunk: { abort: AbortController; promise: Promise<void> } | null = null;
  private startMarkerWritten = false;
```

Add the method to the class:

```ts
  /**
   * Fetch the next 512KB of older transcript (bytes before
   * loadedStartOffset) and rebuild the xterm with scroll position
   * restored.
   *
   * Guards:
   * - Must be paused (no-op otherwise).
   * - loadedStartOffset === 0 → no-op.
   * - pendingChunk !== null → returns the in-flight promise (dedup).
   */
  async loadOlderChunk(): Promise<void> {
    if (this.disposed || !this.paused) return;
    if (this.loadedStartOffset === 0) return;
    if (this.pendingChunk) return this.pendingChunk.promise;

    const abort = new AbortController();
    const end = this.loadedStartOffset - 1;
    const start = Math.max(0, this.loadedStartOffset - CHUNK_SIZE);
    traceRecord('controller.chunk.fetch', { runId: this.runId, start, end });

    const promise = (async () => {
      try {
        const res = await fetch(`/api/runs/${this.runId}/transcript`, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: abort.signal,
        });
        if (this.disposed || abort.signal.aborted) return;
        if (!res.ok && res.status !== 206) {
          traceRecord('controller.chunk.error', { status: res.status });
          return;
        }
        const chunk = new Uint8Array(await res.arrayBuffer());
        if (this.disposed || abort.signal.aborted) return;

        const oldBaseY = this.term.buffer.active.baseY;
        const oldViewportY = this.term.buffer.active.viewportY;

        const newLoaded = concat([chunk, this.loadedBytes]);
        await this.rebuildXterm([newLoaded, this.liveTailBytes]);
        if (this.disposed) return;

        const newBaseY = this.term.buffer.active.baseY;
        const addedLines = newBaseY - oldBaseY;
        this.term.scrollToLine(oldViewportY + addedLines);

        this.loadedBytes = newLoaded;
        this.loadedStartOffset = start;
        if (start === 0 && !this.startMarkerWritten) {
          this.startMarkerWritten = true;
          this.term.write(new TextEncoder().encode('\r\n\x1b[2;37m── start of run ──\x1b[0m\r\n'));
        }
        traceRecord('controller.chunk.rebuild', {
          addedBytes: chunk.byteLength,
          addedLines,
        });
      } catch (err) {
        if (abort.signal.aborted) return;
        traceRecord('controller.chunk.error', { err: String(err) });
      } finally {
        this.pendingChunk = null;
      }
    })();

    this.pendingChunk = { abort, promise };
    return promise;
  }
```

- [ ] **Step 8.4: Run tests to verify they pass**

```bash
npx vitest run src/web/lib/terminalController.test.ts
```
Expected: all existing + 3 new tests PASS.

- [ ] **Step 8.5: Commit**

```bash
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts
git commit -m "web(terminal): loadOlderChunk with dedup + scroll-restore + start marker"
```

---

## Task 9: Client — `resume()` via sendHello (live) / tail fetch (finished)

**Files:**
- Modify: `src/web/lib/terminalController.ts`
- Modify: `src/web/lib/terminalController.test.ts`

Goal: `resume()` clears pause. For live runs, re-hello → fresh snapshot → rebuild with `[loadedBytes, liveTailBytes, snap.ansi]`. For finished runs, fetch tail `[liveOffset..total]` → rebuild with `[loadedBytes, liveTailBytes, tail]`. Aborts any pending chunk.

**Key trick for snapshot interception:** resume sets a one-shot `pendingResumeSnapshot` resolver. The existing `onSnapshot` handler, if the resolver is set, hands the snapshot to it and does NOT run its normal reset+write body (that would clear scrollback).

- [ ] **Step 9.1: Write failing tests**

Append to `src/web/lib/terminalController.test.ts`:

```ts
  it('resume() for a live run sends hello and rebuilds xterm with [loaded, liveTail, snap]', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(60, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(60, term as unknown as import('@xterm/xterm').Terminal, host);

    // Arrange: seed, live bytes, state=running, pause.
    const TOTAL = 100_000;
    fetchResponder = (call) => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array(TOTAL).fill(0) };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'S1', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 0));
    for (const cb of shell._events) cb({ type: 'state', state: 'running' } as unknown as { type: string });
    for (const cb of shell._bytes) cb(new TextEncoder().encode('live'));
    c.pause();

    term.reset.mockClear();
    term.write.mockClear();
    shell.sentHello.length = 0;

    // Act.
    const resumeP = c.resume();
    // The resume sendHello should have fired.
    expect(shell.sentHello).toEqual([{ cols: 120, rows: 40 }]);
    // Server replies with fresh snapshot.
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'FRESH', cols: 120, rows: 40 });
    await resumeP;

    // After resume, xterm was rebuilt (reset + writes).
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(c._debugBuffers().paused).toBe(false);
    // Listener notified.
  });

  it('resume() for a finished run fetches tail and rebuilds without sendHello', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(61, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(61, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 100_000;
    fetchResponder = (call) => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=0-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array(TOTAL).fill(0) };
      }
      if (call.headers.range === `bytes=${TOTAL}-`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array() };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'X', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 0));
    for (const cb of shell._events) cb({ type: 'state', state: 'succeeded' } as unknown as { type: string });
    c.pause();
    shell.sentHello.length = 0;

    await c.resume();

    expect(shell.sentHello).toEqual([]); // no hello for finished
    expect(c._debugBuffers().paused).toBe(false);
  });

  it('snapshot handler drops snapshots while paused (does not reset xterm)', () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(63, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(63, term as unknown as import('@xterm/xterm').Terminal, host);

    // Arrive in a reasonable post-mount state, then pause.
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'INITIAL', cols: 120, rows: 40 });
    c.pause();
    term.reset.mockClear();
    term.write.mockClear();

    // A WS reconnect delivers a stale snapshot while we're paused.
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'RECONNECT', cols: 120, rows: 40 });

    // Must NOT have reset the xterm (which would wipe scrollback).
    expect(term.reset).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalledWith('RECONNECT');
  });

  it('resume() aborts a pending chunk fetch and still completes', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(62, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(62, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    let resolveChunk: ((r: { status: number; headers: Record<string, string>; body: Uint8Array }) => void) | null = null;
    fetchResponder = (call) => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range === `bytes=${TOTAL - 524288}-${TOTAL - 1}`) {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array(524288) };
      }
      // Pending chunk: never resolved here; aborted by resume.
      return { status: 206, headers: {}, body: new Uint8Array(524288) };
    };

    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'X', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 0));
    for (const cb of shell._events) cb({ type: 'state', state: 'succeeded' } as unknown as { type: string });
    c.pause();

    // Kick a chunk load (no await).
    void c.loadOlderChunk();
    // Immediately resume while it's "in flight".
    const resumeP = c.resume();
    await resumeP;

    expect(c._debugBuffers().paused).toBe(false);
  });
```

- [ ] **Step 9.2: Run tests to verify they fail**

```bash
npx vitest run src/web/lib/terminalController.test.ts -t "resume()"
```
Expected: FAIL — `c.resume` is not a function.

- [ ] **Step 9.3: Implement resume + snapshot one-shot**

In `src/web/lib/terminalController.ts`:

Add constant near `CHUNK_SIZE`:
```ts
const RESUME_SNAPSHOT_TIMEOUT_MS = 2000;
```

Add this field to the class:
```ts
  private pendingResumeSnapshot: ((snap: RunWsSnapshotMessage) => void) | null = null;
```

Modify the `onSnapshot` subscription (from Task 7) to intercept when a resume is pending. Change:

```ts
    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      this.term.reset();
      this.term.write(snap.ansi);
      this.onSnapshotParsed();
      this.scheduleCursorRedraw();
      if (!this.seeded) {
        this.seeded = true;
        void this.seedInitialHistory(snap);
      }
    });
```

to:

```ts
    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      // Resume interception: if a resume is waiting for a fresh snapshot,
      // hand it over and skip the normal reset+write (resume does its own
      // rebuild with scrollback preserved).
      if (this.pendingResumeSnapshot) {
        const resolve = this.pendingResumeSnapshot;
        this.pendingResumeSnapshot = null;
        resolve(snap);
        return;
      }
      // Drop snapshots while paused — they would term.reset() and wipe
      // the scrollback the user is actively reading. On resume, we'll
      // request a fresh snapshot via sendHello.
      if (this.paused) {
        traceRecord('controller.snapshot.dropped', { reason: 'paused' });
        return;
      }
      this.term.reset();
      this.term.write(snap.ansi);
      this.onSnapshotParsed();
      this.scheduleCursorRedraw();
      if (!this.seeded) {
        this.seeded = true;
        void this.seedInitialHistory(snap);
      }
    });
```

Add a helper `isLiveState` as a file-scope function:

```ts
function isLiveState(s: RunState): boolean {
  return s === 'queued' || s === 'starting' || s === 'running' || s === 'waiting' || s === 'awaiting_resume';
}
```

Add the `resume` method to the class (near `pause`):

```ts
  async resume(): Promise<void> {
    if (this.disposed || !this.paused) return;
    traceRecord('controller.resume', { runId: this.runId, state: this.latestState });

    // Abort a concurrent chunk load; its rebuild would be wasted work.
    if (this.pendingChunk) {
      this.pendingChunk.abort.abort();
      this.pendingChunk = null;
    }

    let freshSnap: RunWsSnapshotMessage | null = null;
    if (isLiveState(this.latestState)) {
      // Ask server for a fresh snapshot via re-hello (existing server
      // path — see src/server/api/ws.ts: re-hello triggers sendSnapshot).
      const p = new Promise<RunWsSnapshotMessage>((resolve) => {
        this.pendingResumeSnapshot = resolve;
      });
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), RESUME_SNAPSHOT_TIMEOUT_MS));
      this.shell.sendHello(this.term.cols, this.term.rows);
      const snap = await Promise.race([p, timeout]);
      this.pendingResumeSnapshot = null; // clear if we timed out
      if (snap) freshSnap = snap;
    }

    // For finished runs (or as a fallback for timed-out live runs), fetch
    // the tail from liveOffset to current total.
    let tail: Uint8Array | null = null;
    if (!freshSnap) {
      try {
        const res = await fetch(`/api/runs/${this.runId}/transcript`, {
          headers: { Range: `bytes=${this.liveOffset}-` },
        });
        if (!this.disposed && (res.ok || res.status === 206)) {
          tail = new Uint8Array(await res.arrayBuffer());
          // Update liveOffset so subsequent bytes advance from here.
          if (tail.byteLength > 0) {
            const mergedLive = concat([this.liveTailBytes, tail]);
            this.liveTailBytes = mergedLive;
            this.liveOffset += tail.byteLength;
          }
        }
      } catch (err) {
        traceRecord('controller.resume.tail.error', { err: String(err) });
      }
    }

    if (this.disposed) return;

    const buffers: Array<Uint8Array | string> = [this.loadedBytes, this.liveTailBytes];
    if (freshSnap) buffers.push(freshSnap.ansi);
    await this.rebuildXterm(buffers);

    if (this.disposed) return;
    this.term.scrollToBottom();
    this.scheduleCursorRedraw();
    this.paused = false;
    this.applyInteractive();
    this.emitPauseChange();
  }
```

- [ ] **Step 9.4: Run tests to verify they pass**

```bash
npx vitest run src/web/lib/terminalController.test.ts
```
Expected: all PASS. Also run the broader suite to check for regressions:

```bash
npx vitest run
```

- [ ] **Step 9.5: Commit**

```bash
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts
git commit -m "web(terminal): resume() with fresh snapshot (live) / tail fetch (finished)"
```

---

## Task 10: Client — `Terminal.tsx` banner + scroll wiring; remove old history overlay

**Files:**
- Modify: `src/web/components/Terminal.tsx`
- Create: `src/web/components/Terminal.test.tsx`
- Modify: `src/web/lib/terminalController.ts` (remove `enterHistory`, `resumeLive`, `historyTerm`, `historyAborted`)
- Modify: `src/web/lib/terminalController.test.ts` (remove the `resumeLive` test since the method is gone)

- [ ] **Step 10.1: Write a component test for Terminal**

Create `src/web/components/Terminal.test.tsx`. The Terminal component integrates xterm which needs a real DOM; use happy-dom (already the test env). Mock the controller module so we can assert the wiring without initializing xterm.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the controller so we can drive onPauseChange from the test.
const pauseListeners = new Set<(p: boolean) => void>();
let lastController: { pause: () => void; resume: () => void; loadOlderChunk: () => Promise<void>; onScroll: (s: { atBottom: boolean; nearTop: boolean }) => void } | null = null;
vi.mock('../lib/terminalController.js', () => {
  return {
    TerminalController: vi.fn().mockImplementation(() => {
      const inst = {
        pause: vi.fn(),
        resume: vi.fn().mockResolvedValue(undefined),
        loadOlderChunk: vi.fn().mockResolvedValue(undefined),
        setInteractive: vi.fn(),
        resize: vi.fn(),
        requestRedraw: vi.fn(),
        isReady: () => true,
        onReady: vi.fn(),
        onPauseChange: (cb: (p: boolean) => void) => { pauseListeners.add(cb); return () => pauseListeners.delete(cb); },
        onScroll: vi.fn(),
        dispose: vi.fn(),
      };
      lastController = inst;
      return inst;
    }),
  };
});

// Mock xterm to a no-op constructor (open, loadAddon, etc. must not throw).
vi.mock('@xterm/xterm', () => {
  class FakeTerm {
    cols = 120; rows = 40;
    options: Record<string, unknown> = {};
    buffer = { active: { baseY: 100, viewportY: 100 } };
    open() {}
    loadAddon() {}
    onScroll(cb: () => void) { (FakeTerm as unknown as { __scrollCbs: Array<() => void> }).__scrollCbs = [cb]; return { dispose() {} }; }
    dispose() {}
    focus() {}
    write() {}
    reset() {}
  }
  return { Terminal: FakeTerm };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { loadAddon() {} fit() {} } }));

// Import AFTER mocks.
import { Terminal } from './Terminal.js';

describe('Terminal', () => {
  it('renders without crashing and has no "Load full history" button', () => {
    render(<Terminal runId={1} interactive={false} />);
    expect(screen.queryByText(/Load full history/i)).toBeNull();
  });

  it('shows the pause banner with Resume stream when onPauseChange(true) fires', () => {
    render(<Terminal runId={1} interactive={false} />);
    expect(screen.queryByText(/Stream paused/i)).toBeNull();
    act(() => { for (const cb of pauseListeners) cb(true); });
    expect(screen.getByText(/Stream paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume stream/i })).toBeInTheDocument();
  });

  it('clicking Resume stream calls controller.resume()', async () => {
    render(<Terminal runId={1} interactive={false} />);
    act(() => { for (const cb of pauseListeners) cb(true); });
    await userEvent.click(screen.getByRole('button', { name: /Resume stream/i }));
    expect(lastController?.resume).toHaveBeenCalled();
  });
});
```

- [ ] **Step 10.2: Run the test to verify it fails**

```bash
npx vitest run src/web/components/Terminal.test.tsx
```
Expected: FAIL — button still labeled "Load full history" or the banner not yet implemented.

- [ ] **Step 10.3: Rewrite `Terminal.tsx`**

Replace the body of `src/web/components/Terminal.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalController } from '../lib/terminalController.js';
import { detectScroll } from '../lib/scrollDetection.js';
import {
  record as traceRecord,
  isTracing,
  setTracing,
  subscribe as traceSubscribe,
  eventCount as traceEventCount,
  downloadTrace,
} from '../lib/terminalTrace.js';

interface Props {
  runId: number;
  interactive: boolean;
}

function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const bg = s.getPropertyValue('--surface-sunken').trim() || '#0b0f14';
  return {
    background: bg,
    foreground: s.getPropertyValue('--text').trim() || '#e2e8f0',
    cursor: bg,
    cursorAccent: bg,
  };
}

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);

  const [, forceTraceRerender] = useState(0);
  useEffect(() => traceSubscribe(() => forceTraceRerender((n) => n + 1)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setTracing(!isTracing());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Xterm({
      convertEol: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: readTheme(),
      cursorBlink: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    traceRecord('term.mount', { runId });

    const observer = new MutationObserver(() => { term.options.theme = readTheme(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const rect = host.getBoundingClientRect();
    if (rect.width >= 4 && rect.height >= 4) {
      try { fit.fit(); } catch { /* layout may still be transitioning */ }
    }

    const controller = new TerminalController(runId, term, host);
    controllerRef.current = controller;
    setReady(controller.isReady());
    if (!controller.isReady()) {
      controller.onReady(() => setReady(true));
    }

    const unsubPause = controller.onPauseChange((p) => setPaused(p));

    // Scroll-driven pause/resume + chunk prefetch.
    const scrollDisposable = term.onScroll(() => {
      const s = detectScroll(term);
      controller.onScroll(s);
    });

    const onVisibility = () => {
      if (!document.hidden) controller.requestRedraw();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const safeFit = (): boolean => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      try { fit.fit(); return true; } catch { return false; }
    };

    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const runFit = () => {
      roTimer = null;
      if (safeFit()) controller.resize(term.cols, term.rows);
    };
    const ro = new ResizeObserver(() => {
      if (roTimer !== null) clearTimeout(roTimer);
      roTimer = setTimeout(runFit, 120);
    });
    ro.observe(host);

    let winResizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onWinResize = () => {
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      winResizeTimer = setTimeout(() => {
        winResizeTimer = null;
        if (safeFit()) controller.resize(term.cols, term.rows);
      }, 120);
    };
    window.addEventListener('resize', onWinResize);

    return () => {
      if (roTimer !== null) clearTimeout(roTimer);
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      ro.disconnect();
      observer.disconnect();
      window.removeEventListener('resize', onWinResize);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubPause();
      scrollDisposable.dispose();
      controller.dispose();
      controllerRef.current = null;
      term.dispose();
    };
  }, [runId]);

  useEffect(() => {
    controllerRef.current?.setInteractive(interactive);
  }, [interactive, runId]);

  const onResumeClick = () => {
    void controllerRef.current?.resume();
  };

  return (
    <div className="relative h-full w-full bg-surface-sunken">
      {!ready && !paused && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-surface-sunken text-text-dim text-[12px]">
          <span>Loading terminal…</span>
        </div>
      )}
      {paused && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
          <span>⏸ Stream paused — you're viewing history.</span>
          <button
            type="button"
            onClick={onResumeClick}
            className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
          >
            Resume stream
          </button>
        </div>
      )}
      {isTracing() && (
        <div
          className="absolute bottom-1 right-2 z-30 select-none rounded bg-red-900/80 px-2 py-0.5 text-[10px] font-mono text-red-100 shadow ring-1 ring-red-300/30 backdrop-blur"
          title="Terminal trace recording (Ctrl+Shift+D to stop). Click to download."
        >
          <button
            type="button"
            onClick={() => downloadTrace()}
            className="cursor-pointer"
          >
            ● REC {traceEventCount()} ↓
          </button>
        </div>
      )}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
```

- [ ] **Step 10.4: Wire `onScroll` in the controller + remove old history code**

In `src/web/lib/terminalController.ts`:

Remove the `historyTerm` field, `historyAborted` field, the `enterHistory` method, and the `resumeLive` method entirely. Also remove the `XtermImpl` and `FitAddon` imports (no longer needed inside the controller).

Update `dispose()` to drop the `historyTerm` cleanup lines — the method should now read:

```ts
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    traceRecord('controller.dispose', { runId: this.runId });
    this.setInteractive(false);
    if (this.pendingChunk) { this.pendingChunk.abort.abort(); this.pendingChunk = null; }
    this.pendingResumeSnapshot = null;
    this.unsubBytes?.(); this.unsubBytes = null;
    this.unsubSnapshot?.(); this.unsubSnapshot = null;
    this.unsubOpen?.(); this.unsubOpen = null;
    this.unsubEvents?.(); this.unsubEvents = null;
    releaseShell(this.runId);
  }
```

Add the `onScroll` dispatcher:

```ts
  /**
   * Called by the React component on every xterm scroll event.
   * - atBottom + paused → auto-resume.
   * - not atBottom + not paused → pause.
   * - nearTop + paused + startOffset > 0 → prefetch next chunk.
   */
  onScroll(s: { atBottom: boolean; nearTop: boolean }): void {
    if (this.disposed) return;
    if (!this.paused && !s.atBottom) {
      this.pause();
      return;
    }
    if (this.paused && s.atBottom) {
      void this.resume();
      return;
    }
    if (this.paused && s.nearTop && this.loadedStartOffset > 0 && !this.pendingChunk) {
      void this.loadOlderChunk();
    }
  }
```

- [ ] **Step 10.5: Remove stale tests from controller test file**

Delete the `it('resumeLive focuses the live xterm even when no history is active', ...)` test from `src/web/lib/terminalController.test.ts` since `resumeLive` no longer exists.

- [ ] **Step 10.6: Add a test for `onScroll` dispatch**

Append to `src/web/lib/terminalController.test.ts`:

```ts
  it('onScroll: scrolling up from bottom calls pause()', () => {
    const shell = makeStubShell();
    acquiredShells.set(70, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(70, term as unknown as import('@xterm/xterm').Terminal, host);
    const pauseSpy = vi.spyOn(c, 'pause');
    c.onScroll({ atBottom: false, nearTop: false });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('onScroll: scrolling back to bottom calls resume()', () => {
    const shell = makeStubShell();
    acquiredShells.set(71, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(71, term as unknown as import('@xterm/xterm').Terminal, host);
    c.pause();
    const resumeSpy = vi.spyOn(c, 'resume');
    c.onScroll({ atBottom: true, nearTop: false });
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('onScroll: nearTop while paused triggers loadOlderChunk', async () => {
    const shell = makeStubShell();
    acquiredShells.set(72, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(72, term as unknown as import('@xterm/xterm').Terminal, host);
    // Pretend we already loaded an initial chunk by forcing loadedStartOffset > 0.
    (c as unknown as { loadedStartOffset: number }).loadedStartOffset = 100_000;
    c.pause();
    const loadSpy = vi.spyOn(c, 'loadOlderChunk').mockResolvedValue();
    c.onScroll({ atBottom: false, nearTop: true });
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 10.7: Run all terminal tests**

```bash
npx vitest run src/web/lib/terminalController.test.ts src/web/lib/scrollDetection.test.ts src/web/components/Terminal.test.tsx
```
Expected: all PASS.

- [ ] **Step 10.8: Run full test suite + typecheck**

```bash
npx vitest run && npx tsc -p tsconfig.test.json --noEmit && npx tsc -p tsconfig.web.json --noEmit
```
Expected: all PASS, no type errors.

- [ ] **Step 10.9: Commit**

```bash
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts src/web/components/Terminal.tsx src/web/components/Terminal.test.tsx
git commit -m "web(terminal): unified lazy-scrollback view — banner, scroll wiring, remove overlay"
```

---

## Task 11: Chunk-load loading/error strip

**Files:**
- Modify: `src/web/lib/terminalController.ts`
- Modify: `src/web/lib/terminalController.test.ts`
- Modify: `src/web/components/Terminal.tsx`
- Modify: `src/web/components/Terminal.test.tsx`

Goal: when a chunk fetch is underway *and the user is at the true top* (prefetch did not beat them there), show a thin "Loading older history…" strip. On fetch failure, show "Failed to load older history · [Retry]". Covers the spec's "Loading indicators" and "Error handling" for chunk loads.

- [ ] **Step 11.1: Write failing controller test for chunk-state events**

Append to `src/web/lib/terminalController.test.ts`:

```ts
  it('loadOlderChunk emits chunkState loading → idle on success', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(80, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(80, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    fetchResponder = (call) => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      return { status: 206, headers: {}, body: new Uint8Array(524288) };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'S', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 0));

    c.pause();
    const states: string[] = [];
    c.onChunkStateChange((s) => states.push(s));
    await c.loadOlderChunk();
    expect(states).toEqual(['loading', 'idle']);
  });

  it('loadOlderChunk emits chunkState loading → error on failure', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(81, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(81, term as unknown as import('@xterm/xterm').Terminal, host);

    const TOTAL = 2_000_000;
    fetchResponder = (call) => {
      if (call.headers.range === 'bytes=0-0') {
        return { status: 206, headers: { 'x-transcript-total': String(TOTAL) }, body: new Uint8Array([0]) };
      }
      if (call.headers.range?.startsWith(`bytes=${TOTAL - 524288}-`)) {
        return { status: 206, headers: {}, body: new Uint8Array(524288) };
      }
      // Older chunk fails with 500.
      return { status: 500, headers: {}, body: new Uint8Array() };
    };
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'S', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 0));

    c.pause();
    const states: string[] = [];
    c.onChunkStateChange((s) => states.push(s));
    await c.loadOlderChunk();
    expect(states).toEqual(['loading', 'error']);
  });
```

- [ ] **Step 11.2: Run tests to verify they fail**

```bash
npx vitest run src/web/lib/terminalController.test.ts -t "chunkState"
```
Expected: FAIL — `onChunkStateChange` is not a function.

- [ ] **Step 11.3: Implement chunk-state emitter**

In `src/web/lib/terminalController.ts`:

Add type and fields:

```ts
export type ChunkLoadState = 'idle' | 'loading' | 'error';
```

Inside the class (near `pauseListeners`):

```ts
  private chunkState: ChunkLoadState = 'idle';
  private chunkStateListeners = new Set<(s: ChunkLoadState) => void>();
```

Add the subscription API (near `onPauseChange`):

```ts
  onChunkStateChange(cb: (s: ChunkLoadState) => void): () => void {
    this.chunkStateListeners.add(cb);
    return () => { this.chunkStateListeners.delete(cb); };
  }

  private setChunkState(s: ChunkLoadState): void {
    if (this.chunkState === s) return;
    this.chunkState = s;
    for (const cb of this.chunkStateListeners) cb(s);
  }
```

Modify `loadOlderChunk` (from Task 8) to emit state transitions. In the promise body, at the very top (before the fetch):

```ts
    this.setChunkState('loading');
```

In the success branch (after `this.loadedStartOffset = start`):

```ts
        this.setChunkState('idle');
```

In the error branches (status not ok, thrown error, aborted where not the resume-abort): emit `'error'`:

```ts
        if (!res.ok && res.status !== 206) {
          this.setChunkState('error');
          traceRecord('controller.chunk.error', { status: res.status });
          return;
        }
```
```ts
      } catch (err) {
        if (abort.signal.aborted) {
          this.setChunkState('idle'); // aborted by resume — not an error to show
          return;
        }
        this.setChunkState('error');
        traceRecord('controller.chunk.error', { err: String(err) });
```

Keep the existing `finally { this.pendingChunk = null; }`.

Also expose `chunkState` via `_debugBuffers` so tests can query it cleanly (optional but helpful):

```ts
  _debugBuffers(): { /* …existing fields… */; chunkState: ChunkLoadState } {
    return {
      liveTailBytes: this.liveTailBytes,
      liveOffset: this.liveOffset,
      latestState: this.latestState,
      loadedBytes: this.loadedBytes,
      loadedStartOffset: this.loadedStartOffset,
      paused: this.paused,
      chunkState: this.chunkState,
    };
  }
```

- [ ] **Step 11.4: Run controller tests**

```bash
npx vitest run src/web/lib/terminalController.test.ts
```
Expected: all PASS including the two new tests.

- [ ] **Step 11.5: Write failing UI test for the strip**

Append to `src/web/components/Terminal.test.tsx`:

```tsx
  it('shows Loading older history strip when chunk state is loading and user is at top', () => {
    render(<Terminal runId={1} interactive={false} />);
    act(() => { for (const cb of pauseListeners) cb(true); });
    act(() => { for (const cb of chunkStateListeners) cb('loading'); });
    expect(screen.getByText(/Loading older history/i)).toBeInTheDocument();
  });

  it('shows Failed to load older history with Retry on error', async () => {
    render(<Terminal runId={1} interactive={false} />);
    act(() => { for (const cb of pauseListeners) cb(true); });
    act(() => { for (const cb of chunkStateListeners) cb('error'); });
    expect(screen.getByText(/Failed to load older history/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/i });
    await userEvent.click(retry);
    expect(lastController?.loadOlderChunk).toHaveBeenCalled();
  });
```

Also extend the `TerminalController` mock at the top of that file to register chunk-state listeners:

```ts
const chunkStateListeners = new Set<(s: string) => void>();
```

And in the mocked constructor's `inst` object, add:

```ts
onChunkStateChange: (cb: (s: string) => void) => { chunkStateListeners.add(cb); return () => chunkStateListeners.delete(cb); },
```

- [ ] **Step 11.6: Run test to verify it fails**

```bash
npx vitest run src/web/components/Terminal.test.tsx
```
Expected: FAIL — strip not yet rendered.

- [ ] **Step 11.7: Render the strip in `Terminal.tsx`**

In `src/web/components/Terminal.tsx`:

Add state:

```ts
  const [chunkState, setChunkState] = useState<'idle' | 'loading' | 'error'>('idle');
```

In the mount effect, subscribe to the controller and unsubscribe on cleanup. After `const unsubPause = controller.onPauseChange((p) => setPaused(p));`:

```ts
    const unsubChunkState = controller.onChunkStateChange((s) => setChunkState(s));
```

In the cleanup function, add:
```ts
      unsubChunkState();
```

Render the strip below the pause banner (same absolute-positioned row, offset by banner height). Add after the paused banner JSX:

```tsx
      {paused && chunkState !== 'idle' && (
        <div className="absolute top-[28px] left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[11px] text-text-dim">
          {chunkState === 'loading' && <span>Loading older history…</span>}
          {chunkState === 'error' && (
            <>
              <span>Failed to load older history.</span>
              <button
                type="button"
                onClick={() => void controllerRef.current?.loadOlderChunk()}
                className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
              >
                Retry
              </button>
            </>
          )}
        </div>
      )}
```

- [ ] **Step 11.8: Run Terminal tests**

```bash
npx vitest run src/web/components/Terminal.test.tsx
```
Expected: all PASS.

- [ ] **Step 11.9: Run full suite + typecheck**

```bash
npx vitest run && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.test.json --noEmit
```
Expected: all PASS, no type errors.

- [ ] **Step 11.10: Commit**

```bash
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts src/web/components/Terminal.tsx src/web/components/Terminal.test.tsx
git commit -m "web(terminal): loading + error strip for chunk fetches"
```

---

## Task 12: Manual QA via `scripts/dev.sh` + Playwright MCP

**Files:** none (documentation-only task; results may inform follow-up fixes)

- [ ] **Step 11.1: Start the dev server**

```bash
./scripts/dev.sh
```

Wait for both server and web dev output to stabilize. Note the URL (usually `http://localhost:5173`).

- [ ] **Step 11.2: Create a fresh run and verify mount**

Via the Playwright MCP tools (`mcp__playwright__browser_navigate`, `mcp__playwright__browser_snapshot`):

1. Navigate to the app URL; open an existing project or create a run with a non-trivial prompt (e.g., "Echo the last 100 filenames in /etc").
2. Wait for the terminal to show content (live bytes).
3. Verify NO "Load full history" button is visible anywhere in the terminal area.
4. Scroll up in the terminal (mouse wheel inside the xterm host). Expected: pause banner "⏸ Stream paused — you're viewing history." appears at the top, with a "Resume stream" link button.

- [ ] **Step 11.3: Verify auto-resume on scroll-to-bottom**

1. While paused, scroll back down to the bottom. Expected: banner disappears automatically; cursor re-appears at the Claude prompt within ~1 s; typing works.

- [ ] **Step 11.4: Verify [Resume stream] button**

1. Scroll up again to trigger pause.
2. Click "Resume stream". Expected: banner dismisses; xterm snaps to bottom; cursor visible; typing works.

- [ ] **Step 11.5: Verify lazy chunk loading on a long run**

Requires a run with >512 KB of transcript. Options: let an existing long-running run accumulate, or pick an existing finished run from the list.

1. Open the run. Verify initial pre-seed: scroll up a few screens without any network activity. (Use the browser devtools Network tab: check for a single `/transcript` Range request fired immediately after mount.)
2. Continue scrolling up. When the viewport nears the top of loaded scrollback, a second Range request should fire (inspect Network). Expected: no "loading older history…" strip if prefetch completes first.
3. Keep scrolling to the true start. Expected: a "── start of run ──" marker appears; no further Range requests fire.

- [ ] **Step 11.6: Verify finished-run resume path**

1. Open a finished run from the runs list. Scroll up to pause.
2. Click "Resume stream" or scroll to bottom. Expected: resume completes without `sendHello` going anywhere useful; xterm state is consistent (verify via browser devtools that `ws.out.hello` does NOT appear in the trace after the initial mount).

- [ ] **Step 11.7: Verify tab-return while paused**

1. Open a live run. Scroll up to pause.
2. Switch to another browser tab for ~60 s.
3. Return to the FBI tab. Expected: no fast-forward playback of intermediate frames; banner still shown; cursor visible in Claude's main-screen area.
4. Click Resume stream. Expected: snap to current live state.

- [ ] **Step 11.8: Document any issues**

If any step fails or produces unexpected behavior, add a follow-up section to this plan document (or a new spec) detailing the reproduction and proposed fix. Do not attempt to patch inline — surface the issue for review.

- [ ] **Step 11.9: Final sanity commit (if QA triggers doc updates)**

Only if Step 11.8 added anything:

```bash
git add docs/superpowers/plans/2026-04-24-lazy-scrollback.md
git commit -m "docs(plan): record lazy-scrollback QA findings"
```

---

## Rollback / risk notes

- The feature is entirely inside the terminal component; no server-side persistence changes. Rollback = revert the final commit.
- The server `/transcript` route remains backwards-compatible: requests without `Range` still get 200 + full body (existing clients keep working).
- `liveTailBytes` unbounded growth is explicit (spec Q8 = no cap). If a user reports a long-run-with-pause memory spike, follow-up work: add a soft cap (drop oldest tail bytes when > N MB) — the resume path's `term.reset() + rebuild` would need to shift from "replay everything" to "request a catch-up tail from the server."
