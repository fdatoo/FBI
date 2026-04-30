# Terminal Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the "fast-forward on refocus" bug and the vanishing-cursor bug in the live terminal view by making the server the source of truth for current screen state.

**Architecture:** Introduce a per-run `ScreenState` on the server (wraps `@xterm/headless` + `@xterm/addon-serialize`) fed the same byte stream as the existing `LogStore` and `Broadcaster`. The WS gains a `{type:'snapshot', ansi, cols, rows}` frame sent on every client connect (replacing raw log replay on the live path) and on demand via `{type:'resync'}`, which clients send on window focus / visibility change. The client drops its 2 MB rolling byte buffer; the snapshot is now ground truth.

**Tech Stack:** TypeScript (Node 20+), Fastify + `@fastify/websocket`, `@xterm/headless`, `@xterm/addon-serialize`, `@xterm/xterm`, `@xterm/addon-fit`, Vitest.

---

## Spec reference

Design spec: `docs/superpowers/specs/2026-04-22-terminal-robustness-design.md`. Read before starting.

## File structure

**New files**

- `src/server/logs/screen.ts` — `ScreenState` class wrapping `@xterm/headless`.
- `src/server/logs/screen.test.ts` — unit tests for write/serialize round-trip, resize, chunk-boundary parser safety.

**Modified files**

- `package.json` — add `@xterm/headless` and `@xterm/addon-serialize` deps.
- `src/server/logs/registry.ts` — add per-run `ScreenState`; `getOrCreateScreen` with lazy rebuild from log file.
- `src/server/logs/registry.test.ts` — extend with ScreenState lifecycle tests.
- `src/server/orchestrator/index.ts` — fan bytes into `ScreenState` at all three `onBytes` sites; forward resize to `ScreenState`.
- `src/shared/types.ts` — new WS message types: `RunWsSnapshotMessage`, `RunWsResyncMessage`.
- `src/server/api/ws.ts` — on active-run connect: send snapshot first, then subscribe; handle inbound `resync` messages by sending fresh snapshot.
- `src/server/api/ws.test.ts` (create if missing) — integration test for handshake + resync.
- `src/web/lib/ws.ts` — handle `snapshot` inbound, add `onSnapshot`/`sendResync`.
- `src/web/lib/shellRegistry.ts` — drop 2 MB byte buffer; expose `onSnapshot` and `requestResync`.
- `src/web/components/Terminal.tsx` — snapshot-driven first paint; focus/blur/visibility triggers resync; "Load full history" switches to explicit history mode fetching from existing `/api/runs/:id/transcript` endpoint.

**Unchanged but referenced**

- `src/server/logs/store.ts` — `LogStore.readAll` used for lazy `ScreenState` rebuild.
- `src/server/api/runs.ts:123–130` — existing `GET /api/runs/:id/transcript` endpoint is reused for "Load full history." No new endpoint needed.

---

## Task 1: `ScreenState` — install deps + skeleton with TDD

**Files:**
- Modify: `package.json` (add two deps)
- Create: `src/server/logs/screen.ts`
- Create: `src/server/logs/screen.test.ts`

- [ ] **Step 1: Install new dependencies**

Run:
```bash
npm install @xterm/headless@^5.5.0 @xterm/addon-serialize@^0.13.0
```

Expected: both packages added to `dependencies`. Confirm with:
```bash
grep -E '"@xterm/(headless|addon-serialize)"' package.json
```

- [ ] **Step 2: Write the failing tests**

Create `src/server/logs/screen.test.ts` with this content:

```ts
import { describe, it, expect } from 'vitest';
import { ScreenState } from './screen.js';
// Serialize-addon is also used inside ScreenState.serialize(); we verify
// round-tripping by feeding the serialized ansi into a second ScreenState
// and comparing the serialized output.

const enc = (s: string) => new TextEncoder().encode(s);

describe('ScreenState', () => {
  it('round-trips a plain-text write: feeding serialize() into a fresh ScreenState yields the same serialize()', async () => {
    const a = new ScreenState(80, 24);
    await a.write(enc('hello world\r\n'));
    const ansi = a.serialize();
    const b = new ScreenState(80, 24);
    await b.write(enc(ansi));
    expect(b.serialize()).toBe(ansi);
    a.dispose(); b.dispose();
  });

  it('is parser-safe across chunk boundaries: writing bytes in two halves equals writing them whole', async () => {
    const payload = enc('\x1b[31mred\x1b[0m text\r\n');
    const whole = new ScreenState(80, 24);
    await whole.write(payload);

    const split = new ScreenState(80, 24);
    const mid = Math.floor(payload.byteLength / 2);
    await split.write(payload.subarray(0, mid));
    await split.write(payload.subarray(mid));

    expect(split.serialize()).toBe(whole.serialize());
    whole.dispose(); split.dispose();
  });

  it('resize() updates cols/rows and subsequent serialize reflects new dimensions', async () => {
    const s = new ScreenState(80, 24);
    await s.write(enc('before\r\n'));
    s.resize(120, 40);
    await s.write(enc('after\r\n'));
    expect(s.cols).toBe(120);
    expect(s.rows).toBe(40);
    // The serialized output should replay into a fresh ScreenState of the
    // SAME new dimensions and be stable.
    const ansi = s.serialize();
    const b = new ScreenState(120, 40);
    await b.write(enc(ansi));
    expect(b.serialize()).toBe(ansi);
    s.dispose(); b.dispose();
  });

  it('serialize() excludes scrollback by default (scrollback:0)', async () => {
    const s = new ScreenState(10, 3);
    // Emit enough lines to overflow the visible viewport.
    for (let i = 0; i < 10; i++) await s.write(enc(`line${i}\r\n`));
    const ansi = s.serialize();
    // Old lines should not appear in the ANSI output — only what's on the
    // visible viewport. Last-visible line depends on exact rendering; a
    // lenient assertion: the very first emitted line is outside the viewport
    // and should not be present.
    expect(ansi.includes('line0')).toBe(false);
    s.dispose();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/server/logs/screen.test.ts
```

