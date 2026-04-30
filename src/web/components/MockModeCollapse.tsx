import { useState } from 'react';
import { Select } from '@ui/primitives/Select.js';

export interface MockModeValue {
  mock: boolean;
  mock_scenario: string | null;
}

export function MockModeCollapse(props: {
  value: MockModeValue;
  onChange: (v: MockModeValue) => void;
  /** null = capability flag off; component renders nothing */
  scenarios: string[] | null;
}): JSX.Element | null {
  const { value, onChange, scenarios } = props;
  const [expanded, setExpanded] = useState(false);
  if (scenarios === null) return null;

  const summary = value.mock
    ? `mock · ${value.mock_scenario ?? 'default'}`
    : 'off';

  function toggle() {
    if (value.mock) onChange({ mock: false, mock_scenario: null });
    else onChange({ mock: true, mock_scenario: scenarios![0] ?? 'default' });
  }
  function pickScenario(s: string) {
    onChange({ mock: true, mock_scenario: s });
  }

  return (
    <div className="border border-border-strong rounded-md overflow-hidden bg-surface">
      <button
        type="button"
        data-testid="mockmode-toggle"
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-surface-raised transition-colors duration-fast ease-out"
        aria-expanded={expanded}
      >
        <span aria-hidden className="shrink-0 inline-block w-3 text-text-dim">{expanded ? '▾' : '▸'}</span>
        <span className="shrink-0 font-medium text-sm">Mock mode (Quantico)</span>
        <span className="min-w-0 truncate text-text-dim text-sm">· {summary}</span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-2 bg-surface-sunken">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              data-testid="mockmode-enable"
              checked={value.mock}
              onChange={toggle}
            />
            <span className="text-sm">Use mock Claude instead of the real one</span>
          </label>
          {value.mock && (
            <label className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm text-text-dim">Scenario</span>
              <Select
                data-testid="mockmode-scenario-select"
                value={value.mock_scenario ?? 'default'}
                onChange={(e) => pickScenario(e.target.value)}
                className="max-w-[240px]"
              >
                {scenarios.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Select>
            </label>
          )}
          <p className="text-xs text-text-faint">
            Bypasses the LLM. For testing terminal/auto-resume/env behavior.
          </p>
        </div>
      )}
    </div>
  );
}
