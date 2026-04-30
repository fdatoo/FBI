# Run Detail Bottom-Pane Rework

## Goal

Turn the Run Detail bottom pane into the primary control surface for a run: a live
file-change view, a real GitHub view with actionable buttons, and a consolidated
Meta tab that absorbs the right-side panel. As part of the same change, teach
agents to push commits to the feature branch while they work, so the GitHub view
is meaningful mid-run, and add a Merge-to-main button whose common path is a
fast server-side GitHub API call.

The entire right-side `RunSidePanel` is retired; everything lives in the bottom
pane, which becomes vertically resizable.

## Non-goals

- No new agent lifecycle state ("idle", TTL, reaper). Container lifetime stays
  exactly as it is today.
- No "code review" button in v1. The architecture makes it cheap to add later,
  but it is out of scope for this spec.
- No new icon dependency. All icons are inline SVG per the existing convention.
- No new state-machine entries: `parent_run_id` is the only schema addition.
- No changes to the run list, header, or terminal themselves.

## Scope in one paragraph

Four bottom-pane tabs: `files`, `github`, `tunnel`, `meta` (tunnel and prompt
already exist; prompt moves into meta as a collapsible section). Files shows
live working-tree changes plus last commit with expandable inline diffs. GitHub
shows commits + PR + CI ungated, with `[Create PR]` and `[Merge to main]`
buttons. Meta holds Info, Usage, Related, and collapsible Prompt. The pane is
vertically resizable (global localStorage). Agents push after every commit via
a silent `post-commit` hook installed in the supervisor. The Merge-to-main
button has a fast server-side path (GitHub Merge API) and a slow in-container
path (stdin prompt injection into the existing Claude session) for the conflict
case. The right-side panel goes away.

## Touch points

- **Supervisor**: `src/server/orchestrator/supervisor.sh` — install a
  `post-commit` hook.
- **Orchestrator**: `src/server/orchestrator/index.ts` — add `dockerExec()`
  helper and `GitStateWatcher` (mirrors `UsageTailer`); add a new `files` WS
  event type.
- **API**: `src/server/api/runs.ts` — ungate `/diff` and `/github`, add
  `GET /api/runs/:id/file-diff`, `POST /api/runs/:id/github/merge`, and extend
  `/github` to include commits-on-branch.
- **GitHub client**: `src/server/github/gh.ts` — add `commitsOnBranch()` and
  `mergeBranch()` (calls `gh api POST /repos/.../merges`).
- **Web**: `src/web/features/runs/` — rework `FilesTab` and `GithubTab`, add
  `MetaTab`, delete `PromptTab` and `RunSidePanel`, adjust `RunDrawer` for
  resize and new tab set, update `RunDetail` to drop the aside.

## Section 1 — Mid-run pushing (post-commit hook)

Install a silent `.git/hooks/post-commit` in the container during `supervisor.sh`
setup (after the clone, before Claude starts). Hook body:

```sh
#!/bin/sh
# Silent background push. Do not block the commit.
( git push -u origin HEAD > /tmp/last-push.log 2>&1 || true ) &
```

- Uses the SSH socket already mounted into the container.
- `&` so the commit returns immediately even on slow networks.
- Never exits non-zero (commits must never fail because of a transient push
  error).
- Failures get logged to `/tmp/last-push.log`; they show up on the GitHub tab's
  commits list as "not pushed" dots (see Section 3).

No change to `finalizeBranch.sh` — the last commit also triggers a push via the
hook, so the explicit `git push` there becomes a no-op in the common case.
`finalizeBranch.sh` still calls `git push` as a belt-and-suspenders fallback.

## Section 2 — Files tab

### Data

A new WS event type:

```ts
type RunWsFilesMessage = {
  type: 'files';
  dirty: Array<{ path: string; status: 'M'|'A'|'D'|'R'|'U'; additions: number; deletions: number }>;
  head: { sha: string; subject: string } | null;
  headFiles: Array<{ path: string; status: 'M'|'A'|'D'|'R'; additions: number; deletions: number }>;
  branchBase: { base: string; ahead: number; behind: number } | null;
};
```

