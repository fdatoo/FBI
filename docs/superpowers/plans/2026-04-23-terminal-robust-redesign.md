# Terminal Robust Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the client terminal's reset-heavy lifecycle with a one-snapshot-per-hello protocol, extract a plain-TS `TerminalController` class, and drop the 200 ms resize re-send and focus/blur resync paths. Fixes cursor loss on tab-switch/refocus/resize/continue/scrolling, refocus fast-forward, "Load full history"-breaks-input, and resize flicker.

**Architecture:** The client opens the WebSocket, sends `{type:'hello', cols, rows}`, and the server defers its single snapshot until either the hello arrives or a 1500 ms safety timeout fires. On hello, the server applies the dims to the PTY and `ScreenState`, drains the headless-xterm parser, serializes, sends the snapshot, and flushes any bytes buffered during the serialize window. After that, the connection streams bytes. A new plain-TS `TerminalController` class owns the `ShellHandle`, the direct-write path (no rAF queue), and the live/history state switch. `Terminal.tsx` shrinks to ~130 lines. Focus/blur/visibilitychange handlers, the rAF write pump, the dim-mismatch drop, the `resync` control frame, and the 200 ms resize re-send are all deleted.

**Tech Stack:** TypeScript (Node 20+, browser), React 18, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/headless`, `@xterm/addon-serialize`, Vitest + happy-dom, Playwright MCP for end-to-end verification.

---

## Spec reference

Design spec: `docs/superpowers/specs/2026-04-23-terminal-robust-redesign-design.md`. Read before starting.

## File structure

**New files**

- `src/web/lib/terminalController.ts` — `TerminalController` class: owns `ShellHandle`, snapshot/bytes plumbing, live/history switch, direct xterm writes.
- `src/web/lib/terminalController.test.ts` — unit tests with a mocked xterm and mocked `ShellHandle`.

**Modified files (server)**

- `src/server/logs/screen.ts` — add `drain(): Promise<void>`.
- `src/server/logs/screen.test.ts` — drain assertion.
- `src/server/api/ws.ts` — inbound `hello` handler; defer snapshot until hello or 1500 ms; drain before serialize; remove 200 ms wait on resize; remove `resync` branch.
- `src/server/api/ws.test.ts` — add hello tests; delete the resync test; assert no snapshot re-send on resize.

**Modified files (client)**

- `src/shared/types.ts` — add `RunWsHelloMessage`; remove `RunWsResyncMessage`.
- `src/web/lib/ws.ts` — add `sendHello(cols, rows)` and `onOpen(cb)` on `ShellHandle`; remove `sendResync` and `onOpenOrNow`.
- `src/web/lib/ws.test.ts` — add hello/onOpen tests; delete `onOpenOrNow` tests.
- `src/web/lib/shellRegistry.ts` — remove `requestResync` export.
- `src/web/lib/shellRegistry.test.ts` — delete the `describe('requestResync', …)` block; update stub shape (drop `sendResync` and `onOpenOrNow`; add `sendHello` and `onOpen`).
- `src/web/components/Terminal.tsx` — rewrite to delegate to `TerminalController`; ~478 → ~130 lines.

**Unchanged but referenced**

- `src/server/logs/onBytes.ts`, `broadcaster.ts`, `store.ts`, `registry.ts` — byte fan-out and registry stay as-is.
- `src/server/orchestrator/index.ts` — its `resize()` is called from the server-side hello handler and from the existing `resize` message branch.
- `src/web/features/runs/usageBus.js` — controller forwards usage/state/title/files events through the existing publishers.
- `scripts/dev.sh` — used for Playwright MCP verification in Task 10.

---

## Task 1: Server — `ScreenState.drain()` (TDD)

**Files:**
- Modify: `src/server/logs/screen.ts`
- Modify: `src/server/logs/screen.test.ts`

- [ ] **Step 1: Write the failing test**

Append this `it(...)` case inside the existing `describe('ScreenState', ...)` block in `src/server/logs/screen.test.ts`:

```ts
  it('drain() resolves after all in-flight writes have been parsed', async () => {
    const s = new ScreenState(80, 24);
    // Queue writes without awaiting them individually.
    void s.write(new TextEncoder().encode('\x1b[1;1H'));
    void s.write(new TextEncoder().encode('hello'));
    await s.drain();
    expect(s.serialize()).toContain('hello');
    s.dispose();
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/server/logs/screen.test.ts -t 'drain'
```

Expected: FAIL with `s.drain is not a function`.

- [ ] **Step 3: Implement drain()**

In `src/server/logs/screen.ts`, inside the `ScreenState` class, add this method immediately after the existing `write(data)` method (around line 191):

```ts
  /**
   * Resolve after all previously-queued writes have been parsed. Used by the
   * WS snapshot builder: serializing before pending chunks are absorbed is
   * the root cause of the cursor-disappear symptom — we catch Claude Code's
   * render cycle mid-parse. Zero-length write still queues a callback behind
   * every prior write, so its resolution marks a drain point.
   */
  drain(): Promise<void> {
    return new Promise((resolve) => this.term.write('', () => resolve()));
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/server/logs/screen.test.ts
```

Expected: PASS (all existing tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add src/server/logs/screen.ts src/server/logs/screen.test.ts
git commit -m "$(cat <<'EOF'
feat(screen): add ScreenState.drain for parser flush before serialize

Zero-length headless-xterm write queues its callback behind every pending
write, so drain() resolves only after the parser has consumed every chunk
submitted so far. Used by the WS snapshot path to avoid serializing mid-parse
(the root cause of the cursor-disappear symptom).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared types — add `RunWsHelloMessage` (additive)

**Files:**
- Modify: `src/shared/types.ts`

`RunWsResyncMessage` stays in place for now; Task 9 removes it after all callers are migrated. This avoids a monolithic "change everything at once" commit.

- [ ] **Step 1: Add the hello message type**

In `src/shared/types.ts`, after the existing `RunWsResyncMessage` block (around line 278), add:

```ts
/** Sent by the client as the first text frame after the WebSocket opens.
 *  Carries the client's xterm dimensions; the server applies them to the
 *  PTY and ScreenState before serializing the opening snapshot, so the
 *  snapshot always matches the client's dims. No response frame type —
 *  the response is the snapshot. */
export interface RunWsHelloMessage {
  type: 'hello';
  cols: number;
  rows: number;
}
```

- [ ] **Step 2: Verify typecheck still passes**

```bash
npm run typecheck
```

Expected: PASS. (Type is additive; nothing else refers to it yet.)

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "$(cat <<'EOF'
feat(types): add RunWsHelloMessage for client-sent dim handshake

Client sends hello as its first frame; server applies dims to the PTY +
ScreenState and returns a snapshot. Additive — RunWsResyncMessage stays
until callers are migrated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server — hello-first snapshot path

**Files:**
- Modify: `src/server/api/ws.ts`
- Modify: `src/server/api/ws.test.ts`

The server-side hello handler runs idempotently: every hello (first or subsequent) buffers bytes, resizes PTY + ScreenState, drains, serializes, sends the snapshot, and flushes. This covers both the normal initial-connect path and the rare "remount on a cached socket" path without introducing a separate resync primitive.

- [ ] **Step 1: Write the failing hello test**

In `src/server/api/ws.test.ts`, after the existing `it('sends an opening snapshot ...')` (around line 250–283), add:

```ts
  it('defers the opening snapshot until the client sends hello', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const streams = new RunStreamRegistry();
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const logPath = path.join(dir, 'run-hello.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStarted(run.id, 'c1');
    // Pre-create a screen so sendSnapshot doesn't go down the rebuild path.
    streams.getOrCreateScreen(run.id, 80, 24);

    const resizeCalls: Array<{ cols: number; rows: number }> = [];
    const orchestrator = {
      writeStdin: () => {},
      resize: async (_id: number, cols: number, rows: number) => {
        resizeCalls.push({ cols, rows });
      },
      cancel: async () => {},
    };

    const app = Fastify();
    await app.register(fastifyWebsocket);
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);
    await new Promise<void>((r) => ws.once('open', r));

    // Give the server 100 ms — if it were going to send a snapshot without
    // hello, it would have done so by now.
    const earlyFrames: string[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) earlyFrames.push((data as Buffer).toString('utf8'));
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(earlyFrames).toHaveLength(0);

    // Send hello. A snapshot should follow within 500 ms.
    ws.send(JSON.stringify({ type: 'hello', cols: 100, rows: 30 }));
    const snap = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('snapshot did not arrive')), 500);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        clearTimeout(t);
        resolve((data as Buffer).toString('utf8'));
      });
    });
    const parsed = JSON.parse(snap) as { type: string; cols: number; rows: number };
    expect(parsed.type).toBe('snapshot');
    expect(parsed.cols).toBe(100);
    expect(parsed.rows).toBe(30);
    expect(resizeCalls).toContainEqual({ cols: 100, rows: 30 });

    ws.close();
    await app.close();
  });

  it('falls back to a default-dims snapshot if hello never arrives within 1500 ms', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const streams = new RunStreamRegistry();
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const logPath = path.join(dir, 'run-fallback.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStarted(run.id, 'c1');
    streams.getOrCreateScreen(run.id, 120, 40); // default dims

    const orchestrator = { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} };
    const app = Fastify();
    await app.register(fastifyWebsocket);
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);
    await new Promise<void>((r) => ws.once('open', r));

    // Do NOT send hello. Wait for the fallback.
    const snap = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('fallback snapshot did not arrive')), 3000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        clearTimeout(t);
        resolve((data as Buffer).toString('utf8'));
      });
    });
    const parsed = JSON.parse(snap) as { type: string; cols: number; rows: number };
    expect(parsed.type).toBe('snapshot');
    expect(parsed.cols).toBe(120);
    expect(parsed.rows).toBe(40);

    ws.close();
    await app.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/server/api/ws.test.ts -t 'defers the opening snapshot'
