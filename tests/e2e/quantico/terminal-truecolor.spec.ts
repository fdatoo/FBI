/**
 * Validates snapshot-reload equality for the truecolor scenario.
 *
 * truecolor writes 24-bit RGB color escape sequences (both foreground and
 * background). The NIF snapshot must store full RGB color attributes per cell
 * rather than approximating to the nearest 256-color palette entry, so that the
 * rebuilt terminal renders the same colors as the live view.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('truecolor: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'truecolor' });
  try {
    // Wait for the run to finish so the byte stream stops growing — without
    // this, late bytes between the live and rebuilt captures make the
    // equality check non-deterministic.
    await run.waitForFinalState();
    // 500ms settle so trailing BroadcastChunk messages drain before polling.
    await page.waitForTimeout(500);
    const marker = 'orange truecolor'; // first scenario-emitted line
    await run.waitForTerminalText(marker, { timeoutMs: 15_000 });
    const liveText = await run.terminalTextFrom(marker);
    expect(liveText).not.toBe(''); // sanity: scenario actually ran

    await page.reload();
    await page.waitForTimeout(2000);
    const rebuiltText = await run.terminalTextFrom(marker);

    expect(rebuiltText).toEqual(liveText);
  } finally {
    await run.destroy();
  }
});
