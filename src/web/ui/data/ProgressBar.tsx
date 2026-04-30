export interface ProgressBarProps {
  value: number;
  max?: number;
  'aria-label': string;
}

export function ProgressBar({ value, max = 100, ...aria }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={aria['aria-label']}
      className="h-1 w-full bg-surface-sunken rounded-full overflow-hidden"
    >
      <span className="block h-full bg-accent rounded-full transition-all duration-base ease-out" style={{ width: `${pct}%` }} />
    </div>
  );
}