Expected: FAIL with "Cannot find module './screen.js'" or similar.

- [ ] **Step 4: Implement `ScreenState`**

Create `src/server/logs/screen.ts` with this content:

```ts
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/**
 * Server-side virtual terminal. Holds a headless xterm that parses every byte
 * emitted by the PTY, so we always know "the current screen" and can replay
 * it to a fresh client on connect or on refocus. This replaces raw-log
 * replay as the live-view source of truth.
 */
export class ScreenState {
  private term: Terminal;
  private serializer: SerializeAddon;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      // No scrollback needed for live-view snapshots; we only ever want the
      // current screen. Reducing scrollback also bounds memory per run.
      scrollback: 0,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }

  /**
   * Feed bytes into the terminal parser. Resolves when the parser has
   * consumed the chunk; callers that need `serialize()` to reflect the write
   * must await.
   */
  write(data: Uint8Array): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
  }

  /**
   * Produce an ANSI string that, when written into a fresh xterm of the same
   * dimensions, reproduces the current screen. `scrollback:0` ensures we do
   * not replay stale alternate-screen history.
   */
  serialize(): string {
    return this.serializer.serialize({ scrollback: 0 });
  }

  dispose(): void {
    this.term.dispose();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/server/logs/screen.test.ts
```

Expected: all four tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/logs/screen.ts src/server/logs/screen.test.ts
git commit -m "feat(logs): add ScreenState (headless xterm snapshot)"
```

---

## Task 2: Per-run `ScreenState` in `RunStreamRegistry` with lazy log rebuild

**Goal:** Give the registry a per-run `ScreenState` alongside the existing `Broadcaster`, `StateBroadcaster`, and `TypedBroadcaster`. When a client asks for a screen and one isn't in memory but the run's log file exists, rebuild from the log once.

**Files:**
- Modify: `src/server/logs/registry.ts`
- Modify: `src/server/logs/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these test cases to `src/server/logs/registry.test.ts`, inside the existing `describe` block:

```ts
  it('getOrCreateScreen returns the same ScreenState across calls for the same run id', () => {
    const r = new RunStreamRegistry();
    const a = r.getOrCreateScreen(42);
    const b = r.getOrCreateScreen(42);
    expect(a).toBe(b);
  });

  it('release() disposes the ScreenState and future getOrCreateScreen returns a fresh instance', () => {
    const r = new RunStreamRegistry();
    const first = r.getOrCreateScreen(99);
    r.release(99);
    const second = r.getOrCreateScreen(99);
    expect(second).not.toBe(first);
  });

  it('rebuildScreenFromLog: feeds file bytes through a new ScreenState that matches one fed the same bytes live', async () => {
    // Shared scenario: one live ScreenState, one rebuilt from file; both
    // should serialize identically.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ScreenState } = await import('./screen.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-screen-'));
    const logPath = path.join(dir, 'run.log');
    const payload = new TextEncoder().encode(
      'hello\r\n\x1b[31mred\x1b[0m\r\nline three\r\n'
    );
    fs.writeFileSync(logPath, payload);

    const live = new ScreenState(80, 24);
    await live.write(payload);

    const r = new RunStreamRegistry();
    const rebuilt = await r.rebuildScreenFromLog(1, logPath, 80, 24);
    expect(rebuilt.serialize()).toBe(live.serialize());

    live.dispose();
    r.release(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/server/logs/registry.test.ts
```

Expected: FAIL with "getOrCreateScreen is not a function" (and similar for `rebuildScreenFromLog`).

- [ ] **Step 3: Extend `RunStreamRegistry`**

Replace the full contents of `src/server/logs/registry.ts` with:

