# Change Management as a First-Class Surface

## Goal

Make reviewing and shipping an agent's work feel like the primary workflow it is.
Replace the Files + GitHub tabs with a single **Changes** tab built around the
branch's commit tree; move all history-shaping operations (merge, rebase, sync,
squash, commit polish) to raw git so they work for any remote; and make merge
semantics (merge/rebase/squash) a project-level setting so one-click shipping
is reliably boring.

This spec supersedes the GitHub-specific portions of
`2026-04-23-bottom-pane-rework-design.md` (FilesTab, GithubTab, `/files`,
`/github`, `/github/merge`).

## Non-goals

- **No integrations abstraction in this spec.** Types stay `GithubPayload`-shaped
  internally; a follow-up refactor can rename and plugin-ize for GitLab etc.
- **No interactive rebase UI.** "Reorder commits" / "drop commits" are not in scope.
  Commit polish is delegated to the agent.
- **No merge-queue awareness.** Users running GitHub merge queues can still
  create PRs and merge via GitHub; our one-click merge bypasses the queue on
  purpose ("just ship it" is the mode).
- **No Files/GitHub tabs as deprecated coexistence.** The new Changes tab
  replaces both; `/api/runs/:id/files` and `/api/runs/:id/github` endpoints stay
  as building blocks but the UI only consumes a new unified `/changes` endpoint.
- **No change to the agent's own commit cadence.** The post-commit push hook is
  already landed; agents continue to commit as they see fit.

## Scope

One new tab (**Changes**), one new endpoint (`/api/runs/:id/changes`), four new
history-op endpoints (merge / rebase-onto / sync / squash-local), one new
sub-run kind (**polish**), one new project setting (`default_merge_strategy`),
and retirement of the GitHub-specific merge path.

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web: ChangesTab (single replacement for FilesTab + GithubTab)       │
│    - action bar + ⋮ menu                                             │
│    - commit-tree view                                                │
│    - integration strip (GitHub PR + CI when applicable)              │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼  WS event + polling
┌──────────────────────────────────────────────────────────────────────┐
│  Server: /api/runs/:id/changes  — unified payload                    │
│    commits[] + uncommitted + branchBase + integrations.github?       │
│  Server: POST /api/runs/:id/history { op, strategy?, args? }         │
│    one endpoint, four ops: merge | rebase-onto-main | sync | squash  │
└──────────────────────────────────────────────────────────────────────┘
                               │
              ┌────────────────┼─────────────────┐
              ▼                ▼                 ▼
        Live container    Transient           Agent sub-run
         (docker exec)    merge-container     (conflict path,
         for running/     (finished run,      commit polish)
         waiting runs     any remote)
```

- **Live container path**: for `running` / `waiting` runs, the server runs
  `git fetch/rebase/merge/push` inside the active container via `docker exec`.
  Zero new infrastructure, works for any remote.
- **Transient container path**: for finished runs, the server spins up a small
  ephemeral container that clones the repo, performs the git operation, pushes,
  exits. ~10s cold start. Replaces the GitHub-specific `gh api /merges` path
  entirely (which is retired — raw git is now the only path).
- **Agent sub-run path**: when the above fails (conflict) or is explicitly
  agent-driven (commit polish), spawn a child run with `parent_run_id` set to
  the origin run and a templated prompt.

---

## Section 1 — `default_merge_strategy` on projects

### Data

Add column to `projects`:
```sql
default_merge_strategy TEXT NOT NULL DEFAULT 'squash'
  CHECK (default_merge_strategy IN ('merge', 'rebase', 'squash'))
