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
  publishChanges: vi.fn(),
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
      for (const cb of openCbs) cb();
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
    send: vi.fn((d: Uint8Array) => { stub.sent.push(d); }),
    resize: vi.fn((cols: number, rows: number) => { stub.resizes.push({ cols, rows }); }),
    sendHello: vi.fn((cols: number, rows: number) => { stub.sentHello.push({ cols, rows }); }),
    close: vi.fn(),
  };
  return stub;
}

function makeFakeXterm() {
  type DataCb = (d: string) => void;
  const dataCbs: DataCb[] = [];
  const writes: Array<string | Uint8Array> = [];
  const state = { viewportY: 0, scrollbackLength: 0 };
  const scrollCbs: Array<() => void> = [];
  return {
    cols: 120,
    rows: 40,
    writes,
    dataCbs,
    scrollCbs,
    state,
    options: {} as Record<string, unknown>,
    write: vi.fn((data: string | Uint8Array, cb?: () => void) => {
      writes.push(data);
      if (cb) cb();
    }),
    reset: vi.fn(() => { writes.push('__RESET__'); state.viewportY = 0; state.scrollbackLength = 0; }),
    focus: vi.fn(),
    onData: vi.fn((cb: DataCb) => {
      dataCbs.push(cb);
      return { dispose: () => { const i = dataCbs.indexOf(cb); if (i !== -1) dataCbs.splice(i, 1); } };
    }),
    onScroll: vi.fn((cb: () => void) => {
      scrollCbs.push(cb);
      return { dispose: () => { const i = scrollCbs.indexOf(cb); if (i !== -1) scrollCbs.splice(i, 1); } };
    }),
    getViewportY: vi.fn(() => state.viewportY),
    getScrollbackLength: vi.fn(() => state.scrollbackLength),
    scrollToLine: vi.fn((line: number) => { state.viewportY = line; }),
    scrollToBottom: vi.fn(() => { state.viewportY = 0; }),
    dispose: vi.fn(),
  };
}

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

