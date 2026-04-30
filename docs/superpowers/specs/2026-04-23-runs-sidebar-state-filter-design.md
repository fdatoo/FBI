# Runs sidebar — state filter, state grouping, in-state timestamp

Status: Design
Date: 2026-04-23
Owner: UI / Runs feature

## Summary

Three related improvements to the runs sidebar:

1. **Filter by state** — a compact popover (triggered by an icon-only funnel button next to the search input) lets the user multi-select which run states appear.
2. **Optional group-by-state** — a toggle at the bottom of that same popover collapses the list into labeled sections, one per state, sorted chronologically within each section.
3. **In-state timestamp** — the timestamp shown on each row becomes "time since the run entered its current state" (for terminal states, this equals time since completion, which remains useful).

Default behavior keeps a flat chronological list but subtly pins `running` / `waiting` / `awaiting_resume` runs above the rest ("active pinned"). Filter and group-by selections persist across reloads via `localStorage`.

## Motivation

The sidebar currently mixes all runs chronologically with no way to filter or focus. In projects with many runs, finding e.g. "everything that's currently waiting" requires scrolling. The `created_at` timestamp is less useful than "how long has this been in its current state?" when triaging active work; for completed runs, the new timestamp happens to coincide with "time since completion," which is also the more useful framing.

## Scope

In scope:

- DB column `state_entered_at` on `runs`, updated on every state transition.
- WS state broadcast carries `state_entered_at`.
- New state-filter popover UI.
- Group-by-state toggle inside the popover.
- Active-pinned default ordering.
- `localStorage` persistence for filter + grouping selections.
- Change `RunRow` to use `state_entered_at` for its timestamp.

Out of scope:

- Re-sorting by any field other than `created_at` within a group.
- Filtering by project, branch, author, or any non-state attribute (the existing text filter covers prompt/branch/id and is untouched).
- Persisting across devices / accounts.
- Server-side filter push-down (runs list is already in memory on the client).

## User experience

### Default view (no filter, grouping off)

One flat list sorted `created_at DESC`, with one subtle exception: runs whose state is `running`, `waiting`, or `awaiting_resume` are hoisted above the rest. A single hairline divider labeled `Active · N` (tone `text-text-faint`, `text-[11px]`, `uppercase tracking-[0.08em]`) sits above the pinned block. Nothing sits above the unpinned block. If there are no active runs, no divider renders at all.

### Filter control

The header area (`RunsFilter`) becomes a row: the existing text input on the left, a new icon-only funnel button (`StateFilterButton`) on the right. The button:

- Uses the existing `IconButton` primitive sized to match the input height.
- Shows no badge when `filter.size === 0` (i.e. all states shown).
- Shows an accent-colored numeric badge at the top-right corner when `filter.size > 0`.
- Applies an "active" variant (accent border, `bg-accent-subtle` interior) when `filter.size > 0`, matching the chip style used elsewhere.

Click → anchored popover opens below the button (right-aligned). Outside-click or `Escape` closes it.

### Popover contents

```
┌──────────────────────────────┐
│ FILTER STATES          clear │  (header; "clear" shown only when filter.size > 0)
├──────────────────────────────┤
│ [✓] ● running          3     │  (● = tone dot; number = live count of that
│ [✓] ● waiting          2     │   state among runs currently visible to the
│ [ ] ● awaiting         0     │   search-text filter, i.e. the popover counts
│ [ ] ● queued           2     │   reflect what the user would see if they
│ [ ] ● succeeded       30     │   picked that state only)
│ [ ] ● failed           4     │
│ [ ] ● cancelled        1     │
├──────────────────────────────┤
│ [ ] Group by state           │
└──────────────────────────────┘
```

- Checkboxes use the existing `Checkbox` primitive.
- State rows are `font-mono text-[12px]`, with a tone dot (`--run`, `--wait`, `--attn`, `--warn`, `--ok`, `--fail`, `--neutral` — reuse the `Pill` tone mapping).
- An empty filter set (`filter.size === 0`) means "all states" — identical to checking every box. `clear` resets to empty.
- Checking or unchecking a row updates the list live; no "apply" button.
- `Group by state` is a single boolean; its checkbox uses the same primitive.

### Grouped view

When `groupByState === true`, render one section per non-empty state. Section order is fixed:

1. `running`
2. `waiting`
3. `awaiting_resume`
4. `queued`
5. `succeeded`
6. `failed`
7. `cancelled`

Each section has a label row styled like the default-mode `Active` divider: `{state} · N`, tone-matched via text color (`text-run`, `text-attn`, etc. — add missing token classes if not yet in Tailwind config). Within a section, runs are sorted `created_at DESC`. When grouping is on, the active-pinned hoisting is not applied (the grouping already sorts active states to the top).

### Row timestamp

`RunRow` displays `TimestampRelative(iso = new Date(run.state_entered_at).toISOString())`. The tooltip shows the absolute datetime plus the state it refers to, e.g. `entered running at 2026-04-23 14:32:10`.

