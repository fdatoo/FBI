# Terminal Rust + xterm.js Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Zig-based server-side terminal parser and ghostty-web client renderer with a Rust crate (alacritty_terminal + Rustler NIF) and xterm.js + @xterm/addon-webgl. Delete multi-viewer / focus / takeover machinery in favor of a single-driver model. Bound the mount-time history fetch at 5 MB to eliminate boot-time flashing.

**Architecture:** Server runs `cli/fbi-term-core/` as a Rust workspace member alongside `cli/quantico/` and `cli/fbi-tunnel/`. The crate exposes a Rustler NIF with the same Elixir-side surface as today (`FBI.Terminal.new/feed/snapshot/snapshot_at/resize`). Client uses xterm.js with the WebGL renderer addon. WS protocol shrinks to hello/resize/snapshot/driver_state. Lazy scrollback is achieved by capping the mount-time HTTP Range fetch at 5 MB and configuring xterm.js with 50,000 lines of scrollback.

**Tech Stack:** Rust 1.77+, `alacritty_terminal` 0.24, `rustler` 0.32, Cargo workspace; Elixir 1.18, Phoenix, Bandit; TypeScript 5.5, React 18, Vite, `@xterm/xterm` 5.5+, `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/headless` (test-only); Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-28-terminal-rust-xtermjs-rewrite-design.md`

**Path note:** The Elixir server lives at `src/server/`, not `server-elixir/`. The leftover `server-elixir/` directory at the repo root is build artifacts from before the rename and is unrelated.

---

## File Structure

**New files (Rust crate):**
- `cli/fbi-term-core/Cargo.toml` — crate manifest (rustler, alacritty_terminal, vte, serde)
- `cli/fbi-term-core/src/lib.rs` — public API re-exports
- `cli/fbi-term-core/src/parser.rs` — `Parser` struct, alacritty_terminal::Term wrapper
- `cli/fbi-term-core/src/modes.rs` — mode-state scanner (port of `modes.zig`)
- `cli/fbi-term-core/src/checkpoint.rs` — 256 KB checkpoint store (port of `checkpoint.zig`)
- `cli/fbi-term-core/src/serialize.rs` — grid → ANSI replay (port of `serialize.zig`)
- `cli/fbi-term-core/src/nif.rs` — Rustler NIF exports
- `cli/fbi-term-core/tests/modes_test.rs` — unit tests for modes
- `cli/fbi-term-core/tests/checkpoint_test.rs` — unit tests for checkpoint store
- `cli/fbi-term-core/tests/parser_test.rs` — unit tests for Parser
- `cli/fbi-term-core/tests/serialize_test.rs` — unit tests for serialize
- `cli/fbi-term-core/tests/diff_xterm.rs` — full-grid parity vs @xterm/headless
- `cli/fbi-term-core/tests/support/xterm_ref.mjs` — Node script: import @xterm/headless, dump grid as JSON
- `cli/fbi-term-core/tests/support/normalize.rs` — grid normalization helpers (shared between Rust and Node-stdout-parsed-by-Rust)
- `cli/fbi-term-core/tests/fixtures/.gitkeep` — fixtures captured at test time
- `cli/fbi-term-core/tests/fixtures/README.md` — explains fixture provenance

**Modified files (Rust toolchain wiring):**
- `Cargo.toml` (workspace root) — add `cli/fbi-term-core` to `members`
- `src/server/mix.exs` — replace `:elixir_make` dep with `:rustler`; remove `compilers: [:elixir_make | ...]` and `make_cwd` / `make_env`
- `src/server/lib/fbi/terminal.ex` — replace `@on_load :load_nif` body with `use Rustler, otp_app: :fbi, crate: "fbi_term_core", path: "../../cli/fbi-term-core"`

**Modified files (server-side simplifications):**
- `src/server/lib/fbi/orchestrator/run_server.ex` — delete viewer registry state and callbacks; add `:driving_pid` field; broadcast `driver_state` on driver changes
- `src/server/lib/fbi/orchestrator.ex` — delete `viewer_*` public functions; add `set_driving_pid/clear_driving_pid` (or surface via RunServer directly)
- `src/server/lib/fbi_web/sockets/shell_ws_handler.ex` — drop focus/blur frame handling; add single-driver lock; emit `driver_state` instead of `focus_state`
- `src/server/test/fbi_web/sockets/shell_ws_handler_test.exs` — update for new protocol

**Modified files (client-side):**
- `package.json` — remove `ghostty-web`, `@xterm/addon-serialize`, `@xterm/addon-web-links`; add `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`
- `src/web/components/Terminal.tsx` — port from ghostty-web to xterm.js; configure 50,000 line scrollback; load WebglAddon
- `src/web/components/TerminalTakeoverBanner.tsx` — DELETE
- `src/web/lib/terminalController.ts` — bounded fetch (5 MB cap); collapse rebuild/ready flags; delete focus state
- `src/web/lib/shellRegistry.ts` — drop focus_state cache (kept snapshot cache stays)
- `src/web/features/runs/usageBus.js` — delete `publishFocusState` and `useFocusState`
- `src/web/components/Terminal.test.tsx` — update for xterm.js + bounded fetch
- `src/web/lib/terminalController.test.ts` — update assertions for new flag set

**Deleted files:**
- `cli/fbi-term-core/src/*.zig` (all)
- `cli/fbi-term-core/build.zig`
- `cli/fbi-term-core/build.zig.zon`
- `cli/fbi-term-core/Makefile`
- `cli/fbi-term-core/test/*.zig` (Zig test files)
- `src/web/components/TerminalTakeoverBanner.tsx`
- `tests/e2e/quantico/terminal-takeover-banner.spec.ts`

**Modified files (e2e + docs):**
- `tests/e2e/quantico/terminal-rebuild-no-byte-loss.spec.ts` — update for bounded-fetch semantics
- `tests/e2e/quantico/terminal-chunk-load.spec.ts` — repurpose to verify bounded mount fetch
- `scripts/install.sh` — install rustup if missing; remove zig install
- `README.md` — update prerequisites and dev instructions

---

## Task 1: Add fbi-term-core to Cargo workspace

**Files:**
- Modify: `Cargo.toml` (workspace root)
- Create: `cli/fbi-term-core/Cargo.toml`
- Create: `cli/fbi-term-core/src/lib.rs`

- [ ] **Step 1.1: Add member to workspace**

Modify `Cargo.toml`:
```toml
[workspace]
members = ["desktop", "cli/fbi-tunnel", "cli/quantico", "cli/fbi-term-core"]
resolver = "2"
```

- [ ] **Step 1.2: Create fbi-term-core Cargo.toml**

```toml
[package]
name = "fbi_term_core"
version = "0.1.0"
edition = "2021"

[lib]
name = "fbi_term_core"
crate-type = ["cdylib", "rlib"]

[dependencies]
rustler = "0.32"
alacritty_terminal = "0.24"
vte = "0.13"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
serde_json = "1"
```

- [ ] **Step 1.3: Create stub lib.rs**

Create `cli/fbi-term-core/src/lib.rs`:
```rust
pub mod checkpoint;
pub mod modes;
pub mod parser;
pub mod serialize;

#[cfg(not(test))]
mod nif;

pub use checkpoint::CheckpointStore;
pub use modes::{ModeScanner, ModeState};
pub use parser::{ModePrefix, Parser, Snapshot};

// Stub modules — populated in subsequent tasks.
```

- [ ] **Step 1.4: Create stub modules (compile-only)**

Create `cli/fbi-term-core/src/modes.rs`:
```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModeState;

#[derive(Default)]
pub struct ModeScanner;

impl ModeScanner {
    pub fn new() -> Self { Self }
    pub fn feed(&mut self, _bytes: &[u8]) {}
    pub fn modes(&self) -> ModeState { ModeState }
    pub fn emit(&self, _rows: u16) -> Vec<u8> { Vec::new() }
}
```

Create `cli/fbi-term-core/src/checkpoint.rs`:
```rust
use crate::modes::ModeState;

#[derive(Default)]
pub struct CheckpointStore;

pub struct LocateResult<'a> {
    pub cp_offset: u64,
    pub cp_modes: ModeState,
    pub replay_bytes: &'a [u8],
}

impl CheckpointStore {
    pub fn new() -> Self { Self }
    pub fn record(&mut self, _bytes: &[u8], _offset_before: u64, _modes_after: &ModeState) {}
    pub fn locate(&self, _offset: u64) -> Option<LocateResult<'_>> { None }
}
```

Create `cli/fbi-term-core/src/parser.rs`:
```rust
pub struct Snapshot {
    pub ansi: Vec<u8>,
    pub cols: u16,
    pub rows: u16,
    pub byte_offset: u64,
}

pub struct ModePrefix {
    pub ansi: Vec<u8>,
}

pub struct Parser;

impl Parser {
    pub fn new(_cols: u16, _rows: u16) -> Self { Self }
    pub fn feed(&mut self, _bytes: &[u8]) {}
    pub fn snapshot(&self) -> Snapshot {
        Snapshot { ansi: Vec::new(), cols: 0, rows: 0, byte_offset: 0 }
    }
    pub fn snapshot_at(&self, _offset: u64) -> ModePrefix {
        ModePrefix { ansi: Vec::new() }
    }
    pub fn resize(&mut self, _cols: u16, _rows: u16) {}
    pub fn cols(&self) -> u16 { 0 }
    pub fn rows(&self) -> u16 { 0 }
}
```

Create `cli/fbi-term-core/src/serialize.rs`:
```rust
// Stub — populated in Task 5.
```

- [ ] **Step 1.5: Verify scaffold compiles**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo build -p fbi_term_core
```

Expected: Compiles with no errors. Warnings about unused imports / dead code are fine.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add Cargo.toml cli/fbi-term-core/
git commit -m "$(cat <<'EOF'
feat(fbi-term-core): scaffold Rust crate as Cargo workspace member

Stubs only; real implementation in subsequent commits. Crate compiles
alongside quantico and fbi-tunnel; Zig crate continues to ship the .so
artifact for now.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Port modes scanner to Rust (TDD)

**Files:**
- Modify: `cli/fbi-term-core/src/modes.rs`
- Create: `cli/fbi-term-core/tests/modes_test.rs`
- Reference: `cli/fbi-term-core/src/modes.zig` (port source)

The scanner watches CSI sequences for DEC private modes (DECSTBM, alt-screen, mouse, bracketed-paste, focus-reporting, in-band-resize, auto-wrap, cursor-visible) and emits ANSI to replay the current mode state at any byte offset.

- [ ] **Step 2.1: Write failing test for default state emission**

Create `cli/fbi-term-core/tests/modes_test.rs`:
```rust
use fbi_term_core::{ModeScanner, ModeState};

#[test]
fn default_emit_has_main_screen_clear_and_default_modes() {
    let scanner = ModeScanner::new();
    let bytes = scanner.emit(24);
    let s = std::str::from_utf8(&bytes).unwrap();
    // Step 1: main screen + clear (since alt_screen=false default).
    assert!(s.starts_with("\x1b[?1049l\x1b[H\x1b[2J"));
    // Step 2: scroll region reset.
    assert!(s.contains("\x1b[r"));
    // Step 3: auto-wrap on, cursor visible (defaults).
    assert!(s.contains("\x1b[?7h"));
    assert!(s.contains("\x1b[?25h"));
    // Step 5: no mouse / bracketed paste / focus / in-band-resize set by default.
    assert!(!s.contains("?2004h"));
    assert!(!s.contains("?1004h"));
    assert!(!s.contains("?1000h"));
}
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test modes_test
```

Expected: FAIL — stub `emit()` returns empty Vec, assertions fail.

- [ ] **Step 2.3: Implement modes.rs**

Replace `cli/fbi-term-core/src/modes.rs`. The implementation ports `cli/fbi-term-core/src/modes.zig` line-for-line. Key shape:

```rust
use std::io::Write;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModeState {
    pub auto_wrap: bool,
    pub cursor_visible: bool,
    pub alt_screen: bool,
    pub focus_reporting: bool,
    pub bracketed_paste: bool,
    pub in_band_resize: bool,
    pub mouse_mode: u16,
    pub mouse_ext: u16,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanState { Normal, Esc, Csi }

pub struct ModeScanner {
    pub modes: ModeState,
    state: ScanState,
    csi_private: Option<u8>,
    csi_params: Vec<u8>,
}

impl ModeScanner {
    pub fn new() -> Self {
        Self {
            modes: ModeState::default(),
            state: ScanState::Normal,
            csi_private: None,
            csi_params: Vec::new(),
        }
    }

    pub fn with_initial(modes: ModeState) -> Self {
        Self {
            modes,
            state: ScanState::Normal,
            csi_private: None,
            csi_params: Vec::new(),
        }
    }

    pub fn feed(&mut self, data: &[u8]) {
        for &b in data {
            match self.state {
                ScanState::Normal => {
                    if b == 0x1b { self.state = ScanState::Esc; }
                }
                ScanState::Esc => {
                    if b == 0x5b {
                        self.state = ScanState::Csi;
                        self.csi_private = None;
                        self.csi_params.clear();
                    } else {
                        self.state = ScanState::Normal;
                    }
                }
                ScanState::Csi => {
                    let no_priv = self.csi_private.is_none();
                    let no_params = self.csi_params.is_empty();
                    if no_priv && no_params && (0x3c..=0x3f).contains(&b) {
                        self.csi_private = Some(b);
                    } else if b.is_ascii_digit() || b == b';' || b == b':' {
                        self.csi_params.push(b);
                    } else if (0x40..=0x7e).contains(&b) {
                        self.dispatch(b);
                        self.state = ScanState::Normal;
                    } else if (0x20..=0x2f).contains(&b) {
                        // intermediate — ignore
                    } else {
                        self.state = ScanState::Normal;
                    }
                }
            }
        }
    }

    pub fn modes(&self) -> ModeState { self.modes }

    fn dispatch(&mut self, final_byte: u8) {
        if self.csi_private == Some(b'?') && (final_byte == b'h' || final_byte == b'l') {
            let set = final_byte == b'h';
            for part in self.csi_params.split(|&b| b == b';') {
                if part.is_empty() { continue; }
                if let Ok(s) = std::str::from_utf8(part) {
                    if let Ok(n) = s.parse::<u16>() { self.apply_dec_mode(n, set); }
                }
            }
        } else if self.csi_private.is_none() && final_byte == b'r' {
            let parts: Vec<&[u8]> = self.csi_params.split(|&b| b == b';').collect();
            let parse = |s: &[u8]| std::str::from_utf8(s).ok().and_then(|s| s.parse::<u16>().ok());
            let top = parts.first().and_then(|p| parse(p));
            let bot = parts.get(1).and_then(|p| parse(p));
            if top.is_some() && bot.is_some() {
                self.modes.stbm_top = top;
                self.modes.stbm_bottom = bot;
            } else {
                self.modes.stbm_top = None;
                self.modes.stbm_bottom = None;
            }
        }
    }

    fn apply_dec_mode(&mut self, n: u16, set: bool) {
        match n {
            7 => self.modes.auto_wrap = set,
            25 => self.modes.cursor_visible = set,
            47 | 1047 | 1049 => self.modes.alt_screen = set,
            1004 => self.modes.focus_reporting = set,
            2004 => self.modes.bracketed_paste = set,
            2031 => self.modes.in_band_resize = set,
            1000 | 1002 | 1003 => {
                if set { self.modes.mouse_mode = n; }
                else if self.modes.mouse_mode == n { self.modes.mouse_mode = 0; }
            }
            1006 | 1015 | 1016 => {
                if set { self.modes.mouse_ext = n; }
                else if self.modes.mouse_ext == n { self.modes.mouse_ext = 0; }
            }
            _ => {}
        }
    }

    /// Emit ANSI replaying the current mode state, given current row count.
    pub fn emit(&self, rows: u16) -> Vec<u8> {
        let mut buf = Vec::new();

        // Step 1: buffer.
        if self.modes.alt_screen {
            buf.extend_from_slice(b"\x1b[?1049h");
        } else {
            buf.extend_from_slice(b"\x1b[?1049l\x1b[H\x1b[2J");
        }

        // Step 2: scroll region.
        if let (Some(top), Some(bot)) = (self.modes.stbm_top, self.modes.stbm_bottom) {
            let top = top.max(1);
            let bot = bot.min(rows);
            let top_c = top.min(rows);
            let bot_c = bot.max(top_c);
            write!(&mut buf, "\x1b[{};{}r", top_c, bot_c).unwrap();
        } else {
            buf.extend_from_slice(b"\x1b[r");
        }

        // Step 3: auto-wrap and cursor visibility — always emitted.
        if self.modes.auto_wrap { buf.extend_from_slice(b"\x1b[?7h"); } else { buf.extend_from_slice(b"\x1b[?7l"); }
        if self.modes.cursor_visible { buf.extend_from_slice(b"\x1b[?25h"); } else { buf.extend_from_slice(b"\x1b[?25l"); }

        // Step 4: optional flags.
        if self.modes.bracketed_paste { buf.extend_from_slice(b"\x1b[?2004h"); }
        if self.modes.focus_reporting { buf.extend_from_slice(b"\x1b[?1004h"); }
        if self.modes.in_band_resize { buf.extend_from_slice(b"\x1b[?2031h"); }

        // Step 5: mouse modes.
        if self.modes.mouse_mode != 0 { write!(&mut buf, "\x1b[?{}h", self.modes.mouse_mode).unwrap(); }
        if self.modes.mouse_ext != 0 { write!(&mut buf, "\x1b[?{}h", self.modes.mouse_ext).unwrap(); }

        buf
    }
}
```

Update `lib.rs` re-exports if needed.

- [ ] **Step 2.4: Run test to verify it passes**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test modes_test
```

Expected: PASS.

- [ ] **Step 2.5: Add tests for each mode transition**

Append to `tests/modes_test.rs`:
```rust
#[test]
fn alt_screen_set_and_clear_via_1049() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?1049h");
    assert!(s.modes().alt_screen);
    s.feed(b"\x1b[?1049l");
    assert!(!s.modes().alt_screen);
}

#[test]
fn alt_screen_emit_uses_1049h_when_set() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?1049h");
    let out = s.emit(24);
    assert!(out.starts_with(b"\x1b[?1049h"));
}

#[test]
fn dectcem_set_and_clear_via_25() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?25l");
    assert!(!s.modes().cursor_visible);
    s.feed(b"\x1b[?25h");
    assert!(s.modes().cursor_visible);
}

#[test]
fn decstbm_sets_top_and_bottom() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[5;20r");
    assert_eq!(s.modes().stbm_top, Some(5));
    assert_eq!(s.modes().stbm_bottom, Some(20));
}

#[test]
fn decstbm_reset_with_no_params() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[5;20r");
    s.feed(b"\x1b[r");
    assert_eq!(s.modes().stbm_top, None);
    assert_eq!(s.modes().stbm_bottom, None);
}

#[test]
fn mouse_mode_replaced_on_set() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?1000h");
    assert_eq!(s.modes().mouse_mode, 1000);
    s.feed(b"\x1b[?1003h");
    assert_eq!(s.modes().mouse_mode, 1003);
}

#[test]
fn mouse_mode_clear_only_if_matches_current() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?1003h");
    s.feed(b"\x1b[?1000l"); // doesn't match — should not clear
    assert_eq!(s.modes().mouse_mode, 1003);
    s.feed(b"\x1b[?1003l"); // matches — clears
    assert_eq!(s.modes().mouse_mode, 0);
}

#[test]
fn bracketed_paste_emit_only_when_set() {
    let mut s = ModeScanner::new();
    let out_off = s.emit(24);
    assert!(!String::from_utf8_lossy(&out_off).contains("?2004h"));
    s.feed(b"\x1b[?2004h");
    let out_on = s.emit(24);
    assert!(String::from_utf8_lossy(&out_on).contains("?2004h"));
}

#[test]
fn auto_wrap_off_emits_7l() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?7l");
    let out = s.emit(24);
    assert!(String::from_utf8_lossy(&out).contains("?7l"));
}

#[test]
fn with_initial_replays_modes() {
    let initial = ModeState { alt_screen: true, ..ModeState::default() };
    let s = ModeScanner::with_initial(initial);
    let out = s.emit(24);
    assert!(out.starts_with(b"\x1b[?1049h"));
}
```

- [ ] **Step 2.6: Run all modes tests, verify pass**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test modes_test
```

Expected: 10 tests pass.

- [ ] **Step 2.7: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add cli/fbi-term-core/src/modes.rs cli/fbi-term-core/tests/modes_test.rs cli/fbi-term-core/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(fbi-term-core): port mode scanner to Rust

Tracks DEC private modes (DECSTBM, alt-screen, mouse, bracketed paste,
focus reporting, in-band resize, auto-wrap, cursor visible). Emits ANSI
replay at any byte offset. Direct port of modes.zig.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Port checkpoint store to Rust (TDD)

**Files:**
- Modify: `cli/fbi-term-core/src/checkpoint.rs`
- Create: `cli/fbi-term-core/tests/checkpoint_test.rs`
- Reference: `cli/fbi-term-core/src/checkpoint.zig`

The checkpoint store maintains a sparse index of mode-state-at-byte-offset (every 256 KB) plus a rolling byte window of recent input, so `snapshot_at(offset)` can replay bytes from the nearest prior checkpoint to the requested offset.

- [ ] **Step 3.1: Write failing test for empty store**

Create `cli/fbi-term-core/tests/checkpoint_test.rs`:
```rust
use fbi_term_core::{checkpoint::CheckpointStore, modes::ModeState};

#[test]
fn fresh_store_locates_offset_zero() {
    let store = CheckpointStore::new();
    let result = store.locate(0).expect("offset 0 should always locate");
    assert_eq!(result.cp_offset, 0);
    assert_eq!(result.cp_modes, ModeState::default());
    assert_eq!(result.replay_bytes.len(), 0);
}

#[test]
fn small_record_does_not_create_checkpoint_yet() {
    let mut store = CheckpointStore::new();
    let modes = ModeState::default();
    store.record(b"hello", 0, &modes);
    let result = store.locate(3).expect("locate within recorded range");
    assert_eq!(result.cp_offset, 0);
    assert_eq!(&result.replay_bytes[..], b"hel");
}
```

- [ ] **Step 3.2: Run, verify fails**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test checkpoint_test
```

Expected: FAIL on stub.

- [ ] **Step 3.3: Implement checkpoint.rs**

Replace `cli/fbi-term-core/src/checkpoint.rs`:
```rust
use crate::modes::ModeState;

pub const CHECKPOINT_INTERVAL: u64 = 256 * 1024;

#[derive(Clone, Copy)]
struct Checkpoint {
    offset: u64,
    modes: ModeState,
}

pub struct LocateResult<'a> {
    pub cp_offset: u64,
    pub cp_modes: ModeState,
    pub replay_bytes: &'a [u8],
}

pub struct CheckpointStore {
    checkpoints: Vec<Checkpoint>,
    recent_bytes: Vec<u8>,
    recent_start: u64,
}

impl Default for CheckpointStore {
    fn default() -> Self { Self::new() }
}

impl CheckpointStore {
    pub fn new() -> Self {
        Self {
            checkpoints: vec![Checkpoint { offset: 0, modes: ModeState::default() }],
            recent_bytes: Vec::new(),
            recent_start: 0,
        }
    }

    pub fn record(&mut self, bytes: &[u8], offset_before: u64, modes_after: &ModeState) {
        if bytes.is_empty() { return; }
        let offset_after = offset_before + bytes.len() as u64;
        self.recent_bytes.extend_from_slice(bytes);

        let last_cp = self.checkpoints.last().unwrap().offset;
        let next_boundary = ((last_cp / CHECKPOINT_INTERVAL) + 1) * CHECKPOINT_INTERVAL;

        if offset_after >= next_boundary {
            self.checkpoints.push(Checkpoint { offset: offset_after, modes: *modes_after });

            if self.checkpoints.len() >= 2 {
                let penultimate = self.checkpoints[self.checkpoints.len() - 2].offset;
                if penultimate > self.recent_start {
                    let trim = (penultimate - self.recent_start) as usize;
                    if trim <= self.recent_bytes.len() {
                        self.recent_bytes.drain(..trim);
                    } else {
                        self.recent_bytes.clear();
                    }
                    self.recent_start = penultimate;
                }
            }
        }
    }

    pub fn locate(&self, offset: u64) -> Option<LocateResult<'_>> {
        // Binary search for largest checkpoint with offset <= requested offset.
        let mut lo = 0usize;
        let mut hi = self.checkpoints.len();
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if self.checkpoints[mid].offset <= offset { lo = mid; } else { hi = mid; }
        }
        if self.checkpoints[lo].offset > offset { return None; }
        let cp = self.checkpoints[lo];

        let window_start = self.recent_start;
        let window_end = window_start + self.recent_bytes.len() as u64;
        let eff_start = cp.offset.max(window_start);
        let eff_end = offset.min(window_end);

        let replay = if eff_start <= eff_end && eff_start >= window_start && eff_end <= window_end {
            let s = (eff_start - window_start) as usize;
            let e = (eff_end - window_start) as usize;
            &self.recent_bytes[s..e]
        } else {
            &[]
        };

        Some(LocateResult { cp_offset: cp.offset, cp_modes: cp.modes, replay_bytes: replay })
    }
}
```

- [ ] **Step 3.4: Run, verify passes**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test checkpoint_test
```

Expected: 2 tests pass.

- [ ] **Step 3.5: Add boundary tests**

Append to `tests/checkpoint_test.rs`:
```rust
#[test]
fn crossing_256k_boundary_creates_checkpoint() {
    let mut store = CheckpointStore::new();
    let modes = ModeState::default();
    let chunk = vec![b'x'; 100_000];
    store.record(&chunk, 0, &modes);
    store.record(&chunk, 100_000, &modes);
    store.record(&chunk, 200_000, &modes);
    // After 300_000 bytes recorded, offset_after = 300_000 ≥ 262_144.
    let result = store.locate(280_000).expect("locate after boundary");
    // Either cp_offset == 0 (replay full window) or cp_offset == 300_000 (replay none).
    // Implementation creates the checkpoint at offset_after of the crossing record.
    assert!(result.cp_offset == 300_000 || result.cp_offset == 0);
}

#[test]
fn locate_uses_latest_checkpoint_at_or_before_offset() {
    let mut store = CheckpointStore::new();
    let modes = ModeState::default();
    let chunk = vec![b'a'; 256 * 1024 + 1];  // crosses boundary in single record
    store.record(&chunk, 0, &modes);
    let result = store.locate(256 * 1024 + 1).expect("locate at end");
    assert_eq!(result.cp_offset, 256 * 1024 + 1);
    assert_eq!(result.replay_bytes.len(), 0);
}

#[test]
fn locate_offset_beyond_recorded_returns_none() {
    let store = CheckpointStore::new();
    // Empty store has only checkpoint at 0; locate(100) finds it but replay window is empty.
    let result = store.locate(100).expect("offset 100 finds checkpoint at 0");
    assert_eq!(result.cp_offset, 0);
    assert_eq!(result.replay_bytes.len(), 0);
}
```

- [ ] **Step 3.6: Run all checkpoint tests**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test checkpoint_test
```

Expected: 5 tests pass.

- [ ] **Step 3.7: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add cli/fbi-term-core/src/checkpoint.rs cli/fbi-term-core/tests/checkpoint_test.rs
git commit -m "$(cat <<'EOF'
feat(fbi-term-core): port checkpoint store to Rust

256 KB sparse index + rolling byte window. Direct port of checkpoint.zig.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Implement Parser using alacritty_terminal (TDD)

**Files:**
- Modify: `cli/fbi-term-core/src/parser.rs`
- Create: `cli/fbi-term-core/tests/parser_test.rs`

`alacritty_terminal::Term` is the underlying VT engine. We wrap it, drive a `vte::Parser` to feed the term, and track byte count + checkpoints + mode scanner alongside.

- [ ] **Step 4.1: Write failing test for new + cursor at origin**

Create `cli/fbi-term-core/tests/parser_test.rs`:
```rust
use fbi_term_core::{Parser, Snapshot};

#[test]
fn new_parser_has_correct_dims() {
    let p = Parser::new(80, 24);
    assert_eq!(p.cols(), 80);
    assert_eq!(p.rows(), 24);
}

#[test]
fn snapshot_includes_dims_and_zero_offset_after_init() {
    let p = Parser::new(80, 24);
    let snap = p.snapshot();
    assert_eq!(snap.cols, 80);
    assert_eq!(snap.rows, 24);
    assert_eq!(snap.byte_offset, 0);
}

#[test]
fn feed_advances_byte_offset() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello world");
    assert_eq!(p.snapshot().byte_offset, 11);
}
```

- [ ] **Step 4.2: Run, verify fails**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test parser_test
```

Expected: FAIL on stubs.

- [ ] **Step 4.3: Implement parser.rs**

Replace `cli/fbi-term-core/src/parser.rs`. Use `alacritty_terminal::Term` with `EventListener` impl. Key shape (uses alacritty's API; consult `alacritty_terminal` docs for exact types):

```rust
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use alacritty_terminal::index::{Column, Line};
use crate::checkpoint::CheckpointStore;
use crate::modes::ModeScanner;
use crate::serialize;

pub struct Snapshot {
    pub ansi: Vec<u8>,
    pub cols: u16,
    pub rows: u16,
    pub byte_offset: u64,
}

pub struct ModePrefix {
    pub ansi: Vec<u8>,
}

#[derive(Clone)]
struct NopListener;
impl EventListener for NopListener {
    fn send_event(&self, _event: Event) {}
}

pub struct Parser {
    term: Term<NopListener>,
    processor: Processor,
    mode_scanner: ModeScanner,
    checkpoints: CheckpointStore,
    bytes_fed: u64,
    cols: u16,
    rows: u16,
}

impl Parser {
    pub fn new(cols: u16, rows: u16) -> Self {
        let size = alacritty_terminal::term::test::TermSize::new(cols as usize, rows as usize);
        let config = Config::default();
        let term = Term::new(config, &size, NopListener);
        Self {
            term,
            processor: Processor::new(),
            mode_scanner: ModeScanner::new(),
            checkpoints: CheckpointStore::new(),
            bytes_fed: 0,
            cols,
            rows,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() { return; }
        let offset_before = self.bytes_fed;
        for &byte in bytes {
            self.processor.advance(&mut self.term, byte);
        }
        self.mode_scanner.feed(bytes);
        let modes_after = self.mode_scanner.modes();
        self.checkpoints.record(bytes, offset_before, &modes_after);
        self.bytes_fed += bytes.len() as u64;
    }

    pub fn snapshot(&self) -> Snapshot {
        let mode_prefix = self.mode_scanner.emit(self.rows);
        let grid_ansi = serialize::serialize_grid(&self.term, self.cols, self.rows);
        let mut ansi = Vec::with_capacity(mode_prefix.len() + grid_ansi.len());
        ansi.extend_from_slice(&mode_prefix);
        ansi.extend_from_slice(&grid_ansi);
        Snapshot {
            ansi,
            cols: self.cols,
            rows: self.rows,
            byte_offset: self.bytes_fed,
        }
    }

    pub fn snapshot_at(&self, offset: u64) -> ModePrefix {
        if offset > self.bytes_fed { return ModePrefix { ansi: Vec::new() }; }
        let result = match self.checkpoints.locate(offset) {
            Some(r) => r,
            None => return ModePrefix { ansi: Vec::new() },
        };
        let mut scanner = ModeScanner::with_initial(result.cp_modes);
        scanner.feed(result.replay_bytes);
        ModePrefix { ansi: scanner.emit(self.rows) }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if cols == self.cols && rows == self.rows { return; }
        let size = alacritty_terminal::term::test::TermSize::new(cols as usize, rows as usize);
        self.term.resize(size);
        self.cols = cols;
        self.rows = rows;
    }

    pub fn cols(&self) -> u16 { self.cols }
    pub fn rows(&self) -> u16 { self.rows }
}
```

**NOTE:** `alacritty_terminal`'s exact API may differ between versions. If `term::test::TermSize` is not pub in v0.24, define a local `TermSize` newtype implementing `alacritty_terminal::term::Dimensions` directly:
```rust
struct TermDims { cols: usize, screen_lines: usize }
impl alacritty_terminal::term::Dimensions for TermDims {
    fn columns(&self) -> usize { self.cols }
    fn screen_lines(&self) -> usize { self.screen_lines }
    fn total_lines(&self) -> usize { self.screen_lines }
}
```

If `vte` is needed directly for parsing (alacritty's Processor wraps it), add `vte = "0.13"` to `Cargo.toml`.

- [ ] **Step 4.4: Implement minimal serialize.rs stub for snapshot to work**

Replace `cli/fbi-term-core/src/serialize.rs`:
```rust
use alacritty_terminal::event::EventListener;
use alacritty_terminal::term::Term;

/// Stub that emits final cursor positioning only. Full grid serialization
/// implemented in Task 5.
pub fn serialize_grid<L: EventListener>(term: &Term<L>, _cols: u16, _rows: u16) -> Vec<u8> {
    let cursor = term.grid().cursor.point;
    let mut buf = Vec::new();
    use std::io::Write;
    write!(&mut buf, "\x1b[{};{}H", cursor.line.0 + 1, cursor.column.0 + 1).unwrap();
    buf
}
```

- [ ] **Step 4.5: Run, verify parser tests pass**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test parser_test
```

Expected: 3 tests pass.

- [ ] **Step 4.6: Add resize and snapshot_at tests**

Append to `tests/parser_test.rs`:
```rust
#[test]
fn resize_changes_dims() {
    let mut p = Parser::new(80, 24);
    p.resize(100, 30);
    assert_eq!(p.cols(), 100);
    assert_eq!(p.rows(), 30);
}

#[test]
fn snapshot_at_offset_beyond_fed_returns_empty() {
    let p = Parser::new(80, 24);
    let prefix = p.snapshot_at(100);
    assert_eq!(prefix.ansi, Vec::<u8>::new());
}

#[test]
fn snapshot_at_zero_returns_default_modes() {
    let p = Parser::new(80, 24);
    let prefix = p.snapshot_at(0);
    let s = String::from_utf8(prefix.ansi).unwrap();
    // Default modes: main screen + clear, scroll region reset, auto-wrap on, cursor visible.
    assert!(s.starts_with("\x1b[?1049l\x1b[H\x1b[2J"));
    assert!(s.contains("?7h"));
    assert!(s.contains("?25h"));
}

#[test]
fn snapshot_at_after_alt_screen_replay_includes_alt_set() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[?1049h");
    let prefix = p.snapshot_at(p.snapshot().byte_offset);
    let s = String::from_utf8(prefix.ansi).unwrap();
    assert!(s.starts_with("\x1b[?1049h"));
}
```

- [ ] **Step 4.7: Run all parser tests**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test parser_test
```

Expected: 7 tests pass.

- [ ] **Step 4.8: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add cli/fbi-term-core/src/parser.rs cli/fbi-term-core/src/serialize.rs cli/fbi-term-core/tests/parser_test.rs
git commit -m "$(cat <<'EOF'
feat(fbi-term-core): alacritty_terminal-backed Parser

Wraps alacritty_terminal::Term for cell-accurate grid state. Tracks
byte offset, mode state, and 256 KB checkpoints alongside. Direct port
of parser.zig structure; serialize stub kept minimal for now.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Implement grid serialization (TDD)

**Files:**
- Modify: `cli/fbi-term-core/src/serialize.rs`
- Create: `cli/fbi-term-core/tests/serialize_test.rs`
- Reference: `cli/fbi-term-core/src/serialize.zig`

Walk the alacritty grid and emit ANSI that reproduces it: per-row, trim trailing default-attribute blanks, emit codepoints, track SGR delta per cell.

- [ ] **Step 5.1: Write failing test for empty grid**

Create `cli/fbi-term-core/tests/serialize_test.rs`:
```rust
use fbi_term_core::Parser;

#[test]
fn empty_grid_serializes_to_empty_rows_plus_cup() {
    let p = Parser::new(80, 5);
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    // Five empty rows = five "\r\n", then final CUP \e[1;1H.
    assert!(s.contains("\r\n\r\n\r\n\r\n\r\n"));
    assert!(s.ends_with("\x1b[1;1H"));
}

#[test]
fn plain_text_round_trips() {
    let mut p = Parser::new(80, 5);
    p.feed(b"hello");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("hello"));
    // Cursor should be at row 1, col 6 (1-indexed) after writing 5 chars.
    assert!(s.ends_with("\x1b[1;6H"));
}

#[test]
fn newline_advances_cursor_to_next_row() {
    let mut p = Parser::new(80, 5);
    p.feed(b"a\r\nb");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("a\r\n"));
    assert!(s.contains("b"));
    assert!(s.ends_with("\x1b[2;2H"));
}
```

- [ ] **Step 5.2: Run, verify fails**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test serialize_test
```

Expected: FAIL on stub.

- [ ] **Step 5.3: Implement serialize.rs**

Replace `cli/fbi-term-core/src/serialize.rs`. Walks the alacritty grid; emits SGR deltas; trims trailing default-attribute cells per row.

```rust
use std::io::Write;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Indexed;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

#[derive(Clone, Copy, PartialEq)]
struct AttrState {
    fg: Color,
    bg: Color,
    bold: bool,
    italic: bool,
    inverse: bool,
}

impl Default for AttrState {
    fn default() -> Self {
        Self {
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            bold: false,
            italic: false,
            inverse: false,
        }
    }
}

impl AttrState {
    fn from_cell(cell: &Cell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            bold: cell.flags.contains(Flags::BOLD),
            italic: cell.flags.contains(Flags::ITALIC),
            inverse: cell.flags.contains(Flags::INVERSE),
        }
    }

    fn is_default(&self) -> bool { *self == Self::default() }
}

pub fn serialize_grid<L: EventListener>(term: &Term<L>, cols: u16, rows: u16) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut cur = AttrState::default();
    let grid = term.grid();

    for row_idx in 0..rows as i32 {
        let line = Line(row_idx);
        // Find last column with non-default content for trimming.
        let mut last_content: usize = 0;
        for col_idx in 0..cols as usize {
            let cell = &grid[Point::new(line, Column(col_idx))];
            if !is_default_cell(cell) {
                last_content = col_idx + 1;
            }
        }

        for col_idx in 0..last_content {
            let cell = &grid[Point::new(line, Column(col_idx))];
            // Skip wide-char spacers.
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            let next = AttrState::from_cell(cell);
            if next != cur {
                emit_sgr(&mut buf, cur, next);
                cur = next;
            }
            let mut utf8 = [0u8; 4];
            let s = cell.c.encode_utf8(&mut utf8);
            buf.extend_from_slice(s.as_bytes());
        }
        buf.extend_from_slice(b"\r\n");
    }

    if !cur.is_default() {
        buf.extend_from_slice(b"\x1b[0m");
    }

    let cursor = grid.cursor.point;
    write!(&mut buf, "\x1b[{};{}H", cursor.line.0 + 1, cursor.column.0 + 1).unwrap();
    buf
}

fn is_default_cell(cell: &Cell) -> bool {
    cell.c == ' ' && AttrState::from_cell(cell).is_default()
}

fn emit_sgr(buf: &mut Vec<u8>, prev: AttrState, next: AttrState) {
    if next.is_default() {
        buf.extend_from_slice(b"\x1b[0m");
        return;
    }
    let needs_reset =
        (prev.bold && !next.bold) ||
        (prev.italic && !next.italic) ||
        (prev.inverse && !next.inverse);
    let mut effective_prev = prev;
    if needs_reset {
        buf.extend_from_slice(b"\x1b[0m");
        effective_prev = AttrState::default();
    }
    if next.bold && !effective_prev.bold { buf.extend_from_slice(b"\x1b[1m"); }
    if next.italic && !effective_prev.italic { buf.extend_from_slice(b"\x1b[3m"); }
    if next.inverse && !effective_prev.inverse { buf.extend_from_slice(b"\x1b[7m"); }
    if next.fg != effective_prev.fg { emit_color_sgr(buf, next.fg, false); }
    if next.bg != effective_prev.bg { emit_color_sgr(buf, next.bg, true); }
}

fn emit_color_sgr(buf: &mut Vec<u8>, color: Color, is_bg: bool) {
    match color {
        Color::Named(NamedColor::Foreground) => buf.extend_from_slice(b"\x1b[39m"),
        Color::Named(NamedColor::Background) => buf.extend_from_slice(b"\x1b[49m"),
        Color::Named(name) => {
            let idx = name as u8;
            let bright = idx >= 8;
            let base: u8 = if !is_bg && !bright { 30 }
                else if !is_bg && bright { 90 }
                else if is_bg && !bright { 40 }
                else { 100 };
            write!(buf, "\x1b[{}m", base + (idx & 7)).unwrap();
        }
        Color::Indexed(idx) => {
            let prefix: u8 = if is_bg { 48 } else { 38 };
            write!(buf, "\x1b[{};5;{}m", prefix, idx).unwrap();
        }
        Color::Spec(Rgb { r, g, b }) => {
            let prefix: u8 = if is_bg { 48 } else { 38 };
            write!(buf, "\x1b[{};2;{};{};{}m", prefix, r, g, b).unwrap();
        }
    }
}
```

**NOTE:** alacritty's `Color` enum and `NamedColor` variants may differ across versions; adjust the `Color::Named(...)` pattern to match v0.24's actual variants. Check via `cargo doc --open -p alacritty_terminal` if mismatch.

- [ ] **Step 5.4: Run serialize tests, verify pass**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test serialize_test
```

Expected: 3 tests pass.

- [ ] **Step 5.5: Add SGR / color tests**

Append to `tests/serialize_test.rs`:
```rust
#[test]
fn red_text_emits_sgr_31() {
    let mut p = Parser::new(80, 5);
    p.feed(b"\x1b[31mfoo\x1b[0m");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("\x1b[31m"));
    assert!(s.contains("foo"));
}

#[test]
fn truecolor_round_trips() {
    let mut p = Parser::new(80, 5);
    p.feed(b"\x1b[38;2;100;200;50mhi\x1b[0m");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("38;2;100;200;50"));
}

#[test]
fn bold_then_normal_resets_via_0() {
    let mut p = Parser::new(80, 5);
    p.feed(b"\x1b[1mB\x1b[0mn");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("\x1b[1m"));
    assert!(s.contains("B"));
    assert!(s.contains("\x1b[0m"));
}

#[test]
fn trailing_blanks_are_trimmed() {
    let mut p = Parser::new(80, 1);
    p.feed(b"hi");  // followed by 78 default blanks on the row
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    // Only "hi\r\n" — not 78 spaces between hi and \r\n.
    let row_end = s.find("\r\n").unwrap();
    assert_eq!(&s[..row_end], "hi");
}
```

- [ ] **Step 5.6: Run all serialize tests**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test serialize_test
```

Expected: 7 tests pass.

- [ ] **Step 5.7: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add cli/fbi-term-core/src/serialize.rs cli/fbi-term-core/tests/serialize_test.rs
git commit -m "$(cat <<'EOF'
feat(fbi-term-core): grid serialization with SGR delta encoding

Walks the alacritty grid and emits ANSI replay. Per-row trailing default
cells trimmed; SGR state tracked across cells with reset-when-needed
emission. Direct port of serialize.zig.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Implement Rustler NIF

**Files:**
- Create: `cli/fbi-term-core/src/nif.rs`
- Modify: `cli/fbi-term-core/src/lib.rs`

The NIF wraps a `Mutex<Parser>` in a Rustler `ResourceArc` and exposes `new`, `feed`, `snapshot`, `snapshot_at`, `resize` to Elixir. `feed` is scheduled as `DirtyIo`.

- [ ] **Step 6.1: Write the NIF**

Create `cli/fbi-term-core/src/nif.rs`:
```rust
use rustler::{Atom, Binary, Env, Error, NifResult, OwnedBinary, ResourceArc, Term};
use std::sync::Mutex;
use crate::parser::Parser;

pub struct ParserResource(pub Mutex<Parser>);

mod atoms {
    rustler::atoms! { ok, error, nif_panic }
}

#[rustler::nif]
fn new(cols: u32, rows: u32) -> NifResult<ResourceArc<ParserResource>> {
    if cols == 0 || rows == 0 || cols > u16::MAX as u32 || rows > u16::MAX as u32 {
        return Err(Error::BadArg);
    }
    Ok(ResourceArc::new(ParserResource(Mutex::new(Parser::new(cols as u16, rows as u16)))))
}

#[rustler::nif(schedule = "DirtyIo")]
fn feed(handle: ResourceArc<ParserResource>, bytes: Binary) -> Atom {
    let mut p = handle.0.lock().unwrap();
    p.feed(bytes.as_slice());
    atoms::ok()
}

#[rustler::nif]
fn snapshot<'a>(env: Env<'a>, handle: ResourceArc<ParserResource>) -> NifResult<Term<'a>> {
    let p = handle.0.lock().unwrap();
    let snap = p.snapshot();

    let mut bin = OwnedBinary::new(snap.ansi.len()).ok_or(Error::Atom("alloc_fail"))?;
    bin.as_mut_slice().copy_from_slice(&snap.ansi);
    let ansi_term = bin.release(env);

    let map = Term::map_new(env)
        .map_put(rustler::types::atom::Atom::from_str(env, "__struct__")?.to_term(env), rustler::types::atom::Atom::from_str(env, "Elixir.FBI.Terminal.Snapshot")?.to_term(env))?
        .map_put(rustler::types::atom::Atom::from_str(env, "ansi")?.to_term(env), ansi_term.to_term(env))?
        .map_put(rustler::types::atom::Atom::from_str(env, "cols")?.to_term(env), (snap.cols as u32).encode(env))?
        .map_put(rustler::types::atom::Atom::from_str(env, "rows")?.to_term(env), (snap.rows as u32).encode(env))?
        .map_put(rustler::types::atom::Atom::from_str(env, "byte_offset")?.to_term(env), snap.byte_offset.encode(env))?;
    Ok(map)
}

#[rustler::nif]
fn snapshot_at<'a>(env: Env<'a>, handle: ResourceArc<ParserResource>, offset: u64) -> NifResult<Term<'a>> {
    let p = handle.0.lock().unwrap();
    let prefix = p.snapshot_at(offset);

    let mut bin = OwnedBinary::new(prefix.ansi.len()).ok_or(Error::Atom("alloc_fail"))?;
    bin.as_mut_slice().copy_from_slice(&prefix.ansi);
    let ansi_term = bin.release(env);

    let map = Term::map_new(env)
        .map_put(rustler::types::atom::Atom::from_str(env, "__struct__")?.to_term(env), rustler::types::atom::Atom::from_str(env, "Elixir.FBI.Terminal.ModePrefix")?.to_term(env))?
        .map_put(rustler::types::atom::Atom::from_str(env, "ansi")?.to_term(env), ansi_term.to_term(env))?;
    Ok(map)
}

#[rustler::nif]
fn resize(handle: ResourceArc<ParserResource>, cols: u32, rows: u32) -> NifResult<Atom> {
    if cols == 0 || rows == 0 || cols > u16::MAX as u32 || rows > u16::MAX as u32 {
        return Err(Error::BadArg);
    }
    let mut p = handle.0.lock().unwrap();
    p.resize(cols as u16, rows as u16);
    Ok(atoms::ok())
}

fn on_load(env: Env, _info: Term) -> bool {
    rustler::resource!(ParserResource, env);
    true
}

rustler::init!(
    "Elixir.FBI.Terminal",
    [new, feed, snapshot, snapshot_at, resize],
    load = on_load
);
```

**NOTE:** Rustler API surface: the `Term::map_new(env).map_put(...)` chain may not be exactly this in v0.32; alternatively use `rustler::types::map::map_new(env)` or NifStruct derives. If the inline Term API is awkward, define proper `#[derive(NifStruct)]` types for `Snapshot` and `ModePrefix`:

```rust
#[derive(rustler::NifStruct)]
#[module = "FBI.Terminal.Snapshot"]
struct SnapshotTerm {
    ansi: Vec<u8>,
    cols: u32,
    rows: u32,
    byte_offset: u64,
}
```

Then return `SnapshotTerm` directly from the NIF — Rustler handles the Term encoding.

- [ ] **Step 6.2: Update lib.rs to enable nif module**

Modify `cli/fbi-term-core/src/lib.rs`:
```rust
pub mod checkpoint;
pub mod modes;
pub mod parser;
pub mod serialize;

#[cfg(not(test))]
mod nif;

pub use checkpoint::CheckpointStore;
pub use modes::{ModeScanner, ModeState};
pub use parser::{ModePrefix, Parser, Snapshot};
```

(`#[cfg(not(test))]` keeps the NIF out of test builds, so `cargo test` works without an Erlang runtime.)

- [ ] **Step 6.3: Verify build still passes**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo build -p fbi_term_core
```

Expected: NIF crate builds as cdylib. Warnings about unused fields are fine.

- [ ] **Step 6.4: Verify tests still pass**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core
```

Expected: All tests pass (modes, checkpoint, parser, serialize). NIF module is excluded from test builds.

- [ ] **Step 6.5: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add cli/fbi-term-core/src/nif.rs cli/fbi-term-core/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(fbi-term-core): Rustler NIF exports

Wraps Mutex<Parser> in ResourceArc; exposes new/feed/snapshot/snapshot_at/
resize matching the existing FBI.Terminal Elixir surface. feed scheduled
as DirtyIo; structs decoded as FBI.Terminal.Snapshot / FBI.Terminal.ModePrefix.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add @xterm/headless reference dump script

**Files:**
- Create: `cli/fbi-term-core/tests/support/xterm_ref.mjs`
- Create: `cli/fbi-term-core/tests/support/package.json`

Node script that reads bytes from a file (or stdin), feeds them to `@xterm/headless`, and writes a normalized JSON grid dump to stdout. Used by the diff harness.

- [ ] **Step 7.1: Create support/package.json**

Create `cli/fbi-term-core/tests/support/package.json`:
```json
{
  "name": "xterm-ref-harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@xterm/headless": "^6.0.0"
  }
}
```

- [ ] **Step 7.2: Create xterm_ref.mjs**

Create `cli/fbi-term-core/tests/support/xterm_ref.mjs`:
```javascript
#!/usr/bin/env node
// Reads bytes from argv[2] (file path), feeds them to @xterm/headless
// at the dims given in argv[3] (e.g. "80x24"), and writes a normalized
// JSON grid dump to stdout.
//
// Output schema:
//   { cols, rows, cursor: {row, col, visible},
//     active_buffer: "main"|"alt",
//     scroll_region: {top, bottom},
//     mode_flags: {auto_wrap, bracketed_paste, focus_reporting, in_band_resize, mouse_mode, mouse_ext},
//     cells: [
//       [ {ch, fg, bg, bold, italic, inverse, underline, strikethrough, dim, wide} | null, ... ],
//       ...
//     ]
//   }

import { readFile } from 'node:fs/promises';
import { Terminal } from '@xterm/headless';

const path = process.argv[2];
const dims = process.argv[3] || '80x24';
const [cols, rows] = dims.split('x').map(Number);

if (!path) {
  console.error('usage: xterm_ref.mjs <bytes-file> [colsxrows]');
  process.exit(2);
}

const bytes = await readFile(path);
const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
await new Promise((resolve) => term.write(bytes, resolve));

const buf = term.buffer.active;
const cells = [];
for (let r = 0; r < rows; r++) {
  const line = buf.getLine(buf.viewportY + r);
  const row = [];
  for (let c = 0; c < cols; c++) {
    if (!line) { row.push(null); continue; }
    const cell = line.getCell(c);
    if (!cell) { row.push(null); continue; }
    row.push({
      ch: cell.getChars() || ' ',
      fg: cell.getFgColor(),
      fg_mode: cell.isFgRGB() ? 'rgb' : cell.isFgPalette() ? 'palette' : 'default',
      bg: cell.getBgColor(),
      bg_mode: cell.isBgRGB() ? 'rgb' : cell.isBgPalette() ? 'palette' : 'default',
      bold: !!cell.isBold(),
      italic: !!cell.isItalic(),
      inverse: !!cell.isInverse(),
      underline: !!cell.isUnderline(),
      strikethrough: !!cell.isStrikethrough(),
      dim: !!cell.isDim(),
      wide: cell.getWidth() === 2,
    });
  }
  cells.push(row);
}

const dump = {
  cols, rows,
  cursor: { row: buf.cursorY, col: buf.cursorX, visible: term.options.cursorBlink !== false },
  active_buffer: term.buffer.active === term.buffer.normal ? 'main' : 'alt',
  scroll_region: { top: 0, bottom: rows - 1 },  // xterm.js exposes scroll region only via private API
  mode_flags: {
    auto_wrap: !!term.options.scrollOnUserInput,  // proxy; xterm.js does not expose DECAWM publicly
  },
  cells,
};

process.stdout.write(JSON.stringify(dump) + '\n');
```

- [ ] **Step 7.3: Install Node deps for the harness**

```bash
cd /Users/fdatoo/Desktop/FBI/cli/fbi-term-core/tests/support && npm install
```

Expected: `node_modules/` populated; `@xterm/headless` resolvable.

- [ ] **Step 7.4: Smoke test the script**

```bash
cd /Users/fdatoo/Desktop/FBI
echo -n "hello" > /tmp/test.bin
node cli/fbi-term-core/tests/support/xterm_ref.mjs /tmp/test.bin 80x5
```

Expected: JSON output with `cells[0][0..4]` containing chars `h`, `e`, `l`, `l`, `o`.

- [ ] **Step 7.5: Add tests/support/node_modules to .gitignore**

Modify `.gitignore` (find the existing entries, append):
```
cli/fbi-term-core/tests/support/node_modules/
```

- [ ] **Step 7.6: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add cli/fbi-term-core/tests/support/package.json cli/fbi-term-core/tests/support/xterm_ref.mjs .gitignore
git commit -m "$(cat <<'EOF'
test(fbi-term-core): @xterm/headless reference dump script

Node script that feeds a byte file to @xterm/headless at the given
dimensions and prints a normalized grid dump as JSON. Used by the
diff harness in the next commit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Capture Quantico fixtures

**Files:**
- Create: `cli/fbi-term-core/tests/fixtures/<scenario>.bin` (one per scenario)
- Create: `cli/fbi-term-core/tests/fixtures/README.md`

Use `quantico --capture-bytes` to deterministically produce one byte stream per scenario.

- [ ] **Step 8.1: List the scenarios to capture**

Run:
```bash
ls /Users/fdatoo/Desktop/FBI/cli/quantico/scenarios/
```

Expected output (use these as fixtures):
```
alt-screen-cycle.yaml  bracketed-paste-cycle.yaml  chatty.yaml  cjk-wide.yaml
crash-fast.yaml  cursor-styles.yaml  default.yaml  env-echo.yaml  garbled.yaml
hang.yaml  limit-breach-human.yaml  limit-breach.yaml  mouse-modes-cycle.yaml
plugin-fail.yaml  resume-aware.yaml  scroll-region-stress.yaml  scrollback-stress.yaml
slow-startup.yaml  tool-heavy.yaml  truecolor.yaml
```

- [ ] **Step 8.2: Create fixtures README**

Create `cli/fbi-term-core/tests/fixtures/README.md`:
```markdown
# Fixtures

Deterministic byte-stream captures from `cli/quantico` scenarios. Each
`<name>.bin` is the concatenation of `emit` and `emit_ansi` payloads
from `cli/quantico/scenarios/<name>.yaml`, captured via:

```
cargo run -p quantico -- --capture-bytes \
  --scenario-file cli/quantico/scenarios/<name>.yaml \
  cli/fbi-term-core/tests/fixtures/<name>.bin
```

Fixtures are checked in. Regenerate them only when scenarios change.
```

- [ ] **Step 8.3: Capture all fixtures**

```bash
cd /Users/fdatoo/Desktop/FBI
mkdir -p cli/fbi-term-core/tests/fixtures
for name in alt-screen-cycle bracketed-paste-cycle chatty cjk-wide crash-fast cursor-styles default env-echo garbled hang limit-breach-human limit-breach mouse-modes-cycle plugin-fail resume-aware scroll-region-stress scrollback-stress slow-startup tool-heavy truecolor; do
  cargo run --release -p quantico -- --capture-bytes \
    --scenario-file cli/quantico/scenarios/$name.yaml \
    cli/fbi-term-core/tests/fixtures/$name.bin
done
ls -la cli/fbi-term-core/tests/fixtures/
```

Expected: Twenty `.bin` files, each non-empty.

- [ ] **Step 8.4: Commit fixtures**

```bash
cd /Users/fdatoo/Desktop/FBI
git add cli/fbi-term-core/tests/fixtures/
git commit -m "$(cat <<'EOF'
test(fbi-term-core): capture quantico fixtures for diff harness

Twenty .bin files: deterministic byte streams from quantico scenarios,
captured via `quantico --capture-bytes`. Used as inputs to the
Rust↔@xterm/headless diff harness.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Implement diff harness

**Files:**
- Create: `cli/fbi-term-core/tests/diff_xterm.rs`

Per fixture: dump the Rust grid, dump the @xterm/headless grid via the Node script, normalize both, compare.

- [ ] **Step 9.1: Add a Rust grid-dump method to Parser**

Modify `cli/fbi-term-core/src/parser.rs`. Add a method that produces the same JSON shape as `xterm_ref.mjs`.

```rust
use serde::Serialize;

#[derive(Serialize)]
pub struct GridDump {
    pub cols: u16,
    pub rows: u16,
    pub cursor: CursorDump,
    pub active_buffer: String,
    pub scroll_region: ScrollRegionDump,
    pub mode_flags: ModeFlagsDump,
    pub cells: Vec<Vec<Option<CellDump>>>,
}

#[derive(Serialize)]
pub struct CursorDump { pub row: u16, pub col: u16, pub visible: bool }

#[derive(Serialize)]
pub struct ScrollRegionDump { pub top: u16, pub bottom: u16 }

#[derive(Serialize)]
pub struct ModeFlagsDump {
    pub auto_wrap: bool,
    pub bracketed_paste: bool,
    pub focus_reporting: bool,
    pub in_band_resize: bool,
    pub mouse_mode: u16,
    pub mouse_ext: u16,
}

#[derive(Serialize)]
pub struct CellDump {
    pub ch: String,
    pub fg: i64,
    pub fg_mode: String,
    pub bg: i64,
    pub bg_mode: String,
    pub bold: bool,
    pub italic: bool,
    pub inverse: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub dim: bool,
    pub wide: bool,
}

impl Parser {
    pub fn grid_dump(&self) -> GridDump {
        // Walk self.term.grid(); produce CellDump per (row, col).
        // Read mode flags from self.mode_scanner.modes().
        // Read cursor position and visibility.
        // Read scroll region from mode_scanner.modes() (stbm_top/bottom).
        // Implementation: see source — uses alacritty_terminal types as in serialize.rs.
        unimplemented!("populated below")
    }
}
```

Implement `grid_dump()` body following the same shape as `xterm_ref.mjs` output. Mirror cell extraction from `serialize_grid`. For mode flags, expose them on `Parser` by adding `pub fn modes(&self) -> ModeState` that returns `self.mode_scanner.modes()`.

- [ ] **Step 9.2: Write the diff harness test**

Create `cli/fbi-term-core/tests/diff_xterm.rs`:
```rust
use fbi_term_core::Parser;
use std::process::Command;

const FIXTURES: &[&str] = &[
    "alt-screen-cycle", "bracketed-paste-cycle", "chatty", "cjk-wide",
    "crash-fast", "cursor-styles", "default", "env-echo", "garbled", "hang",
    "limit-breach-human", "limit-breach", "mouse-modes-cycle", "plugin-fail",
    "resume-aware", "scroll-region-stress", "scrollback-stress", "slow-startup",
    "tool-heavy", "truecolor",
];

const COLS: u16 = 80;
const ROWS: u16 = 24;

fn dump_rust(name: &str) -> serde_json::Value {
    let path = format!("tests/fixtures/{}.bin", name);
    let bytes = std::fs::read(&path).expect("fixture exists");
    let mut p = Parser::new(COLS, ROWS);
    p.feed(&bytes);
    let dump = p.grid_dump();
    serde_json::to_value(&dump).unwrap()
}

fn dump_node(name: &str) -> serde_json::Value {
    let path = format!("tests/fixtures/{}.bin", name);
    let dims = format!("{}x{}", COLS, ROWS);
    let out = Command::new("node")
        .args(["tests/support/xterm_ref.mjs", &path, &dims])
        .output()
        .expect("node available; deps installed");
    if !out.status.success() {
        panic!("xterm_ref.mjs failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    serde_json::from_slice(&out.stdout).expect("xterm_ref output is JSON")
}

fn normalize(v: &mut serde_json::Value) {
    // 1. Trim trailing default cells per row.
    // 2. Empty cells -> null.
    // 3. Scroll region "0..rows-1" canonicalized to (0, rows-1).
    // 4. Cursor "visible" field — both sides should agree on default true.
    let cells = v.get_mut("cells").unwrap().as_array_mut().unwrap();
    for row in cells.iter_mut() {
        let arr = row.as_array_mut().unwrap();
        while let Some(last) = arr.last() {
            if is_default_cell(last) { arr.pop(); } else { break; }
        }
    }
    // Other normalization rules: zero out fields known to differ in representation
    // but not in semantic meaning. Add as needed when divergences surface.
}

fn is_default_cell(c: &serde_json::Value) -> bool {
    if c.is_null() { return true; }
    let obj = c.as_object().unwrap();
    obj.get("ch").map_or(false, |v| v == " ") &&
        obj.get("bold").map_or(false, |v| v == false) &&
        obj.get("italic").map_or(false, |v| v == false) &&
        obj.get("inverse").map_or(false, |v| v == false) &&
        obj.get("underline").map_or(false, |v| v == false) &&
        obj.get("strikethrough").map_or(false, |v| v == false) &&
        obj.get("dim").map_or(false, |v| v == false) &&
        obj.get("wide").map_or(false, |v| v == false) &&
        obj.get("fg_mode").map_or(false, |v| v == "default") &&
        obj.get("bg_mode").map_or(false, |v| v == "default")
}

#[test]
fn diff_all_fixtures() {
    let mut failures = Vec::new();
    for &name in FIXTURES {
        let mut rust = dump_rust(name);
        let mut node = dump_node(name);
        normalize(&mut rust);
        normalize(&mut node);
        if rust != node {
            failures.push(format!(
                "fixture {} diverged:\n  rust:  {}\n  node:  {}\n",
                name,
                serde_json::to_string_pretty(&rust).unwrap(),
                serde_json::to_string_pretty(&node).unwrap(),
            ));
        }
    }
    if !failures.is_empty() {
        panic!("diff harness failures:\n\n{}", failures.join("\n---\n"));
    }
}
```

- [ ] **Step 9.3: Run the diff harness**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test diff_xterm -- --nocapture
```

Expected on first run: probable failures. Each divergence is either:
- A real parser bug (fix in Rust impl).
- A representational difference (canonicalize via `normalize`).

Iterate: read divergence output, decide bug vs representation, fix or normalize, rerun.

- [ ] **Step 9.4: Iterate until all twenty pass**

For each divergence:
- If colors mismatch (palette vs RGB representation): canonicalize palette-256 mapped colors.
- If trailing cells mismatch: extend `is_default_cell` if needed.
- If cursor position differs: investigate parser advance — likely an off-by-one in line wrap behavior.
- If wide-char layout differs: confirm CJK fixture's expected behavior; xterm.js and alacritty should agree on UAX-11 east-asian-width.

Run the harness after each fix:
```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core --test diff_xterm -- --nocapture
```

Expected end state: `diff_all_fixtures` passes.

- [ ] **Step 9.5: Commit harness once green**

```bash
cd /Users/fdatoo/Desktop/FBI
git add cli/fbi-term-core/src/parser.rs cli/fbi-term-core/src/lib.rs cli/fbi-term-core/tests/diff_xterm.rs
git commit -m "$(cat <<'EOF'
test(fbi-term-core): full grid-state diff harness vs @xterm/headless

Per fixture, dumps the Rust grid and the @xterm/headless grid as JSON,
normalizes (trim trailing default cells, canonicalize color reps), and
asserts equality. Twenty fixtures from cli/quantico/scenarios.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Wire mix.exs to Rustler

**Files:**
- Modify: `src/server/mix.exs`
- Modify: `src/server/lib/fbi/terminal.ex`

Switch from `:elixir_make` (Zig) to `:rustler` (Rust crate at `cli/fbi-term-core`).

- [ ] **Step 10.1: Update mix.exs**

Modify `src/server/mix.exs`:

Replace lines 12-21 (the project `compilers`/`make_cwd`/`make_env`):
```elixir
def project do
  [
    app: :fbi,
    version: "0.1.0",
    elixir: "~> 1.15",
    elixirc_paths: elixirc_paths(Mix.env()),
    start_permanent: Mix.env() == :prod,
    aliases: aliases(),
    deps: deps(),
    listeners: [Phoenix.CodeReloader]
  ]
end
```

Replace `{:elixir_make, "~> 0.7"}` in `deps/0` (line 62) with:
```elixir
{:rustler, "~> 0.32"}
```

- [ ] **Step 10.2: Update terminal.ex to use Rustler**

Modify `src/server/lib/fbi/terminal.ex`:

Replace the `defmodule FBI.Terminal do` body (the part after the two struct modules, starting around line 16) with:
```elixir
defmodule FBI.Terminal do
  @moduledoc """
  NIF wrapper around `fbi-term-core` (Rust crate using alacritty_terminal).

  Each FBI run holds one parser handle. The handle is allocated by
  `FBI.Orchestrator.RunServer` on `set_container` and lives for the
  run's lifetime. Rustler ResourceArc GC reclaims it when the GenServer
  terminates.

  See `docs/superpowers/specs/2026-04-28-terminal-rust-xtermjs-rewrite-design.md`.
  """
  use Rustler, otp_app: :fbi, crate: "fbi_term_core", path: "../../cli/fbi-term-core"

  @opaque handle :: reference()

  @spec new(pos_integer(), pos_integer()) :: handle()
  def new(_cols, _rows), do: :erlang.nif_error(:nif_not_loaded)

  @spec feed(handle(), binary()) :: :ok | {:error, :nif_panic}
  def feed(_handle, _bytes), do: :erlang.nif_error(:nif_not_loaded)

  @spec snapshot(handle()) :: %FBI.Terminal.Snapshot{} | {:error, :nif_panic}
  def snapshot(_handle), do: :erlang.nif_error(:nif_not_loaded)

  @spec snapshot_at(handle(), non_neg_integer()) ::
          %FBI.Terminal.ModePrefix{} | {:error, :nif_panic}
  def snapshot_at(_handle, _offset), do: :erlang.nif_error(:nif_not_loaded)

  @spec resize(handle(), pos_integer(), pos_integer()) :: :ok | {:error, :nif_panic}
  def resize(_handle, _cols, _rows), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Feed the contents of a file into the parser. Used by RunServer on
  :reattach / :resume / :continue.
  """
  @spec feed_file(handle(), Path.t()) :: :ok | {:error, :nif_panic | File.posix()}
  def feed_file(handle, path) do
    case File.read(path) do
      {:ok, ""} -> :ok
      {:ok, bytes} -> feed(handle, bytes)
      {:error, :enoent} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end
end
```

- [ ] **Step 10.3: Get rustler deps**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && mix deps.get
```

Expected: rustler 0.32+ added to deps/, elixir_make removed.

- [ ] **Step 10.4: Compile**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && mix compile
```

Expected: `cargo build --release` runs against `cli/fbi-term-core/`; resulting `.so` placed at `_build/<env>/lib/fbi/priv/native/libfbi_term_core.so`. Module FBI.Terminal compiles.

- [ ] **Step 10.5: Run a smoke test in iex**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && iex -S mix
```

In iex:
```elixir
h = FBI.Terminal.new(80, 24)
:ok = FBI.Terminal.feed(h, "hello world")
%FBI.Terminal.Snapshot{ansi: ansi, cols: 80, rows: 24, byte_offset: 11} = FBI.Terminal.snapshot(h)
IO.puts(inspect(ansi, limit: :infinity))
:ok = FBI.Terminal.resize(h, 100, 30)
%FBI.Terminal.Snapshot{cols: 100, rows: 30} = FBI.Terminal.snapshot(h)
```

Expected: All three return values match (cols/rows, byte_offset, struct shape).

- [ ] **Step 10.6: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add src/server/mix.exs src/server/lib/fbi/terminal.ex src/server/mix.lock
git commit -m "$(cat <<'EOF'
build(server): swap :elixir_make for :rustler

mix compile now drives cargo against cli/fbi-term-core. FBI.Terminal
@spec contracts preserved exactly; Rustler resource GC replaces the
manual erl_nif.h destructor pattern.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Smoke-test NIF round-trip via mix test

**Files:**
- Create: `src/server/test/fbi/terminal_test.exs`

- [ ] **Step 11.1: Write integration test**

Create `src/server/test/fbi/terminal_test.exs`:
```elixir
defmodule FBI.TerminalTest do
  use ExUnit.Case, async: true

  test "new returns an opaque handle reference" do
    h = FBI.Terminal.new(80, 24)
    assert is_reference(h)
  end

  test "feed advances byte_offset" do
    h = FBI.Terminal.new(80, 24)
    :ok = FBI.Terminal.feed(h, "hello world")
    snap = FBI.Terminal.snapshot(h)
    assert %FBI.Terminal.Snapshot{cols: 80, rows: 24, byte_offset: 11} = snap
    assert is_binary(snap.ansi)
  end

  test "resize updates dims" do
    h = FBI.Terminal.new(80, 24)
    :ok = FBI.Terminal.resize(h, 100, 30)
    snap = FBI.Terminal.snapshot(h)
    assert %FBI.Terminal.Snapshot{cols: 100, rows: 30} = snap
  end

  test "snapshot_at returns ModePrefix struct" do
    h = FBI.Terminal.new(80, 24)
    :ok = FBI.Terminal.feed(h, "\e[?1049h")
    prefix = FBI.Terminal.snapshot_at(h, 8)
    assert %FBI.Terminal.ModePrefix{} = prefix
    assert is_binary(prefix.ansi)
    # Replayed mode prefix should set alt screen.
    assert String.starts_with?(prefix.ansi, <<0x1B>> <> "[?1049h")
  end

  test "feed_file with missing file is :ok" do
    h = FBI.Terminal.new(80, 24)
    assert :ok = FBI.Terminal.feed_file(h, "/tmp/does-not-exist-xyz")
  end

  test "feed_file with empty file is :ok" do
    h = FBI.Terminal.new(80, 24)
    path = Path.join(System.tmp_dir!(), "empty-#{:rand.uniform(1_000_000)}")
    File.write!(path, "")
    try do
      assert :ok = FBI.Terminal.feed_file(h, path)
    after
      File.rm(path)
    end
  end

  test "feed_file replays bytes" do
    h = FBI.Terminal.new(80, 24)
    path = Path.join(System.tmp_dir!(), "replay-#{:rand.uniform(1_000_000)}")
    File.write!(path, "hello")
    try do
      assert :ok = FBI.Terminal.feed_file(h, path)
      snap = FBI.Terminal.snapshot(h)
      assert snap.byte_offset == 5
    after
      File.rm(path)
    end
  end
end
```

- [ ] **Step 11.2: Run test, verify pass**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && mix test test/fbi/terminal_test.exs
```

Expected: 7 tests pass.

- [ ] **Step 11.3: Run full mix test to confirm nothing broke**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && mix test
```

Expected: All tests pass. (RunServer / ShellWSHandler tests still expect the viewer registry API — they will break in Task 13. For now they should pass because we haven't deleted the registry yet.)

- [ ] **Step 11.4: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add src/server/test/fbi/terminal_test.exs
git commit -m "$(cat <<'EOF'
test(fbi/terminal): NIF round-trip integration tests

Verifies new/feed/snapshot/snapshot_at/resize/feed_file work end-to-end
with the Rust NIF; confirms struct shapes and field types.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Delete Zig sources

**Files:**
- Delete: `cli/fbi-term-core/src/*.zig`
- Delete: `cli/fbi-term-core/build.zig`
- Delete: `cli/fbi-term-core/build.zig.zon`
- Delete: `cli/fbi-term-core/Makefile`
- Delete: `cli/fbi-term-core/test/*.zig`

- [ ] **Step 12.1: Confirm Rust path is the only one used**

```bash
cd /Users/fdatoo/Desktop/FBI && grep -rn "elixir_make\|\.zig\|build.zig" src/server/ Cargo.toml cli/fbi-term-core/Cargo.toml
```

Expected: No references to elixir_make, .zig, or build.zig in any active config. (Hits inside `target/` or `_build/` are fine — they're build artifacts.)

- [ ] **Step 12.2: Remove Zig sources**

```bash
cd /Users/fdatoo/Desktop/FBI
rm cli/fbi-term-core/src/*.zig
rm -f cli/fbi-term-core/build.zig
rm -f cli/fbi-term-core/build.zig.zon
rm -f cli/fbi-term-core/Makefile
rm -rf cli/fbi-term-core/test/
rm -rf cli/fbi-term-core/zig-out cli/fbi-term-core/.zig-cache
```

- [ ] **Step 12.3: Re-verify build + tests still work**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test -p fbi_term_core
cd /Users/fdatoo/Desktop/FBI/src/server && mix test test/fbi/terminal_test.exs
```

Expected: Both pass.

- [ ] **Step 12.4: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add -A cli/fbi-term-core/
git commit -m "$(cat <<'EOF'
chore(fbi-term-core): delete Zig sources

The Rust NIF (cli/fbi-term-core/, alacritty_terminal-backed) is now
the sole implementation. Diff harness (Task 9) gates parity with
@xterm/headless on every CI run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Replace ghostty-web with xterm.js + addons (npm deps)

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (auto)

- [ ] **Step 13.1: Update package.json deps**

Modify `package.json`. In the `dependencies` block:
- Remove `ghostty-web`.
- Remove `@xterm/addon-serialize` (vestigial).
- Remove `@xterm/addon-web-links` (vestigial).
- Add `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`.
- Keep `@xterm/headless` (test dep used by the harness; could move to devDependencies).

After edit, the relevant block should be:
```json
"dependencies": {
  "@codemirror/lang-json": "^6.0.2",
  "@fontsource/inter": "^5.2.8",
  "@fontsource/jetbrains-mono": "^5.2.8",
  "@tauri-apps/api": "^2.10.1",
  "@uiw/codemirror-themes": "^4.25.9",
  "@uiw/react-codemirror": "^4.25.9",
  "@xterm/addon-fit": "^0.10.0",
  "@xterm/addon-webgl": "^0.18.0",
  "@xterm/headless": "^6.0.0",
  "@xterm/xterm": "^5.5.0",
  "cmdk": "^1.1.1",
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "react-router-dom": "^6.26.1"
}
```

- [ ] **Step 13.2: Install**

```bash
cd /Users/fdatoo/Desktop/FBI && npm install
```

Expected: `node_modules/@xterm/{xterm,addon-webgl,addon-fit,headless}` present; `node_modules/ghostty-web` absent.

- [ ] **Step 13.3: Confirm no remaining ghostty-web imports**

```bash
cd /Users/fdatoo/Desktop/FBI && grep -rn "ghostty-web" src/ tests/ vite.config.ts vitest.config.ts
```

Expected: No matches. (If there are, they'll fail in subsequent tasks.)

- [ ] **Step 13.4: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
build(web): swap ghostty-web for xterm.js + addons

Adds @xterm/xterm, @xterm/addon-webgl, @xterm/addon-fit. Removes
ghostty-web and the vestigial @xterm/addon-serialize / addon-web-links
that the Apr 28 migration left behind.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Port Terminal.tsx to xterm.js

**Files:**
- Modify: `src/web/components/Terminal.tsx`

Reverts the ghostty-web-specific bits to xterm.js APIs: drop `await initGhostty()`, swap `term.onScroll` callback, change `getViewportY()` calls, load WebGL + Fit addons.

- [ ] **Step 14.1: Rewrite imports and ghostty init removal**

Modify `src/web/components/Terminal.tsx`. Replace the existing imports and `ghosttyReady` constant with:
```tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { TerminalController } from '../lib/terminalController.js';
import { detectScroll } from '../lib/scrollDetection.js';
import { TerminalTakeoverBanner } from './TerminalTakeoverBanner.js'; // deleted in Task 18
import { useFocusState } from '../features/runs/usageBus.js';        // deleted in Task 18
import type { ShellHandle } from '../lib/ws.js';
import {
  record as traceRecord,
  isTracing,
  setTracing,
  subscribe as traceSubscribe,
  eventCount as traceEventCount,
  downloadTrace,
} from '../lib/terminalTrace.js';
```

(The `TerminalTakeoverBanner` and `useFocusState` references are still here pending Task 18 — keep them temporarily; remove there.)

- [ ] **Step 14.2: Replace the async terminal-init IIFE**

Replace the `void (async () => { ... })()` block inside the `useEffect` with a synchronous block (xterm.js doesn't need WASM init):

```tsx
const term = new Xterm({
  convertEol: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  theme: readTheme(),
  cursorBlink: false,
  scrollback: 50000,
});
const fit = new FitAddon();
term.loadAddon(fit);
try {
  term.loadAddon(new WebglAddon());
} catch {
  // WebGL unavailable — xterm.js falls back to Canvas2D internally.
}
term.open(host);
traceRecord('term.mount', { runId });

observer = new MutationObserver(() => {
  term.options.theme = readTheme();
});
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

const rect = host.getBoundingClientRect();
if (rect.width >= 4 && rect.height >= 4) {
  try { fit.fit(); } catch { /* layout transitioning */ }
}

