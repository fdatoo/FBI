# ghostty-web Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `fbi-term-core` (Rust/alacritty_terminal) with a flat Zig package using libghostty-vt as the server-side terminal parser, and replace `@xterm/xterm` with `ghostty-web` (WASM) on the client, so both sides run the same underlying terminal implementation.

**Architecture:** Two existing Rust crates (`cli/fbi-term-core/` and `server-elixir/native/fbi_term/`) collapse into one Zig package at `cli/fbi-term-core/` whose `build.zig` produces `fbi_term.so` (the Erlang NIF). The `ModeScanner`, `CheckpointStore`, and ANSI serializer are ported from Rust to Zig. The libghostty-vt terminal handles PTY byte parsing and grid state. On the client, `ghostty-web` replaces `@xterm/xterm` via an API-compatible drop-in swap requiring only an async `init()` call and a scroll-listener fix.

**Tech Stack:** Zig 0.14+ (libghostty-vt via `build.zig.zon`), Erlang NIF C API (`erl_nif.h`, no Rustler), elixir_make (replaces Rustler's Mix integration), ghostty-web npm package (WASM bundle), TypeScript/React (minimal changes), Playwright (helpers updated for Canvas).

**Spec:** [docs/superpowers/specs/2026-04-28-ghostty-web-migration-design.md](../specs/2026-04-28-ghostty-web-migration-design.md)

---

## File Map

**Created:**
- `cli/fbi-term-core/build.zig` — compile `fbi_term.so` NIF artifact; declare test step
- `cli/fbi-term-core/build.zig.zon` — pins ghostty at a specific commit hash
- `cli/fbi-term-core/Makefile` — thin shim; elixir_make calls `zig build` and copies artifact
- `cli/fbi-term-core/src/root.zig` — re-exports public types: `Parser`, `Snapshot`, `ModePrefix`
- `cli/fbi-term-core/src/parser.zig` — `Parser` struct: wraps libghostty terminal, drives `ModeScanner` + `CheckpointStore`
- `cli/fbi-term-core/src/modes.zig` — `ModeState`, `ModeScanner`: port of Rust `modes.rs`
- `cli/fbi-term-core/src/checkpoint.zig` — `CheckpointStore`: port of Rust `checkpoint.rs`
- `cli/fbi-term-core/src/serialize.zig` — grid → ANSI replay: port of Rust `serialize.rs`, uses libghostty grid API
- `cli/fbi-term-core/src/nif.zig` — `ErlNifFunc` table + `nif_init` export; calls into `resource.zig`
- `cli/fbi-term-core/src/resource.zig` — `ResourceObject`: `enif_open_resource_type`, allocate, release
- `cli/fbi-term-core/test/parser_test.zig` — unit tests: round-trips, checkpoint replay, mode tracking

**Modified:**
- `.devcontainer/Dockerfile` — add Zig via asdf
- `.devcontainer/devcontainer.json` — add `ziglang.vscode-zig` VS Code extension
- `Cargo.toml` — remove `cli/fbi-term-core` and `server-elixir/native/fbi_term` from `members`
- `server-elixir/mix.exs` — remove Rustler; add elixir_make; configure `make_cwd`
- `server-elixir/lib/fbi/terminal.ex` — remove `use Rustler`; add `@on_load :load_nif`
- `src/web/components/Terminal.tsx` — `ghostty-web` import, async `initGhostty()`, scroll fix, `window.__fbiTerminalText`
- `src/web/lib/scrollDetection.ts` — remove `.xterm-viewport` DOM query; adapt for host div
- `tests/e2e/quantico/helpers.ts` — `terminalText` via `page.evaluate(() => window.__fbiTerminalText?.())`
- `package.json` — add `ghostty-web`; remove `@xterm/xterm`, `@xterm/addon-serialize`, `@xterm/headless`
- `.github/workflows/ci.yml` — add Zig install; replace `cargo test -p fbi-term-core` with `zig build test`

**Deleted:**
- `cli/fbi-term-core/src/lib.rs`, `parser.rs`, `modes.rs`, `checkpoint.rs`, `serialize.rs`
- `cli/fbi-term-core/Cargo.toml`
- `cli/fbi-term-core/tests/diff_xterm.rs`, `tests/support/xterm_ref.mjs`, `tests/fixtures/`
- `server-elixir/native/fbi_term/` (entire directory)

---

## Notes for executors

- **Working directory for git:** Always `cd /workspace` before any `git` command (CLAUDE.md requirement — post-commit hook depends on it).
- **libghostty API verification is mandatory before implementing `parser.zig` and `serialize.zig`.** Task 4 is entirely devoted to this. Do not skip it or proceed past it without having confirmed actual Zig API signatures.
- **TDD discipline:** Every code task starts by writing a failing test. For Zig: `zig build test`. For Elixir: `mix test`. For TypeScript: `npm test`.
- **Commit after each task** using the conventional commit prefix shown in each task.
- **ModeScanner and CheckpointStore have no libghostty dependency** — port them from Rust to Zig before touching the parser. They can be tested in pure isolation.
- The `dump_normalized_grid` function in the Rust `parser.rs` is **not ported** — it was only used by the deleted diff harness.
- Zig's `@import("ghostty")` module name must match what the pinned ghostty commit's `build.zig` actually exports — verify this in Task 4.

---

## Phase 1 — Infrastructure

### Task 1: Add Zig to devcontainer

**Files:**
- Modify: `.devcontainer/Dockerfile`
- Modify: `.devcontainer/devcontainer.json`

- [ ] **Step 1: Determine required Zig version**

  The ghostty commit you pin in Task 3 will have a `.zigversion` file or a comment in its `build.zig` declaring the required Zig version. For now, proceed with the latest stable Zig (0.14.0 as of this writing). You will revisit this after pinning the ghostty commit in Task 3 — if the required version differs, update the `ARG ZIG_VERSION` here.

- [ ] **Step 2: Add Zig installation to Dockerfile**

  Read `.devcontainer/Dockerfile`. Add these lines after the Elixir installation block (after the `$ASDF_DIR/bin/asdf global elixir` line, before the Hex/rebar block):

  ```dockerfile
  ARG ZIG_VERSION=0.14.0
  
  RUN $ASDF_DIR/bin/asdf plugin add zig \
   && $ASDF_DIR/bin/asdf install zig ${ZIG_VERSION} \
   && $ASDF_DIR/bin/asdf global  zig ${ZIG_VERSION}
  
  ENV ASDF_ZIG_VERSION=${ZIG_VERSION}
  ```

- [ ] **Step 3: Add Zig VS Code extension**

  Read `.devcontainer/devcontainer.json`. Add `"ziglang.vscode-zig"` to the `customizations.vscode.extensions` array.

- [ ] **Step 4: Verify Zig is on PATH**

  If you can rebuild the devcontainer, do so and verify:
  ```
  zig version
  ```
  Expected output: `0.14.0` (or whatever version was installed).

  If you cannot rebuild now, skip verification — it will be caught when Task 3's `zig build` first runs.

- [ ] **Step 5: Commit**

  ```bash
  cd /workspace
  git add .devcontainer/Dockerfile .devcontainer/devcontainer.json
  git commit -m "chore(devcontainer): add Zig via asdf; add ziglang.vscode-zig extension"
  ```

---

### Task 2: Remove Rust terminal crates from Cargo workspace

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Read the workspace Cargo.toml**

  Read `/workspace/Cargo.toml` and locate the `members` array.

- [ ] **Step 2: Remove the two terminal crate entries**

  Remove `"cli/fbi-term-core"` and `"server-elixir/native/fbi_term"` from the `members` list. Leave `"desktop"`, `"cli/fbi-tunnel"`, `"cli/quantico"` unchanged.

- [ ] **Step 3: Verify the workspace still resolves**

  ```bash
  cd /workspace && cargo metadata --no-deps --format-version 1 | python3 -c "import json,sys; d=json.load(sys.stdin); print([p['name'] for p in d['packages']])"
  ```
  Expected: a list containing `fbi-tunnel`, `quantico`, and `desktop` — but NOT `fbi-term-core` or `fbi_term`.

- [ ] **Step 4: Commit**

  ```bash
  cd /workspace
  git add Cargo.toml Cargo.lock
  git commit -m "chore(cargo): remove fbi-term-core and fbi_term from workspace"
  ```

---

## Phase 2 — Zig Core Library

### Task 3: Zig package skeleton + libghostty dependency

**Files:**
- Create: `cli/fbi-term-core/build.zig`
- Create: `cli/fbi-term-core/build.zig.zon`
- Create: `cli/fbi-term-core/src/root.zig` (stub)
- Create: `cli/fbi-term-core/src/parser.zig` (stub)
- Create: `cli/fbi-term-core/src/modes.zig` (stub)
- Create: `cli/fbi-term-core/src/checkpoint.zig` (stub)
- Create: `cli/fbi-term-core/src/serialize.zig` (stub)
- Create: `cli/fbi-term-core/src/nif.zig` (stub)
- Create: `cli/fbi-term-core/src/resource.zig` (stub)
- Create: `cli/fbi-term-core/test/parser_test.zig` (stub)

- [ ] **Step 1: Choose a ghostty commit to pin**

  Go to `https://github.com/ghostty-org/ghostty/commits/main` and choose the most recent commit tagged or noted as stable. Record the full 40-character commit SHA — call it `GHOSTTY_COMMIT`.

  Then fetch and hash it:
  ```bash
  cd /workspace/cli/fbi-term-core
  zig fetch https://github.com/ghostty-org/ghostty/archive/GHOSTTY_COMMIT.tar.gz
  ```
  This prints the `hash` you need. It also suggests adding it to `build.zig.zon`.

- [ ] **Step 2: Create `build.zig.zon`**

  ```zig
  .{
      .name = .fbi_term_core,
      .version = "0.1.0",
      .dependencies = .{
          .ghostty = .{
              .url = "https://github.com/ghostty-org/ghostty/archive/GHOSTTY_COMMIT.tar.gz",
              .hash = "HASH_FROM_ZIG_FETCH",
          },
      },
      .paths = .{"."},
  }
  ```

  Replace `GHOSTTY_COMMIT` and `HASH_FROM_ZIG_FETCH` with the real values from Step 1.

- [ ] **Step 3: Look up the ghostty module name**

  Read the pinned ghostty commit's `build.zig` to find the module name it exports for external consumers. Look for `b.addModule(...)` or `b.addNamedModule(...)` calls, or check if it uses `addLibrary` with a public API.

  ```bash
  # If you have the fetched source in zig global cache, find it:
  find ~/.cache/zig -name "build.zig" -path "*/ghostty*" 2>/dev/null | head -5
  # Or inspect the tar:
  curl -sL https://github.com/ghostty-org/ghostty/archive/GHOSTTY_COMMIT.tar.gz | tar -xz --to-stdout "*/build.zig" 2>/dev/null | head -100
  ```

  The module name is likely `"ghostty"` or `"libghostty"`. Record it — you will use it as `b.dependency("ghostty", ...).module("MODULE_NAME")` throughout.

- [ ] **Step 4: Create `build.zig`**

  ```zig
  const std = @import("std");
  
  pub fn build(b: *std.Build) void {
      const target = b.standardTargetOptions(.{});
      const optimize = b.standardOptimizeOption(.{});
  
      const ghostty_dep = b.dependency("ghostty", .{
          .target = target,
          .optimize = optimize,
      });
      // Use the module name you verified in Step 3.
      const ghostty_mod = ghostty_dep.module("ghostty");
  
      const erl_include = b.option(
          []const u8,
          "erl-include",
          "Path to Erlang NIF headers (erl_nif.h)",
      ) orelse "/usr/lib/erlang/usr/include";
  
      // ── Shared library (the NIF .so) ─────────────────────────────────────
      const lib = b.addSharedLibrary(.{
          .name = "fbi_term",
          .root_source_file = b.path("src/nif.zig"),
          .target = target,
          .optimize = optimize,
      });
      lib.root_module.addImport("ghostty", ghostty_mod);
      lib.addIncludePath(.{ .cwd_relative = erl_include });
      // Link libc for Erlang NIF runtime.
      lib.linkLibC();
      b.installArtifact(lib);
  
      // ── Unit tests ───────────────────────────────────────────────────────
      const tests = b.addTest(.{
          .root_source_file = b.path("test/parser_test.zig"),
          .target = target,
          .optimize = optimize,
      });
      tests.root_module.addImport("ghostty", ghostty_mod);
  
      const run_tests = b.addRunArtifact(tests);
      const test_step = b.step("test", "Run unit tests");
      test_step.dependOn(&run_tests.step);
  }
  ```

- [ ] **Step 5: Create stub source files**

  Create `cli/fbi-term-core/src/root.zig`:
  ```zig
  pub const Parser = @import("parser.zig").Parser;
  pub const Snapshot = @import("parser.zig").Snapshot;
  pub const ModePrefix = @import("parser.zig").ModePrefix;
  ```

  Create `cli/fbi-term-core/src/modes.zig`:
  ```zig
  pub const ModeState = struct {};
  pub const ModeScanner = struct {
      pub fn init() ModeScanner { return .{}; }
      pub fn feed(_: *ModeScanner, _: []const u8) void {}
      pub fn emit(_: *const ModeScanner, _: u16) []const u8 { return ""; }
  };
  ```

  Create `cli/fbi-term-core/src/checkpoint.zig`:
  ```zig
  pub const CheckpointStore = struct {
      pub fn init() CheckpointStore { return .{}; }
  };
  ```

  Create `cli/fbi-term-core/src/serialize.zig`:
  ```zig
  // Stub — implemented after libghostty API verified in Task 4.
  pub fn serializeGrid(_: anytype, _: anytype) []const u8 { return ""; }
  ```

  Create `cli/fbi-term-core/src/parser.zig`:
  ```zig
  const std = @import("std");
  pub const Snapshot = struct { ansi: []const u8, cols: u16, rows: u16, byte_offset: u64 };
  pub const ModePrefix = struct { ansi: []const u8 };
  pub const Parser = struct {
      pub fn init(_: std.mem.Allocator, _: u16, _: u16) !Parser { return .{}; }
      pub fn deinit(_: *Parser) void {}
  };
  ```

  Create `cli/fbi-term-core/src/nif.zig`:
  ```zig
  // Stub — implemented in Task 9.
  const c = @cImport(@cInclude("erl_nif.h"));
  export fn nif_init() callconv(.C) ?*c.ErlNifEntry { return null; }
  ```

  Create `cli/fbi-term-core/src/resource.zig`:
  ```zig
  // Stub — implemented in Task 8.
  ```

  Create `cli/fbi-term-core/test/parser_test.zig`:
  ```zig
  const std = @import("std");
  const testing = std.testing;
  
  test "placeholder" {
      try testing.expect(true);
  }
  ```

- [ ] **Step 6: Verify the skeleton compiles**

  ```bash
  cd /workspace/cli/fbi-term-core
  zig build test
  ```
  Expected: "1 passed; 0 skipped; 0 failed."

  If the ghostty module name in Step 3 was wrong, update `build.zig` and re-run.

- [ ] **Step 7: Commit**

  ```bash
  cd /workspace
  git add cli/fbi-term-core/build.zig cli/fbi-term-core/build.zig.zon \
          cli/fbi-term-core/src/ cli/fbi-term-core/test/
  git commit -m "feat(fbi-term): Zig package skeleton — build.zig, build.zig.zon, stub sources"
  ```

---

### Task 4: Verify libghostty-vt API

This task produces no shipping code. Its output is a set of confirmed API facts that Tasks 5–6 depend on. **Do not skip this task.**

- [ ] **Step 1: Find the ghostty terminal module**

  In the fetched ghostty source (see `~/.cache/zig/p/` or untar directly), locate the file that defines the `Terminal` struct. Likely paths:
  ```
  src/terminal.zig
  src/terminal/main.zig
  src/Terminal.zig
  ```

  ```bash
  find ~/.cache/zig/p/ -name "*.zig" 2>/dev/null | xargs grep -l "pub const Terminal = struct" 2>/dev/null | head -5
  ```

- [ ] **Step 2: Confirm Terminal initialization signature**

  Look for `pub fn init` on the `Terminal` struct. It will look like one of:
  ```zig
  pub fn init(alloc: Allocator, size: TerminalSize) !Terminal
  pub fn init(alloc: Allocator, opts: Options) !Terminal
  pub fn init(alloc: Allocator, cols: usize, rows: usize) !Terminal
  ```
  Record the exact signature.

- [ ] **Step 3: Confirm input processing signature**

  Look for the method that feeds raw bytes. It will look like one of:
  ```zig
  pub fn processInput(self: *Terminal, alloc: Allocator, input: []const u8) !void
  pub fn write(self: *Terminal, data: []const u8) void
  pub fn feed(self: *Terminal, bytes: []const u8) void
  ```
  Record the exact name and signature.

- [ ] **Step 4: Confirm grid access API**

  Look for how to iterate rows and cells. Ghostty uses a page-based screen model. Find the active screen accessor and row iterator. It will look like one of:
  ```zig
  // Option A: page iterator
  var it = self.screen.pages.rowIterator(.right_down, ...);
  while (it.next()) |row| { ... }
  // Option B: direct index
  const row = self.screen.getRow(idx);
  // Option C: cursor / page structure
  ```
  Record the exact pattern for iterating all visible rows and the cells within each row.

- [ ] **Step 5: Confirm cell attribute types**

  For a cell, find how to read:
  - The Unicode codepoint (character)
  - Whether it is a wide-char spacer (to skip)
  - Foreground color (`fg`)
  - Background color (`bg`)
  - Bold, italic, reverse flags
  Record the exact field names and types.

- [ ] **Step 6: Confirm cursor position access**

  Find how to read the active cursor's row and column:
  ```zig
  self.screen.cursor.x  // col
  self.screen.cursor.y  // row
  // or
  self.cursor.point.x / .y
  ```
  Record the exact accessor.

- [ ] **Step 7: Confirm resize signature**

  ```zig
  pub fn resize(self: *Terminal, alloc: Allocator, opts: ResizeOpts) !void
  // or
  pub fn resize(self: *Terminal, cols: usize, rows: usize) !void
  ```

- [ ] **Step 8: Write a minimal exploratory test**

  Update `cli/fbi-term-core/test/parser_test.zig` to import the ghostty terminal and exercise the confirmed APIs:

  ```zig
  const std = @import("std");
  const testing = std.testing;
  const ghostty = @import("ghostty");
  // Adjust the import path to match the module structure you found in Step 1.
  // e.g.: const Terminal = ghostty.terminal.Terminal;
  //   or: const Terminal = ghostty.Terminal;
  
  test "ghostty terminal: feed bytes and read cursor" {
      const alloc = testing.allocator;
      // Use the init signature confirmed in Step 2.
      var t = try ghostty.terminal.Terminal.init(alloc, .{ .cols = 80, .rows = 24 });
      defer t.deinit(alloc);
  
      // Use the input method confirmed in Step 3.
      try t.processInput(alloc, "hello");
  
      // Use the cursor accessor confirmed in Step 6.
      // After writing 5 chars at (0,0), cursor should be at col 5, row 0.
      try testing.expectEqual(@as(usize, 5), t.screen.cursor.x);
      try testing.expectEqual(@as(usize, 0), t.screen.cursor.y);
  }
  ```

  Adjust all API names to match what you confirmed in Steps 2–7. Run:
  ```bash
  cd /workspace/cli/fbi-term-core
  zig build test
  ```
  Expected: "1 passed; 0 skipped; 0 failed."

  If it fails with "field not found" errors, look up the correct field/method names and retry. This step must pass before proceeding.

- [ ] **Step 9: Document API findings**

  At the top of `cli/fbi-term-core/src/parser.zig`, add a comment block recording all confirmed API signatures (init, processInput/feed, grid access, cell fields, cursor, resize). Future readers (and Tasks 5–6) depend on this.

---

### Task 5: Port ModeScanner to Zig (`modes.zig`)

The Rust `ModeScanner` is a pure CSI parser with no external dependencies. Port it directly. The logic is well-documented in `cli/fbi-term-core/src/modes.rs`.

**Files:**
- Modify: `cli/fbi-term-core/src/modes.zig`
- Modify: `cli/fbi-term-core/test/parser_test.zig`

- [ ] **Step 1: Write failing tests for ModeScanner**

  Replace `cli/fbi-term-core/test/parser_test.zig` with:

  ```zig
  const std = @import("std");
  const testing = std.testing;
  const modes = @import("../src/modes.zig");
  
  test "ModeState defaults match xterm power-on" {
      const s = modes.ModeState{};
      try testing.expect(s.auto_wrap);
      try testing.expect(s.cursor_visible);
      try testing.expect(!s.alt_screen);
      try testing.expect(!s.bracketed_paste);
      try testing.expect(!s.focus_reporting);
      try testing.expectEqual(@as(u16, 0), s.mouse_mode);
      try testing.expectEqual(@as(u16, 0), s.mouse_ext);
      try testing.expectEqual(@as(?u16, null), s.stbm_top);
      try testing.expectEqual(@as(?u16, null), s.stbm_bottom);
  }
  
  test "ModeScanner: alt-screen enter and exit" {
      var scanner = modes.ModeScanner.init();
      scanner.feed("\x1b[?1049h"); // enter alt screen
      try testing.expect(scanner.modes.alt_screen);
      scanner.feed("\x1b[?1049l"); // exit alt screen
      try testing.expect(!scanner.modes.alt_screen);
  }
  
  test "ModeScanner: alt-screen variants 47 and 1047" {
      var s = modes.ModeScanner.init();
      s.feed("\x1b[?47h");
      try testing.expect(s.modes.alt_screen);
      s.feed("\x1b[?47l");
      try testing.expect(!s.modes.alt_screen);
      s.feed("\x1b[?1047h");
      try testing.expect(s.modes.alt_screen);
  }
  
  test "ModeScanner: DECSTBM scroll region set and reset" {
      var s = modes.ModeScanner.init();
      s.feed("\x1b[5;20r");
      try testing.expectEqual(@as(?u16, 5), s.modes.stbm_top);
      try testing.expectEqual(@as(?u16, 20), s.modes.stbm_bottom);
      s.feed("\x1b[r"); // reset
      try testing.expectEqual(@as(?u16, null), s.modes.stbm_top);
      try testing.expectEqual(@as(?u16, null), s.modes.stbm_bottom);
  }
  
  test "ModeScanner: mouse modes" {
      var s = modes.ModeScanner.init();
      s.feed("\x1b[?1000h");
      try testing.expectEqual(@as(u16, 1000), s.modes.mouse_mode);
      s.feed("\x1b[?1006h");
      try testing.expectEqual(@as(u16, 1006), s.modes.mouse_ext);
      s.feed("\x1b[?1000l");
      try testing.expectEqual(@as(u16, 0), s.modes.mouse_mode);
  }
  
  test "ModeScanner: bracketed paste and focus reporting" {
      var s = modes.ModeScanner.init();
      s.feed("\x1b[?2004h");
      try testing.expect(s.modes.bracketed_paste);
      s.feed("\x1b[?1004h");
      try testing.expect(s.modes.focus_reporting);
      s.feed("\x1b[?2004l");
      try testing.expect(!s.modes.bracketed_paste);
  }
  
  test "ModeScanner: cursor visibility" {
      var s = modes.ModeScanner.init();
      s.feed("\x1b[?25l");
      try testing.expect(!s.modes.cursor_visible);
      s.feed("\x1b[?25h");
      try testing.expect(s.modes.cursor_visible);
  }
  
  test "ModeScanner: CSI sequence split across feed calls" {
      var s = modes.ModeScanner.init();
      s.feed("\x1b[?");     // partial sequence
      s.feed("1049h");     // completion
      try testing.expect(s.modes.alt_screen);
  }
  
  test "ModeScanner: emit alt-screen" {
      var s = modes.ModeScanner.init();
      s.feed("\x1b[?1049h");
      const ansi = s.emit(testing.allocator, 24);
      defer testing.allocator.free(ansi);
      try testing.expect(std.mem.indexOf(u8, ansi, "\x1b[?1049h") != null);
  }
  
  test "ModeScanner: emit scroll region clamped to rows" {
      var s = modes.ModeScanner.init();
      s.feed("\x1b[1;50r"); // bottom = 50, rows = 24
      const ansi = s.emit(testing.allocator, 24);
      defer testing.allocator.free(ansi);
      // Clamped to 24: expect \x1b[1;24r
      try testing.expect(std.mem.indexOf(u8, ansi, "\x1b[1;24r") != null);
  }
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  cd /workspace/cli/fbi-term-core
  zig build test 2>&1 | head -30
  ```
  Expected: compilation errors since `modes.zig` has stub types.

- [ ] **Step 3: Implement `modes.zig`**

  Replace `cli/fbi-term-core/src/modes.zig` with the full port. Note that `emit` takes an allocator because it builds a heap-allocated string:

  ```zig
  const std = @import("std");
  const Allocator = std.mem.Allocator;
  
  pub const ModeState = struct {
      auto_wrap: bool = true,
      cursor_visible: bool = true,
      alt_screen: bool = false,
      focus_reporting: bool = false,
      bracketed_paste: bool = false,
      in_band_resize: bool = false,
      mouse_mode: u16 = 0,
      mouse_ext: u16 = 0,
      stbm_top: ?u16 = null,
      stbm_bottom: ?u16 = null,
  };
  
  const ScanState = enum { normal, esc, csi };
  
  pub const ModeScanner = struct {
      modes: ModeState = .{},
      state: ScanState = .normal,
      csi_private: ?u8 = null,
      csi_params: std.ArrayList(u8),
  
      pub fn init() ModeScanner {
          return .{ .csi_params = std.ArrayList(u8).init(std.heap.page_allocator) };
      }
  
      pub fn initWithAllocator(alloc: Allocator) ModeScanner {
          return .{ .csi_params = std.ArrayList(u8).init(alloc) };
      }
  
      pub fn deinit(self: *ModeScanner) void {
          self.csi_params.deinit();
      }
  
      pub fn withInitialState(state: ModeState, alloc: Allocator) ModeScanner {
          return .{
              .modes = state,
              .state = .normal,
              .csi_private = null,
              .csi_params = std.ArrayList(u8).init(alloc),
          };
      }
  
      pub fn feed(self: *ModeScanner, data: []const u8) void {
          for (data) |b| {
              switch (self.state) {
                  .normal => {
                      if (b == 0x1b) self.state = .esc;
                  },
                  .esc => {
                      if (b == 0x5b) { // '['
                          self.state = .csi;
                          self.csi_private = null;
                          self.csi_params.clearRetainingCapacity();
                      } else {
                          self.state = .normal;
                      }
                  },
                  .csi => {
                      if (self.csi_private == null and self.csi_params.items.len == 0 and
                          b >= 0x3c and b <= 0x3f)
                      {
                          self.csi_private = b;
                      } else if (std.ascii.isDigit(b) or b == ';' or b == ':') {
                          self.csi_params.append(b) catch {};
                      } else if (b >= 0x40 and b <= 0x7e) {
                          self.dispatch(b);
                          self.state = .normal;
                      } else if (b >= 0x20 and b <= 0x2f) {
                          // intermediate — ignore
                      } else {
                          self.state = .normal;
                      }
                  },
              }
          }
      }
  
      fn dispatch(self: *ModeScanner, final: u8) void {
          if (self.csi_private == '?' and (final == 'h' or final == 'l')) {
              const set = final == 'h';
              var it = std.mem.splitScalar(u8, self.csi_params.items, ';');
              while (it.next()) |part| {
                  if (part.len == 0) continue;
                  const n = std.fmt.parseInt(u16, part, 10) catch continue;
                  self.applyDecMode(n, set);
              }
          } else if (self.csi_private == null and final == 'r') {
              var it = std.mem.splitScalar(u8, self.csi_params.items, ';');
              const top_s = it.next() orelse "";
              const bot_s = it.next() orelse "";
              const top = std.fmt.parseInt(u16, top_s, 10) catch null;
              const bot = std.fmt.parseInt(u16, bot_s, 10) catch null;
              if (top != null and bot != null) {
                  self.modes.stbm_top = top;
                  self.modes.stbm_bottom = bot;
              } else {
                  self.modes.stbm_top = null;
                  self.modes.stbm_bottom = null;
              }
          }
      }
  
      fn applyDecMode(self: *ModeScanner, n: u16, set: bool) void {
          switch (n) {
              7 => self.modes.auto_wrap = set,
              25 => self.modes.cursor_visible = set,
              47, 1047, 1049 => self.modes.alt_screen = set,
              1004 => self.modes.focus_reporting = set,
              2004 => self.modes.bracketed_paste = set,
              2031 => self.modes.in_band_resize = set,
              1000, 1002, 1003 => {
                  if (set) {
                      self.modes.mouse_mode = n;
                  } else if (self.modes.mouse_mode == n) {
                      self.modes.mouse_mode = 0;
                  }
              },
              1006, 1015, 1016 => {
                  if (set) {
                      self.modes.mouse_ext = n;
                  } else if (self.modes.mouse_ext == n) {
                      self.modes.mouse_ext = 0;
                  }
              },
              else => {},
          }
      }
  
      /// Emit ANSI that replays the current mode state. Caller owns returned slice.
      pub fn emit(self: *const ModeScanner, alloc: Allocator, rows: u16) []const u8 {
          var buf = std.ArrayList(u8).init(alloc);
          const w = buf.writer();
  
          // Step 1: buffer
          if (self.modes.alt_screen) {
              w.writeAll("\x1b[?1049h") catch {};
          } else {
              w.writeAll("\x1b[?1049l\x1b[H\x1b[2J") catch {};
          }
  
          // Step 2: scroll region
          if (self.modes.stbm_top != null and self.modes.stbm_bottom != null) {
              const top = @max(self.modes.stbm_top.?, 1);
              const bot = @min(self.modes.stbm_bottom.?, rows);
              const top_c = @min(top, rows);
              const bot_c = @max(bot, top_c);
              w.print("\x1b[{};{}r", .{ top_c, bot_c }) catch {};
          } else {
              w.writeAll("\x1b[r") catch {};
          }
  
          // Step 3: auto-wrap and cursor visibility (always emitted)
          if (self.modes.auto_wrap) {
              w.writeAll("\x1b[?7h") catch {};
          } else {
              w.writeAll("\x1b[?7l") catch {};
          }
          if (self.modes.cursor_visible) {
              w.writeAll("\x1b[?25h") catch {};
          } else {
              w.writeAll("\x1b[?25l") catch {};
          }
  
          // Step 4: optional flags (only when enabled)
          if (self.modes.bracketed_paste) w.writeAll("\x1b[?2004h") catch {};
          if (self.modes.focus_reporting) w.writeAll("\x1b[?1004h") catch {};
          if (self.modes.in_band_resize)  w.writeAll("\x1b[?2031h") catch {};
  
          // Step 5: mouse modes (only when non-zero)
          if (self.modes.mouse_mode != 0) w.print("\x1b[?{}h", .{self.modes.mouse_mode}) catch {};
          if (self.modes.mouse_ext  != 0) w.print("\x1b[?{}h", .{self.modes.mouse_ext})  catch {};
  
          return buf.toOwnedSlice() catch &[_]u8{};
      }
  };
  ```

  > **Note on allocator for `csi_params`:** Using `page_allocator` in `init()` is acceptable for the server-side use case (the scanner lives for the run's lifetime and `csi_params` is tiny). If tests use `testing.allocator`, prefer `initWithAllocator(testing.allocator)` in tests to enable leak detection.

- [ ] **Step 4: Update test file to use `initWithAllocator`**

  In `parser_test.zig`, replace every `modes.ModeScanner.init()` with `modes.ModeScanner.initWithAllocator(testing.allocator)` and add `defer scanner.deinit()` after each init. This ensures leak detection works.

- [ ] **Step 5: Run tests — expect pass**

  ```bash
  cd /workspace/cli/fbi-term-core
  zig build test
  ```
  Expected: all `ModeScanner` tests pass.

- [ ] **Step 6: Commit**

  ```bash
  cd /workspace
  git add cli/fbi-term-core/src/modes.zig cli/fbi-term-core/test/parser_test.zig
  git commit -m "feat(fbi-term): port ModeScanner to Zig"
  ```

---

### Task 6: Port CheckpointStore to Zig (`checkpoint.zig`)

The Rust `CheckpointStore` uses a `BTreeMap` and a rolling byte buffer. Port to Zig using `std.ArrayHashMap` sorted by key (or a simple sorted array — the store has O(total_bytes / 256KB) entries, tiny in practice).

**Files:**
- Modify: `cli/fbi-term-core/src/checkpoint.zig`
- Modify: `cli/fbi-term-core/test/parser_test.zig`

- [ ] **Step 1: Write failing tests for CheckpointStore**

  Add to `parser_test.zig`:

  ```zig
  const checkpoint = @import("../src/checkpoint.zig");
  const modes_mod = @import("../src/modes.zig");
  
  test "CheckpointStore: seed checkpoint at offset 0" {
      var store = try checkpoint.CheckpointStore.init(testing.allocator);
      defer store.deinit();
      const result = store.locate(0);
      try testing.expect(result != null);
      try testing.expectEqual(@as(u64, 0), result.?.cp_offset);
  }
  
  test "CheckpointStore: locate returns latest checkpoint <= offset" {
      var store = try checkpoint.CheckpointStore.init(testing.allocator);
      defer store.deinit();
      // Feed 300 KB in one chunk to trigger a checkpoint at ~256 KB boundary.
      const big_chunk = try testing.allocator.alloc(u8, 300 * 1024);
      defer testing.allocator.free(big_chunk);
      @memset(big_chunk, 'A');
      const ms = modes_mod.ModeState{};
      try store.record(big_chunk, 0, &ms);
      // locate(0) → checkpoint at 0
      const r0 = store.locate(0).?;
      try testing.expectEqual(@as(u64, 0), r0.cp_offset);
      // locate(big) → checkpoint created somewhere in [0, 300K]
      const rbig = store.locate(300 * 1024).?;
      try testing.expect(rbig.cp_offset > 0);
  }
  
  test "CheckpointStore: replay bytes covers [cp_offset, offset)" {
      var store = try checkpoint.CheckpointStore.init(testing.allocator);
      defer store.deinit();
      const chunk = "hello world";
      const ms = modes_mod.ModeState{};
      try store.record(chunk, 0, &ms);
      const r = store.locate(5).?;
      try testing.expectEqual(@as(u64, 0), r.cp_offset);
      try testing.expectEqualStrings("hello", r.replay_bytes);
  }
  ```

- [ ] **Step 2: Run tests — expect compile errors**

  ```bash
  cd /workspace/cli/fbi-term-core && zig build test 2>&1 | head -20
  ```

- [ ] **Step 3: Implement `checkpoint.zig`**

  Port the Rust `CheckpointStore`. Use a `std.ArrayList` of `(u64, ModeState)` pairs kept sorted by offset (append-only in practice; binary search for `locate`):

  ```zig
  const std = @import("std");
  const Allocator = std.mem.Allocator;
  const ModeState = @import("modes.zig").ModeState;
  
  pub const CHECKPOINT_INTERVAL: u64 = 256 * 1024;
  
  const Checkpoint = struct { offset: u64, modes: ModeState };
  
  pub const LocateResult = struct {
      cp_offset: u64,
      cp_modes: ModeState,
      replay_bytes: []const u8,
  };
  
  pub const CheckpointStore = struct {
      alloc: Allocator,
      /// Sorted ascending by .offset. Always has at least one entry (offset=0).
      checkpoints: std.ArrayList(Checkpoint),
      /// Rolling byte window covering [recent_start, recent_start + recent_bytes.len).
      recent_bytes: std.ArrayList(u8),
      recent_start: u64,
  
      pub fn init(alloc: Allocator) !CheckpointStore {
          var cps = std.ArrayList(Checkpoint).init(alloc);
          try cps.append(.{ .offset = 0, .modes = ModeState{} });
          return .{
              .alloc = alloc,
              .checkpoints = cps,
              .recent_bytes = std.ArrayList(u8).init(alloc),
              .recent_start = 0,
          };
      }
  
      pub fn deinit(self: *CheckpointStore) void {
          self.checkpoints.deinit();
          self.recent_bytes.deinit();
      }
  
      pub fn record(
          self: *CheckpointStore,
          bytes: []const u8,
          offset_before: u64,
          modes_after: *const ModeState,
      ) !void {
          if (bytes.len == 0) return;
          const offset_after = offset_before + bytes.len;
  
          try self.recent_bytes.appendSlice(bytes);
  
          // Last checkpoint offset.
          const last_cp = self.checkpoints.items[self.checkpoints.items.len - 1].offset;
          const next_boundary = ((last_cp / CHECKPOINT_INTERVAL) + 1) * CHECKPOINT_INTERVAL;
  
          if (offset_after >= next_boundary) {
              try self.checkpoints.append(.{ .offset = offset_after, .modes = modes_after.* });
  
              // Advance recent_start to the penultimate checkpoint.
              if (self.checkpoints.items.len >= 2) {
                  const penultimate = self.checkpoints.items[self.checkpoints.items.len - 2].offset;
                  if (penultimate > self.recent_start) {
                      const trim = penultimate - self.recent_start;
                      const trim_usize = @as(usize, @intCast(trim));
                      if (trim_usize <= self.recent_bytes.items.len) {
                          const remaining = self.recent_bytes.items[trim_usize..];
                          std.mem.copyForwards(u8, self.recent_bytes.items, remaining);
                          self.recent_bytes.shrinkRetainingCapacity(remaining.len);
                      } else {
                          self.recent_bytes.clearRetainingCapacity();
                      }
                      self.recent_start = penultimate;
                  }
              }
          }
      }
  
      /// Returns the latest checkpoint at or before `offset`.
      pub fn locate(self: *const CheckpointStore, offset: u64) ?LocateResult {
          // Binary search for the largest checkpoint.offset <= offset.
          var lo: usize = 0;
          var hi: usize = self.checkpoints.items.len;
          while (lo + 1 < hi) {
              const mid = lo + (hi - lo) / 2;
              if (self.checkpoints.items[mid].offset <= offset) {
                  lo = mid;
              } else {
                  hi = mid;
              }
          }
          if (self.checkpoints.items[lo].offset > offset) return null;
          const cp = self.checkpoints.items[lo];
  
          // Compute replay slice: recent_bytes[cp.offset - recent_start .. offset - recent_start]
          const window_start = self.recent_start;
          const window_end = window_start + self.recent_bytes.items.len;
  
          const eff_start = @max(cp.offset, window_start);
          const eff_end = @min(offset, window_end);
  
          const replay = if (eff_start <= eff_end and eff_start >= window_start and eff_end <= window_end) blk: {
              const s = @as(usize, @intCast(eff_start - window_start));
              const e = @as(usize, @intCast(eff_end - window_start));
              break :blk self.recent_bytes.items[s..e];
          } else &[_]u8{};
  
          return LocateResult{
              .cp_offset = cp.offset,
              .cp_modes = cp.modes,
              .replay_bytes = replay,
          };
      }
  };
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  cd /workspace/cli/fbi-term-core && zig build test
  ```
  Expected: all `CheckpointStore` tests pass.

- [ ] **Step 5: Commit**

  ```bash
  cd /workspace
  git add cli/fbi-term-core/src/checkpoint.zig cli/fbi-term-core/test/parser_test.zig
  git commit -m "feat(fbi-term): port CheckpointStore to Zig"
  ```

---

### Task 7: Implement Parser and serializer using libghostty

This is the core task. It uses the confirmed API from Task 4. **Do not write this task without having completed Task 4.**

**Files:**
- Modify: `cli/fbi-term-core/src/parser.zig`
- Modify: `cli/fbi-term-core/src/serialize.zig`
- Modify: `cli/fbi-term-core/test/parser_test.zig`

- [ ] **Step 1: Write failing tests for Parser**

  Add to `parser_test.zig`:

  ```zig
  const parser_mod = @import("../src/parser.zig");
  
  test "Parser: feed writes to grid" {
      const alloc = testing.allocator;
      var p = try parser_mod.Parser.init(alloc, 80, 24);
      defer p.deinit();
      // Write "hello" — cursor should advance 5 cols.
      p.feed("hello");
      // Use the cursor helper consistent with the libghostty API confirmed in Task 4.
      const cur = p.cursor();
      try testing.expectEqual(@as(usize, 5), cur.col);
      try testing.expectEqual(@as(usize, 0), cur.row);
  }
  
  test "Parser: feed tracks bytes_fed" {
      const alloc = testing.allocator;
      var p = try parser_mod.Parser.init(alloc, 80, 24);
      defer p.deinit();
      p.feed("abc");
      try testing.expectEqual(@as(u64, 3), p.bytes_fed);
  }
  
  test "Parser: snapshot returns cols/rows" {
      const alloc = testing.allocator;
      var p = try parser_mod.Parser.init(alloc, 80, 24);
      defer p.deinit();
      const snap = try p.snapshot(alloc);
      defer alloc.free(snap.ansi);
      try testing.expectEqual(@as(u16, 80), snap.cols);
      try testing.expectEqual(@as(u16, 24), snap.rows);
  }
  
  test "Parser: snapshot ansi contains CUP for cursor" {
      const alloc = testing.allocator;
      var p = try parser_mod.Parser.init(alloc, 80, 24);
      defer p.deinit();
      p.feed("hello");
      const snap = try p.snapshot(alloc);
      defer alloc.free(snap.ansi);
      // CUP for row 1, col 6 (1-indexed): \x1b[1;6H
      try testing.expect(std.mem.indexOf(u8, snap.ansi, "\x1b[1;6H") != null);
  }
  
  test "Parser: alt-screen tracked in snapshot mode prefix" {
      const alloc = testing.allocator;
      var p = try parser_mod.Parser.init(alloc, 80, 24);
      defer p.deinit();
      p.feed("\x1b[?1049h"); // enter alt screen
      const snap = try p.snapshot(alloc);
      defer alloc.free(snap.ansi);
      try testing.expect(std.mem.indexOf(u8, snap.ansi, "\x1b[?1049h") != null);
  }
  
  test "Parser: resize updates cols/rows" {
      const alloc = testing.allocator;
      var p = try parser_mod.Parser.init(alloc, 80, 24);
      defer p.deinit();
      try p.resize(120, 40);
      try testing.expectEqual(@as(u16, 120), p.cols);
      try testing.expectEqual(@as(u16, 40), p.rows);
  }
  
  test "Parser: snapshot_at returns mode prefix" {
      const alloc = testing.allocator;
      var p = try parser_mod.Parser.init(alloc, 80, 24);
      defer p.deinit();
      p.feed("\x1b[?1049h"); // enter alt at byte 0
      p.feed("hello");       // bytes 8..13
      const prefix = try p.snapshotAt(alloc, 8);
      defer alloc.free(prefix.ansi);
      // Mode prefix at offset 8 should include alt-screen entry.
      try testing.expect(std.mem.indexOf(u8, prefix.ansi, "\x1b[?1049h") != null);
  }
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  cd /workspace/cli/fbi-term-core && zig build test 2>&1 | head -30
  ```

- [ ] **Step 3: Implement `parser.zig`**

  Use the exact API names confirmed in Task 4. The template below uses placeholders — replace them with the actual ghostty API names.

  ```zig
  const std = @import("std");
  const Allocator = std.mem.Allocator;
  // !! Use the import path confirmed in Task 4.
  const ghostty = @import("ghostty");
  // !! Adjust to the actual Terminal type path, e.g.:
  //    const GhosttyTerminal = ghostty.terminal.Terminal;
  //    const GhosttyTerminal = ghostty.Terminal;
  const GhosttyTerminal = ghostty.terminal.Terminal;
  
  const ModeScanner = @import("modes.zig").ModeScanner;
  const CheckpointStore = @import("checkpoint.zig").CheckpointStore;
  const serialize = @import("serialize.zig");
  
  pub const Snapshot = struct {
      ansi: []const u8, // caller owns
      cols: u16,
      rows: u16,
      byte_offset: u64,
  };
  
  pub const ModePrefix = struct {
      ansi: []const u8, // caller owns
  };
  
  pub const CursorPos = struct { row: usize, col: usize };
  
  pub const Parser = struct {
      alloc: Allocator,
      // !! Replace with the actual libghostty terminal type.
      terminal: GhosttyTerminal,
      mode_scanner: ModeScanner,
      checkpoints: CheckpointStore,
      bytes_fed: u64 = 0,
      cols: u16,
      rows: u16,
  
      pub fn init(alloc: Allocator, cols: u16, rows: u16) !Parser {
          // !! Use the init signature confirmed in Task 4, e.g.:
          //    GhosttyTerminal.init(alloc, .{ .cols = cols, .rows = rows })
          const terminal = try GhosttyTerminal.init(alloc, .{
              .cols = @as(usize, cols),
              .rows = @as(usize, rows),
          });
          return .{
              .alloc = alloc,
              .terminal = terminal,
              .mode_scanner = ModeScanner.initWithAllocator(alloc),
              .checkpoints = try CheckpointStore.init(alloc),
              .cols = cols,
              .rows = rows,
          };
      }
  
      pub fn deinit(self: *Parser) void {
          // !! Use the deinit signature confirmed in Task 4.
          self.terminal.deinit(self.alloc);
          self.mode_scanner.deinit();
          self.checkpoints.deinit();
      }
  
      pub fn feed(self: *Parser, bytes: []const u8) void {
          if (bytes.len == 0) return;
          const offset_before = self.bytes_fed;
          // !! Use the processInput/write/feed method confirmed in Task 4.
          self.terminal.processInput(self.alloc, bytes) catch {};
          self.mode_scanner.feed(bytes);
          self.checkpoints.record(bytes, offset_before, &self.mode_scanner.modes) catch {};
          self.bytes_fed += bytes.len;
      }
  
      pub fn resize(self: *Parser, cols: u16, rows: u16) !void {
          if (cols == self.cols and rows == self.rows) return;
          // !! Use the resize signature confirmed in Task 4.
          try self.terminal.resize(self.alloc, .{
              .cols = @as(usize, cols),
              .rows = @as(usize, rows),
          });
          self.cols = cols;
          self.rows = rows;
      }
  
      pub fn cursor(self: *const Parser) CursorPos {
          // !! Use the cursor accessor confirmed in Task 4.
          return .{
              .row = self.terminal.screen.cursor.y,
              .col = self.terminal.screen.cursor.x,
          };
      }
  
      /// Returns ANSI snapshot. Caller owns `snap.ansi`.
      pub fn snapshot(self: *const Parser, alloc: Allocator) !Snapshot {
          const mode_prefix = self.mode_scanner.emit(alloc, self.rows);
          defer alloc.free(mode_prefix);
          const grid_ansi = try serialize.serializeGrid(alloc, &self.terminal, self.cols, self.rows);
          defer alloc.free(grid_ansi);
          const ansi = try std.mem.concat(alloc, u8, &.{ mode_prefix, grid_ansi });
          return .{ .ansi = ansi, .cols = self.cols, .rows = self.rows, .byte_offset = self.bytes_fed };
      }
  
      /// Returns mode-only ANSI prefix for byte offset. Caller owns `prefix.ansi`.
      pub fn snapshotAt(self: *const Parser, alloc: Allocator, offset: u64) !ModePrefix {
          std.debug.assert(offset <= self.bytes_fed);
          const result = self.checkpoints.locate(offset) orelse {
              return ModePrefix{ .ansi = try alloc.dupe(u8, "") };
          };
          var scanner = ModeScanner.withInitialState(result.cp_modes, alloc);
          defer scanner.deinit();
          scanner.feed(result.replay_bytes);
          return ModePrefix{ .ansi = scanner.emit(alloc, self.rows) };
      }
  };
  ```

- [ ] **Step 4: Implement `serialize.zig`**

  Port the Rust `serialize_grid`. The key difference is adapting to the libghostty grid API confirmed in Task 4.

  ```zig
  const std = @import("std");
  const Allocator = std.mem.Allocator;
  const ghostty = @import("ghostty");
  // !! Adjust type references to match confirmed API.
  
  /// Serialize the visible grid to an ANSI replay string. Caller owns result.
  /// Uses the libghostty Terminal type; adapt field/method names per Task 4 findings.
  pub fn serializeGrid(
      alloc: Allocator,
      // !! Replace with the actual terminal type pointer.
      terminal: anytype,
      cols: u16,
      rows: u16,
  ) ![]const u8 {
      var buf = std.ArrayList(u8).init(alloc);
      const w = buf.writer();
  
      var cur_attrs = AttrState{};
  
      // !! Adapt row iteration to libghostty's grid API confirmed in Task 4.
      // The pattern below is illustrative; the exact iterator API will differ.
      //
      // For ghostty's page-based screen, iteration looks something like:
      //   var row_it = terminal.screen.pages.rowIterator(...);
      //   while (row_it.next()) |row| { ... }
      //
      // If the API provides direct row access:
      //   for (0..rows) |row_idx| { const row = terminal.screen.getRow(row_idx); ... }
      //
      // Use whichever pattern matches what you confirmed in Task 4.
  
      for (0..@as(usize, rows)) |row_idx| {
          // !! Replace with actual ghostty row access.
          // const row = terminal.screen.getRow(row_idx);
          _ = row_idx; // placeholder
  
          // Find last non-empty cell in the row to trim trailing blanks.
          // !! Adapt cell iteration and `is_empty` check to ghostty Cell type.
          var last_content_col: usize = 0;
          for (0..@as(usize, cols)) |col_idx| {
              // !! Access cell: const cell = row.cells[col_idx] or similar.
              _ = col_idx; // placeholder
              // if (!cell.isEmpty()) last_content_col = col_idx + 1;
          }
  
          for (0..last_content_col) |col_idx| {
              // !! Get cell at col_idx.
              _ = col_idx;
              // Skip wide-char spacers.
              // !! Use ghostty's wide-char spacer flag: if (cell.wide == .spacer) continue;
  
              // Emit SGR delta if attributes changed.
              // const cell_attrs = AttrState.fromCell(cell);
              // if (!cell_attrs.eql(cur_attrs)) {
              //     emitSgr(w, cur_attrs, cell_attrs) catch {};
              //     cur_attrs = cell_attrs;
              // }
  
              // Emit character.
              // const cp = cell.char; // u21 Unicode codepoint
              // var encoded: [4]u8 = undefined;
              // const len = std.unicode.utf8Encode(cp, &encoded) catch 1;
              // w.writeAll(encoded[0..len]) catch {};
          }
  
          if (row_idx + 1 < @as(usize, rows)) {
              w.writeAll("\r\n") catch {};
          }
      }
  
      // Reset SGR if we left a non-default state.
      if (!cur_attrs.isDefault()) {
          w.writeAll("\x1b[0m") catch {};
      }
  
      // Final CUP (1-indexed).
      // !! Use cursor accessor confirmed in Task 4.
      // const cur = terminal.screen.cursor;
      // w.print("\x1b[{};{}H", .{ cur.y + 1, cur.x + 1 }) catch {};
      // PLACEHOLDER — replace with real cursor access:
      w.writeAll("\x1b[1;1H") catch {};
  
      return buf.toOwnedSlice();
  }
  
  // ── SGR attribute state ───────────────────────────────────────────────────
  
  /// Color representation matching ghostty's Cell.Fg/Bg type.
  /// !! Adjust to match the actual ghostty Color/CellFg/CellBg union type.
  const Color = union(enum) {
      default,
      named: u8,   // ANSI color index 0-15
      indexed: u8, // 256-color index
      rgb: struct { r: u8, g: u8, b: u8 },
  };
  
  const AttrState = struct {
      fg: Color = .default,
      bg: Color = .default,
      bold: bool = false,
      italic: bool = false,
      reverse: bool = false,
  
      fn isDefault(self: AttrState) bool {
          return self.fg == .default and self.bg == .default and
              !self.bold and !self.italic and !self.reverse;
      }
  
      fn eql(self: AttrState, other: AttrState) bool {
          return std.meta.eql(self, other);
      }
  
      /// !! Build from a ghostty Cell. Adjust field names to match confirmed API.
      fn fromCell(cell: anytype) AttrState {
          return .{
              // !! Map ghostty cell.style.fg_color, cell.style.bg_color, etc.
              .fg = .default, // placeholder
              .bg = .default, // placeholder
              .bold = false,   // placeholder: cell.style.flags.bold
              .italic = false, // placeholder: cell.style.flags.italic
              .reverse = false,// placeholder: cell.style.flags.inverse
          };
      }
  };
  
  fn emitSgr(w: anytype, prev: AttrState, next: AttrState) !void {
      if (next.isDefault()) {
          try w.writeAll("\x1b[0m");
          return;
      }
      const needs_reset = (prev.bold and !next.bold) or
          (prev.italic and !next.italic) or
          (prev.reverse and !next.reverse) or
          (prev.fg != .default and next.fg == .default) or
          (prev.bg != .default and next.bg == .default);
      if (needs_reset) {
          try w.writeAll("\x1b[0m");
          try emitSgrApply(w, AttrState{}, next);
      } else {
          try emitSgrApply(w, prev, next);
      }
  }
  
  fn emitSgrApply(w: anytype, prev: AttrState, next: AttrState) !void {
      if (next.bold and !prev.bold) try w.writeAll("\x1b[1m");
      if (next.italic and !prev.italic) try w.writeAll("\x1b[3m");
      if (next.reverse and !prev.reverse) try w.writeAll("\x1b[7m");
      if (!std.meta.eql(next.fg, prev.fg)) try emitColorSgr(w, next.fg, false);
      if (!std.meta.eql(next.bg, prev.bg)) try emitColorSgr(w, next.bg, true);
  }
  
  fn emitColorSgr(w: anytype, color: Color, is_bg: bool) !void {
      switch (color) {
          .default => {
              try w.print("\x1b[{}m", .{ if (is_bg) @as(u8, 49) else @as(u8, 39) });
          },
          .named => |idx| {
              const bright = idx >= 8;
              const base: u8 = if (!is_bg and !bright) 30
                  else if (!is_bg and bright) 90
                  else if (is_bg and !bright) 40
                  else 100;
              try w.print("\x1b[{}m", .{ base + (idx & 7) });
          },
          .indexed => |idx| {
              try w.print("\x1b[{};5;{}m", .{ if (is_bg) @as(u8, 48) else @as(u8, 38), idx });
          },
          .rgb => |rgb| {
              try w.print("\x1b[{};2;{};{};{}m", .{
                  if (is_bg) @as(u8, 48) else @as(u8, 38), rgb.r, rgb.g, rgb.b,
              });
          },
      }
  }
  ```

  > **Important:** The `serialize.zig` template above has many `// !! placeholder` sections. Replace every placeholder with the actual ghostty API calls you verified in Task 4. The file will not compile until all placeholders are replaced with real code.

- [ ] **Step 5: Run tests — expect pass**

  ```bash
  cd /workspace/cli/fbi-term-core && zig build test
  ```
  Expected: all `Parser` tests pass.

- [ ] **Step 6: Commit**

  ```bash
  cd /workspace
  git add cli/fbi-term-core/src/parser.zig cli/fbi-term-core/src/serialize.zig \
          cli/fbi-term-core/test/parser_test.zig
  git commit -m "feat(fbi-term): implement Parser and serializer with libghostty-vt"
  ```

---

## Phase 3 — Erlang NIF Layer

### Task 8: ResourceObject (`resource.zig`)

**Files:**
- Modify: `cli/fbi-term-core/src/resource.zig`

- [ ] **Step 1: Implement `resource.zig`**

  ```zig
  const std = @import("std");
  const c = @cImport(@cInclude("erl_nif.h"));
  const Parser = @import("parser.zig").Parser;
  
  /// The resource type handle registered with the BEAM on NIF load.
  /// Single global — the NIF library is loaded once per BEAM node.
  pub var parser_resource_type: ?*c.ErlNifResourceType = null;
  
  /// The struct stored inside an Erlang resource object.
  pub const ParserResource = struct {
      parser: Parser,
      /// Protects concurrent access from multiple BEAM scheduler threads
      /// (uncommon in practice but the NIF resource API allows it).
      mutex: std.Thread.Mutex = .{},
  };
  
  /// Call from the NIF `on_load` callback.
  pub fn openResourceType(env: ?*c.ErlNifEnv) !void {
      parser_resource_type = c.enif_open_resource_type(
          env,
          null,
          "fbi_parser",
          resourceDtor,
          c.ERL_NIF_RT_CREATE,
          null,
      ) orelse return error.ResourceTypeCreateFailed;
  }
  
  fn resourceDtor(env: ?*c.ErlNifEnv, obj: ?*anyopaque) callconv(.C) void {
      _ = env;
      const res: *ParserResource = @ptrCast(@alignCast(obj.?));
      res.parser.deinit();
      // The mutex needs no explicit deinit for std.Thread.Mutex.
  }
  
  /// Allocate a new resource and initialise the Parser inside it.
  /// Returns `{:error, :alloc_failed}` on allocation failure.
  pub fn allocResource(
      env: ?*c.ErlNifEnv,
      alloc: std.mem.Allocator,
      cols: u16,
      rows: u16,
  ) !c.ERL_NIF_TERM {
      const ptr = c.enif_alloc_resource(
          parser_resource_type.?,
          @sizeOf(ParserResource),
      ) orelse return error.AllocFailed;
      const res: *ParserResource = @ptrCast(@alignCast(ptr));
      res.* = .{
          .parser = try Parser.init(alloc, cols, rows),
          .mutex = .{},
      };
      const term = c.enif_make_resource(env, ptr);
      // Release our local reference; the Erlang term holds the only reference now.
      c.enif_release_resource(ptr);
      return term;
  }
  
  /// Retrieve a `*ParserResource` from an Erlang term, or return null on type mismatch.
  pub fn getResource(env: ?*c.ErlNifEnv, term: c.ERL_NIF_TERM) ?*ParserResource {
      var ptr: ?*anyopaque = null;
      if (c.enif_get_resource(env, term, parser_resource_type.?, &ptr) == 0) return null;
      return @ptrCast(@alignCast(ptr.?));
  }
  ```

- [ ] **Step 2: Verify it compiles (it has no tests of its own — tested via nif.zig in the next task)**

  ```bash
  cd /workspace/cli/fbi-term-core && zig build 2>&1 | head -30
  ```
  Expected: compiles without error (the NIF stub in `nif.zig` still has a null return, which is fine for now).

- [ ] **Step 3: Commit**

  ```bash
  cd /workspace
  git add cli/fbi-term-core/src/resource.zig
  git commit -m "feat(fbi-term): ResourceObject for parser handle lifetime (resource.zig)"
  ```

---

### Task 9: NIF function exports (`nif.zig`)

**Files:**
- Modify: `cli/fbi-term-core/src/nif.zig`

- [ ] **Step 1: Implement `nif.zig`**

  ```zig
  const std = @import("std");
  const c = @cImport(@cInclude("erl_nif.h"));
  const resource = @import("resource.zig");
  const parser_mod = @import("parser.zig");
  
  // Global BEAM allocator backed by enif_alloc/enif_free.
  // Used for all Parser allocations so memory is BEAM-managed.
  const BeamAllocator = struct {
      fn alloc(_: *anyopaque, len: usize, _: u8, _: usize) ?[*]u8 {
          return @ptrCast(c.enif_alloc(len));
      }
      fn resize(_: *anyopaque, buf: []u8, _: u8, new_len: usize, _: usize) bool {
          return new_len <= buf.len;
      }
      fn free(_: *anyopaque, buf: []u8, _: u8, _: usize) void {
          c.enif_free(buf.ptr);
      }
  };
  
  var beam_alloc_state: BeamAllocator = .{};
  var beam_allocator_instance: std.mem.Allocator = undefined;
  
  // ── Atoms ────────────────────────────────────────────────────────────────
  
  var atom_ok: c.ERL_NIF_TERM = undefined;
  var atom_error: c.ERL_NIF_TERM = undefined;
  var atom_nif_panic: c.ERL_NIF_TERM = undefined;
  var atom_badarg: c.ERL_NIF_TERM = undefined;
  
  // ── Helpers ───────────────────────────────────────────────────────────────
  
  fn makeOk(env: ?*c.ErlNifEnv) c.ERL_NIF_TERM {
      return atom_ok;
  }
  
  fn makeError(env: ?*c.ErlNifEnv, reason: c.ERL_NIF_TERM) c.ERL_NIF_TERM {
      return c.enif_make_tuple2(env, atom_error, reason);
  }
  
  fn makePanicError(env: ?*c.ErlNifEnv) c.ERL_NIF_TERM {
      return makeError(env, atom_nif_panic);
  }
  
  // ── NIF: new/2 ────────────────────────────────────────────────────────────
  
  fn nifNew(env: ?*c.ErlNifEnv, argc: c_int, argv: [*c]const c.ERL_NIF_TERM) callconv(.C) c.ERL_NIF_TERM {
      if (argc != 2) return c.enif_make_badarg(env);
      var cols_i: c_int = 0;
      var rows_i: c_int = 0;
      if (c.enif_get_int(env, argv[0], &cols_i) == 0) return c.enif_make_badarg(env);
      if (c.enif_get_int(env, argv[1], &rows_i) == 0) return c.enif_make_badarg(env);
      if (cols_i <= 0 or rows_i <= 0) return c.enif_make_badarg(env);
  
      const term = resource.allocResource(
          env,
          beam_allocator_instance,
          @intCast(cols_i),
          @intCast(rows_i),
      ) catch return makePanicError(env);
      return term;
  }
  
  // ── NIF: feed/2 ──────────────────────────────────────────────────────────
  
  fn nifFeed(env: ?*c.ErlNifEnv, argc: c_int, argv: [*c]const c.ERL_NIF_TERM) callconv(.C) c.ERL_NIF_TERM {
      if (argc != 2) return c.enif_make_badarg(env);
      const res = resource.getResource(env, argv[0]) orelse return c.enif_make_badarg(env);
      var bin: c.ErlNifBinary = undefined;
      if (c.enif_inspect_binary(env, argv[1], &bin) == 0) return c.enif_make_badarg(env);
      const bytes = bin.data[0..bin.size];
  
      res.mutex.lock();
      defer res.mutex.unlock();
      res.parser.feed(bytes);
      return atom_ok;
  }
  
  // ── NIF: snapshot/1 ──────────────────────────────────────────────────────
  
  fn nifSnapshot(env: ?*c.ErlNifEnv, argc: c_int, argv: [*c]const c.ERL_NIF_TERM) callconv(.C) c.ERL_NIF_TERM {
      if (argc != 1) return c.enif_make_badarg(env);
      const res = resource.getResource(env, argv[0]) orelse return c.enif_make_badarg(env);
  
      res.mutex.lock();
      defer res.mutex.unlock();
  
      const snap = res.parser.snapshot(beam_allocator_instance) catch return makePanicError(env);
      defer beam_allocator_instance.free(snap.ansi);
  
      // Copy ansi into an Erlang binary.
      var bin: c.ErlNifBinary = undefined;
      if (c.enif_alloc_binary(snap.ansi.len, &bin) == 0) return makePanicError(env);
      @memcpy(bin.data[0..snap.ansi.len], snap.ansi);
      const ansi_term = c.enif_make_binary(env, &bin);
  
      // Build map: %{ansi: binary, cols: int, rows: int, byte_offset: int}
      const keys = [_]c.ERL_NIF_TERM{
          c.enif_make_atom(env, "ansi"),
          c.enif_make_atom(env, "cols"),
          c.enif_make_atom(env, "rows"),
          c.enif_make_atom(env, "byte_offset"),
      };
      const vals = [_]c.ERL_NIF_TERM{
          ansi_term,
          c.enif_make_int(env, snap.cols),
          c.enif_make_int(env, snap.rows),
          c.enif_make_uint64(env, snap.byte_offset),
      };
      var map: c.ERL_NIF_TERM = undefined;
      _ = c.enif_make_map_from_arrays(env, &keys, &vals, 4, &map);
      return map;
  }
  
  // ── NIF: snapshot_at/2 ───────────────────────────────────────────────────
  
  fn nifSnapshotAt(env: ?*c.ErlNifEnv, argc: c_int, argv: [*c]const c.ERL_NIF_TERM) callconv(.C) c.ERL_NIF_TERM {
      if (argc != 2) return c.enif_make_badarg(env);
      const res = resource.getResource(env, argv[0]) orelse return c.enif_make_badarg(env);
      var offset: c_ulong = 0;
      if (c.enif_get_uint64(env, argv[1], &offset) == 0) return c.enif_make_badarg(env);
  
      res.mutex.lock();
      defer res.mutex.unlock();
  
      const prefix = res.parser.snapshotAt(beam_allocator_instance, offset) catch return makePanicError(env);
      defer beam_allocator_instance.free(prefix.ansi);
  
      var bin: c.ErlNifBinary = undefined;
      if (c.enif_alloc_binary(prefix.ansi.len, &bin) == 0) return makePanicError(env);
      @memcpy(bin.data[0..prefix.ansi.len], prefix.ansi);
      const ansi_term = c.enif_make_binary(env, &bin);
  
      const keys = [_]c.ERL_NIF_TERM{ c.enif_make_atom(env, "ansi") };
      const vals = [_]c.ERL_NIF_TERM{ ansi_term };
      var map: c.ERL_NIF_TERM = undefined;
      _ = c.enif_make_map_from_arrays(env, &keys, &vals, 1, &map);
      return map;
  }
  
  // ── NIF: resize/3 ────────────────────────────────────────────────────────
  
  fn nifResize(env: ?*c.ErlNifEnv, argc: c_int, argv: [*c]const c.ERL_NIF_TERM) callconv(.C) c.ERL_NIF_TERM {
      if (argc != 3) return c.enif_make_badarg(env);
      const res = resource.getResource(env, argv[0]) orelse return c.enif_make_badarg(env);
      var cols_i: c_int = 0;
      var rows_i: c_int = 0;
      if (c.enif_get_int(env, argv[1], &cols_i) == 0) return c.enif_make_badarg(env);
      if (c.enif_get_int(env, argv[2], &rows_i) == 0) return c.enif_make_badarg(env);
      if (cols_i <= 0 or rows_i <= 0) return c.enif_make_badarg(env);
  
      res.mutex.lock();
      defer res.mutex.unlock();
      res.parser.resize(@intCast(cols_i), @intCast(rows_i)) catch return makePanicError(env);
      return atom_ok;
  }
  
  // ── NIF load callback ────────────────────────────────────────────────────
  
  fn onLoad(env: ?*c.ErlNifEnv, _: [*c]?*anyopaque, _: c.ERL_NIF_TERM) callconv(.C) c_int {
      atom_ok = c.enif_make_atom(env, "ok");
      atom_error = c.enif_make_atom(env, "error");
      atom_nif_panic = c.enif_make_atom(env, "nif_panic");
      atom_badarg = c.enif_make_atom(env, "badarg");
  
      beam_allocator_instance = std.mem.Allocator{
          .ptr = &beam_alloc_state,
          .vtable = &.{
              .alloc = BeamAllocator.alloc,
              .resize = BeamAllocator.resize,
              .free = BeamAllocator.free,
          },
      };
  
      resource.openResourceType(env) catch return 1;
      return 0;
  }
  
  // ── NIF function table ────────────────────────────────────────────────────
  
  const nif_funcs = [_]c.ErlNifFunc{
      .{ .name = "new",         .arity = 2, .fptr = nifNew,        .flags = 0 },
      .{ .name = "feed",        .arity = 2, .fptr = nifFeed,       .flags = c.ERL_NIF_DIRTY_JOB_IO_BOUND },
      .{ .name = "snapshot",    .arity = 1, .fptr = nifSnapshot,   .flags = 0 },
      .{ .name = "snapshot_at", .arity = 2, .fptr = nifSnapshotAt, .flags = 0 },
      .{ .name = "resize",      .arity = 3, .fptr = nifResize,     .flags = 0 },
  };
  
  // ── ERL_NIF_INIT equivalent ───────────────────────────────────────────────
  // Replaces the ERL_NIF_INIT macro which cannot be invoked from Zig.
  // The BEAM looks for this exported symbol by name.
  
  const nif_entry = c.ErlNifEntry{
      .major = c.ERL_NIF_MAJOR_VERSION,
      .minor = c.ERL_NIF_MINOR_VERSION,
      .name = "Elixir.FBI.Terminal",
      .num_of_funcs = nif_funcs.len,
      .funcs = @constCast(&nif_funcs),
      .load = onLoad,
      .reload = null,
      .upgrade = null,
      .unload = null,
      .vm_variant = c.ERL_NIF_VM_VARIANT,
      .options = 1,
      .sizeof_ErlNifResourceTypeInit = @sizeOf(c.ErlNifResourceTypeInit),
      .min_erts = c.ERL_NIF_MIN_ERTS_VERSION,
  };
  
  export fn nif_init() callconv(.C) *const c.ErlNifEntry {
      return &nif_entry;
  }
  ```

  > **Note on `ErlNifEntry` fields:** The exact fields depend on the Erlang/OTP version installed. If compilation fails with "unknown field" errors on `ErlNifEntry`, inspect the struct definition in the installed `erl_nif.h` (`find /opt/asdf -name erl_nif.h`) and adjust accordingly.

- [ ] **Step 2: Build the shared library**

  ```bash
  ERL_INCLUDE=$(erl -eval 'io:format("~s~n", [code:root_dir()])' -s init stop)/usr/include
  cd /workspace/cli/fbi-term-core
  zig build -Derl-include="$ERL_INCLUDE" 2>&1 | head -40
  ```
  Expected: produces `zig-out/lib/libfbi_term.so` without error.

- [ ] **Step 3: Commit**

  ```bash
  cd /workspace
  git add cli/fbi-term-core/src/nif.zig cli/fbi-term-core/src/resource.zig
  git commit -m "feat(fbi-term): Erlang NIF in Zig — nif.zig and resource.zig"
  ```

---

## Phase 4 — Elixir Build Integration

### Task 10: Replace Rustler with elixir_make; update `FBI.Terminal`

**Files:**
- Create: `cli/fbi-term-core/Makefile`
- Modify: `server-elixir/mix.exs`
- Modify: `server-elixir/lib/fbi/terminal.ex`
- Delete: `server-elixir/native/fbi_term/` (entire directory)
- Delete: Rust source files in `cli/fbi-term-core/src/*.rs`, `cli/fbi-term-core/Cargo.toml`, `cli/fbi-term-core/tests/`

- [ ] **Step 1: Write a failing mix test to establish the gate**

  The existing `server-elixir/test/fbi/terminal_test.exs` exercises the NIF. Run it now — it will fail because the NIF hasn't been rebuilt yet:

  ```bash
  cd /workspace/server-elixir && mix test test/fbi/terminal_test.exs 2>&1 | tail -20
  ```
  Expected: test fails with a NIF load error (the old Rustler `.so` no longer exists or the module changed). That's the target to fix.

- [ ] **Step 2: Create the Makefile**

  Create `cli/fbi-term-core/Makefile`:

  ```makefile
  # Called by elixir_make from server-elixir/ via make_cwd = "../cli/fbi-term-core".
  # elixir_make provides MIX_APP_PATH (the _build directory) and MIX_ENV.
  
  ERL_INCLUDE = $(shell erl -eval 'io:format("~s~n", [code:root_dir()])' -s init stop)/usr/include
  PRIV_DIR    = $(MIX_APP_PATH)/priv
  MIX_ENV    ?= dev
  
  # ReleaseSafe in prod, Debug in dev/test for faster builds.
  ifeq ($(MIX_ENV),prod)
    ZIG_OPTIMIZE = ReleaseSafe
  else
    ZIG_OPTIMIZE = Debug
  endif
  
  .PHONY: all clean
  
  all: $(PRIV_DIR)/native/fbi_term.so
  
  $(PRIV_DIR)/native/fbi_term.so: src/*.zig build.zig build.zig.zon
  	mkdir -p $(PRIV_DIR)/native
  	zig build \
  		-Derl-include="$(ERL_INCLUDE)" \
  		-Doptimize=$(ZIG_OPTIMIZE) \
  		--prefix "$(PRIV_DIR)"
  	# Zig names the output libfbi_term.so; Erlang's load_nif expects fbi_term.so.
  	mv "$(PRIV_DIR)/lib/libfbi_term.so" "$(PRIV_DIR)/native/fbi_term.so" 2>/dev/null || \
  	cp "zig-out/lib/libfbi_term.so" "$(PRIV_DIR)/native/fbi_term.so"
  
  clean:
  	rm -rf zig-out .zig-cache
  ```

- [ ] **Step 3: Update `server-elixir/mix.exs`**

  Read the file. Make these changes:

  a. Remove `{:rustler, "~> 0.34"}` from `deps`. Add `{:elixir_make, "~> 0.7"}`.

  b. Remove `rustler_crates: rustler_crates()` from the `project/0` keyword list.

  c. Add to `project/0`:
  ```elixir
  compilers: [:elixir_make | Mix.compilers()],
  make_cwd: "../cli/fbi-term-core",
  make_env: %{"MIX_ENV" => to_string(Mix.env())},
  ```

  d. Delete the `defp rustler_crates do ... end` private function entirely.

- [ ] **Step 4: Update `server-elixir/lib/fbi/terminal.ex`**

  Read the file. Replace:
  ```elixir
  use Rustler, otp_app: :fbi, crate: "fbi_term"
  ```
  with:
  ```elixir
  @on_load :load_nif

  def load_nif do
    path = Application.app_dir(:fbi, "priv/native/fbi_term")
    :erlang.load_nif(path, 0)
  end
  ```

  Remove any Rustler-specific module attributes if present. All `@spec` signatures and stub function bodies (`def new(_cols, _rows), do: :erlang.nif_error(:nif_not_loaded)` etc.) remain unchanged.

- [ ] **Step 5: Delete the Rustler crate and Rust source files**

  ```bash
  rm -rf /workspace/server-elixir/native/fbi_term
  rm -f  /workspace/cli/fbi-term-core/src/lib.rs \
         /workspace/cli/fbi-term-core/src/parser.rs \
         /workspace/cli/fbi-term-core/src/modes.rs \
         /workspace/cli/fbi-term-core/src/checkpoint.rs \
         /workspace/cli/fbi-term-core/src/serialize.rs \
         /workspace/cli/fbi-term-core/Cargo.toml
  rm -rf /workspace/cli/fbi-term-core/tests
  ```

- [ ] **Step 6: Fetch new deps and compile**

  ```bash
  cd /workspace/server-elixir
  mix deps.get
  mix compile 2>&1 | tail -30
  ```
  Expected: `elixir_make` runs the Makefile, Zig builds the `.so`, mix compiles without error.

- [ ] **Step 7: Run the terminal NIF tests**

  ```bash
  cd /workspace/server-elixir && mix test test/fbi/terminal_test.exs
  ```
  Expected: all tests pass (NIF loads, `new/2`, `feed/2`, `snapshot/1`, `resize/3` all work).

- [ ] **Step 8: Run the full mix test suite**

  ```bash
  cd /workspace/server-elixir && mix test
  ```
  Expected: full suite passes.

- [ ] **Step 9: Commit**

  ```bash
  cd /workspace
  git add cli/fbi-term-core/Makefile server-elixir/mix.exs \
          server-elixir/lib/fbi/terminal.ex
  git rm -r server-elixir/native/fbi_term \
            cli/fbi-term-core/src/lib.rs cli/fbi-term-core/src/parser.rs \
            cli/fbi-term-core/src/modes.rs cli/fbi-term-core/src/checkpoint.rs \
            cli/fbi-term-core/src/serialize.rs cli/fbi-term-core/Cargo.toml \
            cli/fbi-term-core/tests 2>/dev/null || true
  git commit -m "feat(server): replace Rustler with elixir_make + Zig NIF; update FBI.Terminal load"
  ```

---

## Phase 5 — Client-Side Swap

### Task 11: ghostty-web in `Terminal.tsx`

**Files:**
- Modify: `package.json`
- Modify: `src/web/components/Terminal.tsx`
- Modify: `src/web/lib/scrollDetection.ts`

- [ ] **Step 1: Install ghostty-web and remove xterm packages**

  ```bash
  cd /workspace
  npm install ghostty-web
  npm uninstall @xterm/xterm @xterm/addon-serialize @xterm/headless
  ```

- [ ] **Step 2: Verify ghostty-web exports `init` and `Terminal`**

  ```bash
  node -e "const g = require('ghostty-web'); console.log(Object.keys(g))"
  ```
  Expected: output includes `"init"` and `"Terminal"`.

- [ ] **Step 3: Check ghostty-web's `Terminal` constructor options**

  ```bash
  node -e "
  const { init, Terminal } = require('ghostty-web');
  init().then(() => {
    const t = new Terminal({ cols: 80, rows: 24 });
    console.log('ok', Object.keys(t));
  }).catch(e => console.error(e));
  "
  ```
  Expected: prints `ok` followed by the Terminal's public method list. Note any option names that differ from xterm.js (e.g., `fontFamily`, `fontSize`, `theme`, `cursorBlink`, `scrollback`).

- [ ] **Step 4: Update `Terminal.tsx` — import and init**

  Read `src/web/components/Terminal.tsx`. Make these changes:

  a. Replace the import block:
  ```diff
  -import { Terminal as Xterm } from '@xterm/xterm';
  -import '@xterm/xterm/css/xterm.css';
  +import { Terminal as Xterm, init as initGhostty } from 'ghostty-web';
  ```

  b. Add a module-level init promise immediately after the imports (before the `readTheme` function):
  ```ts
  // Kick off WASM compilation before React mounts — ~400KB bundle.
  const ghosttyReady: Promise<void> = initGhostty();
  ```

  c. In the `useEffect` that creates the `Xterm` instance, make it async and await `ghosttyReady` before `new Xterm(...)`:
  ```ts
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let term: InstanceType<typeof Xterm> | null = null;
    // ... store other cleanup refs here ...

    void (async () => {
      await ghosttyReady;
      if (disposed) return;

      term = new Xterm({
        convertEol: true,
        fontFamily: '...',   // same options as before
        // ... rest of options unchanged ...
      });
      // ... rest of setup unchanged ...
    })();

    return () => {
      disposed = true;
      // cleanup: disconnect observers, remove listeners, dispose term if created
      term?.dispose();
    };
  }, [runId]);
  ```

  > The existing `useEffect` cleanup function uses `controller.dispose()` and `term.dispose()`. Since `term` is now created asynchronously, the cleanup must guard against `term` being null if the effect was cleaned up before `ghosttyReady` resolved.

- [ ] **Step 5: Update `Terminal.tsx` — remove `.xterm-viewport` query**

  The current code queries `.xterm-viewport` for the scroll listener:
  ```ts
  const viewportEl = host.querySelector('.xterm-viewport') as HTMLElement | null;
  if (viewportEl) viewportEl.setAttribute('data-testid', 'xterm-viewport');
  viewportEl?.addEventListener('scroll', onViewportScroll, { passive: true });
  ```

  ghostty-web uses Canvas — there is no `.xterm-viewport`. Replace with a direct listener on the host div's scrollable canvas container (ghostty-web places a `<canvas>` inside the host; the scroll happens on the host itself or a wrapper it creates). Use `host` directly:
  ```ts
  host.addEventListener('scroll', onViewportScroll, { passive: true });
  ```
  And the cleanup:
  ```ts
  host.removeEventListener('scroll', onViewportScroll);
  ```

- [ ] **Step 6: Update `Terminal.tsx` — expose `window.__fbiTerminalText`**

  After the terminal is created and opened, add:
  ```ts
  // Expose text extraction for Playwright E2E tests.
  // ghostty-web's buffer API provides row-by-row text access.
  (window as any).__fbiTerminalText = () => {
    if (!term) return '';
    const lines: string[] = [];
    const buf = term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n').trimEnd();
  };
  ```

  In the cleanup return function, add:
  ```ts
  delete (window as any).__fbiTerminalText;
  ```

  > **Note:** The ghostty-web buffer API (`term.buffer.active`, `getLine`, `translateToString`) mirrors xterm.js's IBufferLine API. Verify these method names exist on the ghostty-web `Terminal` instance using the output from Step 3. If the API differs, adapt accordingly.

- [ ] **Step 7: Update `scrollDetection.ts`**

  Read `src/web/lib/scrollDetection.ts`. It currently reads scroll state from xterm's internal viewport element. Adapt it to work with a generic scrollable element. The function signature and behaviour should remain the same — only the DOM element reference changes from `.xterm-viewport` to the host div.

  Find any code like:
  ```ts
  const viewport = term.element?.querySelector('.xterm-viewport');
  ```
  and replace with an approach that receives the scroll container as a parameter, or uses `term.element` (ghostty-web sets `term.element` to the `<canvas>` wrapper or host div — verify with the API check from Step 3).

- [ ] **Step 8: Update CSS — remove `.xterm` selectors**

  Search for xterm-specific CSS selectors:
  ```bash
  grep -r "\.xterm" /workspace/src/web --include="*.css" --include="*.ts" --include="*.tsx" -l
  ```
  For each file found, review whether the selector targets xterm's internal DOM. Remove selectors that no longer apply. Keep selectors that target `[data-testid="xterm"]` (the host div, unchanged) or general terminal layout.

- [ ] **Step 9: TypeScript check**

  ```bash
  cd /workspace && npm run typecheck 2>&1 | head -40
  ```
  Fix any type errors from the import change or the async useEffect refactor.

- [ ] **Step 10: Commit**

  ```bash
  cd /workspace
  git add package.json package-lock.json src/web/components/Terminal.tsx \
          src/web/lib/scrollDetection.ts
  git commit -m "feat(web): swap xterm.js for ghostty-web; WASM init, scroll listener, window text helper"
  ```

---

### Task 12: Update E2E helpers for ghostty-web Canvas

**Files:**
- Modify: `tests/e2e/quantico/helpers.ts`

- [ ] **Step 1: Identify all DOM-based terminal text accesses**

  ```bash
  grep -n "xterm\|textContent\|getByTestId.*xterm\|toContainText" \
    /workspace/tests/e2e/quantico/helpers.ts
  ```

- [ ] **Step 2: Update `terminalText()`**

  Read `tests/e2e/quantico/helpers.ts`. Replace the `terminalText` implementation:

  ```ts
  async terminalText() {
    return page.evaluate(() => (window as any).__fbiTerminalText?.() ?? '');
  },
  ```

- [ ] **Step 3: Update `terminalTextFrom(marker)`**

  The `terminalTextFrom` method calls `terminalText()` and slices from the marker. Its implementation calls `terminalText()` internally — verify it does and that it will automatically benefit from the updated `terminalText()`. If it has its own DOM access, update it too.

- [ ] **Step 4: Update `waitForTerminalText(needle)`**

  Replace the `expect(...).toContainText(needle)` approach with a polling function:

  ```ts
  async waitForTerminalText(needle, opts) {
    await page.waitForFunction(
      (n: string) => ((window as any).__fbiTerminalText?.() ?? '').includes(n),
      needle,
      { timeout: opts?.timeoutMs ?? 30_000 },
    );
  },
  ```

- [ ] **Step 5: Update `expectScrolledToBottom()`**

  Read the current implementation. If it uses `.xterm-viewport`, update it to use a ghostty-web-compatible approach (check scroll position on the host div, or use ghostty-web's `buffer.active.viewportY` if exposed).

- [ ] **Step 6: Verify unit tests pass**

  ```bash
  cd /workspace && npm test -- --run 2>&1 | tail -20
  ```
  Expected: no new failures.

- [ ] **Step 7: Commit**

  ```bash
  cd /workspace
  git add tests/e2e/quantico/helpers.ts
  git commit -m "test(e2e): update helpers.ts for ghostty-web canvas text extraction"
  ```

---

## Phase 6 — Cleanup

### Task 13: Delete diff harness, dead deps, update CI, update docs

**Files:**
- Delete: `cli/fbi-term-core/tests/diff_xterm.rs`, `tests/support/xterm_ref.mjs`, `tests/fixtures/`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/specs/2026-04-26-terminal-rust-rewrite-design.md`

- [ ] **Step 1: Delete the diff harness files**

  ```bash
  rm -f  /workspace/cli/fbi-term-core/tests/diff_xterm.rs \
         /workspace/cli/fbi-term-core/tests/support/xterm_ref.mjs
  rm -rf /workspace/cli/fbi-term-core/tests/fixtures
  ```
  (The `tests/` directory may now be empty — that is fine, or remove it if so.)

- [ ] **Step 2: Update CI — replace `cargo test -p fbi-term-core` with `zig build test`**

  Read `.github/workflows/ci.yml`. In the `rust` job, the test step currently runs:
  ```yaml
  - name: Test
    run: |
      cargo test -p fbi-tunnel
      cargo test -p quantico
      cargo test -p fbi-term-core
  ```

  Change to:
  ```yaml
  - name: Test
    run: |
      cargo test -p fbi-tunnel
      cargo test -p quantico
  ```

  Add a new `zig` job to the workflow:
  ```yaml
  zig:
    name: Zig (fbi-term-core unit tests)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Zig
        uses: mlugg/setup-zig@v1
        with:
          version: "0.14.0"   # must match devcontainer ARG ZIG_VERSION

      - name: Install Erlang/OTP (for erl_nif.h)
        uses: erlef/setup-beam@v1
        with:
          otp-version: '27.2'
          elixir-version: '1.18.1-otp-27'

      - name: Test
        run: |
          ERL_INCLUDE=$(erl -eval 'io:format("~s~n", [code:root_dir()])' -s init stop)/usr/include
          cd cli/fbi-term-core
          zig build test -Derl-include="$ERL_INCLUDE"
  ```

- [ ] **Step 3: Update `e2e-quantico` job in CI**

  The `e2e-quantico` job currently has `needs: rust` (to ensure the Quantico binary is buildable). Keep that dependency.

  The "Compile Elixir + Rust NIF" step description is now outdated. The step itself (`mix compile`) is unchanged but update the step `name`:
  ```yaml
  - name: Compile Elixir + Zig NIF
  ```

  Also add Zig installation to this job (needed because `mix compile` runs `zig build`):
  ```yaml
      - name: Install Zig
        uses: mlugg/setup-zig@v1
        with:
          version: "0.14.0"
  ```
  Add this step immediately before "Compile Elixir + Zig NIF".

- [ ] **Step 4: Update the `elixir` job in CI**

  The `elixir` job runs `mix compile` which now triggers `zig build`. Add Zig installation:
  ```yaml
      - name: Install Zig
        uses: mlugg/setup-zig@v1
        with:
          version: "0.14.0"
  ```
  Add this step before "Fetch deps".

- [ ] **Step 5: Mark the terminal-rust-rewrite spec as superseded**

  Read `docs/superpowers/specs/2026-04-26-terminal-rust-rewrite-design.md`. Update the front matter:
  ```diff
  -**Status:** approved (design)
  +**Status:** superseded
  +**Superseded by:** [2026-04-28-ghostty-web-migration-design.md](2026-04-28-ghostty-web-migration-design.md)
  ```

- [ ] **Step 6: Run the full test suite one final time**

  ```bash
  cd /workspace
  npm test -- --run 2>&1 | tail -20
  cd server-elixir && mix test 2>&1 | tail -20
  cd ../cli/fbi-term-core && zig build test 2>&1 | tail -10
  ```
  Expected: all pass.

- [ ] **Step 7: Commit**

  ```bash
  cd /workspace
  git rm -f cli/fbi-term-core/tests/diff_xterm.rs \
            cli/fbi-term-core/tests/support/xterm_ref.mjs 2>/dev/null || true
  git rm -rf cli/fbi-term-core/tests/fixtures 2>/dev/null || true
  git add .github/workflows/ci.yml \
          docs/superpowers/specs/2026-04-26-terminal-rust-rewrite-design.md
  git commit -m "chore: remove diff harness + dead deps; add Zig CI job; mark rust-rewrite spec superseded"
  ```