Rationale: for non-terminal states, this answers "how long has this been stuck?" For terminal states (`succeeded` / `failed` / `cancelled`), `state_entered_at === finished_at` by construction, so the timestamp reads as "time since completion," which is the standard useful framing.

### Persistence

`localStorage` key `fbi.runs.view.v1` stores:

```json
{ "filter": ["running", "waiting"], "groupByState": false }
```

- Missing key, invalid JSON, or unknown state values fall back to defaults (`filter: []`, `groupByState: false`).
- Write is debounced-simple: set on every change (it's tiny). No schema migration mechanism needed at v1.

## Data model

### Schema change

Add one column to `runs`:

```sql
ALTER TABLE runs ADD COLUMN state_entered_at INTEGER NOT NULL DEFAULT 0;
```

Performed inline in `src/server/db/index.ts`' `migrate()` alongside the existing `ALTER TABLE runs` blocks. Immediately after add, backfill:

```sql
UPDATE runs
   SET state_entered_at = COALESCE(finished_at, started_at, created_at)
 WHERE state_entered_at = 0;
```

This is best-effort — it won't be perfect for runs that went through `waiting` or `awaiting_resume` in the past, but those timestamps are unrecoverable and the value only needs to be "approximately right" for pre-existing rows. New transitions are exact.

### Type change

`src/shared/types.ts`:

```ts
export interface Run {
  // ... existing fields ...
  state_entered_at: number;  // ms since epoch; updated on every state transition
}
```

### WS payload

The existing `state` WS frame (both per-run and `/api/ws/states`) gains the field:

```ts
// per-run channel (src/shared/types.ts line ~92):
{ type: 'state', state: RunState, state_entered_at: number }

// global /api/ws/states (src/shared/types.ts line ~180):
{ type: 'state', run_id: number, state: RunState, state_entered_at: number }
```

The client reducer uses the incoming `state_entered_at` directly, overwriting the cached value for that run.

### Repo changes

Every state-mutating method in `RunsRepo` (`src/server/db/runs.ts`) sets `state_entered_at` to the same `Date.now()` it already uses (or computes fresh if it didn't need one):

- `create` — `state_entered_at = now` at insert.
- `markStarted` — already sets `started_at`; also set `state_entered_at`.
- `markWaiting` — add `state_entered_at = Date.now()`.
- `markRunningFromWaiting` — add `state_entered_at = Date.now()`.
- `markAwaitingResume` — add `state_entered_at = Date.now()`.
- `markResuming` — set `state_entered_at = Date.now()` (do **not** `COALESCE`; this is a genuine transition back to running).
- `markContinuing` — set `state_entered_at = Date.now()`.
- `finish` (terminal) — set `state_entered_at = Date.now()` (equal to `finished_at`).

## Client architecture

### New hook

`src/web/features/runs/useRunsView.ts`:

```ts
type RunsViewState = { filter: Set<RunState>; groupByState: boolean };

export interface RunsView extends RunsViewState {
  toggleState(s: RunState): void;
  clearFilter(): void;
  setGroupByState(v: boolean): void;
  apply(runs: readonly Run[]): RunsViewResult;
}

export type RunsViewResult =
  | { mode: 'flat'; active: readonly Run[]; rest: readonly Run[] }
  | { mode: 'grouped'; groups: readonly { state: RunState; runs: readonly Run[] }[] };
```

- Reads initial state from `localStorage` with defaults on any failure.
- `toggleState` / `clearFilter` / `setGroupByState` each persist to `localStorage`.
- `apply`:
  1. Drop runs whose state is not in the filter set (skip step if `filter.size === 0`).
  2. Sort by `created_at DESC`.
  3. If `groupByState` → bucket by state in the fixed section order; emit non-empty buckets; return `{ mode: 'grouped', groups }`.
  4. Otherwise → split into `active` (`running` | `waiting` | `awaiting_resume`) and `rest`, preserving order within each; return `{ mode: 'flat', active, rest }`.

### Component changes

#### `RunsFilter.tsx`

Becomes the row container. Exposes both the search input and the new filter button. Accepts the `useRunsView()` handles in props (keeps the hook owned by `RunsList` so both it and the filter share view state).

```tsx
<div className="p-2 border-b border-border bg-surface flex items-center gap-2">
  <Input ... />
  <StateFilterButton view={view} counts={countsByState} />
</div>
```

#### `StateFilterButton.tsx` (new, under `src/web/features/runs/`)

- Renders an `IconButton` with a funnel icon (use `lucide-react`'s `ListFilter` if the dep is present — check during plan; fall back to a small inline SVG matching the design token palette if not).
- Manages its own open/closed state with outside-click + `Escape` close (mirror the pattern used by `primitives/Menu.tsx`).
- Popover body renders a `Checkbox` per state with tone dot + label + count, then a divider, then the `Group by state` `Checkbox`.
- Header shows `FILTER STATES` label and a `clear` text button (only when `view.filter.size > 0`).

#### `RunsList.tsx`

- Calls `useRunsView()` at the top.
- Computes counts per state from the `runs` prop (after applying the existing text filter) for the popover.
- Applies `view.apply(visible)` → if `mode === 'flat'`, render with optional `Active · N` divider above the pinned block; if `mode === 'grouped'`, render a labeled section per group.
- Keyboard j/k navigation still walks the visible order, in whichever mode is active.

#### `RunRow.tsx`

One-line change: pass `run.state_entered_at` (converted to ISO) into `TimestampRelative`. Update the tooltip text to include the state name.

### Popover primitive question

`src/web/ui/primitives/Menu.tsx` already implements an anchored popover with outside-click / Escape. Options during implementation:

- **Reuse the pattern directly** in `StateFilterButton` (copy the open/close hooks, different body). Zero new primitives, fastest path.
- **Generalize `Menu`** into a `Popover` primitive that accepts arbitrary `children` for the popover body; refactor `Menu` to use it. Cleaner long-term; requires a `/design` showcase entry per the UI rules.

Recommendation: pick the reuse-pattern approach unless the implementation naturally yields a clean `Popover` primitive. If it does, add it to `/design`. This is a judgment call for the plan phase; spec does not mandate.

## Tokens / design-system

- All color / spacing / radius / border tokens via Tailwind classes that resolve to existing tokens (per `src/web/ui/CLAUDE.md`).
- Tone dots in the popover reuse the existing `Pill` tone mapping (`--run`, `--wait`, `--attn`, `--warn`, `--ok`, `--fail`, `--neutral`).
- If any state-tone text color class (e.g. `text-attn`, `text-warn`) isn't currently in the Tailwind config for use in section labels, add it there — not inline.
- Nothing new in `tokens.css` — no new tokens needed; the palette already covers this work.

## Testing

### Server

- `src/server/db/runs.test.ts` (extend):
  - `state_entered_at` is set on `create`.
  - `state_entered_at` advances on each transition through `running → waiting → running → succeeded`.
  - `state_entered_at` values are monotonic within a single run.
- `src/server/db/index.test.ts` (if it covers migrations): verify backfill sets `state_entered_at` to `COALESCE(finished_at, started_at, created_at)` for pre-existing rows.

### Client

- `useRunsView.test.ts` (new):
  - Defaults when `localStorage` is empty.
  - Persists and rehydrates filter + groupByState.
  - Invalid stored JSON falls back to defaults.
  - Unknown state values in stored filter are dropped.
  - `apply(...)` flat-mode active pinning with mixed states.
  - `apply(...)` grouped-mode section order + within-section `created_at DESC` sort.
  - Empty sections omitted in grouped mode.
- `StateFilterButton.test.tsx` (new):
  - Button renders with badge only when `filter.size > 0`.
  - Click toggles popover open/closed; outside-click and `Escape` close.
  - Toggling a state checkbox calls `toggleState`.
  - `clear` calls `clearFilter` and is hidden when filter is empty.
  - `Group by state` checkbox toggles the hook.
- `RunRow.test.tsx` (update): assert timestamp uses `state_entered_at` and tooltip includes the state name.
- `RunsList.test.tsx` (new or extend): verify flat-mode active pinning divider renders; verify grouped-mode section labels render in the fixed order; verify j/k navigation honors the visible order.

### Manual

Per the UI workflow (`scripts/dev.sh` + Playwright MCP):

- Default view: confirm `Active · N` divider appears only when active runs exist.
- Open filter popover, select `running`; confirm list filters and badge shows `1`.
- Toggle `Group by state`; confirm sections render in fixed order, label row styling correct.
- Reload; confirm filter + grouping state persists.
- Start a run and let it finish; confirm the row timestamp behaves (running → finished transition updates `state_entered_at` via WS).

## Migration / rollout

- Schema migration runs at server start via the existing `migrate()` path; backfill is idempotent.
- No breaking API change: the WS payload gains a field; clients that ignore it continue to work. Old UI builds keep rendering (they'll just use `created_at` until reloaded).
- No feature flag needed. Ship the whole surface at once.

## Risks and open questions

- **Counts shown in the popover** reflect the text-filtered `runs`, not the whole project. This is deliberate (so the counts match the list the user is about to choose from), but is a choice worth surfacing at review — the alternative is "always the full counts" which some users may expect.
- **`markResuming` previously preserved `started_at` via `COALESCE`.** This spec treats the transition as a fresh "enter running" for `state_entered_at` purposes. That is intentional (the state did just change), but it means "time in running" resets on each resume, even though `started_at` doesn't. If product wants "total time running ever," that's a separate computed field, out of scope.
- **Badge + active-variant styling overlap** on the trigger button: keep the styling change subtle — single-color accent border, no glow — so the badge is legible and the button doesn't scream. The mockup's version is the target.
- **`lucide-react` dependency** — if the project doesn't already use it, fall back to an inline SVG. Plan phase checks.
