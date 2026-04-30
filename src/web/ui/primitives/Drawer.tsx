import { useRef, type PointerEvent, type ReactNode } from 'react';
import { cn } from '../cn.js';

export interface DrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  header: ReactNode;
  children?: ReactNode;
  className?: string;
  /** When provided with `onHeightChange`, the drawer gains a top drag handle
   *  and applies the supplied height to its body. */
  height?: number;
  onHeightChange?: (next: number) => void;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={cn('transition-transform duration-fast ease-out', open ? 'rotate-0' : 'rotate-180')}
    >
      <path d="M3 4.5 L6 7.5 L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Drawer({ open, onToggle, header, children, className, height, onHeightChange }: DrawerProps) {
  const startY = useRef(0);
  const startH = useRef(0);
  const dragging = useRef(false);
  const resizable = open && typeof height === 'number' && typeof onHeightChange === 'function';

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!resizable) return;
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    startY.current = e.clientY;
    startH.current = height as number;
    dragging.current = true;
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!resizable || !dragging.current) return;
    const delta = startY.current - e.clientY;
    (onHeightChange as (n: number) => void)(startH.current + delta);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!resizable) return;
    (e.target as HTMLDivElement).releasePointerCapture?.(e.pointerId);
    dragging.current = false;
  };

  return (
    <div className={cn('border-t border-border-strong bg-surface flex flex-col flex-none', className)}>
      {resizable && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize drawer"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="h-1.5 cursor-ns-resize bg-border hover:bg-border-strong"
        />
      )}
      <div className="flex items-center px-3 py-1.5">
        <div className="flex-1 min-w-0 font-mono text-[13px] text-text-dim">{header}</div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
          onClick={() => onToggle(!open)}
          className="ml-2 flex items-center justify-center w-7 h-7 rounded-md text-text-faint hover:text-text hover:bg-surface-raised transition-colors duration-fast ease-out"
        >
          <Chevron open={open} />
        </button>
      </div>
      {open && (
        <div
          style={resizable ? { height: Math.max(0, (height as number) - 36) } : undefined}
          className="overflow-auto"
        >
          {children}
        </div>
      )}
    </div>
  );
}