```ts
import fs from 'node:fs/promises';
import { Broadcaster } from './broadcaster.js';
import { StateBroadcaster } from './stateBroadcaster.js';
import { TypedBroadcaster } from './typedBroadcaster.js';
import { ScreenState } from './screen.js';
import type { RunWsUsageMessage, RunWsRateLimitMessage } from '../../shared/types.js';

export type RunEvent = RunWsUsageMessage | RunWsRateLimitMessage;

// Cap the replay volume when rebuilding a ScreenState from a run's log after
// a server restart. Alt-screen TUIs clear on every full repaint, so only the
// recent tail matters for reconstructing "current screen."
const REBUILD_TAIL_CAP = 50 * 1024 * 1024; // 50 MB

export class RunStreamRegistry {
  private bytes = new Map<number, Broadcaster>();
  private state = new Map<number, StateBroadcaster>();
  private events = new Map<number, TypedBroadcaster<RunEvent>>();
  private screens = new Map<number, ScreenState>();

  getOrCreate(runId: number): Broadcaster {
    let b = this.bytes.get(runId);
    if (!b) { b = new Broadcaster(); this.bytes.set(runId, b); }
    return b;
  }

  get(runId: number): Broadcaster | undefined {
    return this.bytes.get(runId);
  }

  getOrCreateState(runId: number): StateBroadcaster {
    let b = this.state.get(runId);
    if (!b) { b = new StateBroadcaster(); this.state.set(runId, b); }
    return b;
  }

  getState(runId: number): StateBroadcaster | undefined {
    return this.state.get(runId);
  }

  getOrCreateEvents(runId: number): TypedBroadcaster<RunEvent> {
    let b = this.events.get(runId);
    if (!b) { b = new TypedBroadcaster<RunEvent>(); this.events.set(runId, b); }
    return b;
  }

  /**
   * Per-run screen state. Created at default dims; callers resize once the
   * PTY's actual dimensions are known (via the orchestrator resize path).
   */
  getOrCreateScreen(runId: number, cols = 120, rows = 40): ScreenState {
    let s = this.screens.get(runId);
    if (!s) { s = new ScreenState(cols, rows); this.screens.set(runId, s); }
    return s;
  }

  getScreen(runId: number): ScreenState | undefined {
    return this.screens.get(runId);
  }

  /**
   * Rebuild a ScreenState by streaming an existing log file through a fresh
   * headless terminal. Used after a server restart when we have an active run
   * whose in-memory ScreenState is gone. Caps the replay at the tail
   * REBUILD_TAIL_CAP bytes — older bytes don't influence the final screen
   * in practice (alt-screen TUIs clear on every full repaint).
   */
  async rebuildScreenFromLog(
    runId: number,
    logPath: string,
    cols = 120,
    rows = 40,
  ): Promise<ScreenState> {
    const existing = this.screens.get(runId);
    if (existing) existing.dispose();
    const fresh = new ScreenState(cols, rows);
    this.screens.set(runId, fresh);
    try {
      const stat = await fs.stat(logPath);
      const size = stat.size;
      const start = size > REBUILD_TAIL_CAP ? size - REBUILD_TAIL_CAP : 0;
      const fd = await fs.open(logPath, 'r');
      try {
        // Read in 1 MB chunks; feed synchronously through the parser.
        const bufSize = 1024 * 1024;
        const buf = Buffer.alloc(bufSize);
        let pos = start;
        while (pos < size) {
          const toRead = Math.min(bufSize, size - pos);
          const { bytesRead } = await fd.read(buf, 0, toRead, pos);
          if (bytesRead === 0) break;
          await fresh.write(
            new Uint8Array(buf.buffer, buf.byteOffset, bytesRead).slice()
          );
          pos += bytesRead;
        }
      } finally {
        await fd.close();
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return fresh;
  }

  release(runId: number): void {
    this.bytes.delete(runId);
    this.state.delete(runId);
    this.events.delete(runId);
    const s = this.screens.get(runId);
    if (s) { s.dispose(); this.screens.delete(runId); }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/server/logs/registry.test.ts src/server/logs/screen.test.ts
```

Expected: all tests PASS (original four + three new).

- [ ] **Step 5: Commit**

```bash
git add src/server/logs/registry.ts src/server/logs/registry.test.ts
git commit -m "feat(logs): per-run ScreenState with lazy rebuild from log"
```

---

## Task 3: Fan bytes into `ScreenState`; wire resize

**Goal:** Every `onBytes` fanout in the orchestrator now also writes to the run's `ScreenState`. `Orchestrator.resize` additionally resizes the `ScreenState` so headless xterm tracks PTY dimensions.

**Files:**
- Modify: `src/server/orchestrator/index.ts`

The orchestrator has three separate `onBytes` constructions (launch, reattach, resume). Each creates `const store = new LogStore(...)` and `const broadcaster = this.deps.streams.getOrCreate(runId)`. We add one more line in each.

- [ ] **Step 1: Read the current orchestrator sections**

Run:
```bash
grep -n 'onBytes\|store.append\|broadcaster.publish\|streams.getOrCreate(' src/server/orchestrator/index.ts
```

Confirm three onBytes sites. They live roughly around lines 199–202, 394–396, 591–595 (exact lines may have drifted — trust grep output).

- [ ] **Step 2: Modify the launch onBytes (first site)**

In `src/server/orchestrator/index.ts`, find this block (around line 197):

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
    };
```

Replace it with:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
      // ScreenState.write returns a promise (parser is async). We don't
      // await — ordering is preserved internally by xterm-headless, and
      // snapshot callers tolerate "at most one frame stale."
      void screen.write(chunk);
    };
```

- [ ] **Step 3: Modify the reattach onBytes (second site)**

Find the second block (around line 394):

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => { store.append(chunk); broadcaster.publish(chunk); };
```

Replace with:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
      void screen.write(chunk);
    };
```

- [ ] **Step 4: Modify the resume onBytes (third site)**

Find the third block (around line 591):

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
    };
```

Replace with:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
      void screen.write(chunk);
    };
```

- [ ] **Step 5: Forward resize to ScreenState**

Find `resize(runId, cols, rows)` in the orchestrator. It currently looks roughly like:

```ts
  async resize(runId: number, cols: number, rows: number): Promise<void> {
    const a = this.live.get(runId);
    if (!a) return;
    await a.ptySession.resize(cols, rows);
  }
```

(The exact implementation may vary; find it by grep `async resize(runId`.) Add a ScreenState resize after the PTY resize:

```ts
  async resize(runId: number, cols: number, rows: number): Promise<void> {
    const a = this.live.get(runId);
    if (!a) return;
    await a.ptySession.resize(cols, rows);
    this.deps.streams.getScreen(runId)?.resize(cols, rows);
  }
```

If the method's actual implementation differs (e.g. uses `a.container.resize` or dockerode APIs), keep the existing body; only add the final `streams.getScreen(...)?.resize(...)` line.

- [ ] **Step 6: Run the full orchestrator test suite**

Run:
```bash
npx vitest run src/server/orchestrator
```

