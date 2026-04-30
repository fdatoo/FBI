# Starting state for container launch

Add a `starting` run state to FBI. A run is `starting` from the moment a
container launch is requested (fresh run, manual Continue, or auto-resume)
until Claude inside the container shows its first sign of life — either
processing a prompt (`running`) or sitting idle at the TUI prompt
(`waiting`). The `starting` state is surfaced through the run pill and
hides/disables actions that would re-trigger a launch.

## Why

When the user clicks **Continue** on a `succeeded` / `failed` / `cancelled`
run today, three things go wrong:

1. The run pill stays on the previous terminal state (`succeeded`, etc.)
   for the multiple seconds it takes Docker to create and start the
   container — there's no UI feedback that the click was received.
2. The Continue button stays enabled, so a impatient user can click it
   repeatedly and queue up redundant launches.
3. By the time `markContinuing` flips the state to `running`, Claude
   inside `--resume` may not actually be doing work — it's restoring the
   session and going to the prompt — yet the UI claims `running`.

Adding a `starting` state makes the launch gap first-class, gives the UI
something accurate to show, and gives the API a state value it can use to
gate the Continue button.

## Scope

In scope:

- New `RunState` value: `starting`.
- A second `/fbi-state` sentinel (`prompted`) created by Claude Code's
  `UserPromptSubmit` hook, in addition to the existing `waiting` sentinel
  written by `Stop`.
- A combined runtime-state watcher that derives `starting` / `running` /
  `waiting` from the presence of the two sentinels, replacing
  `WaitingWatcher`.
- Orchestrator integration: `launch`, `continueRun`, auto-resume, and
  `recover` paths all funnel through the new state derivation.
- API: `POST /api/runs/:id/continue` flips state to `starting` synchronously
  before returning, so the UI updates without waiting on the container.
- Frontend: hide the Continue button while `starting`; add `starting` Pill
  tone with `animate-pulse`; treat `starting` like `running`/`waiting`
  in the runs filter (i.e., not a "terminal" state).

Out of scope:

- Changing how Claude is launched (still `claude < /tmp/prompt.txt` for
  fresh runs, `claude --resume <id>` for continue).
- Any change to terminal / stdin forwarding.
- New notification transports.
- Surfacing `starting` separately in the status bar count or sidebar dot
  (treat it as an alias of `running` for those summary views — it's a
  short-lived transitional state).

## State model

`RunState` (`src/shared/types.ts`) gains one value:

```ts
export type RunState =
  | 'queued'
  | 'starting'   // NEW
  | 'running'
  | 'waiting'
  | 'awaiting_resume'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
```

Semantics:

- **`starting`** — A container launch has been requested. Either the
  container is still being created/started, or it has started but Claude
  hasn't yet emitted a lifecycle signal. The run is not interactive yet.
- **`running`** — Claude is processing a prompt (sentinel `prompted`
  present, `waiting` absent).
- **`waiting`** — Claude is idle at the TUI prompt (sentinel `waiting`
  present).

`starting` is a transient state. It is not a terminal state and is never
the resting state of a run.

## Sentinel files

Two files in `/fbi-state` (an emptyDir-style mount per-run, already
present today):

| File | Created by | Removed by |
|------|------------|------------|
| `/fbi-state/waiting` | Claude Code `Stop` hook (existing) | Claude Code `UserPromptSubmit` hook (existing) |
| `/fbi-state/prompted` | Claude Code `UserPromptSubmit` hook (NEW) | Never (the file persists once Claude has accepted any prompt this container) |

The `prompted` file is "sticky" — once Claude has been prompted, we know
the binary is alive and beyond the launch gap, and there is no need to
reset it. It survives until the container exits (and the mount is torn
down with the container).

`buildClaudeSettingsJson` (`src/server/orchestrator/index.ts`) is updated:

```ts
hooks: {
  Stop: [
    { hooks: [{ type: 'command', command: 'touch /fbi-state/waiting', timeout: 5 }] },
  ],
  UserPromptSubmit: [
    { hooks: [{ type: 'command',
        command: 'rm -f /fbi-state/waiting && touch /fbi-state/prompted',
        timeout: 5 }] },
  ],
},
```

## Derived state from sentinels

| `waiting` file | `prompted` file | Derived state |
|---|---|---|
| absent | absent | `starting` |
| absent | present | `running` |
| present | absent | `waiting` |
| present | present | `waiting` |

`waiting` always wins over `prompted` because Claude is definitively idle
when `Stop` has fired more recently than the most recent
`UserPromptSubmit`.

## Runtime watcher

`WaitingWatcher` (`src/server/orchestrator/waitingWatcher.ts`) is
generalized to a `RuntimeStateWatcher` that polls both files (still 500ms,
same shape as `TitleWatcher`). It exposes a single callback whose argument
is the derived state — `'starting' | 'running' | 'waiting'`. The
orchestrator hooks this up the same way it currently hooks `WaitingWatcher`,
calling `runs.markStarting`, `runs.markRunning`, or `runs.markWaiting`
on transitions.

The watcher's initial `lastState` is `null` (unknown). The first poll
emits whatever it finds, so reattach to a running container correctly
syncs state on first tick. Subsequent polls only emit on change.

## Orchestrator transitions

State flow per launch path (only the launch-relevant transitions shown;
existing terminal transitions like `succeeded`/`failed` are unchanged):

**Fresh run (`launch`):**

```
queued
  -> starting   (orchestrator picks up the queued run; set just before
                 createContainerForRun so the run pill flips off `queued`
                 immediately)
  -> running    (UserPromptSubmit fires; Claude is processing initial prompt)
  -> waiting    (Stop fires; Claude is idle)
  -> running    (next UserPromptSubmit, etc.)
```

**Manual Continue (`continueRun`):**

```
succeeded | failed | cancelled
  -> starting   (set synchronously by the API endpoint, before the async
                 continueRun lifecycle even begins)
  -> waiting    (Stop fires after --resume restores the session and goes
                 to the prompt; no UserPromptSubmit happens for plain
                 --resume, so derived state goes directly absent/absent
                 -> waiting/absent)
```

**Auto-resume (rate-limit recovery via the resume scheduler):**

```
awaiting_resume
  -> starting   (set when the scheduler's resume task fires, before
                 container creation)
  -> running    (UserPromptSubmit fires — auto-resume re-pipes the prompt
                 path) — OR `waiting` if the resume happens to land at idle
```

**Reattach (orchestrator restart while a container is alive):**

```
(prior state, persisted)
  -> derived state from first sentinel poll
```

## DB layer

`src/server/db/runs.ts` gains:

- `markStartingForContinue(id, containerId | null): void` — replaces
  `markContinuing`. Sets `state='starting'`, `state_entered_at=now`,
  resets `resume_attempts=0`, clears `next_resume_at`, `finished_at`,
  `exit_code`, `error`. Source-state guard: `state IN
  ('failed','cancelled','succeeded')`. Called twice in the Continue
  path: first by the API endpoint with `containerId=null` (before any
  container exists), then by the orchestrator with the real container
  id after `createContainerForRun` returns. The `state_entered_at`
  column updates on each call so the Pill timer reflects the most
  recent transition.
- `markStartingForResume(id, containerId): void` — replaces
  `markResuming`. Sets `state='starting'`, `state_entered_at=now`,
  preserves `resume_attempts` (still incrementing as set by
  `markAwaitingResume`). No source-state guard (auto-resume scheduler
  is the sole caller).
- `markRunning(id): void` — sets `state='running'`,
  `state_entered_at=now`. Source-state guard: `state IN
  ('starting','waiting')`. This is the new transition called when the
  `prompted` sentinel appears (replaces the implicit running-state
  set that used to happen inside `markContinuing` / `markResuming`).
- `markWaiting(id)` — guard widens from `state='running'` to `state
  IN ('starting','running')` so a clean `starting → waiting` transition
  is permitted (Continue case where Claude `--resume` goes straight to
  idle without ever firing `UserPromptSubmit`).

