# Terminal Rust Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Elixir terminal pipeline (broken `\e[2J\e[H`-only snapshots, missing mode tracking, smallest-viewport-wins resize thrash) with a server-side cell-accurate terminal emulator written in Rust, exposed via Rustler NIF. Add last-focused-wins resize policy and takeover-banner UX. Delete the existing `ScreenState` module entirely.

**Architecture:** Two new Rust crates in the existing workspace — `cli/fbi-term-core` (pure logic, alacritty_terminal-based) and `server-elixir/native/fbi_term` (Rustler cdylib wrapping the core). The Elixir `RunServer` GenServer holds a `ResourceArc<Mutex<Parser>>` handle for each run's lifetime, replacing the `:fbi_screen_state` ETS table. New `Viewer` struct in `RunServer` state tracks per-WS-connection dims and focus state. WS handler honors re-hello (currently silently dropped), accepts `focus`/`blur` text frames, and synthesizes focus on stdin. Snapshots are full grid replays via `modes + serialize() + CUP`. HTTP transcript Range API auto-prepends mode-state-at-offset for non-zero-start chunks. Frontend cleans up the byte-drop-during-rebuild bug and adds a takeover banner. Diff harness extends Quantico with eight terminal-correctness scenarios, gated by a native Rust test that diffs against `@xterm/headless`.

**Tech Stack:** Rust (alacritty_terminal, vte, rustler), Elixir/Phoenix (Rustler 0.34+, ResourceArc), TypeScript/React (xterm.js, Playwright), Quantico YAML scenarios.

**Spec:** [docs/superpowers/specs/2026-04-26-terminal-rust-rewrite-design.md](../specs/2026-04-26-terminal-rust-rewrite-design.md)

---

## File Map

**Created:**
- `cli/fbi-term-core/Cargo.toml`
- `cli/fbi-term-core/src/lib.rs`
- `cli/fbi-term-core/src/parser.rs` — wraps `alacritty_terminal::Term`
- `cli/fbi-term-core/src/modes.rs` — DEC mode tracker
- `cli/fbi-term-core/src/checkpoint.rs` — byte-offset → mode-state index
- `cli/fbi-term-core/src/serialize.rs` — grid + modes → ANSI replay
- `cli/fbi-term-core/tests/diff_xterm.rs` — native diff harness
- `cli/fbi-term-core/tests/support/xterm_ref.mjs` — `@xterm/headless` reference dump
- `cli/fbi-term-core/tests/fixtures/*.bin` — captured Quantico scenario byte streams
- `cli/quantico/scenarios/alt-screen-cycle.yaml`
- `cli/quantico/scenarios/scroll-region-stress.yaml`
- `cli/quantico/scenarios/mouse-modes-cycle.yaml`
- `cli/quantico/scenarios/cjk-wide.yaml`
- `cli/quantico/scenarios/truecolor.yaml`
- `cli/quantico/scenarios/bracketed-paste-cycle.yaml`
- `cli/quantico/scenarios/scrollback-stress.yaml`
- `cli/quantico/scenarios/cursor-styles.yaml`
- `server-elixir/native/fbi_term/Cargo.toml`
- `server-elixir/native/fbi_term/src/lib.rs` — Rustler NIF wrapper
- `server-elixir/lib/fbi/terminal.ex` — Elixir NIF loader
- `server-elixir/lib/fbi/orchestrator/viewer.ex` — Viewer struct
- `server-elixir/test/fbi/terminal_test.exs` — NIF smoke test
- `src/web/components/TerminalTakeoverBanner.tsx` — new banner component
- `tests/e2e/quantico/terminal-alt-screen-cycle.spec.ts`
- `tests/e2e/quantico/terminal-scroll-region.spec.ts`
- `tests/e2e/quantico/terminal-takeover-banner.spec.ts`
- `tests/e2e/quantico/terminal-chunk-load.spec.ts`
- `tests/e2e/quantico/terminal-rebuild-no-byte-loss.spec.ts`

**Modified:**
- `Cargo.toml` (workspace) — add new members
- `cli/quantico/src/argv.rs` and `cli/quantico/src/main.rs` — add `--capture-bytes` flag
- `server-elixir/mix.exs` — add Rustler dep + native config
- `server-elixir/lib/fbi/orchestrator/run_server.ex` — viewer registry, term_handle, on_bytes ordering, resize/focus handlers
- `server-elixir/lib/fbi/orchestrator.ex` — public API for viewer events
- `server-elixir/lib/fbi_web/sockets/shell_ws_handler.ex` — re-hello, focus/blur, real snapshot, synthesized focus
- `server-elixir/lib/fbi_web/controllers/transcript_controller.ex` — auto-prepend mode prefix
- `src/web/lib/terminalController.ts` — byte-buffering fix, delete reclaim loop, focus events, focus_state consumption
- `src/web/lib/ws.ts` — add `sendFocus()` / `sendBlur()` to ShellHandle
- `src/web/components/Terminal.tsx` — mount banner, `overflow: auto`
- `src/shared/types.ts` — `RunWsFocusStateMessage`
- `.github/workflows/ci.yml` — add `cargo test -p fbi-term-core` step

**Deleted:**
- `server-elixir/lib/fbi/orchestrator/screen_state.ex`

---

## Notes for executors

- **Working directory is always `/workspace`.** Per `CLAUDE.md`, `cd /workspace` before any `git` command so the post-commit hook fires.
- **Comment code very well.** This is a multi-week change being landed by an unattended agent overnight. Future readers (humans and agents) need to understand the *why*, not just the *what*. Lean toward more explanation rather than less, especially for the Rust ↔ Elixir boundary, the focus state machine, and the mode-checkpoint replay logic.
- **alacritty_terminal API verification:** the exact API names below are this plan author's best guess from the crate's docs. Task 1.2's first action is to add the dep and run a tiny binary that exercises `Term::new`, `advance_bytes`, `grid()` etc. to verify the actual signatures. If they differ, adapt the rest of the Rust code accordingly — the design contracts are stable; only the function names may vary.
- **Rustler version:** target `rustler 0.34` or whatever is current. Check `mix hex.info rustler` if uncertain.
- **TDD discipline:** every code task starts with a failing test. For Rust, `cargo test` covers it. For Elixir, `mix test`. For TypeScript, `npm run test` (Vitest) or `npx playwright test` (e2e).
- **Frequent commits:** one commit per task, conventional commits prefix matching the spec's commit list (Section 9 of the spec).
- **No flag-gated cutover.** This is a rip-and-replace. The gate is the diff harness in Tasks 3.x; once that passes, the rest is safe to land.
- **If something blocks unexpectedly, fall back to documenting the block and deferring** rather than improvising design changes. The spec is the source of truth for design decisions.

---

## Phase 1: Rust core crate (`cli/fbi-term-core`)

Goal: a self-contained Rust crate that consumes terminal bytes and produces faithful ANSI snapshots, with checkpoint support for chunk loads. No NIF, no Elixir integration yet. Verified by tests against `@xterm/headless`.

### Task 1.1: Workspace bootstrap

**Files:**
- Create: `cli/fbi-term-core/Cargo.toml`
- Create: `cli/fbi-term-core/src/lib.rs`
- Modify: `Cargo.toml` (workspace) — add new member

- [ ] **Step 1: Add the crate to the workspace**

Edit `/workspace/Cargo.toml`:
```toml
[workspace]
members = ["desktop", "cli/fbi-tunnel", "cli/fbi-term-core"]
resolver = "2"
```

- [ ] **Step 2: Create the crate Cargo.toml**

```toml
# /workspace/cli/fbi-term-core/Cargo.toml
[package]
name = "fbi-term-core"
version = "0.1.0"
edition = "2021"

[lib]
path = "src/lib.rs"

[dependencies]
# Pin a known-good version after Task 1.2 verification.
# Initial spike: try latest stable.
alacritty_terminal = "0.24"
vte = "0.13"

[dev-dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 3: Stub lib.rs**

```rust
// /workspace/cli/fbi-term-core/src/lib.rs
//! fbi-term-core
//!
//! Server-side virtual terminal for FBI runs. Consumes raw PTY bytes,
//! maintains a cell-accurate grid via `alacritty_terminal`, and
//! produces ANSI snapshots that the FBI server sends to xterm.js
//! clients on connect / reconnect / focus change.
//!
//! Public API: see `Parser`, `Snapshot`, `ModePrefix`.

pub struct Parser;

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub ansi: String,
    pub cols: u16,
    pub rows: u16,
    pub byte_offset: u64,
}

