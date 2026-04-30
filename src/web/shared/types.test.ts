import { describe, it, expectTypeOf } from 'vitest';
import type {
  UsageBucket, PacingVerdict, PacingZone, UsageError,
  UsageState, UsageWsMessage, Settings,
} from './types.js';

describe('shared usage types', () => {
  it('UsageBucket has expected shape', () => {
    expectTypeOf<UsageBucket>().toEqualTypeOf<{
      id: string;
      utilization: number;
      reset_at: number | null;
      window_started_at: number | null;
    }>();
  });

  it('PacingZone is a fixed string union', () => {
    expectTypeOf<PacingZone>().toEqualTypeOf<'chill' | 'on_track' | 'hot' | 'none'>();
  });

  it('UsageWsMessage is the discriminated union', () => {
    const snapshot: UsageWsMessage = { type: 'snapshot', state: {} as UsageState };
    const cross: UsageWsMessage = { type: 'threshold_crossed', bucket_id: 'five_hour', threshold: 90, reset_at: 1 };
    expectTypeOf(snapshot).toMatchTypeOf<UsageWsMessage>();
    expectTypeOf(cross).toMatchTypeOf<UsageWsMessage>();
  });

  it('Settings includes usage_notifications_enabled', () => {
    expectTypeOf<Settings>().toHaveProperty('usage_notifications_enabled').toEqualTypeOf<boolean>();
  });

  it('UsageError covers all kinds', () => {
    expectTypeOf<UsageError>().toEqualTypeOf<'missing_credentials' | 'expired' | 'rate_limited' | 'network' | null>();
  });

  it('PacingVerdict has expected shape', () => {
    expectTypeOf<PacingVerdict>().toEqualTypeOf<{ delta: number; zone: PacingZone }>();
  });
});
