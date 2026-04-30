# FBI — fbi-tunnel Rust Rewrite Design

**Date:** 2026-04-24
**Project:** FBI
**Status:** Approved for implementation planning
**Builds on:** [Port Tunnel v1 design](2026-04-22-port-tunnel-design.md), [Port Tunnel v1.1 design](2026-04-22-port-tunnel-v1.1-design.md)

## 1. Overview

`fbi-tunnel` is currently a Go CLI that forwards TCP from the operator's laptop into an FBI run's container via WebSocket tunnels. This spec rewrites it in Rust for consistency with the Tauri desktop app, and wires it into the desktop app as a managed Tauri sidecar that starts and stops automatically alongside running runs.

The CLI interface and behavior are unchanged. The Go source is deleted and replaced with an equivalent Rust crate.

### Goals

- Replace the Go implementation with Rust while preserving the exact CLI interface and runtime behavior.
- Bundle `fbi-tunnel` with the Tauri desktop app as a sidecar binary.
- Desktop app automatically starts a tunnel for each running run that has listening ports, and stops it when the run ends.
- Tunnel status surfaced in the system tray label (per run) and system notifications (on start).
- Standalone use (without the desktop app) continues to work identically.

### Non-goals

- Any change to the CLI interface or tunnel behavior.
- Windows support (matching the desktop app's existing scope).
- Exposing tunnel control to the frontend.
- Periodic re-discovery during a CLI session (still one-shot at startup for the standalone CLI; the desktop polls for the managed case).

## 2. Architecture

```
Cargo.toml (workspace)
  ├── desktop/          ← Tauri app; gains tunnel.rs + tauri-plugin-shell
  └── cli/fbi-tunnel/   ← Rust binary; replaces Go source
```

A Cargo workspace at the repo root unifies the two crates. `desktop/Cargo.toml` and `cli/fbi-tunnel/Cargo.toml` become workspace members with `resolver = "2"`.

### Standalone flow (unchanged from v1)

```
operator$ fbi-tunnel http://fbi.tailnet:3000 42
  → GET /api/runs/42/listening-ports
  → bind local listeners
  → print table
  → per-connection: dial ws://…/api/runs/42/proxy/{port}, pipe bytes
```

### Desktop-managed flow (new)

```
run state changes → update_tray_runs() [frontend invoke]
  → tunnel::reconcile(app, server_url, running_run_ids)
      for each new running run:
        spawn poll task → GET .../listening-ports every 2 s
        when ports found:
          spawn fbi-tunnel sidecar (tauri-plugin-shell)
          fire notification
          update tray label
      for each run no longer running:
        kill sidecar child
        (silent if was still polling)
```

## 3. `cli/fbi-tunnel` — Rust binary

### 3.1 Crate layout

```
cli/fbi-tunnel/
  Cargo.toml
  src/
    main.rs        ← arg parsing, run loop, signal handling
    discovery.rs   ← GET /api/runs/:id/listening-ports
    listener.rs    ← bind local TCP listeners
    forwarder.rs   ← WS dial + bidirectional byte pipe
    mapping.rs     ← merge discovered ports with -L overrides
```

The Go files (`*.go`, `go.mod`, `go.sum`) are deleted. The `Makefile` and `scripts/build-dist.sh` are replaced with equivalents that drive `cargo build --target`.

### 3.2 Dependencies (`cli/fbi-tunnel/Cargo.toml`)

| Crate | Purpose |
|---|---|
| `tokio` (full) | Async runtime |
| `reqwest` (rustls-tls, json) | HTTP port discovery |
| `tokio-tungstenite` (rustls-tls-native-roots) | WebSocket client |
| `serde` + `serde_json` | JSON deserialization |

No `clap` — arg parsing is simple enough to do manually, keeping deps minimal and cross-compilation fast.

### 3.3 CLI interface (identical to Go version)

```
fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...
```

Behavior:
1. `GET <fbi-url>/api/runs/<id>/listening-ports` — discover ports; exit 2 on 404/409.
2. Merge with `-L` overrides (override wins by remote port).
3. Bind local TCP listeners; fall back to random port if preferred is busy.
4. Print mapping table to stdout; go quiet.
5. Per inbound connection: dial WS, pipe bytes, close on WS close or EOF.
6. On WS close code `1001` (run ended): print `run <id> ended`, close listeners, exit 0.
7. On SIGINT/SIGTERM: close listeners, drain, exit 0.

### 3.4 Cross-compilation targets

Same four targets as the Go version:

| OS | Arch | Rust target triple |
|---|---|---|
| macOS | arm64 | `aarch64-apple-darwin` |
| macOS | amd64 | `x86_64-apple-darwin` |
| Linux | amd64 | `x86_64-unknown-linux-gnu` |
| Linux | arm64 | `aarch64-unknown-linux-gnu` |

The `Makefile` `build` target cross-compiles all four via `cargo build --release --target`. The `build-dist.sh` script is updated similarly (or removed in favour of the Makefile).

## 4. Desktop integration

### 4.1 New `tunnel.rs` module

Manages a `tokio::sync::Mutex<TunnelState>` stored as a `tauri::State`:

```rust
struct TunnelState {
    tunnels: HashMap<u32, TunnelEntry>,
    last_runs: Vec<TrayRunInfo>,   // last run list from update_tray_runs
}

enum TunnelEntry {
    Polling,                                    // discovery task running, no ports yet
    Active(tauri_plugin_shell::process::Child, Vec<u16>),  // sidecar running with known ports
}
```

`last_runs` lets background poll tasks rebuild the tray with current run info + fresh tunnel state without needing another `invoke` from the frontend.

**`reconcile(app, server_url, runs)`** — called after each `update_tray_runs` with the full run list:

- Updates `last_runs` in the shared state.
- **New running run, no entry**: insert `Polling`, spawn a background tokio task that GETs `/api/runs/{id}/listening-ports` every 2 s. When ≥1 port is returned:
  - Spawn the sidecar via `tauri_plugin_shell::process::Command::new_sidecar("fbi-tunnel")` with args `[server_url, run_id.to_string()]`.
  - Transition entry to `Active(child, ports)`.
  - Fire notification: `"Tunnel active — run #N: localhost:5173, localhost:9229"`.
  - Rebuild tray using `last_runs` + current tunnel state.
- **Run absent from active list, entry exists**: kill the child (if `Active`), remove entry. Fire no notification if it was `Polling`; silent stop if `Active` (the existing run-ended notification covers it).

### 4.2 `tray.rs` changes

`build_runs_menu` receives tunnel state alongside run info. For runs with an `Active` tunnel, append `· ↔ N ports` to the menu label:

```
Title  ·  running  ·  ↔ 2 ports
Title  ·  running                   ← still polling
Title  ·  waiting
```

`update_tray_runs` calls `tunnel::reconcile` after rebuilding the menu.

### 4.3 Tauri configuration

**`desktop/Cargo.toml`** — add:
```toml
tauri-plugin-shell = "2"
```

**`desktop/tauri.conf.json`** — add under `bundle`:
```json
"externalBin": ["../cli/fbi-tunnel/target/release/fbi-tunnel"]
```

Tauri renames the binary to `fbi-tunnel-{target-triple}` during bundling and places it alongside the main executable.

**`desktop/capabilities/default.json`** — the shell plugin's `shell:allow-execute` and `shell:allow-open` capabilities are **not** added to the frontend capability set. The plugin is used exclusively from Rust backend code; no frontend permission is required or granted.

### 4.4 `main.rs` changes

Register the shell plugin and wire in `tunnel`:

```rust
.plugin(tauri_plugin_shell::init())
```

On app setup, initialise the shared tunnel state as a `tauri::State`.

## 5. Data flow: desktop-managed tunnel lifecycle

1. Run goes `running` → frontend WS message → `publishCountsFromMap` → `invoke('update_tray_runs', { runs })`.
2. Rust `update_tray_runs` receives the updated run list, rebuilds tray, calls `tunnel::reconcile`.
3. `reconcile` sees run N as newly running, inserts `Polling`, spawns discovery poll task.
4. Poll task finds `[{port: 5173}]` → spawns `fbi-tunnel http://fbi.tailnet:3000 42` sidecar.
5. Tray label for run 42 updates to `"Title · running · ↔ 1 port"`.
6. Notification fires: `"Tunnel active — run #42: localhost:5173"`.
7. Run ends → next `update_tray_runs` call → `reconcile` kills the child process.
8. Existing run-ended notification fires (no second tunnel notification).

## 6. Error handling

| Condition | Behavior |
|---|---|
| Port discovery returns 404/409 (CLI) | Print server error, exit 2 |
| Port discovery fails in desktop poll | Retry next 2 s tick; stop retrying when run leaves active list |
| Sidecar spawn fails | Log error, remove entry; no notification |
| Sidecar exits unexpectedly | Entry becomes stale; next `reconcile` removes it (child already dead) |
| Local port busy (CLI) | Fall back to random free port; note in table |
| WS close 1001 (run ended) | CLI exits 0; desktop reconcile kills all entries for that run |

## 7. Build & distribution

### Workspace

```toml
# Cargo.toml (repo root)
[workspace]
members = ["desktop", "cli/fbi-tunnel"]
resolver = "2"
```

### Standalone binary

`make build` in `cli/fbi-tunnel/` cross-compiles to `dist/` for all four targets. `make install` builds for the host and copies to `~/.local/bin/fbi-tunnel`.

### Bundled with desktop

When `tauri build` runs, the `externalBin` entry causes Tauri to include the pre-built `fbi-tunnel` binary in the app bundle. CI must build `fbi-tunnel` for the target platform before running `tauri build`.

### Go toolchain removal

`cli/fbi-tunnel/go.mod`, `go.sum`, and all `*.go` files are deleted. The `scripts/build-dist.sh` Docker-based Go builder is removed or replaced with a Rust equivalent.

## 8. Testing strategy

### `cli/fbi-tunnel` unit tests

- Arg parsing: well-formed, malformed, missing values, unknown flags.
- `-L` override parsing: valid `local:remote`, invalid ports, malformed strings.
- Mapping merge: discovered ∪ overrides, override-wins-by-remote, empty discovered set.
- Port table rendering: normal case, port-collision note.

### `cli/fbi-tunnel` integration test

In-process stub HTTP + WS server (using `axum` or `warp` in test only) that:
- Serves `/api/runs/1/listening-ports` with a fixed payload.
- Accepts WS upgrades on `/api/runs/1/proxy/5173`, echoing bytes.

Test exercises the full discovery → listen → pipe → close cycle.

### Desktop `tunnel.rs` unit tests

- `reconcile` inserts `Polling` for new running runs.
- `reconcile` removes entries for runs no longer in the active list.
- Transition from `Polling` to `Active` on port discovery.
- No double-spawn if `reconcile` fires twice for the same run.