#[derive(Debug, Clone)]
pub struct ModePrefix {
    pub ansi: String,
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd /workspace && cargo build -p fbi-term-core
```
Expected: success.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add Cargo.toml cli/fbi-term-core/ && \
  git commit -m "$(cat <<'EOF'
feat(fbi-term): bootstrap workspace crate

Empty skeleton wired into the Cargo workspace. Subsequent commits
fill in the alacritty_terminal-backed parser, mode tracker,
checkpoint store, and serializer.
EOF
)"
```

### Task 1.2: Verify alacritty_terminal API and write the first failing parser test

**Files:**
- Create: `cli/fbi-term-core/src/parser.rs`
- Modify: `cli/fbi-term-core/src/lib.rs`

- [ ] **Step 1: Spike — verify the crate's actual API**

Write a throwaway `examples/spike.rs` that creates a `Term`, feeds bytes, and prints grid contents. Run `cargo run -p fbi-term-core --example spike`. Document any divergence from this plan in the file as inline comments.

The expected API surface (verify):
- `alacritty_terminal::Term::new(config, &SizeInfo, event_proxy)`
- `term.advance_bytes(bytes)` or via `vte::Parser` driving a `Performer`
- `term.grid()` → `&Grid<Cell>`
- `term.cursor()` → cursor position

If `Term::new` requires types we don't want to expose, wrap them in our `Parser` struct and absorb the complexity here.

- [ ] **Step 2: Delete the spike, write the first real test**

```rust
// /workspace/cli/fbi-term-core/src/parser.rs
//! Wraps `alacritty_terminal::Term` behind our public `Parser` API.
//!
//! Hides the alacritty type plumbing (config types, event proxy
//! requirement, grid coordinate types) so callers see a clean
//! `feed`/`snapshot`/`resize` surface that can be exposed verbatim
//! through the Rustler NIF.

// Implementation goes here in Step 4.
```

```rust
// /workspace/cli/fbi-term-core/tests/parser_basic.rs
use fbi_term_core::Parser;

#[test]
fn parser_dims_default_to_constructor() {
    let p = Parser::new(120, 40);
    assert_eq!(p.cols(), 120);
    assert_eq!(p.rows(), 40);
}

#[test]
fn parser_accepts_feed_without_error() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello\r\nworld\r\n");
    // No panic, no return value to check yet.
}
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /workspace && cargo test -p fbi-term-core --test parser_basic
```
Expected: FAIL — `Parser::new` doesn't exist.

- [ ] **Step 4: Implement minimal `Parser`**

Replace `pub struct Parser;` in `lib.rs` with `mod parser; pub use parser::Parser;`.

In `parser.rs`, implement using the API verified in Step 1:

```rust
use alacritty_terminal::Term;
// Other alacritty imports per the verified API.

/// The server-side virtual terminal for one run.
///
/// Owns an `alacritty_terminal::Term` instance plus our mode tracker
/// and checkpoint store (added in later tasks). All state mutation
/// goes through `feed`; reads via `snapshot` / `snapshot_at` / `cols`
/// / `rows`.
///
/// Not `Send + Sync` by itself — the Rustler wrapper puts it behind
/// a `Mutex`.
pub struct Parser {
    term: Term<EventProxy>,
    cols: u16,
    rows: u16,
    bytes_fed: u64,
    // Added in Task 1.4: modes
    // Added in Task 1.5: checkpoints
}

// Empty event proxy — alacritty fires events for things like bell,
// title changes, clipboard. We ignore them for now.
#[derive(Clone)]
struct EventProxy;
impl alacritty_terminal::event::EventListener for EventProxy {
    fn send_event(&self, _event: alacritty_terminal::event::Event) {}
}

impl Parser {
    pub fn new(cols: u16, rows: u16) -> Self {
        // Construct via the verified alacritty API.
        unimplemented!("filled in per Step 1 verification")
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        // Drive the term's parser. Increments `bytes_fed`.
        unimplemented!()
    }

    pub fn cols(&self) -> u16 { self.cols }
    pub fn rows(&self) -> u16 { self.rows }

    pub fn bytes_fed(&self) -> u64 { self.bytes_fed }
}
```

- [ ] **Step 5: Run test to verify pass**

```bash
cd /workspace && cargo test -p fbi-term-core --test parser_basic
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /workspace && git add cli/fbi-term-core/ && \
  git commit -m "feat(fbi-term): Parser skeleton wraps alacritty_terminal::Term"
```

### Task 1.3: Snapshot from grid

**Files:**
- Create: `cli/fbi-term-core/src/serialize.rs`
- Modify: `cli/fbi-term-core/src/parser.rs` — add `snapshot()`
- Modify: `cli/fbi-term-core/src/lib.rs` — re-export

- [ ] **Step 1: Write the failing test**

```rust
// /workspace/cli/fbi-term-core/tests/snapshot_basic.rs
use fbi_term_core::Parser;

#[test]
fn snapshot_after_simple_text_contains_text() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello world");
    let snap = p.snapshot();
    // After replay through xterm, the visible grid must contain "hello world".
    // We check by re-feeding through a fresh parser and inspecting cells.
    let mut p2 = Parser::new(80, 24);
    p2.feed(snap.ansi.as_bytes());
    // Helper: dump first row as plain string (ignore SGR).
    let row0 = grid_row_as_string(&p2, 0);
    assert!(row0.starts_with("hello world"), "got: {:?}", row0);
}

#[test]
fn snapshot_dims_match_parser_dims() {
    let p = Parser::new(120, 40);
    let snap = p.snapshot();
    assert_eq!(snap.cols, 120);
    assert_eq!(snap.rows, 40);
}

fn grid_row_as_string(_p: &Parser, _row: usize) -> String {
    // Implement via Parser's grid accessor (added below as a test-only helper
    // or via a `#[cfg(test)]` pub-in-crate method).
    unimplemented!()
}
```

- [ ] **Step 2: Implement `snapshot()` and the helper**

In `serialize.rs`, write the grid → ANSI logic:

```rust
//! Serialize the current grid + mode state to ANSI escape sequences.
//!
//! Output goal: when the result is written to a fresh xterm.js terminal
//! at the same dims, the resulting cell grid matches the source grid
//! exactly. Output does NOT need to be byte-identical to xterm.js's
//! own SerializeAddon — only semantically equivalent. The diff harness
//! verifies this.
//!
//! Order:
//!   1. Mode prefix (alt-screen, DECSTBM, DECTCEM, DECAWM, mouse, etc.)
//!      — added by Task 1.4's mode tracker integration.
//!   2. Grid contents row by row, with SGR runs coalesced to minimize
//!      escape-sequence count.
//!   3. Final CUP placing the cursor at its current position.

use crate::parser::Parser;

pub(crate) fn serialize_grid(parser: &Parser) -> String {
    // 1. Walk parser.term.grid()
    // 2. For each cell, track SGR transitions, emit `\e[Nm` codes only on change
    // 3. Emit CRLF between rows (or coalesce trailing blanks)
    // 4. Emit final CUP `\e[<row>;<col>H`
    //
    // Implementation references alacritty_terminal::grid::Grid + Cell.
    // See `vte` for ANSI emission helpers if available, otherwise build
    // the strings manually.
    unimplemented!()
}
```

In `parser.rs`, add:

```rust
impl Parser {
    pub fn snapshot(&self) -> crate::Snapshot {
        let ansi = crate::serialize::serialize_grid(self);
        crate::Snapshot {
            ansi,
            cols: self.cols,
            rows: self.rows,
            byte_offset: self.bytes_fed,
        }
    }

    /// Test-only: read a single row of the grid as a plain UTF-8 string,
    /// stripping all attributes. Used by the snapshot tests.
    #[cfg(test)]
    pub(crate) fn _test_row_string(&self, row: usize) -> String {
        // Walk parser.term.grid() at the given row, collect chars.
        unimplemented!()
    }
}
```

Update the test's `grid_row_as_string` helper to call `p._test_row_string(row)`.

- [ ] **Step 3: Run, fix, run**

```bash
cd /workspace && cargo test -p fbi-term-core
```
Iterate until both tests pass. The serializer is the trickiest part — start with the simplest possible "iterate every cell, emit char, emit CRLF at end of row" version, then optimize to coalesce blanks and SGR runs in Task 1.6.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add cli/fbi-term-core/ && \
  git commit -m "feat(fbi-term): naive grid serializer + snapshot()"
```

### Task 1.4: Mode tracker

**Files:**
- Create: `cli/fbi-term-core/src/modes.rs`
- Modify: `cli/fbi-term-core/src/parser.rs`
- Modify: `cli/fbi-term-core/src/serialize.rs`

- [ ] **Step 1: Failing test for mode preservation**

```rust
// /workspace/cli/fbi-term-core/tests/modes.rs
use fbi_term_core::Parser;

#[test]
fn alt_screen_mode_preserved_in_snapshot() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[?1049h");  // enter alt screen
    p.feed(b"alt content");
    let snap = p.snapshot();
    // Replay snapshot into a fresh parser; alt screen flag must persist.
    let mut p2 = Parser::new(80, 24);
    p2.feed(snap.ansi.as_bytes());
    // Helper: reads the alt-screen flag.
    assert!(p2._test_in_alt_screen(), "snapshot did not preserve ?1049h");
}

#[test]
fn decstbm_scroll_region_preserved() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[5;20r");  // DECSTBM 5..20
    let snap = p.snapshot();
    let mut p2 = Parser::new(80, 24);
    p2.feed(snap.ansi.as_bytes());
    let (top, bot) = p2._test_scroll_region();
    assert_eq!((top, bot), (5, 20));
}
```

- [ ] **Step 2: Implement the mode tracker**

```rust
// /workspace/cli/fbi-term-core/src/modes.rs
//! Tracks ANSI mode state across the byte stream.
//!
//! `alacritty_terminal` already maintains alt-screen and scroll-region
//! state internally, but it does NOT expose them in a form we can emit
//! as a leading-mode prefix in our snapshots. This module mirrors the
//! parser independently — feeds the same byte stream — so we can ask
//! "what modes are active right now?" and emit them.
//!
//! Why not delegate to alacritty's state? Two reasons:
//!   1. The grid serializer needs a mode prefix that comes BEFORE the
//!      cell contents (so xterm enters alt-screen, sets DECSTBM, etc.
//!      before receiving the first cell). Alacritty's grid doesn't
//!      provide this prefix.
//!   2. `snapshot_at(offset)` needs mode state at an arbitrary byte
//!      offset (replay from checkpoint). That's a separate parser
//!      anyway, and using the same code path for "current modes" and
//!      "modes at offset X" is simpler than two implementations.
//!
//! Modes tracked:
//!   - DEC private: ?7 (DECAWM), ?25 (DECTCEM), ?47/?1047/?1049
//!     (alt screen), ?1004 (focus reporting), ?2004 (bracketed paste),
//!     ?2031 (in-band resize), ?1000/?1002/?1003 (mouse), ?1006/?1015/
//!     ?1016 (mouse extension)
//!   - DECSTBM scroll region (CSI Pt;Pb r)
//!
//! Parser is a Williams VT500-series state machine for CSI sequences
//! only — we don't care about cell-modifying sequences here. Survives
//! chunk boundaries. Approach mirrors `src/server/logs/screen.ts`
//! ModeScanner, which has been battle-tested.

#[derive(Clone, Debug)]
pub struct ModeState {
    pub auto_wrap: bool,        // ?7  default true
    pub cursor_visible: bool,   // ?25 default true
    pub alt_screen: bool,       // ?47 / ?1047 / ?1049 default false
    pub focus_reporting: bool,  // ?1004
    pub bracketed_paste: bool,  // ?2004
    pub in_band_resize: bool,   // ?2031
    pub mouse_mode: u16,        // 0 | 1000 | 1002 | 1003
    pub mouse_ext: u16,         // 0 | 1006 | 1015 | 1016
    pub stbm_top: Option<u16>,
    pub stbm_bottom: Option<u16>,
}

impl Default for ModeState {
    fn default() -> Self {
        Self {
            auto_wrap: true,
            cursor_visible: true,
            alt_screen: false,
            focus_reporting: false,
            bracketed_paste: false,
            in_band_resize: false,
            mouse_mode: 0,
            mouse_ext: 0,
            stbm_top: None,
            stbm_bottom: None,
        }
    }
}

#[derive(Clone)]
pub struct ModeScanner {
    pub modes: ModeState,
    state: ScanState,
    csi_private: Option<u8>,
    csi_params: Vec<u8>,
}

#[derive(Clone)]
enum ScanState { Normal, Esc, Csi }

impl ModeScanner {
    pub fn new() -> Self { /* ... */ }

    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.step(b);
        }
    }

    fn step(&mut self, b: u8) { /* state machine */ }
    fn dispatch(&mut self, final_byte: u8) { /* update self.modes */ }

    /// Emit ANSI to replay the current mode state.
    /// `rows` is the current screen height, used to clamp DECSTBM
    /// (a stale region from before resize is clamped to the new height).
    pub fn emit(&self, rows: u16) -> String {
        let mut out = String::new();
        // Buffer first — ?1049h enters AND clears alt; for main, emit
        // ?1049l + clear explicitly so client lands in main with a
        // known cursor + screen state.
        if self.modes.alt_screen {
            out.push_str("\x1b[?1049h");
        } else {
            out.push_str("\x1b[?1049l\x1b[H\x1b[2J");
        }
        if let (Some(top), Some(bot)) = (self.modes.stbm_top, self.modes.stbm_bottom) {
            let top = top.max(1).min(rows);
            let bot = bot.max(top).min(rows);
            out.push_str(&format!("\x1b[{};{}r", top, bot));
        } else {
            out.push_str("\x1b[r");
        }
        out.push_str(if self.modes.auto_wrap { "\x1b[?7h" } else { "\x1b[?7l" });
        out.push_str(if self.modes.cursor_visible { "\x1b[?25h" } else { "\x1b[?25l" });
        if self.modes.bracketed_paste { out.push_str("\x1b[?2004h"); }
        if self.modes.focus_reporting { out.push_str("\x1b[?1004h"); }
        if self.modes.in_band_resize { out.push_str("\x1b[?2031h"); }
        if self.modes.mouse_mode != 0 {
            out.push_str(&format!("\x1b[?{}h", self.modes.mouse_mode));
        }
        if self.modes.mouse_ext != 0 {
            out.push_str(&format!("\x1b[?{}h", self.modes.mouse_ext));
        }
        out
    }
}
```

