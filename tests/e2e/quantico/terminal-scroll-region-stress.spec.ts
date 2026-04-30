/**
 * Validates snapshot-reload equality for the scroll-region-stress scenario.
 *
 * scroll-region-stress repeatedly sets and clears DECSTBM (top/bottom margin)
 * scroll regions and writes content inside them. The NIF snapshot must encode
 * the active scroll-region margins and the resulting grid content faithfully so
 * that a fresh controller rebuild from the snapshot matches the live terminal.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('scroll-region-stress: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'scroll-region-stress' });
  try {
    await run.waitForFinalState();
    // 500ms settle so trailing BroadcastChunk messages drain before polling.
    await page.waitForTimeout(500);
    const marker = 'status line 1';
    await run.waitForTerminalText(marker, { timeoutMs: 15_000 });
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
