/**
 * Validates that a forced page reload (destroying and recreating the terminal
 * controller + WebSocket connection) produces a snapshot-faithful replica of
 * the live terminal state for the alt-screen-cycle scenario.
 *
 * The alt-screen-cycle scenario exercises repeated switches between the
 * primary and alternate screen buffers (e.g. as vim/less would trigger).
 * A correct Rust NIF snapshot must capture which buffer is active and its
 * full content, so the rebuilt terminal matches the pre-reload view exactly.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('alt-screen-cycle: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'alt-screen-cycle' });
  try {
    // Wait for the run to fully terminate so the byte stream stops growing —
    // otherwise late bytes between the live and rebuilt captures make the
    // equality check non-deterministic.
    await run.waitForFinalState();
    // 500ms settle so trailing BroadcastChunk messages (which can land after
    // StateChanged under parallel load) finish draining to the xterm before
    // we start polling. Wait for the terminal to finish rendering the
    // transcript history. loadBoundedHistory is async; waitForTerminalText polls.
    await page.waitForTimeout(500);
    await run.waitForTerminalText('main screen line 1', { timeoutMs: 15_000 });
    // Compare from the first scenario-emitted line. We skip the orchestrator
    // preamble (image-build / git-clone chrome) because its CR-overwrite
    // progress noise isn't reproduced byte-identically by the snapshot
    // serializer — a separate, narrower fidelity issue from what this test
    // is actually validating (alt-screen buffer state restoration).
    const marker = 'main screen line 1';
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
