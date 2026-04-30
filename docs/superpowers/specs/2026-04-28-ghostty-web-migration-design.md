# ghostty-web Migration — design

**Date:** 2026-04-28
**Project:** FBI
**Status:** approved (design)
**Supersedes:** [2026-04-26-terminal-rust-rewrite-design.md](2026-04-26-terminal-rust-rewrite-design.md) (server-side and client-side terminal layers only; all other decisions from that spec are preserved)

## 1. Overview

The terminal Rust rewrite (April 2026) established the correct architecture: a server-side cell-accurate terminal emulator owned by `RunServer`, exposing ANSI snapshots over WebSocket to a browser-side renderer. That architecture is kept intact.

This migration replaces the two implementation details that were left as best-available choices at the time:

- **Server-side parser:** `alacritty_terminal` (Rust) → `libghostty-vt` (Zig)
- **Client-side renderer:** `@xterm/xterm` (JS) → `ghostty-web` (WASM)

Both sides now run the same underlying terminal implementation — libghostty, the parser that powers the native Ghostty desktop app. Parser divergence between snapshot producer and snapshot consumer becomes structurally impossible rather than harness-tested. The diff harness (`diff_xterm.rs` vs `@xterm/headless`) is deleted as a consequence.

The two Rust crates (`cli/fbi-term-core/` and `server-elixir/native/fbi_term/`) are replaced by a single flat Zig package. The Rustler dependency is removed. Everything above `FBI.Terminal` in the Elixir stack — `RunServer`, the WS handler, the HTTP transcript API, the wire protocol — is unchanged.

### Goals

- Eliminate the parser-divergence class of bugs by using libghostty on both sides.
- Remove the two-crate Rust structure and Rustler dependency; replace with one Zig package.
- Drop-in swap of `@xterm/xterm` for `ghostty-web` on the client with minimal changes to `Terminal.tsx`.
- Delete the `@xterm/headless` diff harness; keep the Quantico E2E suite as the correctness gate.

### Non-goals

- Any changes to the WebSocket protocol, `RunServer`, viewer registry, focus/resize policy, or HTTP transcript API — all preserved from the Rust rewrite spec.
- Ghostty rendering features (ligatures, GPU acceleration, image protocols) — ghostty-web's Canvas renderer is a correctness improvement, not a visual redesign.
- Supporting the Ghostty desktop app embedding the server in-process — deferred as before.

## 2. Architecture

```
BEFORE
  @xterm/xterm (Canvas/DOM)  ←── WebSocket ──→  fbi-term-core (Rust + alacritty_terminal)
                                                       ↑ Rustler NIF
                                               server-elixir/native/fbi_term/ (Rust cdylib)
                                                       ↑
                                                 FBI.Terminal (Elixir)

AFTER
  ghostty-web (Canvas/WASM)  ←── WebSocket ──→  fbi-term-core (Zig + libghostty-vt)
                                                       ↑ manual Zig NIF
                                                 FBI.Terminal (Elixir — API unchanged)
```

`FBI.Terminal`'s `@spec` signatures are preserved exactly. `RunServer`, the WS handler, the HTTP transcript Range API, and the wire protocol frames are all untouched.

## 3. Zig package (`cli/fbi-term-core/`)

The two existing Rust crates collapse into one flat Zig package. The NIF glue lives alongside the core logic rather than in a separate crate.

### Layout

```
cli/fbi-term-core/
  build.zig              compile to fbi_term.so → server-elixir/priv/native/
  build.zig.zon          pins ghostty at a specific commit hash
  src/
    root.zig             public API: Parser, Snapshot, ModePrefix types
    parser.zig           libghostty-vt Terminal wrapper (feed, snapshot, resize)
    modes.zig            byte-offset checkpoint store
    serialize.zig        grid + modes → ANSI replay
    nif.zig              Erlang NIF function exports
    resource.zig         ResourceObject for parser handle lifetime
  test/
    parser_test.zig      unit tests (zig build test)
```

### libghostty-vt dependency

`build.zig.zon` declares a dependency on `github.com/ghostty-org/ghostty` at a pinned commit hash. `build.zig` imports it via `b.dependency("ghostty", .{})` and adds the `libghostty-vt` module to the lib compile step. Only the VT parser module is imported — no renderer, no windowing, no platform UI.

### Public API (unchanged contracts from Rust rewrite)

```zig
pub const Snapshot = struct {
    ansi: []const u8,     // modes + grid + final CUP
    cols: u16,
    rows: u16,
    byte_offset: u64,
};

pub const ModePrefix = struct {
    ansi: []const u8,     // modes-only ANSI (no cell content)
};

pub const Parser = struct {
    pub fn init(allocator: Allocator, cols: u16, rows: u16) !Parser;
    pub fn deinit(self: *Parser) void;
    pub fn feed(self: *Parser, bytes: []const u8) !void;
    pub fn snapshot(self: *const Parser) !Snapshot;
    pub fn snapshotAt(self: *const Parser, byte_offset: u64) !ModePrefix;
    pub fn resize(self: *Parser, cols: u16, rows: u16) !void;
};
```

