import type { Terminal as Xterm } from '@xterm/xterm';
import { acquireShell, releaseShell, getLastSnapshot } from './shellRegistry.js';
import { publishUsage, publishState, publishTitle, publishBranch, publishChanges } from '../features/runs/usageBus.js';
import { record as traceRecord, strPreview } from './terminalTrace.js';
import type { ShellHandle } from './ws.js';
import { apiBase } from './api.js';
import type {
  UsageSnapshot,
  RunWsStateMessage,
  RunWsTitleMessage,
  RunWsBranchMessage,
  ChangesPayload,
  RunState,
} from '@shared/types.js';

const SCROLLBACK_CAP = 5 * 1024 * 1024;

/**
 * Owns the terminal's WebSocket lifecycle, snapshot/bytes plumbing, and
 * pause/resume state machine. On mount it fetches up to the last 5 MB of the
 * transcript and replays it into the terminal; live bytes are then streamed
 * directly. When the user scrolls up the live stream is paused (bytes buffered)
 * and resumed on scroll-to-bottom by draining the buffer.
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

  private disposed = false;

  // Bytes buffered while paused or rebuilding; drained on resume / after history load.
  private liveTailBytes: Uint8Array = new Uint8Array();

  private latestState: RunState = 'queued';
  private paused = false;
  private rebuilding = false;
  private rebuildingListeners = new Set<(r: boolean) => void>();
  private historyFetched = false;
  private pendingResumePromise: Promise<void> | null = null;
  private pauseListeners = new Set<(paused: boolean) => void>();
  private interactiveProp = false;

  private ready = false;
  private readyCbs: Array<() => void> = [];

  private isDriver = true;
  private driverChangeListeners = new Set<(d: boolean) => void>();

  constructor(runId: number, term: Xterm, host: HTMLElement) {
    this.runId = runId;
    this.term = term;
    this.host = host;
    this.shell = acquireShell(runId);
    traceRecord('controller.mount', { runId });

    this.unsubEvents = this.shell.onTypedEvent<{ type: string; snapshot?: unknown; state?: RunState }>((msg) => {
      if (this.disposed) return;
      if (msg.type === 'usage') publishUsage(runId, msg.snapshot as UsageSnapshot);
      else if (msg.type === 'state') {
        if (msg.state) this.latestState = msg.state;
        publishState(runId, msg as unknown as RunWsStateMessage);
      }
      else if (msg.type === 'title') publishTitle(runId, msg as unknown as RunWsTitleMessage);
      else if (msg.type === 'branch') publishBranch(runId, msg as unknown as RunWsBranchMessage);
      else if (msg.type === 'changes') publishChanges(runId, msg as unknown as ChangesPayload);
      else if (msg.type === 'driver_state') {
        const dm = msg as unknown as { is_driver: boolean };
        this.setDriver(dm.is_driver);
      }
    });

    this.unsubSnapshot = this.shell.onSnapshot((snap) => {
      if (this.disposed) return;
      traceRecord('controller.snapshot', { ansiLen: snap.ansi.length, cols: snap.cols, rows: snap.rows });
      if (this.paused) {
        traceRecord('controller.snapshot.dropped', { reason: 'paused' });
        return;
      }
      this.term.reset();
      this.term.write(snap.ansi);
      this.term.scrollToBottom();
      if (!this.historyFetched) {
        this.historyFetched = true;
        queueMicrotask(() => { void this.loadBoundedHistory(snap); });
      }
    });

    this.unsubBytes = this.shell.onBytes((data) => {
      if (this.disposed) return;
      if (this.paused || this.rebuilding) {
        // Buffer for later — drained on resume or after history rebuild.
        const next = new Uint8Array(this.liveTailBytes.byteLength + data.byteLength);
        next.set(this.liveTailBytes);
        next.set(data, this.liveTailBytes.byteLength);
        this.liveTailBytes = next;
        return;
      }
      this.term.write(data);
    });

    const cached = getLastSnapshot(runId);
    if (cached) {
      traceRecord('controller.snapshot.cached', { cols: cached.cols, rows: cached.rows });
      this.term.reset();
      this.term.write(cached.ansi);
      this.term.scrollToBottom();
      this.ready = true;
      this.historyFetched = true;
      queueMicrotask(() => { void this.loadBoundedHistory(cached); });
    }

    this.unsubOpen = this.shell.onOpen(() => {
      if (this.disposed) return;
      traceRecord('controller.hello', { cols: this.term.cols, rows: this.term.rows });
      this.shell.sendHello(this.term.cols, this.term.rows);
    });
  }

  setInteractive(on: boolean): void {
    if (this.disposed) return;
    this.interactiveProp = on;
    this.applyInteractive();
  }

  private applyInteractive(): void {
    if (this.disposed) return;
    const effective = this.interactiveProp && !this.paused;
    if (effective && !this.inputDisposable) {
      this.inputDisposable = this.term.onData((d) => {
        traceRecord('controller.input', strPreview(d));
        this.shell.send(new TextEncoder().encode(d));
      });
      this.hostClickHandler = () => this.term.focus();
      this.host.addEventListener('click', this.hostClickHandler);
      this.term.focus();
    } else if (!effective && this.inputDisposable) {
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

  getShell(): ShellHandle {
    return this.shell;
  }

  onReady(cb: () => void): void {
    if (this.ready) { queueMicrotask(cb); return; }
    this.readyCbs.push(cb);
  }

  isReady(): boolean {
    return this.ready;
  }

  private fireReady(): void {
    if (this.ready) return;
    this.ready = true;
    const cbs = this.readyCbs.splice(0);
    for (const cb of cbs) cb();
  }

  onDriverChange(cb: (d: boolean) => void): () => void {
    this.driverChangeListeners.add(cb);
    cb(this.isDriver);
    return () => { this.driverChangeListeners.delete(cb); };
  }

  private setDriver(d: boolean): void {
    if (this.isDriver === d) return;
    this.isDriver = d;
    for (const cb of this.driverChangeListeners) cb(d);
  }

  onPauseChange(cb: (paused: boolean) => void): () => void {
    this.pauseListeners.add(cb);
    return () => { this.pauseListeners.delete(cb); };
  }

  onRebuildingChange(cb: (rebuilding: boolean) => void): () => void {
    this.rebuildingListeners.add(cb);
    return () => { this.rebuildingListeners.delete(cb); };
  }

  private setRebuilding(r: boolean): void {
    if (this.rebuilding === r) return;
    this.rebuilding = r;
    const snap = [...this.rebuildingListeners];
    for (const cb of snap) {
      try { cb(r); } catch (err) {
        traceRecord('controller.rebuilding.listener.error', { err: String(err) });
      }
    }
  }

  private emitPauseChange(): void {
    const snap = [...this.pauseListeners];
    for (const cb of snap) {
      try { cb(this.paused); } catch (err) {
        traceRecord('controller.pause.listener.error', { err: String(err) });
      }
    }
  }

  pause(): void {
    if (this.disposed || this.paused) return;
    traceRecord('controller.pause', { runId: this.runId });
    this.paused = true;
    this.applyInteractive();
    this.emitPauseChange();
  }

  onScroll(s: { atBottom: boolean; nearTop: boolean }): void {
    if (this.disposed || this.rebuilding) return;
    if (!this.paused && !s.atBottom) {
      this.pause();
      return;
    }
    if (this.paused && s.atBottom) {
      void this.resume();
    }
  }

  async resume(): Promise<void> {
    if (this.disposed || !this.paused) return;
    if (this.pendingResumePromise) return this.pendingResumePromise;
    traceRecord('controller.resume', { runId: this.runId });

    this.pendingResumePromise = (async () => {
      try {
        if (this.liveTailBytes.byteLength > 0) {
          // Gate onScroll during the tail write to prevent the auto-scroll-to-bottom
          // xterm does on each write from re-triggering resume.
          this.setRebuilding(true);
          const tailLength = this.liveTailBytes.byteLength;
          try {
            await this.writeAndWait(this.liveTailBytes);
          } finally {
            // Flush only bytes that arrived during writeAndWait (not the ones already written).
            const extra = this.liveTailBytes.subarray(tailLength);
            this.liveTailBytes = new Uint8Array();
            if (extra.byteLength > 0 && !this.disposed) this.term.write(extra);
            this.setRebuilding(false);
          }
        } else {
          this.liveTailBytes = new Uint8Array();
        }
        if (this.disposed) return;
        this.term.scrollToBottom();
        this.paused = false;
        this.applyInteractive();
        this.emitPauseChange();
      } finally {
        this.pendingResumePromise = null;
      }
    })();
    return this.pendingResumePromise;
  }

  private writeAndWait(data: Uint8Array | string): Promise<void> {
    return new Promise<void>((resolve) => this.term.write(data, resolve));
  }

  private async rebuildXterm(buffers: Array<Uint8Array | string>): Promise<void> {
    const SUB_CHUNK = 64 * 1024;
    this.term.reset();
    for (const b of buffers) {
      if (typeof b === 'string') {
        await this.writeAndWait(b);
      } else {
        for (let off = 0; off < b.byteLength; off += SUB_CHUNK) {
          await this.writeAndWait(b.subarray(off, Math.min(off + SUB_CHUNK, b.byteLength)));
        }
      }
    }
  }

  /**
   * Fetch the last SCROLLBACK_CAP bytes of the transcript and replay them into
   * the terminal. Called once after the first snapshot. rebuilding=true gates
   * live bytes into liveTailBytes for the duration so they are appended after
   * the history replay.
   */
  private async loadBoundedHistory(snap: import('@shared/types.js').RunWsSnapshotMessage): Promise<void> {
    const N = snap.byte_offset;
    const start = Math.max(0, N - SCROLLBACK_CAP);
    const end = N - 1;

    if (end < start) {
      this.setRebuilding(false);
      this.fireReady();
      return;
    }

    let tailLength = 0;
    this.setRebuilding(true);
    try {
      const res = await fetch(apiBase() + `/api/runs/${this.runId}/transcript`, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (this.disposed) return;
      if (!res.ok && res.status !== 206) {
        traceRecord('controller.history.error', { status: res.status });
        return;
      }
      const historyBytes = new Uint8Array(await res.arrayBuffer());
      if (this.disposed) return;
      if (historyBytes.byteLength === 0) {
        traceRecord('controller.history.complete', { bytes: 0 });
        return;
      }
      const tail = this.liveTailBytes;
      tailLength = tail.byteLength;
      await this.rebuildXterm([historyBytes, tail]);
      if (this.disposed) return;
      this.term.scrollToBottom();
      traceRecord('controller.history.complete', { bytes: historyBytes.byteLength });
    } catch (err) {
      traceRecord('controller.history.error', { err: String(err) });
    } finally {
      const extra = this.liveTailBytes.subarray(tailLength);
      this.liveTailBytes = new Uint8Array();
      if (extra.byteLength > 0 && !this.disposed) this.term.write(extra);
      this.setRebuilding(false);
      this.fireReady();
    }
  }

  /** @internal — for tests only. */
  _debugBuffers(): { liveTailBytes: Uint8Array; latestState: RunState; paused: boolean; rebuilding: boolean } {
    return {
      liveTailBytes: this.liveTailBytes,
      latestState: this.latestState,
      paused: this.paused,
      rebuilding: this.rebuilding,
    };
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
    this.pauseListeners.clear();
    this.rebuildingListeners.clear();
    this.driverChangeListeners.clear();
    releaseShell(this.runId);
  }
}
