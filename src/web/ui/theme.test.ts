import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getStoredTheme, setStoredTheme, applyTheme, toggleTheme, subscribeSystemTheme } from './theme.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('light');
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: q === '(prefers-color-scheme: light)' ? false : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe('theme', () => {
  it('getStoredTheme returns null when nothing saved', () => {
    expect(getStoredTheme()).toBeNull();
  });

  it('setStoredTheme + getStoredTheme round-trip', () => {
    setStoredTheme('light');
    expect(getStoredTheme()).toBe('light');
    setStoredTheme('dark');
    expect(getStoredTheme()).toBe('dark');
  });

  it('applyTheme dark removes .light', () => {
    document.documentElement.classList.add('light');
    applyTheme('dark');
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('applyTheme light adds .light', () => {
    applyTheme('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('toggleTheme flips dark→light and persists', () => {
    applyTheme('dark');
    const next = toggleTheme();
    expect(next).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(getStoredTheme()).toBe('light');
  });

  it('subscribeSystemTheme calls handler on change only when user has no stored preference', () => {
    const listeners: Array<(e: MediaQueryListEvent) => void> = [];
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      matches: false,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    });
    const handler = vi.fn();
    subscribeSystemTheme(handler);
    listeners[0]({ matches: true } as MediaQueryListEvent);
    expect(handler).toHaveBeenCalledWith('light');
  });
});
