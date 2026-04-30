import { Input } from '@ui/primitives/Input.js';
import { StateFilterButton, type StateCounts } from './StateFilterButton.js';
import type { RunsView } from './useRunsView.js';

export interface RunsFilterProps {
  value: string;
  onChange: (v: string) => void;
  view: RunsView;
  counts: StateCounts;
}

export function RunsFilter({ value, onChange, view, counts }: RunsFilterProps) {
  return (
    <div className="p-2 border-b border-border bg-surface flex items-center gap-2">
      <Input
        className="flex-1 min-w-0"
        placeholder="Filter by prompt / branch / id…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <StateFilterButton view={view} counts={counts} />
    </div>
  );
}