A `GitStateWatcher` in the orchestrator polls every 2s while the run's state is
`running` or `waiting` via `dockerExec`:

- `git status --porcelain=v1 -z` + `git diff --numstat HEAD` → `dirty`.
- `git log -1 --format='%H%n%s'` + `git show --numstat HEAD` → `head` +
  `headFiles`.
- `git rev-list --left-right --count origin/<default>...HEAD` → `branchBase`.

The `dockerExec()` helper is a small wrapper over `dockerode`'s
`container.exec({ Cmd, AttachStdout, AttachStderr })`, collecting stdout into a
buffer. Timeout: 5s per call. On timeout or exec error, the watcher skips that
tick (no event emitted); UI shows stale data from the previous tick.

Events flow through the existing `TypedBroadcaster`. The last emitted snapshot
is retained on the broadcaster so that a late-connecting client gets the
current state without waiting for the next poll.

On-demand diff:

```
GET /api/runs/:id/file-diff?path=<p>&ref=worktree|<sha>
→ { path, hunks: Array<{ header: string; lines: Array<{ kind: 'ctx'|'add'|'del'; text: string }> }> }
```

`ref=worktree` runs `git diff -- <p>` in the container.
`ref=<sha>` runs `git show <sha> -- <p>`. Responses capped at 256 KB per file;
oversized diffs return `{ truncated: true }`.

### UI

Replace `FilesTab.tsx` with a live view:

1. **Branch bar** — "branch `feat/…`" linked to the GitHub branch (if known),
   `N ahead / M behind` vs. default, and `pushed Ns ago` (latest push time,
   derived from whichever commit has the latest `origin/HEAD` sighting).
2. **Uncommitted (N)** — conditional section with one row per `dirty` entry.
   Status pill (`M/A/D/R/U`), path, `+add/-del`. Click to expand inline diff.
3. **Last commit** — conditional on `head` present. Header row with short SHA
   + subject, then one row per `headFiles` entry, same expand behavior.

- Expand state is kept in React state, keyed by path + ref, and clears on tab
  switch.
- Non-GitHub repo / `gh` unavailable → dirty and headFiles still render
  (they come from `docker exec git`, not `gh`). Only the branch-bar
  ahead/behind line degrades gracefully to "branch `feat/…`" alone.
- No watcher events once run is `succeeded`/`failed`/`cancelled` — in that
  case the UI fetches a one-shot `GET /api/runs/:id/files` that returns the
  same shape computed from `gh api` compare for finished runs (this endpoint
  is new; the old `/diff` endpoint is deleted).

### Inline diff rendering

A small `DiffBlock` component under `src/web/ui/data/`: no syntax highlighting,
monospace, `+`/`-` gutters tinted with existing success/failure tokens,
hunk header in the existing `text-faint` token. No new dependency. Large
diffs (>256 KB) render a placeholder with a link to GitHub blob.

### Count badge

Tab count = `dirty.length + headFiles.filter(h => !dirtyPaths.has(h.path)).length`.
Badge hidden when zero.

## Section 3 — GitHub tab

### Data

Extend `GET /api/runs/:id/github` to also return commits:

```ts
{
  pr: { number, url, title, state } | null,
  checks: { state, passed, failed, total, items: Array<{ name, conclusion, status, duration_ms }> } | null,
  commits: Array<{ sha, subject, committed_at, pushed: boolean }>,
  github_available: boolean,
}
```

- Drop the `run.state !== 'succeeded'` gate. The endpoint is useful during
  runs too, now that commits are pushed mid-run.
- `commits` from `gh api /repos/{owner}/{repo}/commits?sha=<branch>&per_page=20`
  filtered to commits unique vs. `default_branch`.
- `pushed` is true for every commit returned by `gh api` (that's the
  definition); to represent local-but-unpushed commits, the server compares
  the local tip (via `dockerExec git rev-parse HEAD`) to the `gh api` list
  when the container is alive and appends any missing commits with
  `pushed: false`.
