import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunUsage } from './RunUsage.js';
import { api } from '../../lib/api.js';
import type { Run } from '@shared/types.js';

const baseRun: Run = {
  id: 1, project_id: 1, prompt: 'p', branch_name: 'b', state: 'succeeded',
  container_id: null, log_path: '/l', exit_code: 0, error: null, head_commit: null,
  started_at: 0, finished_at: 0, created_at: 0, state_entered_at: 0,
  resume_attempts: 0, next_resume_at: null, claude_session_id: null,
  last_limit_reset_at: null,
  tokens_input: 100, tokens_output: 200, tokens_cache_read: 5000, tokens_cache_create: 1000,
  tokens_total: 300, usage_parse_errors: 0,
  title: null, title_locked: 0, parent_run_id: null,
  kind: 'work' as const, kind_args_json: null,
  base_branch: null, mirror_status: null,
  model: null, effort: null, subagent_model: null,
  mock: 0, mock_scenario: null,
};

describe('RunUsage', () => {
  it('headline is billable (input + output); cached shown separately', async () => {
    vi.spyOn(api, 'getRunUsageBreakdown').mockResolvedValue([]);
    render(<RunUsage run={baseRun} />);
    const billable = await screen.findByText(/300/);
    expect(billable).toBeInTheDocument();
    expect(screen.getByText(/6\.0k/)).toBeInTheDocument(); // cached
  });

  it('returns null when both billable and cached are zero', () => {
    vi.spyOn(api, 'getRunUsageBreakdown').mockResolvedValue([]);
    const zero = { ...baseRun, tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0, tokens_total: 0 };
    const { container } = render(<RunUsage run={zero} />);
    expect(container.innerHTML).toBe('');
  });
});
