import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('env-echo: orchestrator env reaches the agent', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'env-echo' });
  try {
    await run.waitForTerminalText('[quantico] env.RUN_ID=', { timeoutMs: 30_000 });
    const text = await run.terminalText();
    expect(text).toMatch(/env\.RUN_ID=\d+/);
    expect(text).toContain('env.GIT_AUTHOR_EMAIL=e2e@example.com');
    expect(text).toContain('env.MOCK_CLAUDE_SCENARIO=env-echo');
  } finally {
    await run.destroy();
  }
});
