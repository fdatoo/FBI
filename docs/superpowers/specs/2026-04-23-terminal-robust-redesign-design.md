> **Superseded by [2026-04-26-terminal-rust-rewrite-design.md](2026-04-26-terminal-rust-rewrite-design.md).**
> The redesign in this doc has been replaced by a Rust-based server-side
> virtual terminal exposed to the BEAM via Rustler NIF. See the newer
> spec for the architecture that actually shipped.

# Terminal Robust Redesign

## Problem

The terminal has now been through three fix passes (`2026-04-22-terminal-robustness-design.md`, `2026-04-23-terminal-hardening-design.md`, and the commits that merged them). Five user-observable symptoms are still present, and the most recent pass made some of them worse:

- **B. "Load full history" breaks input.** Clicking "Resume live" leaves the live xterm unfocused; typing goes nowhere until the user clicks.
- **C. Refocus fast-forward.** Unfocusing the tab for 60 s and returning replays every intermediate frame at 60 Hz before landing on the current screen.
- **D. Cursor disappears.** Triggered specifically by tab switch, refocus, resize, Continue, or scrolling. A page refresh restores it (fresh WS → fresh snapshot captures whatever cell Claude last drew as its cursor).
- **E. Live scrollback is useless.** Every snapshot wipes it, and the per-tab viewport is too small to look back in.
- **F. Resize causes flicker and wrong-wrap.** The 200 ms "wait for TUI redraw, re-serialize, re-send snapshot" path on the server interacts badly with client-side fit debouncing.

Each symptom has a specific cause, but they share one shape: **the client keeps resetting the xterm in response to events that do not require a reset**. Every reset catches Claude Code's render cycle mid-frame (losing the cursor cell), restarts dim/snapshot handshakes (flickering, dropping bytes), or drains a rAF-paced queue at 60 Hz on tab return (fast-forward).

Each previous fix pass added more compensating logic — focus/blur resync, dim-mismatch drops, 200 ms resize re-send, `ready` gates — rather than removing the reset-heavy pattern. The result is a 478-line `Terminal.tsx` with three interleaved effects, four refs shared across them, and a growing catalogue of edge cases whose interactions are the next bug.

## Solution

Stop issuing mid-session resets. Collapse the resync protocol to: **one snapshot per WebSocket connection, ever**. If anything goes wrong, the client reconnects the WebSocket; a fresh WS gets a fresh snapshot. Everything else — focus, blur, resize, Continue, scroll — becomes a no-op at the synchronization layer.

To make this possible without dim races, the client sends its terminal dimensions first (`{type:'hello', cols, rows}`). The server defers the snapshot until it has client dims, then sends exactly one snapshot at those dims. The pre-existing "buffer broadcaster bytes during serialize" pattern still applies, so the snapshot is self-consistent and no live bytes are lost.

To make the client side maintainable, the state and lifecycle logic moves into a plain-TS `TerminalController` class. React owns only the xterm instance and the JSX; the controller owns the shell, the write path, and the live/history state machine. The controller is unit-testable without a browser.

### Why not alternatives

