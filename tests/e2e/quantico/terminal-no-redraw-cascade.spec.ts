import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

// Regression for the snapshot ↔ resize cascade discovered via
// fbi-terminal-trace 2026-04-27T07-47-14: every server-pushed snapshot
// scheduled a `requestRedraw` 800 ms later, which sent two PTY resizes,
// each of which provoked another snapshot, etc. — 41 redraws / 48
// snapshots / 16 hellos / 7 paused-snapshot drops in 6 seconds, with
// the controller stuck paused at the end of the trace.
//
// The controller now arms its cursor-redraw nudge only on `onOpen`
// (initial mount + reconnect) and disarms it after the first snapshot
// per arm; ws.ts dedupes duplicate-dim resizes. Both gates are needed
// because either alone would leave a smaller version of the cascade.
//
// We tap the in-app debug trace ring (window.__fbiTerminalTrace) rather
// than intercept WebSocket frames at the Playwright level — same data
// the human-readable trace JSON is built from, no protocol coupling.

interface TraceEvent { t: number; kind: string; data: Record<string, unknown> }
declare global {
  interface Window {
    __fbiTerminalTrace?: {
      setTracing(on: boolean): void;
      getEvents(): readonly TraceEvent[];
      clearTrace(): void;
    };
  }
}

test('controller does not enter the snapshot↔resize cascade in steady state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'chatty' });
  try {
    await run.waitForTerminalText('thinking', { timeoutMs: 15_000 });

    // Start tracing AFTER the initial mount/seed/onOpen handshake has
    // settled, so we measure steady-state behavior — not the legitimate
    // single nudge the controller fires on attach. clearTrace resets
    // the ring so the post-attach hello/snapshot/redraw triple from
    // mount don't leak into our window.
    await page.evaluate(() => {
      const t = window.__fbiTerminalTrace!;
      t.setTracing(true);
      t.clearTrace();
    });

    // Long enough that a runaway 800 ms-cadence cascade would emit ~5
    // redraws and ~10 resizes within the window — well past any noise
    // tolerance. The chatty scenario keeps the byte stream busy so the
    // server has every opportunity to push extra snapshots.
    await page.waitForTimeout(5_000);

    const counts = await page.evaluate(() => {
      const events = window.__fbiTerminalTrace!.getEvents();
      const tally: Record<string, number> = {};
      for (const e of events) tally[e.kind] = (tally[e.kind] ?? 0) + 1;
      return tally;
    });

    // No new hellos in steady state — the only legitimate hellos are
    // mount and reconnect; neither happens during a 5-second idle window.
    expect(counts['ws.out.hello'] ?? 0).toBe(0);

    // No new redraws — `requestRedraw` only fires on visibility return
    // and on resume(), neither of which happens in this test.
    expect(counts['controller.redraw'] ?? 0).toBe(0);

    // Outbound resizes should be zero in steady state. The xterm host
    // dims are stable across the 5 s window (no DOM resize), and the
    // ws.ts dedupe drops any duplicates.
    expect(counts['ws.out.resize'] ?? 0).toBeLessThanOrEqual(1);

    // pause/resume must balance — a cascade exhausting backpressure
    // budget would leave the controller stuck paused with no resume.
    const pauses = counts['controller.pause'] ?? 0;
    const resumes = counts['controller.resume'] ?? 0;
    expect(resumes).toBeGreaterThanOrEqual(pauses);
  } finally {
    await run.destroy();
  }
});

test('typing does not trigger pause via the post-snapshot scroll event', async ({ page }) => {
  // Regression for: a snapshot whose content overflows the xterm's row
  // count (e.g. the rows+1 perturbation from requestRedraw) used to land
  // baseY > viewportY, making detectScroll report atBottom=false on the
  // next DOM scroll event. That fired controller.pause() — at which
  // point xterm.onData was detached and the user's keystrokes vanished.
  // The fix pins term.scrollToBottom() after every snapshot replay so
  // viewportY ≥ baseY, atBottom=true, no spurious pause.
  const run = await createMockRun(page, { scenario: 'chatty' });
  try {
    await run.waitForTerminalText('thinking', { timeoutMs: 15_000 });

    await page.evaluate(() => {
      const t = window.__fbiTerminalTrace!;
      t.setTracing(true);
      t.clearTrace();
    });

    // Focus the xterm and type a short word with realistic per-key
    // delays. The chatty scenario keeps producing bytes so the server
    // is highly likely to push at least one redraw-cycle snapshot
    // during the typing window.
    await page.locator('[data-testid="xterm"]').click();
    for (const ch of 'hello') {
      await page.keyboard.type(ch);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(2_000);

    const counts = await page.evaluate(() => {
      const events = window.__fbiTerminalTrace!.getEvents();
      const tally: Record<string, number> = {};
      for (const e of events) tally[e.kind] = (tally[e.kind] ?? 0) + 1;
      return tally;
    });

    // Every keystroke MUST reach the server. controller.input fires
    // synchronously from xterm.onData — if the controller paused
    // mid-typing, the input handler would have been detached and the
    // remaining keys would silently disappear.
    expect(counts['controller.input'] ?? 0).toBeGreaterThanOrEqual(5);

    // pause must not fire as a side effect of typing. The user is at
    // the bottom of the buffer the whole time; only an explicit scroll-
    // up should pause. Without the scrollToBottom fix this fires once
    // per snapshot whose dims exceed the term's.
    expect(counts['controller.pause'] ?? 0).toBe(0);

    // No chunk fetches either — those are downstream of pause + nearTop.
    expect(counts['controller.chunk.fetch'] ?? 0).toBe(0);
  } finally {
    await run.destroy();
  }
});
