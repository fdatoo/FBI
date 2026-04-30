import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn.js';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  hint?: string;
}

export interface MenuSection {
  label?: string;
  items: readonly MenuItem[];
}

export interface MenuProps {
  trigger: ReactNode;
  /** Either flat items (legacy) OR grouped sections. */
  items?: readonly MenuItem[];
  sections?: readonly MenuSection[];
}

export function Menu({ trigger, items, sections }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const resolved: readonly MenuSection[] = sections ?? (items ? [{ items }] : []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div role="menu"
          className="absolute right-0 mt-1 z-[var(--z-palette)] min-w-[220px] bg-surface-raised border border-border-strong rounded-md shadow-popover py-1">
          {resolved.map((s, i) => (
            <div key={i}>
              {i > 0 && <div className="border-t border-border my-1" role="separator" />}
              {s.label && (
                <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-[0.08em] text-text-faint">
                  {s.label}
                </div>
              )}
              {s.items.map((it) => (
                <button
                  key={it.id}
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => { setOpen(false); it.onSelect(); }}
                  className={cn(
                    'w-full text-left flex items-center gap-2 px-3 py-1.5 text-sm transition-colors duration-fast ease-out',
                    it.danger ? 'text-fail hover:bg-fail-subtle' : 'text-text hover:bg-surface',
                    it.disabled && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <span className="w-3 inline-flex justify-center">
                    {it.checked ? (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="M1.5 5 L4 7.5 L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="flex-1">{it.label}</span>
                  {it.hint && <span className="text-[11px] text-text-faint">{it.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
