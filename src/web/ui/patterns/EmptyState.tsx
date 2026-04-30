import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  hint?: ReactNode;
}

export function EmptyState({ title, description, action, hint }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 p-8 border border-dashed border-border-strong rounded-lg">
      <h2 className="font-mono text-[15px] text-text">{title}</h2>
      {description && <p className="text-[14px] text-text-dim max-w-sm">{description}</p>}
      {action}
      {hint && <div className="mt-2">{hint}</div>}
    </div>
  );
}
