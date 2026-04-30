import { useEffect, useState } from 'react';

/**
 * Lightweight publish/subscribe for the app's primary websocket connection
 * state. Updated by useRunWatcher (which owns the /api/ws/states connection),
 * consumed by the status bar.
 */
export type ConnState = 'connecting' | 'connected' | 'disconnected';

type Listener = (s: ConnState) => void;

let current: ConnState = 'connecting';
const listeners = new Set<Listener>();
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

function notify(s: ConnState) {
  if (s === current) return;
  current = s;
  for (const l of listeners) l(s);
}

export function getConnectionState(): ConnState {
  return current;
}

export function setConnectionState(s: ConnState): void {
  if (s === 'connected') {
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
    notify('connected');
    return;
  }

  if (s === 'disconnected') {
    // Debounce: only surface 'disconnected' after 2 s of continuous loss so
    // quick reconnects never cause a red-banner flicker.
    if (!disconnectTimer && current !== 'disconnected') {
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        notify('disconnected');
      }, 2000);
    }
    return;
  }

  // s === 'connecting': show immediately, but don't override the disconnected
  // banner once it is up (keep showing it until the connection actually succeeds).
  if (current !== 'disconnected') notify('connecting');
}

export function onConnectionState(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function _resetConnectionStateForTest(): void {
  if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
  current = 'connecting';
  listeners.clear();
}

export function useConnectionState(): ConnState {
  const [s, setS] = useState<ConnState>(() => getConnectionState());
  useEffect(() => onConnectionState(setS), []);
  return s;
}
