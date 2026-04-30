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
  // server message. This also caches the initial hello-response snapshot.
  shell.onSnapshot((snap) => { entry.lastSnapshot = snap; });
  cache.set(runId, entry);
  return entry;
}

export function acquireShell(runId: number): ShellHandle {
  const entry = cache.get(runId);
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

// For tests.
export function _reset(): void {
  for (const e of cache.values()) {
    if (e.closeTimer) clearTimeout(e.closeTimer);
    e.shell.close();
  }
  cache.clear();
}