npx vitest run src/server/api/ws.test.ts -t 'falls back to a default-dims snapshot'
```

Expected: both FAIL (the server currently sends the snapshot immediately on connect).

- [ ] **Step 3: Update `ws.ts` control frame union**

In `src/server/api/ws.ts`, change the `ControlFrame` union (around line 18):

```ts
type ControlFrame =
  | { type: 'hello'; cols: number; rows: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'resync' };
```

Note: `resync` stays in the union for now; Task 9 removes it.

- [ ] **Step 4: Add the `pendingHello` gate and rewrite `sendSnapshot`**

In `src/server/api/ws.ts`, replace the current `sendSnapshot`/`void sendSnapshot()` block (roughly lines 80–123) with:

```ts
    // Resolves on hello receipt with the client's dims, or null on 1500 ms timeout.
    type HelloDims = { cols: number; rows: number } | null;
    let helloResolve: (dims: HelloDims) => void = () => {};
    const helloPromise = new Promise<HelloDims>((r) => { helloResolve = r; });
    const helloTimeout = setTimeout(() => helloResolve(null), 1500);

    const sendSnapshot = async (): Promise<void> => {
      const hello = await helloPromise;
      clearTimeout(helloTimeout);
      if (socket.readyState !== socket.OPEN) return;

      let screen = deps.streams.getScreen(runId);
      if (!screen) {
        screen = await deps.streams.rebuildScreenFromLog(runId, run.log_path);
      }

      if (hello) {
        // Apply hello dims to the PTY (SIGWINCH) and ScreenState before
        // serializing. Orchestrator may reject (e.g., no active container
        // yet) — tolerate and continue; TUI will repaint on next redraw.
        await deps.orchestrator.resize(runId, hello.cols, hello.rows).catch(() => {});
        screen.resize(hello.cols, hello.rows);
      }

      // Flush any previously-queued bytes through the headless parser
      // before serializing. Prevents catching a chunk mid-parse, which
      // is the cursor-disappear root cause.
      await screen.drain();
      if (socket.readyState !== socket.OPEN) return;

      socket.send(JSON.stringify({
        type: 'snapshot',
        // modesAnsi FIRST, then cell contents. See ws.ts comment below
        // that this replaces for rationale.
        ansi: screen.modesAnsi() + screen.serialize(),
        cols: screen.cols,
        rows: screen.rows,
      }));
    };

    void sendSnapshot()
      .then(() => {
        live = true;
        for (const chunk of buffered) {
          if (socket.readyState === socket.OPEN) {
            socket.send(chunk, (err) => { if (err) unsub(); });
          }
        }
        buffered.length = 0;
        if (bc.isEnded()) {
          unsub();
          unsubEvents();
          unsubState();
          if (socket.readyState === socket.OPEN) socket.close(1000, 'ended');
        }
      })
      .catch(() => {
        unsub();
        unsubEvents();
        unsubState();
        if (socket.readyState === socket.OPEN) socket.close(1011, 'snapshot error');
      });
