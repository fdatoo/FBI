/**
 * Validates snapshot-reload equality for the bracketed-paste-cycle scenario.
 *
 * bracketed-paste-cycle toggles the bracketed-paste mode flag (?2004h/l)
 * repeatedly. The NIF snapshot must capture the current state of this mode so
 * that a reload restores the terminal to the correct paste-mode state and the
 * rendered output matches the live terminal.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('bracketed-paste-cycle: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'bracketed-paste-cycle' });
  try {
    await run.waitForFinalState();
    await page.waitForTimeout(500);
    const marker = 'bracketed paste enabled';
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
