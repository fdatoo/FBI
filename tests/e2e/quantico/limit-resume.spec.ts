import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('limit-breach triggers waiting-state, then auto-resumes', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'limit-breach' });
  try {
    await run.waitForTerminalText('Claude usage limit reached', { timeoutMs: 30_000 });

    const stateBadge = page.getByTestId('run-state-badge');
    await expect(stateBadge).toContainText(/awaiting|waiting|paused/i, { timeout: 15_000 });

    // Snapshot the current resume_attempts so we can confirm the resume
    // actually kicked a fresh container, not just no-op'd.
    const beforeRes = await page.request.get(`/api/runs/${run.id}`);
    const beforeAttempts = (await beforeRes.json() as { resume_attempts: number }).resume_attempts;

    await page.request.post(`/api/runs/${run.id}/resume-now`);
    // supervisor.sh's resume branch touches /fbi-state/waiting (not
    // /fbi-state/prompted) — by design, since `claude --resume` continues a
    // prior session that may or may not have stdin pending. The runtime
    // state watcher reflects that as state="waiting", which then transitions
    // to "running" or back to "awaiting_resume" depending on what the
    // resumed claude does next. Accept any non-awaiting active state as
    // evidence the resume kicked off.
    await expect(stateBadge).toContainText(/running|waiting|starting/i, { timeout: 30_000 });

    // Confirm the resume actually attempted by checking resume_attempts went up.
    // The limit-breach scenario re-emits the breach, so the run cycles back to
    // awaiting_resume; the increment proves the auto-resume path ran end-to-end.
    await expect.poll(
      async () => {
        const r = await page.request.get(`/api/runs/${run.id}`);
        return (await r.json() as { resume_attempts: number }).resume_attempts;
      },
      { timeout: 30_000 },
    ).toBeGreaterThan(beforeAttempts);
  } finally {
    await run.destroy();
  }
});