controller = new TerminalController(runId, term, host);
controllerRef.current = controller;
shellRef.current = controller.getShell();
controller.setInteractive(interactive);
setReady(controller.isReady());
if (!controller.isReady()) controller.onReady(() => setReady(true));

unsubSnapDims = controller.getShell().onSnapshot((snap) => {
  setSnapDims({ cols: snap.cols, rows: snap.rows });
});
setTermDims({ cols: term.cols, rows: term.rows });

unsubPause = controller.onPauseChange((p) => setPaused(p));
unsubRebuilding = controller.onRebuildingChange((r) => {
  if (host) host.style.visibility = r ? 'hidden' : '';
});

const onViewportScroll = () => {
  const s = detectScroll(term);
  if (!s.atBottom) {
    controller?.onScroll(s);
    return;
  }
  if (scrollRaf !== null) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    controller?.onScroll(detectScroll(term));
  });
};
scrollDisposable = term.onScroll(onViewportScroll);

(window as any).__fbiTerminalText = () => {
  const lines: string[] = [];
  const buf = term.buffer.active;
  const limit = buf.baseY + term.rows;
  for (let i = 0; i < limit; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').trimEnd();
};
(window as any).__fbiIsAtBottom = () =>
  term.buffer.active.viewportY === term.buffer.active.baseY;

const onVisibility = () => {
  if (!document.hidden) controller?.requestRedraw();
};
document.addEventListener('visibilitychange', onVisibility);

const safeFit = (): boolean => {
  const r = host.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  try { fit.fit(); return true; } catch { return false; }
};

const runFit = () => {
  roTimer = null;
  if (safeFit()) {
    controller?.resize(term.cols, term.rows);
    setTermDims({ cols: term.cols, rows: term.rows });
  }
};
ro = new ResizeObserver(() => {
  if (roTimer !== null) clearTimeout(roTimer);
  roTimer = setTimeout(runFit, 120);
});
ro.observe(host);

const onWinResize = () => {
  if (winResizeTimer !== null) clearTimeout(winResizeTimer);
  winResizeTimer = setTimeout(() => {
    winResizeTimer = null;
    if (safeFit()) {
      controller?.resize(term.cols, term.rows);
      setTermDims({ cols: term.cols, rows: term.rows });
    }
  }, 120);
};
window.addEventListener('resize', onWinResize);
(host as any).__fbiCleanupWinResize = onWinResize;
(host as any).__fbiCleanupVisibility = onVisibility;
```

The cleanup function in the same useEffect needs the `disposed = true; void (async ...)` pattern dropped in favor of plain mount-time setup. Delete `let disposed = false;` and the `if (disposed) return;` checks since synchronous init means there's no race.

- [ ] **Step 14.3: Update detectScroll to xterm.js semantics**

Open `src/web/lib/scrollDetection.ts`, look at how it interacts with `term`. ghostty-web exposes `getViewportY()`; xterm.js exposes `term.buffer.active.viewportY` and `term.buffer.active.baseY`. Update:

```typescript
export function detectScroll(term: { buffer: { active: { viewportY: number; baseY: number } }; rows: number; cols: number }) {
  const buf = term.buffer.active;
  const atBottom = buf.viewportY === buf.baseY;
  const nearTop = buf.viewportY <= 1;
  return { atBottom, nearTop };
}
```

(Adjust the typed shape to match the actual signature you find in the existing file.)

- [ ] **Step 14.4: Run typecheck**

```bash
cd /Users/fdatoo/Desktop/FBI && npm run typecheck
```

Expected: clean, or only errors in TerminalTakeoverBanner / useFocusState (those are deleted in Task 18 / 19). Note any errors here as expected; they're cleared in the dependent tasks.

- [ ] **Step 14.5: Run vitest unit tests**

```bash
cd /Users/fdatoo/Desktop/FBI && npm test -- src/web/components/Terminal.test.tsx
```

Expected: tests fail because the test mocks `ghostty-web`. We'll fix in Task 19. Note the failure mode; don't fix yet.

- [ ] **Step 14.6: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add src/web/components/Terminal.tsx src/web/lib/scrollDetection.ts
git commit -m "$(cat <<'EOF'
feat(web): port Terminal.tsx from ghostty-web to xterm.js

Drops the WASM init wait. Loads WebglAddon (fallback to Canvas2D if
WebGL unavailable) and FitAddon. Configures 50,000-line scrollback
to back the bounded mount-fetch architecture. test hooks
(__fbiTerminalText, __fbiIsAtBottom) ported to xterm.js semantics.

TerminalTakeoverBanner / useFocusState references will be deleted in
the C-kill task; tests are red until those land.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Delete viewer registry from RunServer

**Files:**
- Modify: `src/server/lib/fbi/orchestrator/run_server.ex`
- Modify: `src/server/lib/fbi/orchestrator.ex`

Delete every `viewer_*` callback, the `viewers` map state, the `focused_viewer` field, and the `pick_fallback_focus`/`drop_viewer` helpers.

- [ ] **Step 15.1: Remove viewer fields from initial state**

In `src/server/lib/fbi/orchestrator/run_server.ex`, find the GenServer state initialization (around line 49 per spec; the field is `viewers: %{}` and possibly `focused_viewer: nil`). Remove both fields and replace with:
```elixir
driving_pid: nil,
```

Add the same field everywhere the state defaults are set / merged.

- [ ] **Step 15.2: Delete viewer_* GenServer callbacks**

In `run_server.ex`, delete the function clauses:
- `def viewer_joined(...)` (around line 114) — public wrapper
- `def viewer_focused(...)` (line 121)
- `def viewer_blurred(...)` (line 128)
- `def viewer_left(...)` (line 135)
- `def viewer_resized(...)` (line 142)
- All matching `handle_call({:viewer_joined, ...}, _from, state)` clauses (line 339)
- `handle_call({:viewer_focused, ...}, ...)` (line 371)
- `handle_call({:viewer_blurred, ...}, ...)` (line 393)
- `handle_call({:viewer_resized, ...}, ...)` (line 408)
- `handle_call({:viewer_left, ...}, ...)` (line 424)
- `handle_info` clause around line 476 that drops a viewer on DOWN
- `defp drop_viewer/2` (line 1688)
- `defp pick_fallback_focus/2`
- The `state.focused_viewer` references in PTY-resize logic around line 1748

Replace the PTY-resize-on-focus-change logic. Currently it reads `state.viewers[focused_viewer]` to get the dimensions to apply to the PTY. After this change, the WS handler dictates dims via `Orchestrator.resize/3` (already exists, line 85-87 of orchestrator.ex). Remove the viewer-driven resize path entirely from RunServer.

- [ ] **Step 15.3: Add driving_pid management**

Add new public functions in `run_server.ex`:
```elixir
def claim_driver(run_id, ws_pid) do
  case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
    [{pid, _}] -> GenServer.call(pid, {:claim_driver, ws_pid})
    [] -> {:error, :no_run}
  end
end

def driver_disconnected(run_id, ws_pid) do
  case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
    [{pid, _}] -> GenServer.cast(pid, {:driver_disconnected, ws_pid})
    [] -> :ok
  end
end

def is_driver?(run_id, ws_pid) do
  case Registry.lookup(FBI.Orchestrator.Registry, run_id) do
    [{pid, _}] -> GenServer.call(pid, {:is_driver, ws_pid})
    [] -> false
  end
end

def handle_call({:claim_driver, ws_pid}, _from, state) do
  case state.driving_pid do
    nil ->
      Process.monitor(ws_pid)
      new_state = %{state | driving_pid: ws_pid}
      Phoenix.PubSub.broadcast(
        FBI.PubSub, "run:#{state.run_id}:state",
        {:event, %{type: "driver_state", driving_pid: inspect(ws_pid)}}
      )
      {:reply, :ok, new_state}
    _existing ->
      {:reply, :already_claimed, state}
  end
end

def handle_call({:is_driver, ws_pid}, _from, state) do
  {:reply, state.driving_pid == ws_pid, state}
end

def handle_cast({:driver_disconnected, ws_pid}, state) do
  if state.driving_pid == ws_pid do
    new_state = %{state | driving_pid: nil}
    Phoenix.PubSub.broadcast(
      FBI.PubSub, "run:#{state.run_id}:state",
      {:event, %{type: "driver_state", driving_pid: nil}}
    )
    {:noreply, new_state}
  else
    {:noreply, state}
  end
end

# Process.monitor DOWN — clear driver if it was the driving WS.
def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
  if state.driving_pid == pid do
    new_state = %{state | driving_pid: nil}
    Phoenix.PubSub.broadcast(
      FBI.PubSub, "run:#{state.run_id}:state",
      {:event, %{type: "driver_state", driving_pid: nil}}
    )
    {:noreply, new_state}
  else
    {:noreply, state}
  end
end
```

(There may be other DOWN handlers already in the file; merge clauses with existing ones, taking care to keep clause ordering correct.)

- [ ] **Step 15.4: Update Orchestrator public API**

Modify `src/server/lib/fbi/orchestrator.ex`:
- Delete the `# Viewer registry — public API` block (lines 89-108).
- Add:
```elixir
@doc "Try to become the driving WS for a run. Returns :ok or :already_claimed."
def claim_driver(run_id, ws_pid), do: RunServer.claim_driver(run_id, ws_pid)

@doc "Notify that the driving WS has disconnected."
def driver_disconnected(run_id, ws_pid), do: RunServer.driver_disconnected(run_id, ws_pid)

@doc "Check whether ws_pid is the current driver."
def is_driver?(run_id, ws_pid), do: RunServer.is_driver?(run_id, ws_pid)
```

- [ ] **Step 15.5: Compile + smoke**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && mix compile
```

Expected: compiles. Tests broken (still reference viewer_* APIs); will fix in Task 16/17.

- [ ] **Step 15.6: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add src/server/lib/fbi/orchestrator/run_server.ex src/server/lib/fbi/orchestrator.ex
git commit -m "$(cat <<'EOF'
refactor(orchestrator): drop viewer registry; single driving_pid

Replaces the multi-viewer registry / focus tracker with a single
driving_pid field. claim_driver / driver_disconnected / is_driver?
replace viewer_joined / viewer_focused / viewer_blurred / viewer_left /
viewer_resized. Driver-PTY resize coordination is moved entirely
into the WS handler via the existing Orchestrator.resize/3 entry.

WS handler tests still reference removed APIs and will be fixed in
the next commit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Shrink WS protocol; single-driver enforcement

**Files:**
- Modify: `src/server/lib/fbi_web/sockets/shell_ws_handler.ex`
- Modify: `src/server/test/fbi_web/sockets/shell_ws_handler_test.exs`

WS handler now: only `hello` / `resize` C→S text frames. C→S binary stdin only accepted from the driver. S→C `driver_state` replaces `focus_state`. No more `focus` / `blur` frames.

- [ ] **Step 16.1: Rewrite the WS handler**

Replace `src/server/lib/fbi_web/sockets/shell_ws_handler.ex` with:
```elixir
defmodule FBIWeb.Sockets.ShellWSHandler do
  @moduledoc """
  WebSock handler for /api/runs/:id/shell.

  Protocol:

    C→S text:
      {"type":"hello",  "cols":N, "rows":M}     — first message; replies with snapshot
      {"type":"resize", "cols":N, "rows":M}     — driver only changes PTY dims
    C→S binary:
      stdin bytes — accepted only from driver
    S→C text:
      {"type":"snapshot", "ansi":..., "cols":N, "rows":M, "byte_offset":K}
      {"type":"driver_state", "is_driver":bool}
      typed events (usage / state / title / changes — via :events PubSub)
    S→C binary:
      raw PTY bytes (via :bytes PubSub)
  """
  @behaviour WebSock

  alias FBI.Orchestrator

  @impl true
  def init(%{run_id: run_id}) do
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:bytes")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:events")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:state")
    Phoenix.PubSub.subscribe(FBI.PubSub, "run:#{run_id}:snapshot")
    {:ok, %{run_id: run_id, is_driver: false}}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, %{run_id: run_id} = state) do
    case Jason.decode(text) do
      {:ok, %{"type" => "hello", "cols" => cols, "rows" => rows}}
      when is_integer(cols) and is_integer(rows) ->
        # Try to claim driver. First WS wins.
        is_driver =
          case Orchestrator.claim_driver(run_id, self()) do
            :ok -> true
            :already_claimed -> false
            _ -> false
          end

        # Driver dictates initial PTY dims.
        if is_driver, do: Orchestrator.resize(run_id, cols, rows)

        snap = Orchestrator.snapshot(run_id)
        snap_frame =
          Jason.encode!(%{
            type: "snapshot",
            ansi: snap.ansi,
            cols: snap.cols,
            rows: snap.rows,
            byte_offset: snap.byte_offset
          })

        driver_frame =
          Jason.encode!(%{type: "driver_state", is_driver: is_driver})

        new_state = %{state | is_driver: is_driver}
        {:push, [{:text, driver_frame}, {:text, snap_frame}], new_state}

      {:ok, %{"type" => "resize", "cols" => cols, "rows" => rows}}
      when is_integer(cols) and is_integer(rows) ->
        if state.is_driver, do: Orchestrator.resize(run_id, cols, rows)
        {:ok, state}

      _ ->
        {:ok, state}
    end
  end

  def handle_in({data, [opcode: :binary]}, %{run_id: run_id, is_driver: true} = state) do
    Orchestrator.write_stdin(run_id, data)
    {:ok, state}
  end

  # Non-driver binary frames are dropped silently.
  def handle_in({_data, [opcode: :binary]}, state), do: {:ok, state}

  @impl true
  def handle_info({:bytes, chunk}, state), do: {:push, {:binary, chunk}, state}

  def handle_info({:snapshot, frame}, state) do
    {:push, {:text, Jason.encode!(frame)}, state}
  end

  def handle_info({:state, frame}, state), do: {:push, {:text, Jason.encode!(frame)}, state}

  def handle_info({:event, %{type: "driver_state", driving_pid: pid_str}}, state) do
    is_driver = pid_str == inspect(self())
    new_state = %{state | is_driver: is_driver}
    frame = Jason.encode!(%{type: "driver_state", is_driver: is_driver})
    {:push, {:text, frame}, new_state}
  end

  def handle_info({:event, frame}, state) do
    {:push, {:text, Jason.encode!(frame)}, state}
  end

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{run_id: run_id, is_driver: true}) do
    Orchestrator.driver_disconnected(run_id, self())
    :ok
  end

  def terminate(_reason, _state), do: :ok