Expected: all existing tests PASS. (They don't check ScreenState yet; we just need to not regress.)

- [ ] **Step 7: Typecheck**

Run:
```bash
npx tsc -p tsconfig.server.json --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): fan bytes into ScreenState; forward resize"
```

---

## Task 4: Shared WS message types

**Goal:** Declare the new snapshot/resync message types so client and server share a vocabulary.

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Locate existing WS message types**

Run:
```bash
grep -n 'RunWs\(State\|Usage\|RateLimit\)Message' src/shared/types.ts
```

You will find types like `RunWsStateMessage`, `RunWsUsageMessage`, `RunWsRateLimitMessage`. Find the section where they're defined.

- [ ] **Step 2: Add the new types**

Append these type declarations in the same section (after the existing RunWs\*Message types):

```ts
/** Sent by the server as the opening text frame on live WS connect, and in
 *  response to a client-initiated resync. Carries the current screen state
 *  as an ANSI string that reproduces the screen when written into a fresh
 *  xterm of the same cols/rows. */
export interface RunWsSnapshotMessage {
  type: 'snapshot';
  ansi: string;
  cols: number;
  rows: number;
}

/** Sent by the client on window refocus / visibilitychange->visible to ask
 *  the server for a fresh snapshot frame. Body carries no payload. */
export interface RunWsResyncMessage {
  type: 'resync';
}
```

- [ ] **Step 3: Typecheck**

Run:
```bash
npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.web.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): add snapshot and resync WS message types"
```

---

## Task 5: Server WS — snapshot-first handshake, resync handler

**Goal:** Replace the "replay full log on connect" path (active runs) with: send a `{type:'snapshot'}` text frame first, then live bytes. Handle an inbound `{type:'resync'}` by re-serializing the ScreenState and sending a fresh snapshot frame. Finished-run path is unchanged.

**Files:**
- Modify: `src/server/api/ws.ts`

- [ ] **Step 1: Rewrite the active-run section of `ws.ts`**

Replace the full contents of `src/server/api/ws.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { RunsRepo } from '../db/runs.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { LogStore } from '../logs/store.js';

interface Orchestrator {
  writeStdin(runId: number, bytes: Uint8Array): void;
  resize(runId: number, cols: number, rows: number): Promise<void>;
  cancel(runId: number): Promise<void>;
}

interface Deps {
  runs: RunsRepo;
  streams: RunStreamRegistry;
  orchestrator: Orchestrator;
}

type ControlFrame =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'resync' };

export function registerWsRoute(app: FastifyInstance, deps: Deps): void {
  app.get('/api/runs/:id/shell', { websocket: true }, (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);

    if (!Number.isFinite(runId)) {
      socket.close(4004, 'invalid run id');
      return;
    }

    const run = deps.runs.get(runId);
    if (!run) {
      socket.close(4004, 'run not found');
      return;
    }

    const isLive = run.state === 'running' || run.state === 'queued' || run.state === 'awaiting_resume';

    // FINISHED runs: serve archival view — full log file, then close.
    if (!isLive) {
      const existing = LogStore.readAll(run.log_path);
      if (existing.length > 0) {
        socket.send(existing, () => {
          socket.close(1000, 'ended');
        });
      } else {
        socket.close(1000, 'ended');
      }
      return;
    }

    // LIVE runs: snapshot-first. Subscribe before sending snapshot so no live
    // bytes are missed during the snapshot build/send window; buffer any that
    // arrive in the window and flush immediately after.
    const bc = deps.streams.getOrCreate(runId);
    const buffered: Uint8Array[] = [];
    let live = false;
    const unsub = bc.subscribe(
      (chunk) => {
        if (!live) { buffered.push(chunk); return; }
        if (socket.readyState === socket.OPEN) {
          socket.send(chunk, (err) => { if (err) unsub(); });
        }
      },
      () => {
        try { socket.close(1000, 'ended'); } catch { /* noop */ }
      }
    );

    const ev = deps.streams.getOrCreateEvents(runId);
    const unsubEvents = ev.subscribe((msg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    });

    const stateBc = deps.streams.getOrCreateState(runId);
    const unsubState = stateBc.subscribe((frame) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    });

    // Build + send the initial snapshot. If no ScreenState exists yet
    // (e.g. fresh process, run is still spinning up and the orchestrator
    // hasn't wired the byte pipeline), lazily rebuild from the log file —
    // this also covers the "server was restarted mid-run" case.
    const sendSnapshot = async (): Promise<void> => {
      let screen = deps.streams.getScreen(runId);
      if (!screen) {
        screen = await deps.streams.rebuildScreenFromLog(runId, run.log_path);
      }
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({
        type: 'snapshot',
        ansi: screen.serialize(),
        cols: screen.cols,
        rows: screen.rows,
      }));
    };

    void sendSnapshot().then(() => {
      live = true;
      for (const chunk of buffered) {
        if (socket.readyState === socket.OPEN) {
          socket.send(chunk, (err) => { if (err) unsub(); });
        }
      }
      // Edge: broadcaster ended while we were building the snapshot.
      if (bc.isEnded()) {
        unsub();
        unsubEvents();
        unsubState();
        if (socket.readyState === socket.OPEN) socket.close(1000, 'ended');
      }
    });

    socket.on('message', async (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString('utf8')) as ControlFrame;
          if (msg.type === 'resize') {
            void deps.orchestrator.resize(runId, msg.cols, msg.rows);
            return;
          }
          if (msg.type === 'resync') {
            // Send a fresh snapshot. Any bytes arriving from the broadcaster
            // between this snapshot and the next delivered chunk are
            // strictly newer — the client drops its local queue on snapshot
            // arrival, so there's no double-apply risk.
            const screen = deps.streams.getScreen(runId);
            if (screen && socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                type: 'snapshot',
                ansi: screen.serialize(),
                cols: screen.cols,
                rows: screen.rows,
              }));
            }
            return;
          }
          return; // any other text frame: ignore, do not forward to stdin
        } catch { /* not valid JSON — fall through to stdin */ }
      }
      deps.orchestrator.writeStdin(runId, data);
    });

    socket.on('close', () => { unsub(); unsubState(); unsubEvents(); });
  });
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npx tsc -p tsconfig.server.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run all server tests**

Run:
```bash
npx vitest run src/server
```

Expected: all tests PASS (may be slower due to orchestrator integration tests; that's normal).

- [ ] **Step 4: Commit**

```bash
git add src/server/api/ws.ts
git commit -m "feat(ws): snapshot-first handshake; resync handler"
```

---

## Task 6: Integration test — snapshot handshake & resync

**Goal:** End-to-end test that (a) the first text frame a client receives is a snapshot, (b) sending a resync yields a fresh snapshot, and (c) no pre-resync bytes leak after the resync snapshot.

**Files:**
- Create: `src/server/api/ws.test.ts`

- [ ] **Step 1: Check for existing ws.test.ts**

Run:
```bash
ls src/server/api/ws.test.ts 2>/dev/null && echo EXISTS || echo NEW
```

If it EXISTS, append to it instead of creating. The content below assumes NEW; if appending, omit the imports and `describe` wrapper.

- [ ] **Step 2: Write the test**

Create `src/server/api/ws.test.ts` with:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket as WsClient } from 'ws';
import { registerWsRoute } from './ws.js';
import { RunStreamRegistry } from '../logs/registry.js';
import type { RunsRepo } from '../db/runs.js';

const enc = (s: string) => new TextEncoder().encode(s);

function stubRunsRepo(run: { id: number; state: string; log_path: string }): RunsRepo {
  return {
    get: (id: number) => (id === run.id ? run : undefined),
  } as unknown as RunsRepo;
}

function stubOrchestrator() {
  return {
    writeStdin: () => {},
    resize: async () => {},
    cancel: async () => {},
  };
}

async function makeApp(streams: RunStreamRegistry, run: { id: number; state: string; log_path: string }): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify();
  await app.register(websocket);
  registerWsRoute(app, {
    runs: stubRunsRepo(run),
    streams,
    orchestrator: stubOrchestrator(),
  });
  await app.listen({ port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, port };
}

function connect(port: number, runId: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/runs/${runId}/shell`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function next(ws: WsClient): Promise<{ kind: 'text' | 'binary'; data: string | Uint8Array }> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data: Buffer, isBinary: boolean) => {
      resolve(isBinary
        ? { kind: 'binary', data: new Uint8Array(data) }
        : { kind: 'text', data: data.toString('utf8') });
    });
    ws.once('error', reject);
  });
}

