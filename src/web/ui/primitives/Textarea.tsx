import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'bg-surface-sunken text-text placeholder:text-text-faint border border-border-strong rounded-md px-3 py-2 text-sm font-mono leading-5',
        'focus:outline-none focus:border-accent focus:shadow-focus transition-[border,box-shadow] duration-fast ease-out',
        'disabled:opacity-50 disabled:cursor-not-allowed resize-y min-h-[96px]',
        className,
      )}
      {...rest}
    />
  );
});