Implement `step` and `dispatch` mirroring `src/server/logs/screen.ts:44-120` (the TypeScript ModeScanner — same algorithm).

In `parser.rs`, add a `ModeScanner` field to `Parser`, feed it alongside the alacritty term, and expose `_test_in_alt_screen()` / `_test_scroll_region()` helpers.

In `serialize.rs`, prepend `parser.modes.emit(parser.rows)` to the grid output.

- [ ] **Step 3: Run, fix, run**

```bash
cd /workspace && cargo test -p fbi-term-core
```

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add cli/fbi-term-core/ && \
  git commit -m "feat(fbi-term): mode scanner + snapshot prefix"
```

### Task 1.5: Checkpoint store + `snapshot_at`

**Files:**
- Create: `cli/fbi-term-core/src/checkpoint.rs`
- Modify: `cli/fbi-term-core/src/parser.rs`

- [ ] **Step 1: Failing test**

```rust
// /workspace/cli/fbi-term-core/tests/checkpoint.rs
use fbi_term_core::Parser;

#[test]
fn snapshot_at_returns_modes_at_offset() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[?1049h");      // enter alt at offset ~7
    let off_after_alt = p.bytes_fed();
    p.feed(b"some text\r\n");
    p.feed(b"\x1b[?1049l");      // exit alt later

    let prefix = p.snapshot_at(off_after_alt);
    // Replaying just the prefix should put a fresh parser in alt screen.
    let mut p2 = Parser::new(80, 24);
    p2.feed(prefix.ansi.as_bytes());
    assert!(p2._test_in_alt_screen());
}
```

- [ ] **Step 2: Implement checkpoint store**

```rust
// /workspace/cli/fbi-term-core/src/checkpoint.rs
//! Periodic snapshots of `ModeState` keyed by byte offset.
//!
//! Used by `Parser::snapshot_at(offset)` to answer "what modes were
//! active at byte offset X?". The naive answer is "replay the entire
//! byte history through a fresh ModeScanner up to X." That works but
//! is O(history size). With checkpoints every CHECKPOINT_INTERVAL bytes
//! (256 KB), we replay at most one interval — bounded constant work.
//!
//! We don't store the bytes themselves — only the mode snapshot at
//! each checkpoint offset. The `Parser` keeps a copy of the most
//! recently checkpointed bytes (last interval's worth) so it can
//! replay forward from the latest checkpoint to any requested offset.

use crate::modes::ModeState;
use std::collections::BTreeMap;

pub const CHECKPOINT_INTERVAL: u64 = 256 * 1024;

pub struct CheckpointStore {
    /// offset -> mode state snapshot at that offset.
    snapshots: BTreeMap<u64, ModeState>,
    /// Bytes received since the last checkpoint (capped at one interval
    /// worth). Used by `replay_to(offset)` to advance from the latest
    /// checkpoint forward.
    recent_bytes: Vec<u8>,
}

impl CheckpointStore {
    pub fn new() -> Self { /* */ }

    /// Record bytes that were just fed. Called from `Parser::feed`.
    /// Appends to recent_bytes; if we crossed a CHECKPOINT_INTERVAL
    /// boundary, save a snapshot and trim recent_bytes.
    pub fn record(&mut self, bytes: &[u8], current_offset: u64, current_modes: &ModeState) {
        // Append to recent_bytes.
        // If current_offset / INTERVAL > last_checkpoint / INTERVAL,
        // store snapshot at the new boundary and reset recent_bytes
        // to the bytes after the boundary.
    }

    /// Find the latest checkpoint <= `offset` and return (its offset,
    /// the mode state at that offset, and the bytes between that
    /// checkpoint and `offset` that need replaying to reach `offset`).
    pub fn locate(&self, offset: u64) -> Option<(u64, &ModeState, &[u8])> {
        // BTreeMap range query.
        unimplemented!()
    }
}
```

In `parser.rs`:

```rust
impl Parser {
    pub fn snapshot_at(&self, offset: u64) -> crate::ModePrefix {
        // 1. checkpoint.locate(offset) -> (cp_offset, cp_modes, bytes_to_replay)
        // 2. clone cp_modes into a fresh ModeScanner
        // 3. feed bytes_to_replay through the scanner
        // 4. emit() the result clamped to current rows
        // 5. wrap in ModePrefix
        unimplemented!()
    }
}
```

- [ ] **Step 3: Test, iterate, commit**

```bash
cd /workspace && cargo test -p fbi-term-core
cd /workspace && git add cli/fbi-term-core/ && git commit -m "feat(fbi-term): mode checkpoint store + snapshot_at"
```

### Task 1.6: Resize support

**Files:**
- Modify: `cli/fbi-term-core/src/parser.rs`

- [ ] **Step 1: Failing test**

```rust
// /workspace/cli/fbi-term-core/tests/resize.rs
use fbi_term_core::Parser;

#[test]
fn resize_changes_dims() {
    let mut p = Parser::new(80, 24);
    p.resize(120, 40);
    assert_eq!(p.cols(), 120);
    assert_eq!(p.rows(), 40);
}

#[test]
fn snapshot_after_resize_uses_new_dims() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello");
    p.resize(40, 10);
    let snap = p.snapshot();
    assert_eq!(snap.cols, 40);
    assert_eq!(snap.rows, 10);
}
```

- [ ] **Step 2: Implement**

```rust
impl Parser {
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(/* alacritty SizeInfo */ ...);
        self.cols = cols;
        self.rows = rows;
    }
}
```

- [ ] **Step 3: Test + commit**

```bash
cd /workspace && cargo test -p fbi-term-core
cd /workspace && git add cli/fbi-term-core/ && git commit -m "feat(fbi-term): resize support"
```

---

## Phase 2: Quantico scenarios + capture flag

### Task 2.1: Add `--capture-bytes` flag to Quantico

**Files:**
- Modify: `cli/quantico/src/argv.rs`
- Modify: `cli/quantico/src/main.rs` (or `executor.rs`)

- [ ] **Step 1: Read existing argv structure**

```bash
head -120 /workspace/cli/quantico/src/argv.rs
```

- [ ] **Step 2: Add the flag**

Add a `--capture-bytes <PATH>` option. When set, instead of writing scenario output to stdout, write the raw byte stream (no terminal, no timing — just the concatenated `emit_ansi` payloads) to the given file. Used by the diff harness to extract deterministic byte streams from scenarios.

```rust
// In argv.rs's struct/parse function:
pub capture_bytes: Option<PathBuf>,

// Argument: --capture-bytes <PATH>
```

In `main.rs` / `executor.rs`, when `capture_bytes` is set, skip `sleep_ms` and `exit` step types; just concatenate `emit_ansi` payloads and write the file. Skip scenario timing entirely.

- [ ] **Step 3: Test manually**

```bash
cd /workspace/cli/quantico && cargo build
./target/debug/quantico --scenario default --capture-bytes /tmp/default.bin
file /tmp/default.bin  # expect "data"
xxd /tmp/default.bin | head -5
```

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add cli/quantico/ && \
  git commit -m "feat(quantico): --capture-bytes flag for diff-harness fixtures"
```

### Task 2.2: New terminal-correctness scenarios

**Files:**
- Create: `cli/quantico/scenarios/alt-screen-cycle.yaml`
- Create: `cli/quantico/scenarios/scroll-region-stress.yaml`
- Create: `cli/quantico/scenarios/mouse-modes-cycle.yaml`
- Create: `cli/quantico/scenarios/cjk-wide.yaml`
- Create: `cli/quantico/scenarios/truecolor.yaml`
- Create: `cli/quantico/scenarios/bracketed-paste-cycle.yaml`
- Create: `cli/quantico/scenarios/scrollback-stress.yaml`
- Create: `cli/quantico/scenarios/cursor-styles.yaml`

- [ ] **Step 1: Read existing scenario format**

```bash
cat /workspace/cli/quantico/scenarios/garbled.yaml
cat /workspace/cli/quantico/scenarios/tool-heavy.yaml
```

- [ ] **Step 2: Author each scenario**

Each scenario uses `emit_ansi: <string>`, `sleep_ms: <int>`, `exit: <code>` step types (already supported). Write the YAML for each. Examples:

`alt-screen-cycle.yaml`:
```yaml
name: alt-screen-cycle
steps:
  - emit_ansi: "main screen line 1\r\n"
  - emit_ansi: "\x1b[?1049h"
  - emit_ansi: "alt screen content\r\n"
  - emit_ansi: "more alt\r\n"
  - sleep_ms: 100
  - emit_ansi: "\x1b[?1049l"
  - emit_ansi: "back to main\r\n"
  - emit_ansi: "\x1b[?1049h"
  - emit_ansi: "second alt visit\r\n"
  - sleep_ms: 100
  - emit_ansi: "\x1b[?1049l"
  - emit_ansi: "main again\r\n"
  - exit: 0
```

`scroll-region-stress.yaml`:
```yaml
name: scroll-region-stress
steps:
  - emit_ansi: "\x1b[2J\x1b[H"
  - emit_ansi: "\x1b[3;20r"     # DECSTBM rows 3..20
  - emit_ansi: "\x1b[1;1Hstatus line 1\r\n"
  - emit_ansi: "\x1b[2;1Hstatus line 2\r\n"
  - emit_ansi: "\x1b[3;1H"      # cursor inside region
  - emit_ansi: "scrolled line 1\r\n"
  - emit_ansi: "scrolled line 2\r\n"
  - emit_ansi: "scrolled line 3\r\n"
  - sleep_ms: 100
  - emit_ansi: "\x1b[r"          # reset region
  - exit: 0
```

`mouse-modes-cycle.yaml`:
```yaml
name: mouse-modes-cycle
steps:
  - emit_ansi: "\x1b[?1000h"
  - emit_ansi: "\x1b[?1006h"
  - sleep_ms: 50
  - emit_ansi: "\x1b[?1000l"
  - emit_ansi: "\x1b[?1003h"
  - emit_ansi: "\x1b[?1006l"
  - emit_ansi: "\x1b[?1015h"
  - sleep_ms: 50
  - emit_ansi: "\x1b[?1003l"
  - emit_ansi: "\x1b[?1015l"
  - exit: 0
```

`cjk-wide.yaml`:
```yaml
name: cjk-wide
steps:
  - emit_ansi: "\xe4\xbd\xa0\xe5\xa5\xbd 你好\r\n"
  - emit_ansi: "日本語のテスト\r\n"
  - emit_ansi: "emoji: \xf0\x9f\x8e\x89 \xf0\x9f\x9a\x80 \xf0\x9f\x90\x88\r\n"
  - exit: 0
```

