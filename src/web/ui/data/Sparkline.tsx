export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  'aria-label': string;
}

export function Sparkline({ values, width = 140, height = 28, ...aria }: SparklineProps) {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg role="img" aria-label={aria['aria-label']} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.5" points={points} />
    </svg>
  );
}
