import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../cn.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
        className={cn(
          'bg-surface border border-border-strong rounded-xl shadow-popover w-full max-w-md outline-none',
          className,
        )}
      >
        <header className="px-5 py-3 border-b border-border">
          <h2 className="text-[16px] font-semibold">{title}</h2>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
