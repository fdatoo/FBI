import { cn } from '../../cn.js';

export interface ExternalLinkProps {
  className?: string;
  size?: number;
}

export function ExternalLink({ className, size = 12 }: ExternalLinkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={cn('inline-block align-[-1px]', className)}
    >
      <path
        d="M4.5 2.5 H2.5 V9.5 H9.5 V7.5 M7 2.5 H9.5 V5 M9.5 2.5 L6 6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
