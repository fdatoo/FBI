# Terminal Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the terminal reliably render on new run, Continue, and state transitions without requiring a tab-switch workaround; make "Load full history" non-destructive so typing is never blocked; eliminate the recurring drift where `continueRun` forgets to update the server-side `ScreenState`.

**Architecture:** Keep the long-lived xterm instance across `interactive` state changes (split `Terminal.tsx`'s single useEffect into a mount effect + an input-wiring effect + a fit/resize effect). Replace `shell.onOpen({once:true})` with a reliable `onOpenOrNow` helper so the dim-handshake runs on every fit-effect run, not just the first WS open. Render "Load full history" in a second, sibling xterm that does not tear down the live view. On the server, dedupe the four copies of `onBytes` into a single helper so new code paths cannot forget to feed `ScreenState` the way `continueRun` currently does.

**Tech Stack:** TypeScript (Node 20+, browser), React 18, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/headless`, `@xterm/addon-serialize`, Vitest + happy-dom, Playwright (via MCP for manual end-to-end verification).

---

## Spec reference

Design spec: `docs/superpowers/specs/2026-04-23-terminal-hardening-design.md`. Read before starting.

## File structure

**New files**

- `src/server/logs/onBytes.ts` — exported `makeOnBytes(store, broadcaster, screen)` helper used by every orchestrator path that pumps PTY bytes.
- `src/server/logs/onBytes.test.ts` — unit tests for the helper.

**Modified files**

- `src/server/orchestrator/index.ts` — replace the four inline `onBytes` closures (`launch` ~258, `resume` ~509, `continueRun` ~611, `reattach` ~836) with calls to `makeOnBytes`. `continueRun` was missing `screen.write`; this is the primary production bug the refactor fixes.
- `src/server/orchestrator/continueRun.flow.test.ts` — extend the happy-path test with an assertion that `streams.getScreen(runId)` reflects `[fbi] continuing` bytes during the continue.
- `src/web/lib/ws.ts` — rename `onOpen(cb)` to `onOpenOrNow(cb)`; implementation fires `cb` on the next microtask if the socket is already OPEN, else attaches an `open` listener (no `{once: true}`).
- `src/web/components/Terminal.tsx` — split the single useEffect into: (A) mount effect keyed on `[runId]`, (B) input-wiring effect keyed on `[interactive]`, (C) fit/resize effect keyed on `[interactive]`. Drop the `if (!ready) return;` gate on the live-bytes handler. Replace the destructive `loadFullRef.current` with a history-xterm sibling in the same host div, toggled via `display: none` on the live host.

**Unchanged but referenced**

- `src/server/logs/screen.ts`, `broadcaster.ts`, `store.ts` — used by `makeOnBytes`.
- `src/server/logs/registry.ts` — `getOrCreateScreen` is the source of the `ScreenState` passed into `makeOnBytes`.
- `src/web/lib/shellRegistry.ts` — `acquireShell`/`releaseShell` untouched; the cache survives across re-mounts as today.
- `scripts/dev.sh` — used for the Playwright MCP verification steps at the end.

---

## Task 1: Server — `makeOnBytes` helper skeleton + failing test

**Files:**
- Create: `src/server/logs/onBytes.ts`
- Create: `src/server/logs/onBytes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/logs/onBytes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOnBytes } from './onBytes.js';
import { LogStore } from './store.js';
import { Broadcaster } from './broadcaster.js';
import { ScreenState } from './screen.js';

