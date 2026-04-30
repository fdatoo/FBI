import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { UsageNotifier } from './UsageNotifier.js';
import { usageStore } from './usageStore.js';
import { api } from '../../lib/api.js';
import type { Settings } from '@shared/types.js';

function stubSettings(partial: Partial<Settings>) {
  const defaults: Settings = {
    global_prompt: '', notifications_enabled: true, concurrency_warn_at: 3,
    image_gc_enabled: false, last_gc_at: null, last_gc_count: null, last_gc_bytes: null,
    global_marketplaces: [], global_plugins: [],
    auto_resume_enabled: false, auto_resume_max_attempts: 0,
    usage_notifications_enabled: false,
    updated_at: 0,
  };
  vi.spyOn(api, 'getSettings').mockResolvedValue({ ...defaults, ...partial });
}

function emitThreshold() {
  const subs = (usageStore as unknown as { threshSubs: Set<(m: unknown) => void> }).threshSubs;
  for (const cb of subs) cb({ type: 'threshold_crossed', bucket_id: 'five_hour', threshold: 90, reset_at: null });
}

describe('UsageNotifier', () => {
  beforeEach(() => { usageStore._resetForTest(); vi.restoreAllMocks(); });

  it('does not notify when usage_notifications_enabled is false', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'granted' }));
    stubSettings({ notifications_enabled: true, usage_notifications_enabled: false });
    render(<UsageNotifier />);
    await Promise.resolve();
    await Promise.resolve();
    emitThreshold();
    expect(ctor).not.toHaveBeenCalled();
  });

  it('notifies when both flags and permission are true', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'granted' }));
    stubSettings({ notifications_enabled: true, usage_notifications_enabled: true });
    render(<UsageNotifier />);
    await Promise.resolve();
    await Promise.resolve();
    emitThreshold();
    expect(ctor).toHaveBeenCalled();
  });

  it('does not notify when permission is not granted', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('Notification', Object.assign(ctor, { permission: 'denied' }));
    stubSettings({ notifications_enabled: true, usage_notifications_enabled: true });
    render(<UsageNotifier />);
    await Promise.resolve();
    await Promise.resolve();
    emitThreshold();
    expect(ctor).not.toHaveBeenCalled();
  });
});