`truecolor.yaml`:
```yaml
name: truecolor
steps:
  - emit_ansi: "\x1b[38;2;255;128;0morange truecolor\x1b[0m\r\n"
  - emit_ansi: "\x1b[48;2;0;0;128;38;2;255;255;255mwhite on dark blue\x1b[0m\r\n"
  - emit_ansi: "\x1b[38;5;201mindexed 256\x1b[0m\r\n"
  - emit_ansi: "\x1b[1;31mbold red 16\x1b[0m\r\n"
  - exit: 0
```

`bracketed-paste-cycle.yaml`:
```yaml
name: bracketed-paste-cycle
steps:
  - emit_ansi: "\x1b[?2004h"
  - emit_ansi: "bracketed paste enabled\r\n"
  - sleep_ms: 50
  - emit_ansi: "\x1b[?2004l"
  - emit_ansi: "and disabled\r\n"
  - exit: 0
```

`scrollback-stress.yaml`: 50,000 lines is a lot of YAML; instead generate via a single step:
```yaml
name: scrollback-stress
steps:
  - emit_ansi: "(scrollback-stress: see hardcoded loop in executor — TODO inline if cleaner)"
  - exit: 0
```

Actually: better to inline as a sequence of 50k `emit_ansi: "line N\r\n"` steps via a generator. Add a small generator script in `cli/quantico/scenarios/_gen-scrollback-stress.sh` that produces the YAML, then run it once and check in the result. Or accept the file is large; YAML supports anchors but emit_ansi is per-step.

Alternative: extend the executor to support a `repeat: { count: N, body: [...] }` step shape. But that's scope creep.

Pragmatic choice: write the file with a script:
```bash
cat > /workspace/cli/quantico/scenarios/scrollback-stress.yaml <<EOF
name: scrollback-stress
steps:
EOF
for i in $(seq 1 50000); do
  printf '  - emit_ansi: "line %d\\\\r\\\\n"\n' "$i" >> /workspace/cli/quantico/scenarios/scrollback-stress.yaml
done
echo "  - exit: 0" >> /workspace/cli/quantico/scenarios/scrollback-stress.yaml
```

`cursor-styles.yaml`:
```yaml
name: cursor-styles
steps:
  - emit_ansi: "\x1b[?25l"           # hide cursor
  - emit_ansi: "cursor hidden\r\n"
  - sleep_ms: 50
  - emit_ansi: "\x1b[?25h"           # show
  - emit_ansi: "\x1b[5 q"            # blinking bar
  - emit_ansi: "\x1b[1 q"            # blinking block
  - emit_ansi: "\x1b7"               # DECSC save
  - emit_ansi: "\x1b[10;5Hsaved here"
  - emit_ansi: "\x1b8"               # DECRC restore
  - exit: 0
```

- [ ] **Step 3: Verify each scenario builds & captures**

```bash
cd /workspace/cli/quantico && cargo build
for s in alt-screen-cycle scroll-region-stress mouse-modes-cycle cjk-wide \
         truecolor bracketed-paste-cycle cursor-styles; do
  ./target/debug/quantico --scenario "$s" --capture-bytes "/tmp/q-$s.bin" || { echo "FAIL: $s"; exit 1; }
  echo "$s: $(wc -c < /tmp/q-$s.bin) bytes"
done
# scrollback-stress likely takes longer; run separately:
./target/debug/quantico --scenario scrollback-stress --capture-bytes /tmp/q-scrollback-stress.bin
echo "scrollback-stress: $(wc -c < /tmp/q-scrollback-stress.bin) bytes"
```

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add cli/quantico/scenarios/ && \
  git commit -m "feat(quantico): 8 terminal-correctness scenarios"
```

---

## Phase 3: Native diff harness

### Task 3.1: `xterm_ref.mjs` reference parser

**Files:**
- Create: `cli/fbi-term-core/tests/support/xterm_ref.mjs`
- Modify: root `package.json` to ensure `@xterm/headless` is a dev dep

- [ ] **Step 1: Verify @xterm/headless is in package.json**

```bash
grep -n "@xterm/headless" /workspace/package.json
```

If not present, add to `devDependencies`:
```json
"@xterm/headless": "^5.5.0",
"@xterm/addon-serialize": "^0.13.0"
```
And run `npm install`.

- [ ] **Step 2: Write the Node script**

```javascript
// /workspace/cli/fbi-term-core/tests/support/xterm_ref.mjs
//
// Reference terminal parser used by the diff harness.
//
// Reads bytes from stdin, feeds them through @xterm/headless at the
// requested dims, then prints a normalized JSON grid representation
// to stdout. The Rust diff harness compares this against fbi-term-core's
// own grid dump.
//
// Usage:
//   node xterm_ref.mjs <cols> <rows> < bytes.bin
//
// Output JSON shape:
//   {
//     "cols": N, "rows": M,
//     "cursor": [row, col],
//     "alt_screen": bool,
//     "scroll_region": [top, bottom] | null,
//     "rows_data": [
//       [{"ch":"a","fg":255,"bg":0,"attrs":0}, ...],
//       ...
//     ]
//   }
//
// Normalization:
//  - Empty cells canonicalized to default attrs (fg=257, bg=256, attrs=0)
//  - Trailing default cells removed from each row
//  - SGR transitions implicit (we emit raw cell attrs, not escape sequences)

import headless from '@xterm/headless';
const { Terminal } = headless;

const cols = Number(process.argv[2] || 80);
const rows = Number(process.argv[3] || 24);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const bytes = await readStdin();
const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
await new Promise((resolve) => term.write(bytes, () => resolve()));

const buf = term.buffer.active;
const out = {
  cols, rows,
  cursor: [buf.cursorY, buf.cursorX],
  alt_screen: term.buffer.active === term.buffer.alternate,
  scroll_region: null,  // xterm-headless doesn't expose this directly
  rows_data: [],
};

for (let r = 0; r < rows; r++) {
  const line = buf.getLine(r);
  const cells = [];
  if (line) {
    for (let c = 0; c < cols; c++) {
      const cell = line.getCell(c);
      cells.push({
        ch: cell?.getChars() || ' ',
        fg: cell?.getFgColor() ?? 257,
        bg: cell?.getBgColor() ?? 256,
        attrs: 0,  // TODO: encode bold/italic/underline if needed
      });
    }
  }
  // Trim trailing default cells.
  while (cells.length > 0) {
    const c = cells[cells.length - 1];
    if (c.ch === ' ' && c.fg === 257 && c.bg === 256 && c.attrs === 0) {
      cells.pop();
    } else break;
  }
  out.rows_data.push(cells);
}

process.stdout.write(JSON.stringify(out));
```

- [ ] **Step 3: Manual smoke-test**

```bash
cd /workspace && printf 'hello\r\n' | node cli/fbi-term-core/tests/support/xterm_ref.mjs 80 24 | jq '.rows_data[0]'
```
Expected: an array of cells; first 5 have `ch: 'h','e','l','l','o'`.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add cli/fbi-term-core/tests/support/ package.json package-lock.json && \
  git commit -m "test(fbi-term): @xterm/headless reference dump script"
```

### Task 3.2: Native diff harness Rust test

**Files:**
- Create: `cli/fbi-term-core/tests/diff_xterm.rs`

- [ ] **Step 1: Capture fixtures from Quantico**

```bash
cd /workspace && mkdir -p cli/fbi-term-core/tests/fixtures
cd /workspace/cli/quantico && cargo build --release
for s in alt-screen-cycle scroll-region-stress mouse-modes-cycle cjk-wide \
         truecolor bracketed-paste-cycle cursor-styles; do
  ./target/release/quantico --scenario "$s" \
    --capture-bytes "/workspace/cli/fbi-term-core/tests/fixtures/$s.bin"
done
# scrollback-stress excluded (would be huge; tested separately)
```

Commit fixtures (binary, but small — <100 KB total):
```bash
cd /workspace && git add cli/fbi-term-core/tests/fixtures/ && \
  git commit -m "test(fbi-term): captured Quantico scenario fixtures"
```

- [ ] **Step 2: Write the harness**

```rust
// /workspace/cli/fbi-term-core/tests/diff_xterm.rs
//! Differential test harness: feed each fixture's bytes through both
//! fbi-term-core's Parser AND @xterm/headless (via xterm_ref.mjs), then
//! compare the resulting grids cell-by-cell.
//!
//! This is the gating test for the rip-and-replace cutover. If our
//! parser disagrees with xterm.js on what a byte stream renders to,
//! snapshots sent to xterm.js clients won't match what those clients
//! would have rendered from raw bytes — visible as wrong-rendering
//! bugs in the UI.
//!
//! When this test fails, the failure dump prints a row-by-row diff so
//! the disagreement is easy to localize.

use std::process::Command;

use fbi_term_core::Parser;
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
struct Cell {
    ch: String,
    fg: i64,
    bg: i64,
    attrs: u32,
}

#[derive(Debug, Deserialize)]
struct Grid {
    cols: u16,
    rows: u16,
    cursor: (u16, u16),
    alt_screen: bool,
    rows_data: Vec<Vec<Cell>>,
}

fn xterm_ref_grid(bytes: &[u8], cols: u16, rows: u16) -> Grid {
    use std::io::Write;
    let mut child = Command::new("node")
        .arg("tests/support/xterm_ref.mjs")
        .arg(cols.to_string())
        .arg(rows.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn xterm_ref.mjs (is node available?)");
    child.stdin.as_mut().unwrap().write_all(bytes).unwrap();
    drop(child.stdin.take());
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "xterm_ref.mjs failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).expect("parse xterm_ref output")
}

fn fbi_term_grid(bytes: &[u8], cols: u16, rows: u16) -> Grid {
    let mut p = Parser::new(cols, rows);
    p.feed(bytes);
    p.into_test_grid()  // helper added on Parser, dumps in same JSON shape
}

fn diff_grids(name: &str, ours: &Grid, theirs: &Grid) {
    assert_eq!(ours.cols, theirs.cols, "{}: cols", name);
    assert_eq!(ours.rows, theirs.rows, "{}: rows", name);
    assert_eq!(ours.alt_screen, theirs.alt_screen, "{}: alt_screen", name);
    // Cursor: tolerate small differences for now, log them.
    if ours.cursor != theirs.cursor {
        eprintln!("{}: cursor diff (ours={:?}, theirs={:?})", name, ours.cursor, theirs.cursor);
    }
    for (r, (our_row, their_row)) in ours.rows_data.iter().zip(theirs.rows_data.iter()).enumerate() {
        if our_row != their_row {
            eprintln!("{}: row {} differs", name, r);
            eprintln!("  ours:   {:?}", our_row);
            eprintln!("  theirs: {:?}", their_row);
            panic!("{}: grid mismatch", name);
        }
    }
}

macro_rules! scenario_test {
    ($name:ident, $fixture:literal) => {
        #[test]
        fn $name() {
            let bytes = std::fs::read(concat!("tests/fixtures/", $fixture, ".bin"))
                .expect("read fixture");
            let ours = fbi_term_grid(&bytes, 80, 24);
            let theirs = xterm_ref_grid(&bytes, 80, 24);
            diff_grids($fixture, &ours, &theirs);
        }
    };
}

scenario_test!(alt_screen_cycle,        "alt-screen-cycle");
scenario_test!(scroll_region_stress,    "scroll-region-stress");
scenario_test!(mouse_modes_cycle,       "mouse-modes-cycle");
scenario_test!(cjk_wide,                "cjk-wide");
scenario_test!(truecolor,               "truecolor");
scenario_test!(bracketed_paste_cycle,   "bracketed-paste-cycle");
scenario_test!(cursor_styles,           "cursor-styles");
```