describe('makeOnBytes', () => {
  it('fans one chunk out to store.append, broadcaster.publish, and screen.write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-onbytes-'));
    const store = new LogStore(path.join(dir, 'run.log'));
    const broadcaster = new Broadcaster();
    const screen = new ScreenState(80, 24);
    const received: Uint8Array[] = [];
    broadcaster.subscribe((c) => received.push(c));

    const appendSpy = vi.spyOn(store, 'append');
    const publishSpy = vi.spyOn(broadcaster, 'publish');
    const writeSpy = vi.spyOn(screen, 'write');

    const onBytes = makeOnBytes(store, broadcaster, screen);
    const chunk = new TextEncoder().encode('hello\r\n');
    onBytes(chunk);

    expect(appendSpy).toHaveBeenCalledWith(chunk);
    expect(publishSpy).toHaveBeenCalledWith(chunk);
    expect(writeSpy).toHaveBeenCalledWith(chunk);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(chunk);

    // Give ScreenState's async parser a tick to finish.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.serialize()).toContain('hello');

    store.close();
    screen.dispose();
  });

  it('swallows screen.write rejections so a misbehaving screen cannot break the broadcaster', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-onbytes-'));
    const store = new LogStore(path.join(dir, 'run.log'));
    const broadcaster = new Broadcaster();
    const screen = {
      write: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as ScreenState;

    const onBytes = makeOnBytes(store, broadcaster, screen);
    expect(() => onBytes(new Uint8Array([1, 2, 3]))).not.toThrow();

    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/server/logs/onBytes.test.ts
```
Expected: FAIL with "Cannot find module './onBytes.js'" or equivalent.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/logs/onBytes.ts`:

```ts
import type { LogStore } from './store.js';
import type { Broadcaster } from './broadcaster.js';
import type { ScreenState } from './screen.js';

/**
 * Build the fan-out callback for PTY bytes. Every orchestrator path that
 * consumes PTY output (launch, resume, continueRun, reattach) must use
 * this — feeding one sink but not another is the class of bug that
 * caused the "continueRun doesn't update ScreenState" drift.
 *
 * `screen.write` returns a promise (xterm-headless parser is async); we
 * don't await — xterm preserves write ordering internally, and snapshot
 * callers tolerate "at most one frame stale."
 */
export function makeOnBytes(
  store: LogStore,
  broadcaster: Broadcaster,
  screen: ScreenState,
): (chunk: Uint8Array) => void {
  return (chunk) => {
    store.append(chunk);
    broadcaster.publish(chunk);
    void screen.write(chunk).catch(() => {});
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/server/logs/onBytes.test.ts
```
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/server/logs/onBytes.ts src/server/logs/onBytes.test.ts
git commit -m "feat(logs): makeOnBytes helper fans PTY bytes to store+broadcaster+screen"
```

---

## Task 2: Server — use `makeOnBytes` in `continueRun` (the bug fix)

**Files:**
- Modify: `src/server/orchestrator/index.ts` (`continueRun`, lines ~604–672)
- Modify: `src/server/orchestrator/continueRun.flow.test.ts` (regression assertion)

- [ ] **Step 1: Write the regression test**

Open `src/server/orchestrator/continueRun.flow.test.ts`. Locate the test at line 99: `'revives a failed run with a captured session and transitions failed → running → succeeded'`. Modify `makeSuccessContainer` at line 50 to emit a distinctive byte pattern we can look for, by changing the pushed chunk:

```ts
function makeSuccessContainer(): Docker.Container {
  const attachStream = new PassThrough();
  let resultTar: NodeJS.ReadableStream | undefined;
  return {
    id: 'continue-container',
    putArchive: async () => {},
    attach: async () => attachStream,
    start: async () => {
      resultTar = await makeResultTar(0, 0, 'cafe', 'feat/keep-going');
      attachStream.push(Buffer.from('CONTINUE-OUTPUT-MARKER\n'));
      attachStream.push(null);
    },
    wait: async () => ({ StatusCode: 0 }),
    inspect: async () => ({ State: { OOMKilled: false } }),
    getArchive: async () => resultTar!,
    remove: async () => {},
  } as unknown as Docker.Container;
}
```

Then add a new test AFTER line 138 (before the `rejects a run without a captured session id` test):

```ts
  it('feeds continue-emitted bytes through ScreenState so a resync during the continue would show them', async () => {
    const { dir, runs, p, streams, makeOrchestrator } = setup();
    const run = runs.create({
      project_id: p.id, prompt: 'keep going',
      branch_hint: 'feat/keep-going',
      log_path_tmpl: (id) => path.join(os.tmpdir(), `cont-${id}.log`),
    });
    runs.markStarted(run.id, 'c1');
    runs.setClaudeSessionId(run.id, 'sess-xyz');
    runs.markFinished(run.id, { state: 'failed', error: 'OOM' });
    const sessDir = runMountDir(dir, run.id);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'sess-xyz.jsonl'), '{"x":1}\n');

    // Capture the screen the orchestrator creates for this run so we can
    // inspect it after the run ends (streams.release disposes the real one).
    const captured: { screen: ReturnType<typeof streams.getOrCreateScreen> | null } = { screen: null };
    const origGetOrCreate = streams.getOrCreateScreen.bind(streams);
    vi.spyOn(streams, 'getOrCreateScreen').mockImplementation((id, cols, rows) => {
      const s = origGetOrCreate(id, cols, rows);
      if (id === run.id) captured.screen = s;
      return s;
    });

    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(makeSuccessContainer()),
    } as unknown as Docker;
    const orch = makeOrchestrator(mockDocker);
    await orch.continueRun(run.id);

    expect(captured.screen).not.toBeNull();
    // The captured reference is the same object the orchestrator fed; dispose()
    // does not clear the SerializeAddon's snapshot, so we can still serialize.
    const ansi = captured.screen!.serialize();
    expect(ansi).toContain('continuing from session');
    expect(ansi).toContain('CONTINUE-OUTPUT-MARKER');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/server/orchestrator/continueRun.flow.test.ts -t 'feeds continue-emitted bytes'
```
Expected: FAIL. The screen either is never captured (getOrCreateScreen never called in continueRun) or its serialize output does not contain the marker.

- [ ] **Step 3: Switch `continueRun` to `makeOnBytes`**

In `src/server/orchestrator/index.ts`, at the top add:

```ts
import { makeOnBytes } from '../logs/onBytes.js';
```

Locate `continueRun` (around line 604). Replace the existing `onBytes` block (approximately lines 610–613):

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => { store.append(chunk); broadcaster.publish(chunk); };
    onBytes(Buffer.from(`\n[fbi] continuing from session ${run.claude_session_id}\n`));
```

with:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = makeOnBytes(store, broadcaster, screen);
    onBytes(Buffer.from(`\n[fbi] continuing from session ${run.claude_session_id}\n`));
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/server/orchestrator/continueRun.flow.test.ts
```
Expected: PASS for all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/continueRun.flow.test.ts
git commit -m "fix(orchestrator): continueRun feeds ScreenState so resyncs reflect continued output"
```

---

## Task 3: Server — use `makeOnBytes` in `launch`, `resume`, `reattach`

**Files:**
- Modify: `src/server/orchestrator/index.ts` (`launch` ~256–265, `resume` ~506–513, `reattach` ~833–840)

- [ ] **Step 1: Replace `launch`'s onBytes**

In `launch` (around lines 255–265), find:

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
      void screen.write(chunk).catch(() => {});
    };
