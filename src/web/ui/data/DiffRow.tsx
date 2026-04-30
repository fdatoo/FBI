export interface DiffRowProps {
  status: 'added' | 'modified' | 'removed' | 'renamed';
  filename: string;
  href?: string;
  additions: number;
  deletions: number;
}

const STATUS_CHAR: Record<DiffRowProps['status'], string> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  renamed: 'R',
};

export function DiffRow({ status, filename, href, additions, deletions }: DiffRowProps) {
  return (
    <div className="grid grid-cols-[18px_1fr_40px_40px] items-center gap-2 px-2 py-0.5 border-b border-border font-mono text-[13px] last:border-0">
      <span className="text-accent text-center">{STATUS_CHAR[status]}</span>
      {href ? <a href={href} target="_blank" rel="noreferrer" className="text-accent truncate">{filename}</a> : <span className="text-text truncate">{filename}</span>}
      <span className="text-right text-ok">+{additions}</span>
      <span className="text-right text-fail">−{deletions}</span>
    </div>
  );
}
