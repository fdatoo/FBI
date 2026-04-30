import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn.js';

export interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** Initial / default width as a CSS string, e.g. '360px'. */
  leftWidth?: string;
  /** Minimum left-pane width in px. Default 240. */
  minLeftWidth?: number;
  /** Maximum left-pane width in px. Default 640. */
  maxLeftWidth?: number;
  /** When set, persists drag width to localStorage under `fbi-splitpane:<key>`. */
  storageKey?: string;
  className?: string;
}

function parseInitialWidth(
  leftWidth: string | undefined,
  storageKey: string | undefined,
  minLeft: number,
  maxLeft: number,
): number {
  // Try persisted value first.
  if (storageKey) {
    const stored = localStorage.getItem(`fbi-splitpane:${storageKey}`);
    if (stored !== null) {
      const n = Number(stored);
      if (Number.isFinite(n)) return Math.min(maxLeft, Math.max(minLeft, n));
    }
  }
  // Fall back to the prop.
  if (leftWidth) {
    const n = parseFloat(leftWidth);
    if (Number.isFinite(n)) return Math.min(maxLeft, Math.max(minLeft, n));
  }
  return 360;
}

export function SplitPane({
  left,
  right,
  leftWidth = '360px',
  minLeftWidth = 240,
  maxLeftWidth = 640,
  storageKey,
  className,
}: SplitPaneProps) {
  const [width, setWidth] = useState<number>(() =>
    parseInitialWidth(leftWidth, storageKey, minLeftWidth, maxLeftWidth),
  );
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep a stable ref to storageKey so cleanup callbacks don't close over stale values.
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const minRef = useRef(minLeftWidth);
  minRef.current = minLeftWidth;
  const maxRef = useRef(maxLeftWidth);
  maxRef.current = maxLeftWidth;

  const clamp = useCallback(
    (v: number) => Math.min(maxLeftWidth, Math.max(minLeftWidth, v)),
    [minLeftWidth, maxLeftWidth],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMouseMove = (ev: MouseEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const newW = Math.min(
          maxRef.current,
          Math.max(minRef.current, ev.clientX - rect.left),
        );
        setWidth(newW);
      };

      const onMouseUp = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        setDragging(false);

        // Persist final width.
        if (storageKeyRef.current) {
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
            const finalW = Math.min(
              maxRef.current,
              Math.max(minRef.current, ev.clientX - rect.left),
            );
            localStorage.setItem(
              `fbi-splitpane:${storageKeyRef.current}`,
              String(finalW),
            );
          }
        }
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setWidth((w) => {
          const next = clamp(w + 16);
          if (storageKeyRef.current) localStorage.setItem(`fbi-splitpane:${storageKeyRef.current}`, String(next));
          return next;
        });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setWidth((w) => {
          const next = clamp(w - 16);
          if (storageKeyRef.current) localStorage.setItem(`fbi-splitpane:${storageKeyRef.current}`, String(next));
          return next;
        });
      }
    },
    [clamp],
  );

  // Clean up body styles if component unmounts while dragging.
  useEffect(() => {
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  return (
    <div ref={containerRef} className={cn('h-full min-h-0 flex', className)}>
      <aside
        className="shrink-0 bg-surface min-h-0 overflow-auto"
        style={{ width }}
      >
        {left}
      </aside>

      {/* Resizable divider */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={minLeftWidth}
        aria-valuemax={maxLeftWidth}
        aria-label="Resize pane"
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        className={cn(
          'group shrink-0 w-[6px] cursor-col-resize relative bg-border',
          'hover:bg-border-strong focus:outline-none focus-visible:bg-accent/40',
          dragging && 'bg-accent/50',
          'transition-colors duration-fast',
        )}
      >
        <span className={cn(
          'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
          'w-[3px] h-8 rounded-full pointer-events-none',
          'bg-border-strong group-hover:bg-text-faint transition-colors duration-fast',
          dragging && 'bg-accent',
        )} />
      </div>

      <main className="flex-1 min-w-0 min-h-0 overflow-auto">{right}</main>
    </div>
  );
}
