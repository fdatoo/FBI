import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('crash-fast exits 1 and marks run failed', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'crash-fast' });
  try {
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/failed|errored/i, { timeout: 30_000 });
    // run-exit-code only renders inside the meta tab (see MetaTab.tsx).
    // The drawer defaults to the changes tab, so click meta first.
    await page.getByRole('tab', { name: 'meta' }).click();
    await expect(page.getByTestId('run-exit-code')).toContainText('1');
  } finally {
    await run.destroy();
  }
});

test('hang ignores SIGTERM but is killed when stop is requested', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'hang' });
  try {
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/running/i, { timeout: 15_000 });
    const stopRes = await page.request.post(`/api/runs/${run.id}/stop`);
    expect(stopRes.ok()).toBe(true);
    // FBI.Orchestrator.cancel marks state="cancelled" and SIGTERM-then-
    // SIGKILLs the container after a 10s grace period (hang ignores
    // SIGTERM, so SIGKILL is the one that wins).
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/cancelled|stopped|failed|errored/i, { timeout: 30_000 });
  } finally {
    await run.destroy();
  }
});
