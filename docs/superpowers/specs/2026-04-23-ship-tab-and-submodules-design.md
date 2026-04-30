# Ship Tab + First-Class Submodule Support

## Goal

Make shipping a branch the second pillar of a run (alongside reviewing the
changes), instead of a cramped action bar hidden under a `⋮` menu. Give it
its own tab, a spacious labeled layout, and strategy-aware controls that
match muscle memory (GitHub's PR-merge split-button). While reworking the
shipping surface, fix the submodule gap: agents operating on repos with
submodules currently risk losing work (parent pushes a SHA the submodule's
remote doesn't have) and the UI hides submodule changes behind a cryptic
one-line row. Both the Changes tab and the new Ship tab become first-class
citizens of repos that use submodules.

This spec supersedes the ChangesTab action-bar + `⋮` menu portions of
`2026-04-23-change-management-design.md`. The history-op endpoint and the
shell runner stay; the UI around them changes and they grow submodule
awareness.

## Non-goals

- **No submodule-branch merging** from FBI. A submodule is a pinned pointer
  in the parent; we make it safe to push and easy to see, but we don't try
  to "merge the submodule's feature branch into its main" — that would be
  a separate Ship tab per submodule, out of scope.
- **No recursive-recursive submodule rendering.** One level deep in the
  Changes tree. Nested-nested submodules (submodule-of-submodule) are
  flattened: the outer bump is shown, the inner bumps are rendered as
  simple file rows.
- **No new agent sub-run kinds.** Ship-tab agent ops are still just
  `polish` (from the prior spec). Adding submodule-aware polish / review
  is a follow-up.
- **No alternatives-to-GitHub** in this spec. PR + CI rendering still
  assume the current GitHub path; GitLab et al. remain a future refactor.
- **No changes to gh.ts, run lifecycle, or parent_run_id semantics.**

## Scope in one paragraph

One new tab (`ship`) between `changes` and `tunnel`. The tab renders a
branch status line, a primary merge split-button whose label reflects the
user's last-selected strategy (persisted globally to localStorage), and
grouped History / Agent / Submodules / Links sections. The Changes tab
loses its action bar and integration strip — the branch header becomes
pure info. Both tabs grow submodule rendering: bumps show as expandable
nodes with their own commit list (capped at 20, truncated indicator if
more); dirty submodules appear under Uncommitted with their own files +
local commits. The post-commit push hook and all history ops switch to
`--recurse-submodules=on-demand` so pushes are always safe. A new
per-submodule "Push submodule" action catches any submodule state that the
hook couldn't resolve automatically.

## Section 1 — Tab set

`changes · ship · tunnel · meta` (4 tabs; up from 3 in
`2026-04-23-change-management-design.md`).

`ship` renders a subtle dot after its label:

- **amber** when `branch_base.behind > 0` — branch is stale; sync needed.
- **accent** when `branch_base.ahead > 0 && pr?.state !== 'MERGED' && (!checks || checks.state === 'success')` — ready to ship.
- **no dot** otherwise.

Amber wins when both conditions apply (stale > ready). The indicator
updates live from the same `/changes` polling used by the tab itself.

## Section 2 — Changes tab: action bar removed

Changes tab retains only:

- Branch header line: `branch · N ahead / M behind main` (no buttons).
- Commit tree (with submodule rendering — Section 7).
- Inline diffs on click (unchanged).

Deleted:
- `ChangesHeader.tsx` (action bar + ⋮ menu)
- `IntegrationStrip.tsx` (PR + CI summary — moves to Ship)

Kept but simplified:
- `ChangesTab.tsx` renders its own minimal header inline. No extra component.

## Section 3 — Ship tab layout

### Header
One line, mirrored across run states:

```
branch · N ahead / M behind main  ·  PR #142 ↗  ·  ci 5/5 ✓
```

Links: PR and CI status are anchors (PR → GitHub PR URL, CI → aggregated
checks URL). If `integrations.github` is absent, those segments are
omitted. If `pr.state === 'MERGED'`, a banner appears **above** the primary
card:

```
✓ Shipped · merged as abc1234 · 2m ago                   [view merge ↗]
```

`pr.state === 'CLOSED'` shows an amber banner: `PR closed (not merged)`.
Actions below stay active — the run isn't dead.

### Primary card (Merge to main)

Centered, bordered, accent-toned.

```
┌────────────────────────────────────────────────────┐
│ Merge to main                                      │
│ Combine this branch into main using the strategy   │
│ you pick.                                          │
│                                                    │
│   [Merge with squash ▾]   strategy: clean main     │
│                                                    │
│ Strategy persists across projects.                 │
└────────────────────────────────────────────────────┘
```

The split-button is rendered by a new `SplitButtonMerge` component:
- **Body click**: runs merge with the current strategy.
- **Caret click**: opens a popover listing the three strategies, each
  with a one-line hint (`preserves history`, `linear history`,
  `clean main`). The current selection has a ✓. Clicking an item updates
  the selection **and the button label** (`Merge with merge-commit`,
  `Merge with rebase`, `Merge with squash`) and closes the popover.
  **Does not run the merge.**
- **Persistence**: selection saved to `localStorage['fbi.mergeStrategy']`
  as the literal string `'merge' | 'rebase' | 'squash'`.
- **Initial value resolution**:
  1. `localStorage['fbi.mergeStrategy']` if valid.
  2. `project.default_merge_strategy`.
  3. `'squash'` as the hardcoded fallback.

Disabled states (tooltip on hover, button greyed):
- `ahead === 0`: "Nothing to merge."
- `!branch_name`: "This run didn't produce a branch." (card renders but
  button is disabled.)

### History section

Two rows, each a labeled button + one-line description:

```
History
  [Sync with main]      Rebase this branch onto main and force-push.
                        Useful when main moved during your run.

  [Squash local 4→1]    Combine your 4 commits into 1 on the feature
                        branch. Cleans up before you merge.
```

- **Sync row** is highlighted amber (background + left border) when
  `behind > 0`. Button label unchanged, just visually prominent.
- **Squash row** is hidden entirely when commits < 2.

### Agent section

One row, distinct purple (`text-accent-purple` / add a `bg-agent-subtle`
token if missing):

```
Agent actions
  [✦ Polish commit messages]    Spawn an agent sub-run that rewrites
                                each commit's subject and body without
                                touching code.
```

### Submodules section

Shown only when `changes.dirty_submodules.length > 0` OR at least one
commit in `changes.commits` has non-empty `submodule_bumps`. Rendered as
one row per submodule:

```
Submodules
  📦 cli/fbi-tunnel   2 local commits unpushed    [Push submodule]
  📦 docs/ref         clean
```

Each row shows:
- Submodule path (monospace).
- Status: `N local commits unpushed` / `N dirty files` / `bumped in last commit` / `clean`.
- `[Push submodule]` button on rows that have local-only state.

### Links section

Subtle footer row:

```
Links   Create PR   feat/x on GitHub ↗   copy branch name
```

`Create PR` becomes `View PR on GitHub ↗` once one exists.

### Sub-runs section

If this run has children (other runs with `parent_run_id === this.id`):

```
Sub-runs
  ↳ #48 merge-conflict · running
  ↳ #49 polish · succeeded · 4m ago
```

Each entry is a link to the child run. Rendered below Links.

## Section 4 — State machine (Ship tab by run/branch state)

| Condition | Render |
|---|---|
| No `branch_name` | "This run didn't produce a branch." No card, no sections. |
| Normal branch with commits | Full layout. |
| `behind > 0` | Sync row highlighted amber; same under-card hint. |
| `pr.state === 'MERGED'` | Blue "Shipped ✓" banner above card. Actions stay active; merge button disabled if `ahead === 0`. |
| `pr.state === 'CLOSED'` (not merged) | Amber "PR closed" banner. Actions stay active. |
| GitHub unavailable | PR + CI segments absent from header. Merge still works (raw git). Submodules section still works. |

## Section 5 — Data model additions

`src/shared/types.ts`:

```ts
export interface SubmoduleBump {
  path: string;                 // repo-relative
  url: string | null;           // submodule's remote URL (null if gitmodules doesn't define one)
  from: string;                 // old SHA
  to: string;                   // new SHA
  commits: ChangeCommit[];      // commits in the submodule between from..to, capped at 20
  commits_truncated: boolean;   // true if more than 20 commits in the range
}

export interface SubmoduleDirty {
  path: string;
  url: string | null;
  dirty: FilesDirtyEntry[];     // uncommitted changes inside the submodule
  unpushed_commits: ChangeCommit[];  // local commits not yet on the submodule's origin, capped at 20
  unpushed_truncated: boolean;
}

export interface ChangeCommit {
  // existing fields…
  submodule_bumps: SubmoduleBump[];  // empty for commits that don't touch submodules
}

export interface ChangesPayload {
  // existing fields…
  dirty_submodules: SubmoduleDirty[];   // empty when no submodule has working-tree changes
  children: ChildRunSummary[];
}

export interface ChildRunSummary {
  id: number;
  kind: 'work' | 'merge-conflict' | 'polish';
  state: RunState;
  created_at: number;
}
```

The `ChangeCommit` inside `SubmoduleBump.commits` and
`SubmoduleDirty.unpushed_commits` is the **same** `ChangeCommit` type,
used recursively one level deep only. A commit inside a submodule could
in principle have its own `submodule_bumps`, but we always emit the inner
ones as empty — that's the "flatten to immediate level" rule.

## Section 6 — Server changes

### `GitStateWatcher` extension

Existing watcher script is extended to also emit submodule data:

```sh
printf "__SM_STATUS__"; git submodule status --recursive 2>/dev/null
# per submodule with `+` prefix (bumped from HEAD) or `-` (uninitialized):
#   print dirty file list and local-only commit count via `git -C <path>`
```

The parser in `gitStateWatcher.ts` maps the output into
`SubmoduleDirty[]` (for the live-watcher snapshot — only the dirty ones;
bumps are per-commit and handled by the `/changes` endpoint).

### `/api/runs/:id/changes` extension

For each commit returned, run `git show <sha> --submodule=log` in the
container — this reports submodule bumps in a parseable format. Parse
into `SubmoduleBump[]`, attach to the `ChangeCommit`. For the `from..to`
commit list inside each bump, run `git -C <submodule-path> log from..to
--format='%H%x00%s%x00%ct'` and map to `ChangeCommit` entries (files
lazy, fetched on expand). Cap at 20; set `commits_truncated`.

If a submodule has no URL configured (`git config -f .gitmodules
submodule.<name>.url` returns empty), `url: null`.

Add `children`: `deps.runs.listByParent(runId)` → mapped to
`ChildRunSummary[]`.

### New endpoint: `GET /api/runs/:id/submodule/:path/commits/:sha/files`

Returns files for a commit *inside* a submodule. Same shape as
`/commits/:sha/files`. Path is URL-encoded (it contains slashes).

Implementation: `docker exec` `git -C /workspace/<submodule-path> show
--numstat --format= <sha>`.

### New history op: `op: 'push-submodule'`

Request body: `{ op: 'push-submodule', path: string }`. Runs
`git -C /workspace/<path> push origin HEAD` via the same
`execHistoryOp → runHistoryOpInContainer` path. Script change: add a
`run_push_submodule` case to `fbi-history-op.sh`.

Response shape: same `HistoryResult` — `{kind:'complete'}` on success,
`{kind:'git-error', message}` on push failure.

### `fbi-history-op.sh` extension

All `git fetch` calls in the script gain
`--recurse-submodules=on-demand`. All `git push` calls gain the same.
This ensures that any op touching the parent also handles submodule
history.

### Post-commit hook update

`supervisor.sh` switches the post-commit hook to
`git push --recurse-submodules=on-demand origin HEAD`. Agents working
inside a submodule (running commits against the submodule dir) still
need an explicit `git -C <submodule-path> push` — the parent-level hook
only fires on parent commits. This is OK because we surface the per-
submodule push button in the UI as a fallback.

## Section 7 — UI details

### `ChangesTab` — submodule rendering

Inside the commit tree:

- `CommitRow` whose `submodule_bumps.length > 0` renders bump rows
  **below** the normal file list, visually indented one level. Each
  bump row is a new `SubmoduleBumpRow` component (~30 LOC) showing
  `📦 <path> · <from7> → <to7>`. Click to expand.
- Expanded bump renders the range's commits as regular `CommitRow`s
  (recursion) with the submodule path prefixed where needed. Their
  file-list fetches use the new submodule-scoped endpoint.

Under **Uncommitted** (synthetic top node):

- Existing `dirty` files render as today.
- After them, each `dirty_submodules` entry renders a
  `SubmoduleDirtyRow` (~25 LOC): `📦 <path> · <summary>` where summary
  is e.g. "2 dirty files, 1 local commit." Expand to show the
  submodule's dirty files + unpushed commits.

### `ShipTab` — submodule rendering

The **Submodules** section renders `SubmoduleStatusRow` per submodule:

- For a submodule in `dirty_submodules`: status `N local commits
  unpushed · M dirty files` + `[Push submodule]` button when local
  commits exist.
- For a submodule that appears only in a recent commit's bump but is
  otherwise clean: status `bumped in <sha>`.
- For a submodule that's clean: `clean` (shown only if we have reason
  to mention it — otherwise omitted to keep the list small).

Clicking `[Push submodule]` fires
`POST /api/runs/:id/history` with `{ op: 'push-submodule', path }`. Uses
the same `useHistoryOp` hook — success/error messaging flows through
the existing toast.

### `SplitButtonMerge` component

File: `src/web/features/runs/SplitButtonMerge.tsx` (~100 LOC).

Props:
```ts
interface Props {
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onMerge: (strategy: MergeStrategy) => void;
  projectDefault: MergeStrategy;  // fallback when localStorage empty
}
```

Exposes the split-button and manages:
- Current selection (`useMergeStrategy()` hook; see below).
- Popover open state.
- Busy / disabled visuals.

Button label is derived from selection:
- `merge` → "Merge with merge-commit"
- `rebase` → "Merge with rebase"
- `squash` → "Merge with squash"

(No per-label variants — keep the wording uniform.)

### `useMergeStrategy` hook

File: `src/web/features/runs/useMergeStrategy.ts` (~30 LOC).

```ts
export function useMergeStrategy(projectDefault: MergeStrategy) {
  const [strategy, setStrategyState] = useState<MergeStrategy>(() => readInitial(projectDefault));
  const setStrategy = useCallback((s: MergeStrategy) => {
    setStrategyState(s);
    try { localStorage.setItem(KEY, s); } catch { /* quota */ }
  }, []);
  return { strategy, setStrategy };
}

function readInitial(projectDefault: MergeStrategy): MergeStrategy {
  const raw = (typeof window !== 'undefined')
    ? window.localStorage.getItem(KEY)
    : null;
  if (raw === 'merge' || raw === 'rebase' || raw === 'squash') return raw;
  return projectDefault;
}

const KEY = 'fbi.mergeStrategy';
```

### `ShipTab` component tree

```
ShipTab
├── ShipHeader (branch/ahead/behind + PR + CI; banners)
├── MergePrimary (card with SplitButtonMerge)
├── HistorySection (Sync + Squash rows)
├── AgentSection (Polish row)
├── SubmodulesSection (conditional)
├── LinksSection (Create PR / View PR / branch link / copy)
└── SubRunsSection (conditional)
```

Each sub-component in its own file under
`src/web/features/runs/ship/`. ShipTab stitches them; each is
individually testable.

## Section 8 — State persistence

- `fbi.mergeStrategy` in `localStorage` — single string.
- No per-run / per-project override in the UI. If a user genuinely
  needs different strategies per project, they'd change their last
  selection between merges. This keeps the UX dead simple; we'll add
  a per-project hint if the signal emerges.

## Section 9 — Files

### New
- `src/web/features/runs/ship/ShipTab.tsx`
- `src/web/features/runs/ship/ShipHeader.tsx`
- `src/web/features/runs/ship/MergePrimary.tsx`
- `src/web/features/runs/ship/HistorySection.tsx`
- `src/web/features/runs/ship/AgentSection.tsx`
- `src/web/features/runs/ship/SubmodulesSection.tsx`
- `src/web/features/runs/ship/LinksSection.tsx`
- `src/web/features/runs/ship/SubRunsSection.tsx`
- `src/web/features/runs/SplitButtonMerge.tsx`
- `src/web/features/runs/useMergeStrategy.ts`
- `src/web/features/runs/SubmoduleBumpRow.tsx` (Changes tab helper)
- `src/web/features/runs/SubmoduleDirtyRow.tsx` (Changes tab helper)
- Tests colocated next to each component.

### Modified
- `src/shared/types.ts` — add `SubmoduleBump`, `SubmoduleDirty`,
  `ChildRunSummary`; extend `ChangeCommit` and `ChangesPayload`.
- `src/server/api/runs.ts` — extend `/changes` to populate new fields;
  add `/submodule/:path/commits/:sha/files`; extend `/history` to
  accept `op: 'push-submodule'`.
- `src/server/orchestrator/gitStateWatcher.ts` — submodule status
  parsing.
- `src/server/orchestrator/fbi-history-op.sh` — `--recurse-submodules`
  flags everywhere; `run_push_submodule` case.
- `src/server/orchestrator/supervisor.sh` — post-commit hook switches
  to `--recurse-submodules=on-demand`.
- `src/server/db/runs.ts` — add `listByParent(parentRunId): Run[]`.
- `src/web/features/runs/RunDrawer.tsx` — add `'ship'` between
  `'changes'` and `'tunnel'`; accept + render dot indicator state.
- `src/web/features/runs/ChangesTab.tsx` — strip action bar + integration
  strip; render simple branch header inline; render submodule bumps +
  dirty submodules in the commit tree.
- `src/web/features/runs/CommitRow.tsx` — render submodule bumps below
  file list when present.
- `src/web/pages/RunDetail.tsx` — compute dot state; pass through to
  `RunDrawer`; route `'ship'` to `ShipTab`.
- `src/web/lib/api.ts` — add `getRunSubmoduleCommitFiles`; no change to
  `postRunHistory` (body shape is already `HistoryOp`).

### Deleted
- `src/web/features/runs/ChangesHeader.tsx`
- `src/web/features/runs/ChangesHeader.test.tsx`
- `src/web/features/runs/IntegrationStrip.tsx`

## Section 10 — Testing

### Unit
- `useMergeStrategy` — localStorage roundtrip, fallback to project default,
  invalid-value guard (falls back).
- `SplitButtonMerge` — body click fires onMerge with current strategy;
  caret click opens popover; item click updates label + persists without
  firing onMerge; checkmark on current selection.
- `ShipTab` — render matrix for Section 4's six states (no-branch,
  normal, behind, merged, closed, gh-unavailable). Dot indicator logic
  tested through a shared `computeShipDot(payload)` helper.
