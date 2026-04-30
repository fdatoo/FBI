import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('garbled: malformed UTF-8 + escape sequences do not crash the renderer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const run = await createMockRun(page, { scenario: 'garbled' });
  try {
    await page.waitForTimeout(5_000);
    await expect(page.getByTestId('xterm')).toBeVisible();
    await expect(page.getByTestId('terminal-disconnected-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await run.destroy();
  }
});
