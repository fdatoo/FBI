// In-app debug trace for the terminal pipeline.
//
// Toggle with Ctrl+Shift+D on any page that has a Terminal mounted.
// While on, every WS message in/out, every snapshot apply/drop, every
// xterm write, and every keystroke is captured into a ring buffer with
// high-resolution timestamps. Click the floating "● REC" indicator to
// download the trace as JSON, or call downloadTrace() from the console.
//
// All recording functions early-return when tracing is off so the cost
// in the steady state is one boolean check per event.

const STORAGE_KEY = 'fbiTerminalTrace';
const RING_CAP = 10_000;
const PREVIEW_BYTES = 256;

type EventKind =
  | 'trace.start'
  | 'ws.open'
  | 'ws.close'
  | 'ws.abandoned'
  | 'ws.in.bytes'
  | 'ws.in.snapshot'
  | 'ws.in.event'
  | 'ws.out.send'
  | 'ws.out.resize'
  | 'ws.out.hello'
  | 'ws.out.focus'
  | 'ws.out.blur'
  | 'term.mount'
  | 'term.unmount'
  | 'term.fit'
  | 'term.applySnapshot'
  | 'term.dropSnapshot'
  | 'term.adoptSnapDims'
  | 'term.write'
  | 'term.input'
  | 'term.history.start'
  | 'term.history.end'
  | 'term.interactiveFit'
  | 'controller.mount'
  | 'controller.dispose'
  | 'controller.hello'
  | 'controller.snapshot'
  | 'controller.snapshot.cached'
  | 'controller.input'
  | 'controller.redraw'
  | 'controller.pause'
  | 'controller.pause.listener.error'
  | 'controller.rebuilding.listener.error'
  | 'controller.resume'
  | 'controller.snapshot.dropped'
  | 'controller.history.error'
  | 'controller.history.complete';

interface TraceEvent {
  t: number; // ms since trace start
  kind: EventKind;
  data: Record<string, unknown>;
}

interface TraceState {
  on: boolean;
  startedAt: number; // performance.now() at start
  startedAtIso: string;
  events: TraceEvent[];
  listeners: Set<() => void>;
}

const state: TraceState = {
  on: false,
  startedAt: 0,
  startedAtIso: '',
  events: [],
  listeners: new Set(),
};

function notify(): void {
  for (const cb of state.listeners) cb();
}

export function isTracing(): boolean {
  return state.on;
}

export function eventCount(): number {
  return state.events.length;
}

/** Read-only access to the underlying event ring, for e2e tests. The
 *  Quantico spec at tests/e2e/quantico/terminal-no-redraw-cascade.spec.ts
 *  uses this (via window.__fbiTerminalTrace) to assert the controller
 *  doesn't fall back into the snapshot↔resize cascade. Callers MUST treat
 *  the result as read-only. */
export function getEvents(): readonly TraceEvent[] {
  return state.events;
}

export function subscribe(cb: () => void): () => void {
  state.listeners.add(cb);
  return () => state.listeners.delete(cb);
}

export function setTracing(on: boolean): void {
  if (on === state.on) return;
  state.on = on;
  try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* noop */ }
  if (on) {
    state.startedAt = performance.now();
    state.startedAtIso = new Date().toISOString();
    state.events = [];
    record('trace.start', { ua: navigator.userAgent });
  }
  notify();
}

export function clearTrace(): void {
  state.events = [];
  state.startedAt = performance.now();
  state.startedAtIso = new Date().toISOString();
  if (state.on) record('trace.start', { ua: navigator.userAgent, cleared: true });
  notify();
}

export function record(kind: EventKind, data: Record<string, unknown> = {}): void {
  if (!state.on) return;
  const ev: TraceEvent = {
    t: Math.round((performance.now() - state.startedAt) * 1000) / 1000,
    kind,
    data,
  };
  state.events.push(ev);
  if (state.events.length > RING_CAP) state.events.splice(0, state.events.length - RING_CAP);
  // Cheap notify — only every ~100 events to avoid React thrash.
  if (state.events.length % 100 === 0) notify();
}

export function downloadTrace(): void {
  const payload = {
    version: 1,
    startedAt: state.startedAtIso,
    durationMs: Math.round(performance.now() - state.startedAt),
    eventCount: state.events.length,
    capped: state.events.length >= RING_CAP,
    events: state.events,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fbi-terminal-trace-${state.startedAtIso.replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Initialize from localStorage on module load. Trace stays on across
// page reloads if the user enabled it before.
try {
  if (localStorage.getItem(STORAGE_KEY) === '1') {
    setTracing(true);
  }
} catch { /* noop */ }

// Private debug API. Used by the Quantico e2e spec to assert on WS-control-
// plane behavior (snapshot/resize/hello counts) without needing Playwright
// to intercept the WebSocket frames. Not part of the public surface — the
// double-underscore name signals "internal".
try {
  (globalThis as { __fbiTerminalTrace?: unknown }).__fbiTerminalTrace = {
    setTracing,
    isTracing,
    getEvents,
    eventCount,
    clearTrace,
  };
} catch { /* noop in non-globalThis envs */ }

// Helpers for callers to format byte previews consistently.

export function bytesPreview(data: Uint8Array): { len: number; hex: string; ascii: string; truncated: boolean } {
  const len = data.byteLength;
  const slice = data.subarray(0, Math.min(len, PREVIEW_BYTES));
  let hex = '';
  let ascii = '';
  for (let i = 0; i < slice.byteLength; i++) {
    const b = slice[i];
    hex += b.toString(16).padStart(2, '0');
    ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return { len, hex, ascii, truncated: len > PREVIEW_BYTES };
}

export function strPreview(s: string): { len: number; preview: string; truncated: boolean } {
  const len = s.length;
  return {
    len,
    preview: len > PREVIEW_BYTES ? s.slice(0, PREVIEW_BYTES) : s,
    truncated: len > PREVIEW_BYTES,
  };
}
