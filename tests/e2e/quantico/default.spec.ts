import { test } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('default scenario: runs to completion with output', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'default' });
  try {
    await run.waitForTerminalText('thinking', { timeoutMs: 15_000 });
    await run.waitForTerminalText('Done.', { timeoutMs: 30_000 });
    await run.expectScrolledToBottom();
  } finally {
    await run.destroy();
  }
});
