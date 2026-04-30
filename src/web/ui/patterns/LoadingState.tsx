export interface LoadingStateProps { label?: string; }

export function LoadingState({ label = 'Loading…' }: LoadingStateProps) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-[14px] text-text-faint p-4 font-mono">
      <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
      {label}
    </div>
  );
}