Mode-state checkpointing (every 256 KB, `snapshot_at` replay) and ANSI serialization logic are ported directly from the Rust implementation.

## 4. Erlang NIF in Zig

### Resource lifetime (`resource.zig`)

`enif_open_resource_type` registers a `ParserResource` type on NIF load with a destructor that calls `parser.deinit()`. Each `new/2` call allocates one via `enif_alloc_resource`, wraps it in `enif_make_resource`, and returns the opaque reference Elixir holds as a `handle()`. BEAM GC calls the destructor when `RunServer` terminates and the last reference drops — identical lifetime semantics to the previous `ResourceArc<Mutex<Parser>>`.

### Exported functions (`nif.zig`)

| NIF | Scheduler | Notes |
|-----|-----------|-------|
| `new/2` | clean | allocates resource, initialises Parser |
| `feed/2` | dirty I/O (`ERL_NIF_DIRTY_JOB_IO_BOUND`) | equivalent to Rustler `schedule: "DirtyIo"` |
| `snapshot/1` | clean | returns `%{ansi: binary, cols: int, rows: int, byte_offset: int}` |
| `snapshot_at/2` | clean | returns `%{ansi: binary}` |
| `resize/3` | clean | |

### Panic boundary

Every NIF entry point wraps its body in Zig error handling (`catch`). Any error returns `{:error, :nif_panic}`; `RunServer` treats this as a fatal run failure and increments the `fbi_term.nif_panic` telemetry counter. The BEAM survives.

### `FBI.Terminal` Elixir module

`use Rustler, otp_app: :fbi, crate: "fbi_term"` is replaced with:

```elixir
@on_load :load_nif
def load_nif do
  :erlang.load_nif(Application.app_dir(:fbi, "priv/native/fbi_term"), 0)
end
```

All function stubs (`def new(_cols, _rows), do: :erlang.nif_error(:nif_not_loaded)` etc.) and `@spec` signatures are preserved unchanged.

## 5. Build system changes

### `server-elixir/mix.exs`

- Remove `{:rustler, "~> 0.34"}` from `deps`
- Remove `rustler_crates: rustler_crates()` from `project`
- Remove the `rustler_crates/0` private function
- Add `{:elixir_make, "~> 0.7"}` to `deps`
- Add `compilers: [:elixir_make | Mix.compilers()]` to `project`
- Configure elixir_make to invoke `make` in `cli/fbi-term-core/` (exact config keys — `make_cwd`, `make_targets`, `make_env` — should be verified against the installed elixir_make version during implementation)

The Makefile in `cli/fbi-term-core/` (a thin shim) runs `zig build -Doptimize=ReleaseSafe` in prod and `zig build` otherwise, then copies the output to `server-elixir/priv/native/fbi_term.so`.

### `Cargo.toml` (workspace root)

Remove `cli/fbi-term-core` and `server-elixir/native/fbi_term` from `members`. The remaining workspace members (`cli/fbi-tunnel`, `cli/quantico`, `desktop`) are unaffected.

### CI

Replace `cargo test -p fbi-term-core` with `zig build test --build-file cli/fbi-term-core/build.zig` in `.github/workflows/ci.yml`.

## 6. Client-side swap

### npm changes

```diff
- "@xterm/addon-serialize": "^0.13.0",
- "@xterm/headless": "^5.5.0",
- "@xterm/xterm": "^5.5.0",
+ "ghostty-web": "<pinned version>",
```

`@xterm/addon-fit` and `@xterm/addon-web-links` are kept — ghostty-web supports xterm.js-compatible addons via `loadAddon()` and both work as-is.

### `src/web/components/Terminal.tsx`

**Import swap:**
```diff
- import { Terminal as Xterm } from '@xterm/xterm';
- import '@xterm/xterm/css/xterm.css';
+ import { Terminal as Xterm, init as initGhostty } from 'ghostty-web';
```

**One-time WASM init:** A module-level promise fires before React mounts:
```ts
const ghosttyReady = initGhostty(); // loads + compiles ~400KB WASM bundle
```
The `useEffect` that creates the `Xterm` instance `await`s `ghosttyReady` before calling `new Xterm(...)`.

**Scroll listener:** The `.xterm-viewport` DOM query is removed. ghostty-web renders to `<canvas>` — there is no xterm viewport element. The scroll listener is wired to the host div directly; `detectScroll` is updated to read scroll position from the ghostty-web buffer API (exact method — e.g. `getViewport()` — to be verified against ghostty-web docs during implementation) instead of the xterm viewport element.

**Text extraction for E2E tests:** `Terminal.tsx` sets `window.__fbiTerminalText` to a function that extracts text from the ghostty-web buffer API (`getLine`, `getViewport`) when the controller mounts, and clears it on unmount.

**CSS:** `.xterm`-class selectors in terminal-specific CSS are removed. The host div sizing (`h-full w-full`, `overflow: auto`) is unaffected — ghostty-web renders a `<canvas>` inside whatever container it's given.

**Everything else in `Terminal.tsx` is unchanged** — `term.open(host)`, `fit.fit()`, `term.write()`, `term.onData()`, `term.onResize()`, the `TerminalTakeoverBanner`, the trace overlay, and the pause/resume UI all use the same API surface.

