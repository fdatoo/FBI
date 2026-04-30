import { cn } from '../cn.js';
import type { FileDiffHunk } from '@shared/types.js';

export interface DiffBlockProps {
  hunks: FileDiffHunk[];
  truncated?: boolean;
  className?: string;
}

export function DiffBlock({ hunks, truncated, className }: DiffBlockProps) {
  return (
    <div className={cn('font-mono text-[12px]', className)}>
      {hunks.map((h, i) => (
        <div key={i} className="border-t border-border">
          <div className="px-3 py-0.5 text-text-faint bg-surface-raised">{h.header}</div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              className={cn(
                'px-3 whitespace-pre',
                l.kind === 'add' ? 'bg-ok-subtle text-ok' :
                l.kind === 'del' ? 'bg-fail-subtle text-fail' :
                'text-text-dim',
              )}
            >
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}{l.text}
            </div>
          ))}
        </div>
      ))}
      {truncated && (
        <div className="px-3 py-1 text-text-faint text-[12px] border-t border-border">
          diff truncated — open on GitHub
        </div>
      )}
    </div>
  );
}
