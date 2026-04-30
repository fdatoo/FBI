import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useBottomPaneHeight, MIN_HEIGHT, clampHeight } from './useBottomPaneHeight.js';

describe('useBottomPaneHeight', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to a positive height based on viewport', () => {
    const { result } = renderHook(() => useBottomPaneHeight());
    expect(result.current.height).toBeGreaterThan(0);
  });

  it('persists set value to localStorage', () => {
    const { result } = renderHook(() => useBottomPaneHeight());
    act(() => result.current.setHeight(300));
    expect(localStorage.getItem('fbi.bottomPaneHeight')).toBe('300');
    expect(result.current.height).toBe(300);
  });

  it('clamps too-small values up to MIN_HEIGHT', () => {
    expect(clampHeight(50, 1000)).toBe(MIN_HEIGHT);
  });

  it('clamps too-large values down to viewport - 200', () => {
    expect(clampHeight(10_000, 1000)).toBe(800);
  });

  it('reads persisted value on mount', () => {
    localStorage.setItem('fbi.bottomPaneHeight', '256');
    const { result } = renderHook(() => useBottomPaneHeight());
    expect(result.current.height).toBe(256);
  });
});