### `tests/e2e/quantico/helpers.ts`

Replace the xterm DOM text extraction:
```diff
- async terminalText() {
-   return (await page.getByTestId('xterm').textContent()) ?? '';
- },
+ async terminalText() {
+   return page.evaluate(() => (window as any).__fbiTerminalText?.() ?? '');
+ },
```
`waitForTerminalText` is updated to poll via `page.waitForFunction(() => (window as any).__fbiTerminalText?.().includes(needle))` instead of `toContainText` on the xterm testid. All scenario-level specs (`terminal-truecolor.spec.ts` etc.) are otherwise unchanged.

## 7. Deletion list

| Path | Reason |
|------|--------|
| `cli/fbi-term-core/src/*.rs` | replaced by Zig |
| `cli/fbi-term-core/Cargo.toml` | replaced by `build.zig` / `build.zig.zon` |
| `cli/fbi-term-core/tests/diff_xterm.rs` | harness deleted |
| `cli/fbi-term-core/tests/support/xterm_ref.mjs` | harness deleted |
| `cli/fbi-term-core/tests/fixtures/` | harness deleted |
| `server-elixir/native/fbi_term/` | replaced by `nif.zig` / `resource.zig` |
| `@xterm/addon-serialize` (npm) | only used by diff harness |
| `@xterm/headless` (npm) | only used by diff harness |
| `@xterm/xterm` (npm) | replaced by `ghostty-web` |

## 8. Devcontainer changes

### `.devcontainer/Dockerfile`

Zig is installed via asdf (already present in the image) alongside Erlang/Elixir:

```dockerfile
ARG ZIG_VERSION=<version required by pinned ghostty commit — verify in build.zig.zon>

RUN $ASDF_DIR/bin/asdf plugin add zig \
 && $ASDF_DIR/bin/asdf install zig ${ZIG_VERSION} \
 && $ASDF_DIR/bin/asdf global  zig ${ZIG_VERSION}

ENV ASDF_ZIG_VERSION=${ZIG_VERSION}
```

The Rust toolchain (`ghcr.io/devcontainers/features/rust:1` in `devcontainer.json`) is kept — `cli/fbi-tunnel` and `cli/quantico` remain Rust crates.

### `.devcontainer/devcontainer.json`

Add the official Zig VS Code extension:

```diff
+ "ziglang.vscode-zig",
```

`rust-lang.rust-analyzer` stays (still needed for the remaining Rust crates).

## 9. Error handling

- **NIF errors:** Zig `catch` at each NIF boundary → `{:error, :nif_panic}` → `RunServer` marks run failed, telemetry counter increments, BEAM survives.
- **Malformed PTY bytes:** absorbed by libghostty (same guarantee as alacritty_terminal, verified by `garbled` Quantico scenario).
- **Container resize fails:** logged at `:warn`; grid resized regardless (unchanged from Rust rewrite).
- **WASM init failure (client):** `ghosttyReady` promise rejection surfaces as an unhandled rejection; terminal mount aborts and shows "Loading terminal…" indefinitely. Acceptable for pre-alpha — the WASM bundle loading from a local asset should not fail in practice.

## 10. Testing strategy

| Gate | Command | What it validates |
|------|---------|-------------------|
| Zig unit tests | `zig build test` in `cli/fbi-term-core/` | Parser round-trips, checkpoint replay, snapshot serialization |
| Elixir tests | `mix test` | NIF load smoke test, RunServer viewer/focus state machine (unchanged) |
| Playwright Quantico suite | `npx playwright test tests/e2e/quantico/` | Terminal correctness, snapshot-reload equality, chunk loads, takeover banner |

The Quantico E2E suite is the primary correctness gate — same role as before, same scenarios, helpers updated for Canvas text extraction.

## 11. Migration sequence (single PR)

One PR, commits for reviewability:

1. `chore(devcontainer): add Zig via asdf; add ziglang.vscode-zig extension`
2. `chore(cargo): remove fbi-term-core and fbi_term from workspace`
3. `feat(fbi-term): Zig package skeleton — build.zig, build.zig.zon, root.zig stubs`
4. `feat(fbi-term): port parser, modes, checkpoint, serialize to Zig with libghostty-vt`
5. `test(fbi-term): Zig unit tests for parser round-trips and checkpoint replay`
6. `feat(fbi-term): Erlang NIF in Zig — nif.zig, resource.zig`
7. `feat(server): replace Rustler with elixir_make + Zig NIF; update FBI.Terminal load`
8. `feat(web): swap xterm.js for ghostty-web; WASM init, scroll listener, CSS`
9. `test(e2e): update helpers.ts for ghostty-web canvas text extraction`
10. `chore: remove @xterm/addon-serialize, @xterm/headless, diff harness`
11. `docs: supersede terminal-rust-rewrite-design with ghostty-web-migration-design`

Each commit compiles and passes its own tests. Behavior cutover is at commit 7 (server) and commit 8 (client). CI gates: `zig build test` (added at commit 5), `mix test` (passes throughout), Playwright suite (passes from commit 9 onward).
