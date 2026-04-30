import { cn } from '../cn.js';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  'aria-label'?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, disabled, id, className, ...aria }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      id={id}
      aria-label={aria['aria-label']}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className={cn(
        'appearance-none w-[14px] h-[14px] rounded-sm border border-border-strong bg-surface',
        'checked:bg-accent checked:border-accent',
        'focus-visible:shadow-focus outline-none transition-colors duration-fast ease-out',
        className,
      )}
    />
  );
}
