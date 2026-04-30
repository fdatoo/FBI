import { type ReactNode } from 'react';
import { cn } from '../cn.js';

export interface TabDef<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabDef<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: TabsProps<T>) {
  return (
    <div role="tablist" className={cn('flex border-b border-border', className)}>
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              'font-mono text-[13px] px-3 py-1.5 border-b-2 transition-colors duration-fast ease-out',
              active
                ? 'text-accent-strong border-accent'
                : 'text-text-faint border-transparent hover:text-text',
            )}
          >
            {t.label}
            {t.count != null && <span className="ml-1 text-text-faint">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
