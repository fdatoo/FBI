import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('ansi: tool-heavy scenario produces styled output', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'tool-heavy' });
  try {
    // Verify the scenario output reaches the terminal. The tool-heavy scenario
    // emits ANSI-styled lines; xterm.js processes the escape codes and renders
    // via its canvas/WebGL renderer (no DOM class spans in that mode, but the
    // text is still decoded and displayed correctly).
    await run.waitForTerminalText('Read(src/index.ts)', { timeoutMs: 30_000 });
    await run.waitForTerminalText('Bash(', { timeoutMs: 5_000 });
  } finally {
    await run.destroy();
  }
});