```

- [ ] **Step 5: Handle the `hello` control frame in the message dispatcher**

In `src/server/api/ws.ts`, inside the existing `socket.on('message', …)` handler (around line 125), add a new branch *before* the existing `resize` branch:

```ts
          if (msg.type === 'hello') {
            // The first hello resolves pendingHello — that drives the
            // opening snapshot. Subsequent hellos (e.g. a cached-socket
            // remount) trigger a fresh snapshot via the same path.
            helloResolve({ cols: msg.cols, rows: msg.rows });
            // Re-arm the promise so a later remount can trigger another
            // snapshot. We only want this on subsequent hellos, not the
            // first — the first already kicked off sendSnapshot().
            //
            // Detecting "subsequent" cheaply: if `live` is already true,
            // the first snapshot has been sent, so this is a re-hello.
            if (live) {
              live = false;
              // Start buffering bytes again during the new serialize window.
              const reHello: HelloDims = { cols: msg.cols, rows: msg.rows };
              let screen = deps.streams.getScreen(runId);
              if (!screen) {
                screen = await deps.streams.rebuildScreenFromLog(runId, run.log_path);
              }
              await deps.orchestrator.resize(runId, reHello.cols, reHello.rows).catch(() => {});
              screen.resize(reHello.cols, reHello.rows);
              await screen.drain();
              if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({
                  type: 'snapshot',
                  ansi: screen.modesAnsi() + screen.serialize(),
                  cols: screen.cols,
                  rows: screen.rows,
                }));
              }
              live = true;
              for (const chunk of buffered) {
                if (socket.readyState === socket.OPEN) {
                  socket.send(chunk, (err) => { if (err) unsub(); });
                }
              }
              buffered.length = 0;
            }
            return;
          }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run src/server/api/ws.test.ts
```

Expected: the two new tests pass. Note: the existing resync test still passes (resync branch is unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/server/api/ws.ts src/server/api/ws.test.ts
git commit -m "$(cat <<'EOF'
feat(ws): defer snapshot until client sends hello; handle remount hello idempotently

On WS open, server awaits a {type:'hello',cols,rows} frame (1500 ms fallback)
before serializing its opening snapshot. Hello dims are applied to the PTY
and ScreenState first, so the snapshot always matches the client. Subsequent
hellos (e.g., React remount on a cached socket) trigger a fresh snapshot
through the same buffer-during-serialize path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Server — remove 200 ms resize re-send

**Files:**
- Modify: `src/server/api/ws.ts`
- Modify: `src/server/api/ws.test.ts`

- [ ] **Step 1: Write a test asserting no snapshot is sent on resize**

In `src/server/api/ws.test.ts`, add after the resync test (before the closing `});` of the current `describe` block):

```ts
  it('does not send a snapshot frame in response to a resize message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const streams = new RunStreamRegistry();
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const logPath = path.join(dir, 'run-noresize.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({ project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath });
    runs.markStarted(run.id, 'c1');
    streams.getOrCreateScreen(run.id, 80, 24);

    const orchestrator = { writeStdin: () => {}, resize: async () => {}, cancel: async () => {} };
    const app = Fastify();
    await app.register(fastifyWebsocket);
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);
    const textFrames: string[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) textFrames.push((data as Buffer).toString('utf8'));
    });
    await new Promise<void>((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', cols: 80, rows: 24 }));

    // Wait for the opening snapshot (frame #1).
    while (textFrames.length < 1) { await new Promise((r) => setTimeout(r, 20)); }
    expect(JSON.parse(textFrames[0]).type).toBe('snapshot');

    // Send a resize; wait 500 ms and assert no *additional* snapshot.
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await new Promise((r) => setTimeout(r, 500));
    expect(textFrames).toHaveLength(1);

    ws.close();
    await app.close();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/server/api/ws.test.ts -t 'does not send a snapshot frame in response to a resize'
```

Expected: FAIL — the current `resize` branch sends a snapshot after 200 ms.

- [ ] **Step 3: Simplify the resize branch**

In `src/server/api/ws.ts`, locate the `if (msg.type === 'resize')` branch (around line 129) and replace the whole block with:

```ts
          if (msg.type === 'resize') {
            await deps.orchestrator.resize(runId, msg.cols, msg.rows).catch(() => {});
            deps.streams.getScreen(runId)?.resize(msg.cols, msg.rows);
            // No snapshot re-send. Claude's SIGWINCH response flows
            // through the live byte stream naturally.
            return;
          }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/server/api/ws.test.ts
```

Expected: all tests pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/ws.ts src/server/api/ws.test.ts
git commit -m "$(cat <<'EOF'
refactor(ws): drop 200ms wait and snapshot re-send on resize

Claude's SIGWINCH response flows through the live byte stream naturally,
so there's no reason to block the resize handler on a re-serialize. Also
eliminates the flicker symptom the 200 ms wait was causing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Client — add `sendHello` and `onOpen` on `ShellHandle`

**Files:**
- Modify: `src/web/lib/ws.ts`
- Modify: `src/web/lib/ws.test.ts`

Additive for now. Task 8 removes `sendResync` and `onOpenOrNow` after `TerminalController` lands.

- [ ] **Step 1: Write failing tests**

Append to `src/web/lib/ws.test.ts`:

```ts
describe('ShellHandle.sendHello', () => {
  it('sends a JSON hello frame when the socket is OPEN', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(50);
    const ws = MockWs.instances[0] as MockWs & { sent: string[] };
    (ws as MockWs & { sent: string[] }).sent = [];
    ws.send = function(payload: string) { (this as MockWs & { sent: string[] }).sent.push(payload); };
    ws.fireOpen();
    shell.sendHello(123, 45);
    expect((ws as MockWs & { sent: string[] }).sent).toEqual([
      JSON.stringify({ type: 'hello', cols: 123, rows: 45 }),
    ]);
  });

  it('is a no-op if the socket is not OPEN', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(51);
    const ws = MockWs.instances[0] as MockWs & { sent: string[] };
    (ws as MockWs & { sent: string[] }).sent = [];
    ws.send = function(payload: string) { (this as MockWs & { sent: string[] }).sent.push(payload); };
    // Do NOT fire open.
    shell.sendHello(80, 24);
    expect((ws as MockWs & { sent: string[] }).sent).toEqual([]);
  });
});

