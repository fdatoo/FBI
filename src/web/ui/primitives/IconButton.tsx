import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center w-7 h-7 rounded-md text-text-dim hover:text-text hover:bg-surface-raised transition-colors duration-fast ease-out disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
});
