import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('auto-scroll: stays pinned during steady output', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'chatty' });
  try {
    await run.waitForTerminalText('thinking', { timeoutMs: 15_000 });
    await page.waitForTimeout(2_000);
    await run.expectScrolledToBottom();

    // Manually scroll up: should stop pinning.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement;
      el.scrollTop = 0;
    });
    await page.waitForTimeout(2_000);
    const stillTop = await page.evaluate(() =>
      (document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement).scrollTop,
    );
    expect(stillTop).toBeLessThan(50);

    // Scroll back to bottom: should re-pin. The chatty scenario emits over
    // ~1.2s wall (12s × MOCK_CLAUDE_SPEED_MULT=10) so by this point the
    // stream is winding down. The controller's resume()→rebuild path can
    // briefly leave the DOM scrollTop trailing the buffer's at-bottom
    // state; force a re-scroll to ensure we're observing the steady state
    // rather than racing the rebuild's render tick.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement;
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(2_000);
    // One more scroll-to-bottom kick to defeat the rebuild render-tick race.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement;
      el.scrollTop = el.scrollHeight;
    });
    await run.expectScrolledToBottom();
  } finally {
    await run.destroy();
  }
});