## API endpoint

`POST /api/runs/:id/continue` (`src/server/api/runs.ts`):

```ts
// After eligibility passes:
deps.runs.markStarting(run.id, null);   // synchronous, before fire-and-forget
deps.publishState(run.id);              // broadcast over WS
void deps.continueRun(run.id).catch(...);
return reply.code(204).send();
```

This is the key change that makes the UI feedback instant — the state
flips before Docker is even called, so the WS message lands within
milliseconds of the click. `continueEligibility` is updated to also
reject runs already in `starting`, so a second click during the gap is
a clean 409.

## Frontend

`src/web/features/runs/RunHeader.tsx`:

- `canContinue` excludes `starting` (it already excluded `running`,
  `waiting`, `queued`, `awaiting_resume` via `canFollowUp`'s pattern).
  Continue button is hidden during `starting`.
- No spinner needed in the button — the Pill carries the loading
  affordance.

`src/web/ui/primitives/Pill.tsx`:

- Add `'starting'` tone, styled like `'run'` (subtle bg + accent border)
  with `animate-pulse`. Label: `"starting"`.

`src/web/pages/RunDetail.tsx`:

- The existing `subscribeState` flow already updates the run's `state`
  in place; no changes needed beyond making sure `'starting'` renders
  through the same path.

`src/web/components/runs/RunsList.tsx` and any sidebar dot logic:

- Treat `starting` as part of the "active" group alongside `running` /
  `waiting`. Sidebar dot color: same as `running`.

Status bar count (`src/web/.../StatusBar.tsx`):

- Treat `starting` as `running` for count purposes (out of scope to give
  it its own count — see Scope).

## Tests

- `src/server/orchestrator/waitingWatcher.test.ts` becomes
  `runtimeStateWatcher.test.ts`. Cover all four sentinel combinations,
  initial-poll-with-existing-files (reattach), and rapid transitions.
- `src/server/orchestrator/claudeSettings.test.ts` updated to assert the
  new compound `UserPromptSubmit` command and the new `prompted` file.
- `src/server/orchestrator/continueRun.flow.test.ts` updated to assert
  the synchronous `starting` transition before the async continueRun.
- `src/server/api/runs.test.ts` (or wherever the continue endpoint is
  tested) — assert state is `starting` immediately after the POST.
- `src/server/orchestrator/continueEligibility.test.ts` — assert
  `starting` is ineligible.
- `src/web/features/runs/RunHeader.test.tsx` — Continue button hidden
  when state is `starting`.
- `src/web/ui/primitives/Pill.test.tsx` — `starting` tone renders with
  `animate-pulse`.

## Migration / backwards compatibility

`RunState` is persisted as a string column. Adding a new value requires
no SQL migration. Existing rows are unaffected.

For an in-flight container started by an older binary: the `prompted`
file won't be created (the old hook config didn't write it). After
upgrade, the new watcher polls a container with no `prompted` file. If
the container is past launch (Claude already running), this would
mis-derive `starting`. To guard against this, `RuntimeStateWatcher`'s
first-poll behavior, combined with persisted DB state, defers to the
DB: if the persisted state is `running` or `waiting` and the watcher
would derive `starting`, the watcher emits the persisted state instead
on first poll. Subsequent polls trust the watcher.

## Risks

- **`UserPromptSubmit` hook timing on `--resume`**: If `claude --resume`
  fires `UserPromptSubmit` for a queued / replayed prompt at restore
  time, our continue path would briefly show `running` before `waiting`.
  This is acceptable — it's still progress past `starting`. Verified
  during implementation by running a Continue and watching states.
- **Hook command failure**: If `touch /fbi-state/prompted` fails (disk
  full, etc.), `starting` would persist forever. The existing `Stop`
  hook has the same risk and the project accepts it. Both hooks have a
  5-second timeout and run as the in-container user with write access
  to `/fbi-state`.
