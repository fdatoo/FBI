import { forwardRef, type AnchorHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link(
  { className, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      className={cn('text-accent hover:text-accent-strong transition-colors duration-fast ease-out', className)}
      {...rest}
    />
  );
});