beforeEach(() => {
  acquiredShells.clear();
  usagePublishes.length = 0;
  fetchCalls.length = 0;
  fetchResponder = () => ({ status: 404, headers: {}, body: new Uint8Array() });
  installFetchMock();
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

  it('resets + writes + pins viewport to bottom on snapshot arrival', () => {
    const shell = makeStubShell();
    acquiredShells.set(3, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    new TerminalController(3, term as unknown as import('@xterm/xterm').Terminal, host);

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'ANSI_SNAP', cols: 120, rows: 40, byte_offset: 0 };
    for (const cb of shell._snap) cb(snap);

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.writes).toEqual(['__RESET__', 'ANSI_SNAP']);
    expect(term.scrollToBottom).toHaveBeenCalled();
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

    for (const cb of term.dataCbs) cb('x');
    expect(shell.send).toHaveBeenCalledTimes(1);

    c.setInteractive(false);
    expect(term.dataCbs).toHaveLength(0);
  });

  it('dispose unsubscribes everything and releases the shell', async () => {
    const shell = makeStubShell();
    acquiredShells.set(6, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(6, term as unknown as import('@xterm/xterm').Terminal, host);

    const { releaseShell } = await import('./shellRegistry.js');

    c.dispose();

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

  it('onReady fires after loadBoundedHistory completes', async () => {
    const shell = makeStubShell();
    acquiredShells.set(11, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(11, term as unknown as import('@xterm/xterm').Terminal, host);

    fetchResponder = () => ({ status: 206, headers: {}, body: new Uint8Array(10).fill(65) });

    const readyCb = vi.fn();
    c.onReady(readyCb);
    expect(readyCb).not.toHaveBeenCalled();

    const snap: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'X', cols: 120, rows: 40, byte_offset: 100 };
    for (const cb of shell._snap) cb(snap);

    // Wait for microtask + fetch + async operations to complete.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(readyCb).toHaveBeenCalledTimes(1);
  });

  it('live bytes are written directly to terminal when not paused', () => {
    const shell = makeStubShell();
    acquiredShells.set(20, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(20, term as unknown as import('@xterm/xterm').Terminal, host);

    const abc = new TextEncoder().encode('abc');
    const de = new TextEncoder().encode('de');
    for (const cb of shell._bytes) cb(abc);
    for (const cb of shell._bytes) cb(de);

    // Live bytes go directly to term, not buffered.
    expect(term.write).toHaveBeenCalledWith(abc);
    expect(term.write).toHaveBeenCalledWith(de);
    // liveTailBytes is empty when not paused/rebuilding.
    expect(c._debugBuffers().liveTailBytes.byteLength).toBe(0);
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

  it('pause() sets paused state; live bytes are buffered (not rendered) while paused', () => {
    const shell = makeStubShell();
    acquiredShells.set(22, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(22, term as unknown as import('@xterm/xterm').Terminal, host);

    // Pre-pause bytes go directly to term (not buffered).
    for (const cb of shell._bytes) cb(new TextEncoder().encode('pre'));
    expect(c._debugBuffers().liveTailBytes.byteLength).toBe(0);

    c.pause();
    expect(c._debugBuffers().paused).toBe(true);
    term.write.mockClear();
    for (const cb of shell._bytes) cb(new TextEncoder().encode('paused'));
    // Bytes must NOT be rendered to xterm while paused.
    expect(term.write).not.toHaveBeenCalled();
    // Post-pause bytes are buffered in liveTailBytes.
    expect(c._debugBuffers().liveTailBytes.byteLength).toBe(6); // 'paused' = 6 bytes
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

  it('snapshot handler drops snapshots while paused (does not reset xterm)', () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(63, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(63, term as unknown as import('@xterm/xterm').Terminal, host);

    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'INITIAL', cols: 120, rows: 40, byte_offset: 0 });
    c.pause();
    term.reset.mockClear();
    term.write.mockClear();

    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'RECONNECT', cols: 120, rows: 40, byte_offset: 0 });

    expect(term.reset).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalledWith('RECONNECT');
  });

  it('resume() reentrant calls return the same in-flight promise', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(64, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(64, term as unknown as import('@xterm/xterm').Terminal, host);

    c.pause();
    const p1 = c.resume();
    const p2 = c.resume();
    // Both promises must resolve without hanging.
    await Promise.all([p1, p2]);
    expect(c._debugBuffers().paused).toBe(false);
  });

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
    const resumeSpy = vi.spyOn(c, 'resume').mockResolvedValue();
    c.onScroll({ atBottom: true, nearTop: false });
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('onScroll is a no-op while rebuilding (seed rebuild does not trigger spurious resume)', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(73, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(73, term as unknown as import('@xterm/xterm').Terminal, host);
    (c as unknown as { rebuilding: boolean }).rebuilding = true;
    const pauseSpy = vi.spyOn(c, 'pause');
    const resumeSpy = vi.spyOn(c, 'resume').mockResolvedValue();
    c.onScroll({ atBottom: false, nearTop: false });
    c.onScroll({ atBottom: true, nearTop: false });
    c.onScroll({ atBottom: false, nearTop: true });
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('mount-time history fetch is bounded by SCROLLBACK_CAP', async () => {
    const shell = makeStubShell({ openState: 'open' });
    acquiredShells.set(90, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(90, term as unknown as import('@xterm/xterm').Terminal, host);

    const historyBytes = new Uint8Array(1000).fill(65); // 'A' * 1000
    let capturedCall: FetchCall | null = null;
    fetchResponder = (call): { status: number; headers: Record<string, string>; body: Uint8Array } => {
      capturedCall = call;
      return { status: 206, headers: {}, body: historyBytes };
    };

    // Fire a snapshot with large byte_offset to trigger loadBoundedHistory.
    const byteOffset = 10_000_000;
    for (const cb of shell._snap) cb({ type: 'snapshot', ansi: 'SNAP', cols: 120, rows: 40, byte_offset: byteOffset });

    // Wait for the async fetch + rebuild to complete.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(capturedCall).not.toBeNull();
    const rangeHeader = capturedCall!.headers['range'];
    expect(rangeHeader).toBeDefined();
    // Should be bytes=<start>-9999999
    expect(rangeHeader).toMatch(/^bytes=\d+-9999999$/);
    const start = Number(rangeHeader.split('=')[1].split('-')[0]);
    const SCROLLBACK_CAP = 5 * 1024 * 1024;
    expect(start).toBe(Math.max(0, byteOffset - SCROLLBACK_CAP));

    // term.reset should have been called (once for snapshot, once for rebuildXterm).
    expect(term.reset).toHaveBeenCalled();
    // History bytes should have been written.
    const writtenBuffers = term.writes.filter((w) => w instanceof Uint8Array);
    const hasHistoryBytes = writtenBuffers.some(
      (w) => w instanceof Uint8Array && w.byteLength === historyBytes.byteLength && w[0] === 65
    );
    expect(hasHistoryBytes).toBe(true);
    void c;
  });

  it('resume() writes buffered live bytes then scrolls to bottom', async () => {
    const shell = makeStubShell();
    acquiredShells.set(91, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(91, term as unknown as import('@xterm/xterm').Terminal, host);

    c.pause();

    // Fire bytes while paused — they buffer into liveTailBytes.
    const buffered = new TextEncoder().encode('hello');
    for (const cb of shell._bytes) cb(buffered);
    expect(c._debugBuffers().liveTailBytes.byteLength).toBe(5);

    term.write.mockClear();
    term.scrollToBottom.mockClear();

    await c.resume();

    // Buffered bytes should have been written to term.
    expect(term.write).toHaveBeenCalled();
    // scrollToBottom should have been called after resume.
    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(c._debugBuffers().paused).toBe(false);
  });

  it('onDriverChange is called when driver_state event arrives', () => {
    const shell = makeStubShell();
    acquiredShells.set(100, shell);
    const term = makeFakeXterm();
    const host = document.createElement('div');
    const c = new TerminalController(100, term as unknown as import('@xterm/xterm').Terminal, host);

    const driverCb = vi.fn();
    // onDriverChange immediately calls cb with current value (true by default).
    c.onDriverChange(driverCb);
    expect(driverCb).toHaveBeenCalledWith(true);
    driverCb.mockClear();

    // Fire a driver_state event with is_driver = false.
    for (const cb of shell._events) {
      cb({ type: 'driver_state', is_driver: false } as unknown as { type: string });
    }
    expect(driverCb).toHaveBeenCalledWith(false);

    // Fire again with is_driver = true.
    driverCb.mockClear();
    for (const cb of shell._events) {
      cb({ type: 'driver_state', is_driver: true } as unknown as { type: string });
    }
    expect(driverCb).toHaveBeenCalledWith(true);

    c.dispose();
  });
});