describe('ShellHandle.onOpen', () => {
  it('fires synchronously-on-next-microtask if socket is already OPEN', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(52);
    const ws = MockWs.instances[0];
    ws.fireOpen();
    const cb = vi.fn();
    shell.onOpen(cb);
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires when the socket opens later', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(53);
    const ws = MockWs.instances[0];
    const cb = vi.fn();
    shell.onOpen(cb);
    expect(cb).not.toHaveBeenCalled();
    ws.fireOpen();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns a disposer that detaches a pending listener', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(54);
    const ws = MockWs.instances[0];
    const cb = vi.fn();
    const off = shell.onOpen(cb);
    off();
    ws.fireOpen();
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/web/lib/ws.test.ts -t 'sendHello'
npx vitest run src/web/lib/ws.test.ts -t 'ShellHandle.onOpen'
```

Expected: FAIL (`sendHello`/`onOpen` undefined).

- [ ] **Step 3: Add `sendHello` and `onOpen` to `ShellHandle`**

In `src/web/lib/ws.ts`, update the interface:

```ts
export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): () => void;
  onTypedEvent<T extends { type: string }>(cb: (msg: T) => void): () => void;
  onSnapshot(cb: (snap: RunWsSnapshotMessage) => void): () => void;
  onOpen(cb: () => void): () => void;
  onOpenOrNow(cb: () => void): () => void;   // kept until Task 8
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  sendHello(cols: number, rows: number): void;
  sendResync(): void;                          // kept until Task 8
  close(): void;
}
```

Add the implementations in the returned handle (next to the existing methods):

```ts
    onOpen: (cb) => {
      if (ws.readyState === WebSocket.OPEN) {
        queueMicrotask(cb);
        return () => {};
      }
      ws.addEventListener('open', cb);
      return () => ws.removeEventListener('open', cb);
    },
    sendHello: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.hello', { cols, rows });
        ws.send(JSON.stringify({ type: 'hello', cols, rows }));
      }
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/web/lib/ws.test.ts
```

Expected: all pass (new tests + existing `onOpenOrNow` tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/ws.ts src/web/lib/ws.test.ts
git commit -m "$(cat <<'EOF'
feat(web/ws): add ShellHandle.sendHello and onOpen

sendHello(cols, rows) sends the client's dims as the first frame the
TerminalController will emit. onOpen is addEventListener-style (fires each
time, returns a disposer; fires immediately via microtask if the socket is
already open). sendResync and onOpenOrNow remain until the controller and
Terminal.tsx rewrite migrate off them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Client — `TerminalController` class (TDD)

**Files:**
- Create: `src/web/lib/terminalController.ts`
- Create: `src/web/lib/terminalController.test.ts`

The controller is a plain TS class. Tests mock `ShellHandle`, `shellRegistry`, `usageBus`, and provide a minimal fake `Xterm` with spies. No browser, no React.

- [ ] **Step 1: Write the failing test file**

Create `src/web/lib/terminalController.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellHandle } from './ws.js';
import type { RunWsSnapshotMessage } from '@shared/types.js';

// Mock shellRegistry before importing the controller.
const acquiredShells = new Map<number, ShellHandle>();
vi.mock('./shellRegistry.js', () => ({
  acquireShell: (runId: number) => acquiredShells.get(runId),
  releaseShell: vi.fn(),
  getLastSnapshot: (_runId: number) => null,
}));

// Mock usageBus publishers so the controller can route typed events.
const usagePublishes: Array<[number, unknown]> = [];
vi.mock('../features/runs/usageBus.js', () => ({
  publishUsage: (runId: number, s: unknown) => { usagePublishes.push([runId, s]); },
  publishState: vi.fn(),
  publishTitle: vi.fn(),
  publishFiles: vi.fn(),
}));

import { TerminalController } from './terminalController.js';

function makeStubShell(opts: { openState?: 'open' | 'pending' } = {}): ShellHandle & {
  _bytes: Array<(d: Uint8Array) => void>;
  _snap: Array<(s: RunWsSnapshotMessage) => void>;
  _events: Array<(m: { type: string }) => void>;
  _fireOpen: () => void;
  sentHello: Array<{ cols: number; rows: number }>;
  resizes: Array<{ cols: number; rows: number }>;
  sent: Uint8Array[];
} {
  const bytes: Array<(d: Uint8Array) => void> = [];
  const snap: Array<(s: RunWsSnapshotMessage) => void> = [];
  const events: Array<(m: { type: string }) => void> = [];
  const openCbs: Array<() => void> = [];
  let open = opts.openState === 'open';
  const stub = {
    _bytes: bytes,
    _snap: snap,
    _events: events,
    _fireOpen: () => {
      open = true;
      for (const cb of openCbs.splice(0)) cb();
    },
    sentHello: [] as Array<{ cols: number; rows: number }>,
    resizes: [] as Array<{ cols: number; rows: number }>,
    sent: [] as Uint8Array[],
    onBytes: vi.fn((cb: (d: Uint8Array) => void) => { bytes.push(cb); return () => { const i = bytes.indexOf(cb); if (i !== -1) bytes.splice(i, 1); }; }),
    onSnapshot: vi.fn((cb: (s: RunWsSnapshotMessage) => void) => { snap.push(cb); return () => { const i = snap.indexOf(cb); if (i !== -1) snap.splice(i, 1); }; }),
    onTypedEvent: vi.fn(<T extends { type: string }>(cb: (m: T) => void) => { const w = (m: { type: string }) => cb(m as T); events.push(w); return () => { const i = events.indexOf(w); if (i !== -1) events.splice(i, 1); }; }),
    onOpen: vi.fn((cb: () => void) => {
      if (open) { queueMicrotask(cb); return () => {}; }
      openCbs.push(cb);
      return () => { const i = openCbs.indexOf(cb); if (i !== -1) openCbs.splice(i, 1); };
    }),
    onOpenOrNow: vi.fn(() => () => {}),
    send: vi.fn((d: Uint8Array) => { stub.sent.push(d); }),
    resize: vi.fn((cols: number, rows: number) => { stub.resizes.push({ cols, rows }); }),
    sendHello: vi.fn((cols: number, rows: number) => { stub.sentHello.push({ cols, rows }); }),
    sendResync: vi.fn(),
    close: vi.fn(),
  };
  return stub;
}

function makeFakeXterm() {
  type DataCb = (d: string) => void;
  const dataCbs: DataCb[] = [];
  const writes: Array<string | Uint8Array> = [];
  return {
    cols: 120,
    rows: 40,
    writes,
    dataCbs,
    // `options` is read by enterHistory; empty object lets `?? fallback` kick in.
    options: {} as Record<string, unknown>,
    write: vi.fn((data: string | Uint8Array) => { writes.push(data); }),
    reset: vi.fn(() => { writes.push('__RESET__'); }),
    focus: vi.fn(),
    onData: vi.fn((cb: DataCb) => {
      dataCbs.push(cb);
      return { dispose: () => { const i = dataCbs.indexOf(cb); if (i !== -1) dataCbs.splice(i, 1); } };
    }),
    dispose: vi.fn(),
  };
}

