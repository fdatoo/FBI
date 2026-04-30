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
    // 500ms settle window for the last in-flight bytes to drain from the
    // broadcaster + WS to the xterm. waitForFinalState fires off the
    // StateChanged broadcast, but BroadcastChunk messages emitted by the
    // attach reader can land *after* that on the queue under heavy
    // parallel-test load — without this pause the next polling check can
    // race the trailing bytes. Polling on top still tolerates slower drains.
    await page.waitForTimeout(500);
    const marker = 'ASCII line';
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