describe('ws route snapshot-first handshake', () => {
  const tmp = '/tmp/fbi-ws-test.log';
  let app: FastifyInstance | null = null;

  afterEach(async () => { if (app) { await app.close(); app = null; } });

  it('sends a snapshot text frame as the first message on active-run connect', async () => {
    const streams = new RunStreamRegistry();
    // Pre-populate a ScreenState so the route has something to serialize.
    const screen = streams.getOrCreateScreen(1, 80, 24);
    await screen.write(enc('hello world\r\n'));

    const made = await makeApp(streams, { id: 1, state: 'running', log_path: tmp });
    app = made.app;
    const ws = await connect(made.port, 1);
    const first = await next(ws);
    expect(first.kind).toBe('text');
    const msg = JSON.parse(first.data as string) as { type: string; ansi: string; cols: number; rows: number };
    expect(msg.type).toBe('snapshot');
    expect(typeof msg.ansi).toBe('string');
    expect(msg.cols).toBe(80);
    expect(msg.rows).toBe(24);
    ws.close();
  });

  it('responds to a resync message with a fresh snapshot reflecting newly-written bytes', async () => {
    const streams = new RunStreamRegistry();
    const screen = streams.getOrCreateScreen(2, 80, 24);
    await screen.write(enc('before\r\n'));

    const made = await makeApp(streams, { id: 2, state: 'running', log_path: tmp });
    app = made.app;
    const ws = await connect(made.port, 2);
    // Consume the initial snapshot.
    const first = await next(ws);
    expect((JSON.parse(first.data as string) as { type: string }).type).toBe('snapshot');

    // Simulate new bytes arriving after initial snapshot.
    await screen.write(enc('after-resync\r\n'));

    // Request a resync; expect a fresh snapshot frame.
    ws.send(JSON.stringify({ type: 'resync' }));
    const second = await next(ws);
    expect(second.kind).toBe('text');
    const m2 = JSON.parse(second.data as string) as { type: string; ansi: string };
    expect(m2.type).toBe('snapshot');
    expect(m2.ansi.includes('after-resync')).toBe(true);
    ws.close();
  });
});
```

- [ ] **Step 3: Run the tests**

Run:
```bash
npx vitest run src/server/api/ws.test.ts
```

Expected: both tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/api/ws.test.ts
git commit -m "test(ws): snapshot handshake and resync integration tests"
```

---

## Task 7: Client `ws.ts` — snapshot inbound, `sendResync` outbound

**Goal:** The `ShellHandle` gains `onSnapshot(cb)` and `sendResync()`. Snapshot frames are demultiplexed out of the typed-event stream so they don't get confused with state/usage/rate_limit events.