```

Migration sets it to `'merge'` for rows existing at migration time (preserves
today's behavior for pre-existing projects; new projects default to `'squash'`
which matches the vibecoding flow).

`Project` type gets `default_merge_strategy: 'merge' | 'rebase' | 'squash'`.

### UI

Project settings page: new dropdown "Default merge strategy" with three
options and a one-line hint under each:
- **Merge commit** — keep branch history, add a merge commit on main
- **Rebase & fast-forward** — rebase branch onto main, fast-forward
- **Squash & merge** *(default for new projects)* — collapse branch into a single commit on main

### Values affect

Only the one-click `Merge to main` button. The `⋮` menu still exposes all three
strategies explicitly; the project default just determines which one the
primary button uses.

---

## Section 2 — The `Changes` tab

### Tab lineup

`changes · tunnel · meta` (3 tabs, down from 4). `Files` and `GitHub` are
deleted. No alias redirect — dead components are removed cleanly.

### Component structure

`src/web/features/runs/ChangesTab.tsx` replaces `FilesTab.tsx` and
`GithubTab.tsx`. Internal decomposition:

- `ChangesHeader` — branch name, ahead/behind, action buttons, ⋮ menu
- `IntegrationStrip` — one-row GitHub PR + CI summary (conditional)
- `CommitTree` — scrollable list of commit rows + one synthetic "Uncommitted" row
- `CommitRow` — expandable; on expand, renders `FileList` below
- `FileList` — rows of `FileRow`; each expandable to `DiffBlock`
- `FileRow` — path, status chip, +/− stats, click-to-expand

The existing `DiffBlock` primitive is reused unchanged.

### Data model

New payload shape in `src/shared/types.ts`:

```ts
export type MergeStrategy = 'merge' | 'rebase' | 'squash';

export interface ChangeCommit {
  sha: string;
  subject: string;
  committed_at: number;           // unix seconds
  pushed: boolean;                // true if present on origin/<branch>
  files: FilesHeadEntry[];        // populated on demand when commit expanded
  files_loaded: boolean;
}

export interface ChangesPayload {
  branch_name: string;
  branch_base: { base: string; ahead: number; behind: number } | null;
  commits: ChangeCommit[];        // ordered newest-first, bounded to 50
  uncommitted: FilesDirtyEntry[]; // working tree
  integrations: {
    github?: {
      pr: { number: number; url: string; state: 'OPEN'|'CLOSED'|'MERGED'; title: string } | null;
      checks: { state: 'pending'|'success'|'failure'; passed: number; failed: number; total: number } | null;
    };
  };
}
```

Note: `integrations.github` is present only when the project's `repo_url` maps
to a GitHub repo *and* `gh` is available. Its absence is the signal to hide the
integration strip and `[Create PR]`.

### Header — branch bar

```
feat/refactor-auth-middleware · 4 ahead / 0 behind main  [Sync*] [Merge] [Create PR*] ⋮
                                                         └── conditional ──┘
```

- `branch_name` — monospace, clickable → opens `https://github.com/<repo>/tree/<branch>`
  (or nothing if not GitHub).
- `X ahead / Y behind` — ahead in accent, behind in warn when non-zero.
- `[Sync with main]` — visible iff `branch_base.behind > 0`. Amber, subtle pulse.
- `[Merge to main]` — primary (accent). Always visible when `branch_name` present
  and state ∈ `running`/`waiting`/`succeeded`. Uses
  `project.default_merge_strategy`.
- `[Create PR]` — visible iff GitHub integration active and `!integrations.github.pr`.
- `⋮` — always visible when any op is possible.

### Integration strip

One 24px row beneath the header. Renders only if `integrations.github` is present:

```
github · PR #142 — refactor: extract token parser  [open]  ·  ✓ ci 5/5
```

