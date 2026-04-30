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
  removeEventListener(type: string, fn: (e: Event) => void) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  }
  send() {}
  close() { this.readyState = MockWs.CLOSED; }
  fireOpen() {
    this.readyState = MockWs.OPEN;
    (this.listeners.get('open') ?? []).forEach((f) => f(new Event('open')));
  }
  fireClose(code = 1000, reason = '') {
    this.readyState = MockWs.CLOSED;
    const ev = Object.assign(new Event('close'), { code, reason });
    (this.listeners.get('close') ?? []).forEach((f) => f(ev));
  }
}

beforeEach(() => {
  MockWs.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = MockWs;
});

afterEach(() => {
  MockWs.instances = [];
});

describe('ShellHandle.sendHello', () => {
  it('sends a JSON hello frame when the socket is OPEN', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(50);
    const ws = MockWs.instances[0];
    const sent: string[] = [];
    (ws as unknown as { send(data: string): void }).send = (data: string) => { sent.push(data); };
    ws.fireOpen();
    shell.sendHello(123, 45);
    expect(sent).toEqual([
      JSON.stringify({ type: 'hello', cols: 123, rows: 45 }),
    ]);
  });

  it('is a no-op if the socket is not OPEN', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(51);
    const ws = MockWs.instances[0];
    const sent: string[] = [];
    (ws as unknown as { send(data: string): void }).send = (data: string) => { sent.push(data); };
    shell.sendHello(80, 24);
    expect(sent).toEqual([]);
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

describe('ShellHandle auto-reconnect', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens a new socket after the server closes the existing one', async () => {
    const { openShell } = await import('./ws.js');
    openShell(60);
    expect(MockWs.instances).toHaveLength(1);
    MockWs.instances[0].fireClose();
    vi.advanceTimersByTime(500);
    expect(MockWs.instances).toHaveLength(2);
  });

  it('re-fires onOpen callbacks on every reconnect', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(61);
    const cb = vi.fn();
    shell.onOpen(cb);

    MockWs.instances[0].fireOpen();
    expect(cb).toHaveBeenCalledTimes(1);

    MockWs.instances[0].fireClose();
    vi.advanceTimersByTime(500);
    MockWs.instances[1].fireOpen();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect after the caller calls close()', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(62);
    shell.close();
    vi.advanceTimersByTime(2000);
    expect(MockWs.instances).toHaveLength(1);
  });

  it('does not reconnect after caller close() even if a close event is also delivered', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(63);
    shell.close();
    MockWs.instances[0].fireClose();
    vi.advanceTimersByTime(2000);
    expect(MockWs.instances).toHaveLength(1);
  });
});

describe('ShellHandle.resize', () => {
  it('drops a duplicate resize with identical dims', async () => {
    const { openShell } = await import('./ws.js');
    const shell = openShell(70);
    const ws = MockWs.instances[0];
    const sent: string[] = [];
    (ws as unknown as { send(data: string): void }).send = (data: string) => { sent.push(data); };
    ws.fireOpen();

    shell.resize(133, 33);
    shell.resize(133, 33);  // same dims — must be dropped
    shell.resize(133, 34);  // different dims — must go through
    shell.resize(133, 34);  // same as previous — dropped
    shell.resize(133, 33);  // back to first dims — must go through (lastResize was 34)

    expect(sent).toEqual([
      JSON.stringify({ type: 'resize', cols: 133, rows: 33 }),
      JSON.stringify({ type: 'resize', cols: 133, rows: 34 }),
      JSON.stringify({ type: 'resize', cols: 133, rows: 33 }),
    ]);
  });

  it('resends after a reconnect even if dims match the pre-disconnect value', async () => {
    vi.useFakeTimers();
    try {
      const { openShell } = await import('./ws.js');
      const shell = openShell(71);
      const sent: string[] = [];
      const ws0 = MockWs.instances[0];
      (ws0 as unknown as { send(data: string): void }).send = (d: string) => { sent.push(`s0:${d}`); };
      ws0.fireOpen();

      shell.resize(80, 24);
      ws0.fireClose();
      vi.advanceTimersByTime(500);
      const ws1 = MockWs.instances[1];
      (ws1 as unknown as { send(data: string): void }).send = (d: string) => { sent.push(`s1:${d}`); };
      ws1.fireOpen();

      // Same dims as before disconnect — but the new socket's server side
      // doesn't know that, so we MUST resend.
      shell.resize(80, 24);

      expect(sent).toEqual([
        `s0:${JSON.stringify({ type: 'resize', cols: 80, rows: 24 })}`,
        `s1:${JSON.stringify({ type: 'resize', cols: 80, rows: 24 })}`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
