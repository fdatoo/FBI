import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUsage, __resetUsageStoreForTest } from './useUsage.js';
import type { UsageState } from '@shared/types.js';

const snapshot: UsageState = {
  plan: 'max', observed_at: 1, last_error: null, last_error_at: null,
  buckets: [{ id: 'five_hour', utilization: 0.5, reset_at: 100, window_started_at: 0 }],
  pacing: { five_hour: { delta: 0, zone: 'on_track' } },
};

// Mock api to provide getUsage and wsBase
vi.mock('../../lib/api.js', () => ({
  api: {
    getUsage: vi.fn(async () => snapshot),
  },
  wsBase: vi.fn(() => 'ws://localhost'),
}));

describe('useUsage', () => {
  beforeEach(() => { __resetUsageStoreForTest(); vi.restoreAllMocks(); });

  it('resolves to initial REST snapshot before WS opens', async () => {
    class FakeWS {
      addEventListener() {}
      removeEventListener() {}
      close() {}
      send() {}
      readyState = 0;
    }
    vi.stubGlobal('WebSocket', FakeWS);
    const { result } = renderHook(() => useUsage());
    await waitFor(() => expect(result.current?.plan).toBe('max'));
  });

  it('updates when a snapshot frame arrives', async () => {
    const handlers: Record<string, (e: MessageEvent) => void> = {};
    class FakeWS {
      readyState = 1;
      addEventListener(type: string, cb: (e: MessageEvent) => void) { handlers[type] = cb; }
      removeEventListener() {}
      close() {}
      send() {}
    }
    vi.stubGlobal('WebSocket', FakeWS);
    const { result } = renderHook(() => useUsage());
    await waitFor(() => expect(result.current?.plan).toBe('max'));
    act(() => handlers.message?.(new MessageEvent('message', {
      data: JSON.stringify({ type: 'snapshot', state: { ...snapshot, plan: 'pro' } }),
    })));
    await waitFor(() => expect(result.current?.plan).toBe('pro'));
  });
});