- [ ] **Step 3: Add `into_test_grid` on Parser**

In `parser.rs`:
```rust
#[cfg(test)]
impl Parser {
    /// Test-only: dump grid in the same JSON shape as xterm_ref.mjs
    /// produces, for the diff harness.
    pub fn into_test_grid(&self) -> serde_json::Value {
        // Walk self.term.grid(), produce the same shape.
        // Match the trimming + canonicalization rules in xterm_ref.mjs.
        unimplemented!()
    }
}
```

(Use `serde_json::Value` to avoid duplicating the Grid struct; the harness already parses xterm_ref output into `Grid` and can do the same with `serde_json::from_value`.)

Better: extract a normalization helper used by both sides so the formats are guaranteed to match.

- [ ] **Step 4: Run, fix iteratively**

```bash
cd /workspace && cargo test -p fbi-term-core --test diff_xterm -- --nocapture
```

Some tests will fail initially. Iterate on the parser, mode tracker, and serializer until all pass. This is where most fidelity work happens. Document any deliberate divergences from xterm.js as inline comments — but they should be rare; if our parser doesn't match xterm.js, it's almost always our bug.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add cli/fbi-term-core/ && \
  git commit -m "test(fbi-term): native diff harness against @xterm/headless"
```

### Task 3.3: CI integration

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Read existing CI**

```bash
cat /workspace/.github/workflows/ci.yml
```

- [ ] **Step 2: Add the cargo test step**

In the existing `ci.yml`, add a step (or job) that runs `cargo test -p fbi-term-core` after `npm install` (so `@xterm/headless` is available). Mark it as a required check.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add .github/workflows/ci.yml && \
  git commit -m "ci: gate on fbi-term diff harness"
```

---

## Phase 4: Rustler NIF wrapper

### Task 4.1: NIF crate skeleton

**Files:**
- Create: `server-elixir/native/fbi_term/Cargo.toml`
- Create: `server-elixir/native/fbi_term/src/lib.rs`
- Modify: `Cargo.toml` (workspace) — add member
- Modify: `server-elixir/mix.exs` — add Rustler dep

- [ ] **Step 1: Add to workspace + create Cargo.toml**

Workspace:
```toml
[workspace]
members = ["desktop", "cli/fbi-tunnel", "cli/fbi-term-core", "server-elixir/native/fbi_term"]
```

NIF crate:
```toml
# /workspace/server-elixir/native/fbi_term/Cargo.toml
[package]
name = "fbi_term"
version = "0.1.0"
edition = "2021"

[lib]
name = "fbi_term"
crate-type = ["cdylib"]
path = "src/lib.rs"

[dependencies]
rustler = "0.34"
fbi-term-core = { path = "../../../cli/fbi-term-core" }

[profile.release]
panic = "abort"
opt-level = 3
```

- [ ] **Step 2: Stub the NIF**

```rust
// /workspace/server-elixir/native/fbi_term/src/lib.rs
//! Rustler NIF wrapper exposing fbi-term-core to the BEAM.
//!
//! The handle returned to Elixir is a `ResourceArc<Mutex<Parser>>`.
//! - ResourceArc: BEAM-managed reference; freed when the Elixir term
//!   becomes unreachable.
//! - Mutex: NIFs can theoretically be called from multiple BEAM
//!   scheduler threads; in practice we only call from the run's
//!   GenServer, but the Mutex makes the contract safe for any caller.
//!
//! Every NIF function wraps its body in `catch_unwind`. A panic
//! returns `{:error, :nif_panic}` to Elixir; the RunServer treats this
//! as fatal for the run. `panic = abort` in the release profile means
//! a panic in non-NIF code (e.g. fbi-term-core code that escapes our
//! catch_unwind boundary) crashes the entire BEAM node — but our
//! catch_unwind blanket should prevent that in practice.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

use fbi_term_core::Parser;
use rustler::{Atom, Binary, Env, NifResult, NifStruct, OwnedBinary, ResourceArc, Term};

mod atoms {
    rustler::atoms! {
        ok,
        error,
        nif_panic,
    }
}

pub struct ParserResource(pub Mutex<Parser>);

#[rustler::nif]
fn new(cols: u16, rows: u16) -> NifResult<ResourceArc<ParserResource>> {
    let p = Parser::new(cols, rows);
    Ok(ResourceArc::new(ParserResource(Mutex::new(p))))
}

#[rustler::nif(schedule = "DirtyIo")]
fn feed(handle: ResourceArc<ParserResource>, bytes: Binary) -> NifResult<Atom> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut g = handle.0.lock().unwrap();
        g.feed(bytes.as_slice());
    }));
    match result {
        Ok(()) => Ok(atoms::ok()),
        Err(_) => Err(rustler::Error::Term(Box::new(atoms::nif_panic()))),
    }
}

#[derive(NifStruct)]
#[module = "FBI.Terminal.Snapshot"]
struct SnapshotEx {
    ansi: String,
    cols: u16,
    rows: u16,
    byte_offset: u64,
}

#[rustler::nif]
fn snapshot(handle: ResourceArc<ParserResource>) -> NifResult<SnapshotEx> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let g = handle.0.lock().unwrap();
        let s = g.snapshot();
        SnapshotEx { ansi: s.ansi, cols: s.cols, rows: s.rows, byte_offset: s.byte_offset }
    }));
    result.map_err(|_| rustler::Error::Term(Box::new(atoms::nif_panic())))
}

#[derive(NifStruct)]
#[module = "FBI.Terminal.ModePrefix"]
struct ModePrefixEx {
    ansi: String,
}

#[rustler::nif]
fn snapshot_at(handle: ResourceArc<ParserResource>, offset: u64) -> NifResult<ModePrefixEx> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let g = handle.0.lock().unwrap();
        let p = g.snapshot_at(offset);
        ModePrefixEx { ansi: p.ansi }
    }));
    result.map_err(|_| rustler::Error::Term(Box::new(atoms::nif_panic())))
}

#[rustler::nif]
fn resize(handle: ResourceArc<ParserResource>, cols: u16, rows: u16) -> NifResult<Atom> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut g = handle.0.lock().unwrap();
        g.resize(cols, rows);
    }));
    result.map(|_| atoms::ok()).map_err(|_| rustler::Error::Term(Box::new(atoms::nif_panic())))
}

fn on_load(env: Env, _: Term) -> bool {
    rustler::resource!(ParserResource, env);
    true
}

rustler::init!("Elixir.FBI.Terminal", [new, feed, snapshot, snapshot_at, resize], load = on_load);
```

- [ ] **Step 3: Add Rustler to mix.exs**

```elixir
# In server-elixir/mix.exs, in deps/0:
{:rustler, "~> 0.34"},

# Also add a rustler_crates configuration in project/0:
def project do
  [
    # ... existing fields ...
    rustler_crates: rustler_crates(),
  ]
end

defp rustler_crates do
  [
    fbi_term: [
      path: "native/fbi_term",
      mode: if(Mix.env() == :prod, do: :release, else: :debug),
    ]
  ]
end
```

- [ ] **Step 4: Verify build**

```bash
cd /workspace/server-elixir && mix deps.get && mix compile
```

Expected: builds the NIF, output mentions `cargo build` and produces `.so` / `.dylib` artifact.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add Cargo.toml server-elixir/native/fbi_term/ server-elixir/mix.exs server-elixir/mix.lock && \
  git commit -m "feat(fbi-term): Rustler NIF wrapper"
```

### Task 4.2: Elixir-side `FBI.Terminal` module + smoke test

**Files:**
- Create: `server-elixir/lib/fbi/terminal.ex`
- Create: `server-elixir/test/fbi/terminal_test.exs`

- [ ] **Step 1: Write the module**

```elixir
# /workspace/server-elixir/lib/fbi/terminal.ex
defmodule FBI.Terminal do
  @moduledoc """
  Rustler NIF wrapper around `fbi-term-core`.

  Each run holds a parser handle (`ResourceArc<Mutex<Parser>>` on the
  Rust side, opaque reference on the Elixir side) for its lifetime.
  The handle is reclaimed when the holding process terminates and the
  reference becomes unreachable — BEAM GC drives the destructor.

  All functions panic-safe: a Rust panic returns `{:error, :nif_panic}`
  rather than crashing the BEAM node. A panic is a P0 bug — investigate.

  See `docs/superpowers/specs/2026-04-26-terminal-rust-rewrite-design.md`
  for design rationale.
  """
  use Rustler, otp_app: :fbi, crate: "fbi_term"

  @opaque handle :: reference()

  @spec new(pos_integer(), pos_integer()) :: handle()
  def new(_cols, _rows), do: :erlang.nif_error(:nif_not_loaded)

  @spec feed(handle(), binary()) :: :ok | {:error, :nif_panic}
  def feed(_handle, _bytes), do: :erlang.nif_error(:nif_not_loaded)

  @spec snapshot(handle()) ::
          %FBI.Terminal.Snapshot{}
          | {:error, :nif_panic}
  def snapshot(_handle), do: :erlang.nif_error(:nif_not_loaded)

  @spec snapshot_at(handle(), non_neg_integer()) ::
          %FBI.Terminal.ModePrefix{}
          | {:error, :nif_panic}
  def snapshot_at(_handle, _offset), do: :erlang.nif_error(:nif_not_loaded)

  @spec resize(handle(), pos_integer(), pos_integer()) :: :ok | {:error, :nif_panic}
  def resize(_handle, _cols, _rows), do: :erlang.nif_error(:nif_not_loaded)
end

defmodule FBI.Terminal.Snapshot do
  @moduledoc "Returned by `FBI.Terminal.snapshot/1`."
  defstruct [:ansi, :cols, :rows, :byte_offset]
end

defmodule FBI.Terminal.ModePrefix do
  @moduledoc "Returned by `FBI.Terminal.snapshot_at/2`. ANSI to put a fresh xterm in the right mode state at a given byte offset."
  defstruct [:ansi]
end
```

- [ ] **Step 2: Smoke test**

```elixir
# /workspace/server-elixir/test/fbi/terminal_test.exs
defmodule FBI.TerminalTest do
  use ExUnit.Case

  test "new/2 returns a handle and snapshot/1 round-trips dims" do
    h = FBI.Terminal.new(80, 24)
    snap = FBI.Terminal.snapshot(h)
    assert %FBI.Terminal.Snapshot{cols: 80, rows: 24} = snap
    assert is_binary(snap.ansi)
  end

  test "feed/2 then snapshot/1 reflects content" do
    h = FBI.Terminal.new(80, 24)
    assert :ok == FBI.Terminal.feed(h, "hello")
    snap = FBI.Terminal.snapshot(h)
    assert snap.byte_offset == 5
    # Replaying the snapshot through a fresh parser should yield the same byte_offset of 0+ansi length;
    # we don't assert on ansi content shape here, that's fbi-term-core's job.
  end

  test "resize/3 changes reported dims" do
    h = FBI.Terminal.new(80, 24)
    assert :ok == FBI.Terminal.resize(h, 120, 40)
    snap = FBI.Terminal.snapshot(h)
    assert {snap.cols, snap.rows} == {120, 40}
  end

  test "snapshot_at/2 returns a ModePrefix" do
    h = FBI.Terminal.new(80, 24)
    FBI.Terminal.feed(h, "\e[?1049h")
    pref = FBI.Terminal.snapshot_at(h, 7)
    assert %FBI.Terminal.ModePrefix{ansi: ansi} = pref
    assert String.contains?(ansi, "\e[?1049h")
  end
