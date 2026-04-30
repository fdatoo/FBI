import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Run } from '@shared/types.js';

// Mock notifications dispatch so we can count calls.
vi.mock('../lib/notifications.js', () => ({
  notifyComplete: vi.fn(),
  notifyWaiting: vi.fn(),
  clearWaitingBadge: vi.fn(),
  installFocusReset: vi.fn(() => () => {}),
}));

// Mock api — listRuns returns seed snapshot; getProject returns a stub.
const listRunsMock = vi.fn<() => Promise<Run[]>>();
vi.mock('../lib/api.js', () => ({
  api: {
    listRuns: (...args: unknown[]) => listRunsMock(...args as []),
    getProject: vi.fn(async (id: number) => ({
      id, name: `proj-${id}`, repo_url: 'x', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
      marketplaces: [], plugins: [], mem_mb: null, cpus: null, pids_limit: null,
      created_at: 0, updated_at: 0,
    })),
  },
  wsBase: vi.fn(() => 'ws://localhost'),
}));

// Fake WebSocket to capture the instance and drive messages.
class FakeSocket {
  static last: FakeSocket | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  constructor(_url: string) { FakeSocket.last = this; }
  close() { this.readyState = 3; this.onclose?.(); }
  fire(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const mkRun = (patch: Partial<Run> = {}): Run => ({
  id: 1, project_id: 1, prompt: '', branch_name: '', state: 'running',
  container_id: null, log_path: '', exit_code: null, error: null,
  head_commit: null, started_at: 0, finished_at: null, created_at: 0,
  state_entered_at: 0,
  resume_attempts: 0, next_resume_at: null, claude_session_id: null,
  last_limit_reset_at: null, tokens_input: 0, tokens_output: 0,
  tokens_cache_read: 0, tokens_cache_create: 0, tokens_total: 0,
  usage_parse_errors: 0, title: null, title_locked: 0, parent_run_id: null,
  kind: 'work' as const, kind_args_json: null,
  base_branch: null, mirror_status: null, ...patch,
  model: null, effort: null, subagent_model: null,
  mock: 0, mock_scenario: null, ...patch,
});

describe('useRunWatcher (WS-driven)', () => {
  let origWS: typeof globalThis.WebSocket;

  beforeEach(() => {
    origWS = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket;
    FakeSocket.last = null;
    listRunsMock.mockReset();
  });
  afterEach(() => {
    (globalThis as unknown as { WebSocket: typeof globalThis.WebSocket }).WebSocket = origWS;
    vi.clearAllMocks();
  });

  async function setupHook(enabled: boolean, initial: Run[]) {
    listRunsMock.mockResolvedValue(initial);
    const { useRunWatcher } = await import('./useRunWatcher.js');
    renderHook(() => useRunWatcher(enabled));
    // Wait for seed + WS-open sequence.
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    await waitFor(() => expect(listRunsMock).toHaveBeenCalled());
  }

  it('seeds without firing notifications', async () => {
    const { notifyWaiting, notifyComplete } =
      (await vi.importMock('../lib/notifications.js')) as {
        notifyWaiting: ReturnType<typeof vi.fn>;
        notifyComplete: ReturnType<typeof vi.fn>;
      };
    await setupHook(true, [mkRun({ state: 'running' }), mkRun({ id: 2, state: 'succeeded' })]);
    // Seed done; WS open but no frames yet; notifications should be untouched.
    expect(notifyWaiting).not.toHaveBeenCalled();
    expect(notifyComplete).not.toHaveBeenCalled();
  });

  it('running → waiting triggers notifyWaiting', async () => {
    const { notifyWaiting } = (await vi.importMock('../lib/notifications.js')) as {
      notifyWaiting: ReturnType<typeof vi.fn>;
    };
    await setupHook(true, [mkRun({ id: 1, state: 'running' })]);
    FakeSocket.last!.fire({
      type: 'state', run_id: 1, project_id: 1, state: 'waiting',
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });
    await waitFor(() => expect(notifyWaiting).toHaveBeenCalledTimes(1));
    expect(notifyWaiting).toHaveBeenCalledWith({ id: 1, project_name: 'proj-1' });
  });

  it('waiting → running triggers clearWaitingBadge, not notifyWaiting', async () => {
    const { notifyWaiting, clearWaitingBadge } =
      (await vi.importMock('../lib/notifications.js')) as {
        notifyWaiting: ReturnType<typeof vi.fn>;
        clearWaitingBadge: ReturnType<typeof vi.fn>;
      };
    await setupHook(true, [mkRun({ id: 1, state: 'waiting' })]);
    FakeSocket.last!.fire({
      type: 'state', run_id: 1, project_id: 1, state: 'running',
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });
    await waitFor(() => expect(clearWaitingBadge).toHaveBeenCalledWith(1));
    expect(notifyWaiting).not.toHaveBeenCalled();
  });

  it('terminal transitions trigger notifyComplete', async () => {
    const { notifyComplete } =
      (await vi.importMock('../lib/notifications.js')) as {
        notifyComplete: ReturnType<typeof vi.fn>;
      };
    await setupHook(true, [mkRun({ id: 5, state: 'running' })]);
    FakeSocket.last!.fire({
      type: 'state', run_id: 5, project_id: 1, state: 'succeeded',
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });
    await waitFor(() => expect(notifyComplete).toHaveBeenCalledTimes(1));
    expect(notifyComplete).toHaveBeenCalledWith(expect.objectContaining({
      id: 5, state: 'succeeded', project_name: 'proj-1',
    }));
  });

  it('disabled: transitions do NOT notify but counts still publish', async () => {
    const { notifyWaiting, notifyComplete } =
      (await vi.importMock('../lib/notifications.js')) as {
        notifyWaiting: ReturnType<typeof vi.fn>;
        notifyComplete: ReturnType<typeof vi.fn>;
      };
    await setupHook(false, [mkRun({ id: 1, state: 'running' })]);
    FakeSocket.last!.fire({
      type: 'state', run_id: 1, project_id: 1, state: 'waiting',
      next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
    });
    // Give microtasks a chance to run.
    await new Promise((r) => setTimeout(r, 5));
    expect(notifyWaiting).not.toHaveBeenCalled();
    expect(notifyComplete).not.toHaveBeenCalled();
  });
});
