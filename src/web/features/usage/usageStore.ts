import type { UsageState, UsageWsMessage, UsageWsThresholdMessage } from '@shared/types.js';
import { api, wsBase } from '../../lib/api.js';

type SnapshotListener = (s: UsageState) => void;
type ThresholdListener = (m: UsageWsThresholdMessage) => void;

class UsageStore {
  private snapshot: UsageState | null = null;
  private lastUpdatedAt: number | null = null;
  private ws: WebSocket | null = null;
  private snapSubs = new Set<SnapshotListener>();
  private threshSubs = new Set<ThresholdListener>();
  private updatedAtSubs = new Set<(t: number | null) => void>();
  private reconnectDelay = 1000;
  private started = false;

  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    void this.fetchInitial();
    this.connect();
  }

  getSnapshot(): UsageState | null { return this.snapshot; }
  getLastUpdatedAt(): number | null { return this.lastUpdatedAt; }

  onSnapshot(cb: SnapshotListener): () => void {
    this.snapSubs.add(cb);
    if (this.snapshot) cb(this.snapshot);
    return () => { this.snapSubs.delete(cb); };
  }

  onUpdatedAt(cb: (t: number | null) => void): () => void {
    this.updatedAtSubs.add(cb);
    cb(this.lastUpdatedAt);
    return () => { this.updatedAtSubs.delete(cb); };
  }

  onThreshold(cb: ThresholdListener): () => void {
    this.threshSubs.add(cb);
    return () => { this.threshSubs.delete(cb); };
  }

  _resetForTest(): void {
    this.started = false;
    this.snapshot = null;
    this.lastUpdatedAt = null;
    this.snapSubs.clear();
    this.threshSubs.clear();
    this.updatedAtSubs.clear();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.reconnectDelay = 1000;
  }

  private async fetchInitial(): Promise<void> {
    try {
      const state = await api.getUsage();
      this.apply(state);
    } catch { /* fall through to WS */ }
  }

  private connect(): void {
    const ws = new WebSocket(`${wsBase()}/api/ws/usage`);
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse((ev as MessageEvent).data as string) as UsageWsMessage;
        if (m.type === 'snapshot') this.apply(m.state);
        else if (m.type === 'threshold_crossed') {
          for (const cb of this.threshSubs) cb(m);
        }
      } catch { /* ignore */ }
    });
    ws.addEventListener('open', () => { this.reconnectDelay = 1000; });
    ws.addEventListener('close', () => {
      this.ws = null;
      const d = this.reconnectDelay;
      this.reconnectDelay = Math.min(30_000, d * 2);
      setTimeout(() => this.connect(), d);
    });
  }

  private apply(s: UsageState): void {
    this.snapshot = s;
    this.lastUpdatedAt = Date.now();
    for (const cb of this.snapSubs) cb(s);
    for (const cb of this.updatedAtSubs) cb(this.lastUpdatedAt);
  }
}

export const usageStore = new UsageStore();