end
```

- [ ] **Step 3: Run + commit**

```bash
cd /workspace/server-elixir && mix test test/fbi/terminal_test.exs
cd /workspace && git add server-elixir/lib/fbi/terminal.ex server-elixir/test/fbi/terminal_test.exs && \
  git commit -m "feat(fbi-term): FBI.Terminal Elixir module + smoke test"
```

---

## Phase 5: Viewer registry + RunServer integration

### Task 5.1: `Viewer` struct + RunServer state additions

**Files:**
- Create: `server-elixir/lib/fbi/orchestrator/viewer.ex`
- Modify: `server-elixir/lib/fbi/orchestrator/run_server.ex`

- [ ] **Step 1: Create Viewer struct**

```elixir
# /workspace/server-elixir/lib/fbi/orchestrator/viewer.ex
defmodule FBI.Orchestrator.Viewer do
  @moduledoc """
  Per-WS-connection state in a run's viewer registry.

  Each viewer has an opaque id (allocated by RunServer on join), the
  pid of its WS handler process, the dims it last reported, and the
  monotonic timestamp of its last `focus` event (or `joined_at` if
  never focused).

  Held inside RunServer state — not a separate process. Updates are
  serialized through the GenServer's mailbox.
  """
  defstruct [
    :id,
    :ws_pid,
    :ws_monitor_ref,
    :cols,
    :rows,
    :focused_at,
    :joined_at
  ]

  @type t :: %__MODULE__{
          id: reference(),
          ws_pid: pid(),
          ws_monitor_ref: reference(),
          cols: pos_integer(),
          rows: pos_integer(),
          focused_at: integer() | nil,
          joined_at: integer()
        }
end
```

- [ ] **Step 2: Add fields to RunServer state**

In `run_server.ex`, locate the `defstruct` and add:
```elixir
defstruct [
  # ... existing fields ...
  :term_handle,        # FBI.Terminal handle, allocated on set_container
  viewers: %{},        # %{viewer_id (ref) => Viewer.t()}
  focused_viewer: nil, # viewer_id | nil
]
```

- [ ] **Step 3: Allocate handle in `set_container`**

Find the `handle_call({:set_container, ...}, ...)` clause (around line 194). Modify to also allocate the term handle:

```elixir
def handle_call({:set_container, cid, socket}, _from, state) do
  # Allocate the per-run terminal parser. Default 80x24; the first
  # focused viewer's hello will resize.
  handle = FBI.Terminal.new(80, 24)
  {:reply, :ok, %{state | container_id: cid, attach_socket: socket, term_handle: handle}}
end
```

- [ ] **Step 4: Failing test**

```elixir
# /workspace/server-elixir/test/fbi/orchestrator/run_server_viewer_test.exs
defmodule FBI.Orchestrator.RunServerViewerTest do
  use ExUnit.Case
  alias FBI.Orchestrator.{RunServer, Viewer}

  # Direct GenServer testing with a stub state. Real launch is expensive
  # (Docker etc.); we test the registry logic in isolation.

  test "viewer_joined adds to registry" do
    # ... uses :sys.replace_state and synthetic events ...
  end

  test "viewer_focused updates focused_viewer and focused_at" do
    # ...
  end
end
```

- [ ] **Step 5: Implement viewer_joined / viewer_focused / viewer_left handlers**

Add to `run_server.ex`:

```elixir
# Public API.
def viewer_joined(run_id, ws_pid, cols, rows) do
  case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
    [{pid, _}] -> GenServer.call(pid, {:viewer_joined, ws_pid, cols, rows})
    [] -> {:error, :no_run}
  end
end

def viewer_focused(run_id, viewer_id) do
  # ...
end

def viewer_left(run_id, viewer_id) do
  # ...
end

# Handlers.
def handle_call({:viewer_joined, ws_pid, cols, rows}, _from, state) do
  ref = make_ref()
  monitor_ref = Process.monitor(ws_pid)
  now = System.monotonic_time()
  v = %Viewer{
    id: ref,
    ws_pid: ws_pid,
    ws_monitor_ref: monitor_ref,
    cols: cols,
    rows: rows,
    focused_at: nil,
    joined_at: now
  }
  state = %{state | viewers: Map.put(state.viewers, ref, v)}

  # Initial focus: first viewer becomes focused implicitly.
  state =
    if state.focused_viewer == nil do
      %{state | focused_viewer: ref}
      |> Map.update!(:viewers, fn vs -> Map.update!(vs, ref, &%{&1 | focused_at: now}) end)
      |> apply_focus_resize_if_needed()
    else
      state
    end

  {:reply, {:ok, ref}, state}
end

def handle_call({:viewer_focused, viewer_id}, _from, state) do
  case state.viewers[viewer_id] do
    nil ->
      {:reply, {:error, :unknown_viewer}, state}

    _v ->
      now = System.monotonic_time()
      state =
        state
        |> Map.update!(:viewers, fn vs -> Map.update!(vs, viewer_id, &%{&1 | focused_at: now}) end)
        |> Map.put(:focused_viewer, viewer_id)
        |> apply_focus_resize_if_needed()

      broadcast_focus_state(state)
      {:reply, :ok, state}
  end
end

def handle_call({:viewer_left, viewer_id}, _from, state) do
  state = drop_viewer(state, viewer_id)
  {:reply, :ok, state}
end

def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
  # Find the viewer with this monitor_ref and drop it.
  case Enum.find(state.viewers, fn {_, v} -> v.ws_monitor_ref == ref end) do
    {viewer_id, _} -> {:noreply, drop_viewer(state, viewer_id)}
    nil -> {:noreply, state}
  end
end

# Drops a viewer; if it was focused, falls back per policy.
defp drop_viewer(state, viewer_id) do
  state = Map.update!(state, :viewers, &Map.delete(&1, viewer_id))
  if state.focused_viewer == viewer_id do
    new_focused = pick_fallback_focus(state.viewers)
    %{state | focused_viewer: new_focused}
  else
    state
  end
end

# Policy: most-recently-focused remaining viewer wins.
# If no viewer was ever focused, pick most-recently-joined.
defp pick_fallback_focus(viewers) when map_size(viewers) == 0, do: nil

defp pick_fallback_focus(viewers) do
  # Prefer a previously-focused viewer.
  focused = viewers |> Enum.filter(fn {_, v} -> v.focused_at != nil end)
  case focused do
    [] ->
      # Fall back to most-recently-joined.
      {id, _v} = Enum.max_by(viewers, fn {_, v} -> v.joined_at end)
      id

    list ->
      {id, _v} = Enum.max_by(list, fn {_, v} -> v.focused_at end)
      id
  end
end

defp apply_focus_resize_if_needed(state) do
  case state.viewers[state.focused_viewer] do
    nil -> state
    v ->
      if v.cols != FBI.Terminal.snapshot(state.term_handle).cols or
         v.rows != FBI.Terminal.snapshot(state.term_handle).rows do
        :ok = FBI.Docker.resize_container(state.container_id, v.cols, v.rows)
        :ok = FBI.Terminal.resize(state.term_handle, v.cols, v.rows)
        broadcast_fresh_snapshot(state)
      end
      state
  end
end

defp broadcast_fresh_snapshot(state) do
  snap = FBI.Terminal.snapshot(state.term_handle)
  frame = %{type: "snapshot", ansi: snap.ansi, cols: snap.cols, rows: snap.rows}
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

- [ ] **Step 6: Run tests + commit**

```bash
cd /workspace/server-elixir && mix test
cd /workspace && git add server-elixir/ && \
  git commit -m "feat(orchestrator): viewer registry + last-focused-wins resize policy"
```

### Task 5.2: Replace ScreenState in `make_on_bytes`

**Files:**
- Modify: `server-elixir/lib/fbi/orchestrator/run_server.ex`

- [ ] **Step 1: Update make_on_bytes to feed term_handle and reorder**

Around line 810:
```elixir
defp make_on_bytes(run_id, log_path, term_handle) do
  fn chunk ->
    # Order: persist, parse, broadcast.
    # Persist first so historical Range queries always see the bytes.
    # Parse before broadcast so any client whose snapshot is being
    # built in response to a hello sees a parser state that includes
    # this chunk — closes the snapshot-vs-broadcast race that the old
    # code (broadcast-then-feed) had.
    LogStore.append(log_path, chunk)
    FBI.Terminal.feed(term_handle, chunk)
    Phoenix.PubSub.broadcast(FBI.PubSub, "run:#{run_id}:bytes", {:bytes, chunk})
  end
end
```

Update every caller of `make_on_bytes(run_id, log_path)` to pass `term_handle` as the third arg. There are calls in `run_lifecycle(:launch, ...)`, `run_lifecycle(:resume, ...)`, `run_lifecycle(:continue, ...)`, `run_lifecycle(:reattach, ...)`. The handle isn't allocated until `set_container`, so callers need to thread it through.

The cleanest approach: allocate the handle in `RunServer.init/1` (or at the top of each `run_lifecycle/4`) instead of in `set_container`. Since `term_handle` is just a NIF resource — cheap to allocate, no Docker dependency — allocating it eagerly is fine. Remove the allocation from `set_container`.

- [ ] **Step 2: Test that bytes flow through the parser**

Adapt or add an integration test that fakes the on_bytes pipeline and verifies the snapshot reflects fed bytes.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add server-elixir/ && \
  git commit -m "feat(orchestrator): integrate fbi-term NIF in on_bytes pipeline"
```

### Task 5.3: Delete ScreenState entirely

**Files:**
- Delete: `server-elixir/lib/fbi/orchestrator/screen_state.ex`
- Modify: every call site of `ScreenState`

- [ ] **Step 1: Find call sites**

```bash
cd /workspace && grep -rn "ScreenState" server-elixir/
```

- [ ] **Step 2: Remove each call site**

`ScreenState.feed/2` calls → already removed in Task 5.2.
`ScreenState.snapshot/1` calls → already in shell_ws_handler will be replaced in Task 6.
`ScreenState.clear/1` calls (in run_server termination) → delete; the NIF handle is GC'd automatically.
`ScreenState.resize/3` calls (in handle_cast({:resize, ...})) → replace with `FBI.Terminal.resize(state.term_handle, cols, rows)`.
`ScreenState.ensure_started/0` calls (in application.ex if any) → delete; no ETS to bootstrap.

- [ ] **Step 3: Delete the file**

```bash
cd /workspace && rm server-elixir/lib/fbi/orchestrator/screen_state.ex
```

- [ ] **Step 4: Compile + test**

```bash
cd /workspace/server-elixir && mix compile && mix test
```

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add -A server-elixir/ && \
  git commit -m "refactor(orchestrator): delete ScreenState (replaced by FBI.Terminal NIF)"
```

