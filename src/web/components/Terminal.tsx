import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { TerminalController } from '../lib/terminalController.js';
import { detectScroll } from '../lib/scrollDetection.js';
import {
  record as traceRecord,
  isTracing,
  setTracing,
  subscribe as traceSubscribe,
  eventCount as traceEventCount,
  downloadTrace,
} from '../lib/terminalTrace.js';

declare global {
  interface Window {
    __fbiTerminalText?: () => string;
    __fbiIsAtBottom?: () => boolean;
  }
}

interface FbiHostElement extends HTMLDivElement {
  __fbiCleanupWinResize?: EventListener;
}

interface Props {
  runId: number;
  interactive: boolean;
}


function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const bg = s.getPropertyValue('--terminal-bg').trim() || '#060a0f';
  const fg = s.getPropertyValue('--terminal-fg').trim() || '#e2e8f0';
  return { background: bg, foreground: fg, cursor: bg, cursorAccent: bg };
}

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  const [isDriver, setIsDriver] = useState<boolean>(true);

  const [, forceTraceRerender] = useState(0);
  useEffect(() => traceSubscribe(() => forceTraceRerender((n) => n + 1)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setTracing(!isTracing());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let term: InstanceType<typeof Xterm> | null = null;
    let controller: TerminalController | null = null;
    let ro: ResizeObserver | null = null;
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    let winResizeTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollRaf: number | null = null;
    let scrollDisposable: { dispose(): void } | null = null;
    let unsubPause: (() => void) | null = null;
    let unsubRebuilding: (() => void) | null = null;
    let unsubDriver: (() => void) | null = null;
    let observer: MutationObserver | null = null;

    term = new Xterm({
      convertEol: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: readTheme(),
      cursorBlink: false,
      scrollback: 50000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL unavailable — xterm.js falls back to Canvas2D internally.
    }
    term.open(host);
    traceRecord('term.mount', { runId });

    observer = new MutationObserver(() => {
      term!.options.theme = readTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const rect = host.getBoundingClientRect();
    if (rect.width >= 4 && rect.height >= 4) {
      try { fit.fit(); } catch { /* layout may still be transitioning */ }
    }

    controller = new TerminalController(runId, term, host);
    controllerRef.current = controller;
    // Seed the interactive prop: the sibling useEffect([interactive, runId])
    // fires before this effect body sets controllerRef.current, so it runs
    // as a no-op. Apply the captured value now so initial interactive state is wired.
    controller.setInteractive(interactive);
    setReady(controller.isReady());
    if (!controller.isReady()) {
      controller.onReady(() => setReady(true));
    }

    setIsDriver(true); // reset optimistically — this tab is claiming driver for this run
    unsubPause = controller.onPauseChange((p) => setPaused(p));
    unsubRebuilding = controller.onRebuildingChange((r) => {
      if (host) host.style.visibility = r ? 'hidden' : '';
    });
    unsubDriver = controller.onDriverChange(setIsDriver);

    // term.onScroll fires whenever viewportY changes (user wheel,
    // scrollToLine, scrollToBottom, etc.).
    const onViewportScroll = () => {
      const s = detectScroll(term!);
      if (!s.atBottom) {
        // Pause immediately on scroll-up.
        controller?.onScroll(s);
        return;
      }
      // For resume (user scrolled back to bottom), throttle via rAF to
      // debounce rapid events while still catching the user's intent.
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        controller?.onScroll(detectScroll(term!));
      });
    };
    scrollDisposable = term.onScroll(onViewportScroll);

    // Expose text extraction for Playwright E2E tests.
    window.__fbiTerminalText = () => {
      const lines: string[] = [];
      const buf = term!.buffer.active;
      const limit = buf.baseY + term!.rows;
      for (let i = 0; i < limit; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n').trimEnd();
    };
    // Expose scroll-at-bottom state for Playwright E2E tests.
    window.__fbiIsAtBottom = () =>
      term!.buffer.active.viewportY === term!.buffer.active.baseY;

    const safeFit = (): boolean => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      try { fit.fit(); return true; } catch { return false; }
    };

    const runFit = () => {
      roTimer = null;
      if (safeFit()) {
        controller?.resize(term!.cols, term!.rows);
      }
    };
    ro = new ResizeObserver(() => {
      if (roTimer !== null) clearTimeout(roTimer);
      roTimer = setTimeout(runFit, 120);
    });
    ro.observe(host);

    const onWinResize = () => {
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      winResizeTimer = setTimeout(() => {
        winResizeTimer = null;
        if (safeFit()) {
          controller?.resize(term!.cols, term!.rows);
        }
      }, 120);
    };
    window.addEventListener('resize', onWinResize);

    // Store cleanup for window.resize so the synchronous cleanup function
    // can reach it.
    (host as FbiHostElement).__fbiCleanupWinResize = onWinResize;

    return () => {
      if (roTimer !== null) clearTimeout(roTimer);
      if (winResizeTimer !== null) clearTimeout(winResizeTimer);
      ro?.disconnect();
      observer?.disconnect();
      const onWinResize = (host as FbiHostElement).__fbiCleanupWinResize;
      if (onWinResize) window.removeEventListener('resize', onWinResize);
      unsubPause?.();
      unsubRebuilding?.();
      unsubDriver?.();
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      scrollDisposable?.dispose();
      delete window.__fbiTerminalText;
      delete window.__fbiIsAtBottom;
      controller?.dispose();
      controllerRef.current = null;
      term?.dispose();
      term = null;
    };
  // interactive is seeded synchronously above; the sibling effect handles updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    controllerRef.current?.setInteractive(interactive);
  }, [interactive, runId]);

  const onResumeClick = () => {
    void controllerRef.current?.resume();
  };

  return (
    <div className="relative h-full w-full bg-terminal flex flex-col">
      {!ready && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-terminal text-text-dim text-[12px]">
          <span>Loading terminal…</span>
        </div>
      )}
      {paused && (
        <div className="absolute top-0 left-0 right-0 z-10 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
            <span>⏸ Stream paused — you&apos;re viewing history.</span>
            <button
              type="button"
              onClick={onResumeClick}
              className="text-accent hover:text-accent-strong transition-colors duration-fast ease-out"
            >
              Resume stream
            </button>
          </div>
        </div>
      )}
      {!isDriver && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
          <span>Viewing only — terminal is being driven by another tab.</span>
        </div>
      )}
      {isTracing() && (
        <div
          className="absolute bottom-1 right-2 z-30 select-none rounded bg-red-900/80 px-2 py-0.5 text-[10px] font-mono text-red-100 shadow ring-1 ring-red-300/30 backdrop-blur"
          title="Terminal trace recording (Ctrl+Shift+D to stop). Click to download."
        >
          <button
            type="button"
            onClick={() => downloadTrace()}
            className="cursor-pointer"
          >
            ● REC {traceEventCount()} ↓
          </button>
        </div>
      )}
      {/* overflow:auto so when PTY > viewer dims, user can scroll to see the
          terminal canvas rather than it being clipped. */}
      <div ref={hostRef} className="h-full w-full" style={{ overflow: 'auto' }} data-testid="xterm" />
    </div>
  );
}