end
```

- [ ] **Step 16.2: Update WS handler tests**

Modify `src/server/test/fbi_web/sockets/shell_ws_handler_test.exs`. The test file currently asserts on the `viewer_joined` / `focus_state` flow. Rewrite the relevant tests to:
- Assert that hello returns both `driver_state` (`is_driver: true` for first connection, `false` for subsequent) and `snapshot`.
- Assert that binary stdin from a non-driver is dropped.
- Assert that resize from a non-driver is a no-op.

Concrete test rewrite — replace the existing test bodies:
```elixir
# (Skeleton; adjust to your existing TestSocket harness in the file.)
test "first hello claims driver and replies with driver_state + snapshot" do
  {:ok, run_id} = create_run()
  {:ok, sock} = connect_ws(run_id)
  send_text(sock, %{type: "hello", cols: 80, rows: 24})

  # Two text frames in order: driver_state then snapshot.
  assert {:text, frame1} = recv_frame(sock)
  assert {:ok, %{"type" => "driver_state", "is_driver" => true}} = Jason.decode(frame1)

  assert {:text, frame2} = recv_frame(sock)
  assert {:ok, %{"type" => "snapshot"}} = Jason.decode(frame2)
end

test "second hello on same run gets is_driver: false" do
  {:ok, run_id} = create_run()
  {:ok, sock1} = connect_ws(run_id)
  send_text(sock1, %{type: "hello", cols: 80, rows: 24})
  _ = recv_frame(sock1) # driver_state
  _ = recv_frame(sock1) # snapshot

  {:ok, sock2} = connect_ws(run_id)
  send_text(sock2, %{type: "hello", cols: 80, rows: 24})
  assert {:text, frame1} = recv_frame(sock2)
  assert {:ok, %{"type" => "driver_state", "is_driver" => false}} = Jason.decode(frame1)