- `checks.items` comes from the existing `prChecks()` call, with duration
  derived from `started_at`/`completed_at` if present.
- Cache TTL stays at 10s; the endpoint is now polled from the UI every 10s
  while the GitHub tab is visible.

New endpoint for the merge action:

```
POST /api/runs/:id/github/merge
Body: {}  (no parameters)
→ 200 { merged: true, sha: string }           on fast-path success
→ 409 { merged: false, reason: 'conflict' }    on fast-path conflict
→ 409 { merged: false, reason: 'agent-busy' }  if no container alive for slow path
→ 503 { error: 'gh-not-available' }
```

Behavior:

1. **Fast path**: call `gh api -X POST /repos/{owner}/{repo}/merges`
   with `base=<default_branch>`, `head=<branch_name>`, commit message
   `"Merge branch '<branch_name>' (FBI run #<id>)"`. On success, invalidate
   the run's github cache and return `200`.
2. **Fast-path conflict** (GitHub returns 409 with "merge conflict"): if
   `run.state` is `running` or `waiting` and the container is alive, inject a
   prompt into Claude via the existing stdin mechanism
   (`deps.orchestrator.writeStdin(runId, prompt)`):

       Merge branch <branch_name> into <default_branch>, resolve conflicts,
       and push <default_branch>. Use the following steps:
       1. git fetch origin
       2. git checkout <default_branch>
       3. git pull --ff-only origin <default_branch>
       4. git merge --no-ff <branch_name>
       5. If conflicts: resolve them, git add the resolved files, git commit.
       6. git push origin <default_branch>

   Return `200 { merged: false, agent: true }`; the UI shows a toast "merge
   delegated to agent" and the merge progress streams to the terminal.
   If no container is alive, return `409 agent-busy`.

No code-review button in v1. The same stdin-injection pattern will cover it
later.

### UI

Replace `GithubTab.tsx` with four stacked sections:

1. **Actions** (sticky top row) —
   - `[Create PR]` — enabled when `github_available && !pr && branch_name`.
     Existing handler kept.
   - `[Merge to main]` — enabled when
     `github_available && pr != null && (run.state === 'running' || run.state === 'waiting' || run.state === 'succeeded')`.
     (Succeeded runs can still fast-path merge — no container needed.)
   - `[View PR]` — external link, enabled when `pr != null`.
   - Right-aligned hint: "branch is N ahead of main" or "no PR yet — create one to merge".
2. **Pull request** — PR row only rendered when `pr != null`: number, title,
   state pill, external-link icon. If `pr == null`, replaced with a muted "no PR yet."
3. **CI** — per-check rows: colored dot (pass/fail/pending), name, duration.
   Header shows aggregate "N/M passed". Section hidden when `checks == null`.
4. **Commits on `<branch>`** — one row per commit: `pushed` dot (green) or
   `unpushed` dot (gray), short SHA, subject, relative time.

Empty state (non-GitHub repo / no `gh`): only commits show (from local git);
the rest of the tab is replaced with a one-line explanation.

## Section 4 — Meta tab

A new `MetaTab.tsx` replaces `PromptTab.tsx`. Content, top-to-bottom:

1. **Info** — project (linked), started (relative), branch (linked).
2. **Auto-resume** — conditional on `run.state === 'awaiting_resume'`; reuse
   the existing rendering from `RunSidePanel`.
3. **Usage** — reuse the existing `RunUsage` component as-is.
4. **Related** — siblings list, same rendering as the current side panel.
5. **Prompt** — `<details>` block, closed by default, summary "Prompt" with a
   chevron. Expanded state uses the existing `CodeBlock`.

`RunSidePanel.tsx` is deleted. `RunDetail.tsx` drops the `<aside>` wrapper and
its flex row; terminal + bottom pane now take full width.

## Section 5 — Vertical resize

