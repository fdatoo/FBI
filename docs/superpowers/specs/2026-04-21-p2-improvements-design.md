# FBI — Post-v1 P2 Improvements Design

**Date:** 2026-04-21
**Project:** FBI
**Status:** Draft — pending user review
**Backlog reference:** [`docs/feature-gaps.md`](../../feature-gaps.md)

## 1. Overview

Eleven improvements across six categories, shipped as six sequenced phases. Each phase leaves the app in a working state; none depends on a later phase.

### Scope

| # | Feature | Category | Phase |
|---|---------|----------|-------|
| 1 | `/runs` filters, search, pagination | C. Filtering & scale | 1 |
| 2 | `/projects` last-run state + timestamp | C. Filtering & scale | 1 |
| 3 | "What's running now" on home page | B. Visibility | 1 |
| 4 | Composed-prompt preview on NewRun | F. Prompt transparency | 2 |
| 5 | Effective plugins/marketplaces preview on NewRun | F. Prompt transparency | 2 |
| 6 | Concurrency soft-cap with confirm dialog | D. Safety & limits | 3 |
| 7 | Image GC (opt-in, nightly + on-demand) | D. Safety & limits | 3 |
| 8 | PR / CI / branch-status surfacing on RunDetail | B. Visibility | 4 |
| 9 | One-click "Create PR" on RunDetail | E. Completion | 4 |
| 10 | File-level diff summary on RunDetail | B. Visibility | 5 |
| 11 | Related runs (shared prompt) + compare link | A. Run iteration | 6 |

Item numbering in this spec is for ordering only; the backlog groups these as 11 P2 items across categories A–F.

### Non-goals in this spec

- **In-app diff viewer.** Diff summary links out to GitHub; no client-side diff rendering.
- **In-app side-by-side run comparison.** Compare surfaces via a GitHub `compare/` URL opened in a new tab.
- **GitHub PAT management or OAuth App flow.** All GitHub access shells to the host `gh` CLI (user runs `gh auth login` once out-of-band).
- **Hard concurrency cap.** Soft warning only — the operator always has the final say.
- **Image-GC retention knobs beyond an on/off switch and a single 30-day window.** More nuance is future work.
- **Per-project concurrency override, per-project GC policy.** Single install-wide setting each.
- **WebSocket push for home-page running-count updates.** Existing 5s poll style is fine.

---

## 2. Phase 1 — Scale & visibility (C1 + C2 + B1)

### 2.1 Goal

Make `/runs` useful past 50 rows; make `/projects` tell you last-run state at a glance; show a "runs in flight" chip on the home page.

### 2.2 `/runs` filters, search, pagination (C1)

**API:** extend the existing `GET /api/runs` handler:

- Query params:
  - `state` — already supported. No change.
  - `project_id` — integer. Filter to one project.
  - `q` — string. Case-insensitive `LIKE '%q%'` on `prompt`.
  - `limit` — integer, default 50, max 200.
  - `offset` — integer, default 0.
- Response body shape changes from `Run[]` to `{ items: Run[]; total: number }`.
- `RunsRepo` gains `listFiltered({ state?, project_id?, q?, limit, offset })` returning `{ items, total }`. `total` runs a parallel `COUNT(*)` with the same WHERE clause.

**UI:** `/runs` page adds:

- State dropdown (All / queued / running / succeeded / failed / cancelled).
- Project dropdown (All / each project).
- Search input, 250ms debounce.
- Pagination bar: "Page N of M  ← →" at the bottom. No page-size picker in v1.
- Filter state lives in URL query params (`?state=failed&project_id=3&q=fix&page=2`) so bookmarking/sharing works and refresh preserves state.

**Data note:** Existing `idx_runs_state` and `idx_runs_project` cover the common filters. No new indexes.

### 2.3 `/projects` last-run state (C2)

