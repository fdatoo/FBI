> **Superseded by [2026-04-26-terminal-rust-rewrite-design.md](2026-04-26-terminal-rust-rewrite-design.md).**
> The redesign in this doc has been replaced by a Rust-based server-side
> virtual terminal exposed to the BEAM via Rustler NIF. See the newer
> spec for the architecture that actually shipped.

# Terminal Robustness Redesign

## Problem

The terminal is FBI's most important feature and currently its buggiest. Two symptoms dominate:

1. **Fast-forward on refocus.** Unfocusing the window and returning causes the terminal to replay every intermediate frame (each agent turn, each spinner tick) at max speed before landing on the current state. Visually it looks like a time-lapse rewinding at 100×.
2. **Disappearing cursor.** The cursor glyph (rendered by Claude Code inside the PTY output — the default xterm cursor is painted background-colored because the hardware cursor doesn't land in the chat box) frequently vanishes.

### Delivery mechanism of the fast-forward

The client write pipeline in `src/web/components/Terminal.tsx:93–117` is a `requestAnimationFrame`-paced serial queue. Browsers throttle rAF when the window is blurred (typically to 1 Hz or paused entirely). Bytes keep arriving over the WS during the blur; the pump can't drain them. When focus returns, rAF resumes at 60 Hz and the queue drains as fast as xterm can parse → fast-forward.

### Architectural root cause

The system reasons in terms of byte streams, not screen states. On every connect, the server replays the entire raw byte log, and the client parses its way forward through every intermediate ANSI frame. The same root cause drives both symptoms: the cursor glyph tends to disappear because the fast-forward path clobbers the final cell with an intermediate frame's content.

## Solution

Introduce a server-side virtual terminal that maintains the authoritative current-screen state. On connect (and on every refocus), the server sends a single snapshot frame describing the current screen; the client resets its local xterm and writes that snapshot. No raw log replay on the live path.

This is the standard pattern used by tmux, ttyd, gotty, and zellij.

### Why not alternatives

- **Client-only "shadow xterm" that catches up on visibilitychange.** Smaller backend diff, but still eats full log replay on initial load, doubles client memory per tab, and doesn't help if the root cause is partially server-side. Rejected.
- **Render throttling / scrub mode.** Tiny diff, but it's a band-aid — still replaying history, just fast enough to hide the flicker. Doesn't address the cursor. Rejected.
- **DOM overlay cursor driven by headless-xterm cursor position.** Initially considered, but Claude Code parks the hardware cursor away from the visual cursor position (that's why the default xterm cursor is hidden today). An overlay at the hardware cursor would render in the wrong place. Rejected in favor of snapshot-replay preserving whatever cell Claude Code drew as its cursor.

## Architecture

### New: `ScreenState` (server)

`src/server/logs/screen.ts`. A wrapper around `@xterm/headless` + `@xterm/addon-serialize`, one instance per active run.

```
class ScreenState {
  constructor(cols: number, rows: number)
  write(bytes: Uint8Array): void    // sync; feeds headless xterm parser
  resize(cols: number, rows: number): void
  serialize(): string               // ANSI string reproducing current screen
  dispose(): void
  readonly cols: number
  readonly rows: number
}
```

Defaults: 120 cols × 40 rows until the first resize from the client. Headless xterm is fast enough to parse synchronously on the bytes-in path without queueing; if that ever changes we add a metric and revisit.

### Modified: `RunStreamRegistry`

`src/server/logs/registry.ts`. Each `RunStream` gains a `ScreenState` alongside the existing `LogStore` and `Broadcaster`. `RunStream.push(bytes)` fans out to all three synchronously: file, broadcaster, screen state. `RunStream.resize(cols, rows)` forwards to `ScreenState`. New: `RunStream.getSnapshot(): { ansi, cols, rows }`.

On server restart with an active run present: `RunStreamRegistry` lazily rebuilds `ScreenState` by streaming the existing `LogStore` file through a fresh headless terminal once, then resumes normal operation. Cap the rebuild replay at 50 MB (reading from the tail); above that, older bytes are discarded — alt-screen TUIs clear on every full repaint, so only the most recent screen matters in practice.

### Modified: WS route

`src/server/api/ws.ts`.

**On active-run connect:**
1. Subscribe to broadcaster, buffer incoming bytes in a small array.
2. Serialize `ScreenState` → send text frame `{type: 'snapshot', ansi, cols, rows}`.
3. Flush any bytes buffered during steps 1–2 as binary frames.
4. Unblock; live bytes now forward directly.

**On client resync message** (`{type: 'resync'}`):
1. Finish any in-flight byte send.
2. Serialize `ScreenState`.
3. Send snapshot frame.
4. Any bytes arriving from the PTY between steps 2–3 are held and flushed after the snapshot; all bytes after the snapshot are strictly newer.

**Finished runs:** unchanged. Serve full `LogStore` file, close. No snapshot frame.

### Modified: client WS + shell registry

`src/web/lib/ws.ts`: handle new inbound `snapshot` message type; expose `sendResync()` outbound.

`src/web/lib/shellRegistry.ts`: **remove** the 2 MB rolling byte buffer. Server is now the authority for "current screen." Add `onSnapshot(cb)` subscription; add `requestResync()` method.

### Modified: Terminal component

`src/web/components/Terminal.tsx`.

- Drop `getBuffer` / `writeReplay` / `trimToTail`.
- On mount: subscribe to snapshot and live bytes. On first snapshot arrival: `term.reset()`, write `ansi`, flag ready. Subsequent bytes are live.
- Add `window` `blur`/`focus` and `document` `visibilitychange` listeners. On blur or hide: set a `stale` flag; optionally dim (aesthetic; not required for correctness) the terminal. On focus or visible, if `stale`: drop the pending write queue, call `requestResync()`, wait for snapshot frame, process as above.
- On any subsequent snapshot (resync response): drop write queue, `term.reset()`, write `ansi`, resume.

### New HTTP endpoint

`GET /api/runs/:id/log` — serves the full raw log file. Used only by the "Load full history" button, which is no longer on the WS live path.

### "Load full history" becomes explicit history mode

The button pauses live view, fetches `GET /api/runs/:id/log`, resets the terminal, writes the log, and shows a "Resume live" button. "Resume live" triggers `requestResync()` to return to current-screen view. This makes the two modes distinct instead of mingled.

## Data flow

### Byte path (PTY → client)

Docker attach stream → `RunStream.push(bytes)` → synchronous fan-out to `LogStore.append`, `Broadcaster.publish`, `ScreenState.write`. Broadcaster delivers to each subscribed WS; no serialization happens on this path.

### Initial connect (active run)

```
client opens WS
  └─► server subscribes to broadcaster, buffers live bytes
      └─► server serializes ScreenState → sends {type: 'snapshot', ...}
          └─► server flushes buffered bytes
              └─► server forwards live bytes directly
client receives snapshot
  └─► term.reset(); enqueue ansi
      └─► subscribe to subsequent binary frames as live bytes
```

### Focus/blur cycle

```
window.blur  / visibilitychange→hidden
  └─► client sets stale=true; optionally dim xterm
window.focus / visibilitychange→visible
  └─► if stale:
        drop pending write queue
        send {type: 'resync'}
        await snapshot frame
          └─► term.reset(); write ansi; resume live
```

### Resize

Client fit addon computes cols/rows → `shell.resize(cols, rows)` sends existing `{type: 'resize', ...}` → server forwards to **both** PTY **and** `ScreenState`. Headless xterm must track the same dimensions as the PTY.

### Input (client → PTY)

Unchanged. Keystrokes go straight through the WS to the PTY. No coupling to snapshot/resync.

### Run end

PTY exits → `ScreenState.dispose()` → run marked finished. Future connects take the finished-run path (full log replay from `LogStore`, then close).

## Edge cases

- **Resync race.** Server finishes in-flight byte send before serializing, and buffers any bytes arriving during serialization for flush after the snapshot. Client discards its write queue on snapshot arrival, so stale in-flight bytes are safely dropped. Snapshot is self-consistent; all bytes after it are strictly newer.
- **PTY resize while client is blurred.** No resize message sent during blur. On refocus: client refits, sends resize, server updates PTY and `ScreenState`; then client sends resync and receives a snapshot at the new dimensions. Client refits once more if needed after snapshot arrives.
- **Headless xterm falling behind.** `ScreenState.write` is synchronous; headless xterm parses in the tens-of-MB/sec range while Claude Code emits far less. If pressure ever appears, we add a metric. No queueing upstream.
- **Server restart with active run.** `RunStreamRegistry` rebuilds `ScreenState` by streaming the existing log file (capped at tail 50 MB). One-time cost per restart per active run. The rebuilt `ScreenState` starts at the PTY's current dimensions if queryable from Docker, else the 120×40 defaults; the next client resize corrects it.
- **Multiple concurrent viewers of one run.** All share the same `ScreenState` (reads are pure serialize calls). Each gets its own snapshot on connect. Free from the server-authority design.
- **Memory budget.** Per active run: ~2–3 MB for headless xterm (1000-line scrollback × 200 cols × ~4 bytes/cell ≈ 800 KB plus overhead). Ten concurrent runs ≈ 30 MB. Acceptable.
- **Cursor visibility (DECTCEM toggles).** Not handled explicitly — the snapshot captures whatever cells Claude Code drew, including its cursor glyph. If cursor disappearance recurs after this fix, it is a separate bug to investigate against Claude Code's TUI output, not our transport.

## Testing

### Unit tests (new)

- `ScreenState.test.ts`
  - Write a byte sequence, serialize, feed the result into a second headless xterm; assert the two buffers are cell-for-cell equal.
  - Same, but split the byte stream across arbitrary chunk boundaries (catches parser-state bugs).
  - Resize: write bytes, resize, write more, serialize; assert the result reflects post-resize dimensions.
- `registry.test.ts` (extend)
  - `ScreenState` is updated alongside `LogStore` and `Broadcaster` on every `push`.
  - Rebuild-from-log-file produces a ScreenState identical to one that received the same bytes live.

### Integration tests (new)

- WS handshake: connect, assert first text frame is `{type: 'snapshot', ...}`, assert subsequent bytes are live. Cases: empty run (empty-screen snapshot) and mid-run (snapshot contains prior state).
- Resync: connect, send `{type: 'resync'}`, assert a new snapshot frame arrives and no bytes from before the resync slip through after it.
- Server restart: write bytes to `LogStore`, create a fresh registry (simulating restart), connect a client, assert the snapshot matches what a live-fed ScreenState would produce.

### Manual browser validation

1. Open a run; verify initial paint is current screen (no flicker, no scrollback of old frames).
2. Unfocus the window for 60+ seconds while Claude Code is working; refocus; verify no fast-forward, screen jumps to current state smoothly.
3. Cursor glyph present in the chat input before and after the refocus cycle.
4. Multiple tabs on the same run: each gets its own snapshot, both show identical state.
5. Type during and immediately after refocus; verify input latency hasn't regressed.
6. "Load full history" switches to history mode; "Resume live" returns to current-screen view.
7. Restart server mid-session; client reconnects and lands on current state without errors.

### Non-regressions

Existing orchestrator, WS, and Terminal component tests should still pass. Tests that assume "log replay is the live-view source" will need updating — that is the intended behavior change.

## Out of scope

- **Client-side cursor overlay.** Not doing. See rejected alternatives.
- **Unifying live and finished-run viewing paths.** Finished runs keep the full-log replay path; live runs use snapshot. Unifying this would be premature abstraction — the two modes want different things (scrollback vs current screen).
- **Multi-user collaboration primitives** (shared selection, cursors of other viewers, etc.). The architecture supports it but we're not building it.
- **Investigating root cause of Claude Code's cursor disappearance if it persists post-fix.** Triaged as separate work if observed.