---

## Phase 6: WebSocket handler rewrite

### Task 6.1: Honor re-hello + send real snapshot

**Files:**
- Modify: `server-elixir/lib/fbi_web/sockets/shell_ws_handler.ex`

- [ ] **Step 1: Read current handler**

```bash
cat /workspace/server-elixir/lib/fbi_web/sockets/shell_ws_handler.ex
```

- [ ] **Step 2: Rewrite `init/1` and `handle_in`**

Full rewrite — see spec Section 6 for protocol details. Key behaviors:
- `init/1` subscribes to `:bytes`, `:events`, `:state`, AND new `:snapshot` topics; calls `Orchestrator.viewer_joined` to register self with the run.
- `handle_in` for `hello` is accepted at any time (no `greeted` flag). Updates viewer dims; if focused, drives PTY+grid resize; replies with current snapshot.
- `handle_in` for `resize`: same as hello but doesn't reply with snapshot.
- `handle_in` for `focus` / `blur`: delegate to RunServer.
- `handle_in` for binary frames: synthesize focus, then forward stdin.
- `handle_info({:snapshot, frame}, state)`: forward as text frame.
- `handle_info({:event, %{type: "focus_state", focused_viewer: id}} = ev, state)`: rewrite to per-viewer `{focused, by_self}` shape based on stored `viewer_id`, then forward.
- `terminate/2`: call `Orchestrator.viewer_left(run_id, viewer_id)`.

```elixir
defmodule FBIWeb.Sockets.ShellWSHandler do
  @moduledoc """
  WebSock handler for /api/runs/:id/shell.

  Protocol (see spec 2026-04-26-terminal-rust-rewrite-design.md §6):
    C→S text:
      {"type":"hello", "cols":N, "rows":M}     accepted any time
      {"type":"resize", "cols":N, "rows":M}    same routing as hello, no reply
      {"type":"focus"}                         viewer asserts ownership
      {"type":"blur"}                          viewer relinquishes
    C→S binary:
      raw stdin bytes (synthesizes focus first)
    S→C text:
      {"type":"snapshot", "ansi":..., "cols":N, "rows":M}
      {"type":"focus_state", "focused":bool, "by_self":bool}
      typed events: usage / state / title / changes (via :events PubSub)
    S→C binary:
      raw PTY bytes (via :bytes PubSub)
  """
  @behaviour WebSock

  alias FBI.Orchestrator

  @impl true
  def init(%{run_id: run_id, ws_pid_self: nil} = init_args) do
    init(%{init_args | ws_pid_self: self()})
  end

  def init(%{run_id: run_id}) do
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:bytes")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:events")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:state")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:snapshot")
    {:ok, %{run_id: run_id, viewer_id: nil, dims: {80, 24}, is_focused: false}}
  end

  # ----- text frames -----

  @impl true
  def handle_in({text, [opcode: :text]}, %{run_id: run_id} = state) do
    case Jason.decode(text) do
      {:ok, %{"type" => "hello", "cols" => cols, "rows" => rows}}
      when is_integer(cols) and is_integer(rows) ->
        state = ensure_registered(state, cols, rows)
        # Reply to THIS viewer with the current snapshot, regardless
        # of focus state. (Driving viewer's resize broadcast is
        # handled separately inside RunServer.)
        snap = Orchestrator.snapshot(run_id)
        frame = Jason.encode!(%{type: "snapshot", ansi: snap.ansi, cols: snap.cols, rows: snap.rows})
        {:push, {:text, frame}, state}

      {:ok, %{"type" => "resize", "cols" => cols, "rows" => rows}}
      when is_integer(cols) and is_integer(rows) ->
        state = ensure_registered(state, cols, rows)
        Orchestrator.viewer_resized(run_id, state.viewer_id, cols, rows)
        {:ok, state}

      {:ok, %{"type" => "focus"}} ->
        if state.viewer_id, do: Orchestrator.viewer_focused(run_id, state.viewer_id)
        {:ok, state}

      {:ok, %{"type" => "blur"}} ->
        if state.viewer_id, do: Orchestrator.viewer_blurred(run_id, state.viewer_id)
        {:ok, state}

      _ ->
        {:ok, state}
    end
  end

  # ----- binary frames: forward to stdin, synthesize focus -----
  def handle_in({data, [opcode: :binary]}, %{run_id: run_id} = state) do
    if state.viewer_id && not state.is_focused do
      Orchestrator.viewer_focused(run_id, state.viewer_id)
    end
    Orchestrator.write_stdin(run_id, data)
    {:ok, state}
  end

  # ----- events from RunServer -----

  @impl true
  def handle_info({:bytes, chunk}, state), do: {:push, {:binary, chunk}, state}

  def handle_info({:snapshot, frame}, state) do
    {:push, {:text, Jason.encode!(frame)}, state}
  end

  def handle_info({:state, frame}, state) do
    {:push, {:text, Jason.encode!(frame)}, state}
  end

  def handle_info({:event, %{type: "focus_state", focused_viewer: focused_id} = _evt}, state) do
    by_self = state.viewer_id != nil and state.viewer_id == focused_id
    is_focused = focused_id != nil and by_self
    state = %{state | is_focused: is_focused}
    frame = Jason.encode!(%{type: "focus_state", focused: focused_id != nil, by_self: by_self})
    {:push, {:text, frame}, state}
  end

  def handle_info({:event, frame}, state), do: {:push, {:text, Jason.encode!(frame)}, state}

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{run_id: run_id, viewer_id: viewer_id}) when not is_nil(viewer_id) do
    Orchestrator.viewer_left(run_id, viewer_id)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  # ----- helpers -----

  defp ensure_registered(%{viewer_id: nil} = state, cols, rows) do
    case Orchestrator.viewer_joined(state.run_id, self(), cols, rows) do
      {:ok, vid} -> %{state | viewer_id: vid, dims: {cols, rows}}
      _ -> state  # registration failed; subsequent ops will be no-ops
    end
  end

  defp ensure_registered(state, _cols, _rows), do: state
end
```

Add public API on `FBI.Orchestrator` (in `orchestrator.ex`):
```elixir
def viewer_joined(run_id, ws_pid, cols, rows), do: RunServer.viewer_joined(run_id, ws_pid, cols, rows)
def viewer_focused(run_id, viewer_id), do: RunServer.viewer_focused(run_id, viewer_id)
def viewer_blurred(run_id, viewer_id), do: RunServer.viewer_blurred(run_id, viewer_id)
def viewer_left(run_id, viewer_id), do: RunServer.viewer_left(run_id, viewer_id)
def viewer_resized(run_id, viewer_id, cols, rows), do: RunServer.viewer_resized(run_id, viewer_id, cols, rows)

def snapshot(run_id) do
  case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
    [{pid, _}] -> GenServer.call(pid, :snapshot)
    [] -> %{ansi: "\e[2J\e[H", cols: 80, rows: 24}  # graceful fallback if run gone
  end
end
```

Add corresponding RunServer.viewer_resized/4 + viewer_blurred/2 handlers, and a `:snapshot` GenServer.call handler that returns the current snapshot.

- [ ] **Step 3: Test**

```bash
cd /workspace/server-elixir && mix test
```

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add server-elixir/ && \
  git commit -m "feat(ws): honor re-hello, focus, blur, implicit focus on stdin"
```

---

## Phase 7: Transcript controller mode prefix

### Task 7.1: Auto-prepend mode-state for non-zero ranges

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/transcript_controller.ex`
- Modify: `server-elixir/lib/fbi/orchestrator.ex`

- [ ] **Step 1: Add `Orchestrator.snapshot_at(run_id, offset)` public API**

```elixir
def snapshot_at(run_id, offset) do
  case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
    [{pid, _}] -> GenServer.call(pid, {:snapshot_at, offset})
    [] -> %{ansi: ""}
  end
end
```

In RunServer:
```elixir
def handle_call({:snapshot_at, offset}, _from, state) do
  case state.term_handle do
    nil -> {:reply, %{ansi: ""}, state}
    h -> {:reply, FBI.Terminal.snapshot_at(h, offset), state}
  end
end
```

- [ ] **Step 2: Update transcript_controller**

```elixir
case parse_range(range_header, total) do
  nil ->
    send_resp(conn, 200, LogStore.read_all(run.log_path))

  {:ok, 0, end_offset} ->
    body = LogStore.read_range(run.log_path, 0, end_offset)
    conn
    |> put_resp_header("content-range", "bytes 0-#{end_offset}/#{total}")
    |> send_resp(206, body)

  {:ok, start_offset, end_offset} ->
    # Non-zero start: prepend the mode-state prefix so xterm.js replays
    # this chunk in the correct buffer / scroll region / mode state.
    %{ansi: prefix} = FBI.Orchestrator.snapshot_at(id, start_offset)
    body = LogStore.read_range(run.log_path, start_offset, end_offset)
    combined = prefix <> body

    conn
    |> put_resp_header("content-range", "bytes #{start_offset}-#{end_offset}/#{total}")
    |> put_resp_header("x-transcript-mode-prefix-bytes", Integer.to_string(byte_size(prefix)))
    |> send_resp(206, combined)

  :invalid ->
    conn
    |> put_resp_header("content-range", "bytes */#{total}")
    |> send_resp(416, "")
end
```

- [ ] **Step 3: Add controller test**

Test that:
- `Range: bytes=0-100` returns no prefix header.
- `Range: bytes=100-200` returns the prefix header with a numeric value.
- The combined body length equals `prefix + (end - start + 1)`.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add server-elixir/ && \
  git commit -m "feat(transcript): auto-prepend mode-state for non-zero-start ranges"
```

---

## Phase 8: Frontend changes

### Task 8.1: byte-buffering during rebuild + delete reclaim loop

**Files:**
- Modify: `src/web/lib/terminalController.ts`

- [ ] **Step 1: Locate the byte handler at controller.ts:151-170 and the reclaim loop at controller.ts:137-141**

```bash
cd /workspace && sed -n '130,175p' src/web/lib/terminalController.ts
```

- [ ] **Step 2: Apply both changes**

For the byte handler, move the buffering before the gate:

```typescript
this.unsubBytes = this.shell.onBytes((data) => {
  if (this.disposed) return;
  // Always retain the live tail and advance liveOffset, regardless of
  // pause/rebuild state. Dropping bytes from liveTailBytes here means
  // resume's tail-fetch math undershoots and the rebuild loses content
  // permanently — see spec §7. Only the visible-render is gated.
  const next = new Uint8Array(this.liveTailBytes.byteLength + data.byteLength);
  next.set(this.liveTailBytes);
  next.set(data, this.liveTailBytes.byteLength);
  this.liveTailBytes = next;
  this.liveOffset += data.byteLength;
  if (this.paused || this.rebuilding) return;
  this.term.write(data);
  this.bumpReadySilenceTimer();
});
```

For the reclaim loop, delete the `if (snap.cols !== this.term.cols ...)` block entirely. A dim mismatch is now an expected, design-intended state.

- [ ] **Step 3: Test + commit**

```bash
cd /workspace && npm run test -- terminalController
cd /workspace && git add src/web/lib/terminalController.ts && \
  git commit -m "refactor(controller): always retain live tail; delete reclaim loop"