- PR text is a link to the PR URL. Whole row clickable.
- PR state pill uses existing tones.
- CI summary: green dot if all pass; red if any fail; amber pulse if pending.
- Clicking the "ci X/Y" chip opens a hover popover with per-check rows
  (existing `checks.items` data from today's `/github` endpoint).

If GitHub integration is not present, the whole strip is hidden — no empty
state noise.

### Commit tree

1. **Synthetic Uncommitted row** (only if `uncommitted.length > 0`). Accent left-border,
   italic subject "Uncommitted changes", file count, "working tree" timestamp label.
   Always expandable; expanded state default.
2. **Commit rows** (newest-first), each with:
   - Pushed/unpushed dot (green/gray)
   - Short SHA (7 chars, mono, in a chip)
   - Subject (truncated to fit)
   - File count
   - Relative timestamp

Clicking a row toggles expand. On first expand, fires
`GET /api/runs/:id/commits/:sha/files` (see Endpoints), caches result, renders
`FileList` below the row. Expand state keyed by sha (or `'uncommitted'`),
persists across tab switches within the same session.

### File rows and diffs

Exactly as today's FilesTab: path with color-coded status chip, +add/−del
counts, click to expand inline diff via existing `GET /api/runs/:id/file-diff`.
The diff endpoint is unchanged; this spec doesn't touch it.

### Empty states

- No changes at all (`commits.length === 0 && uncommitted.length === 0`):
  "No changes yet. The agent hasn't committed anything." Shown only after the
  first poll returns.
- Branch unset: "This run didn't produce a branch." (covers the rare case of a
  run that never touched git.)
- Not GitHub / no `gh`: the integration strip is simply absent; no message
  needed. Commits/files still render.

### Tab count badge

`ChangesTab` count = `uncommitted.length + commits.reduce((n, c) => n + c.files.length, 0)`
when `files_loaded`, else falls back to `uncommitted.length + commits.length`
(rough approximation until files load). Badge hidden when zero.

---

## Section 3 — ⋮ menu

Rendered as a `Menu` primitive (already in the UI library). Grouped:

**Merge strategy**
- Merge commit *(checked if `project.default_merge_strategy === 'merge'`)*
- Rebase & fast-forward *(checked if `rebase`)*
- Squash & merge *(checked if `squash`)*

Clicking a non-default strategy immediately runs `Merge to main` with that
strategy override. Does not change the project default (that's in settings).

**History**
- **Sync branch with main** — always enabled when `branch_name` exists.
  Runs `git fetch origin && git rebase origin/<default>` in the active
  container (or transient container for finished runs). Force-pushes the
  branch. Conflicts → agent sub-run.
- **Squash local commits** — only enabled when `commits.length > 1`.
  Runs `git reset --soft <origin/default>... && git commit -m "<subject>"` in
  the container, force-pushes. Subject defaults to the run's title or first
  commit subject; user can override via a quick prompt dialog (one-line
  `<input>`).
- **Polish commits with agent** — spawns a sub-run with a templated prompt
  ("rebase and rewrite commit messages on <branch> so each commit has a clear
  conventional-commits-style subject and coherent body; then force-push").
  Agent handles the interactive rebase in its normal workflow.

**Misc**
- Copy branch name
- Open branch on GitHub ↗ (conditional on integration present)

### Menu implementation notes

- Use the existing `Menu` primitive; no new popover component.
- Destructive ops (sync, squash, merge with non-default strategy) get a
  confirmation toast — not a dialog, a post-click "Undo" banner for 8s that lets
  the user abort if the op hasn't finished. Easier to live with than a modal.

---

## Section 4 — History ops endpoint

Single endpoint, discriminated by `op`:

```
POST /api/runs/:id/history
  body: { op: 'merge',          strategy?: 'merge'|'rebase'|'squash' }
       | { op: 'sync' }
       | { op: 'squash-local',  subject: string }
       | { op: 'polish' }
  → 200 { kind: 'complete',    sha?: string }
  → 202 { kind: 'agent',       child_run_id: number }
  → 409 { kind: 'conflict',    child_run_id: number }
  → 409 { kind: 'agent-busy' }
  → 400 { kind: 'invalid' }
  → 503 { kind: 'git-unavailable' }
```

Response `kind` discriminator:
- `complete` — the op ran server-side, no further action needed. `sha` present
  for merge/sync/squash-local (the new head of the relevant branch).
- `agent` — spawned a child run; the client should navigate to it
  (same as current conflict path). Used for `polish` unconditionally, and for
  any op that hits a conflict.
- `conflict` — shorthand for "spawned an agent sub-run to resolve a conflict."
  Effectively the same as `agent` but distinct for UX copy ("conflicts —
  delegated to agent #123" vs "polishing — delegated to agent #123").
- `agent-busy` — no container available and the user didn't want agent
  delegation (for ops where that makes sense; currently only forced path).

### Execution model

```ts
function execGit(args: string[]): Promise<Result> {
  const live = orchestrator.execInContainer(runId, ['git', ...args], { timeoutMs: 30_000 });
  if (live) return live;
  return transientMergeContainer(project, args, { timeoutMs: 120_000 });
}
```

`transientMergeContainer` is new (Section 5). It clones the repo into a fresh
container using the project's devcontainer image (fallback to a tiny git/ssh
base image), runs the op, force-pushes, exits.

### Op implementations (shell equivalents)

- **merge, strategy=merge**:
  ```
  git fetch origin
  git checkout <default>
  git pull --ff-only origin <default>
  git merge --no-ff <branch>
  git push origin <default>
  ```
- **merge, strategy=rebase**:
  ```
  git fetch origin
  git checkout <branch>
  git rebase origin/<default>           # conflicts → abort & delegate
  git push --force-with-lease origin <branch>
  git checkout <default>
  git pull --ff-only
  git merge --ff-only <branch>
  git push origin <default>
  ```
- **merge, strategy=squash**:
  ```
  git fetch origin
  git checkout <default>
  git pull --ff-only
  git merge --squash <branch>
  git commit -m "<title>"                # title from run.title or run.prompt first line
  git push origin <default>
  ```
- **sync**: same as the first half of rebase (up to `push --force-with-lease`).
- **squash-local**:
  ```
  git reset --soft $(git merge-base HEAD origin/<default>)
  git commit -m "<subject>"
  git push --force-with-lease origin <branch>
  ```
- **polish**: always agent sub-run. Prompt template:
  ```
  You're polishing the commits on branch <branch>.
  Use git interactive-rebase (or equivalent) to:
    1. Rewrite each commit's subject as a concise conventional-commits style summary.
    2. Ensure each commit body explains the "why", not just the "what".
    3. Combine trivially-related "wip:" or "fix:" commits where appropriate.
    4. Do NOT change code — only commit metadata.
  Then: git push --force-with-lease origin <branch>.
  Finish by writing a one-line summary of your changes to /fbi-state/session-name.
  ```

### Conflict detection

Each op wraps its git command and inspects exit code + stderr. On non-zero
with stderr matching `/CONFLICT|conflict|could not apply|rebase failed/i`, the
server aborts (`git merge --abort` / `git rebase --abort` / `git reset --hard`
back to a known-good state), then spawns an agent sub-run with a conflict
prompt, returning `{ kind: 'conflict', child_run_id }`.

---

## Section 5 — Transient merge containers

For finished-run ops (state ∈ `succeeded` / `failed` / `cancelled`), the active
container is gone. New orchestrator method:

```ts
async execHistoryOp(
  runId: number,
  op: HistoryOp,
  args: HistoryOpArgs,
): Promise<HistoryResult>
```

For live runs, dispatches to `execInContainer`. For finished runs, builds a
transient container:

- Image: the project's existing devcontainer image (built once per project by
  `ImageBuilder`; already cached). Fall back to
  `ghcr.io/fynn-labs/fbi-git-base:latest` (tiny alpine + git + ssh) when no
  devcontainer image exists.
- Mounts: host SSH-agent socket (same as normal runs), git author name/email env
  (same), a fresh tmpfs for the workspace.
- Command: a bundled `fbi-history-op.sh` script that takes `$OP` env and
  performs the shell sequence from Section 4.
- Lifetime: `--rm`, runs to completion, max 120s timeout.
- Output: stdout/stderr captured; on nonzero exit we return `gh-error` with the
  last ~200 bytes of stderr.

Transient containers are NOT exposed as runs in the UI. They're background ops.
On conflict, the orchestrator **does** spawn a real agent sub-run (with a
`parent_run_id` and a templated prompt), which is a normal run.

---

## Section 6 — Sub-runs (agent-driven merge / polish)

`parent_run_id` column is already on `runs` (added in
`2026-04-23-bottom-pane-rework-design.md`, currently unused).

New run kind signaled by new columns on `runs`:

```sql
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'
  CHECK (kind IN ('work', 'merge-conflict', 'polish'));
ALTER TABLE runs ADD COLUMN kind_args_json TEXT;     -- JSON blob
```

`kind` defaults to `'work'` (the normal case). Sub-runs get `'merge-conflict'`
or `'polish'`, and their prompt is templated from `kind_args_json`.

### UI: Meta tab "Related" rendering

The existing Related section in Meta already lists siblings. It also renders
**sub-runs** of the current run (`parent_run_id === this.id`), with a small
badge for `kind`:
- ↳ `#48` merge-conflict — delegated merge for feat/x
- ↳ `#49` polish — commit polish for feat/x

Sub-runs appear in the main run list too, with a similar badge.

### Navigation when an op spawns a sub-run

When the history endpoint returns `{ kind: 'agent'|'conflict', child_run_id }`,
the ChangesTab shows a toast "Delegated to agent (run #N) — view ↗", clicking
which navigates to `/runs/N`. We don't auto-navigate — the user may want to
stay on the parent.

---

## Section 7 — Retirement of gh-CLI merge path

Remove:
- `GhClient.mergeBranch` method entirely
- `/api/runs/:id/github/merge` endpoint entirely
- `api.mergeRunBranch` web helper
- `'already-merged' | 'gh-error'` reasons from `MergeResponse` (the whole
  `MergeResponse` type is replaced by the new history-op response)

Keep `GhClient.commitsOnBranch`, `prForBranch`, `prChecks`, `createPr`, and
`available()` — those are read-only enrichments, still useful.

The `/api/runs/:id/github/pr` endpoint (Create PR) stays as-is. It's the one
thing that genuinely needs GitHub semantics.

---

## Section 8 — Changes endpoint (`/api/runs/:id/changes`)

Unified read endpoint. Returns `ChangesPayload`. 10-second cache (same TTL as
today's `/github`). Internally composes:

1. From the live `GitStateWatcher` snapshot: `uncommitted`, `branch_base`,
   head commit (becomes commits[0] if not in the gh-reported list already).
2. From `gh api`: `commits` (last 20), `integrations.github.pr`,
   `integrations.github.checks`. Tolerates `gh` missing — just leaves
   `integrations.github` out.
3. For pushed-status: reconcile the local HEAD against the gh-reported list.
   Commits in the gh list → `pushed: true`. Local HEAD not in that list →
   `pushed: false` (local-only).

`/files` and `/github` are deleted. `/file-diff` stays (the Changes tab uses it
for inline diffs). `/changes/commits/:sha/files` is new and thin — returns the
file list for a specific commit via `gh api compare <parent>..<sha>` or
`docker exec git show --numstat <sha>` depending on availability.

---

## Section 9 — WebSocket events

Current `files` event is renamed to `changes`. Payload is the full
`ChangesPayload` (not a delta — simpler; sizes are bounded and deltas aren't
worth the complexity). Poll cadence still 2s while the run is active.

Client subscribers (web) replace their `files` handler with a `changes` handler
and stop calling `/files`.

---

## Section 10 — Testing

- **Unit**
  - `ChangesTab` render matrix: with/without uncommitted, with/without
    integrations, empty state, 50-commit cap.
  - `ChangesHeader` — Sync button conditional on `behind > 0`; menu strategy
    checkmark follows project default.
  - `CommitRow` expand/collapse, files lazy-load.
  - Server: `executeMerge({strategy: 'merge'|'rebase'|'squash'})` with mocked
    `docker exec`, asserting the shell sequence. One test per strategy.
  - Server: conflict detection fires agent sub-run and returns
    `{ kind: 'conflict' }`.
  - Server: transient merge container — mocked `docker create/start/wait` path.
- **Integration**
  - Run a real agent against a test repo, observe Changes tab fills live,
    commits flip to pushed after post-commit hook runs.
  - Force-push flows (sync, squash-local) succeed and the commit tree updates.
  - Conflict path: create a conflicting commit on main mid-run, click Merge,
    observe agent sub-run spawned, the parent's Changes tab receives
    "delegated to #N" toast.

---

## Section 11 — Implementation notes

- **No UI migration gate.** Changes tab is visible the first time the rebuilt
  web bundle runs; FilesTab / GithubTab are removed in the same release.
- **Existing runs** keep working — the new endpoint only depends on data we're
  already collecting.
- **Force-push policy**: we always use `--force-with-lease`, never plain
  `--force`. Protects against silent overwrites if someone else pushed.
- **Merge strategies and long-running branches**: `rebase` and `squash` rewrite
  the branch's history on `origin`. If the user has collaborators on that
  branch (another agent, a human), they'll see a diverged branch. Acceptable
  for single-user vibecoding; users in shared branches should pick `merge` as
  their project default.
- **Confirmation**: destructive ops (sync, squash-local, merge with strategy
  different from default) show a post-click "Undo" banner for 8s instead of a
  modal. Undo is best-effort — if the push has already landed, we surface
  "can't undo: already pushed".
- **Project settings UI**: the new `default_merge_strategy` dropdown is added
  to the existing project edit form. No new settings page.

## Open follow-ups (out of scope)

- Integrations abstraction (`ChangesPayload.integrations` becomes plugin-backed
  for GitLab, Gitea, etc).
- Merge-queue awareness for teams.
- Pre-merge check: "CI is failing, are you sure?" confirmation.
- Per-run strategy override saved across page reloads (currently project-level
  only).
- Interactive commit reorder/drop via a richer UI.
