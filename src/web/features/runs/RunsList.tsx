import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RunsFilter } from './RunsFilter.js';
import { RunRow } from './RunRow.js';
import { useRunsView, applyRunsView } from './useRunsView.js';
import type { StateCounts } from './StateFilterButton.js';
import type { Run, RunState } from '@shared/types.js';
import { useKeyBinding, keymap } from '@ui/shell/KeyMap.js';
import { contextMenuRegistry } from '@ui/shell/contextMenuRegistry.js';
import { usePaneRegistration, usePaneFocus } from '@ui/shell/PaneFocusContext.js';
import { useModifierKeyHeld } from '../../hooks/useModifierKeyHeld.js';
import { cn } from '@ui/cn.js';

export interface RunsListProps {
  runs: readonly Run[];
  toHref: (r: Run) => string;
  currentId?: number | null;
}

const ACTIVE_STATES = new Set<RunState>(['starting', 'running', 'waiting', 'awaiting_resume', 'queued']);

const TONE_TEXT: Record<RunState, string> = {
  starting: 'text-run',
  running: 'text-run',
  waiting: 'text-attn',
  awaiting_resume: 'text-warn',
  queued: 'text-text-faint',
  succeeded: 'text-ok',
  failed: 'text-fail',
  cancelled: 'text-text-faint',
  resume_failed: 'text-fail',
};

export function RunsList({ runs, toHref, currentId }: RunsListProps) {
  const [filter, setFilter] = useState('');
  const view = useRunsView();
  const nav = useNavigate();
  const modHeld = useModifierKeyHeld();
  usePaneRegistration('runs-sidebar', 1);
  const { isFocused, focus } = usePaneFocus('runs-sidebar');

  const textFiltered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return runs;
    return runs.filter((r) =>
      String(r.id).includes(q) ||
      (r.title ?? '').toLowerCase().includes(q) ||
      (r.branch_name ?? '').toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q),
    );
  }, [runs, filter]);

  const counts: StateCounts = useMemo(() => {
    const base: StateCounts = {
      starting: 0, running: 0, waiting: 0, awaiting_resume: 0, queued: 0,
      succeeded: 0, failed: 0, cancelled: 0, resume_failed: 0,
    };
    for (const r of textFiltered) base[r.state]++;
    return base;
  }, [textFiltered]);

  const result = useMemo(
    () => applyRunsView(textFiltered, { filter: view.filter, groupByState: view.groupByState }),
    [textFiltered, view.filter, view.groupByState],
  );

  const flatForNav: readonly Run[] = useMemo(() => {
    if (result.mode === 'flat') return [...result.active, ...result.rest];
    return result.groups.flatMap((g) => g.runs);
  }, [result]);

  // First 9 active runs, in the same order they appear in the list.
  const activeRuns = useMemo(
    () => flatForNav.filter((r) => ACTIVE_STATES.has(r.state)).slice(0, 9),
    [flatForNav],
  );

  // Stable refs so keymap handlers registered once can always read fresh data.
  const stateRef = useRef({ flatForNav, currentId, toHref, nav });
  stateRef.current = { flatForNav, currentId, toHref, nav };
  const activeRunsRef = useRef(activeRuns);
  activeRunsRef.current = activeRuns;
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;

  function step(dir: 1 | -1): void {
    const { flatForNav: list, currentId: cur, toHref: href, nav: n } = stateRef.current;
    if (list.length === 0) return;
    const idx = cur == null ? -1 : list.findIndex((r) => r.id === cur);
    const nextIdx = idx < 0 ? (dir === 1 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
    n(href(list[nextIdx]));
  }

  useKeyBinding({ chord: 'j', handler: () => step(1), description: 'Next run' }, []);
  useKeyBinding({ chord: 'k', handler: () => step(-1), description: 'Previous run' }, []);

  useEffect(() => {
    return contextMenuRegistry.register('run-row', (el) => {
      const runId = el.dataset.contextRunId ?? '';
      const branch = el.dataset.contextBranch ?? '';
      return [
        {
          id: 'open',
          label: 'Open run',
          onSelect: () => nav(`/runs/${runId}`),
        },
        {
          id: 'copy-run-id',
          label: 'Copy run ID',
          onSelect: () => void navigator.clipboard.writeText(`#${runId}`),
        },
        ...(branch
          ? [{
              id: 'copy-branch',
              label: 'Copy branch name',
              onSelect: () => void navigator.clipboard.writeText(branch),
            }]
          : []),
      ];
    });
  }, [nav]);

  // Register mod+1–9 once; use refs for fresh data inside handlers.
  useEffect(() => {
    const offs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
      keymap.register({
        chord: `mod+${n}`,
        description: n === 1 ? 'Jump to active run 1–9' : undefined,
        when: () => isFocusedRef.current,
        handler: () => {
          const run = activeRunsRef.current[n - 1];
          if (run) stateRef.current.nav(stateRef.current.toHref(run));
        },
      }),
    );
    return () => offs.forEach((off) => off());
  }, []);

  const running = runs.filter((r) => r.state === 'running' || r.state === 'starting').length;

  // Shortcut label for a run: only shown when modifier held, pane focused, run is active.
  const shortcutFor = (r: Run): string | undefined => {
    if (!modHeld || !isFocused) return undefined;
    const idx = activeRuns.indexOf(r);
    return idx >= 0 ? String(idx + 1) : undefined;
  };

  return (
    <div
      className={cn(
        'h-full flex flex-col min-h-0 border-t-2',
        isFocused ? 'border-accent' : 'border-transparent',
      )}
      onClick={focus}
    >
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Runs</h2>
        <span className="font-mono text-[12px] text-text-faint">{runs.length} · {running} running</span>
      </div>
      <RunsFilter value={filter} onChange={setFilter} view={view} counts={counts} />
      <div className="flex-1 min-h-0 overflow-auto">
        {result.mode === 'flat' ? (
          <>
            {result.active.length > 0 && (
              <div className="px-3 py-1 text-[11px] uppercase tracking-[0.08em] text-text-faint border-b border-border">
                Active · {result.active.length}
              </div>
            )}
            {result.active.map((r) => (
              <RunRow key={r.id} run={r} to={toHref(r)} shortcutLabel={shortcutFor(r)} />
            ))}
            {result.rest.length > 0 && (
              <div className="px-3 py-1 text-[11px] uppercase tracking-[0.08em] text-text-faint border-b border-border">
                Finished · {result.rest.length}
              </div>
            )}
            {result.rest.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
          </>
        ) : (
          result.groups.map((g) => (
            <div key={g.state}>
              <div
                data-testid="runs-group-label"
                className={`px-3 py-1 text-[11px] uppercase tracking-[0.08em] border-b border-border bg-surface ${TONE_TEXT[g.state]}`}
              >
                {g.state} · {g.runs.length}
              </div>
              {g.runs.map((r) => (
                <RunRow key={r.id} run={r} to={toHref(r)} shortcutLabel={shortcutFor(r)} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