Drag handle on the top edge of the bottom pane (a 6px bar above the tab row).
Cursor `ns-resize`, hover-brightened.

- Height state: `useBottomPaneHeight()` hook under `src/web/features/runs/`,
  backed by `localStorage['fbi.bottomPaneHeight']`. Global (not per-run).
- Default: `35vh`. Min: `120px`. Max: `calc(100vh - 200px)`.
- Height applies only when the drawer is open; collapsed drawer is unchanged.
- Implementation in `src/web/ui/primitives/Drawer.tsx`: accept an optional
  `height: number | 'auto'` and an `onHeightChange?` callback; add the drag
  handle inside the header row. The existing `max-h-[35vh]` body clamp in
  `RunDrawer` is replaced by an inline `height` style driven by the hook.
- Drag math: mousedown → capture initial height + cursor Y → listen for
  mousemove; `next = clamp(start + (startY - e.clientY), min, max)`. Commit
  to localStorage on mouseup (not on every mousemove).

## Tab order and defaults

- Order: `files · github · tunnel · meta`.
- Default tab: `files` on first open of a run; thereafter, last-opened tab is
  remembered per-session (in-memory, not persisted — this matches the current
  behavior).

## Testing strategy

- **Unit**
  - `dockerExec()` helper — success, timeout, exec error.
  - `GitStateWatcher` tick — parses `git status -z` output, produces correct
    `dirty` shape; handles empty repo.
  - `post-commit` hook — shell-level test in a temp git repo, asserts that
    the commit returns in `<100ms` even with a slow/fake remote.
  - Merge endpoint — mock `gh.mergeBranch()` success, mock conflict, mock
    not-a-github-repo.
  - `useBottomPaneHeight` — localStorage round-trip, min/max clamping.
- **Component**
  - `FilesTab` — dirty-only, head-only, both, empty, non-GitHub repo.
  - `GithubTab` — PR+CI+commits; no PR; no gh; commits with unpushed dot.
  - `MetaTab` — all groups present; auto-resume conditional; collapsed/
    expanded prompt.
  - `Drawer` resize — drag clamps to min/max; persists on mouseup.
- **Integration** (dev-only, behind `scripts/dev.sh`)
  - Start a run in a real container, observe `files` events, toggle files
    on disk inside the container, see them appear in the UI.
  - Trigger fast-path merge against a test repo.
  - Trigger conflict path; verify stdin prompt reaches Claude.

## Implementation notes

- **No unicode arrows anywhere in the UI.** External-link and chevron icons
  are inline SVGs, in the same style as the existing `Drawer.tsx` chevron.
  A new `ExternalLink` inline-SVG component lives at
  `src/web/ui/primitives/icons/ExternalLink.tsx` and is reused across tabs.
- **Poll cadence**: Files 2s, GitHub 10s. Both stop when tab is backgrounded
  (existing `visibilitychange` handler in `RunDetail` covers this).
- **Backwards compatibility**: The `/diff` endpoint is deleted; remove all
  callsites. The existing "Create PR" handler in `RunDetail` is moved into
  `GithubTab` (tab owns its actions now). The `PromptTab` export is removed.
- **Parent/child runs**: `parent_run_id INTEGER NULL` column on `runs`, with
  an index. Not used by this spec's features — reserved for follow-up runs
  (code review, post-succeed merge, etc.). Related section in Meta tab
  already displays siblings; after the migration, a follow-up can add a
  dedicated "sub-runs" rendering.
- **Docker exec privileges**: runs as whatever user `supervisor.sh` runs as
  (currently `agent`). Git operations already work at that user.
- **Merge commit author**: the Merge API call uses the repo owner's identity
  by default. No local git author config needed for fast path.

## Open follow-ups (out of scope)

- Code-review button (same stdin-injection architecture).
- Post-succeeded merge via a fresh ephemeral child container (cold-start cost).
- Merge-queue awareness (if user enables one on GitHub).
- Per-project `CLAUDE.md` instruction to the agent to commit frequently (so
  mid-run pushing is most effective).
