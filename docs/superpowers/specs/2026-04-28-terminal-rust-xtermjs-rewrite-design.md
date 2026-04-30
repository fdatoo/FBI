# Terminal Rust + xterm.js Rewrite — design

**Date:** 2026-04-28
**Project:** FBI
**Status:** approved (design)
**Supersedes:** [2026-04-28-ghostty-web-migration-design.md](2026-04-28-ghostty-web-migration-design.md), [2026-04-26-terminal-rust-rewrite-design.md](2026-04-26-terminal-rust-rewrite-design.md) (server-side and client-side terminal layers)

## 1. Overview

The current terminal stack is the result of five architectural revisions over the last week (Apr 22 robustness, Apr 23 hardening, Apr 23 robust redesign, Apr 26 Rust rewrite, Apr 28 ghostty-web migration). Each pass addressed real problems but added scaffolding. The result is a working but heavy implementation: ~880 LoC of Zig, a manual `erl_nif.h` NIF binding, a libghostty-vt dependency that drags Zig into the build toolchain, and a client controller that juggles three byte sources (WS bytes, WS snapshot frames, HTTP transcript fetch) plus a multi-viewer focus state machine.

This rewrite simplifies along three axes simultaneously:

1. **Toolchain:** `cli/fbi-term-core/` migrates from Zig to Rust, joining `cli/quantico/` and `cli/fbi-tunnel/` as workspace members. Server-side terminal emulation switches from libghostty-vt to `alacritty_terminal`. Client-side renderer switches from `ghostty-web` to `xterm.js + @xterm/addon-webgl`.

2. **Multi-viewer machinery deletes.** The viewer registry, focus/blur/focus_state WS frames, takeover banner, and "synthesize focus on stdin" hack all delete. The server tracks one `driving_pid` per run; subsequent connections are read-only mirrors with no takeover UI.