```

### Task 8.2: Focus events + focus_state consumption + ws.ts methods

**Files:**
- Modify: `src/web/lib/ws.ts`
- Modify: `src/web/lib/terminalController.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add `RunWsFocusStateMessage` type**

In `src/shared/types.ts`, alongside other RunWs* types:
```typescript
export interface RunWsFocusStateMessage {
  type: 'focus_state';
  focused: boolean;
  by_self: boolean;
}
```

- [ ] **Step 2: Add `sendFocus()` / `sendBlur()` to ShellHandle**

In `src/web/lib/ws.ts`, locate the ShellHandle interface and methods. Add:
```typescript
sendFocus(): void {
  this.send_text(JSON.stringify({ type: 'focus' }));
}

sendBlur(): void {
  this.send_text(JSON.stringify({ type: 'blur' }));
}
```

(Reusing the existing send-text path used by `sendHello`.)

- [ ] **Step 3: Wire focus events in terminalController.ts**

In the controller constructor, set up:
- A `private isFocused = false` field.
- A `document.addEventListener('visibilitychange', ...)` handler that calls `sendFocus()` when becoming visible, `sendBlur()` when hidden. Track the cleanup via `this.unsubVisibility`.
- In the existing `term.onData(...)` (input handler), call `sendFocus()` if `!this.isFocused`.
- An `onTypedEvent` filter for `focus_state` that sets `this.isFocused = msg.focused && msg.by_self`.

The `unsubEvents` typed-event subscriber already exists; add a `focus_state` branch:
```typescript
else if (msg.type === 'focus_state') {
  this.isFocused = msg.focused && msg.by_self;
  publishFocusState(runId, msg as RunWsFocusStateMessage);
}
```

Implement `publishFocusState` in the per-run pub-sub registry (same shape as `publishUsage`, `publishState`, etc.).

- [ ] **Step 4: Test + commit**

```bash
cd /workspace && npm run test
cd /workspace && git add src/ && git commit -m "feat(web): focus events + focus_state propagation"
```

### Task 8.3: TerminalTakeoverBanner component + Terminal.tsx integration

**Files:**
- Create: `src/web/components/TerminalTakeoverBanner.tsx`
- Modify: `src/web/components/Terminal.tsx`

- [ ] **Step 1: Banner component**

```typescript
// /workspace/src/web/components/TerminalTakeoverBanner.tsx
import { useEffect, useState } from 'react';
import type { ShellHandle } from '../lib/ws';

interface Props {
  shell: ShellHandle;
  termCols: number;
  termRows: number;
  snapshotCols: number;
  snapshotRows: number;
  isFocused: boolean;
  onTakeover: () => void;
}

/**
 * Shown when this viewer's local terminal dims don't match the PTY's
 * actual dims AND this viewer isn't the one driving the PTY (i.e.
 * another viewer has focus). Click "Take over" to send a focus event,
 * which causes the server to resize the PTY to this viewer's dims and
 * broadcast a fresh snapshot to all viewers.
 *
 * Banner is dismissible per session only — no localStorage. Reappears
 * on the next dim-mismatch transition.
 */
export function TerminalTakeoverBanner({
  shell, termCols, termRows, snapshotCols, snapshotRows, isFocused, onTakeover,
}: Props) {
  const [dismissed, setDismissed] = useState(false);
  const dimsMatch = termCols === snapshotCols && termRows === snapshotRows;
  const visible = !isFocused && !dimsMatch && !dismissed;

  useEffect(() => {
    // Reset dismissal whenever the mismatch goes away — the next mismatch
    // is a fresh event the user might want to see.
    if (dimsMatch) setDismissed(false);
  }, [dimsMatch]);

  if (!visible) return null;
  return (
    <div className="terminal-takeover-banner" role="status" aria-live="polite">
      <span>
        Showing terminal at {snapshotCols}×{snapshotRows} (driven by another viewer)
      </span>
      <button onClick={() => { onTakeover(); shell.sendFocus(); }}>
        Take over
      </button>
      <button aria-label="Dismiss" onClick={() => setDismissed(true)}>×</button>
    </div>
  );
}
```

- [ ] **Step 2: Mount in Terminal.tsx + overflow:auto**

In `Terminal.tsx`, subscribe to focus_state via the pub-sub function, track snapshot dims (the controller already has this), and render `<TerminalTakeoverBanner>` above the xterm host. Set `style={{ overflow: 'auto' }}` on the wrapper div.

- [ ] **Step 3: Add basic styling**

Either inline or in the corresponding CSS module — thin yellow/blue strip above the terminal, "Take over" button styled to look clickable.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add src/ && git commit -m "feat(web): TerminalTakeoverBanner + dim-mismatch scroll"
```

### Task 8.4: Read X-Transcript-Mode-Prefix-Bytes header

**Files:**
- Modify: `src/web/lib/terminalController.ts` (or wherever `loadOlderChunk` lives — it's in controller.ts:590)

- [ ] **Step 1: Update fetch handling in `loadOlderChunk`**

After the existing `const res = await fetch(...)`, capture the prefix length:
```typescript
const prefixLen = Number(res.headers.get('X-Transcript-Mode-Prefix-Bytes') ?? '0');
const fullBytes = new Uint8Array(await res.arrayBuffer());
const prefix = fullBytes.subarray(0, prefixLen);
const chunk = fullBytes.subarray(prefixLen);
```

Then write `prefix + chunk` into the rebuild buffers, but treat `chunk.byteLength` as the count for `loadedStartOffset` adjustment. The mode prefix is "free" — it sets state but doesn't represent historical content, so it shouldn't shift the byte-offset accounting that's used to dedupe against the live tail.

```typescript
const newLoaded = concat([prefix, chunk, this.loadedBytes]);
// loadedStartOffset advances by chunk.byteLength only (not prefix length).
this.loadedStartOffset = start;  // unchanged from current logic — start is the chunk's own start
```

- [ ] **Step 2: Commit**

```bash
cd /workspace && git add src/ && \
  git commit -m "feat(web): consume X-Transcript-Mode-Prefix-Bytes header"
```

---

## Phase 9: E2E Playwright specs

### Task 9.1: Per-scenario reload-equality specs

**Files:**
- Create: `tests/e2e/quantico/terminal-alt-screen-cycle.spec.ts`
- Create: `tests/e2e/quantico/terminal-scroll-region.spec.ts`
- (and others as needed for the 8 new scenarios)

- [ ] **Step 1: Author one spec, verify pattern works**

```typescript
// /workspace/tests/e2e/quantico/terminal-alt-screen-cycle.spec.ts
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('alt-screen-cycle: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'alt-screen-cycle' });
  try {
    // Wait for scenario to run to completion.
    await page.waitForTimeout(2000);
    const liveText = await run.terminalText();

    // Force a reload (snapshot rebuild path).
    await page.reload();
    await page.waitForTimeout(1500);
    const rebuiltText = await run.terminalText();

    // Snapshot must reproduce the live state.
    expect(rebuiltText).toEqual(liveText);
  } finally {
    await run.destroy();
  }
});
```

- [ ] **Step 2: Verify it runs**

```bash
cd /workspace && npx playwright test tests/e2e/quantico/terminal-alt-screen-cycle.spec.ts
```

- [ ] **Step 3: Replicate for each new scenario**

Same pattern, swap `scenario:`. Commit each.

- [ ] **Step 4: Commit batch**

```bash
cd /workspace && git add tests/e2e/quantico/terminal-*.spec.ts && \
  git commit -m "test(e2e): per-scenario snapshot-reload-equality specs"
```

### Task 9.2: Takeover banner spec

**Files:**
- Create: `tests/e2e/quantico/terminal-takeover-banner.spec.ts`

- [ ] **Step 1: Multi-context spec**

```typescript
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('takeover-banner: appears for non-driving viewer at different size; click takes over', async ({ browser }) => {
  const ctxA = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pageA = await ctxA.newPage();
  const run = await createMockRun(pageA, { scenario: 'chatty' });

  const ctxB = await browser.newContext({ viewport: { width: 600, height: 400 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(pageA.url());

  // B should see the takeover banner because A is driving at a different size.
  await expect(pageB.getByText(/Take over/)).toBeVisible({ timeout: 5000 });

  // Click takeover; B's PTY size becomes the driver.
  await pageB.getByRole('button', { name: /Take over/ }).click();
  await expect(pageB.getByText(/Take over/)).toBeHidden({ timeout: 5000 });
  // A should now see the banner instead.
  await expect(pageA.getByText(/Take over/)).toBeVisible({ timeout: 5000 });

  await run.destroy();
  await ctxA.close();
  await ctxB.close();
});
```

- [ ] **Step 2: Commit**

```bash
cd /workspace && git add tests/e2e/quantico/terminal-takeover-banner.spec.ts && \
  git commit -m "test(e2e): takeover banner multi-viewer flow"
```

### Task 9.3: Chunk load + rebuild-no-byte-loss

**Files:**
- Create: `tests/e2e/quantico/terminal-chunk-load.spec.ts`
- Create: `tests/e2e/quantico/terminal-rebuild-no-byte-loss.spec.ts`

- [ ] **Step 1: chunk-load**

Use `scrollback-stress` scenario; scroll into history; verify modes are correct (e.g., look for content that depends on alt-screen state).

- [ ] **Step 2: rebuild-no-byte-loss**

Use `chatty`; trigger many rebuilds during high byte rate; verify final state matches expected output.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add tests/e2e/quantico/ && git commit -m "test(e2e): chunk-load + no-byte-loss specs"
```

---

## Phase 10: Cleanup + docs

### Task 10.1: Remove dead deps + update prior specs

**Files:**
- Modify: `package.json` (if any deps become unused)
- Modify: prior terminal-*.md spec files

- [ ] **Step 1: Add "superseded" headers**

In each of:
- `docs/superpowers/specs/2026-04-22-terminal-robustness-design.md`
- `docs/superpowers/specs/2026-04-23-terminal-hardening-design.md`
- `docs/superpowers/specs/2026-04-23-terminal-robust-redesign-design.md`

Add at the top:
```markdown
> **Superseded by [2026-04-26-terminal-rust-rewrite-design.md](2026-04-26-terminal-rust-rewrite-design.md).** The redesign in this doc has been replaced by a Rust-based server-side virtual terminal.
```

- [ ] **Step 2: Commit**

```bash
cd /workspace && git add docs/ && git commit -m "docs: supersede prior terminal-robustness specs"
```

---

## Self-review notes for the executor

1. **alacritty_terminal API may differ** from the function names sketched here. Trust the actual crate over this plan's prose; the spec's design contracts are stable but the implementation may need to adapt.
2. **The diff harness (Task 3.2) is the most novel piece.** Spend time on the grid normalization and the JSON dump format. If a single scenario fails, treat it as a real bug to fix in the parser/serializer, not as "tighten the comparison."
3. **Phases 1–4 can be completed without touching the existing Elixir code.** They're pure additions and new tests. Phase 5 onward is where the rip-and-replace cutover happens.
4. **Do NOT skip the diff harness.** It's the gate. If you're tempted to ship Phase 5+ before the harness passes, stop — the gate exists for a reason.
5. **Comment generously.** This rewrite supersedes ~6 months of attempted fixes. Future readers (humans and agents) need to understand why this approach is different and why it works.
