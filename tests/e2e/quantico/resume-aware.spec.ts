import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('continue-run path: second run sees prior session and emits resume marker', async ({ page }) => {
  // Use the resume-aware scenario (which write_jsonl's a session JSONL) so
  // the continue path has a session_id to resume from. The default scenario
  // emits no JSONL and would fall through to the fresh-prompt branch in
  // supervisor.sh, never invoking quantico's --resume code.
  const first = await createMockRun(page, { scenario: 'resume-aware' });
  // Wait for the run to fully complete: claude_session_id is only set by
  // mark_finished after the container exits and result.json is read.
  // Without this, do_continue returns 422 (no session id) and Continue is
  // a no-op. The Continue button is also disabled until claude_session_id
  // is captured.
  await first.waitForFinalState({ timeoutMs: 30_000 });
  await first.waitForTerminalText('Done.', { timeoutMs: 5_000 });

  // Open the Continue dialog (the run-header button text is just "Continue",
  // not "Continue run") and click the dialog's primary button to actually
  // submit. Both buttons say "Continue" — disambiguate by scoping the
  // dialog click to the dialog testid container.
  await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await page.getByTestId('continue-dialog')
    .getByRole('button', { name: 'Continue', exact: true })
    .click();

  // do_continue creates a new (child) run and returns its JSON; the UI
  // navigates to the new run's URL. Wait for the URL to change to a
  // different run id, then assert the new run's terminal contains the
  // resume marker that quantico's --resume code prints before the
  // resume-aware scenario runs again.
  await page.waitForURL(
    (url) => /\/projects\/\d+\/runs\/(\d+)$/.test(url.pathname)
      && Number(url.pathname.match(/runs\/(\d+)/)![1]) !== first.id,
    { timeout: 30_000 },
  );

  // xterm.js renders to a WebGL canvas — DOM textContent is empty, so
  // toContainText would always fail. Read text out of the xterm buffer
  // via __fbiTerminalText, which is what waitForTerminalText also uses.
  await page.waitForFunction(
    (n: string) => ((window as Window & { __fbiTerminalText?: () => string })
      .__fbiTerminalText?.() ?? '').includes(n),
    '[quantico] resumed from',
    { timeout: 60_000 },
  );

  // Capture the new run id from the URL so we can clean up both runs.
  const newRunId = Number(page.url().match(/runs\/(\d+)/)![1]);
  await page.request.delete(`/api/runs/${newRunId}`).catch(() => {});
  await page.request.delete(`/api/runs/${first.id}`).catch(() => {});
});
