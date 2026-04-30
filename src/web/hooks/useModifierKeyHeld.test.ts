import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useModifierKeyHeld } from './useModifierKeyHeld.js';

function fireKeydown(opts: { metaKey?: boolean; ctrlKey?: boolean } = {}): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...opts })); });
}
function fireKeyup(): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); });
}

describe('useModifierKeyHeld', () => {
  it('returns false initially', () => {
    const { result } = renderHook(() => useModifierKeyHeld());
    expect(result.current).toBe(false);
  });

  it('returns true while metaKey is held', () => {
    const { result } = renderHook(() => useModifierKeyHeld());
    fireKeydown({ metaKey: true });
    expect(result.current).toBe(true);
    fireKeyup();
    expect(result.current).toBe(false);
  });

  it('returns true while ctrlKey is held', () => {
    const { result } = renderHook(() => useModifierKeyHeld());
    fireKeydown({ ctrlKey: true });
    expect(result.current).toBe(true);
    fireKeyup();
    expect(result.current).toBe(false);
  });

  it('resets on window blur', () => {
    const { result } = renderHook(() => useModifierKeyHeld());
    fireKeydown({ metaKey: true });
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(result.current).toBe(false);
  });
});
