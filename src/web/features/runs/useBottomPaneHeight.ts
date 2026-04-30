import { useCallback, useEffect, useState } from 'react';

export const MIN_HEIGHT = 120;
const KEY = 'fbi.bottomPaneHeight';

export function clampHeight(value: number, viewportHeight: number): number {
  const max = Math.max(MIN_HEIGHT + 40, viewportHeight - 200);
  return Math.max(MIN_HEIGHT, Math.min(value, max));
}

function readInitial(): number {
  if (typeof window === 'undefined') return 280;
  const raw = window.localStorage.getItem(KEY);
  if (raw == null) return Math.round(window.innerHeight * 0.35);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return Math.round(window.innerHeight * 0.35);
  return clampHeight(parsed, window.innerHeight);
}

export interface BottomPaneHeight {
  height: number;
  setHeight: (next: number) => void;
}

export function useBottomPaneHeight(): BottomPaneHeight {
  const [height, setHeightState] = useState<number>(() => readInitial());

  const setHeight = useCallback((next: number) => {
    const viewport = typeof window !== 'undefined' ? window.innerHeight : 1000;
    const clamped = clampHeight(next, viewport);
    setHeightState(clamped);
    try { window.localStorage.setItem(KEY, String(clamped)); } catch { /* quota; ignore */ }
  }, []);

  useEffect(() => {
    const onResize = (): void => setHeightState((h) => clampHeight(h, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { height, setHeight };
}
