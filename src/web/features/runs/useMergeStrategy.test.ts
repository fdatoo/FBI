import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useMergeStrategy } from './useMergeStrategy.js';

describe('useMergeStrategy', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to projectDefault when localStorage empty', () => {
    const { result } = renderHook(() => useMergeStrategy('rebase'));
    expect(result.current.strategy).toBe('rebase');
  });

  it('reads persisted value and ignores projectDefault', () => {
    localStorage.setItem('fbi.mergeStrategy', 'squash');
    const { result } = renderHook(() => useMergeStrategy('merge'));
    expect(result.current.strategy).toBe('squash');
  });

  it('setStrategy updates and persists', () => {
    const { result } = renderHook(() => useMergeStrategy('squash'));
    act(() => result.current.setStrategy('rebase'));
    expect(result.current.strategy).toBe('rebase');
    expect(localStorage.getItem('fbi.mergeStrategy')).toBe('rebase');
  });

  it('ignores invalid persisted value and falls back', () => {
    localStorage.setItem('fbi.mergeStrategy', 'bogus');
    const { result } = renderHook(() => useMergeStrategy('squash'));
    expect(result.current.strategy).toBe('squash');
  });
});
