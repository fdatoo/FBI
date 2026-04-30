import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellHandle } from './ws.js';
import type { RunWsSnapshotMessage } from '@shared/types.js';

// Mock ws.js before importing the registry.
vi.mock('./ws.js', () => {
  return {
    openShell: vi.fn(),
  };
});

import { openShell } from './ws.js';
import { acquireShell, releaseShell, getLastSnapshot, _reset } from './shellRegistry.js';

function makeStubShell(): ShellHandle & {
  _bytesCbs: Array<(d: Uint8Array) => void>;
  _snapshotCbs: Array<(s: RunWsSnapshotMessage) => void>;
} {
  const bytesCbs: Array<(d: Uint8Array) => void> = [];
  const snapshotCbs: Array<(s: RunWsSnapshotMessage) => void> = [];
  return {
    _bytesCbs: bytesCbs,
    _snapshotCbs: snapshotCbs,
    onBytes: vi.fn((cb: (d: Uint8Array) => void) => {
      bytesCbs.push(cb);
      return () => { const i = bytesCbs.indexOf(cb); if (i !== -1) bytesCbs.splice(i, 1); };
    }),
    onTypedEvent: vi.fn(() => () => {}),
    onSnapshot: vi.fn((cb: (s: RunWsSnapshotMessage) => void) => {
      snapshotCbs.push(cb);
      return () => { const i = snapshotCbs.indexOf(cb); if (i !== -1) snapshotCbs.splice(i, 1); };
    }),
    onOpen: vi.fn(() => () => {}),
    send: vi.fn(),
    resize: vi.fn(),
    sendHello: vi.fn(),
    close: vi.fn(),
  };
}

const mockedOpenShell = openShell as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  _reset();
  vi.clearAllMocks();
});

afterEach(() => {
  _reset();
  vi.useRealTimers();
});

describe('acquireShell', () => {
  it('calls openShell once and returns the same handle on subsequent acquires', () => {
    const stub = makeStubShell();
    mockedOpenShell.mockReturnValue(stub);

    const h1 = acquireShell(1);
    const h2 = acquireShell(1);

    expect(mockedOpenShell).toHaveBeenCalledTimes(1);
    expect(h1).toBe(h2);
  });

  it('opens a new shell for a different runId', () => {
    const stub1 = makeStubShell();
    const stub2 = makeStubShell();
    mockedOpenShell.mockReturnValueOnce(stub1).mockReturnValueOnce(stub2);

    const h1 = acquireShell(1);
    const h2 = acquireShell(2);

    expect(h1).not.toBe(h2);
    expect(mockedOpenShell).toHaveBeenCalledTimes(2);
  });
});

describe('releaseShell', () => {
  it('does not close the socket immediately on release', () => {
    const stub = makeStubShell();
    mockedOpenShell.mockReturnValue(stub);

    acquireShell(5);
    releaseShell(5);

    expect(stub.close).not.toHaveBeenCalled();
  });

  it('closes the socket after TTL when refCount reaches 0', () => {
    const stub = makeStubShell();
    mockedOpenShell.mockReturnValue(stub);

    acquireShell(5);
    releaseShell(5);

    vi.advanceTimersByTime(300_000);

    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it('cancels TTL when re-acquired before it fires', () => {
    const stub = makeStubShell();
    mockedOpenShell.mockReturnValue(stub);

    acquireShell(5);
    releaseShell(5);

    vi.advanceTimersByTime(150_000); // halfway through TTL

    // re-acquire before TTL fires
    const h = acquireShell(5);
    expect(h).toBe(stub);
    expect(stub.close).not.toHaveBeenCalled();

    // advance past original TTL
    vi.advanceTimersByTime(300_000);

    // still not closed — new TTL was not triggered (refCount > 0)
    expect(stub.close).not.toHaveBeenCalled();
  });

  it('does not close socket when there are still active references', () => {
    const stub = makeStubShell();
    mockedOpenShell.mockReturnValue(stub);

    acquireShell(5);
    acquireShell(5); // refCount = 2
    releaseShell(5); // refCount = 1

    vi.advanceTimersByTime(300_000);

    expect(stub.close).not.toHaveBeenCalled();
  });

  it('is a no-op for unknown runId', () => {
    // Should not throw.
    expect(() => releaseShell(999)).not.toThrow();
  });
});

describe('getLastSnapshot', () => {
  it('returns null when no shell exists', () => {
    expect(getLastSnapshot(42)).toBeNull();
  });

  it('returns null before any snapshot has arrived', () => {
    const stub = makeStubShell();
    mockedOpenShell.mockReturnValue(stub);

    acquireShell(7);

    expect(getLastSnapshot(7)).toBeNull();
  });

  it('caches the most recent snapshot received', () => {
    const stub = makeStubShell();
    mockedOpenShell.mockReturnValue(stub);

    acquireShell(7);

    const snap1: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'hello', cols: 80, rows: 24, byte_offset: 0 };
    const snap2: RunWsSnapshotMessage = { type: 'snapshot', ansi: 'world', cols: 80, rows: 24, byte_offset: 5 };
    for (const cb of stub._snapshotCbs) cb(snap1);

    expect(getLastSnapshot(7)).toBe(snap1);

    for (const cb of stub._snapshotCbs) cb(snap2);

    expect(getLastSnapshot(7)).toBe(snap2);
  });

  it('returns null after the socket is closed and removed from cache', () => {
    const stub = makeStubShell();
    mockedOpenShell.mockReturnValue(stub);

    acquireShell(8);
    releaseShell(8);
    vi.advanceTimersByTime(300_000); // TTL fires, cache cleared

    expect(getLastSnapshot(8)).toBeNull();
  });
});

