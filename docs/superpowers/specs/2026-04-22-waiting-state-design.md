# Waiting-for-user-input state

Add a `waiting` run state to FBI. A run is `waiting` when Claude is idle at
its TUI input prompt; it returns to `running` the moment Claude starts
processing again. The state is surfaced in the status bar (count), project
sidebar (dot color), run pill, and notifications.

## Why

Today FBI only distinguishes "actively doing work" (`running`) from "blocked
on a rate limit" (`awaiting_resume`). In practice, Claude Code's TUI stays
alive at the input prompt after finishing a turn — the run is neither done
nor making progress, and the user has no signal that their agent is sitting
idle waiting for them. This feature makes that state first-class.

## Scope

In scope:
- New `RunState` value: `waiting`.
- New `WaitingMonitor` that detects the transition to/from `waiting` from
  container-local signals, parallel in shape to the existing `LimitMonitor`.
- Orchestrator integration in `launch`, `resume`, `continueRun`, `recover`,
  `cancel`.
- Web UI: new `attn` tone, status bar count, sidebar dot, run pill, runs
  filter, Design showcase entry.
- Notifications refactor: replace `useRunWatcher`'s polling with a WS-driven
  global state channel; add a "waiting" notification path.

Out of scope:
- Changing how Claude is launched (still `claude --dangerously-skip-permissions`
  with piped prompt; still `claude --resume …` on resume).
- Any change to the terminal / stdin forwarding path.
- CLI changes beyond recognizing the new state value.
- Per-project notification routing / alternate transports (email, Slack, etc.).

## State model

`RunState` (`src/shared/types.ts`) gains one value:

```ts
export type RunState =
  | 'queued'
  | 'running'
  | 'waiting'          // NEW
  | 'awaiting_resume'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
```

No DB migration. `runs.state` is `TEXT`; `idx_runs_state` continues to work.

Valid transitions (additions marked `NEW`):

```
queued ──▶ running ─┬─▶ succeeded
                    ├─▶ failed
                    ├─▶ cancelled
                    ├─▶ awaiting_resume ──▶ running  (auto-resume)
                    └─▶ waiting  ◀───────┐           NEW
                           │             │
                           └─▶ running ──┘           NEW (freely toggling)
waiting ──▶ awaiting_resume                          NEW (rate-limit wins)
waiting ──▶ cancelled                                NEW (user cancel)
waiting ──▶ succeeded | failed                       NEW (container exit while waiting)
```

**Guards (enforced in the repo):**
- `markWaiting(id)` is a no-op unless current state is `running`.
- `markRunningFromWaiting(id)` is a no-op unless current state is `waiting`.

These guards are the concurrency boundary: if a rate-limit detection and a
waiting detection race, the repo guard lets at most one win and the other
becomes a no-op. (A rate limit firing while `state='waiting'` still
transitions to `awaiting_resume` via `markAwaitingResume`, whose guard accepts
both `running` and `waiting`.)

## Detection: `WaitingMonitor`

New file: `src/server/orchestrator/waitingMonitor.ts`.

Mirrors `LimitMonitor`'s shape so the reader who knows one knows the other.

```ts
export interface WaitingMonitorOptions {
  mountDir: string;
  logBufferBytes?: number;   // default 16 KiB
  idleMs?: number;           // default 8_000
  warmupMs?: number;         // default 20_000
  checkMs?: number;          // default 2_000
  onEnter: () => void;
  onExit: () => void;
  now?: () => number;
}

export class WaitingMonitor {
  feedLog(chunk: Uint8Array): void;
  start(): void;
  stop(): void;
  checkNow(): void;
}
```

### Two-signal fusion for enter

A tick fires `onEnter` iff **all** of these hold:
1. `now - startedAt >= warmupMs`.
2. `now - lastActivityAt >= idleMs` (no new bytes written to any session
   `.jsonl` under `mountDir` for at least `idleMs`).
3. The ANSI-stripped tail of the rolling TTY buffer matches a TUI input-prompt
   pattern.

The prompt pattern is conservative and refined against real fixtures:

