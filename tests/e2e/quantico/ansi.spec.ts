import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('ansi: tool-heavy scenario produces styled spans', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'tool-heavy' });
  try {
    await run.waitForTerminalText('Read', { timeoutMs: 30_000 });
    // xterm.js renders SGR foregrounds as `xterm-fg-N` / bold as `xterm-bold`.
    const styled = page.locator('[data-testid="xterm"] .xterm-fg-36, [data-testid="xterm"] .xterm-bold').first();
    await expect(styled).toBeVisible();
  } finally {
    await run.destroy();
  }
});
