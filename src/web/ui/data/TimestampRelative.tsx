export interface TimestampRelativeProps { iso: string; }

export function TimestampRelative({ iso }: TimestampRelativeProps) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  let text: string;
  if (diff < 10) text = 'now';
  else if (diff < 60) text = `${Math.round(diff)}s`;
  else if (diff < 3600) text = `${Math.round(diff / 60)}m`;
  else if (diff < 86400) text = `${Math.round(diff / 3600)}h`;
  else text = `${Math.round(diff / 86400)}d`;
  return <time dateTime={iso} title={new Date(iso).toLocaleString()} className="font-mono text-[13px] text-text-faint">{text}</time>;
}
