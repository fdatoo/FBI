import { useEffect, useState } from 'react';
import { api, wsBase } from '../lib/api.js';
import {
  notifyComplete, notifyWaiting, clearWaitingBadge, installFocusReset,
} from '../lib/notifications.js';
import { setConnectionState } from '../lib/connectionState.js';
import type { RunState } from '@shared/types.js';
import { isTauri, invoke } from '@tauri-apps/api/core';

type Listener = (map: Map<number, number>) => void;
type RefreshListener = () => void;

let lastRunning = new Map<number, number>();
let lastWaiting = new Map<number, number>();
const runningListeners = new Set<Listener>();
const waitingListeners = new Set<Listener>();
const refreshListeners = new Set<RefreshListener>();

export function subscribeToRunRefresh(cb: RefreshListener): () => void {
  refreshListeners.add(cb);
  return () => { refreshListeners.delete(cb); };
}

function notifyRunRefresh() {
  for (const l of refreshListeners) l();
}

export function _publishRunning(map: Map<number, number>) {
  lastRunning = map;
  for (const l of runningListeners) l(map);
}

export function _publishWaiting(map: Map<number, number>) {
  lastWaiting = map;
  for (const l of waitingListeners) l(map);
}

export function useRunningCounts(): Map<number, number> {
  const [m, setM] = useState(lastRunning);
  useEffect(() => {
    const l: Listener = (x) => setM(new Map(x));
    runningListeners.add(l);
    return () => { runningListeners.delete(l); };
  }, []);
  return m;
}

export function useWaitingCounts(): Map<number, number> {
  const [m, setM] = useState(lastWaiting);
  useEffect(() => {
    const l: Listener = (x) => setM(new Map(x));
    waitingListeners.add(l);
    return () => { waitingListeners.delete(l); };
  }, []);
  return m;
}

interface GlobalStateFrame {
  type: 'state';
  run_id: number;
  project_id: number;
  state: RunState;
}

const isTerminal = (s: RunState) =>
  s === 'succeeded' || s === 'failed' || s === 'cancelled';

function statesUrl(): string {
  return `${wsBase()}/api/ws/states`;
}

function publishCountsFromMap(runs: Map<number, { state: RunState; project_id: number; title: string | null }>) {
  const running = new Map<number, number>();
  const waiting = new Map<number, number>();
  for (const { state, project_id } of runs.values()) {
    if (state === 'running') running.set(project_id, (running.get(project_id) ?? 0) + 1);
    else if (state === 'waiting') waiting.set(project_id, (waiting.get(project_id) ?? 0) + 1);
  }
  _publishRunning(running);
  _publishWaiting(waiting);
  if (isTauri()) {
    const activeRuns = [...runs.entries()]
      .filter(([, r]) => !isTerminal(r.state))
      .map(([id, r]) => ({ id, title: r.title, state: r.state }));
    invoke('update_tray_runs', { runs: activeRuns }).catch(() => {});
  }
}

export function useRunWatcher(enabled: boolean) {
  useEffect(() => {
    const dispose = enabled ? installFocusReset() : () => {};
    const runs = new Map<number, { state: RunState; project_id: number; title: string | null }>();
    let seeding = true;
    let ws: WebSocket | null = null;
    let stopped = false;

    const seed = async () => {
      seeding = true;
      try {
        const all = await api.listRuns();
        runs.clear();
        for (const r of all) runs.set(r.id, { state: r.state, project_id: r.project_id, title: r.title });
        publishCountsFromMap(runs);
      } catch { /* swallow; reconnect retry will re-seed */ }
      seeding = false;
    };

    const connect = () => {
      if (stopped) return;
      setConnectionState('connecting');
      ws = new WebSocket(statesUrl());
      ws.onopen = () => { setConnectionState('connected'); };
      ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data as string) as GlobalStateFrame;
        const prev = runs.get(msg.run_id)?.state;
        const prevTitle = runs.get(msg.run_id)?.title ?? null;
        runs.set(msg.run_id, { state: msg.state, project_id: msg.project_id, title: prevTitle });
        publishCountsFromMap(runs);
        notifyRunRefresh();
        if (seeding || !enabled) return;
        if (prev === 'running' && msg.state === 'waiting') {
          const proj = await api.getProject(msg.project_id).catch(() => null);
          void notifyWaiting({ id: msg.run_id, project_name: proj?.name });
        } else if (prev === 'waiting' && msg.state !== 'waiting') {
          clearWaitingBadge(msg.run_id);
        }
        if (isTerminal(msg.state) && !isTerminal(prev ?? 'queued')) {
          const proj = await api.getProject(msg.project_id).catch(() => null);
          void notifyComplete({
            id: msg.run_id,
            state: msg.state as 'succeeded' | 'failed' | 'cancelled',
            project_name: proj?.name,
          });
          if (isTauri() && enabled) {
            const icon = msg.state === 'succeeded' ? '✓' : msg.state === 'failed' ? '✗' : '⊘';
            invoke('notify', {
              title: `${icon} Run #${msg.run_id} ${msg.state}`,
              body: proj?.name ? `Project: ${proj.name}` : 'Run finished',
            }).catch(() => {});
          }
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setConnectionState('disconnected');
        setTimeout(() => { void seed().then(connect); }, 1000);
      };
      ws.onerror = () => { setConnectionState('disconnected'); };
    };

    void seed().then(connect);
    return () => {
      stopped = true;
      ws?.close();
      dispose();
    };
  }, [enabled]);
}
