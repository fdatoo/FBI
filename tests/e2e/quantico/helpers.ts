import { expect, type Page } from '@playwright/test';

export type ScenarioName =
  | 'default' | 'chatty' | 'limit-breach' | 'limit-breach-human'
  | 'crash-fast' | 'hang' | 'garbled' | 'slow-startup'
  | 'env-echo' | 'resume-aware' | 'tool-heavy' | 'plugin-fail'
  // Terminal-correctness scenarios (Rust rewrite, 2026-04-26)
  | 'alt-screen-cycle' | 'scroll-region-stress' | 'mouse-modes-cycle'
  | 'cjk-wide' | 'truecolor' | 'bracketed-paste-cycle'
  | 'scrollback-stress' | 'cursor-styles';

export interface RunHandle {
  id: number;
  page: Page;
  waitForTerminalText(needle: string, opts?: { timeoutMs?: number }): Promise<void>;
  terminalText(): Promise<string>;
  /** Returns terminal text starting at the first occurrence of `marker`.
   * Use in snapshot-reload tests to scope the comparison to scenario-emitted
   * content (skipping orchestrator preamble whose CR-overwrites the
   * snapshot serializer doesn't byte-reproduce). */
  terminalTextFrom(marker: string): Promise<string>;
  expectScrolledToBottom(): Promise<void>;
  /** Block until the run reaches a terminal state (succeeded/failed/cancelled).
   * Snapshot-reload tests need the byte stream to have settled before they
   * can compare the live xterm to a post-reload one — otherwise stray late
   * bytes between the two captures make the equality check non-deterministic.
   */
  waitForFinalState(opts?: { timeoutMs?: number }): Promise<void>;
  destroy(): Promise<void>;
}

/** Creates a project (idempotent) then navigates to /projects/:id/runs/new and submits a mock run. */
export async function createMockRun(
  page: Page,
  opts: { scenario: ScenarioName; prompt?: string },
): Promise<RunHandle> {
  const projectId = await ensureProject(page);
  await page.goto(`/projects/${projectId}/runs/new`);

  await page.getByPlaceholder(/Describe what Claude should do/i)
    .fill(opts.prompt ?? `quantico ${opts.scenario}`);
  await page.getByTestId('mockmode-toggle').click();
  await page.getByTestId('mockmode-enable').check();
  await page.getByTestId('mockmode-scenario-select').selectOption(opts.scenario);

  await page.getByRole('button', { name: /Start run/i }).click();
  await page.waitForURL(/\/projects\/\d+\/runs\/\d+/);
  const url = page.url();
  const id = Number(url.match(/runs\/(\d+)/)![1]);
  return wrap(id, page);
}

async function ensureProject(page: Page): Promise<number> {
  const res = await page.request.get('/api/projects');
  const list = await res.json() as Array<{ id: number }>;
  if (list.length > 0) return list[0].id;
  const created = await page.request.post('/api/projects', {
    data: { name: 'e2e', repo_url: '/tmp/empty-repo.git', default_branch: 'main' },
  });
  return ((await created.json()) as { id: number }).id;
}

function wrap(id: number, page: Page): RunHandle {
  return {
    id, page,
    async waitForTerminalText(needle, opts) {
      await page.waitForFunction(
        (n: string) => ((window as any).__fbiTerminalText?.() ?? '').includes(n),
        needle,
        { timeout: opts?.timeoutMs ?? 30_000 },
      );
    },
    async terminalText() {
      return page.evaluate(() => (window as any).__fbiTerminalText?.() ?? '');
    },
    /** Returns the substring of the terminal text starting at the first
     * occurrence of `marker` — used by snapshot-reload tests to scope the
     * comparison to scenario-emitted content.
     *
     * Why: the orchestrator's image-build / container-start preamble uses
     * CR-overwrites that the snapshot serializer (alacritty grid → ANSI
     * replay) doesn't reproduce byte-identically. The snapshot DOES
     * reproduce the scenario's output faithfully — passing the scenario's
     * first emitted line as `marker` lets the test assert what it's
     * actually validating without the preamble noise.
     */
    async terminalTextFrom(marker: string) {
      const full = await page.evaluate(() => (window as any).__fbiTerminalText?.() ?? '');
      const idx = full.indexOf(marker);
      return idx === -1 ? '' : full.slice(idx);
    },
    async expectScrolledToBottom({ timeoutMs = 5_000 } = {}) {
      // Poll instead of one-shot: when chatty/steady-stream scenarios are
      // running, auto-scroll re-engages a few hundred ms after a manual
      // scroll-to-bottom (resume() does a rebuild round-trip via the WS).
      // A single check immediately after scrolling can race that.
      await expect.poll(
        () => page.evaluate(() => (window as any).__fbiIsAtBottom?.() ?? false),
        { timeout: timeoutMs },
      ).toBe(true);
    },
    async waitForFinalState({ timeoutMs = 30_000 } = {}) {
      await expect(page.getByTestId('run-state-badge'))
        .toContainText(/succeeded|failed|errored|cancelled/i, { timeout: timeoutMs });
    },
    async destroy() {
      await page.request.delete(`/api/runs/${id}`).catch(() => {});
    },
  };
}
