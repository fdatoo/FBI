/**
 * Validates snapshot-reload equality for the cjk-wide scenario.
 *
 * cjk-wide writes double-width CJK characters (Chinese/Japanese/Korean) that
 * each occupy two terminal columns. The NIF snapshot must faithfully encode
 * wide-character cells and their "spacer" right halves so the rebuilt terminal
 * renders the same layout as the live terminal without column-shift corruption.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('cjk-wide: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'cjk-wide' });
  try {
    await run.waitForFinalState();
    await page.waitForTimeout(500);
    const marker = 'ASCII line';
    const liveText = await run.terminalTextFrom(marker);
    expect(liveText).not.toBe('');

    await page.reload();
    await page.waitForTimeout(2000);
    const rebuiltText = await run.terminalTextFrom(marker);

    expect(rebuiltText).toEqual(liveText);
  } finally {
    await run.destroy();
  }
});
