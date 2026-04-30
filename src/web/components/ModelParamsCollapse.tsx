import { useState } from 'react';
import { Select } from '@ui/primitives/Select.js';

export interface ModelParamsValue {
  model: string | null;
  effort: string | null;
  subagent_model: string | null;
}

const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
  { value: 'haiku', label: 'haiku' },
] as const;

const SUBAGENT_OPTIONS = [
  { value: '', label: 'Inherit' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
  { value: 'haiku', label: 'haiku' },
] as const;

function effortOptionsFor(model: string | null): string[] {
  if (model === 'haiku') return [];
  if (model === 'opus') return ['low', 'medium', 'high', 'xhigh', 'max'];
  return ['low', 'medium', 'high', 'max'];
}

function effortStillValid(model: string | null, effort: string | null): boolean {
  if (effort === null) return true;
  return effortOptionsFor(model).includes(effort);
}

export function ModelParamsCollapse(props: {
  value: ModelParamsValue;
  onChange: (v: ModelParamsValue) => void;
}): JSX.Element {
  const { value, onChange } = props;
  const [expanded, setExpanded] = useState(false);

  const summary =
    `${value.model ?? 'default'} · effort: ${value.effort ?? 'default'} · ` +
    `subagent: ${value.subagent_model ?? 'inherit'}`;

  const effortDisabled = value.model === 'haiku';
  const effortChoices = effortOptionsFor(value.model);

  function setModel(next: string | null): void {
    const effort = effortStillValid(next, value.effort) ? value.effort : null;
    onChange({ model: next, effort, subagent_model: value.subagent_model });
  }
  function setEffort(next: string | null): void {
    onChange({ model: value.model, effort: next, subagent_model: value.subagent_model });
  }
  function setSubagent(next: string | null): void {
    onChange({ model: value.model, effort: value.effort, subagent_model: next });
  }

  return (
    <div className="border border-border-strong rounded-md overflow-hidden bg-surface">
      <button
        type="button"
        data-testid="modelparams-toggle"
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-surface-raised transition-colors duration-fast ease-out"
        aria-expanded={expanded}
      >
        <span aria-hidden className="shrink-0 inline-block w-3 text-text-dim">{expanded ? '▾' : '▸'}</span>
        <span className="shrink-0 font-medium text-sm">Model &amp; effort</span>
        <span
          data-testid="modelparams-summary"
          className="min-w-0 truncate text-text-dim text-sm"
        >
          · {summary}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-2 bg-surface-sunken">
          <label className="flex items-center gap-3">
            <span className="w-36 shrink-0 text-sm text-text-dim">Model</span>
            <Select
              data-testid="modelparams-model-select"
              value={value.model ?? ''}
              onChange={(e) => setModel(e.target.value === '' ? null : e.target.value)}
              className="max-w-[200px]"
            >
              {MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </label>
          <div>
            <label className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm text-text-dim">Effort</span>
              <Select
                data-testid="modelparams-effort-select"
                value={value.effort ?? ''}
                disabled={effortDisabled}
                onChange={(e) => setEffort(e.target.value === '' ? null : e.target.value)}
                className="max-w-[200px]"
              >
                <option value="">Default</option>
                {effortChoices.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </Select>
            </label>
            {effortDisabled && (
              <p className="ml-[9.75rem] mt-1 text-xs text-text-faint">Not supported on Haiku</p>
            )}
          </div>
          <label className="flex items-center gap-3">
            <span className="w-36 shrink-0 text-sm text-text-dim">Subagent model</span>
            <Select
              data-testid="modelparams-subagent-select"
              value={value.subagent_model ?? ''}
              onChange={(e) => setSubagent(e.target.value === '' ? null : e.target.value)}
              className="max-w-[200px]"
            >
              {SUBAGENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </label>
        </div>
      )}
    </div>
  );
}
