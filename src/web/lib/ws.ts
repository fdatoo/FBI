import type { RunWsSnapshotMessage } from '@shared/types.js';
import { wsBase } from './api.js';
import { record, bytesPreview, strPreview } from './terminalTrace.js';

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

const RECONNECT_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Stop reconnecting after this many consecutive failures that never opened.
// Runs whose actor is gone from the registry (completed or orphaned after a
// server restart) return 404 on every upgrade attempt. Without a cap, the
// client would loop forever.
const MAX_CONSECUTIVE_FAILURES = 8;

export function openShell(runId: number): ShellHandle {
  const url = `${wsBase()}/api/runs/${runId}/shell`;

  // Subscriber arrays live across reconnects so the controller's
  // onBytes/onSnapshot/onOpen handlers wired once at mount keep firing
  // for every reconnect-served WS instance.
  const bytesCbs: Array<(d: Uint8Array) => void> = [];
  const typedCbs: Array<(msg: { type: string }) => void> = [];
  const snapshotCbs: Array<(s: RunWsSnapshotMessage) => void> = [];
  const openCbs: Array<() => void> = [];

  let ws: WebSocket;
  let userClosed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Counts consecutive close events where the socket never reached OPEN.
  // Reset to 0 whenever a connection successfully opens.
  let consecutiveFailures = 0;
  // Track the last (cols, rows) we sent on the wire so duplicate resizes
  // (e.g. two ResizeObserver firings in the same frame, or a redraw
  // perturbation that lands on the existing dims) are dropped. Cleared
  // on (re)connect — a fresh socket has no server-side memory of prior
  // sizes. The server-side resize is also free of side effects, so a
  // duplicate is safe to drop entirely (no snapshot would've been sent).
  let lastResize: { cols: number; rows: number } | null = null;

  const connect = (): void => {
    lastResize = null;
    let thisConnectionOpened = false;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      thisConnectionOpened = true;
      consecutiveFailures = 0;
      record('ws.open', { runId });
      for (const cb of openCbs) cb();
    });
    ws.addEventListener('close', (e) => {
      record('ws.close', { runId, code: e.code, reason: e.reason, consecutiveFailures });
      if (userClosed) return;
      if (!thisConnectionOpened) {
        consecutiveFailures++;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        record('ws.abandoned', { runId, consecutiveFailures });
        return;
      }
      // Exponential backoff for repeated upgrade failures; immediate reconnect
      // for normal closes (server ended a live stream, then Continue creates a
      // new broadcaster the client should reattach to).
      const delay = consecutiveFailures === 0
        ? RECONNECT_DELAY_MS
        : Math.min(RECONNECT_DELAY_MS * 2 ** (consecutiveFailures - 1), RECONNECT_MAX_DELAY_MS);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!userClosed) connect();
      }, delay);
    });
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as { type: string };
          if (msg.type === 'snapshot') {
            const snap = msg as unknown as RunWsSnapshotMessage;
            record('ws.in.snapshot', {
              cols: snap.cols, rows: snap.rows,
              ansiLen: snap.ansi.length,
              ansiPreview: strPreview(snap.ansi),
            });
            for (const cb of snapshotCbs) cb(snap);
            return;
          }
          record('ws.in.event', { type: msg.type, msg });
          for (const cb of typedCbs) cb(msg);
        } catch {
          const data = new TextEncoder().encode(ev.data);
          record('ws.in.bytes', { source: 'text-fallback', ...bytesPreview(data) });
          for (const cb of bytesCbs) cb(data);
        }
        return;
      }
      const data = ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new TextEncoder().encode('');
      record('ws.in.bytes', bytesPreview(data));
      for (const cb of bytesCbs) cb(data);
    };
  };
  connect();

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
    onOpen: (cb) => {
      // Persist across reconnects: every fresh WS open re-fires registered
      // callbacks so the controller can re-send hello and get a fresh
      // snapshot for the new container.
      openCbs.push(cb);
      if (ws.readyState === WebSocket.OPEN) queueMicrotask(cb);
      return () => { const i = openCbs.indexOf(cb); if (i !== -1) openCbs.splice(i, 1); };
    },
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.send', bytesPreview(data));
        ws.send(data);
      }
    },
    resize: (cols, rows) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (lastResize && lastResize.cols === cols && lastResize.rows === rows) return;
      lastResize = { cols, rows };
      record('ws.out.resize', { cols, rows });
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    sendHello: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN) {
        record('ws.out.hello', { cols, rows });
        ws.send(JSON.stringify({ type: 'hello', cols, rows }));
      }
    },
    close: () => {
      userClosed = true;
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      ws.close();
    },
  };
}