```

Replace with:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = makeOnBytes(store, broadcaster, screen);
```

- [ ] **Step 2: Replace `resume`'s onBytes**

In `resume` (around lines 505–513), find:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
      void screen.write(chunk).catch(() => {});
    };
```

Replace with:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = makeOnBytes(store, broadcaster, screen);
```

- [ ] **Step 3: Replace `reattach`'s onBytes**

In `reattach` (around lines 833–840), find:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
      void screen.write(chunk).catch(() => {});
    };
```

Replace with:

```ts
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const screen = this.deps.streams.getOrCreateScreen(runId);
    const onBytes = makeOnBytes(store, broadcaster, screen);
```

- [ ] **Step 4: Run the full orchestrator test suite**

Run:
```bash
npx vitest run src/server/orchestrator
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "refactor(orchestrator): dedupe onBytes into makeOnBytes helper across all four paths"
```

---

## Task 4: Client — replace `onOpen` with `onOpenOrNow` (TDD)

**Files:**
- Modify: `src/web/lib/ws.ts`
- Create: `src/web/lib/ws.test.ts`
- Modify: `src/web/components/Terminal.tsx` (single call site, line ~276)

- [ ] **Step 1: Write the failing test**

Create `src/web/lib/ws.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We have to mock the global WebSocket constructor because happy-dom's
// implementation won't actually connect. We care about our wrapper's
// state-handling logic, not real networking.
class MockWs {
  static instances: MockWs[] = [];
  readyState = 0; // CONNECTING
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  listeners = new Map<string, Array<(e: Event) => void>>();
  onmessage: ((e: MessageEvent) => void) | null = null;
  binaryType = '';
  constructor(_url: string) { MockWs.instances.push(this); }
  addEventListener(type: string, fn: (e: Event) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  send() {}
  close() { this.readyState = MockWs.CLOSED; }
  fireOpen() {
    this.readyState = MockWs.OPEN;
    (this.listeners.get('open') ?? []).forEach((f) => f(new Event('open')));
  }
}

beforeEach(() => {
  MockWs.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = MockWs;
});

afterEach(() => {
  MockWs.instances = [];
});

describe('ShellHandle.onOpenOrNow', () => {
  it('fires the callback asynchronously when the socket is already OPEN', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(42);
    const ws = MockWs.instances[0];
    ws.fireOpen();
    const cb = vi.fn();
    shell.onOpenOrNow(cb);
    // microtask flush
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires the callback when the socket transitions to OPEN later', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(43);
    const ws = MockWs.instances[0];
    const cb = vi.fn();
    shell.onOpenOrNow(cb);
    expect(cb).not.toHaveBeenCalled();
    ws.fireOpen();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('supports multiple independent callers (no {once:true} behavior)', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(44);
    const ws = MockWs.instances[0];
    ws.fireOpen();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    shell.onOpenOrNow(cb1);
    shell.onOpenOrNow(cb2);
    await Promise.resolve();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/web/lib/ws.test.ts
```
Expected: FAIL with "shell.onOpenOrNow is not a function" or similar.

- [ ] **Step 3: Update `ShellHandle` interface and implementation**

In `src/web/lib/ws.ts`:

Change the interface (line ~4):

```ts
export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): () => void;
  onTypedEvent<T extends { type: string }>(cb: (msg: T) => void): () => void;
  onSnapshot(cb: (snap: RunWsSnapshotMessage) => void): () => void;
  onOpenOrNow(cb: () => void): void;
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  sendResync(): void;
  close(): void;
}
```

Replace the existing `onOpen` handler (line ~67):

```ts
    onOpen: (cb) => { ws.addEventListener('open', cb, { once: true }); },
```

with:

```ts
    onOpenOrNow: (cb) => {
      if (ws.readyState === WebSocket.OPEN) {
        queueMicrotask(cb);
      } else {
        ws.addEventListener('open', cb);
      }
    },
```

- [ ] **Step 4: Update the single existing caller in `Terminal.tsx`**

In `src/web/components/Terminal.tsx`, line ~276, change:

```ts
    shell.onOpen(() => {
      if (interactive && safeFit()) shell.resize(term.cols, term.rows);
    });
```

to:

```ts
    shell.onOpenOrNow(() => {
      if (interactive && safeFit()) shell.resize(term.cols, term.rows);
    });
```

(The broader restructuring of this callsite happens in Task 5; this keeps it compiling.)

- [ ] **Step 5: Run the tests to verify pass**

Run:
```bash
npx vitest run src/web/lib/ws.test.ts && npm run typecheck
```
Expected: all pass. Typecheck must succeed because the interface renamed a method.

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/ws.ts src/web/lib/ws.test.ts src/web/components/Terminal.tsx
git commit -m "feat(web/ws): replace onOpen once:true with onOpenOrNow for reliable dim handshake"
```

---

## Task 5: Client — split `Terminal.tsx` useEffect; keep xterm alive across `interactive` flip

**Files:**
- Modify: `src/web/components/Terminal.tsx`

This task is the biggest change. Break it into steps carefully.

- [ ] **Step 1: Extract the input-wiring into its own effect**

In `src/web/components/Terminal.tsx`, locate the block inside the main useEffect (around lines 342–348):

```ts
    if (interactive) {
      term.onData((d) => {
        traceRecord('term.input', strPreview(d));
        shell.send(new TextEncoder().encode(d));
      });
      host.addEventListener('click', () => term.focus());
    }
```

Remove it from the main useEffect. We'll reintroduce input wiring in a separate effect after Step 4 completes.

To make the `term` and `shell` references available to the new effect, lift them to `useRef`s. At the top of the component, above the existing useEffect:

```ts
  const termRef = useRef<Xterm | null>(null);
  const shellRef = useRef<ShellHandle | null>(null);
```

(Add `import type { ShellHandle } from '../lib/ws.js';` at the top of the file.)

Inside the main useEffect, after `const term = new Xterm(...)` and `const shell = acquireShell(runId)`, assign:

```ts
    termRef.current = term;
    shellRef.current = shell;
```

And in the cleanup (the `return () => { ... }` block at the bottom), before `term.dispose()`:

```ts
      termRef.current = null;
      shellRef.current = null;
```

- [ ] **Step 2: Change the main useEffect dep list to `[runId]` only**

Change the dependency list (line ~367) from:

```ts
  }, [runId, interactive]);
```

to:

```ts
  }, [runId]);
```

This is the critical change: xterm is no longer disposed when `interactive` flips.

Note: the body still references `interactive`. We need to keep that closure reading a stable variable. Add, just inside the effect, right after `const host = hostRef.current; if (!host) return;`:

```ts
    // `interactive` is tracked in a ref so state transitions do not re-run
    // this effect (which would dispose + recreate the xterm). The input-
    // wiring and fit/resize effects below read the ref on each toggle.
    interactiveRef.current = interactive;
```

At the top of the component, add:

```ts
  const interactiveRef = useRef<boolean>(interactive);
  useEffect(() => { interactiveRef.current = interactive; }, [interactive]);
```

Replace in-effect reads of `interactive` with `interactiveRef.current`. The references are at roughly these spots (around lines 148, 181, 209, 225, 238, 277, 342): change each `interactive` (as a value read, not a prop) to `interactiveRef.current`. **Do not** change the initial `interactiveRef` initializer.

- [ ] **Step 3: Add the input-wiring effect**

Below the main useEffect (after the closing `}, [runId]);`), add:

```ts
  // Toggle input forwarding when `interactive` flips, without touching the
  // xterm instance. `termRef` and `shellRef` outlive the parent effect's
  // dependency changes.
  useEffect(() => {
    const term = termRef.current;
    const shell = shellRef.current;
    if (!term || !shell) return;
    if (!interactive) return;
    const dataDisposable = term.onData((d) => {
      traceRecord('term.input', strPreview(d));
      shell.send(new TextEncoder().encode(d));
    });
    const onClick = () => term.focus();
    const host = hostRef.current;
    host?.addEventListener('click', onClick);
    return () => {
      dataDisposable.dispose();
      host?.removeEventListener('click', onClick);
    };
  }, [interactive]);
```

- [ ] **Step 4: Add the fit/resize effect**

Immediately below the input-wiring effect, add:

```ts
  // Each time `interactive` becomes true, run the dim handshake: fit the
  // xterm to its host and tell the server. We can't rely on the WS's
  // 'open' event — after the first open, it never fires again, but a run
  // transitioning into 'running'/'waiting' needs the handshake to run.
  useEffect(() => {
    if (!interactive) return;
    const term = termRef.current;
    const shell = shellRef.current;
    const host = hostRef.current;
    if (!term || !shell || !host) return;
    shell.onOpenOrNow(() => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        // Can't call safeFit (it's scoped inside the mount effect); inline the
        // equivalent. If the fit addon fails, bail — the ResizeObserver in
        // the mount effect will retry as the container settles.
        const fit = (term as unknown as { _addonManager?: { _addons?: Array<{ instance?: { fit?: () => void } }> } })
          ._addonManager?._addons?.find((a) => typeof a.instance?.fit === 'function')?.instance;
        fit?.fit?.();
        shell.resize(term.cols, term.rows);
        traceRecord('term.interactiveFit', { cols: term.cols, rows: term.rows });
      } catch { /* retry via ResizeObserver */ }
    });
  }, [interactive]);
```

Note: if the "reach into xterm internals for the fit addon" approach is ugly, extract a `fitRef` in Step 1 alongside `termRef` and `shellRef`, and use `fitRef.current.fit()` here. Prefer the clean version:

In Step 1 add:

```ts
  const fitRef = useRef<FitAddon | null>(null);
```

And in the main effect, after `term.loadAddon(fit);`:

```ts
    fitRef.current = fit;
```

And in cleanup:

```ts
      fitRef.current = null;
```

Then the fit/resize effect becomes:

```ts
  useEffect(() => {
    if (!interactive) return;
    const term = termRef.current;
    const shell = shellRef.current;
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!term || !shell || !host || !fit) return;
    shell.onOpenOrNow(() => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        fit.fit();
        shell.resize(term.cols, term.rows);
        traceRecord('term.interactiveFit', { cols: term.cols, rows: term.rows });
      } catch { /* retry via ResizeObserver */ }
    });
  }, [interactive]);
```

Use this clean version. Drop the internals-peeking variant.

- [ ] **Step 5: Run the full test suite + typecheck + lint**

Run:
```bash
npm run typecheck && npm run lint && npx vitest run
```
Expected: all pass. Most existing terminal tests are not about this behavior, so they should be unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/Terminal.tsx
git commit -m "fix(terminal): keep xterm alive across interactive flips; split effects"
```

---

## Task 6: Client — drop the `ready=false` drop gate on live bytes

**Files:**
- Modify: `src/web/components/Terminal.tsx`

- [ ] **Step 1: Remove the `ready` gate**

In the main useEffect, find (around lines 201–207):

```ts
    unsubBytes = shell.onBytes((data) => {
      // Drop live bytes until the first snapshot has arrived; the snapshot
      // encodes the initial state, and out-of-order pre-snapshot bytes would
      // corrupt it. After ready=true, forward everything.
      if (!ready) return;
      enqueueWrite(data);
    });
```

Replace with:

```ts
    unsubBytes = shell.onBytes((data) => {
      // Forward live bytes unconditionally. The leading `modesAnsi` of any
      // subsequent snapshot (which ends in ?1049h or ?1049l\x1b[H\x1b[2J)
      // wipes the screen, so early live bytes are visually harmless. This
      // avoids the symptom where a re-mount loses all live bytes while the
      // dim handshake is still negotiating.
      enqueueWrite(data);
    });
```

You can now also drop the `let ready = false;` declaration and all other reads/writes to `ready` in this effect. Specifically:
- Remove `let ready = false;` (~line 141).
- Remove `ready = true;` inside `applySnapshot` (~line 173).
- In the `resumeLive` function (~line 317), remove `ready = false;` (this function is being replaced entirely in Task 7; if Task 7 hasn't landed yet, leave this occurrence alone and let Task 7 remove `resumeLive`).
- Remove `unsubBytes = shell.onBytes((data) => { if (ready) enqueueWrite(data); });` re-subscribe in `resumeLive` — replaced in Task 7.

- [ ] **Step 2: Run typecheck and tests**

Run:
```bash
npm run typecheck && npx vitest run
```
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/Terminal.tsx
git commit -m "fix(terminal): stream live bytes without waiting for first snapshot"
```

---

## Task 7: Client — non-destructive "Load full history"

**Files:**
- Modify: `src/web/components/Terminal.tsx`

Rewrite `loadFullRef` to create a sibling xterm whose host div overlays the live one. The live host gets `display: none`; the history xterm is disposed on "Resume live."

- [ ] **Step 1: Add a history-xterm ref and host**

At the top of the component add:

```ts
  const historyHostRef = useRef<HTMLDivElement>(null);
```

In the JSX, replace the current single host div (line ~413):

```tsx
      <div ref={hostRef} className="h-full w-full" />
```

with a pair:

```tsx
      <div
        ref={hostRef}
        className="h-full w-full"
        style={{ display: historyMode ? 'none' : 'block' }}
      />
      {historyMode && (
        <div ref={historyHostRef} className="absolute inset-0 h-full w-full bg-surface-sunken" />
      )}
```

- [ ] **Step 2: Replace `loadFullRef.current` and `resumeLive`**

Delete the current bodies (approximately lines 281–340) of `loadFullRef.current = async () => { ... };` and `const resumeLive = () => { ... };` and the line that stashes `resumeLive` on the ref. Replace with:

```ts
    // History mode: render the transcript in a *separate* xterm instance
    // mounted in a sibling DOM node. The live xterm and its subscriptions
    // keep running in the background (hidden via display:none on the host).
    // Resuming "live" simply disposes the history xterm; no resync roundtrip,
    // no dropped bytes, no input-blocking.
    let historyTerm: Xterm | null = null;
    loadFullRef.current = async () => {
      if (disposed) return;
      traceRecord('term.history.start', { runId });
      setHistoryMode(true);
      setLoaded(false);
      // React has to mount historyHostRef first; defer a frame.
      await new Promise((r) => requestAnimationFrame(r));
      const hhost = historyHostRef.current;
      if (!hhost || disposed) return;
      historyTerm = new Xterm({
        convertEol: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        theme: readTheme(),
        cursorBlink: false,
        disableStdin: true,
      });
      const hfit = new FitAddon();
      historyTerm.loadAddon(hfit);
      historyTerm.open(hhost);
      try { hfit.fit(); } catch { /* ignore */ }

      try {
        const res = await fetch(`/api/runs/${runId}/transcript`);
        if (disposed) return;
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (disposed) return;
        const HISTORY_CHUNK = 1024 * 1024;
        for (let off = 0; off < buf.byteLength; off += HISTORY_CHUNK) {
          if (disposed) return;
          const end = Math.min(off + HISTORY_CHUNK, buf.byteLength);
          await new Promise<void>((resolve) =>
            historyTerm!.write(buf.subarray(off, end), resolve)
          );
        }
        if (!disposed) setLoaded(true);
        traceRecord('term.history.end', { runId, bytes: buf.byteLength });
      } catch {
        if (disposed) return;
        historyTerm!.write(new TextEncoder().encode('\r\n[failed to load history]\r\n'));
        setLoaded(true);
        traceRecord('term.history.end', { runId, error: true });
      }
    };

    // "Resume live" disposes the history xterm and reveals the always-running
    // live one. The live subscription was never detached, so no resync.
    (loadFullRef as unknown as { resume?: () => void }).resume = () => {
      if (disposed) return;
      setHistoryMode(false);
      if (historyTerm) { historyTerm.dispose(); historyTerm = null; }
    };
```

Also, update the main useEffect's cleanup (bottom of effect, around line 350) to dispose the history term if one is active:

```ts
      if (historyTerm) { historyTerm.dispose(); historyTerm = null; }
```

- [ ] **Step 3: Run typecheck and unit tests**

Run:
```bash
npm run typecheck && npm run lint && npx vitest run
```
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/Terminal.tsx
git commit -m "fix(terminal): history mode renders in sibling xterm; live stays subscribed"
```

---

## Task 8: Playwright MCP verification — symptom acceptance

These are manual steps executed via the Playwright MCP, not codified tests. Each verifies a symptom from the spec.

- [ ] **Step 1: Start the dev server**

In a separate terminal:
```bash
scripts/dev.sh
```
Wait for `server :3000, vite :5173` to print.

- [ ] **Step 2: Verify symptom 1a — new run renders without tab switch**

Using Playwright MCP:

```
mcp__playwright__browser_navigate url=http://localhost:5173/projects
```

Pick a project with a valid devcontainer. Click "New run", submit a trivial prompt. After `nav` to the run detail, `browser_snapshot` and confirm that within 2 seconds the terminal area contains `[fbi] resolving image` or similar bytes without any tab-switch.

Expected: terminal shows streaming bytes before any tab switch or navigation. Pass if bytes visible within 3 s of page load.

- [ ] **Step 3: Verify symptom 1b — Continue streams without tab switch**

Navigate to a completed run with a captured Claude session (state `succeeded` or `failed`). Click the Continue button. `browser_snapshot` within 2 s of the click.

Expected: terminal shows `[fbi] continuing from session …` and subsequent bytes without any tab switch.

- [ ] **Step 4: Verify symptom 2 — history does not block input**

On an active (running or waiting) run, click "Load full history." The transcript should render in a new view. Then click "Resume live." Without any delay, type `echo test` into the terminal via `browser_type`.

Expected: characters appear in the terminal as typed; no loading spinner on resume; the live view is continuous with the pre-history content.

- [ ] **Step 5: Verify symptom 3 — insufficient scrollback (regression smoke)**

On an active run, click "Load full history." The history xterm should have scrollback spanning the full run (not just one viewport).

Expected: scrolling up in the history pane reveals more content than the live viewport showed. The live view is recoverable via "Resume live" with no data loss.

- [ ] **Step 6: Record outcomes**

If all four manual checks pass, add a one-line note to the plan (or PR description). If any fail, file a follow-up task; do not force-pass.

No commit for this task.

---

## Self-review checklist

- Spec coverage: Solution items (S1, C1–C5) map to Tasks 1–8:
  - S1 → Tasks 1, 2, 3
  - C1 → Task 5
  - C2 → Task 4
  - C3 → Task 6
  - C4 → Task 7
  - C5 → Tasks 1, 2 (server tests) and Task 8 (Playwright verification)
- Placeholder scan: no "TBD", no unreferenced helpers. Every code block is concrete.
- Type consistency: `makeOnBytes(store, broadcaster, screen)` signature is identical in Tasks 1 and 2/3. `onOpenOrNow(cb: () => void)` consistent between Task 4 and Task 5. `historyTerm: Xterm | null` defined once in Task 7 and referenced in cleanup.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-terminal-hardening.md`.

Recommended execution approach: **subagent-driven**, because tasks are short and independent (Tasks 1→3 are server-only; Task 4 is isolated; Tasks 5→7 are sequential client edits on the same file; Task 8 is manual). A fresh subagent per task with a two-stage review between server and client phases will catch any regressions early and keeps each agent's context focused.

Alternative: inline execution with checkpoints after Task 3 (server commits land), Task 5 (biggest client refactor), and Task 7 (history mode).
