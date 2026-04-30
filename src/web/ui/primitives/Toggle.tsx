import { cn } from '../cn.js';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  'aria-label': string;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, disabled, className, ...aria }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria['aria-label']}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-7 h-4 rounded-full border transition-colors duration-fast ease-out',
        checked ? 'bg-accent-subtle border-accent' : 'bg-surface-raised border-border-strong',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
    >
      <span
        className={cn(
          'absolute top-[1px] w-3 h-3 rounded-full transition-all duration-fast ease-out',
          checked ? 'left-[13px] bg-accent' : 'left-[1px] bg-text-faint',
        )}
      />
    </button>
  );
}