**API:** `GET /api/projects` stays the same shape; each `Project` returned is augmented with `last_run: { id, state, created_at } | null`. Computed via a correlated subquery (or two queries in `list()`: fetch projects, then one `SELECT MAX(id)` per project — with ≤100 projects in practice this is fine; avoid premature join optimization).

**Shared type:** add `last_run?: { id: number; state: RunState; created_at: number } | null` to `Project`. Optional so list-context and detail-context can diverge if needed.

**UI:** `/projects` cards render a `StateBadge` + relative-time ("3 min ago") next to the project name when `last_run` is present.

### 2.4 "What's running now" on home page (B1)

Reuse the existing 5s run-watcher poll (installed for notifications). Derive a `Map<project_id, running_count>` and render a green dot + count next to each project card that has active runs. No new API; same `GET /api/runs?state=running` already used by the watcher.

### 2.5 Ship boundary

Phase 1 complete when: UI for `/runs` filters + pagination works, `/projects` cards show last-run badge, home page running chip is visible, all of it driven by existing or lightly-extended APIs with no schema changes.

---

## 3. Phase 2 — Pre-run transparency (F1 + F2)

### 3.1 Goal

Before clicking Start Run, the operator can see exactly what Claude is about to receive: the fully composed prompt and the effective plugin list.

### 3.2 Composed-prompt preview (F1)

The server, at launch time, concatenates `preamble + global_prompt + project.instructions + run.prompt`. The same concatenation must be reconstructible client-side, so we don't drift between "what the preview shows" and "what Claude sees."

**Approach:** a new pure function `composePrompt({ preamble, globalPrompt, instructions, runPrompt })` in `src/shared/composePrompt.ts`, used by both:

- **Server** in `supervisor.sh` (no, we can't call TS from bash) — but the server already writes `preamble.txt`, `global.txt`, `instructions.txt`, `prompt.txt` to `/fbi/` and `supervisor.sh` concatenates them. The TS helper mirrors that shell logic; any change to one must be mirrored in the other. Add a test that asserts server-compose output == `supervisor.sh` concatenation behavior (tested by reading the shell logic and reimplementing it in a Vitest test — guards against drift).
- **Web** on the NewRun page, in the "What Claude will see" collapsible panel.

**UI:** a `<details>`-style disclosure, collapsed by default, labeled "Preview what Claude will receive". When open: monospace rendered text with section dividers (`---`) as literal horizontal rules. Live-updates as the user edits `prompt` or `branch`.

**Preamble in preview:** the preamble depends on `project.default_branch`, `project.repo_url`, and the branch hint. The web page has all three, so it reconstructs the preamble locally using the same string template as the server.

### 3.3 Effective plugins/marketplaces preview (F2)

On NewRun, render a compact list above the Start button:

```
Effective plugins: @anthropic-ai/superpowers @anthropic-ai/fancy (3 marketplaces, 2 plugins)
```

If none, render nothing. No new API — the project object already has `marketplaces` and `plugins`; we need the server's `config.defaultMarketplaces` / `defaultPlugins` exposed. Add a tiny `GET /api/config/defaults` returning `{ defaultMarketplaces: string[], defaultPlugins: string[] }`. Cached client-side for the session.

### 3.4 Ship boundary

Phase 2 complete when: NewRun shows a live composed-prompt preview and an effective plugin list, the compose logic is shared test-covered code, and the `/api/config/defaults` endpoint returns the server's global defaults.

---

## 4. Phase 3 — Safety (D1 + D2)

### 4.1 Concurrency soft-cap (D1)

**Setting:** `settings.concurrency_warn_at: integer NOT NULL DEFAULT 3`. Migration-only, no schema-breaking change. `0` disables the warning.

**Wire-up:** NewRun's submit handler, on click:

1. Fetch `/api/runs?state=running` (already wired).
2. If `count >= concurrency_warn_at` (and `warn_at > 0`), show a browser `confirm()` with: "You already have N run(s) in flight. Start another?" Default cancel.
3. If confirmed or under threshold, proceed.

No server-side enforcement. The server still accepts the POST unconditionally — soft cap means the operator's choice wins.

**UI setting:** Settings page gains an integer input "Warn when starting a run with this many already in flight" (blank/0 = never warn).

### 4.2 Image GC (D2)

**Goal:** delete Docker images that aren't reachable from any current project's devcontainer hash and haven't been used in >30 days.

**Setting:** `settings.image_gc_enabled: INTEGER NOT NULL DEFAULT 0` — opt-in. Only when on does the nightly sweep run or the "Run GC now" button function.

**Reachability:** `ImageBuilder` tags images as `fbi/p<projectId>:<hash>` and `fbi/p<projectId>-base:<hash>`, where `<hash>` is recomputed at resolve time from `(devcontainer_file, override_json, ALWAYS, POSTBUILD)`. For GC, reachability is computed by:

1. For each project in the DB, recompute the expected final+base tags via the same `computeConfigHash` inputs the builder uses.
2. Tag anything in that set as "keep".
3. Also "keep" any `fbi/*` image that has an existing container (running OR stopped) referencing it — `docker.listContainers({ all: true })` joined against image id.
4. Every other `fbi/*` image with `Created > 30 days ago` is deleted via `docker.getImage(tag).remove({ force: false })`.

Non-`fbi/` images are never touched.

**Scheduler:** a lightweight in-process timer. On startup, if `image_gc_enabled`, run GC once, then every 24h. A cancel handle is kept so `settings.update` can stop/restart the timer when the toggle flips.

**UI:** Settings page gets:
- A checkbox "Enable nightly image GC (keeps only images used in the last 30 days)".
- A button "Run GC now" (disabled when `image_gc_enabled === false`).
- A read-only line: "Last GC: <time>, reclaimed <n> images, <size> MB" — populated from a new `settings.last_gc_at`, `settings.last_gc_count`, `settings.last_gc_bytes` trio (nullable columns).

**Safety rails:**
- GC never touches non-`fbi/` image tags.
- GC skips any image currently referenced by a container (running or stopped).
- Errors from `docker.getImage().remove` are logged but don't abort the sweep.

### 4.3 Ship boundary

Phase 3 complete when: NewRun shows a confirm dialog above the configured threshold, Settings page has the concurrency + GC controls, GC enabled ticks nightly, GC disabled ticks nothing, and "Run GC now" removes unreachable `fbi/` image tags older than 30 days.

---

## 5. Phase 4 — GitHub surface via `gh` (B2 + E)

### 5.1 Dependency note

All GitHub reads and writes shell out to the host's `gh` CLI. Calls are server-side only; the browser never sees `gh`. If `gh` isn't on the server's `PATH`, every Phase 4/5 endpoint returns HTTP 503 with body `{ error: "gh-not-available" }` and the UI renders a "GitHub CLI not installed" placeholder instead of failing the whole page.

### 5.2 gh helper module

New file `src/server/github/gh.ts`:

```ts
// Thin wrapper around `gh`. Never interpolates into a shell string.
// All methods accept { repo, cwd? } and pass --repo explicitly so we never
// rely on cwd.
export class GhClient {
  constructor(private bin: string = 'gh') {}
  async available(): Promise<boolean> { /* which gh */ }
  async prForBranch(repo: string, branch: string): Promise<PR | null>;
  async prChecks(repo: string, branch: string): Promise<Check[]>;
  async createPr(repo: string, { head, base, title, body }): Promise<PR>;
  async compareFiles(repo: string, base: string, head: string): Promise<FileChange[]>;  // Phase 5
}
```

`repo` is derived from `project.repo_url` (`git@github.com:OWNER/REPO.git` → `OWNER/REPO`). A single `parseGitHubRepo()` helper in `src/shared/` handles both SSH and HTTPS URL forms; returns `null` for non-GitHub repos, which causes Phase 4/5 features to render a "non-GitHub remote" placeholder.

All `execFile` calls use the array-argument form: `execFile('gh', ['pr', 'list', '--repo', repo, '--head', branch, ...])`. No string interpolation into shell.

### 5.3 PR / CI / branch-status card (B2)

**API:** `GET /api/runs/:id/github` returns:

```ts
{
  pr: null | { number: number; url: string; state: 'OPEN'|'CLOSED'|'MERGED'; title: string };
  checks: null | { state: 'pending'|'success'|'failure'; passed: number; failed: number; total: number };
  github_available: boolean;     // false => render placeholder
}
```

Response cached server-side per run ID for 10 seconds (simple in-memory Map with TTL).

**UI:** RunDetail gains a "GitHub status" card below the Terminal, shown only for runs with `state='succeeded'` and a non-empty `branch_name`. Card polls `/api/runs/:id/github` every 30s while the page is open. Inside:

- PR: title, number, state badge, link to URL. If no PR: "No PR yet" + a "Create PR" button (Phase 4 §5.4).
- Checks: colored badge (pending/pass/fail) with `N/M` summary. Links to the GitHub Actions tab.

### 5.4 One-click Create PR (E)

**API:** `POST /api/runs/:id/github/pr` with empty body. Server side:

1. Verify run state is `succeeded`, branch_name present, no existing PR for that branch.
2. Build title: first line of `run.prompt`, truncated to 72 chars, newlines stripped.
3. Build body:
   ```
   <full run prompt>

   ---
   🤖 Generated with FBI run #<id>
   ```
4. Call `gh.createPr(repo, { head: run.branch_name, base: project.default_branch, title, body })`.
5. Return the created PR object.

**UI:** the "No PR yet" state in the GitHub status card contains a "Create PR" button. On success, the card refreshes (bypassing cache) and now shows the PR. On failure, inline error with the `gh` stderr trimmed.

### 5.5 Ship boundary

Phase 4 complete when: RunDetail shows a live GitHub status card for successful runs with GitHub remotes, "Create PR" works when no PR exists, 503 placeholder shows cleanly when `gh` is missing.

---

## 6. Phase 5 — File-level diff summary (B3)

### 6.1 Approach

Uses the `gh.compareFiles` helper added in Phase 4. Prefer `gh api` over `gh pr diff` because the former works whether or not a PR exists, as long as both refs are pushed.

**API:** `GET /api/runs/:id/diff` returns:

```ts
{
  base: string;       // e.g. "main"
  head: string;       // e.g. "fix-login"
  files: Array<{ filename: string; additions: number; deletions: number; status: 'added'|'modified'|'removed'|'renamed' }>;
  github_available: boolean;
}
```

Cached 60s per run (the branch doesn't change post-completion; 60s guards against pathological repeated loads).

### 6.2 UI

RunDetail gains a "Files changed" collapsible section under the GitHub status card. Rendered as a table:

```
Status  File                       +     −
M       src/server/orchestrator/index.ts   12    3
A       src/web/lib/notifications.ts       77    0
```

Each filename links to `https://github.com/<repo>/blob/<branch>/<path>`. No inline diff, no client-side syntax highlighting.

### 6.3 Ship boundary

Phase 5 complete when: RunDetail renders a file list for any successful run whose branch is pushed to a GitHub remote; empty-diff case shows "no files changed"; 503 case shows placeholder.

---

## 7. Phase 6 — Related runs (A carryover)

### 7.1 Approach

The smallest possible "run comparison": surface sibling runs that share the prompt, with a quick compare link to GitHub.

**API:** `GET /api/runs/:id/siblings` returns up to 10 other completed runs with the same `project_id` and identical `prompt`, ordered newest-first:

```ts
Array<{ id: number; branch_name: string; state: RunState; created_at: number; finished_at: number | null; head_commit: string | null }>
```

**UI:** RunDetail adds a "Related runs" collapsible section (only shown when siblings exist). Table with:

- Run # (link to /runs/:id)
- Branch name
- State badge
- Finished-at relative time
- "Diff vs this" button → opens `https://github.com/<repo>/compare/<this-branch>...<sibling-branch>` in a new tab. Only shown when both branches are non-empty.

### 7.2 Ship boundary

Phase 6 complete when: RunDetail surfaces up to 10 sibling runs by identical prompt; "Diff vs this" opens the correct compare URL.

---

## 8. Cross-cutting decisions

### 8.1 Schema changes

Additive only. Per-phase migrations:

- **Phase 1:** none.
- **Phase 2:** none.
- **Phase 3:** `ALTER TABLE settings ADD COLUMN concurrency_warn_at INTEGER NOT NULL DEFAULT 3`; `ADD COLUMN image_gc_enabled INTEGER NOT NULL DEFAULT 0`; `ADD COLUMN last_gc_at INTEGER`; `ADD COLUMN last_gc_count INTEGER`; `ADD COLUMN last_gc_bytes INTEGER`.
- **Phase 4:** none.
- **Phase 5:** none.
- **Phase 6:** none.

### 8.2 `gh` invocation discipline

- Always `execFile`, never `exec`, never template strings into a shell.
- Pass `--repo OWNER/REPO` explicitly — never rely on cwd.
- Pipe stdin/stderr to captured strings; never inherit stdout to the parent.
- On non-zero exit, throw `new GhError(stderr.trim())` — API handlers convert to 500 + trimmed stderr in body.

### 8.3 Caching

- GitHub status: 10s per run id, in-memory.
- Files changed: 60s per run id, in-memory.
- Config defaults: session-lifetime on the client; never changes at runtime without a server restart.

### 8.4 Graceful degradation

Every GitHub-touching endpoint answers `{ github_available: false }` (200 OK) rather than failing when:
- `gh` not on PATH.
- `project.repo_url` isn't parseable as a GitHub repo.
- Current user isn't authenticated to `gh` (errors from `gh` other than network errors signal this).

UI renders a small "GitHub CLI not available" / "Non-GitHub remote" placeholder card — doesn't break RunDetail.

### 8.5 Testing

- **Phase 1:** unit tests for `RunsRepo.listFiltered`. UI smoke for filter/URL sync.
- **Phase 2:** unit tests for `composePrompt` — one test per ordering edge (empty sections, missing instructions). Parity test comparing `composePrompt` output to a mock shell concatenation.
- **Phase 3:** unit test for soft-cap threshold math; GC reachability test against a fake Docker client that records which image tags were deleted.
- **Phase 4/5:** `GhClient` tested by mocking `execFile` with `vi.mock('node:child_process')`. No real `gh` binary in CI.
- **Phase 6:** unit test for `/api/runs/:id/siblings` grouping.

### 8.6 Non-goals restatement

Nothing in this spec introduces: new persistent OAuth flows, PAT storage, a web-facing cron UI, hard run limits, in-app diff rendering, or client-server WebSocket push for status updates. If any of these surface as needed during implementation, stop and file them as a new spec rather than smuggling them in.

---

## 9. Suggested phase order

1. **Phase 1** — Scale & visibility. Ship-ready first; purely additive.
2. **Phase 2** — Pre-run transparency. No deps.
3. **Phase 3** — Safety. Introduces one schema migration; lands before anything GitHub-shaped.
4. **Phase 4** — GitHub surface. Introduces `gh` dependency; lands before Phase 5/6 which reuse the helper.
5. **Phase 5** — Diff summary. Reuses Phase 4 helper.
6. **Phase 6** — Related runs. Purely local; could ship earlier, placed last because "Diff vs this" benefits from being shown next to the other GitHub features.

Each phase is independently reviewable and independently shippable. Implementation plan will encode them as phases with the same "leave suite green at every commit" discipline as the P1 pack.
