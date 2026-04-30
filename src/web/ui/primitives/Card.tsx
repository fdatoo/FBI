import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type CardVariant = 'raised' | 'flat';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
}

export function Card({ variant = 'raised', className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border-strong',
        variant === 'raised' && 'bg-surface shadow-card',
        className,
      )}
      {...rest}
    />
  );
}