```ts
// Both patterns applied to stripAnsi(tail), then to its trailing window.
const WAITING_PROMPT_RES = [
  /[│|]\s*>\s*$/m,          // bordered "│ >" with nothing after
  /^\s*>\s*⠀?\s*$/m,   // plain "> " line
];
```

Shared helpers:
- `stripAnsi` is already exported from `src/server/orchestrator/resumeDetector.ts`;
  `WaitingMonitor` imports it.
- `sumJsonlSizes(root)` — extracted from `limitMonitor.ts` into a sibling
  module (e.g. `mountActivity.ts`) and imported by both monitors. No behavior
  change in `LimitMonitor`.

### Exit edge

After `onEnter` has fired, the tick loop watches `sumJsonlSizes(mountDir)` for
**growth**. As soon as it grows (Claude has written a jsonl event — i.e., a
turn is in flight), fire `onExit` and set `lastActivityAt = now`. The
subsequent `onEnter` gate is unchanged — it still requires `idleMs` of
silence — so the same idle threshold that governs initial entry also
prevents immediate re-entry after exit. No separate post-exit warmup is
needed.

This is symmetric with the enter signal: entering requires jsonl silence;
exiting requires jsonl activity. The TTY pattern is **not** consulted on
exit — any mount-dir write is sufficient evidence that Claude is working.

### Lifecycle

One `WaitingMonitor` per container, for the full duration of the container.
It is **not** torn down on toggle — the same instance fires `onEnter`/`onExit`
repeatedly (decision: freely toggling). Torn down in the same `finally` block
that tears down `LimitMonitor`.

### Thresholds

- `warmupMs: 20_000` — covers container boot + `git clone` + plugin install
  before jsonl writes begin. Shorter than `LimitMonitor`'s 60 s because we're
  not defending against a limit phrase that scrolled by early.
- `idleMs: 8_000` — long enough not to flap on 1–3 s gaps between sub-calls
  within a single turn; short enough that "waiting" feels live.
- `checkMs: 2_000` — tick cadence.

All tunable via options.

## Orchestrator integration

`src/server/orchestrator/index.ts`.

### Monitor construction

Add a sibling to `makeLimitMonitor`:

```ts
private makeWaitingMonitor(
  runId: number,
  attach: NodeJS.ReadWriteStream,
  onBytes: (chunk: Uint8Array) => void,
): WaitingMonitor {
  return new WaitingMonitor({
    mountDir: this.mountDirFor(runId),
    onEnter: () => {
      this.deps.runs.markWaiting(runId);
      this.publishState(runId);
      onBytes(Buffer.from('\n[fbi] waiting for user input\n'));
    },
    onExit: () => {
      this.deps.runs.markRunningFromWaiting(runId);
      this.publishState(runId);
      onBytes(Buffer.from('\n[fbi] user responded; resuming\n'));
    },
  });
}
```

The one-line markers in the run log are deliberate: the transcript tells the
full story including state changes, consistent with the existing
`[fbi] awaiting resume until …` marker.

### Wiring into existing flows

In `launch`, `resume` (the auto-resume reattach), and `continueRun`:
- Construct `waitingMonitor` next to `limitMonitor`.
- Extend the existing `attach.on('data')` handler to also call
  `waitingMonitor.feedLog(c)`.
- `await container.start()` → `waitingMonitor.start()` (after
  `limitMonitor.start()`).
- `finally { limitMonitor?.stop(); waitingMonitor?.stop(); }`.

### `recover()`

`recover` currently reattaches runs where `state='running'`. Extend the
selector to `listByState('running').concat(listByState('waiting'))` (or add a
`listByStates(['running','waiting'])` method — stylistic choice deferred to
the plan). On successful reattach, construct both monitors fresh; the
`waiting` state from the DB is a best-guess hint and will be re-derived on
the next tick.

### `cancel()`

Extend with a `waiting` branch that mirrors `running`:

```ts
if (run.state === 'running' || run.state === 'waiting') {
  await a.container.stop({ t: 10 }).catch(() => {});
  this.cancelled.add(runId);
  return;
}
```

