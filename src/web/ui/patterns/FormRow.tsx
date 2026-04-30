import type { ReactNode } from 'react';
import { FieldLabel } from '../primitives/FieldLabel.js';

export interface FormRowProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}

export function FormRow({ label, hint, htmlFor, children }: FormRowProps) {
  return (
    <div className="mb-4">
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {hint && <p className="text-[13px] text-text-dim mb-1.5">{hint}</p>}
      {children}
    </div>
  );
}
