import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UsagePage } from './UsagePage.js';
import * as useUsageMod from './useUsage.js';
import { api } from '../../lib/api.js';
import type { UsageState } from '@shared/types.js';

describe('UsagePage', () => {
  it('renders bucket cards, daily chart, and recent runs on happy path', async () => {
    const now = Date.now();
    const state: UsageState = {
      plan: 'max', observed_at: now, last_error: null, last_error_at: null,
      buckets: [
        { id: 'five_hour', utilization: 0.42, reset_at: now + 3_600_000, window_started_at: now - 3_600_000 },
        { id: 'weekly',    utilization: 0.18, reset_at: now + 86_400_000, window_started_at: now - 86_400_000 },
      ],
      pacing: {
        five_hour: { delta: 0, zone: 'on_track' },
        weekly:    { delta: -0.1, zone: 'chill' },
      },
    };
    vi.spyOn(useUsageMod, 'useUsage').mockReturnValue(state);
    vi.spyOn(api, 'listDailyUsage').mockResolvedValue([]);
    vi.spyOn(api, 'listRunsPaged').mockResolvedValue({ items: [], total: 0 });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(await screen.findByText(/42%/)).toBeInTheDocument();
    expect(screen.getByText(/5-hour window/i)).toBeInTheDocument();
    expect(screen.getByText(/plan:/i)).toBeInTheDocument();
  });

  it('renders error panel when last_error is set', () => {
    vi.spyOn(useUsageMod, 'useUsage').mockReturnValue({
      plan: null, observed_at: null, last_error: 'missing_credentials', last_error_at: 1,
      buckets: [], pacing: {},
    });
    vi.spyOn(api, 'listDailyUsage').mockResolvedValue([]);
    vi.spyOn(api, 'listRunsPaged').mockResolvedValue({ items: [], total: 0 });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);
    expect(screen.getByText(/sign in to claude/i)).toBeInTheDocument();
  });
});