**Files:**
- Modify: `src/web/lib/ws.ts`

- [ ] **Step 1: Replace the full contents of `src/web/lib/ws.ts`**

New content:

```ts
import type { RunWsSnapshotMessage } from '@shared/types.js';

export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): () => void;
  onTypedEvent<T extends { type: string }>(cb: (msg: T) => void): () => void;
  onSnapshot(cb: (snap: RunWsSnapshotMessage) => void): () => void;
  onOpen(cb: () => void): void;
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  sendResync(): void;
  close(): void;
}

export function openShell(runId: number): ShellHandle {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/runs/${runId}/shell`);
  ws.binaryType = 'arraybuffer';
  const bytesCbs: Array<(d: Uint8Array) => void> = [];
  const typedCbs: Array<(msg: { type: string }) => void> = [];
  const snapshotCbs: Array<(s: RunWsSnapshotMessage) => void> = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data) as { type: string };
        if (msg.type === 'snapshot') {
          for (const cb of snapshotCbs) cb(msg as unknown as RunWsSnapshotMessage);
          return;
        }
        for (const cb of typedCbs) cb(msg);
      } catch {
        const data = new TextEncoder().encode(ev.data);
        for (const cb of bytesCbs) cb(data);
      }
      return;
    }
    const data = ev.data instanceof ArrayBuffer
      ? new Uint8Array(ev.data)
      : new TextEncoder().encode('');
    for (const cb of bytesCbs) cb(data);
  };
  return {
    onBytes: (cb) => {
      bytesCbs.push(cb);
      return () => { const i = bytesCbs.indexOf(cb); if (i !== -1) bytesCbs.splice(i, 1); };
    },
    onTypedEvent: <T extends { type: string }>(cb: (msg: T) => void) => {
      const wrapper = (msg: { type: string }) => cb(msg as T);
      typedCbs.push(wrapper);
      return () => { const i = typedCbs.indexOf(wrapper); if (i !== -1) typedCbs.splice(i, 1); };
    },
    onSnapshot: (cb) => {
      snapshotCbs.push(cb);
      return () => { const i = snapshotCbs.indexOf(cb); if (i !== -1) snapshotCbs.splice(i, 1); };
    },
    onOpen: (cb) => { ws.addEventListener('open', cb, { once: true }); },
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    resize: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    sendResync: () => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resync' }));
    },
    close: () => ws.close(),
  };
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npx tsc -p tsconfig.web.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/lib/ws.ts
git commit -m "feat(web/ws): onSnapshot + sendResync on ShellHandle"
```

---

## Task 8: Client `shellRegistry.ts` — drop byte buffer, expose snapshot & resync

**Goal:** Remove the 2 MB rolling byte buffer — the server is now authoritative for current screen. Expose `onSnapshot` and `requestResync` so the Terminal component can wire focus/blur to a fresh server snapshot.

**Files:**
- Modify: `src/web/lib/shellRegistry.ts`

- [ ] **Step 1: Replace the full contents of `src/web/lib/shellRegistry.ts`**

New content:

```ts
import { openShell, type ShellHandle } from './ws.js';
import type { RunWsSnapshotMessage } from '@shared/types.js';

interface Entry {
  shell: ShellHandle;
  refCount: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  lastSnapshot: RunWsSnapshotMessage | null;
}

const TTL_MS = 5 * 60_000; // keep the socket warm for 5min after last unmount

const cache = new Map<number, Entry>();

function makeEntry(runId: number): Entry {
  const shell = openShell(runId);
  const entry: Entry = { shell, refCount: 1, closeTimer: null, lastSnapshot: null };
  // Cache the most recent snapshot so a late-mounting Terminal component can
  // acquireShell() → getLastSnapshot() without needing to wait for another
  // server message. This is also what "resync returned a snapshot" caches.
  shell.onSnapshot((snap) => { entry.lastSnapshot = snap; });
  cache.set(runId, entry);
  return entry;
}

export function acquireShell(runId: number): ShellHandle {
  let entry = cache.get(runId);
  if (entry) {
    entry.refCount += 1;
    if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
    return entry.shell;
  }
  return makeEntry(runId).shell;
}

