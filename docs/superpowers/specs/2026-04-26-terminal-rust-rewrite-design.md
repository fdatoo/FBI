# Terminal Rust Rewrite — design

**Date:** 2026-04-26
**Project:** FBI
**Status:** superseded
**Superseded by:** [2026-04-28-ghostty-web-migration-design.md](2026-04-28-ghostty-web-migration-design.md)
**Supersedes:** [2026-04-22-terminal-robustness-design.md](2026-04-22-terminal-robustness-design.md), [2026-04-23-terminal-hardening-design.md](2026-04-23-terminal-hardening-design.md), [2026-04-23-terminal-robust-redesign-design.md](2026-04-23-terminal-robust-redesign-design.md)
**Builds on:** [2026-04-24-fbi-tunnel-rust-design.md](2026-04-24-fbi-tunnel-rust-design.md), [2026-04-26-quantico-mock-claude-design.md](2026-04-26-quantico-mock-claude-design.md)

## 1. Overview

The Elixir FBI server's terminal pipeline is structurally broken in a way three prior fix passes have failed to repair. The root cause is architectural: the Elixir backend has no virtual terminal. Its WebSocket "snapshot" frame is hard-coded to `\e[2J\e[H` (clear screen + home). All terminal state lives only on each connected client's xterm.js instance; reconnects, tab switches, and chunk loads start from zero.

This spec rips out the existing terminal infrastructure and replaces it with a server-side cell-accurate terminal emulator written in Rust, exposed to the BEAM via a Rustler NIF. The same change introduces a multi-viewer-aware resize policy (last-focused-wins), a takeover-banner UX, and a transparent mode-state-prefix on the HTTP transcript Range API. The scope also bundles four pre-existing frontend bugs that survive the architectural change.

We are pre-alpha; the rewrite ships as a single coordinated PR with no fallback path. The diff harness — built on top of the existing Quantico mock-Claude infrastructure — is the gate.

### Goals

- Send a faithful, cell-accurate snapshot of the current screen state on every WS hello, eliminating the blank-on-tab-switch and incomplete-output-until-refresh symptoms.
- Maintain accurate mode state (DECSTBM scroll region, alt-screen, mouse modes, DECTCEM, DECAWM, bracketed paste, focus reporting, in-band resize) across the entire byte stream so chunk loads from anywhere in history replay correctly.
- Make multi-viewer behavior predictable: a non-driving viewer's resize never disturbs the driving viewer, and viewers can take over explicitly via UI or implicitly via keystroke.
- Establish server-side cell state as the single source of truth, opening the door to future capabilities (image snapshots, search, mobile clients) without requiring further protocol churn.
- Deliver a deterministic, every-PR diff harness that catches regressions in the Rust grid against the canonical xterm.js client renderer.

### Non-goals

- Cell-diff wire protocol. Snapshots remain full ANSI replays.
- Server-rendered images, server-side search, mobile-native clients. Foundational, not initial deliverables.
- Production-traffic PTY capture for diff-harness corpus growth. Deferred until post-alpha.
- Sixel / kitty graphics protocols. Out of scope.
- Hysteresis / debounce on the resize policy. Last-focused-wins is naturally low-churn; revisit only if usage shows the need.
- Replaying the persisted log tail through the parser on RunServer reattach. Empty grid on reattach is acceptable for v1.
- Removing `@xterm/headless` from `src/server/`. The TS server is on its own deletion path via the server-rewrite migration; out of scope for this work.
- Supporting any frontend other than the existing xterm.js-based web client.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  cli/fbi-term-core/   (pure Rust crate, workspace)      │
│   • alacritty_terminal-based grid + parser              │
│   • Mode tracking + checkpoint store                    │
│   • serialize() → ANSI replay                           │
│   • cargo test runs against Quantico-derived fixtures   │
└────────────────────────┬────────────────────────────────┘
                         │ depended on by
                         ▼
┌─────────────────────────────────────────────────────────┐
│  server-elixir/native/fbi_term/  (Rustler wrapper)      │
│   • cdylib NIF                                          │
│   • ResourceArc<Mutex<Parser>> handles                  │
│   • feed/snapshot/snapshot_at/resize                    │
│   • catch_unwind boundary; panic = abort in release     │
└────────────────────────┬────────────────────────────────┘
                         │ called from
                         ▼