- **Surgical subtraction only** (delete the rAF pump, delete focus/blur resync, delete resize re-send; leave `Terminal.tsx`'s effect structure intact). Ships faster but leaves us with the same 478-line file of interleaved effects and refs — the substrate that turned three previous fix passes into each other's bugs. The *next* fix will still be a walk on a minefield.
- **Server-push rendered frames** (server renders at 30 fps, sends cell diffs, client just paints). Throws away working server-side `ScreenState` + `SerializeAddon` code to replace it with custom framework code; doesn't address robustness better than the controller extraction; large novel surface area.
- **Per-chunk sequence numbers to fix the resync race**. Addresses only the race, not the reset-heavy pattern; lands us back at a more complex protocol without fixing cursor loss, fast-forward, or resize flicker.

## Architecture

### New: `TerminalController` (client)

`src/web/lib/terminalController.ts`. A plain TypeScript class that owns the `ShellHandle`, the snapshot/bytes plumbing, and the live/history mode switch. Constructed with a `runId` and the already-created `Xterm` instance; disposed when the React component unmounts.

```
class TerminalController {
  constructor(runId: number, term: Xterm)

  setInteractive(on: boolean): void  // attach/detach term.onData -> shell.send

  resize(cols: number, rows: number): void  // sends shell.resize only

  enterHistory(host: HTMLElement): Promise<void>
                                    // fetches /api/runs/:id/transcript,
                                    // creates a second Xterm on `host`,
                                    // writes the transcript into it, and
                                    // leaves the live subscription intact

  resumeLive(): void                 // disposes the history Xterm and
                                    // calls term.focus() on the live one

  dispose(): void                    // releaseShell, unsubscribe, stop
                                    // forwarding bytes, dispose history Xterm
                                    // if present
}
```

Internal behavior:

- On construction: `acquireShell(runId)`, subscribe to `onBytes` (writes straight to `term` — no rAF queue), `onSnapshot` (calls `term.reset()` then `term.write(ansi)`), and typed events (forwards to existing `usageBus` publishers: `publishUsage`, `publishState`, `publishTitle`, `publishFiles`).
- On WS open: send `{type:'hello', cols: term.cols, rows: term.rows}`. This is the *only* thing the controller sends before a snapshot arrives. The subscription is via `ShellHandle.onOpen(cb)` (see *Interface changes* — replaces the previous `onOpenOrNow`).
- State: a single enum `{live, history}`. No `connecting`, no `ready`, no `stale`, no dim-mismatch drop.

### Modified: `Terminal.tsx` (client)

Shrinks from 478 lines to roughly 130. The React component owns:

1. One mount effect keyed on `[runId]`: creates the `Xterm`, creates the `TerminalController(runId, term)`, attaches a `ResizeObserver` and window-resize listener (both call `controller.resize(cols, rows)` after `fit.fit()`), disposes both on unmount.
2. One effect keyed on `[interactive]`: calls `controller.setInteractive(interactive)`. Nothing else.
3. JSX: the live host div, the optional history host div, the "Load full history" / "Resume live" buttons (which call `controller.enterHistory(historyHostRef.current)` / `controller.resumeLive()`), and the unchanged `<TraceBadge>` rendering.

Public props (`runId: number, interactive: boolean`) are unchanged. `RunTerminal.tsx` is not touched.

### Modified: WebSocket protocol

Client → server gains one frame:

```
{type: 'hello', cols: number, rows: number}
```

Server-side `ws.ts` gains a `pendingHello` promise that resolves on hello receipt or after a 1500 ms timeout (falls back to default 120×40). The snapshot-build path awaits `pendingHello` before calling `ScreenState.serialize()`. On hello receipt, the server also calls `orchestrator.resize` to apply the dims to the PTY (so the TUI emits its redraw at the right size) and `ScreenState.resize` to match.

Client → server `resync` is removed. Server handles for `resync` are deleted. `shellRegistry.requestResync` and `ShellHandle.sendResync` are deleted.

### Modified: `ws.ts` (server) resize path

The `resize` branch forwards to `orchestrator.resize` and `ScreenState.resize`, and returns. The 200 ms wait and snapshot re-send are deleted. Claude's SIGWINCH response reaches the client via the live byte stream.

### Modified: snapshot build awaits parser drain

The snapshot builder in `ws.ts` awaits pending writes on the `ScreenState`'s headless xterm before calling `serialize()`. `makeOnBytes` remains fire-and-forget on the hot path (it's only the pre-serialize moment that needs to drain). Concretely: `ScreenState` grows a `drain(): Promise<void>` that resolves after the headless xterm's `write()` callback queue has flushed. `ws.ts`'s `sendSnapshot()` awaits this before `serialize()`.

Rationale: the cursor-disappear symptom is caused by serializing before a just-received chunk has been parsed. Awaiting the drain collapses that window.

## Data flow

### Initial connect (active run)

```
client opens WS (inside controller constructor)
  └─► server subscribes to broadcaster, buffers live bytes
      └─► server awaits pendingHello (or 1500ms timeout)
client WS emits 'open'
  └─► controller sends {type:'hello', cols, rows}
server receives hello
  └─► orchestrator.resize(runId, cols, rows)
  └─► ScreenState.resize(cols, rows)
  └─► ScreenState.drain()
  └─► serialize() -> send {type:'snapshot', ansi, cols, rows}
  └─► flush buffered bytes as binary frames
  └─► forward live bytes from now on
client receives snapshot
  └─► term.reset(); term.write(ansi)
client receives subsequent binary frames
  └─► term.write(data)
```