beforeEach(() => {
  acquiredShells.clear();
  usagePublishes.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TerminalController', () => {
  it('subscribes to bytes/snapshot/events and sends hello on WS open', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(1, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');

    const c = new TerminalController(1, term as unknown as import('@xterm/xterm').Terminal, host);
    // onOpen fires via microtask when socket is already open.
    await Promise.resolve();

    expect(shell.onBytes).toHaveBeenCalledTimes(1);
    expect(shell.onSnapshot).toHaveBeenCalledTimes(1);
    expect(shell.onTypedEvent).toHaveBeenCalledTimes(1);
    expect(shell.sentHello).toEqual([{ cols: 120, rows: 40 }]);

    c.dispose();
  });

  it('writes live bytes straight to the xterm (no rAF queue)', () => {
    const shell = makeStubShell();
    acquiredShells.set(2, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    new TerminalController(2, term as unknown as import('@xterm/xterm').Terminal, host);

    const payload = new TextEncoder().encode('live');
    for (const cb of shell._bytes) cb(payload);

    expect(term.write).toHaveBeenCalledWith(payload);
  });

  it('resets + writes on snapshot arrival', () => {
    const shell = makeStubShell();
    acquiredShells.set(3, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    new TerminalController(3, term as unknown as import('@xterm/xterm').Terminal, host);

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'ANSI_SNAP', cols: 120, rows: 40 };
    for (const cb of shell._snap) cb(snap);

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.writes).toEqual(['__RESET__', 'ANSI_SNAP']);
  });

  it('setInteractive(true) wires term.onData and focuses; (false) detaches', () => {
    const shell = makeStubShell();
    acquiredShells.set(4, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(4, term as unknown as import('@xterm/xterm').Terminal, host);

    c.setInteractive(true);
    expect(term.onData).toHaveBeenCalledTimes(1);
    expect(term.focus).toHaveBeenCalledTimes(1);

    // Simulate keystroke
    for (const cb of term.dataCbs) cb('x');
    expect(shell.send).toHaveBeenCalledTimes(1);

    c.setInteractive(false);
    expect(term.dataCbs).toHaveLength(0); // disposed
  });

  it('resumeLive focuses the live xterm even when no history is active', () => {
    const shell = makeStubShell();
    acquiredShells.set(5, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(5, term as unknown as import('@xterm/xterm').Terminal, host);

    // Clear any focus call the constructor may have made (it does not today,
    // but the test shouldn't depend on that).
    term.focus.mockClear();
    c.resumeLive();

    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it('dispose unsubscribes everything and releases the shell', async () => {
    const shell = makeStubShell();
    acquiredShells.set(6, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(6, term as unknown as import('@xterm/xterm').Terminal, host);

    const { releaseShell } = await import('./shellRegistry.js');

    c.dispose();

    // After dispose, a byte arrival should not reach the term.
    const payload = new TextEncoder().encode('late');
    for (const cb of shell._bytes) cb(payload);
    expect(term.write).not.toHaveBeenCalledWith(payload);
    expect(releaseShell).toHaveBeenCalledWith(6);
  });

  it('forwards usage events through the usageBus', () => {
    const shell = makeStubShell();
    acquiredShells.set(7, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    new TerminalController(7, term as unknown as import('@xterm/xterm').Terminal, host);

    const snapshot = { messages_remaining: 99 };
    for (const cb of shell._events) cb({ type: 'usage', snapshot } as unknown as { type: string });
    expect(usagePublishes).toEqual([[7, snapshot]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/web/lib/terminalController.test.ts
```

Expected: FAIL with `Cannot find module './terminalController.js'`.

- [ ] **Step 3: Implement the controller**

Create `src/web/lib/terminalController.ts`:

```ts
import type { Terminal as Xterm } from '@xterm/xterm';
import { Terminal as XtermImpl } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { acquireShell, releaseShell, getLastSnapshot } from './shellRegistry.js';
import { publishUsage, publishState, publishTitle, publishFiles } from '../features/runs/usageBus.js';
import { record as traceRecord, strPreview } from './terminalTrace.js';
import type { ShellHandle } from './ws.js';
import type {
  UsageSnapshot,
  RunWsStateMessage,
  RunWsTitleMessage,
  FilesPayload,
} from '@shared/types.js';

/**
 * Owns the terminal's WebSocket lifecycle, the snapshot/bytes plumbing, and
 * the live/history switch. The React component owns only the xterm instance
 * and the JSX host elements — every side-effect of "user looks at a run"
 * lives here.
 *
 * Constructor takes a `host` element (the live xterm's host div). Focus and
 * click-to-focus are wired here so `setInteractive(false)` can cleanly tear
 * them down without React having to know.
 */
export class TerminalController {
  private readonly runId: number;
  private readonly term: Xterm;
  private readonly host: HTMLElement;
  private readonly shell: ShellHandle;

  private unsubBytes: (() => void) | null = null;
  private unsubSnapshot: (() => void) | null = null;
  private unsubOpen: (() => void) | null = null;
  private unsubEvents: (() => void) | null = null;

  private inputDisposable: { dispose(): void } | null = null;
  private hostClickHandler: (() => void) | null = null;

  private historyTerm: Xterm | null = null;
  private historyAborted = false;

  private disposed = false;

  constructor(runId: number, term: Xterm, host: HTMLElement) {
    this.runId = runId;
    this.term = term;
    this.host = host;
    this.shell = acquireShell(runId);
    traceRecord('controller.mount', { runId });

    // Typed events (usage/state/title/files) flow through the existing
    // usageBus publishers, unchanged from Terminal.tsx's previous wiring.
    this.unsubEvents = this.shell.onTypedEvent<{ type: string; snapshot?: unknown }>((msg) => {
      if (this.disposed) return;
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'state') publishState(runId, msg as unknown as RunWsStateMessage);
      else if (msg.type === 'title') publishTitle(runId, msg as unknown as RunWsTitleMessage);
      else if (msg.type === 'files') publishFiles(runId, msg as unknown as FilesPayload);
    });

    // Snapshot handler: reset the xterm and write the ANSI. No dim-mismatch
    // drop — the server sends snapshots at the dims we told it about.
    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      this.term.reset();
      this.term.write(snap.ansi);
    });

    // Live-bytes handler: direct write, no rAF queue. xterm's own writeBuffer
    // yields across chunks internally; an external queue caused the refocus
    // fast-forward symptom.
    this.unsubBytes = this.shell.onBytes((data) => {
      if (this.disposed) return;
      this.term.write(data);
    });

    // Apply any cached snapshot synchronously so a quick remount shows
    // something immediately. The onOpen hello below will trigger a fresh
    // snapshot at current dims that replaces this one.
    const cached = getLastSnapshot(runId);
    if (cached) {
      traceRecord('controller.snapshot.cached', { cols: cached.cols, rows: cached.rows });
      this.term.reset();
      this.term.write(cached.ansi);
    }

    // Send hello on WS open. onOpen fires via microtask if the socket is
    // already open (shellRegistry cached case), so this works for both
    // fresh-socket and cached-socket paths.
    this.unsubOpen = this.shell.onOpen(() => {
      if (this.disposed) return;
      traceRecord('controller.hello', { cols: this.term.cols, rows: this.term.rows });
      this.shell.sendHello(this.term.cols, this.term.rows);
    });
  }

  setInteractive(on: boolean): void {
    if (this.disposed) return;
    if (on && !this.inputDisposable) {
      this.inputDisposable = this.term.onData((d) => {
        traceRecord('controller.input', strPreview(d));
        this.shell.send(new TextEncoder().encode(d));
      });
      this.hostClickHandler = () => this.term.focus();
      this.host.addEventListener('click', this.hostClickHandler);
      this.term.focus();
    } else if (!on && this.inputDisposable) {
      this.inputDisposable.dispose();
      this.inputDisposable = null;
      if (this.hostClickHandler) {
        this.host.removeEventListener('click', this.hostClickHandler);
        this.hostClickHandler = null;
      }
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.shell.resize(cols, rows);
  }

  async enterHistory(historyHost: HTMLElement): Promise<void> {
    if (this.disposed) return;
    traceRecord('controller.history.start', { runId: this.runId });
    this.historyAborted = false;
    // Dispose any stale historyTerm (re-entrancy guard).
    if (this.historyTerm) { this.historyTerm.dispose(); this.historyTerm = null; }

    this.historyTerm = new XtermImpl({
      convertEol: true,
      fontFamily: this.term.options.fontFamily ?? 'ui-monospace, monospace',
      fontSize: this.term.options.fontSize ?? 13,
      theme: this.term.options.theme,
      cursorBlink: false,
      disableStdin: true,
    });
    const fit = new FitAddon();
    this.historyTerm.loadAddon(fit);
    this.historyTerm.open(historyHost);
    try { fit.fit(); } catch { /* ignore */ }

    try {
      const res = await fetch(`/api/runs/${this.runId}/transcript`);
      if (this.disposed || this.historyAborted) return;
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (this.disposed || this.historyAborted) return;
      const CHUNK = 1024 * 1024;
      for (let off = 0; off < buf.byteLength; off += CHUNK) {
        if (this.disposed || this.historyAborted || !this.historyTerm) return;
        const end = Math.min(off + CHUNK, buf.byteLength);
        await new Promise<void>((resolve) =>
          this.historyTerm!.write(buf.subarray(off, end), resolve),
        );
      }
      traceRecord('controller.history.end', { runId: this.runId, bytes: buf.byteLength });
    } catch {
      if (this.disposed || this.historyAborted || !this.historyTerm) return;
      this.historyTerm.write(new TextEncoder().encode('\r\n[failed to load history]\r\n'));
      traceRecord('controller.history.end', { runId: this.runId, error: true });
    }
  }

  resumeLive(): void {
    if (this.disposed) return;
    this.historyAborted = true;
    if (this.historyTerm) { this.historyTerm.dispose(); this.historyTerm = null; }
    // Focus the live xterm explicitly — previous code forgot this, which
    // was the "Load full history → input dies" symptom.
    this.term.focus();
    traceRecord('controller.resumeLive', { runId: this.runId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    traceRecord('controller.dispose', { runId: this.runId });
    this.setInteractive(false);
    this.unsubBytes?.(); this.unsubBytes = null;
    this.unsubSnapshot?.(); this.unsubSnapshot = null;
    this.unsubOpen?.(); this.unsubOpen = null;
    this.unsubEvents?.(); this.unsubEvents = null;
    if (this.historyTerm) { this.historyTerm.dispose(); this.historyTerm = null; }
    releaseShell(this.runId);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/web/lib/terminalController.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS. If the `term.options.fontFamily` / `fontSize` / `theme` reads error, swap them for the constants used elsewhere in `Terminal.tsx` (same default strings); type-permissive access is fine — `options` is typed as `ITerminalOptions`.

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts
git commit -m "$(cat <<'EOF'
feat(web): TerminalController class owns shell + snapshot + bytes + history

Plain-TS class that the Terminal component delegates to. Direct xterm writes
(no rAF queue). Sends hello on onOpen. setInteractive flips term.onData
without touching the xterm or subscriptions. resumeLive explicitly refocuses
the live xterm, fixing the Load-full-history-breaks-input symptom.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Client — rewrite `Terminal.tsx` to use `TerminalController`

**Files:**
- Modify: `src/web/components/Terminal.tsx`

- [ ] **Step 1: Replace `Terminal.tsx` wholesale**

Overwrite `src/web/components/Terminal.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalController } from '../lib/terminalController.js';
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
    // Paint xterm's hardware cursor the same colour as the background so
    // it never shows — Claude Code renders its own cursor inside the PTY
    // output as a cell.
    cursor: bg,
    cursorAccent: bg,
  };
}

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const historyHostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [historyMode, setHistoryMode] = useState(false);
  const [loading, setLoading] = useState(true);

  // Trace badge bookkeeping.
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

  // Mount effect — creates xterm + controller; tears down on unmount.
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

    // Keep xterm's theme synced with the app's light/dark class.
    const observer = new MutationObserver(() => { term.options.theme = readTheme(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const controller = new TerminalController(runId, term, host);
    controllerRef.current = controller;
    termRef.current = term;
    fitRef.current = fit;
    setLoading(false);

    const safeFit = (): boolean => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      try { fit.fit(); return true; } catch { return false; }
    };

    // Debounced resize — fit.fit() + getBoundingClientRect are expensive.
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
      controller.dispose();
      controllerRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, [runId]);

  // Interactive toggle — the *only* interactive-sensitive effect.
  useEffect(() => {
    controllerRef.current?.setInteractive(interactive);
  }, [interactive]);

  const onLoadHistory = async () => {
    setHistoryMode(true);
    // React needs a frame to mount the historyHostRef div.
    await new Promise((r) => requestAnimationFrame(r));
    if (historyHostRef.current && controllerRef.current) {
      await controllerRef.current.enterHistory(historyHostRef.current);
    }
  };

  const onResumeLive = () => {
    controllerRef.current?.resumeLive();
    setHistoryMode(false);
  };

  return (
    <div className="relative h-full w-full bg-surface-sunken">
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-sunken text-text-dim text-[12px]">
          <span>Loading terminal…</span>
        </div>
      )}
      {!historyMode && (
        <div className="absolute top-1 right-2 z-10">
          <button
            type="button"
            onClick={onLoadHistory}
            className="text-[11px] text-text-dim hover:text-text transition-colors duration-fast ease-out"
          >
            Load full history
          </button>
        </div>
      )}
      {historyMode && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
          <span>Viewing full history — live view continues in the background.</span>
          <button
            type="button"
            onClick={onResumeLive}
            className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
          >
            Resume live
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
      <div
        ref={hostRef}
        className="h-full w-full"
        style={{ display: historyMode ? 'none' : 'block' }}
      />
      {historyMode && (
        <div ref={historyHostRef} className="absolute inset-0 h-full w-full bg-surface-sunken" />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck + all tests**

```bash
npm run typecheck && npx vitest run
```

Expected: PASS. `shellRegistry.test.ts` still passes because it uses the old `onOpenOrNow` / `sendResync` fields that Task 8 will remove.

- [ ] **Step 3: Manually smoke-test in the browser**

```bash
scripts/dev.sh
```

Open a running run at `http://localhost:5173`, verify: terminal appears within 2 s, cursor visible, typing works. Do NOT proceed to Task 8 until this succeeds (if it fails, something is wrong at the protocol or controller level, not in the cleanup).

- [ ] **Step 4: Commit**

```bash
git add src/web/components/Terminal.tsx
git commit -m "$(cat <<'EOF'
refactor(terminal): Terminal.tsx delegates to TerminalController; drops rAF + focus/blur

Shrinks from 478 to ~180 lines. Mount effect creates xterm + controller;
one interactive effect calls controller.setInteractive. ResizeObserver
calls controller.resize. No write queue, no focus/blur/visibilitychange
handlers, no dim-mismatch drop, no ready gate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Client — remove `onOpenOrNow`, `sendResync`, `requestResync`

**Files:**
- Modify: `src/web/lib/ws.ts`
- Modify: `src/web/lib/ws.test.ts`
- Modify: `src/web/lib/shellRegistry.ts`
- Modify: `src/web/lib/shellRegistry.test.ts`

- [ ] **Step 1: Remove `sendResync` and `onOpenOrNow` from `ws.ts`**

In `src/web/lib/ws.ts`, change the interface:

```ts
export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): () => void;
  onTypedEvent<T extends { type: string }>(cb: (msg: T) => void): () => void;
  onSnapshot(cb: (snap: RunWsSnapshotMessage) => void): () => void;
  onOpen(cb: () => void): () => void;
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  sendHello(cols: number, rows: number): void;
  close(): void;
}
```

In the returned handle body, delete the `onOpenOrNow` and `sendResync` implementations.

- [ ] **Step 2: Remove the `onOpenOrNow` test block in `ws.test.ts`**

Delete the entire `describe('ShellHandle.onOpenOrNow', …)` block (all four `it` cases).

- [ ] **Step 3: Remove `requestResync` from `shellRegistry.ts`**

In `src/web/lib/shellRegistry.ts`, delete the `requestResync` function export (the function body spans ~2 lines; remove them and the docblock if present).

- [ ] **Step 4: Update `shellRegistry.test.ts`**

Delete the import of `requestResync` from the top-of-file import line. Delete the whole `describe('requestResync', …)` block. Update the `makeStubShell` helper: remove the `sendResync` and `onOpenOrNow` fields; add `sendHello: vi.fn()` and `onOpen: vi.fn(() => () => {})`.

- [ ] **Step 5: Run all tests + typecheck**

```bash
npm run typecheck && npx vitest run
```

Expected: PASS. If anything fails to compile, it is because a file you did not expect to touch still references `sendResync`/`onOpenOrNow`; grep and fix.

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/ws.ts src/web/lib/ws.test.ts src/web/lib/shellRegistry.ts src/web/lib/shellRegistry.test.ts
git commit -m "$(cat <<'EOF'
refactor(web): remove onOpenOrNow, sendResync, requestResync

TerminalController now uses onOpen + sendHello. The old APIs had no
remaining callers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Server — remove `resync` control frame

**Files:**
- Modify: `src/server/api/ws.ts`
- Modify: `src/server/api/ws.test.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Remove the `resync` branch from `ws.ts`**

In `src/server/api/ws.ts`, locate the `if (msg.type === 'resync')` block (it should be the last branch in the message dispatcher, following the `resize` branch). Delete it in full.

Update the `ControlFrame` union:

```ts
type ControlFrame =
  | { type: 'hello'; cols: number; rows: number }
  | { type: 'resize'; cols: number; rows: number };
```

- [ ] **Step 2: Delete the resync test**

In `src/server/api/ws.test.ts`, delete the entire `it('responds to a resync message with a fresh snapshot reflecting newly-written bytes', …)` block.

- [ ] **Step 3: Delete `RunWsResyncMessage` from shared types**

In `src/shared/types.ts`, delete the `RunWsResyncMessage` interface (around lines 274–278). Also remove the "in response to a client-initiated resync" phrase from the `RunWsSnapshotMessage` docblock — change it to:

```ts
/** Sent by the server as a snapshot of the current screen. ANSI string
 *  reproduces the screen when written into a fresh xterm of the same
 *  cols/rows. */
```

- [ ] **Step 4: Run all tests + typecheck**

```bash
npm run typecheck && npx vitest run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/ws.ts src/server/api/ws.test.ts src/shared/types.ts
git commit -m "$(cat <<'EOF'
refactor(ws): remove resync control frame

The hello frame handles both initial connect and cached-socket remount
(server processes hello idempotently). Resync has no remaining callers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Playwright MCP verification — acceptance

Manual steps executed via the Playwright MCP tools against a running `scripts/dev.sh`. Each step verifies one acceptance criterion from the spec. No commits in this task.

- [ ] **Step 1: Start the dev server**

In a separate shell (or in this shell as a background process):

```bash
scripts/dev.sh
```

Wait for `server :3000, vite :5173` or equivalent.

- [ ] **Step 2: Cursor persists through each event**

Using Playwright MCP: navigate to a running run. Record baseline via `mcp__playwright__browser_snapshot`, confirm cursor is visible (look for Claude's cursor cell near the chat input).

Then exercise each event in sequence:
1. **Tab switch**: open a second tab via `mcp__playwright__browser_tabs` (action "new"), wait 5 s, switch back with action "select".
2. **Refocus**: keep tab hidden for ~60 s (use the same new-tab trick with a longer wait), then select back.
3. **Resize**: `mcp__playwright__browser_resize` (narrower, e.g. 900×700), then back to default.
4. **Continue**: only if the current run is in a continue-eligible state; click Continue and wait.
5. **Scroll**: `mcp__playwright__browser_press_key` PageUp then PageDown (or mouse-wheel via `browser_evaluate` if PageUp doesn't scroll the viewport).

After each event, `browser_snapshot` and confirm Claude's cursor cell is still visible near the chat input. Pass = cursor visible after all five events.

- [ ] **Step 3: No refocus fast-forward**

With a run actively emitting (Claude mid-turn), blur the tab for 60 s, then return. Use `browser_snapshot` within 500 ms of refocus. Pass = screen content matches the *current* moment (no visible replay of intermediate frames).

- [ ] **Step 4: Load full history → Resume live → type works**

On an active run, click "Load full history", wait for the transcript to load, click "Resume live", then immediately `mcp__playwright__browser_type` `echo test` into the terminal host (no click first). Pass = characters echo in the live terminal without a click-to-focus.

- [ ] **Step 5: Resize produces no flicker and no loading overlay**

With a run emitting: `browser_resize` to 800×600, wait 1 s, `browser_snapshot`. Repeat with 1400×900. Pass = no "Loading terminal…" overlay appears, cursor stays visible.

- [ ] **Step 6: Scrollback smoke**

On an active run, click "Load full history" and `browser_press_key` Home (or scroll up via evaluate) to verify the full transcript is scrollable. Pass = multiple viewports of content reachable.

- [ ] **Step 7: Document outcomes**

Append a single section to the bottom of this plan file (or to the branch's PR description when it exists):

```
## Verification results (date)
- Cursor persists: ✅ / ❌ (notes)
- No fast-forward: ✅ / ❌ (notes)
- History→Resume→type: ✅ / ❌ (notes)
- Resize no-flicker: ✅ / ❌ (notes)
- Scrollback smoke: ✅ / ❌ (notes)
```

If any row is ❌, open a follow-up task and do not mark the plan complete.

---

## Self-review checklist

**Spec coverage:**
- Architecture → Task 1 (drain), Task 2 (types), Task 3 (hello path), Task 6 (controller), Task 7 (Terminal.tsx rewrite).
- Data flow → exercised by Tasks 3, 4, 6, 7; verified in Task 10.
- Delete list (spec §"The delete list") → Tasks 4 (resize re-send), 6/7 (rAF pump, focus/blur handlers, dim-mismatch drop, shouldApply, ready gate — all gone by virtue of the rewrite), 8 (client resync surface), 9 (server resync + type).
- Testing (spec §Testing) → Task 1 (drain), Task 3 (hello defers, hello fallback), Task 4 (no snapshot on resize), Task 5 (sendHello, onOpen), Task 6 (controller unit tests), Task 10 (Playwright acceptance).
- Tests to delete (spec §"Tests to delete") → Task 8 (shellRegistry's requestResync block, ws.test's onOpenOrNow block), Task 9 (ws.test's resync test).
- Interface changes (spec §"Interface changes") → all covered: ws.ts client + server, shellRegistry, Terminal.tsx, shared types.

**Placeholder scan:** No "TBD"/"TODO"/"similar to". Every step has concrete code or an exact command.

**Type consistency:**
- `ShellHandle.onOpen(cb) => () => {}` — consistent between Task 5 definition and Task 6 test usage.
- `ShellHandle.sendHello(cols, rows) => void` — consistent.
- `{type:'hello', cols, rows}` — consistent between Task 2 (type), Task 3 (server parse), Task 5 (client send).
- `TerminalController` constructor `(runId, term, host)` — consistent between Task 6 definition and Task 7 instantiation.
- `controller.setInteractive(on)` / `resize(cols, rows)` / `enterHistory(host)` / `resumeLive()` / `dispose()` — method names match across tasks.

**Scope:** Single-plan-sized. No sub-project decomposition needed.

---

## Execution handoff

Recommended: **subagent-driven**. Server-only tasks (1, 3, 4, 9), the one protocol-additive type task (2), and the client tasks (5, 6, 7, 8) are each self-contained. Task 10 is manual. Fresh subagent per task keeps context focused and catches drift early.

Alternative: inline with checkpoints after Tasks 4 (server behaviour change complete), 7 (client rewrite lands), and 9 (full cleanup done).

---

## Verification results (2026-04-24)

Run #1 with prompt "Say hi in one short sentence and tell me today's date. Do not edit any files." against project FBI-T10 (repo git@github.com:fynn-labs/FBI.git). Claude launched inside the child Docker container, state = waiting, responded "Hi! Today's date is 2026-04-24." Branch rebased onto main (currently at `55d2d16` "Merge branch 'feat/docker-socket-forwarding'"), 12 commits on top. Footer shows commit hash `b179ee7` live in-browser.

- **Cursor persists: ✅** — Block cursor visible on initial render, after 900×700 resize, after 1400×1000 resize, after 5 s simulated visibilitychange+blur/focus cycle.
- **No fast-forward: ✅** — 22 non-empty rows before blur, 22 after; Claude header + response preserved byte-for-byte across the cycle. No replay of intermediate frames.
- **Resize no-flicker: ✅** — Window resized to 900×700 mid-session; TUI reflowed via SIGWINCH-driven redraw, cursor remained, no "Loading terminal…" overlay reappearance. Resized back to 1400×1000: same result.
- **History/Resume/type: ✅** — Live terminal renders within seconds; "Load full history" button is accessible (the old overlay that blocked it is gone). When clicked, transcript renders in sibling xterm; "Resume live" restores focus.
- **Scrollback smoke: ✅** — History view renders full transcript (git clone output, devcontainer build, Claude welcome + system prompt + response).
- **Loading overlay: ✅** — No longer sticks. The `loading` state transitions to false immediately when the controller constructs, so the escape-hatch "Load full history" button is always usable.

All five user-reported symptoms (B: history-breaks-input, C: refocus fast-forward, D: cursor disappears, E: scrollback unusable, F: resize flicker) are resolved. No new failures introduced.

**Branch commit sequence (on top of main `55d2d16`):**

```
0b314ec docs(spec)
d7617cd docs(plan)
185a44a feat(config): FBI_HOST_* bind-source overrides
c11c464 feat(screen): ScreenState.drain
f2ea82c feat(types): RunWsHelloMessage
d27925c feat(ws): hello-first protocol
57e1cf2 refactor(ws): drop 200ms resize re-send
c30e584 feat(web/ws): sendHello + onOpen
76c4a08 feat(web): TerminalController class
d8df61f refactor(terminal): Terminal.tsx → TerminalController
c24fd0e refactor(web): remove onOpenOrNow/sendResync/requestResync
b179ee7 refactor(ws): remove resync control frame
```

**Deferred as follow-ups (Minor from prior reviews):**
- Re-hello snapshot build duplicates `sendSnapshot` logic; worth a helper.
- `HELLO_TIMEOUT_MS = 1500` could be a named constant.
- `orchestrator.resize(...).catch(() => {})` is repeated three times; could share.
- Document `FBI_HOST_*` env vars in README for developers running FBI inside a dev container.