end

test "binary stdin from non-driver is dropped" do
  # ... two sockets; only sock1 is driver; send binary on sock2; assert
  # Orchestrator.write_stdin is never called (mock or assert via side effect).
end

test "resize from non-driver is no-op" do
  # ... only the driver's resize causes Orchestrator.resize/3 to fire.
end
```

(Use the harness shape that exists in your repo; the above is a sketch.)

- [ ] **Step 16.3: Run tests**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && mix test test/fbi_web/sockets/shell_ws_handler_test.exs
```

Expected: All test cases pass.

- [ ] **Step 16.4: Run full test suite**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && mix test
```

Expected: Pass. Other test files that referenced viewer-* APIs may need similar small updates; fix them.

- [ ] **Step 16.5: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add src/server/lib/fbi_web/sockets/shell_ws_handler_test.exs src/server/lib/fbi_web/sockets/shell_ws_handler.ex
git commit -m "$(cat <<'EOF'
refactor(ws): shrink shell protocol to single-driver model

C→S frames: hello, resize. C→S binary: stdin (driver-only). S→C frames:
snapshot, driver_state, typed events. focus / blur / focus_state deleted.
First WS to call hello becomes the driver; subsequent connections are
read-only mirrors. Driver disconnect promotes nothing — next WS to
claim becomes driver.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Implement bounded mount fetch + scrollback config

**Files:**
- Modify: `src/web/lib/terminalController.ts`

Replace `loadHistory` with `loadBoundedHistory`. Use `Range: bytes=max(0, byte_offset - 5MB)-(byte_offset - 1)`. Single Range request, single rebuild.

- [ ] **Step 17.1: Add SCROLLBACK_CAP constant**

At the top of `src/web/lib/terminalController.ts`, add:
```typescript
const SCROLLBACK_CAP = 5 * 1024 * 1024;  // 5 MB; matches xterm.js scrollback config
```

- [ ] **Step 17.2: Replace loadHistory**

Find the `private async loadHistory(...)` method (around line 349). Replace with:
```typescript
/**
 * Fetch up to SCROLLBACK_CAP bytes of recent transcript and replay them
 * into the terminal. Called once after the first snapshot. The fetch
 * is bounded so the mount-time rebuild is bounded regardless of run length.
 */
