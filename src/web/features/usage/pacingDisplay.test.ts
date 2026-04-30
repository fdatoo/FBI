import { describe, it, expect } from 'vitest';
import { pacingDisplay } from './pacingDisplay.js';

describe('pacingDisplay', () => {
  it('returns null when zone is none', () => {
    expect(pacingDisplay({ zone: 'none', delta: 0 })).toBeNull();
  });

  it('maps far-negative delta to cold', () => {
    const d = pacingDisplay({ zone: 'chill', delta: -0.3 });
    expect(d?.label).toBe('cold');
    expect(d?.tone).toBe('ok');
    expect(d?.deltaPct).toBe('-30%');
  });

  it('maps mild-negative delta to cool', () => {
    const d = pacingDisplay({ zone: 'chill', delta: -0.12 });
    expect(d?.label).toBe('cool');
    expect(d?.tone).toBe('ok');
    expect(d?.deltaPct).toBe('-12%');
  });

  it('maps near-zero delta to on track with signed percentage', () => {
    const a = pacingDisplay({ zone: 'on_track', delta: 0.03 });
    expect(a?.label).toBe('on track');
    expect(a?.tone).toBe('dim');
    expect(a?.deltaPct).toBe('+3%');
    const b = pacingDisplay({ zone: 'on_track', delta: -0.02 });
    expect(b?.label).toBe('on track');
    expect(b?.deltaPct).toBe('-2%');
  });

  it('maps mild-positive delta to warm', () => {
    const d = pacingDisplay({ zone: 'hot', delta: 0.15 });
    expect(d?.label).toBe('warm');
    expect(d?.tone).toBe('warn');
    expect(d?.deltaPct).toBe('+15%');
  });

  it('maps far-positive delta to hot', () => {
    const d = pacingDisplay({ zone: 'hot', delta: 0.35 });
    expect(d?.label).toBe('hot');
    expect(d?.tone).toBe('fail');
    expect(d?.deltaPct).toBe('+35%');
  });

  it('boundary at -5% goes to on track (exclusive on cool side)', () => {
    const d = pacingDisplay({ zone: 'on_track', delta: -0.05 });
    expect(d?.label).toBe('cool');
  });

  it('boundary at +10% goes to warm (exclusive on on-track side)', () => {
    const d = pacingDisplay({ zone: 'hot', delta: 0.10 });
    expect(d?.label).toBe('warm');
  });
});
