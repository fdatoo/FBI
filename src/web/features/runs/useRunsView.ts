import { useCallback, useMemo, useState } from 'react';
import type { Run, RunState } from '@shared/types.js';

export const STORAGE_KEY = 'fbi.runs.view.v1';

const ALL_STATES: readonly RunState[] = [
  'starting', 'running', 'waiting', 'awaiting_resume', 'queued', 'succeeded', 'failed', 'cancelled',
];

const ACTIVE_STATES = new Set<RunState>(['starting', 'running', 'waiting', 'awaiting_resume', 'queued']);

const STATE_SET = new Set<string>(ALL_STATES);

interface StoredView {
  filter: RunState[];
  groupByState: boolean;
}

function loadStored(): StoredView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { filter: [], groupByState: false };
    const parsed = JSON.parse(raw) as Partial<StoredView>;
    const filter = Array.isArray(parsed.filter)
      ? parsed.filter.filter((s): s is RunState => typeof s === 'string' && STATE_SET.has(s))
      : [];
    const groupByState = typeof parsed.groupByState === 'boolean' ? parsed.groupByState : false;
    return { filter, groupByState };
  } catch {
    return { filter: [], groupByState: false };
  }
}

function saveStored(v: StoredView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* localStorage may be unavailable in some embedded contexts — ignore */
  }
}

export type RunsViewResult =
  | { mode: 'flat'; active: readonly Run[]; rest: readonly Run[] }
  | { mode: 'grouped'; groups: readonly { state: RunState; runs: readonly Run[] }[] };

export interface RunsView {
  filter: ReadonlySet<RunState>;
  groupByState: boolean;
  toggleState(s: RunState): void;
  clearFilter(): void;
  setGroupByState(v: boolean): void;
}

export function useRunsView(): RunsView {
  const [state, setState] = useState<StoredView>(() => loadStored());
  const filterSet = useMemo(() => new Set<RunState>(state.filter), [state.filter]);

  const toggleState = useCallback((s: RunState) => {
    setState((prev) => {
      const next = new Set(prev.filter);
      if (next.has(s)) next.delete(s); else next.add(s);
      const updated: StoredView = { ...prev, filter: [...next] };
      saveStored(updated);
      return updated;
    });
  }, []);

  const clearFilter = useCallback(() => {
    setState((prev) => {
      const updated: StoredView = { ...prev, filter: [] };
      saveStored(updated);
      return updated;
    });
  }, []);

  const setGroupByState = useCallback((v: boolean) => {
    setState((prev) => {
      const updated: StoredView = { ...prev, groupByState: v };
      saveStored(updated);
      return updated;
    });
  }, []);

  return { filter: filterSet, groupByState: state.groupByState, toggleState, clearFilter, setGroupByState };
}

export function applyRunsView(
  runs: readonly Run[],
  view: { filter: ReadonlySet<RunState>; groupByState: boolean },
): RunsViewResult {
  const filtered = view.filter.size === 0 ? runs : runs.filter((r) => view.filter.has(r.state));
  const sorted = [...filtered].sort((a, b) => b.state_entered_at - a.state_entered_at);

  if (view.groupByState) {
    const groups = ALL_STATES
      .map((state) => ({ state, runs: sorted.filter((r) => r.state === state) }))
      .filter((g) => g.runs.length > 0);
    return { mode: 'grouped', groups };
  }

  const active = sorted.filter((r) => ACTIVE_STATES.has(r.state));
  const rest = sorted.filter((r) => !ACTIVE_STATES.has(r.state));
  return { mode: 'flat', active, rest };
}
