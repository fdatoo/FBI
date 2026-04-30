import type { PacingVerdict } from '@shared/types.js';

export type PacingTone = 'ok' | 'dim' | 'warn' | 'fail';

export interface PacingDisplay {
  /** User-visible label, e.g. "cool", "on track", "hot". */
  label: string;
  /** Signed percentage string, e.g. "+12%", "-3%". */
  deltaPct: string;
  /** Tone used to color the label and delta. */
  tone: PacingTone;
}

/**
 * Derives a 5-level display bucket (cold/cool/on track/warm/hot) from the
 * continuous pacing delta. The server only emits 3 coarse zones; the extra
 * cutoffs here are presentation-only.
 */
export function pacingDisplay(p: PacingVerdict): PacingDisplay | null {
  if (p.zone === 'none') return null;
  const d = p.delta;
  const deltaPct = `${d >= 0 ? '+' : ''}${Math.round(d * 100)}%`;
  if (d <= -0.20) return { label: 'cold', deltaPct, tone: 'ok' };
  if (d <= -0.05) return { label: 'cool', deltaPct, tone: 'ok' };
  if (d < 0.10)   return { label: 'on track', deltaPct, tone: 'dim' };
  if (d < 0.25)   return { label: 'warm', deltaPct, tone: 'warn' };
  return { label: 'hot', deltaPct, tone: 'fail' };
}

export const PACING_TONE_CLASS: Record<PacingTone, string> = {
  ok: 'text-ok',
  dim: 'text-text-dim',
  warn: 'text-warn',
  fail: 'text-fail',
};