### Focus / blur cycle

Nothing happens at the application layer. xterm's canvas renderer is allowed to throttle while hidden; its `write()` keeps parsing into the buffer. When the tab becomes visible again, xterm paints the current buffer state — not 1000 intermediate frames. The fast-forward symptom disappears by construction.

### Resize

```
ResizeObserver fires -> fit.fit() -> controller.resize(cols, rows)
  └─► shell.resize (sends {type:'resize', cols, rows})
server receives resize
  └─► orchestrator.resize(runId, cols, rows)
  └─► ScreenState.resize(cols, rows)
TUI (Claude Code) receives SIGWINCH, emits a full redraw
  └─► bytes flow via broadcaster to live WS subscribers
  └─► client writes bytes into its already-live xterm
```

No snapshot. No 200 ms wait. No flicker.

### Continue

`interactive` flips from `false` to `true`. React runs the `[interactive]` effect → `controller.setInteractive(true)` attaches `onData`. Nothing else changes — xterm is not reset. The new Docker container's bytes arrive via the existing subscription; Claude's next redraw restores the cursor.

### History toggle

```
user clicks "Load full history"
  └─► controller.enterHistory(historyHostRef.current)
      - fetches /api/runs/:id/transcript
      - creates a second Xterm on historyHostRef
      - writes the transcript (chunked, ~1 MB chunks)
      - live Xterm host becomes display:none; live subscription unchanged
user clicks "Resume live"
  └─► controller.resumeLive()
      - disposes history Xterm
      - live host becomes display:block
      - term.focus() on the live Xterm  (THIS is the missing line today)
```

### Server restart with active run

The client's WS closes. Today the user refreshes the page; the controller's constructor runs again, opens a new WS, `hello` → snapshot (built by `rebuildScreenFromLog`). Auto-reconnect is explicitly out of scope for this spec.

## Edge cases

- **Hello arrives after the 1500 ms timeout.** The server has already sent a snapshot at default dims; it then processes the hello normally (resize PTY + ScreenState). The TUI's SIGWINCH redraw flows through as live bytes. Brief visual mis-wrap is possible; this is no worse than today.
- **Client disconnects before hello.** Server's `pendingHello` is orphaned; socket close cancels the pending send. No leak (the promise just goes unresolved and is eventually GC'd with the closed socket's handlers).
- **Multiple tabs on one run.** Each tab has its own WS, sends its own hello, and gets its own snapshot. `ScreenState` is shared; reads are pure serialize calls. No change from today.
- **Rapid resize (user dragging the browser edge).** `ResizeObserver` debouncing is unchanged (120 ms). Each commit of dims triggers a `shell.resize`; server applies them in order. No extra snapshot traffic.
- **xterm write burst blocks the main thread.** xterm's internal `writeBuffer` yields across chunks; empirically not an issue at Claude Code's output volume. If it becomes one, throttling goes inside the controller — we do not resurrect the rAF pump.
- **Load-history fetch fails mid-stream.** History xterm shows `[failed to load history]`; user can still click Resume live. No change from today.

## Testing

### Unit tests (new)

- `TerminalController.test.ts` (happy-dom + mocked xterm):
  - Constructor sends `hello` with the xterm's current dims on WS `open`.
  - `setInteractive(true)` attaches `term.onData`; `(false)` detaches.
  - Snapshot handler calls `term.reset()` once, then `term.write(ansi)`.
  - Bytes handler calls `term.write(data)` directly (no queue).
  - `enterHistory` creates a sibling Xterm and does not unsubscribe bytes.
  - `resumeLive` disposes the history Xterm and calls `term.focus()`.
  - `dispose` releases the shell and unsubscribes all handlers.

### Server tests (extended)

- `ws.test.ts`:
  - Snapshot is **not** sent before `hello` arrives.
  - Hello dims are propagated to `orchestrator.resize` and `ScreenState.resize`.
  - Hello timeout (1500 ms) results in a snapshot at default dims.
  - `resize` does not trigger a snapshot re-send.
  - `resync` branch is gone (delete existing test asserting it).
- `screen.test.ts`:
  - `drain()` resolves after all in-flight writes have been parsed.
  - A snapshot serialized after `drain()` includes the bytes from a recently-written chunk (regression for cursor-disappear).