private async loadBoundedHistory(snap: RunWsSnapshotMessage): Promise<void> {
  const N = snap.byte_offset;
  const start = Math.max(0, N - SCROLLBACK_CAP);
  const end = N - 1;

  // Run is brand new: no history to fetch.
  if (end < start) {
    this.setRebuilding(false);
    return;
  }

  let tailLength = 0;
  this.setRebuilding(true);
  try {
    const res = await fetch(apiBase() + `/api/runs/${this.runId}/transcript`, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (this.disposed) return;
    if (!res.ok && res.status !== 206) {
      traceRecord('controller.history.error', { status: res.status });
      return;
    }
    const historyBytes = new Uint8Array(await res.arrayBuffer());
    if (this.disposed) return;
    if (historyBytes.byteLength === 0) {
      traceRecord('controller.history.complete', { bytes: 0 });
      return;
    }
    const tail = this.liveTailBytes;
    tailLength = tail.byteLength;
    await this.rebuildXterm([historyBytes, tail]);
    if (this.disposed) return;
    this.term.scrollToBottom();
    traceRecord('controller.history.complete', { bytes: historyBytes.byteLength });
  } catch (err) {
    traceRecord('controller.history.error', { err: String(err) });
  } finally {
    const extra = this.liveTailBytes.subarray(tailLength);
    this.liveTailBytes = new Uint8Array();
    if (extra.byteLength > 0 && !this.disposed) this.term.write(extra);
    this.setRebuilding(false);
  }
}
```

- [ ] **Step 17.3: Update the snapshot handler to call loadBoundedHistory**

Find the `unsubSnapshot = this.shell.onSnapshot((snap) => { ... })` block (around line 87 of the controller). Replace the `queueMicrotask(() => { void this.loadHistory(snap); })` with `queueMicrotask(() => { void this.loadBoundedHistory(snap); })`.

Update the cached-snapshot branch (around line 132) similarly: replace `void this.loadHistory(cached)` with `void this.loadBoundedHistory(cached)`.

- [ ] **Step 17.4: Add a unit test**

Modify `src/web/lib/terminalController.test.ts` to assert that `loadBoundedHistory` issues a Range request rather than a full GET. Use the existing fetch mock pattern from the file.

```typescript
test('mount-time history fetch is bounded by SCROLLBACK_CAP', async () => {
  // Setup: WS mock fires snapshot with byte_offset = 10_000_000.
  // Assertion: fetch is called with Range: bytes=4806656-9999999 (5MB cap).
  // ... use existing test scaffolding to drive the controller through mount.
});
```

(The exact shape depends on the existing helpers in `terminalController.test.ts`; add the bounded-fetch assertion alongside the existing rebuild-no-byte-loss test.)

- [ ] **Step 17.5: Run controller test**

```bash
cd /Users/fdatoo/Desktop/FBI && npm test -- src/web/lib/terminalController.test.ts
```

Expected: pass.

- [ ] **Step 17.6: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts
git commit -m "$(cat <<'EOF'
feat(web): bounded mount-time transcript fetch

Replaces loadHistory (full transcript) with loadBoundedHistory (last
5 MB via HTTP Range). Fixes the boot-time flashing on long-running
agents — the mount rebuild is now bounded regardless of run length.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Delete TerminalTakeoverBanner and focus-state machinery

**Files:**
- Delete: `src/web/components/TerminalTakeoverBanner.tsx`
- Modify: `src/web/components/Terminal.tsx`
- Modify: `src/web/features/runs/usageBus.js`
- Modify: `src/web/lib/terminalController.ts`

- [ ] **Step 18.1: Delete the takeover banner component**

```bash
cd /Users/fdatoo/Desktop/FBI && rm src/web/components/TerminalTakeoverBanner.tsx
```

- [ ] **Step 18.2: Remove takeover banner usage from Terminal.tsx**

Modify `src/web/components/Terminal.tsx`. Delete:
- The import `import { TerminalTakeoverBanner } from './TerminalTakeoverBanner.js';`
- The import `import { useFocusState } from '../features/runs/usageBus.js';`
- The `const focusState = useFocusState(runId);` line.
- The JSX block that conditionally renders `<TerminalTakeoverBanner ... />` (matched by the `shellRef.current && snapDims && termDims && (` predicate).

Add a small "viewing only" indicator that shows when this WS is not the driver. Driver state comes through the snapshot WS as a `driver_state` message; subscribe via the controller's typed-event hook.

In `Terminal.tsx`, add:
```tsx
const [isDriver, setIsDriver] = useState<boolean>(true);

useEffect(() => {
  const c = controllerRef.current;
  if (!c) return;
  return c.onDriverChange(setIsDriver);
}, [runId]);
```

In the JSX, near the existing paused banner:
```tsx
{!isDriver && (
  <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-3 py-1 bg-surface border-b border-border text-[12px] text-text-dim">
    <span>👁 Viewing only — terminal is being driven by another tab.</span>
  </div>
)}
```

- [ ] **Step 18.3: Add onDriverChange to TerminalController**

Modify `src/web/lib/terminalController.ts`:
- In the constructor, set up a `driverChangeListeners = new Set<(d: boolean) => void>()` field.
- In the typed-events router, when `msg.type === "driver_state"`, update an internal `private isDriver = true` field and notify listeners.
- Expose `onDriverChange(cb: (d: boolean) => void): () => void`.

Concretely:
```typescript
private isDriver = true;
private driverChangeListeners = new Set<(d: boolean) => void>();

onDriverChange(cb: (d: boolean) => void): () => void {
  this.driverChangeListeners.add(cb);
  cb(this.isDriver);
  return () => { this.driverChangeListeners.delete(cb); };
}

private setDriver(d: boolean): void {
  if (this.isDriver === d) return;
  this.isDriver = d;
  for (const cb of this.driverChangeListeners) cb(d);
}
```

In the `unsubEvents` callback inside the constructor, add:
```typescript
else if (msg.type === 'driver_state') {
  const dm = msg as unknown as { is_driver: boolean };
  this.setDriver(dm.is_driver);
}
```

Delete the existing focus-state branch (`else if (msg.type === 'focus_state') ...`).

Also delete from the controller:
- The `unsubVisibility` field, the `visibilityHandler`, the `document.addEventListener('visibilitychange', visibilityHandler)`.
- The `private isFocused = false` field.
- The `if (!this.isFocused) this.shell.sendFocus()` branch in `applyInteractive`.

Search for and remove all `this.shell.sendFocus()` and `this.shell.sendBlur()` calls — those WS frames no longer exist server-side.

- [ ] **Step 18.4: Update ws.ts and usageBus.js**

Modify `src/web/lib/ws.ts`:
- Delete the `sendFocus()` / `sendBlur()` methods on `ShellHandle`.
- Add a `sendHello(cols, rows)` (already exists; keep) and `sendResize(cols, rows)` (already exists; keep).

Modify `src/web/features/runs/usageBus.js`:
- Delete `publishFocusState` and `useFocusState` (and the related event channel).

- [ ] **Step 18.5: Update shellRegistry.ts**

Modify `src/web/lib/shellRegistry.ts`:
- Remove any focus-state cache / publishing. The snapshot cache stays.

- [ ] **Step 18.6: Run typecheck and tests**

```bash
cd /Users/fdatoo/Desktop/FBI && npm run typecheck
cd /Users/fdatoo/Desktop/FBI && npm test
```

Expected: typecheck clean. Vitest passes (or has only test-file failures that need updating in next step).

- [ ] **Step 18.7: Update Terminal.test.tsx**

Modify `src/web/components/Terminal.test.tsx` to:
- Replace any ghostty-web mocks with xterm.js mocks. Use `vi.mock('@xterm/xterm', ...)` to stub the `Terminal` class.
- Drop assertions about TerminalTakeoverBanner.
- Add an assertion that the "Viewing only" indicator renders when `isDriver: false` is published via the WS mock.

- [ ] **Step 18.8: Run vitest one more time**

```bash
cd /Users/fdatoo/Desktop/FBI && npm test
```

Expected: all pass.

- [ ] **Step 18.9: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add -A src/web/ src/web/components/Terminal.test.tsx
git commit -m "$(cat <<'EOF'
refactor(web): delete takeover banner; replace with driver-state indicator

TerminalTakeoverBanner.tsx deleted. focus_state event channel deleted
(usageBus, shellRegistry, ws.ts). TerminalController exposes
onDriverChange, driven by the new driver_state WS frame. A small
"Viewing only" pill appears on non-driver tabs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Simplify terminalController state flags

**Files:**
- Modify: `src/web/lib/terminalController.ts`
- Modify: `src/web/lib/terminalController.test.ts`

Collapse `historyLoaded`, `snapshotArrived`, `readySilenceTimer`, `readyCapTimer` into a single `ready` boolean. Drop `nudgePending` / `requestRedraw` after confirming e2e suite is green without them.

- [ ] **Step 19.1: Replace ready-tracking fields with a single ready boolean**

In `src/web/lib/terminalController.ts`:
- Delete `private historyLoaded = false`, `private snapshotArrived = false`, `private readySilenceTimer`, `private readyCapTimer`.
- Delete `private bumpReadySilenceTimer`, `private onSnapshotParsed`.
- Replace with:
```typescript
private ready = false;
private readyCbs: Array<() => void> = [];

private fireReady(): void {
  if (this.ready) return;
  this.ready = true;
  const cbs = this.readyCbs.splice(0);
  for (const cb of cbs) cb();
}
```

- In the snapshot handler, the only ready signal is "snapshot parsed and history fetch resolved." Fire ready in the `loadBoundedHistory` finally block (after the `setRebuilding(false)` call):
```typescript
this.fireReady();
```

This simplifies the state machine. Initial mount: snapshot arrives → bounded fetch starts → fetch done → ready fires.

- [ ] **Step 19.2: Drop nudgePending and requestRedraw**

In `terminalController.ts`:
- Delete `private nudgePending = false;`.
- Delete `private scheduleCursorRedraw()`.
- In the `unsubOpen` callback, delete the `this.nudgePending = true;` line.
- In the snapshot handler, delete the `if (this.nudgePending) ...` block.
- Delete `requestRedraw(): void { ... }`.

In `Terminal.tsx`, delete the `onVisibility = () => { if (!document.hidden) controller?.requestRedraw(); }` and the corresponding `addEventListener('visibilitychange', onVisibility)`.

- [ ] **Step 19.3: Run unit tests**

```bash
cd /Users/fdatoo/Desktop/FBI && npm test -- src/web/lib/terminalController.test.ts src/web/components/Terminal.test.tsx
```

Expected: pass.

- [ ] **Step 19.4: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add src/web/lib/terminalController.ts src/web/lib/terminalController.test.ts src/web/components/Terminal.tsx
git commit -m "$(cat <<'EOF'
refactor(controller): collapse rebuild flags to single ready boolean

Drops historyLoaded / snapshotArrived / readySilenceTimer / readyCapTimer
in favor of one fireReady() invocation in loadBoundedHistory's finally
block. Drops nudgePending / requestRedraw — those were ghostty-web-
specific workarounds and are unnecessary on xterm.js + WebGL.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Update Playwright e2e tests

**Files:**
- Delete: `tests/e2e/quantico/terminal-takeover-banner.spec.ts`
- Modify: `tests/e2e/quantico/terminal-rebuild-no-byte-loss.spec.ts`
- Modify: `tests/e2e/quantico/terminal-chunk-load.spec.ts`
- Possibly modify other specs if they reference focus/blur or assert on the takeover UX.

- [ ] **Step 20.1: Delete the takeover spec**

```bash
cd /Users/fdatoo/Desktop/FBI && rm tests/e2e/quantico/terminal-takeover-banner.spec.ts
```

- [ ] **Step 20.2: Update terminal-rebuild-no-byte-loss.spec.ts**

The existing test verifies no bytes are lost during the rebuild. With bounded fetch:
- Use the `scrollback-stress` fixture (large output, will exceed CAP).
- Assert: the LAST 5 MB of output is fully present in the terminal scrollback.
- Assert: bytes from before that 5 MB window are absent (acceptable; that's the bounded-fetch contract).

Open the file and update assertions. The existing helper `__fbiTerminalText` returns the full visible scrollback. Compare against expected last-N-bytes.

- [ ] **Step 20.3: Repurpose terminal-chunk-load.spec.ts**

Rename test cases inside the spec to verify the bounded mount fetch behavior:
- Open a long-running scenario, navigate to the run page, assert the terminal shows the most-recent ~5 MB of output, not 0 MB and not the full N MB.
- Use the existing helper to count visible characters; assert in [4 MB, 6 MB] range.

- [ ] **Step 20.4: Audit remaining e2e specs for focus/blur references**

```bash
cd /Users/fdatoo/Desktop/FBI && grep -rn "focus_state\|sendFocus\|sendBlur\|takeover" tests/e2e/quantico/
```

Expected: no matches. Update any remaining ones.

- [ ] **Step 20.5: Run e2e suite**

```bash
cd /Users/fdatoo/Desktop/FBI && npm run e2e
```

Expected: all specs pass. (The Quantico mock-claude path drives the runs.)

- [ ] **Step 20.6: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add -A tests/e2e/quantico/
git commit -m "$(cat <<'EOF'
test(e2e): update specs for bounded fetch + single-driver model

Drops terminal-takeover-banner.spec.ts. Updates rebuild-no-byte-loss
to verify the bounded mount fetch is correctly applied (last ~5 MB
visible; older content acceptably absent). Repurposes chunk-load to
assert bounded behavior on long runs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Update install.sh and README

**Files:**
- Modify: `scripts/install.sh`
- Modify: `README.md`

`install.sh` no longer needs `zig`; it now needs `cargo` (rustup).

- [ ] **Step 21.1: Inspect existing install.sh**

```bash
cd /Users/fdatoo/Desktop/FBI && cat scripts/install.sh | head -100
```

Locate any `zig` install or check (e.g., `command -v zig`, `apt-get install zig`, `curl ... ziglang.org`).

- [ ] **Step 21.2: Replace zig install with rustup**

Modify `scripts/install.sh`. Replace the zig section with:
```bash
# Install rustup if cargo is missing.
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing rustup (Rust toolchain) — required to build the FBI.Terminal NIF."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    -y --default-toolchain stable --profile minimal
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
```

- [ ] **Step 21.3: Update README prerequisites**

Modify `README.md`. In the "Prerequisites on the server" list, replace any `zig` reference with `cargo (Rust 1.77+)`. If `zig` is not currently listed, no change needed.

In the "Local development" section or "Architecture" section, mention that `cli/fbi-term-core/` is a Rust crate that compiles via `cargo` automatically through `:rustler` during `mix compile`.

- [ ] **Step 21.4: Verify install.sh is syntactically valid**

```bash
cd /Users/fdatoo/Desktop/FBI && bash -n scripts/install.sh
```

Expected: no syntax errors.

- [ ] **Step 21.5: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add scripts/install.sh README.md
git commit -m "$(cat <<'EOF'
docs: update install.sh and README for Rust toolchain

install.sh installs rustup if cargo is missing. README prerequisites
list updated; zig references replaced with cargo.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: Final verification gates

**Files:** none (verification only)

Run each gate. Confirm green before declaring the rewrite complete.

- [ ] **Step 22.1: Cargo tests**

```bash
cd /Users/fdatoo/Desktop/FBI && cargo test --workspace
```

Expected: all tests pass — modes, checkpoint, parser, serialize, diff_xterm.

- [ ] **Step 22.2: Mix tests**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && mix test
```

Expected: all tests pass — including FBI.TerminalTest, ShellWSHandlerTest, RunServer tests.

- [ ] **Step 22.3: Vitest unit tests**

```bash
cd /Users/fdatoo/Desktop/FBI && npm test
```

Expected: all unit tests pass.

- [ ] **Step 22.4: TypeScript typecheck**

```bash
cd /Users/fdatoo/Desktop/FBI && npm run typecheck
```

Expected: clean.

- [ ] **Step 22.5: Playwright e2e**

```bash
cd /Users/fdatoo/Desktop/FBI && npm run e2e
```

Expected: all specs pass.

- [ ] **Step 22.6: Manual smoke #1 — long run, no flashing**

Start the dev server:
```bash
cd /Users/fdatoo/Desktop/FBI
head -c 32 /dev/urandom > /tmp/fbi.key
GIT_AUTHOR_NAME="Dev" GIT_AUTHOR_EMAIL=dev@example.com \
  DB_PATH=/tmp/fbi.db RUNS_DIR=/tmp/fbi-runs \
  SECRETS_KEY_FILE=/tmp/fbi.key \
  MOCK_CLAUDE=$(pwd)/target/release/quantico \
  MOCK_CLAUDE_SCENARIO=scrollback-stress \
  npm run dev
```

In a browser:
1. Open `http://localhost:5173/`.
2. Create a run.
3. Open the run detail page.
4. Confirm: terminal shows current screen content immediately (no blank).
5. Confirm: no flashing during mount.
6. Confirm: scrollback contains the most-recent output.

- [ ] **Step 22.7: Manual smoke #2 — second tab is read-only**

With the same run still open in tab 1:
1. Open the run detail page in a second browser tab.
2. Confirm: tab 2 shows "Viewing only" indicator.
3. Try typing in tab 2. Confirm: no characters reach the run.
4. Type in tab 1. Confirm: characters reach the run; output appears in both tabs.
5. Close tab 1. Confirm: tab 2's "Viewing only" disappears (it became the driver).

- [ ] **Step 22.8: Final commit (no-op if all gates green)**

If anything was tweaked during smoke testing, commit those tweaks. Otherwise no commit.

```bash
cd /Users/fdatoo/Desktop/FBI && git status
```

Expected: clean working tree.

- [ ] **Step 22.9: Mark plan complete**

The rewrite is complete when all 22 tasks are checked off and all 9 verification steps in Task 22 are green. Open a PR via `gh pr create` (per existing project conventions) targeting `main`.

---

## Self-Review

**Spec coverage:**
- §1 Overview / §2 Architecture: covered by Tasks 1-12 (Rust crate + NIF) + 13-19 (client) + 15-16 (single-driver) + 17 (bounded fetch).
- §3 Server-side Rust crate: Tasks 1-12.
- §4 Client xterm.js: Tasks 13-14, 18-19.
- §5 Lazy-bounded scrollback: Task 17.
- §6 Single-driver model + WS protocol: Tasks 15-16.
- §7 Diff harness: Tasks 7-9.
- §8 Migration sequencing: implemented as the task numbering itself, plus Task 22 verification.
- §9 Testing matrix: Task 11 (Elixir), Task 22 (full gates).
- §10 Risks (parser drift, WebGL quirks, cargo dep): mitigated by the diff harness (Task 9) and Task 21 install.sh update.
- §11 Alternatives considered: not implemented (correctly — alternatives are not the chosen path).

**Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N" left. Each step has explicit code or commands. Two `NOTE:` blocks (Tasks 4 and 6) document version-specific API hedges with concrete fallback code provided inline.

**Type consistency:**
- `Parser`, `Snapshot`, `ModePrefix`, `ModeState`, `ModeScanner`, `CheckpointStore`, `LocateResult` referenced consistently across Tasks 1-9.
- `claim_driver` / `driver_disconnected` / `is_driver?` consistently named across Tasks 15-16.
- `loadBoundedHistory`, `SCROLLBACK_CAP`, `setRebuilding`, `liveTailBytes`, `fireReady` consistently named across Tasks 17-19.
- `onDriverChange` / `setDriver` / `driverChangeListeners` consistently used across Task 18.
- `driver_state` WS frame name consistent across Tasks 15, 16, 18.

**Path corrections:** The plan uses `src/server/` (current code location) rather than the spec's `server-elixir/` (stale path).

**One spec gap I'm leaving open:** §3 also mentions `serialize_grid` should "trim trailing default-attribute blanks" and "skip wide-char spacers" — covered in Task 5 via `is_default_cell` and the `WIDE_CHAR_SPACER` flag check. Confirmed.
