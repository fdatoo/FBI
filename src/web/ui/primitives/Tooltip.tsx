import type { ReactElement, ReactNode } from 'react';
import { cloneElement } from 'react';

export interface TooltipProps {
  label: string;
  children: ReactElement;
}

export function Tooltip({ label, children }: TooltipProps): ReactNode {
  return cloneElement(children, { title: label, 'aria-label': (children.props as { 'aria-label'?: string })['aria-label'] ?? label });
}
