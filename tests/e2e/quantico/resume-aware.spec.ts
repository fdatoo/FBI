import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('continue-run path: second run sees prior session and emits resume marker', async ({ page }) => {
  // Use the resume-aware scenario (which write_jsonl's a session JSONL) so
  // the continue path has a session_id to resume from. The default scenario
  // emits no JSONL and would fall through to the fresh-prompt branch in
  // supervisor.sh, never invoking quantico's --resume code.
  const first = await createMockRun(page, { scenario: 'resume-aware' });
  await first.waitForTerminalText('Done.', { timeoutMs: 30_000 });

  // Open the Continue dialog (the run-header button text is just "Continue",
  // not "Continue run") and click the dialog's primary button to actually
  // submit. Both buttons say "Continue" — disambiguate by scoping the
  // dialog click to the dialog testid container.
  await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
  await page.getByTestId('continue-dialog')
    .getByRole('button', { name: 'Continue', exact: true })
    .click();

  // The continue endpoint reuses the same run id (flips state to "starting"
  // and re-launches with FBI_RESUME_SESSION_ID set). Page stays at
  // /projects/X/runs/<first.id>; quantico's --resume code prints the
  // resume marker before the resume-aware scenario runs again.
  await expect(page.getByTestId('xterm'))
    .toContainText('[quantico] resumed from', { timeout: 60_000 });

  await page.request.delete(`/api/runs/${first.id}`).catch(() => {});
});