┌─────────────────────────────────────────────────────────┐
│  FBI.Orchestrator.RunServer  (Elixir GenServer per run) │
│   • Replaces ETS ScreenState                            │
│   • Owns the parser handle for the run's lifetime       │
│   • Owns the new ViewerRegistry (last-focused-wins)     │
│   • Drives PTY resize on focus changes                  │
│   • broadcast(:bytes) AFTER feed (was: before)          │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  FBIWeb.Sockets.ShellWSHandler  (one per WS connection) │
│   • Honors hello / resize / focus / blur                │
│   • Snapshot frame contains real ANSI replay            │
│   • Re-hello triggers fresh snapshot (was: dropped)     │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  FBIWeb.TranscriptController  (HTTP Range API)          │
│   • Auto-prepends mode-state-at-offset for non-zero     │
│     starts (calls NIF.snapshot_at via RunServer)        │
└─────────────────────────────────────────────────────────┘
```

Key behavior changes:

- The Rust grid is the canonical source of "what the screen looks like now." Snapshots, chunk-load prefixes, and resize handling all derive from it.
- Per-run state moves from `:ets` (ScreenState ring buffer) to a per-RunServer NIF resource handle. Lifetime is the RunServer's lifetime; ResourceArc GC reclaims it when the GenServer terminates.
- Viewer registry lives in RunServer state — no new ETS table. Updates are serialized through the GenServer's mailbox.
- Wire protocol stays compatible: same JSON snapshot frame shape, same HTTP transcript Range API. Only payload contents change. New text frames `{type:"focus"}` and `{type:"blur"}` are additive.

### What gets deleted

- `server-elixir/lib/fbi/orchestrator/screen_state.ex` (entire file).
- The hard-coded `\e[2J\e[H` snapshot in `shell_ws_handler.ex` and the `@clear_screen` constant.
- The dim-mismatch reclaim loop in `terminalController.ts:137-141`.
- All `ScreenState.feed/2`, `ScreenState.snapshot/1`, `ScreenState.clear/1`, `ScreenState.resize/3` call sites.
- The `:fbi_screen_state` ETS table (no longer initialized).

## 3. Rust crate `fbi-term-core`

### Layout

```
cli/fbi-term-core/                  ← pure Rust, testable in isolation
  Cargo.toml                        (lib only, no binary)
  src/
    lib.rs                          ← public API, re-exports
    parser.rs                       ← wraps alacritty_terminal::Term
    modes.rs                        ← mode tracker, checkpoint store
    serialize.rs                    ← grid + modes → ANSI replay
    checkpoint.rs                   ← byte-offset → mode-state index
  tests/
    fixtures/                       ← Quantico .yaml-derived byte captures
    diff_xterm.rs                   ← native diff vs @xterm/headless via stdio
    support/
      xterm_ref.mjs                 ← Node script: import @xterm/headless, dump grid
```

Workspace member alongside `cli/fbi-tunnel/` and `cli/quantico/`.

### Public API

```rust
pub struct Parser { /* opaque */ }

pub struct Snapshot {
    pub ansi: String,        // modes + grid + final CUP
    pub cols: u16,
    pub rows: u16,
    pub byte_offset: u64,    // total bytes consumed up to this snapshot
}

pub struct ModePrefix {
    pub ansi: String,        // modes-only ANSI (no cell content)
}

impl Parser {
    pub fn new(cols: u16, rows: u16) -> Self;
    pub fn feed(&mut self, bytes: &[u8]);
    pub fn snapshot(&self) -> Snapshot;
    pub fn snapshot_at(&self, byte_offset: u64) -> ModePrefix;
    pub fn resize(&mut self, cols: u16, rows: u16);
    pub fn cols(&self) -> u16;
    pub fn rows(&self) -> u16;
}
```

### Mode-state checkpointing

Every 256 KB of fed bytes, the parser stores a snapshot of its mode state (DECSTBM top/bottom, alt-screen flag, DECTCEM, DECAWM, mouse mode, mouse extension, bracketed paste, focus reporting, in-band resize, saved cursor, charset selections) indexed by `byte_offset`.

`snapshot_at(offset)`:
1. Find the latest checkpoint with `checkpoint.byte_offset <= offset`.
2. Replay bytes between `checkpoint.byte_offset` and `offset` through a fresh, side-effect-free mode tracker (no cell mutations, just CSI/OSC dispatch).
3. Emit the resulting mode state as ANSI escape sequences clamped to the parser's current rows (DECSTBM clamp matches the existing `screen.ts` ModeScanner approach).

Replay-from-checkpoint is bounded at ≤256 KB of pure mode-extraction work — microseconds.

### Serialization

`serialize.rs` walks the alacritty grid and emits ANSI:
1. Mode prefix (alt-screen flag → `\e[?1049h`/`\e[?1049l\e[H\e[2J`; DECSTBM; DECTCEM; DECAWM; mouse modes; bracketed paste; focus reporting; in-band resize).
2. Grid contents row by row (cell runs sharing SGR coalesced; CR/LF for line breaks; final blank cells trimmed).
3. Final CUP placing the cursor at its current position.

Output format matches `@xterm/headless` + `SerializeAddon` semantics closely enough that writing the result into a fresh xterm at the same dims reproduces the source grid. Differences from byte-perfect SerializeAddon output are acceptable as long as the resulting xterm grid state matches — verified by the diff harness.

### Panic behavior

`panic = "abort"` in release. All public methods are panic-free for any byte input that the existing TS pipeline accepts. Defensive `catch_unwind` lives at the NIF boundary, not the crate API.

## 4. Rustler NIF wrapper

### Layout

```
server-elixir/native/fbi_term/      ← Rustler wrapper (cdylib)
  Cargo.toml                        (depends on fbi-term-core, rustler)
  src/
    lib.rs                          ← #[rustler::nif] functions, ResourceArc
```

Mix Rustler integration in `server-elixir/mix.exs` builds the cdylib on `mix compile`. Linux x86_64 is the primary target. macOS arm64/x86_64 are added later if/when the desktop app embeds the server in-process.

### Elixir surface

```elixir
defmodule FBI.Terminal do
  @moduledoc "Rustler NIF wrapper around fbi-term-core."
  use Rustler, otp_app: :fbi, crate: "fbi_term"

  @opaque handle :: reference()

  @spec new(pos_integer(), pos_integer()) :: handle()
  def new(_cols, _rows), do: :erlang.nif_error(:nif_not_loaded)

  @spec feed(handle(), binary()) :: :ok | {:error, :nif_panic}
  def feed(_handle, _bytes), do: :erlang.nif_error(:nif_not_loaded)

  @spec snapshot(handle()) ::
    %{ansi: binary(), cols: pos_integer(), rows: pos_integer(), byte_offset: non_neg_integer()}
    | {:error, :nif_panic}
  def snapshot(_handle), do: :erlang.nif_error(:nif_not_loaded)

  @spec snapshot_at(handle(), non_neg_integer()) :: %{ansi: binary()} | {:error, :nif_panic}
  def snapshot_at(_handle, _offset), do: :erlang.nif_error(:nif_not_loaded)

  @spec resize(handle(), pos_integer(), pos_integer()) :: :ok | {:error, :nif_panic}
  def resize(_handle, _cols, _rows), do: :erlang.nif_error(:nif_not_loaded)
end
```

`feed/2` is a dirty NIF on the I/O scheduler (`schedule = "DirtyIo"`). Other functions are clean NIFs.

The handle is `ResourceArc<Mutex<Parser>>`. The Mutex protects against the (unused but possible) case of multiple BEAM scheduler threads dispatching to the same resource concurrently.

### Panic boundary

Every `#[rustler::nif]` function wraps its body in `std::panic::catch_unwind`. A caught panic returns `{:error, :nif_panic}`; the caller (`RunServer`) treats this as fatal for the run. Telemetry counter `fbi_term.nif_panic` increments on each occurrence — panics are P0 bugs to investigate, not normal operation.

## 5. Per-run integration in Elixir

### `RunServer` state additions

```elixir
defmodule FBI.Orchestrator.RunServer do
  defstruct [
    # ... existing fields ...
    :term_handle,           # FBI.Terminal.handle()
    viewers: %{},           # %{viewer_id => Viewer.t()}
    focused_viewer: nil,    # viewer_id | nil
  ]
end

defmodule FBI.Orchestrator.Viewer do
  defstruct [:id, :ws_pid, :ws_monitor_ref, :cols, :rows, :focused_at, :joined_at]
end
```

The handle is allocated on `set_container` (when the PTY exists and we know its initial size, defaulting to 80×24). It lives for the run's lifetime; ResourceArc reclaims it when `RunServer` terminates.

### Lifecycle events

| Event | Effect |
|---|---|
| `set_container(cid, socket)` | `term_handle = FBI.Terminal.new(80, 24)` |
| `feed` (from `make_on_bytes`) | `FBI.Terminal.feed(term_handle, chunk)` then `Phoenix.PubSub.broadcast({:bytes, chunk})` (note ordering swap from current code) |
| `viewer_joined(ws_pid, cols, rows)` | Add to registry, monitor pid; do not change PTY size |
| `viewer_focused(viewer_id)` | Update `focused_at`; if dims differ from PTY, resize PTY + grid + broadcast fresh snapshot to all viewers |
| `viewer_left(viewer_id)` | Drop from registry; if was focused, fall back per policy |
| WS pid `:DOWN` | Synthesized `viewer_left` |
| `terminate` | ResourceArc dropped → NIF resource freed |

### `make_on_bytes` ordering fix

```elixir
defp make_on_bytes(run_id, log_path, term_handle) do
  fn chunk ->
    LogStore.append(log_path, chunk)
    FBI.Terminal.feed(term_handle, chunk)
    Phoenix.PubSub.broadcast(FBI.PubSub, "run:#{run_id}:bytes", {:bytes, chunk})
  end
end
```

`feed` precedes `broadcast`. Any client whose snapshot is built in response to a hello sees a parser state that includes every byte broadcast to it so far — closing the original race.

### Last-focused-wins policy

```elixir
def handle_call({:viewer_focused, viewer_id}, _from, state) do
  case state.viewers[viewer_id] do
    nil ->
      {:reply, {:error, :unknown_viewer}, state}

    v ->
      now = System.monotonic_time()
      state =
        state
        |> put_in([Access.key(:viewers), viewer_id, Access.key(:focused_at)], now)
        |> Map.put(:focused_viewer, viewer_id)

      state =
        if v.cols != current_cols(state) or v.rows != current_rows(state) do
          :ok = FBI.Docker.resize_container(state.container_id, v.cols, v.rows)
          :ok = FBI.Terminal.resize(state.term_handle, v.cols, v.rows)
          broadcast_fresh_snapshot(state)
          broadcast_focus_state(state)
          state
        else
          broadcast_focus_state(state)
          state
        end

      {:reply, :ok, state}
  end
end
```

Fallback when the focused viewer disconnects:
1. If any other viewer exists, the most-recently-focused remaining viewer becomes focused (sticky — their last `focused_at` timestamp wins).
2. If no viewer was ever focused, fall back to the most-recently-joined viewer.
3. If no viewers remain, `focused_viewer = nil` and PTY size is left untouched.

Initial focus: the first viewer to connect is implicitly focused on first hello, driving the initial PTY dims. Subsequent viewers join unfocused.

No hysteresis / debouncing in v1.

### `broadcast_fresh_snapshot` and `broadcast_focus_state`

```elixir
defp broadcast_fresh_snapshot(state) do
  %{ansi: ansi, cols: cols, rows: rows} = FBI.Terminal.snapshot(state.term_handle)
  frame = %{type: "snapshot", ansi: ansi, cols: cols, rows: rows}
  Phoenix.PubSub.broadcast(FBI.PubSub, "run:#{state.run_id}:snapshot", {:snapshot, frame})
end

defp broadcast_focus_state(state) do
  Phoenix.PubSub.broadcast(
    FBI.PubSub,
    "run:#{state.run_id}:events",
    {:event, %{type: "focus_state", focused_viewer: state.focused_viewer}}
  )
end
```

A new PubSub topic `run:<id>:snapshot` separates fan-out snapshot pushes from per-connection unicast snapshot replies. Each WS handler subscribes to the topic on init.

The `focus_state` event piggybacks on the existing `:events` topic and is rendered to per-viewer `{focused: bool, by_self: bool}` in the WS handler (which knows its own `viewer_id`).

### Reattach behavior

A reattached `RunServer` allocates a fresh `term_handle` with default 80×24 dims. The grid starts empty; the snapshot contains only the empty-grid replay. As live bytes flow in, the grid populates. Replaying the persisted log tail through the parser at startup is deferred (Section 1 non-goals).

## 6. Wire protocol

### Existing message types (preserved, payloads upgraded)

| Direction | Frame | Payload |
|---|---|---|
| C→S | text | `{"type":"hello", "cols":N, "rows":M}` |
| C→S | text | `{"type":"resize", "cols":N, "rows":M}` |
| C→S | binary | raw stdin bytes |
| S→C | text | `{"type":"snapshot", "ansi":<real-replay>, "cols":N, "rows":M}` |
| S→C | binary | raw PTY bytes |
| S→C | text | `{"type":"usage"|"state"|"title"|"changes", ...}` (typed events, unchanged) |

### New message types

| Direction | Frame | Payload |
|---|---|---|
| C→S | text | `{"type":"focus"}` — viewer asserts ownership |
| C→S | text | `{"type":"blur"}` — viewer relinquishes (advisory) |
| S→C | text | `{"type":"focus_state", "focused": bool, "by_self": bool}` |

### Re-hello behavior

`hello` is accepted at any time:

1. Update this viewer's `cols`/`rows` in the run's viewer registry.
2. If this viewer is the focused viewer and dims differ from PTY: resize and broadcast snapshot to all viewers.
3. If this viewer is not focused: registry update only; no PTY resize.
4. Always reply with the current snapshot to *this* viewer.

### Resize semantics

`{type:"resize"}` is a thin variant of `hello` that updates the viewer's recorded dims without triggering snapshot reply. Same routing as items 1–3 above; the focused-viewer case still triggers PTY/grid resize and broadcast.

### Focus / blur semantics

- `{type:"focus"}` triggers `RunServer.viewer_focused/2`. If dims differ from PTY, resize and broadcast snapshot to all viewers.
- `{type:"blur"}` clears `focused_viewer` only if this viewer was the focused one.
- Implicit focus on stdin: when a viewer sends a binary frame, the WS handler synthesizes a `focus` before forwarding stdin (the "keystroke implies takeover" rule).

### HTTP transcript Range API — auto-prepended mode prefix

`GET /api/runs/:id/transcript`:

- `Range: bytes=0-B` or no Range: behavior unchanged. `X-Transcript-Total: total`, `Content-Range: bytes 0-B/total` (if Range), body is raw bytes.
- `Range: bytes=A-B` where `A > 0`: server calls `RunServer.snapshot_at(run_id, A)` → `FBI.Terminal.snapshot_at(handle, A)` → returns mode-prefix ANSI (~50–500 bytes). Server returns `prefix ++ bytes(A..B)`.

Headers on `A > 0` responses:
- `X-Transcript-Total: <total>` (unchanged)
- `Content-Range: bytes A-B/total` (unchanged — refers to logical byte range, not body bytes)
- `X-Transcript-Mode-Prefix-Bytes: <N>` (new — length of the prepended prefix in bytes)

The client treats `body[0..N)` as modes (write to xterm but don't count toward `loadedStartOffset`) and `body[N..)` as the chunk bytes.

### Wire-format compatibility summary

| Surface | Compat |
|---|---|
| WS snapshot frame | shape preserved, `ansi` payload becomes meaningful |
| WS hello / resize | shape preserved, server behavior expanded |
| WS bytes (S→C) | unchanged |
| WS focus / blur / focus_state | new (additive) |
| Transcript Range API | response shape preserved + one new optional header |

## 7. Frontend changes

### `terminalController.ts` cleanups

1. **Stop dropping bytes during rebuild** (`controller.ts:151-170`). Always append to `liveTailBytes` and advance `liveOffset`; gate only the `term.write`. This preserves the live tail across rebuilds and keeps `liveOffset` honest for resume's tail-fetch math.

2. **Delete the dim-mismatch reclaim loop** (`controller.ts:137-141`). A dim mismatch is now an expected state for non-focused viewers; the takeover banner handles UX.

3. **Cached-snapshot path becomes meaningful**. The cached snapshot is now a real grid replay; the synchronous fast-paint actually shows useful content. `seedInitialHistory` still backfills scrollback from the transcript Range API.

### Focus event firing

The controller fires `focus` / `blur` to the shell on:

| Trigger | Event |
|---|---|
| `document.visibilityState === 'visible'` AND this run is the active tab | `focus` |
| User keystroke into the terminal | `focus` (only if not already focused) |
| Click on the takeover banner | `focus` |
| `document.visibilityState === 'hidden'` | `blur` |
| Component unmount | implicit blur via WS disconnect; no explicit message |

Tracked locally with `private isFocused = false` to avoid spamming `focus` on every keystroke.

### `TerminalTakeoverBanner` component

Visible when:
- Latest snapshot dims differ from this viewer's local terminal dims, AND
- This viewer is not the focused viewer.

Banner body: `Showing terminal at <cols>×<rows> (driven by another viewer)` plus a `Take over` button. Click → `sendFocus()` → server resizes PTY to this viewer's dims → broadcasts new snapshot.

Banner is dismissible per session only (no localStorage); reappears on subsequent dim-mismatch transitions.

### xterm container scroll behavior

The wrapper div (`.terminal-host`) gains `overflow: auto` (currently `overflow: hidden`). When PTY dims exceed container dims, scrollbars appear and the user can pan. Inverse case (PTY smaller) continues to use existing letterbox CSS.

### Files touched

| File | Change |
|---|---|
| `src/web/lib/terminalController.ts` | byte-buffering fix; remove reclaim loop; add focus/blur firing; consume `focus_state` |
| `src/web/lib/ws.ts` | add `sendFocus()` / `sendBlur()` to ShellHandle |
| `src/web/components/Terminal.tsx` | mount `<TerminalTakeoverBanner>`; `overflow: auto` on host |
| `src/web/components/TerminalTakeoverBanner.tsx` | new component |
| `src/shared/types.ts` | add `RunWsFocusStateMessage` type |
| `src/web/lib/transcript.ts` (or equivalent) | read `X-Transcript-Mode-Prefix-Bytes`; slice body |

Total frontend delta: ~150 added LOC, ~25 deleted LOC.

## 8. Diff harness

### New Quantico scenarios

Eight new YAML scenarios in `cli/quantico/scenarios/`, authored in the existing `emit_ansi` / `sleep_ms` format:

| scenario | exercises |
|---|---|
| `alt-screen-cycle` | `\e[?1049h` enter alt, draw content, `\e[?1049l` exit, repeat |
| `scroll-region-stress` | DECSTBM scroll region + status-line-driven layout |
| `mouse-modes-cycle` | mouse mode set/unset, extended mouse mode set/unset |
| `cjk-wide` | UTF-8 CJK + wide emoji at column boundaries |
| `truecolor` | 24-bit + 256 + 16 SGR across the grid |
| `bracketed-paste-cycle` | `\e[?2004h`/`\e[?2004l` |
| `scrollback-stress` | 50,000 lines for chunk-load testing |
| `cursor-styles` | DECTCEM toggling, cursor shape escapes, DECSC/DECRC |

### Native diff layer

`cli/fbi-term-core/tests/diff_xterm.rs`. For each scenario:
1. Capture bytes via `quantico --capture-bytes <out>` (new flag) into `tests/fixtures/<name>.bin`.
2. Feed bytes through `fbi-term-core` parser → produce normalized grid representation.
3. Spawn Node, run `tests/support/xterm_ref.mjs` (imports `@xterm/headless` + `SerializeAddon`), feed same bytes, dump grid as JSON.
4. Compare normalized grid representations cell-by-cell + cursor pos + active buffer + scroll region.

Normalization: empty cells canonicalized to default attributes; trailing blanks per row removed; SGR-equivalent attributes coalesced.

Runs via `cargo test -p fbi-term-core` in CI on every PR. Total runtime ≤30 seconds.

### E2E diff layer

Extends `tests/e2e/quantico/`. New specs:

- `terminal-<scenario>.spec.ts` (one per terminal-correctness scenario): assert that after a forced reload (close+reopen WS), the rendered terminal matches the pre-reload state. The strongest end-to-end statement of "the snapshot is faithful."
- `terminal-takeover-banner.spec.ts`: two browser contexts, different sizes, same run. Banner appears on the second; click transfers focus.
- `terminal-chunk-load.spec.ts`: `scrollback-stress` scenario. Scroll into history; verify modes correct for chunks crossing alt-screen / scroll-region boundaries.
- `terminal-rebuild-no-byte-loss.spec.ts`: `chatty` scenario. Trigger a rebuild during high byte rate; verify final state matches raw-byte ground truth.

### CI wiring

- Add `cargo test -p fbi-term-core` as a required check in `.github/workflows/ci.yml`.
- New Playwright specs run automatically as part of the existing Quantico suite — no workflow changes beyond adding files.
- Existing `quantico-fidelity.yml` (live-Claude probe) is unchanged — orthogonal concern.

### Deferred

- Property-based fuzz of arbitrary ANSI against both implementations.
- Production-traffic capture for corpus growth.
- Visual screenshot diffing (we compare normalized grid state, not pixels — robust to font rendering noise).

## 9. Migration sequence (single PR)

One PR, multiple commits for reviewability:

1. `feat(fbi-term): add Rust core crate with alacritty_terminal grid + checkpoint store`
2. `feat(quantico): add 8 terminal-correctness scenarios + --capture-bytes flag`
3. `test(fbi-term): native diff harness against @xterm/headless`
4. `feat(fbi-term): Rustler NIF wrapper + Elixir module`
5. `feat(orchestrator): viewer registry + last-focused-wins resize policy`
6. `feat(orchestrator): integrate fbi-term NIF, replace ScreenState`
7. `feat(ws): honor re-hello, focus, blur, implicit focus on stdin`
8. `feat(transcript): auto-prepend mode-state for non-zero-start ranges`
9. `refactor(controller): byte-buffering during rebuild + delete reclaim loop`
10. `feat(web): focus events, takeover banner, dim-mismatch scroll`
11. `test(e2e): terminal correctness Playwright specs`
12. `chore: delete ScreenState module + remove dead deps`
13. `docs: supersede prior terminal-robustness specs`

Bisectable: each commit compiles and passes its own tests. The behavior cutover is at commit 6; commits 7–10 layer on the new capabilities and bug fixes.

CI gates: `cargo test -p fbi-term-core` (added at commit 3), `mix test` (passes throughout), Playwright suite (passes from commit 10 onward; new specs in commit 11 must pass).

No flag-gated cutover, no parallel-run mode. The diff harness in commits 1–3 is the gate; once it passes, the integration is safe to merge.

## 10. Error handling

- **NIF panics**: `panic = "abort"` in release; `catch_unwind` at every NIF boundary. Caught panic returns `{:error, :nif_panic}`; RunServer marks the run failed with `error: "terminal parser crashed"`. Telemetry counter `fbi_term.nif_panic` increments. BEAM survives.
- **Malformed PTY input**: absorbed by `alacritty_terminal`. Verified end-to-end by the `garbled` Quantico scenario.
- **Container resize fails**: logged at `:warn`. The grid is resized regardless; the next focused-viewer reconnect retries.
- **Empty grid on reattach**: deliberate v1 limitation. Snapshot is empty until live bytes flow in. Acceptable: matches today's behavior.
- **WS handler crashes**: each viewer is its own process. `RunServer` monitors WS pids and synthesizes `viewer_left` on `:DOWN`; standard OTP pattern.
- **NIF resource leaks**: ResourceArc reclaimed by BEAM GC. Bounded by RunServer lifecycles, which already have correct termination semantics.

## 11. Why not alternatives

- **Pure-Elixir port of just the ModeScanner** (~150 LOC). Fixes ~70% of the visible bugs at low cost, but leaves the snapshot empty (Bug 1 unresolved) and doesn't establish server-side cell state for future capabilities. Considered as a tactical option; rejected because we'd have to do the architectural work eventually anyway and pre-alpha is the right time.

- **Rust as Erlang Port (long-running child process)**. Avoids panic-can-crash-BEAM risk. Adds IPC overhead (microseconds — fine at our byte rates) and a small wire protocol to maintain. NIF is preferred because byte rates are tiny, the panic boundary is well-managed via `catch_unwind`, and the resource model maps cleanly to "one parser per run."

- **`vt100` crate instead of `alacritty_terminal`**. More minimal, ships a `contents_formatted()` close to SerializeAddon. Less complete xterm coverage; more parity gaps to surface in the diff harness. Rejected because parity-gap risk dominates the simplicity win.

- **`wezterm-term` crate instead of `alacritty_terminal`**. Most complete option; includes kitty graphics, sixel, every escape. Vendoring is non-trivial because of tight coupling to wezterm's broader workspace. Rejected as overkill for our needs; remains a fallback if `alacritty_terminal` shows critical fidelity gaps.

- **Cell-diff wire protocol**. Bandwidth win; adds custom client renderer and breaks protocol compatibility. Deferred — nothing about the chosen design precludes adding it later.

- **Max-wins resize policy instead of last-focused-wins**. Simpler (stateless), but a single big monitor inflates the size for everyone even when the primary user is on a smaller screen. Rejected because the agent-driven workflow has an implicit primary user; predictable focus behavior matters more than statelessness.

- **Flag-gated rollout with parallel ETS-and-Rust paths**. Safer for production systems; we have no production users. The "ETS fallback" path becomes a place where bugs hide. Rejected because rip-and-replace forces deletion (which is half the value of this rewrite) and the diff harness is a stronger guarantee than runtime fallback.

- **Multi-PR series instead of single PR**. Cleaner from a code-review-team-process perspective; we have no team. Single PR keeps the rewrite atomic and bisectable via individual commits.

## 12. Open questions / risks

1. **`alacritty_terminal` API stability**: the design assumes a clean `Term` API; PR implementation will verify and absorb any wrapper complexity in `cli/fbi-term-core/`. If the crate's API changes between versions, we pin to a known-good version.

2. **`@xterm/headless` reference fidelity**: where xterm.js diverges from xterm-spec, our parser will match xterm.js (the correct choice for our use case). Documented in the diff harness README.

3. **Grid normalization for diff comparison**: blank-cell canonicalization, SGR coalescing, trailing-blank trimming — worked out during diff harness implementation.

4. **Cross-compile burden**: Linux x86_64 only at v1. macOS targets added when desktop app embeds the server in-process.

5. **Memory cap**: ~200 KB per parser. At 1000 concurrent runs, ~200 MB. Acceptable. Tighter eviction (drop parser at `mark_finished` rather than at `RunServer.terminate`) is a future optimization.

6. **Initial focus on first viewer**: implicit, no banner shown. If this turns out to be a UX surprise, adding a "you have focus" indicator is a small follow-up.

## 13. Testing strategy

- `cargo test -p fbi-term-core` — unit tests on the Rust core, including the native diff harness against `@xterm/headless`. Required CI gate.
- `mix test` — Elixir tests including a smoke test for `FBI.Terminal` NIF round-trip and an integration test for `RunServer` viewer registry / focus state machine.
- `tests/e2e/quantico/` — Playwright specs for the new scenarios + takeover banner + chunk load + rebuild-no-byte-loss. Required CI gate.

Test execution time targets:
- `cargo test`: ≤30 seconds.
- `mix test`: continues at current runtime.
- Playwright Quantico suite: ≤5 minutes total (each new spec ≤30 seconds).