3. **Lazy-bounded scrollback.** The full-transcript-on-mount fetch is replaced with a bounded Range fetch capped at 5 MB (matching xterm.js's configured 50,000-line scrollback). The mount-time rebuild becomes a bounded operation regardless of run length, eliminating the "render everything at once and fall behind" flashing that plagued earlier iterations.

The Elixir API surface (`FBI.Terminal.new/feed/snapshot/snapshot_at/resize/feed_file`) is preserved bit-identically. `RunServer`, `TranscriptController`, `ShellWSHandler` (after C-kill cuts) keep their existing call sites. The wire protocol drops the `focus` and `blur` C→S frames entirely and renames `focus_state` to `driver_state` S→C; typed events (`usage`, `state`, `title`, `changes`) are preserved.

### Goals

- Replace the Zig server-side parser with a Rust crate, standardizing the cli/ workspace on a single toolchain shared with quantico and fbi-tunnel.
- Replace ghostty-web with xterm.js + @xterm/addon-webgl, adopting a more mature and broadly-supported renderer.
- Delete multi-viewer / focus-tracking / takeover machinery. Single-driver model.
- Bound the mount-time history rebuild to ≤5 MB regardless of run length, eliminating boot-time flashing.
- Preserve cell-accurate snapshot behavior on reconnect (the original A requirement) and full mode-state correctness (DECSTBM, alt-screen, mouse modes — the F-keep requirement).
- Restore a full-grid-state diff harness against `@xterm/headless` as the per-PR correctness gate.

### Non-goals

- Changes to the HTTP transcript Range API contract. The `Range` header semantics, the `X-Transcript-Total` and `X-Transcript-Mode-Prefix-Bytes` response headers, and the mode-prefix prepending logic are preserved.
- Changes to PubSub topic names or RunServer-internal message shapes beyond the C-kill deletions.
- Server-rendered images, server-side full-text search, or any future-feature scaffolding. (Server-side cell state is preserved precisely so future features like search remain feasible without further architectural change.)
- Multi-user / multi-driver browser tabs. Explicitly removed.
- Lazy-into-scrollback chunked replay as the user scrolls up. xterm.js cannot prepend lines to its buffer; this approach is architecturally unavailable. The bounded mount fetch + ample scrollback is the alternative.
- Sixel / kitty graphics. Out of scope, as in prior specs.
- Replaying the persisted log tail on RunServer reattach. `feed_file` is preserved but the surrounding behavior is unchanged.
- Cross-compiling the NIF for desktop-app embedding. Linux x86_64 is the v1 target; macOS arm64 added when desktop embedding lands.

## 2. Architecture

```
BEFORE (post-Apr 28 ghostty-web migration)
  ghostty-web (Canvas/WASM)  ─ WebSocket ─→  fbi-term-core (Zig + libghostty-vt)
                                                    ↑ manual erl_nif.h NIF
                                              FBI.Terminal (Elixir)
                                                    ↑
                              ViewerRegistry, focus tracking, takeover banner

AFTER
  xterm.js + addon-webgl     ─ WebSocket ─→  fbi-term-core (Rust + alacritty_terminal)
                                                    ↑ Rustler NIF
                                              FBI.Terminal (Elixir, API unchanged)
                                                    ↑
                              single driving_pid; secondary tabs read-only

  CI: Rust harness ↔ Node @xterm/headless reference (full grid-state parity per fixture)
```

`FBI.Terminal`'s `@spec` signatures are preserved exactly. `RunServer`, the WS handler, and the HTTP transcript Range API keep their existing structure (with C-kill deletions).

### What gets deleted

- `cli/fbi-term-core/src/*.zig` (all Zig sources).
- `cli/fbi-term-core/build.zig`, `build.zig.zon`, `Makefile` (Zig build wiring).
- `:elixir_make` from `server-elixir/mix.exs` (replaced by `:rustler`).
- `RunServer.ViewerRegistry` field and the five `viewer_*` callbacks (~150 LoC).
- The `:focus_state` PubSub broadcast and event handlers.
- `src/web/components/TerminalTakeoverBanner.tsx` (95 LoC).
- The `useFocusState` hook usage in `Terminal.tsx`.
- The `visibilitychange → sendFocus/sendBlur` handler in `terminalController.ts`.
- The `isFocused` state, "synthesize focus on stdin" branch, dim-mismatch banner.
- `ghostty-web` dependency from `package.json`.
- WS protocol: `focus`, `blur`, `focus_state` text frames.

## 3. Server-side: Rust crate

### Layout

```
cli/fbi-term-core/
  Cargo.toml             # rustler, alacritty_terminal, vte (transitive), serde, serde_json
  src/
    lib.rs               # public API: Parser, Snapshot, ModePrefix
    parser.rs            # alacritty_terminal::Term wrapper (feed/snapshot/resize)
    modes.rs             # mode-state scanner (port of modes.zig)
    checkpoint.rs        # 256 KB checkpoint store (port of checkpoint.zig)
    serialize.rs         # grid → ANSI replay (port of serialize.zig)
    nif.rs               # Rustler NIF exports
  tests/
    fixtures/            # bytes captured via `quantico --capture-bytes`
    diff_xterm.rs        # full-grid parity vs @xterm/headless
    support/
      xterm_ref.mjs      # Node script: import @xterm/headless, dump grid
```

Workspace member alongside `cli/fbi-tunnel/` and `cli/quantico/`. `[workspace]` in the top-level `Cargo.toml` adds `cli/fbi-term-core` as a member.

### Public API (Rust)

```rust
pub struct Parser { /* opaque */ }

pub struct Snapshot {
    pub ansi: Vec<u8>,       // modes + grid + final CUP
    pub cols: u16,
    pub rows: u16,
    pub byte_offset: u64,    // total bytes consumed up to this snapshot
}

pub struct ModePrefix {
    pub ansi: Vec<u8>,       // modes-only ANSI (no cell content)
}

impl Parser {
    pub fn new(cols: u16, rows: u16) -> Self;
    pub fn feed(&mut self, bytes: &[u8]);
    pub fn snapshot(&self) -> Snapshot;
    pub fn snapshot_at(&self, byte_offset: u64) -> ModePrefix;
    pub fn resize(&mut self, cols: u16, rows: u16);
}
```

Mode-state checkpointing semantics (every 256 KB, `snapshot_at` replay) are preserved from the Zig implementation. `serialize.rs` walks the alacritty grid and emits ANSI:

- Per-row iteration: trim trailing default-attribute blanks.
- SGR delta encoding: emit `\e[0m` reset only when transitioning out of a flag state.
- Wide cells: emit codepoint at the wide cell, skip the spacer_tail.
- Final CUP: `\e[{cy+1};{cx+1}H`.

### Rustler NIF

```rust
#[rustler::nif(schedule = "DirtyIo")]
fn feed(handle: ResourceArc<ParserResource>, bytes: Binary) -> Atom;

#[rustler::nif]
fn new(cols: u32, rows: u32) -> ResourceArc<ParserResource>;

#[rustler::nif]
fn snapshot(handle: ResourceArc<ParserResource>) -> NifResult<SnapshotTerm>;

#[rustler::nif]
fn snapshot_at(handle: ResourceArc<ParserResource>, offset: u64) -> NifResult<ModePrefixTerm>;

#[rustler::nif]
fn resize(handle: ResourceArc<ParserResource>, cols: u32, rows: u32) -> Atom;

rustler::init!(
    "Elixir.FBI.Terminal",
    [new, feed, snapshot, snapshot_at, resize],
    load = on_load
);
```

`ParserResource` is `Mutex<Parser>` wrapped in `ResourceArc`. Lifetime semantics match the prior Zig implementation: BEAM GC reclaims when the last reference drops (typically when `RunServer` terminates).

### Panic safety

`#[rustler::nif]` already wraps each call in `catch_unwind`. A panic inside the NIF returns an Erlang exception rather than crashing the BEAM. `FBI.Terminal` callers handle the exception with the same `{:error, :nif_panic}` semantics they use today.

### Build wiring

`server-elixir/mix.exs`:

```elixir
defp deps do
  [
    # ...
    {:rustler, "~> 0.32"},
    # remove: {:elixir_make, "~> 0.7"}
  ]
end
```

`server-elixir/lib/fbi/terminal.ex`:

```elixir
defmodule FBI.Terminal do
  use Rustler, otp_app: :fbi, crate: "fbi_term_core", path: "../cli/fbi-term-core"
  # @spec signatures preserved exactly
end
```

Rustler invokes `cargo build` against the workspace member, copies the `.so` to the OTP app's priv directory under the same path the current code loads from. The `priv/native/fbi_term.so` path is preserved via Rustler's standard layout.

## 4. Client-side: xterm.js + WebGL

### Dependency changes

`package.json`:
- Remove: `ghostty-web`.
- Add: `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`.
- Keep: `@xterm/headless` (test dep, used by the diff harness).
- Remove: `@xterm/addon-serialize`, `@xterm/addon-web-links` (vestigial from prior architecture, unused).

### Terminal.tsx

Reverts to xterm.js initialization:

```tsx
const term = new Terminal({
  fontFamily: '...',
  fontSize: 13,
  theme: readTheme(),
  cursorBlink: false,
  scrollback: 50000,        // bounded scrollback budget
  convertEol: true,
});
term.loadAddon(new WebglAddon());
term.loadAddon(new FitAddon());
term.open(host);
```

WebglAddon falls back to Canvas2D internally if WebGL is unavailable; no manual fallback code needed.

Test hooks port:
```tsx
(window as any).__fbiTerminalText = () => {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.baseY + term.rows; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').trimEnd();
};
(window as any).__fbiIsAtBottom = () =>
  term.buffer.active.viewportY === term.buffer.active.baseY;
```

The `await ghosttyReady` WASM init disappears entirely. ResizeObserver / FitAddon resize handling stays; `term.onScroll` callback signature differs slightly between ghostty-web and xterm.js (param shape) — adjusted in-place.

### terminalController.ts simplifications

Deletions:
- `unsubVisibility`, `visibilityHandler` — no more focus/blur on tab switch.
- `isFocused` field and the `if (!this.isFocused) this.shell.sendFocus()` synthesis branch in input handler.
- The `focus_state` event handler in the typed-event router.
- The `nudgePending` / `scheduleCursorRedraw` workaround (a ghostty-web-specific fix, drop after e2e suite confirms unnecessary on xterm.js).
- The `requestRedraw` "resize +1, then -1" hack (same — drop pending e2e confirmation).

Modifications:
- `loadHistory` → `loadBoundedHistory`. Single Range request: `Range: bytes=max(0, byte_offset - SCROLLBACK_CAP)-(byte_offset - 1)`. `SCROLLBACK_CAP = 5 * 1024 * 1024` (5 MB).
- The four "ready" signals (`historyLoaded`, `snapshotArrived`, `readySilenceTimer`, `readyCapTimer`) collapse to a single `ready` boolean fired when both snapshot is parsed AND bounded history is applied.
- `setRebuilding` / `liveTailBytes` / `pendingResumePromise` retained, but exercised only once (during mount rebuild). Pause/resume uses them only for scroll-up byte buffering, not for history-fetch coordination.

Pause/resume (E-keep) behavior is preserved: scrolling up pauses the live stream, buffering bytes; scrolling back to bottom drains the buffer. No changes to user-visible behavior.

Net controller LoC: ~411 → ~250.

## 5. Lazy-bounded scrollback

xterm.js cannot prepend lines to its scrollback buffer (the API is append-only at the cursor; old content scrolls off the top). "Lazy" therefore means: bound the mount-time history fetch, never rebuild after mount.

### Mount flow

1. WS opens; client sends `{type: "hello", cols, rows}`.
2. Server replies with `{type: "snapshot", ansi, cols, rows, byte_offset: N}`. Snapshot is the cell-accurate current screen (~10 KB ANSI).
3. Client: `term.reset(); term.write(snap.ansi); term.scrollToBottom()`. Terminal is interactive.
4. **Background**, in parallel with live byte streaming over WS:
   - Client fetches `GET /api/runs/:id/transcript` with `Range: bytes=max(0, N - SCROLLBACK_CAP)-(N - 1)`.
   - Server responds with `[mode_prefix from snapshot_at(start)] + log_bytes_in_range`.
5. Live WS bytes that arrive during the fetch are buffered in `liveTailBytes`. The terminal host's `visibility` is set to `hidden` while rebuild is in progress.
6. On fetch complete, single rebuild:
   - `term.reset()`
   - `term.write(history_with_prefix)`
   - `term.write(buffered_live)`
   - `term.scrollToBottom()`
   - `host.style.visibility = ''`
7. `liveTailBytes` is cleared. Subsequent live bytes append directly. **No further rebuilds, ever.**

### Why this kills the flashing

- The mount rebuild is bounded at ≤5 MB regardless of run length. WebGL processes 5 MB of bytes in ~100-300 ms on commodity hardware.
- Rebuild happens exactly once per mount. Pause/resume, scroll, viewport changes, focus changes — none trigger a rebuild.
- The terminal is hidden during rebuild (single visibility flip), then revealed. User sees: snapshot paints → brief blank → fully populated scrollback. No incremental fill-in flicker.

### Edge cases

- Run shorter than CAP: `start` clamps to 0, server returns the full log. Range request handles this naturally.
- WS disconnect during fetch: client cancels the HTTP request on disposal.
- Terminal pre-mount: `getLastSnapshot(runId)` cache (in `shellRegistry.ts`) is checked first to avoid waiting for the WS hello round-trip when navigating back to a run. Same as today.

## 6. Single-driver model

`RunServer` tracks one `driving_pid` per run. The first WS connection to a run with no current driver becomes the driver. Subsequent connections receive snapshot frames + live byte broadcasts but their inbound binary frames (stdin) are dropped server-side.

When the driver disconnects, the next-connected mirror (if any) is promoted to driver via a `driver_promoted` PubSub event; the WS handler re-evaluates input acceptance.

Resize policy: the driver's WS dictates the PTY size. Mirror connections' `resize` frames are accepted into a per-connection `cols x rows` field used only for snapshot rendering on that connection — they do not propagate to the PTY.

Client-side: a small read-only "viewing" indicator on non-driving tabs (~20 LoC, uses existing `Pill` primitive). No takeover button; closing the driver's tab is the only way to hand off.

### WS protocol final shape

```
C → S text:
  {"type":"hello",  "cols":N, "rows":M}
  {"type":"resize", "cols":N, "rows":M}

C → S binary:
  raw stdin bytes (dropped if not driver)

S → C text:
  {"type":"snapshot", "ansi":..., "cols":N, "rows":M, "byte_offset":K}
  {"type":"driver_state", "is_driver":bool}
  typed events: usage / state / title / changes (unchanged)

S → C binary:
  raw PTY bytes
```

Three text-message types in each direction (down from seven C→S and six S→C in the current protocol). The `driver_state` frame replaces `focus_state` and is sent only on initial connection and when the driver changes.

## 7. Diff harness

Full grid-state parity per fixture, regenerated and verified on every commit.

### Pipeline

```
1. cli/quantico/scenarios/<name>.yaml
       │
       │  cargo run -p quantico -- --capture-bytes scenarios/<name>.yaml \
       │     --output cli/fbi-term-core/tests/fixtures/<name>.bin
       ▼
2. cli/fbi-term-core/tests/fixtures/<name>.bin
       │
       ├──→ Rust path: alacritty_terminal::Term, dump full grid state as JSON
       │
       └──→ Node path: import @xterm/headless, feed bytes, dump full grid state as JSON
       │
       ▼
3. tests/diff_xterm.rs: assert_eq!(rust_dump, node_dump) after normalization
```

### State captured

For each test:
- Every cell at `(row, col)`: codepoint, fg color, bg color, bold/italic/inverse/underline/strikethrough/dim flags, wide-state.
- Cursor position `(row, col)`, visibility (DECTCEM).
- Active buffer (main vs alt-screen).
- Scroll region `(top, bottom)` (DECSTBM).
- Auto-wrap (DECAWM), bracketed paste, focus reporting, in-band resize flags.
- Mouse mode + extension state.

### Normalization

- Empty cells canonicalized to default-attribute space.
- Trailing default-attribute cells per row trimmed.
- SGR equivalence: `bold + dim` collapses to canonical order.
- Color: palette-256 colors that map to RGB canonicalized to palette form.

### Fixtures used

The full set in `cli/quantico/scenarios/`: `alt-screen-cycle`, `bracketed-paste-cycle`, `chatty`, `cjk-wide`, `crash-fast`, `cursor-styles`, `default`, `env-echo`, `garbled`, `hang`, `limit-breach-human`, `limit-breach`, `mouse-modes-cycle`, `plugin-fail`, `resume-aware`, `scroll-region-stress`, `scrollback-stress`, `slow-startup`, `tool-heavy`, `truecolor`. Twenty fixtures, covering F-keep matrix.

### CI gates

- `cargo test -p fbi-term-core` — diff harness must pass.
- `mix test` — Elixir tests including `FBI.Terminal` NIF round-trip smoke tests.
- `npm test` — Vitest unit tests including `Terminal.test.tsx` and `terminalController.test.ts`.
- `npm run e2e` — Playwright suite at `tests/e2e/quantico/` (24 specs minus the takeover spec).

## 8. Migration sequencing

Single PR, atomic cutover, no flag gate. Same model as the Apr 26 and Apr 28 rewrites.

### Commit sequence

```
01  feat(fbi-term-core): scaffold Rust crate alongside Zig (not wired)
02  feat(fbi-term-core): port modes.rs from modes.zig
03  feat(fbi-term-core): port checkpoint.rs from checkpoint.zig
04  feat(fbi-term-core): alacritty_terminal-backed parser.rs
05  feat(fbi-term-core): port serialize.rs from serialize.zig
06  feat(fbi-term-core): Rustler NIF nif.rs with FBI.Terminal-shaped exports
07  test(fbi-term-core): diff harness vs @xterm/headless — gate on green
08  build(server-elixir): swap :elixir_make → :rustler
09  chore(fbi-term-core): delete Zig sources, build.zig, build.zig.zon, Makefile
10  build(web): replace ghostty-web with @xterm/xterm + addon-webgl + addon-fit
11  feat(web): port Terminal.tsx from ghostty-web to xterm.js
12  refactor(orchestrator): delete ViewerRegistry, single driving_pid
13  refactor(ws): shrink protocol — drop focus/blur/focus_state frames
14  refactor(web): delete TerminalTakeoverBanner, focus state machine
15  feat(web): bounded transcript fetch (Range CAP=5MB) on mount
16  refactor(controller): collapse rebuild flags, single ready boolean
17  test(e2e): drop takeover spec, update fetch-related specs for bounded mode
18  docs: update README, design specs index, CLAUDE.md if needed
```

### Pre-merge gates

- All four test commands above pass.
- Manual smoke: open a long-running mock claude run (use `quantico` `scrollback-stress` scenario), mount the page, confirm no flashing.
- Manual smoke: open two tabs on the same run, confirm tab #2 shows "viewing only" and stdin is dropped.

### Server-host install impact

`scripts/install.sh` currently expects `zig` for `mix compile`. After this change it expects `cargo`.

Decision: install.sh installs rustup if missing (one-line via `rustup-init -y --default-toolchain stable --profile minimal`). README updated in commit 18. `rustler_precompiled` deferred — adds release-time complexity; not worth it for a personal-tool deploy.

### Rollback

`git revert` the merge commit. No flag-gated parallel paths.

## 9. Testing

### Rust

`cargo test -p fbi-term-core`:
- Unit tests on `parser.rs`: feed/snapshot/resize round-trips.
- Unit tests on `modes.rs`: mode-state transitions match Zig implementation byte-for-byte (port the existing Zig tests).
- Unit tests on `checkpoint.rs`: checkpoint store invariants (port).
- Integration test `diff_xterm.rs`: full-grid parity against `@xterm/headless` for all fixtures.

### Elixir

`mix test`:
- `FBI.Terminal` NIF round-trip: `new → feed → snapshot → resize → snapshot` with assertions on returned binary contents.
- `RunServer` tests updated for single-driver model (no viewer registry assertions).
- `ShellWSHandler` tests updated for shrunk protocol (no focus/blur frames).
- `TranscriptController` tests unchanged (Range API is preserved).

### Web

`npm test` (Vitest):
- `Terminal.test.tsx`: mount with mocked WS, assert snapshot writes happen, bounded fetch fires, rebuild completes, `ready` fires.
- `terminalController.test.ts`: pause/resume on scroll, single-rebuild semantics, no rebuild on subsequent scroll events.
- Existing `useRunWatcher`, `scrollDetection` tests unchanged.

### E2E

`npm run e2e` (Playwright at `tests/e2e/quantico/`):
- Drop: `terminal-takeover-banner.spec.ts`.
- Update: `terminal-rebuild-no-byte-loss.spec.ts` for bounded-fetch semantics. Verify a long `scrollback-stress` run still shows zero byte loss across the bounded window.
- Update: `terminal-chunk-load.spec.ts` — no longer about chunked fetch (deleted concept). Repurpose to verify bounded mount fetch is correctly applied.
- Unchanged: `default`, `ansi`, `garbled`, `auto-scroll`, `terminal-cjk-wide`, `terminal-truecolor`, `terminal-cursor-styles`, `terminal-bracketed-paste-cycle`, `terminal-alt-screen-cycle`, `terminal-mouse-modes-cycle`, `terminal-scroll-region-stress`, `terminal-no-redraw-cascade`, `env-echo`, `crash`, `limit-resume`, `resume-aware`.

## 10. Risks and open questions

### Risk: parser drift between alacritty_terminal and @xterm/headless

The April 28 ghostty-web migration explicitly cited "we have a diff harness AND it's a maintenance burden AND we still hit divergence in production" as a reason to abandon the Apr 26 architecture. This rewrite reintroduces that risk.

Mitigations:
- The harness is full grid-state parity (stricter than the prior cell-only diff).
- C-kill removes the multi-viewer reconcile path, reducing the surface where divergence could manifest.
- Snapshot ANSI is serialized from the server's grid (clean ANSI), not echoed PTY bytes — divergence is bounded to the snapshot serialization step.
- Live PTY bytes flow passthrough; both server and client parse the same bytes the same way (within parser drift bounds).

Escape valve: if drift becomes an ongoing pain, replace `alacritty_terminal` with a Rust crate that FFIs to libghostty's C API. Reintroduces Zig as a build-time dependency (libghostty is built via Zig) but contained inside the Rust crate's `build.rs`. Not pursued in v1 because libghostty's C API stability is uncertain and the build.rs orchestration is non-trivial.

### Risk: WebGL rendering quirks

xterm.js's WebGL renderer has known issues with non-Latin scripts, certain underline styles, and ligatures. None should affect claude TUI output (monospace, Latin + CJK + emoji, no ligatures). The harness pins these via fixtures; e2e visual regression is caught via Playwright.

### Risk: Rustler precompilation not available

If a developer working on the project doesn't have `cargo` installed, `mix compile` fails. `rustler_precompiled` would solve this but adds release-pipeline complexity. Decision: install.sh installs rustup if missing; document the dependency in README; defer precompilation.

### Open question: SCROLLBACK_CAP tuning

5 MB / 50,000 lines is a starting point. May need adjustment based on real claude runs:
- Too small: user sees less history than feels natural for long-running agents.
- Too large: mount rebuild duration grows; WebGL processing time becomes user-visible again.

Tune via real-world usage; revisit if mount-time rebuild approaches 500 ms on a representative run.

### Open question: precompile NIF for production

Production servers (`scripts/install.sh`) currently get `mix compile`-time NIF builds. Rustler's `rustler_precompiled` ships binaries via GitHub Releases, eliminating per-host cargo. For a single-user / single-server FBI deployment this is overkill. Defer; revisit if multi-host deployment becomes a thing.

## 11. Alternatives considered

- **Keep Zig, just delete C-kill machinery.** Smaller diff (~1,200 LoC removed), no toolchain pain addressed. Rejected because user explicitly stated relief at moving to Rust to standardize with quantico and tauri.

- **Keep Zig + ghostty-web, just delete C-kill machinery + fix bounded fetch.** Smaller still. Rejected for same reason; ghostty-web is also young/under-supported per user input.

- **WS-based chunk fetch instead of HTTP Range.** Collapse all transports to WebSocket. Rejected because WS-as-RPC adds complexity that exceeds the gain. HTTP Range is well-suited to the request/response shape and maps cleanly to browser semantics.

- **`vt100` crate instead of `alacritty_terminal`.** More minimal, smaller surface. Rejected: less complete xterm coverage means more parity gaps to debug via the harness.

- **`wezterm-term` crate instead of `alacritty_terminal`.** Most complete option. Rejected: vendoring is non-trivial due to tight coupling to the wezterm workspace; overkill for current needs. Remains a fallback if `alacritty_terminal` shows critical fidelity gaps.

- **libghostty C-FFI in Rust.** Preserves Apr 28 parser-on-both-sides parity. Rejected: build.rs would need to invoke Zig to build libghostty as a static library — same Zig-in-the-build pain, hidden behind a Rust facade. Reconsider if `alacritty_terminal` parity proves insufficient in practice.

- **Lazy-into-scrollback chunked replay (user scrolls up, fetch chunk, splice into top).** xterm.js cannot prepend; this approach is architecturally unavailable. Bounded mount fetch is the pragmatic alternative.

- **Two stitched xterm.js viewports (one history, one live).** Architecturally elegant for true unbounded scrollback. Rejected: complexity outweighs benefit. Bounded scrollback covers ~all real-world claude runs; long-tail full transcripts can be served as a separate download endpoint later if a real need emerges.

- **Rustler precompiled NIFs.** Eliminates `cargo` from production hosts. Deferred until multi-host deployment is a real requirement.

- **Multi-PR series instead of single PR.** Cleaner per-step review; no team review process exists. Single PR keeps the rewrite atomic and bisectable via individual commits.