export function releaseShell(runId: number): void {
  const entry = cache.get(runId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.closeTimer = setTimeout(() => {
    entry.shell.close();
    cache.delete(runId);
  }, TTL_MS);
}

export function getLastSnapshot(runId: number): RunWsSnapshotMessage | null {
  return cache.get(runId)?.lastSnapshot ?? null;
}

export function requestResync(runId: number): void {
  cache.get(runId)?.shell.sendResync();
}

// For tests.
export function _reset(): void {
  for (const e of cache.values()) {
    if (e.closeTimer) clearTimeout(e.closeTimer);
    e.shell.close();
  }
  cache.clear();
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npx tsc -p tsconfig.web.json --noEmit
```

Expected: errors in `Terminal.tsx` about `getBuffer` no longer being exported. That's expected — Task 9 fixes it. If there are other errors, investigate.

- [ ] **Step 3: Commit (even though Terminal.tsx will error)**

Do NOT commit yet. This task's changes compile in isolation but break `Terminal.tsx`. Leave the files staged and continue to Task 9 in the same working tree. Commit at the end of Task 9.

---

## Task 9: `Terminal.tsx` — snapshot-driven first paint

**Goal:** Replace the "read `getBuffer`, trim to tail, writeReplay" dance with "wait for a snapshot frame, `term.reset()`, enqueueWrite the ANSI, then subscribe to live bytes."

**Files:**
- Modify: `src/web/components/Terminal.tsx`

- [ ] **Step 1: Replace the full contents of `src/web/components/Terminal.tsx`**

New content:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  acquireShell,
  releaseShell,
  getLastSnapshot,
  requestResync,
} from '../lib/shellRegistry.js';
import { publishUsage, publishRateLimit, publishState } from '../features/runs/usageBus.js';
import type {
  UsageSnapshot,
  RateLimitState,
  RunWsStateMessage,
} from '@shared/types.js';

interface Props {
  runId: number;
  interactive: boolean;
}

const WRITE_CHUNK = 16 * 1024;

function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const bg = s.getPropertyValue('--surface-sunken').trim() || '#0b0f14';
  return {
    background: bg,
    foreground: s.getPropertyValue('--text').trim() || '#e2e8f0',
    // Paint xterm's cursor the same colour as the background so it never
    // shows. Claude Code renders its own cursor inside the PTY output.
    cursor: bg,
    cursorAccent: bg,
  };
}

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const loadFullRef = useRef<() => void>(() => {});
  const [historyMode, setHistoryMode] = useState(false);

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

    const safeFit = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      try { fit.fit(); return true; } catch { return false; }
    };

    let disposed = false;

    // Frame-paced write queue. All writes — snapshot replay, live bytes,
    // history-mode load — go through this.
    const writeQueue: Uint8Array[] = [];
    let pumping = false;
    const pump = () => {
      if (disposed) { pumping = false; return; }
      const chunk = writeQueue.shift();
      if (!chunk) { pumping = false; return; }
      term.write(chunk);
      requestAnimationFrame(pump);
    };
    const enqueueWrite = (data: Uint8Array): void => {
      if (data.byteLength === 0) return;
      if (data.byteLength <= WRITE_CHUNK) {
        writeQueue.push(data);
      } else {
        let offset = 0;
        while (offset < data.byteLength) {
          const end = Math.min(offset + WRITE_CHUNK, data.byteLength);
          writeQueue.push(data.subarray(offset, end));
          offset = end;
        }
      }
      if (!pumping) {
        pumping = true;
        requestAnimationFrame(pump);
      }
    };

    const clearQueue = () => { writeQueue.length = 0; };

    const shell = acquireShell(runId);
    let unsubBytes: (() => void) | null = null;
    let unsubSnapshot: (() => void) | null = null;
    let ready = false; // true once first snapshot has been applied

    const applySnapshot = (ansi: string) => {
      clearQueue();
      term.reset();
      enqueueWrite(new TextEncoder().encode(ansi));
      ready = true;
    };

    // If another component has already acquired the shell and cached a
    // snapshot, apply it synchronously on mount — otherwise wait for one.
    const cached = getLastSnapshot(runId);
    if (cached) applySnapshot(cached.ansi);

    unsubSnapshot = shell.onSnapshot((snap) => {
      // Every snapshot (initial OR resync response) resets the view.
      applySnapshot(snap.ansi);
    });

    unsubBytes = shell.onBytes((data) => {
      // Drop live bytes until the first snapshot has arrived; the snapshot
      // encodes the initial state, and out-of-order pre-snapshot bytes would
      // corrupt it. After ready=true, forward everything.
      if (!ready) return;
      enqueueWrite(data);
    });

    if (interactive) term.focus();

    const observer = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Debounced resize — the fit addon's getBoundingClientRect can be
    // expensive, and SplitPane/window drags fire continuously.
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const runFit = () => {
      roTimer = null;
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
    };
    const ro = new ResizeObserver(() => {
      if (roTimer !== null) clearTimeout(roTimer);
      roTimer = setTimeout(runFit, 120);
    });
    ro.observe(host);

    let winResizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      winResizeTimer = setTimeout(() => {
        winResizeTimer = null;
        if (safeFit() && interactive) shell.resize(term.cols, term.rows);
      }, 120);
    };
    window.addEventListener('resize', onResize);

    const unsubEv = shell.onTypedEvent<{ type: string; snapshot?: unknown }>((msg) => {
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'rate_limit') publishRateLimit(runId, msg.snapshot as RateLimitState);
      else if (msg.type === 'state') publishState(runId, msg as unknown as RunWsStateMessage);
    });

    // Focus/blur/visibility triggers the fast-forward fix. When the window
    // has been blurred or the tab hidden, rAF has been throttled and the
    // write queue may have filled with stale bytes. On return, drop the
    // queue and ask the server for a fresh snapshot.
    let stale = false;
    const markStale = () => { stale = true; };
    const refresh = () => {
      if (!stale) return;
      stale = false;
      clearQueue();
      requestResync(runId);
      // The next snapshot frame will land via unsubSnapshot → applySnapshot.
    };
    const onVisChange = () => {
      if (document.hidden) markStale();
      else refresh();
    };
    window.addEventListener('blur', markStale);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisChange);

    shell.onOpen(() => {
      if (safeFit() && interactive) shell.resize(term.cols, term.rows);
    });

    // "Load full history": fetch the log file and render it instead of the
    // live view. Exposed via loadFullRef so the JSX button can call it.
    loadFullRef.current = async () => {
      if (disposed) return;
      setHistoryMode(true);
      if (unsubBytes) { unsubBytes(); unsubBytes = null; }
      if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
      clearQueue();
      term.reset();
      try {
        const res = await fetch(`/api/runs/${runId}/transcript`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        enqueueWrite(buf);
      } catch {
        enqueueWrite(new TextEncoder().encode('\r\n[failed to load history]\r\n'));
      }
    };

    const resumeLive = () => {
      if (disposed) return;
      setHistoryMode(false);
      clearQueue();
      term.reset();
      ready = false;
      unsubSnapshot = shell.onSnapshot((snap) => applySnapshot(snap.ansi));
      unsubBytes = shell.onBytes((data) => { if (ready) enqueueWrite(data); });
      requestResync(runId);
    };
    // Stash resumeLive on the ref so the JSX button can call it.
    (loadFullRef as unknown as { resume?: () => void }).resume = resumeLive;

    if (interactive) {
      term.onData((d) => shell.send(new TextEncoder().encode(d)));
      host.addEventListener('click', () => term.focus());
    }

    return () => {
      disposed = true;
      if (roTimer !== null) clearTimeout(roTimer);
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      ro.disconnect();
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', markStale);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisChange);
      if (unsubBytes) unsubBytes();
      if (unsubSnapshot) unsubSnapshot();
      unsubEv();
      releaseShell(runId);
      term.dispose();
    };
  }, [runId, interactive]);

  return (
    <div className="relative h-full w-full bg-surface-sunken">
      {!historyMode && (
        <div className="absolute top-1 right-2 z-10">
          <button
            type="button"
            onClick={() => loadFullRef.current()}
            className="text-[11px] text-text-dim hover:text-text transition-colors duration-fast ease-out"
          >
            Load full history
          </button>
        </div>
      )}
      {historyMode && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
          <span>Viewing full history (live updates paused).</span>
          <button
            type="button"
            onClick={() => (loadFullRef as unknown as { resume?: () => void }).resume?.()}
            className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
          >
            Resume live
          </button>
        </div>
      )}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npx tsc -p tsconfig.web.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run web tests**

Run:
```bash
npx vitest run src/web
```

Expected: all existing web tests PASS. (Terminal has no unit test by default; we rely on manual validation in Task 10.)

- [ ] **Step 4: Commit (covers Task 8 + Task 9)**

```bash
git add src/web/lib/shellRegistry.ts src/web/components/Terminal.tsx
git commit -m "feat(web/terminal): snapshot-driven first paint; focus/blur resync; history mode"
```

---

## Task 10: Manual browser validation

**Goal:** Confirm the reported bugs are fixed and nothing else regressed.

**Files:** none (runtime validation).

- [ ] **Step 1: Start the dev server**

Run:
```bash
scripts/dev.sh
```

Expected: Vite + Fastify start; URL printed in the terminal.

- [ ] **Step 2: Create / pick a long-running run**

Use the UI to kick off (or resume) a run with Claude Code that will be actively working for at least a couple of minutes.

- [ ] **Step 3: Initial-paint test**

Navigate to that run. Verify:
- The terminal shows the **current screen immediately**, not a scroll-past of older frames.
- No visible "time-lapse" on mount.

- [ ] **Step 4: Refocus / fast-forward test**

1. With the terminal open and Claude Code actively producing output, click into another application (fully unfocus the window) for 60+ seconds.
2. Return focus to the browser window.
3. Verify:
   - **No fast-forward.** The view jumps smoothly to the current screen.
   - **Cursor glyph is present** in the chat input area both before and after the refocus cycle.

- [ ] **Step 5: Tab-hide test**

1. Switch to another tab for 60+ seconds (not another window — same browser, different tab).
2. Return to the tab.
3. Verify same criteria as Step 4.

- [ ] **Step 6: Input-latency check**

Immediately after refocus, type into the terminal. Keystrokes should appear in <100 ms with no stalling.

- [ ] **Step 7: Load full history / Resume live**

1. Click "Load full history." Verify the scrollback of the whole run loads.
2. Click "Resume live." Verify the view switches back to current screen.

- [ ] **Step 8: Multi-tab test**

Open the same run in two tabs simultaneously. Verify both show the same current screen. Fast-forward on either tab's refocus behaves as in Step 4.

- [ ] **Step 9: Server-restart test**

1. With an active run visible, restart the dev server (Ctrl-C in `scripts/dev.sh`, then rerun).
2. The client WS will reconnect automatically (or hard-reload the page).
3. Verify the terminal lands on the current screen with no errors in the browser console or server logs.

- [ ] **Step 10: Commit the plan / validation completion**

This task is runtime validation; nothing to commit. If any step above fails, open an issue against this plan and file a follow-up task before merging.

---

## Self-review

Verified each spec section has at least one task that implements it:

- Server-side virtual terminal → Tasks 1, 2, 3
- Snapshot-first WS handshake → Task 5
- Resync on refocus → Task 5 (server) + Task 7 (client ws) + Task 9 (client term)
- Client buffer removal → Task 8
- Focus/blur/visibility triggers → Task 9
- Load full history → Task 9 (uses existing `/api/runs/:id/transcript`)
- Server-restart rebuild → Task 2 (`rebuildScreenFromLog`) + Task 5 (invoked on connect if no in-memory screen)
- Resize wiring to ScreenState → Task 3
- Resync race handling → Task 5 (client drops write queue on snapshot arrival; server flushes buffered bytes after snapshot)
- Unit tests for ScreenState → Task 1
- Registry lifecycle tests → Task 2
- Integration tests → Task 6
- Manual validation → Task 10

No placeholders, no "TBD." Types consistent (`RunWsSnapshotMessage`, `RunWsResyncMessage` defined once in shared/types; used by server `ws.ts`, client `ws.ts`, and `shellRegistry.ts`). Function names consistent (`getOrCreateScreen`, `getScreen`, `rebuildScreenFromLog`, `getLastSnapshot`, `requestResync`, `sendResync`).
