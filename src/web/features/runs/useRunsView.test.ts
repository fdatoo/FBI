import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRunsView, STORAGE_KEY, applyRunsView } from './useRunsView.js';
import type { Run, RunState } from '@shared/types.js';

function mkRun(id: number, state: RunState, createdAt: number): Run {
  return {
    id, project_id: 1, prompt: '', branch_name: '',
    state, container_id: null, log_path: '', exit_code: null,
    error: null, head_commit: null, started_at: null, finished_at: null,
    created_at: createdAt, state_entered_at: createdAt,
    resume_attempts: 0, next_resume_at: null,
    claude_session_id: null, last_limit_reset_at: null,
    tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0,
    tokens_total: 0, usage_parse_errors: 0,
    title: null, title_locked: 0, parent_run_id: null,
    kind: 'work' as const, kind_args_json: null,
    base_branch: null, mirror_status: null,
    model: null, effort: null, subagent_model: null,
    mock: 0, mock_scenario: null,
  };
}

describe('useRunsView', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to empty filter and grouping off', () => {
    const { result } = renderHook(() => useRunsView());
    expect(result.current.filter.size).toBe(0);
    expect(result.current.groupByState).toBe(false);
  });

  it('persists toggleState to localStorage (only on setter call)', () => {
    const { result } = renderHook(() => useRunsView());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    act(() => result.current.toggleState('running'));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.filter).toEqual(['running']);
  });

  it('rehydrates filter and groupByState', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filter: ['failed'], groupByState: true }));
    const { result } = renderHook(() => useRunsView());
    expect([...result.current.filter]).toEqual(['failed']);
    expect(result.current.groupByState).toBe(true);
  });

  it('drops unknown states on rehydrate', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filter: ['running', 'bogus'], groupByState: false }));
    const { result } = renderHook(() => useRunsView());
    expect([...result.current.filter]).toEqual(['running']);
  });

  it('falls back to defaults on invalid JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const { result } = renderHook(() => useRunsView());
    expect(result.current.filter.size).toBe(0);
    expect(result.current.groupByState).toBe(false);
  });

  it('clearFilter empties the set', () => {
    const { result } = renderHook(() => useRunsView());
    act(() => result.current.toggleState('running'));
    act(() => result.current.toggleState('waiting'));
    act(() => result.current.clearFilter());
    expect(result.current.filter.size).toBe(0);
  });
});

describe('applyRunsView', () => {
  const runs: Run[] = [
    mkRun(1, 'succeeded', 1000),
    mkRun(2, 'running',   2000),
    mkRun(3, 'failed',    3000),
    mkRun(4, 'waiting',   4000),
    mkRun(5, 'queued',    5000),
    mkRun(6, 'running',   6000),
  ];

  it('flat mode pins active states above rest, each sorted created_at DESC', () => {
    const out = applyRunsView(runs, { filter: new Set(), groupByState: false });
    expect(out.mode).toBe('flat');
    if (out.mode !== 'flat') return;
    expect(out.active.map((r) => r.id)).toEqual([6, 5, 4, 2]);
    expect(out.rest.map((r) => r.id)).toEqual([3, 1]);
  });

  it('grouped mode emits sections in fixed order with within-section created_at DESC', () => {
    const out = applyRunsView(runs, { filter: new Set(), groupByState: true });
    expect(out.mode).toBe('grouped');
    if (out.mode !== 'grouped') return;
    expect(out.groups.map((g) => g.state)).toEqual(['running', 'waiting', 'queued', 'succeeded', 'failed']);
    expect(out.groups.find((g) => g.state === 'running')!.runs.map((r) => r.id)).toEqual([6, 2]);
  });

  it('respects filter in flat mode', () => {
    const out = applyRunsView(runs, { filter: new Set<RunState>(['failed']), groupByState: false });
    expect(out.mode).toBe('flat');
    if (out.mode !== 'flat') return;
    expect(out.active).toEqual([]);
    expect(out.rest.map((r) => r.id)).toEqual([3]);
  });

  it('omits empty sections in grouped mode', () => {
    const out = applyRunsView([mkRun(1, 'running', 1), mkRun(2, 'failed', 2)], { filter: new Set(), groupByState: true });
    expect(out.mode).toBe('grouped');
    if (out.mode !== 'grouped') return;
    expect(out.groups.map((g) => g.state)).toEqual(['running', 'failed']);
  });

  it('sorts by state_entered_at, not created_at', () => {
    // Older run that was just restarted should appear above a newer run that has been running a while.
    const older = { ...mkRun(1, 'running', 1000), state_entered_at: 9000 };
    const newer = { ...mkRun(2, 'running', 5000), state_entered_at: 5000 };
    const out = applyRunsView([older, newer], { filter: new Set(), groupByState: false });
    expect(out.mode).toBe('flat');
    if (out.mode !== 'flat') return;
    expect(out.active.map((r) => r.id)).toEqual([1, 2]);
  });
});
