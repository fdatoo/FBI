import type { ReactNode } from 'react';
import { cn } from '../cn.js';

export interface SectionProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({ title, actions, children, className }: SectionProps) {
  return (
    <section className={cn('space-y-3', className)}>
      <header className="flex items-center justify-between">
        <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-text">{title}</h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div>{children}</div>
    </section>
  );
}