### Manual Playwright (via `scripts/dev.sh` + Playwright MCP)

1. New run: cursor present within 2 s of page load; stays present through at least one full Claude turn.
2. Resize window mid-run: screen reflows cleanly; cursor stays; no "Loading terminal…" overlay re-appears.
3. Tab-hide for 60 s, then return: no fast-forward; visible content matches what Claude is doing right now.
4. Continue a failed run: cursor appears as soon as Claude redraws; no tab-switch trick needed.
5. Load full history → Resume live: typing works immediately, no click-to-focus needed.
6. Scroll back inside the history view: full run is scrollable (smoke).

### Tests to delete

- `src/web/lib/shellRegistry.test.ts`: the `describe('requestResync', …)` block (resync is gone).
- `src/server/api/ws.test.ts`: the `it('responds to a resync message with a fresh snapshot…')` test.
- Any test in `src/server/api/ws.test.ts` that asserts the 200 ms wait + snapshot re-send on `resize` (replace with an assertion that no extra snapshot is sent after a `resize`).

These behaviours are going away on purpose. There is no current `Terminal.test.*` file; new coverage goes into `TerminalController.test.ts`.

## Interface changes

### `src/web/lib/terminalController.ts` (new)

Public surface as described in the "New: `TerminalController`" section. No other file in the project constructs a controller — only `Terminal.tsx` uses it.

### `src/web/components/Terminal.tsx`

Props unchanged. Internal structure rewritten.

### `src/web/lib/ws.ts` (client)

- Add outbound `sendHello(cols: number, rows: number): void` on `ShellHandle`.
- Delete `sendResync` from `ShellHandle`.
- Replace `onOpenOrNow` with `onOpen(cb: () => void): () => void`: addEventListener-like semantics (fires each time the socket opens, returns a disposer). If the socket is already open at subscribe time, fires `cb` on the next microtask so the controller can use a single `onOpen` call regardless of timing.

### `src/web/lib/shellRegistry.ts`

- Delete `requestResync`.
- Unchanged otherwise.

### `src/server/api/ws.ts`

- Add `pendingHello` promise with 1500 ms timeout.
- `sendSnapshot()` awaits `pendingHello` before serializing, and applies hello's dims via `orchestrator.resize` + `ScreenState.resize`.
- `sendSnapshot()` awaits `ScreenState.drain()` before `serialize()`.
- Delete the `resync` control-frame branch.
- Delete the 200 ms wait + snapshot re-send in the `resize` branch.

### `src/server/logs/screen.ts`

- Add `drain(): Promise<void>` that resolves after the headless xterm's in-flight writes have been parsed (the existing `write` callback gives us this; `drain` chains a final callback).

### `src/shared/types.ts`

- Add `{type: 'hello', cols: number, rows: number}` to the client-to-server WS control-frame union.
- Remove `{type: 'resync'}` from the same union.

## Acceptance criteria

1. Cursor is visible on a running Claude Code session before and after each of: tab switch, refocus (>60 s hidden), resize, Continue, scrolling to the bottom of the viewport.
2. Tab-hide for 60 s followed by return produces no visible fast-forward of intermediate frames.
3. "Load full history" → "Resume live" restores typing immediately with no click-to-focus required.
4. Resizing the window during a run produces no flicker and no "Loading terminal…" overlay re-appearance.
5. All existing terminal tests pass after deletions and rewrites; new `TerminalController` tests pass; new server assertions pass.
6. `Terminal.tsx` is <= 200 lines; no file in the project contains both snapshot-application and input-forwarding logic.

## Out of scope

- **Auto-reconnect on WebSocket drop.** Separate reliability gap; the user refreshes for now.
- **Smarter "semantic" history** (JSONL chat rendering). Confirmed with the user: raw bytes with better UX is what's wanted.
- **Changing Claude Code's cursor rendering.** We accept that the cursor is a cell Claude paints; the fix is not to interrupt its render cycle.
- **Server-push cell-diff streaming.** Considered and rejected above.
- **Restructuring `RunTerminal.tsx`** or the `runs` feature surface.
- **Migration of the terminal trace subsystem** (`terminalTrace.ts`). Trace calls stay where they are.