- `SubmoduleBumpRow` / `SubmoduleDirtyRow` — expand/collapse, file fetch.
- Server: gitStateWatcher submodule parser; `/changes` with submodule
  bumps; `/history` with `op: 'push-submodule'`.

### Component-integration
- `ChangesTab` — no action bar rendered; submodule bumps render inside
  commit rows; dirty submodules render under Uncommitted.
- `RunDrawer` — `'ship'` tab present; dot indicator renders with the
  right class when amber/accent/none.

### Manual (Playwright + dev server)
- Create a test project whose repo has submodules; run a fake agent that
  bumps a submodule and makes changes inside one; verify ShipTab renders
  the submodules section, Changes tab nests bump commits, Push Submodule
  action succeeds end-to-end.

## Section 11 — Rollout

- No DB migration (no schema changes beyond previous specs).
- No API versioning concerns — response shape strictly additive.
- First commit: post-commit hook `--recurse-submodules` flip. Ships
  a concrete safety win immediately.
- Rest of the work merges as the UI is built.

## Section 12 — Open follow-ups (out of scope)

- Agent-aware submodule polish: a `polish-submodule` sub-run kind that
  cleans up submodule commit messages independently.
- Submodule code review / merge: dedicated workflows for submodule
  branches.
- GitLab / generic-remote integration ("integrations" abstraction).
- Per-project merge strategy override in Ship (currently global-only).
- `ship` tab search / filter for when there are many sub-runs.
- Non-linear submodule graphs (recursive > 1 level).
