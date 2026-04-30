import type { HTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full text-xs', className)} {...rest} />;
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('text-text-faint text-[12px] uppercase tracking-[0.08em]', className)} {...rest} />;
}

export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-border last:border-0', className)} {...rest} />;
}

export function TH({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('text-left px-2 py-1 font-semibold', className)} {...rest} />;
}

export function TD({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-2 py-1 font-mono', className)} {...rest} />;
}
