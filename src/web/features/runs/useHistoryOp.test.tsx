import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { useHistoryOp } from './useHistoryOp.js';
import * as apiModule from '../../lib/api.js';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe('useHistoryOp', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sets msgIsError=false and msg on complete result', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'complete', sha: 'abc1234' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Done (abc1234)');
    expect(result.current.msgIsError).toBe(false);
  });

  it('sets msgIsError=true and msg on git-unavailable without message', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'git-unavailable' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Git operation unavailable');
    expect(result.current.msgIsError).toBe(true);
  });

  it('sets msgIsError=true and includes message on git-unavailable with message', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'git-unavailable', message: 'Docker daemon not running' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Git unavailable: Docker daemon not running');
    expect(result.current.msgIsError).toBe(true);
  });

  it('sets msgIsError=true on git-error result', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'git-error', message: 'not a git repo' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Git: not a git repo');
    expect(result.current.msgIsError).toBe(true);
  });

  it('sets msgIsError=true on invalid result', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'invalid', message: 'op required' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Invalid: op required');
    expect(result.current.msgIsError).toBe(true);
  });
});