The existing `awaitAndComplete` loop then closes the run as `cancelled` as
normal.

## WS payload

`RunWsStateMessage` shape is unchanged:

```ts
{ type: 'state', state: RunState, next_resume_at, resume_attempts, last_limit_reset_at }
```

Consumers get an extra legal value for `state`. TypeScript exhaustiveness
checks in web code will point to every `Record<RunState, …>` and `switch`
that needs updating.

## Web UI

### Tokens

`src/web/ui/tokens.css` gains a new semantic tone, `attn`, in both palettes:

```css
/* dark */
--attn: #fbbf24;
--attn-subtle: #2a1c07;

/* light */
--attn: #b45309;
--attn-subtle: #fffbeb;
```

Per the UI-system CLAUDE.md, the token is the only way to reference this
color; components use `text-attn`, `bg-attn`, `bg-attn-subtle`, `border-attn`.

### Primitives

- `StatusDot.tsx`: `DotTone` gains `'attn'`; `DOT['attn'] = 'bg-attn shadow-[0_0_6px_var(--attn)] animate-pulse'` (pulsing like `run`, since it's a live attention signal).
- `Pill.tsx`: `PillTone` gains `'attn'`; `TONES['attn'] = 'bg-attn-subtle text-attn border-attn animate-pulse'`.
- `Design.tsx`: add `attn` chip + dot to the showcase (required by UI-system rule 4).

### Run surfaces

- `RunRow.tsx` `TONE` map: `waiting: 'attn'`.
- `RunHeader.tsx` status chip: renders `attn` for `waiting`.
- `RunsFilter.tsx`: add `waiting` as a filter chip alongside existing state
  filters.

### Status bar

`src/web/App.tsx`. Alongside the existing `active` count, register a
`waiting` item that is only visible when `waiting > 0`:

```ts
const waiting = runs.filter(r => r.state === 'waiting').length;

useEffect(() => {
  if (waiting === 0) return;                   // registration toggled off at 0
  return statusRegistry.register({
    id: 'waiting',
    side: 'left',
    order: 2,
    render: () => <>{waiting} <span className="text-attn">waiting</span></>,
  });
}, [waiting]);
```

Gating by effect dependency rather than rendering `null` keeps the bar's
flex-gap spacing correct when the item is absent.

### Project sidebar dot

`src/web/features/projects/ProjectList.tsx` + `src/web/App.tsx:30-35`:

```tsx
const hasWaiting = runs.some(r => r.project_id === p.id && r.state === 'waiting');
const hasRunning = runs.some(r => r.project_id === p.id && r.state === 'running');

{hasWaiting ? <StatusDot tone="attn" aria-label="waiting for input" />
 : hasRunning ? <StatusDot tone="run" aria-label="running" />
 : null}
```

Precedence: `waiting` beats `running` — attention beats ambient activity.
`projectRows` in `App.tsx` gains a `hasWaiting` field and threads it through
`AppShell` → `Sidebar` → `ProjectList` (prop additions only; no new
components).

## Notifications refactor

Replace `useRunWatcher`'s 5 s polling with a WS-driven global state channel.
This is a mild refactor of existing code, scoped to `useRunWatcher.ts`,
`notifications.ts`, and two files on the server.

### Server: global state channel

`src/server/logs/registry.ts`: add a single globally-shared broadcaster.

```ts
getGlobalStates(): StateBus;        // returns the singleton bus
```

`src/server/api/ws.ts`: add a route, e.g. `/api/ws/states`. On connect, pipe
global-states messages to the socket. Payload:

```ts
{ type: 'state', run_id: number, project_id: number, state: RunState,
  next_resume_at: number | null, resume_attempts: number,
  last_limit_reset_at: number | null }
```

`Orchestrator.publishState(runId)`: also publishes to
`getGlobalStates()`. The per-run channel (`getOrCreateState`) is kept
unchanged — the run detail page continues to use it.

### Web: WS subscription

`src/web/hooks/useRunWatcher.ts` is refactored:

```ts
export function useRunWatcher(enabled: boolean) {
  useEffect(() => {
    const dispose = enabled ? installFocusReset() : () => {};
    const runs = new Map<number, { state: RunState; project_id: number }>();
    let seeding = true;
    const seed = async () => {
      const all = await api.listRuns();
      for (const r of all) runs.set(r.id, { state: r.state, project_id: r.project_id });
      _publishCountsFromMap(runs);
      seeding = false;
    };
    const ws = new WebSocket(statesUrl());
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as GlobalStateMsg;
      const prev = runs.get(msg.run_id)?.state;
      runs.set(msg.run_id, { state: msg.state, project_id: msg.project_id });
      _publishCountsFromMap(runs);
      if (seeding || !enabled) return;
      if (prev === 'running' && msg.state === 'waiting')   void notifyWaiting(msg.run_id);
      if (prev === 'waiting' && msg.state === 'running')   clearWaitingBadge(msg.run_id);
      if (isTerminal(msg.state))                            void notifyCompleteById(msg.run_id);
    };
    ws.onclose = () => { /* reconnect: call seed() again, seeding=true */ };
    void seed();
    return () => { ws.close(); dispose(); };
  }, [enabled]);
}
```

The existing exports `_publishRunning` / `useRunningCounts` keep the same
shape — their source changes from polling to WS. `_publishCountsFromMap`
computes per-project counts of `running` **and** `waiting` so the sidebar can
distinguish them.

### Notifications API

`src/web/lib/notifications.ts`:

```ts
export function notifyWaiting(run: { id: number; project_name?: string }): Promise<void>;
export function clearWaitingBadge(runId: number): void;
```

`notifyWaiting`:
- `Notification(label, { body, tag: `fbi-run-${id}-waiting` })` — `tag`
  coalesces repeat notifications for the same run per OS conventions.
- Label: `⧖ Run #N` (body: `Waiting for input · <project_name>`).
- If the tab is hidden, increments the combined `unread` counter and updates
  the title badge.
- Repaints the favicon with the `--attn` color.

Title-badge format: **combined** — `(N) FBI`, where `N = unreadComplete +
unreadWaiting`. Per the decision, we do not split the counter in the title.

`clearWaitingBadge`: if the run was currently contributing to `unreadWaiting`
because the tab was hidden at the transition, decrement; otherwise no-op.
Leaves the OS-level Notification alone (the user's OS handles dismissal).

`installFocusReset` keeps its existing semantics — on visibilitychange to
`visible`, zero both unread counters and reset the favicon.

### Seed-on-reconnect

A freshly-opened WS misses transitions during the disconnect window. On
every connect (initial or reconnect) we:
1. Set `seeding = true`.
2. Call `GET /api/runs` and seed the `runs` map.
3. Publish updated counts (silently).
4. Set `seeding = false`.

Transitions observed during step 2 flow through the normal event path but
skip notification dispatch because `seeding` is true. This prevents a
reconnect from spamming phantom `waiting`/terminal notifications.

## Testing

All tests follow FBI conventions (Vitest, colocated, `__fixtures__/` for TTY
captures).

### `waitingMonitor.test.ts`

- Fires `onEnter` once after warmup + idle + prompt pattern all hold; never
  before warmup.
- Does not fire when only one of {idle, prompt} holds.
- Fires `onExit` on first `sumJsonlSizes` growth after entering.
- Fires `onEnter` → `onExit` → `onEnter` within a single lifetime.
- `feedLog` tolerates ANSI (redraws, cursor moves, SGR terminators) — the
  ANSI-stripped tail still matches the prompt pattern.

### TTY fixtures

`src/server/orchestrator/__fixtures__/`:
- `claude-tui-prompt.bin` — raw TTY bytes captured while Claude is at the
  input prompt. Assertion: `containsWaitingPrompt(stripAnsi(bin))` is `true`.
- `claude-tui-midturn.bin` — bytes during a mid-turn redraw. Assertion:
  `containsWaitingPrompt(stripAnsi(bin))` is `false`.

These fixtures are the place where the regex set is validated against real
output. The regex set in this spec is provisional and will be tightened when
the fixtures land.

### Repo: `runs.test.ts`

- `markWaiting` is a no-op from `queued`, `awaiting_resume`, `succeeded`,
  `failed`, `cancelled`.
- `markRunningFromWaiting` is a no-op from any non-`waiting` state.
- Both are idempotent (repeat calls are no-ops).

### Orchestrator integration

- `autoResume.flow.test.ts`-style flow test: if a rate-limit fires while
  `state='waiting'`, transition is `waiting → awaiting_resume` (repo guard on
  `markAwaitingResume` accepts `waiting`).
- `recover()` with a DB run in state `waiting`: monitor re-constructed; next
  tick re-derives state.

### Web

- `RunRow.tsx`: renders `attn` pill when `state === 'waiting'`.
- `ProjectList.tsx`: dot precedence — `hasWaiting` beats `hasRunning`.
- Status bar: `waiting` item visible iff `waiting > 0`.
- `useRunWatcher` (new WS-driven tests):
  - Seeds from REST without firing notifications.
  - `'running' → 'waiting'` triggers `notifyWaiting`.
  - `'waiting' → 'running'` does not notify.
  - Terminal still triggers `notifyComplete`.
  - WS reconnect re-seeds cleanly without phantom notifications.

### Manual UI check

Per FBI convention (main CLAUDE.md: "start the dev server and use the feature
in a browser"), run `scripts/dev.sh` and drive a real run:

- Sidebar dot turns amber on waiting, blue on running, absent when idle.
- Status-bar `N waiting` appears when present, hides at 0.
- Typing in the run terminal flips the state back to `running` within a few
  seconds.
- OS notification fires on `running → waiting` and on terminal states.
- Title badge increments combined.

## Files touched (summary)

Server:
- `src/shared/types.ts` — add `'waiting'` to `RunState`.
- `src/server/db/runs.ts` — `markWaiting`, `markRunningFromWaiting`, accept
  `'waiting'` in `markAwaitingResume` guard.
- `src/server/orchestrator/waitingMonitor.ts` — new.
- `src/server/orchestrator/mountActivity.ts` — new (extracted from
  `limitMonitor.ts`).
- `src/server/orchestrator/limitMonitor.ts` — use shared `sumJsonlSizes`.
- `src/server/orchestrator/index.ts` — wire `WaitingMonitor` into
  `launch`, `resume`, `continueRun`, extend `cancel`, extend `recover`,
  publish to global states bus.
- `src/server/logs/registry.ts` — `getGlobalStates()`.
- `src/server/api/ws.ts` — `/api/ws/states` route.

Web:
- `src/web/ui/tokens.css` — `--attn`, `--attn-subtle` in both palettes.
- `src/web/ui/primitives/StatusDot.tsx` — `'attn'` tone.
- `src/web/ui/primitives/Pill.tsx` — `'attn'` tone.
- `src/web/pages/Design.tsx` — `attn` chip + dot in showcase.
- `src/web/features/runs/RunRow.tsx` — `waiting: 'attn'`.
- `src/web/features/runs/RunHeader.tsx` — handle `'waiting'`.
- `src/web/features/runs/RunsFilter.tsx` — add `waiting` filter chip.
- `src/web/features/projects/ProjectList.tsx` — `hasWaiting` + dot precedence.
- `src/web/App.tsx` — `waiting` count; `hasWaiting` in `projectRows`; status
  registration gated on `waiting > 0`.
- `src/web/hooks/useRunWatcher.ts` — WS subscription, seed, reconnect.
- `src/web/lib/notifications.ts` — `notifyWaiting`, `clearWaitingBadge`,
  combined counter update.

Tests:
- `src/server/orchestrator/waitingMonitor.test.ts` — new.
- `src/server/orchestrator/__fixtures__/claude-tui-prompt.bin` — new.
- `src/server/orchestrator/__fixtures__/claude-tui-midturn.bin` — new.
- `src/server/db/runs.test.ts` — extend.
- Web tests per above list.
