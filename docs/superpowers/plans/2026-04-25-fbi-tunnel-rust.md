# fbi-tunnel Rust Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Go `fbi-tunnel` CLI with an equivalent Rust binary, bundle it with the Tauri desktop app as a managed sidecar, and have the desktop automatically start/stop tunnels for running runs.

**Architecture:** A root Cargo workspace ties `desktop/` and `cli/fbi-tunnel/` together. The CLI is a standalone async Rust binary (tokio + reqwest + tokio-tungstenite) with the same interface as the Go version. The desktop gains a `tunnel.rs` module that manages one `fbi-tunnel` sidecar process per running run via `tauri-plugin-shell`, polling for listening ports and spawning/killing the child as run state changes.

**Tech Stack:** Rust, tokio 1 (full), reqwest 0.12 (rustls-tls), tokio-tungstenite 0.21, futures-util 0.3, serde/serde_json, tauri-plugin-shell 2, axum 0.8 (dev-dep for integration tests).

---

## File Map

**Created:**
- `Cargo.toml` — root workspace
- `cli/fbi-tunnel/Cargo.toml`
- `cli/fbi-tunnel/src/main.rs`
- `cli/fbi-tunnel/src/args.rs`
- `cli/fbi-tunnel/src/mapping.rs`
- `cli/fbi-tunnel/src/discovery.rs`
- `cli/fbi-tunnel/src/listener.rs`
- `cli/fbi-tunnel/src/forwarder.rs`
- `cli/fbi-tunnel/src/tests/integration.rs`
- `desktop/binaries/.gitkeep`
- `scripts/build-fbi-tunnel.sh`

**Modified:**
- `desktop/Cargo.toml` — add tauri-plugin-shell
- `desktop/src/main.rs` — register plugin + tunnel state
- `desktop/src/tray.rs` — tunnel-aware menu labels + expose rebuild_tray
- `desktop/src/tunnel.rs` — new module
- `desktop/tauri.conf.json` — externalBin
- `desktop/capabilities/default.json` — no shell frontend perms (intentionally)
- `cli/fbi-tunnel/Makefile` — replace Go build with cargo build

**Deleted:**
- `cli/fbi-tunnel/*.go`
- `cli/fbi-tunnel/go.mod`
- `cli/fbi-tunnel/go.sum`
- `cli/fbi-tunnel/scripts/build-dist.sh`

---

## Task 1: Root Cargo workspace

**Files:**
- Create: `Cargo.toml`

- [ ] **Step 1: Create root workspace Cargo.toml**

```toml
[workspace]
members = ["desktop", "cli/fbi-tunnel"]
resolver = "2"
```

- [ ] **Step 2: Verify workspace parses**

```bash
cd /workspace && cargo metadata --no-deps --format-version 1 | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['name'] for m in d['packages']])"
```

Expected: `['fbi-desktop', 'fbi-tunnel']` (order may vary)

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml && git commit -m "chore: add root Cargo workspace"
```

---

## Task 2: `cli/fbi-tunnel` crate skeleton

**Files:**
- Create: `cli/fbi-tunnel/Cargo.toml`
- Create: `cli/fbi-tunnel/src/main.rs`

- [ ] **Step 1: Write `cli/fbi-tunnel/Cargo.toml`**

```toml
[package]
name = "fbi-tunnel"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "fbi-tunnel"
path = "src/main.rs"

[dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
tokio-tungstenite = { version = "0.21", features = ["rustls-tls-native-roots"] }
futures-util = { version = "0.3", default-features = false, features = ["sink"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
axum = { version = "0.8", features = ["ws"] }
```

- [ ] **Step 2: Write stub `cli/fbi-tunnel/src/main.rs`**

```rust
fn main() {
    println!("fbi-tunnel");
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /workspace && cargo build -p fbi-tunnel 2>&1 | tail -5
```

Expected: `Finished` line with no errors (many dependencies will download).

- [ ] **Step 4: Commit**

```bash
git add cli/fbi-tunnel/Cargo.toml cli/fbi-tunnel/src/main.rs && git commit -m "feat(tunnel): add Rust crate skeleton"
```

---

## Task 3: `mapping.rs` — port merge logic (TDD)

**Files:**
- Create: `cli/fbi-tunnel/src/mapping.rs`

- [ ] **Step 1: Write `mapping.rs` with types and failing tests**

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct Override {
    pub local: u16,
    pub remote: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mapping {
    pub local: u16,
    pub remote: u16,
}

pub fn merge_mappings(discovered: &[u16], overrides: &[Override]) -> Vec<Mapping> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovered_with_no_overrides() {
        let result = merge_mappings(&[5173, 9229], &[]);
        let mut ports: Vec<u16> = result.iter().map(|m| m.remote).collect();
        ports.sort();
        assert_eq!(ports, vec![5173, 9229]);
        // local == remote when no override
        for m in &result {
            assert_eq!(m.local, m.remote);
        }
    }

    #[test]
    fn override_replaces_local_for_matching_remote() {
        let result = merge_mappings(&[5173], &[Override { local: 8080, remote: 5173 }]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].remote, 5173);
        assert_eq!(result[0].local, 8080);
    }

    #[test]
    fn override_adds_mapping_not_in_discovered() {
        let result = merge_mappings(&[], &[Override { local: 3000, remote: 5173 }]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], Mapping { local: 3000, remote: 5173 });
    }

    #[test]
    fn empty_both() {
        assert_eq!(merge_mappings(&[], &[]), vec![]);
    }

    #[test]
    fn override_wins_over_same_remote() {
        let result = merge_mappings(
            &[5173],
            &[Override { local: 8080, remote: 5173 }],
        );
        assert_eq!(result[0].local, 8080);
    }
}
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd /workspace && cargo test -p fbi-tunnel mapping 2>&1 | tail -10
```

Expected: compile error or `FAILED` (todo! panics).

- [ ] **Step 3: Implement `merge_mappings`**

Replace the `todo!()` body:

```rust
pub fn merge_mappings(discovered: &[u16], overrides: &[Override]) -> Vec<Mapping> {
    use std::collections::HashMap;
    let mut by_remote: HashMap<u16, u16> = discovered.iter().map(|&p| (p, p)).collect();
    for o in overrides {
        by_remote.insert(o.remote, o.local);
    }
    let mut out: Vec<Mapping> = by_remote
        .into_iter()
        .map(|(remote, local)| Mapping { local, remote })
        .collect();
    out.sort_by_key(|m| m.remote);
    out
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /workspace && cargo test -p fbi-tunnel mapping 2>&1 | tail -5
```

Expected: `test result: ok. 5 passed`

- [ ] **Step 5: Add `mapping` module to `main.rs`**

Replace `cli/fbi-tunnel/src/main.rs` with:

```rust
mod mapping;

fn main() {
    println!("fbi-tunnel");
}
```

- [ ] **Step 6: Commit**

```bash
git add cli/fbi-tunnel/src/mapping.rs cli/fbi-tunnel/src/main.rs && git commit -m "feat(tunnel): add mapping merge logic with tests"
```

---

## Task 4: `args.rs` — CLI argument parsing (TDD)

**Files:**
- Create: `cli/fbi-tunnel/src/args.rs`

- [ ] **Step 1: Write `args.rs`**

```rust
use crate::mapping::Override;

#[derive(Debug)]
pub struct Args {
    pub fbi_url: String,
    pub run_id: u32,
    pub overrides: Vec<Override>,
}

pub fn parse_args(argv: &[String]) -> Result<Args, String> {
    if argv.len() < 2 {
        return Err(
            "usage: fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...".into(),
        );
    }
    let fbi_url = argv[0].clone();
    let run_id: u32 = argv[1]
        .parse()
        .map_err(|_| format!("invalid run id {:?}", argv[1]))?;

    let mut overrides = Vec::new();
    let mut i = 2usize;
    while i < argv.len() {
        match argv[i].as_str() {
            "-L" => {
                i += 1;
                if i >= argv.len() {
                    return Err("-L requires a value".into());
                }
                overrides.push(parse_l_flag(&argv[i])?);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
        i += 1;
    }

    Ok(Args { fbi_url, run_id, overrides })
}

fn parse_l_flag(v: &str) -> Result<Override, String> {
    let parts: Vec<&str> = v.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!("-L must be localport:remoteport, got {v:?}"));
    }
    let local: u16 = parts[0]
        .parse()
        .map_err(|_| format!("invalid local port in {v:?}"))?;
    let remote: u16 = parts[1]
        .parse()
        .map_err(|_| format!("invalid remote port in {v:?}"))?;
    if local == 0 || remote == 0 {
        return Err(format!("port must be > 0 in {v:?}"));
    }
    Ok(Override { local, remote })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn minimal_args() {
        let a = parse_args(&argv(&["http://fbi:3000", "42"])).unwrap();
        assert_eq!(a.fbi_url, "http://fbi:3000");
        assert_eq!(a.run_id, 42);
        assert!(a.overrides.is_empty());
    }

    #[test]
    fn l_flag_parsed() {
        let a = parse_args(&argv(&["http://fbi:3000", "42", "-L", "8080:5173"])).unwrap();
        assert_eq!(a.overrides.len(), 1);
        assert_eq!(a.overrides[0].local, 8080);
        assert_eq!(a.overrides[0].remote, 5173);
    }

    #[test]
    fn multiple_l_flags() {
        let a = parse_args(&argv(&[
            "http://fbi:3000", "42",
            "-L", "8080:5173",
            "-L", "9230:9229",
        ])).unwrap();
        assert_eq!(a.overrides.len(), 2);
    }

    #[test]
    fn too_few_args_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000"])).is_err());
        assert!(parse_args(&argv(&[])).is_err());
    }

    #[test]
    fn invalid_run_id_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "abc"])).is_err());
    }

    #[test]
    fn l_without_value_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "42", "-L"])).is_err());
    }

    #[test]
    fn l_malformed_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "42", "-L", "notaport"])).is_err());
    }

    #[test]
    fn l_zero_port_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "42", "-L", "0:5173"])).is_err());
    }

    #[test]
    fn unknown_arg_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "42", "--foo"])).is_err());
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cd /workspace && cargo test -p fbi-tunnel args 2>&1 | tail -5
```

Expected: `test result: ok. 8 passed`

- [ ] **Step 3: Add `args` module to `main.rs`**

```rust
mod args;
mod mapping;

fn main() {
    println!("fbi-tunnel");
}
```

- [ ] **Step 4: Commit**

```bash
git add cli/fbi-tunnel/src/args.rs cli/fbi-tunnel/src/main.rs && git commit -m "feat(tunnel): add arg parsing with tests"
```

---

## Task 5: `discovery.rs` — HTTP port discovery (TDD)

**Files:**
- Create: `cli/fbi-tunnel/src/discovery.rs`

- [ ] **Step 1: Write `discovery.rs`**

```rust
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct DiscoveryResp {
    ports: Vec<PortEntry>,
}

#[derive(Deserialize)]
struct PortEntry {
    port: u16,
}

pub async fn discover_ports(base_url: &str, run_id: u32) -> Result<Vec<u16>, String> {
    let url = format!(
        "{}/api/runs/{}/listening-ports",
        base_url.trim_end_matches('/'),
        run_id
    );
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;

    let status = resp.status().as_u16();
    if status != 200 {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("server returned {status}: {}", body.trim()));
    }

    let data: DiscoveryResp = resp.json().await.map_err(|e| format!("parse response: {e}"))?;
    Ok(data.ports.into_iter().map(|p| p.port).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};

    async fn ports_handler() -> axum::Json<serde_json::Value> {
        axum::Json(serde_json::json!({
            "ports": [{"port": 5173, "proto": "tcp"}, {"port": 9229, "proto": "tcp"}]
        }))
    }

    async fn not_found_handler() -> impl axum::response::IntoResponse {
        (axum::http::StatusCode::NOT_FOUND, "run not found")
    }

    #[tokio::test]
    async fn returns_parsed_ports() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/api/runs/1/listening-ports", get(ports_handler));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let result = discover_ports(&format!("http://127.0.0.1:{port}"), 1)
            .await
            .unwrap();
        assert_eq!(result, vec![5173, 9229]);
    }

    #[tokio::test]
    async fn non_200_is_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new()
            .route("/api/runs/99/listening-ports", get(not_found_handler));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let err = discover_ports(&format!("http://127.0.0.1:{port}"), 99)
            .await
            .unwrap_err();
        assert!(err.contains("404"), "expected 404 in error, got: {err}");
    }

    #[tokio::test]
    async fn trailing_slash_in_base_url_is_handled() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/api/runs/1/listening-ports", get(ports_handler));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        // trailing slash in base url should still work
        let result = discover_ports(&format!("http://127.0.0.1:{port}/"), 1)
            .await
            .unwrap();
        assert_eq!(result, vec![5173, 9229]);
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cd /workspace && cargo test -p fbi-tunnel discovery 2>&1 | tail -8
```

Expected: `test result: ok. 3 passed`

- [ ] **Step 3: Add `discovery` module to `main.rs`**

```rust
mod args;
mod discovery;
mod mapping;

fn main() {
    println!("fbi-tunnel");
}
```

- [ ] **Step 4: Commit**

```bash
git add cli/fbi-tunnel/src/discovery.rs cli/fbi-tunnel/src/main.rs && git commit -m "feat(tunnel): add port discovery with tests"
```

---

## Task 6: `listener.rs` — TCP binding

**Files:**
- Create: `cli/fbi-tunnel/src/listener.rs`

- [ ] **Step 1: Write `listener.rs`**

```rust
use tokio::net::TcpListener;

pub async fn bind_local(preferred: u16) -> Result<(TcpListener, u16), std::io::Error> {
    if preferred > 0 {
        if let Ok(l) = TcpListener::bind(format!("127.0.0.1:{preferred}")).await {
            let port = l.local_addr()?.port();
            return Ok((l, port));
        }
    }
    let l = TcpListener::bind("127.0.0.1:0").await?;
    let port = l.local_addr()?.port();
    Ok((l, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn binds_preferred_port() {
        // bind port 0 first to get a free port number, then release and re-bind it via bind_local
        let l0 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let free_port = l0.local_addr().unwrap().port();
        drop(l0);

        let (l, port) = bind_local(free_port).await.unwrap();
        assert_eq!(port, free_port);
        drop(l);
    }

    #[tokio::test]
    async fn falls_back_to_random_when_preferred_is_busy() {
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let busy_port = occupied.local_addr().unwrap().port();

        // occupied is still open, so bind_local should fall back
        let (l, port) = bind_local(busy_port).await.unwrap();
        assert_ne!(port, busy_port);
        assert!(port > 0);
        drop(l);
        drop(occupied);
    }

    #[tokio::test]
    async fn zero_preferred_always_picks_random() {
        let (l, port) = bind_local(0).await.unwrap();
        assert!(port > 0);
        drop(l);
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cd /workspace && cargo test -p fbi-tunnel listener 2>&1 | tail -5
```

Expected: `test result: ok. 3 passed`

- [ ] **Step 3: Add `listener` module to `main.rs`**

```rust
mod args;
mod discovery;
mod listener;
mod mapping;

fn main() {
    println!("fbi-tunnel");
}
```

- [ ] **Step 4: Commit**

```bash
git add cli/fbi-tunnel/src/listener.rs cli/fbi-tunnel/src/main.rs && git commit -m "feat(tunnel): add TCP listener with tests"
```

---

## Task 7: `forwarder.rs` — WebSocket byte pipe

**Files:**
- Create: `cli/fbi-tunnel/src/forwarder.rs`

- [ ] **Step 1: Write `forwarder.rs`**

```rust
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        protocol::frame::coding::CloseCode,
        Message,
    },
};

pub const ERR_RUN_ENDED: &str = "run ended";

fn ws_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("http://") {
        Ok(format!("ws://{rest}"))
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        Ok(format!("wss://{rest}"))
    } else if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        Ok(trimmed.to_string())
    } else {
        Err(format!("unsupported scheme in {base_url:?}"))
    }
}

pub async fn forward_conn(
    base_url: &str,
    run_id: u32,
    remote_port: u16,
    stream: TcpStream,
) -> Result<(), String> {
    let ws_base = ws_url(base_url)?;
    let url = format!("{ws_base}/api/runs/{run_id}/proxy/{remote_port}");

    let (ws, _) = connect_async(url.as_str())
        .await
        .map_err(|e| format!("ws dial: {e}"))?;

    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut tcp_rx, mut tcp_tx) = tokio::io::split(stream);

    let tcp_to_ws = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match tcp_rx.read(&mut buf).await {
                Ok(0) | Err(_) => return Ok(()),
                Ok(n) => {
                    ws_tx
                        .send(Message::Binary(buf[..n].to_vec()))
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    };

    let ws_to_tcp = async {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    tcp_tx.write_all(&data).await.map_err(|e| e.to_string())?;
                }
                Ok(Message::Close(frame)) => {
                    if frame.map(|f| f.code == CloseCode::Away).unwrap_or(false) {
                        return Err(ERR_RUN_ENDED.to_string());
                    }
                    return Ok(());
                }
                Ok(_) => {} // ping, pong, text — ignore
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    };

    tokio::select! {
        r = tcp_to_ws => r,
        r = ws_to_tcp => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_http() {
        assert_eq!(ws_url("http://foo:3000").unwrap(), "ws://foo:3000");
    }

    #[test]
    fn ws_url_https() {
        assert_eq!(ws_url("https://foo:3000").unwrap(), "wss://foo:3000");
    }

    #[test]
    fn ws_url_strips_trailing_slash() {
        assert_eq!(ws_url("http://foo:3000/").unwrap(), "ws://foo:3000");
    }

    #[test]
    fn ws_url_passthrough_ws() {
        assert_eq!(ws_url("ws://foo:3000").unwrap(), "ws://foo:3000");
    }

    #[test]
    fn ws_url_bad_scheme() {
        assert!(ws_url("ftp://foo:3000").is_err());
    }
}
```

- [ ] **Step 2: Run unit tests (scheme conversion only)**

```bash
cd /workspace && cargo test -p fbi-tunnel forwarder 2>&1 | tail -5
```

Expected: `test result: ok. 5 passed`

- [ ] **Step 3: Add `forwarder` module to `main.rs`**

```rust
mod args;
mod discovery;
mod forwarder;
mod listener;
mod mapping;

fn main() {
    println!("fbi-tunnel");
}
```

- [ ] **Step 4: Commit**

```bash
git add cli/fbi-tunnel/src/forwarder.rs cli/fbi-tunnel/src/main.rs && git commit -m "feat(tunnel): add WebSocket forwarder with url-conversion tests"
```

---

## Task 8: `main.rs` — full run loop

**Files:**
- Modify: `cli/fbi-tunnel/src/main.rs`

- [ ] **Step 1: Write the complete `main.rs`**

```rust
mod args;
mod discovery;
mod forwarder;
mod listener;
mod mapping;

use args::parse_args;
use mapping::Mapping;

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let a = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = run(&a).await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

async fn run(args: &args::Args) -> Result<(), String> {
    let discovered = discovery::discover_ports(&args.fbi_url, args.run_id).await?;
    let mappings = mapping::merge_mappings(&discovered, &args.overrides);

    if mappings.is_empty() {
        return Err("no ports to forward (run has no listening ports and no -L flags given)".into());
    }

    let mut bound: Vec<(tokio::net::TcpListener, Mapping)> = Vec::new();
    let mut final_mappings: Vec<Mapping> = Vec::new();
    for m in &mappings {
        match listener::bind_local(m.local).await {
            Ok((l, port)) => {
                let fm = Mapping { local: port, remote: m.remote };
                bound.push((l, fm.clone()));
                final_mappings.push(fm);
            }
            Err(e) => eprintln!("bind failed for remote {}: {e}", m.remote),
        }
    }

    if bound.is_empty() {
        return Err("no listeners bound".into());
    }

    print_table(args, &final_mappings);

    let (cancel_tx, _) = tokio::sync::watch::channel(false);
    let (ended_tx, mut ended_rx) = tokio::sync::mpsc::channel::<()>(1);
    let mut join_set = tokio::task::JoinSet::new();

    for (tcp_listener, m) in bound {
        let url = args.fbi_url.clone();
        let run_id = args.run_id;
        let mut cancel_rx = cancel_tx.subscribe();
        let ended_tx = ended_tx.clone();

        join_set.spawn(async move {
            loop {
                tokio::select! {
                    accept = tcp_listener.accept() => {
                        match accept {
                            Ok((stream, addr)) => {
                                eprintln!("open  remote {}  from {addr}", m.remote);
                                let url = url.clone();
                                let ended_tx = ended_tx.clone();
                                let remote = m.remote;
                                tokio::spawn(async move {
                                    let result = forwarder::forward_conn(&url, run_id, remote, stream).await;
                                    let is_ended = result.as_deref().err() == Some(forwarder::ERR_RUN_ENDED);
                                    eprintln!("close remote {remote}  from {addr}  err={result:?}");
                                    if is_ended {
                                        let _ = ended_tx.send(()).await;
                                    }
                                });
                            }
                            Err(_) => return,
                        }
                    }
                    _ = cancel_rx.changed() => return,
                }
            }
        });
    }

    tokio::select! {
        _ = ended_rx.recv() => {
            eprintln!("run {} ended", args.run_id);
            let _ = cancel_tx.send(true);
        }
        _ = wait_for_signal() => {
            let _ = cancel_tx.send(true);
        }
        _ = drain_join_set(&mut join_set) => {}
    }

    // drain remaining listener tasks
    while join_set.join_next().await.is_some() {}

    Ok(())
}

async fn drain_join_set(set: &mut tokio::task::JoinSet<()>) {
    while set.join_next().await.is_some() {}
}

async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = sigint.recv() => {}
        _ = sigterm.recv() => {}
    }
}

fn print_table(args: &args::Args, mappings: &[Mapping]) {
    println!("run {} → {}", args.run_id, args.fbi_url);
    for m in mappings {
        let note = if m.local != m.remote {
            format!("  (local {} was busy)", m.remote)
        } else {
            String::new()
        };
        println!("  remote {}  →  http://localhost:{}{}", m.remote, m.local, note);
    }
}
```

- [ ] **Step 2: Build release binary**

```bash
cd /workspace && cargo build -p fbi-tunnel --release 2>&1 | tail -5
```

Expected: `Finished release [optimized]` — binary at `target/release/fbi-tunnel`.

- [ ] **Step 3: Smoke test the binary**

```bash
/workspace/target/release/fbi-tunnel 2>&1 | head -2
```

Expected: `usage: fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...`

(exit code 2)

- [ ] **Step 4: Commit**

```bash
git add cli/fbi-tunnel/src/main.rs && git commit -m "feat(tunnel): complete fbi-tunnel run loop in Rust"
```

---

## Task 9: Integration test — full discovery → listen → pipe → close

**Files:**
- Modify: `cli/fbi-tunnel/src/forwarder.rs` (add integration test at bottom)

- [ ] **Step 1: Add integration test to `forwarder.rs`**

Append to the end of `cli/fbi-tunnel/src/forwarder.rs`:

```rust
#[cfg(test)]
mod integration_tests {
    use super::*;
    use axum::{extract::ws::{WebSocket, WebSocketUpgrade, Message as AxMessage}, routing::get, Router};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn ws_echo(ws: WebSocketUpgrade) -> impl axum::response::IntoResponse {
        ws.on_upgrade(|mut socket: WebSocket| async move {
            while let Some(Ok(msg)) = socket.recv().await {
                if let AxMessage::Binary(data) = msg {
                    let _ = socket.send(AxMessage::Binary(data)).await;
                }
            }
        })
    }

    #[tokio::test]
    async fn forward_conn_pipes_bytes_and_echoes() {
        // Start WS echo server
        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_port = ws_listener.local_addr().unwrap().port();
        let app = Router::new().route("/api/runs/1/proxy/9999", get(ws_echo));
        tokio::spawn(async move { axum::serve(ws_listener, app).await.unwrap() });

        // TCP pair: client <-> server_side (server_side goes into forward_conn)
        let local_server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_port = local_server.local_addr().unwrap().port();
        let mut client = tokio::net::TcpStream::connect(format!("127.0.0.1:{local_port}")).await.unwrap();
        let (server_side, _) = local_server.accept().await.unwrap();

        let base_url = format!("http://127.0.0.1:{ws_port}");
        tokio::spawn(async move {
            let _ = forward_conn(&base_url, 1, 9999, server_side).await;
        });

        // Write data through the tunnel; expect echo
        client.write_all(b"hello world").await.unwrap();
        let mut buf = vec![0u8; 11];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello world");
    }
}
```

- [ ] **Step 2: Run integration test**

```bash
cd /workspace && cargo test -p fbi-tunnel integration 2>&1 | tail -8
```

Expected: `test result: ok. 1 passed`

- [ ] **Step 3: Run all fbi-tunnel tests**

```bash
cd /workspace && cargo test -p fbi-tunnel 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add cli/fbi-tunnel/src/forwarder.rs && git commit -m "test(tunnel): add integration test for full forward_conn pipe"
```

---

## Task 10: Remove Go files + update Makefile

**Files:**
- Delete: `cli/fbi-tunnel/*.go`, `cli/fbi-tunnel/go.mod`, `cli/fbi-tunnel/go.sum`, `cli/fbi-tunnel/scripts/build-dist.sh`
- Modify: `cli/fbi-tunnel/Makefile`

- [ ] **Step 1: Delete Go source and build scripts**

```bash
rm /workspace/cli/fbi-tunnel/*.go \
   /workspace/cli/fbi-tunnel/go.mod \
   /workspace/cli/fbi-tunnel/go.sum \
   /workspace/cli/fbi-tunnel/scripts/build-dist.sh
```

- [ ] **Step 2: Write replacement `Makefile`**

```makefile
.PHONY: build test install clean

DIST := dist
TARGETS := \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  x86_64-unknown-linux-gnu \
  aarch64-unknown-linux-gnu

build:
	@mkdir -p $(DIST)
	@for target in $(TARGETS); do \
	  echo "building $$target..."; \
	  cargo build --release --target $$target; \
	  cp target/$$target/release/fbi-tunnel $(DIST)/fbi-tunnel-$$target; \
	done

test:
	cargo test

install:
	cargo install --path . --force

clean:
	rm -rf $(DIST)
```

- [ ] **Step 3: Create `scripts/build-fbi-tunnel.sh`** (copies sidecar binary into desktop/binaries for bundling)

```bash
#!/usr/bin/env bash
set -euo pipefail
# Builds fbi-tunnel for the current host platform and places it in
# desktop/binaries/ with the Tauri sidecar naming convention
# (fbi-tunnel-{target-triple}).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$REPO_ROOT/desktop/binaries"
mkdir -p "$OUT"

TARGET=$(rustc -vV | awk '/^host:/ { print $2 }')
echo "Building fbi-tunnel for $TARGET..."
cargo build --release --manifest-path "$REPO_ROOT/cli/fbi-tunnel/Cargo.toml"
cp "$REPO_ROOT/target/release/fbi-tunnel" "$OUT/fbi-tunnel-$TARGET"
echo "Wrote $OUT/fbi-tunnel-$TARGET"
```

- [ ] **Step 4: Make the script executable**

```bash
chmod +x /workspace/scripts/build-fbi-tunnel.sh
```

- [ ] **Step 5: Create `desktop/binaries/.gitkeep`**

```bash
mkdir -p /workspace/desktop/binaries
touch /workspace/desktop/binaries/.gitkeep
```

- [ ] **Step 6: Add binaries/ to .gitignore (keep .gitkeep, ignore actual binaries)**

Append to `/workspace/.gitignore`:

```
desktop/binaries/fbi-tunnel-*
```

- [ ] **Step 7: Build and verify the Makefile works (host only, not cross)**

```bash
cd /workspace && cargo build -p fbi-tunnel --release 2>&1 | tail -3
```

Expected: `Finished release`.

- [ ] **Step 8: Commit**

```bash
git add cli/fbi-tunnel/Makefile scripts/build-fbi-tunnel.sh desktop/binaries/.gitkeep .gitignore
git rm --cached cli/fbi-tunnel/go.mod cli/fbi-tunnel/go.sum cli/fbi-tunnel/*.go cli/fbi-tunnel/scripts/build-dist.sh 2>/dev/null || true
git commit -m "chore(tunnel): replace Go build with Rust Makefile, add sidecar setup script"
```

---

## Task 11: Add `tauri-plugin-shell` to desktop

**Files:**
- Modify: `desktop/Cargo.toml`

- [ ] **Step 1: Add dependency**

In `desktop/Cargo.toml`, add to `[dependencies]`:

```toml
tauri-plugin-shell = "2"
```

The full dependencies section should look like:

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
tauri-plugin-store = "2"
tauri-plugin-notification = "2"
tauri-plugin-updater = "2"
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "1", features = ["full"] }
```

- [ ] **Step 2: Verify desktop still compiles**

```bash
cd /workspace && cargo build -p fbi-desktop 2>&1 | tail -5
```

Expected: `Finished` — no errors.

- [ ] **Step 3: Commit**

```bash
git add desktop/Cargo.toml && git commit -m "feat(desktop): add tauri-plugin-shell dependency"
```

---

## Task 12: `tunnel.rs` — sidecar lifecycle manager

**Files:**
- Create: `desktop/src/tunnel.rs`

- [ ] **Step 1: Write `desktop/src/tunnel.rs`**

```rust
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::tray::TrayRunInfo;

pub struct TunnelState {
    pub tunnels: HashMap<u32, TunnelEntry>,
    pub last_runs: Vec<TrayRunInfo>,
}

pub enum TunnelEntry {
    Polling,
    Active {
        child: tauri_plugin_shell::process::CommandChild,
        ports: Vec<u16>,
    },
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            tunnels: HashMap::new(),
            last_runs: Vec::new(),
        }
    }

    pub fn active_ports(&self, run_id: u32) -> Option<&Vec<u16>> {
        match self.tunnels.get(&run_id)? {
            TunnelEntry::Active { ports, .. } => Some(ports),
            TunnelEntry::Polling => None,
        }
    }
}

/// Called from update_tray_runs after tray rebuild. Reconciles managed
/// sidecar processes against the current set of running runs.
pub async fn reconcile(app: &AppHandle, runs: Vec<TrayRunInfo>) {
    let server_url = read_server_url(app);
    if server_url.is_empty() {
        return; // no server configured yet, nothing to tunnel
    }

    let state_ref = app.state::<Mutex<TunnelState>>();
    let mut state = state_ref.lock().await;
    state.last_runs = runs.clone();

    let running_ids: std::collections::HashSet<u32> = runs
        .iter()
        .filter(|r| r.state == "running")
        .map(|r| r.id)
        .collect();

    // Kill tunnels for runs no longer active
    let to_remove: Vec<u32> = state
        .tunnels
        .keys()
        .filter(|id| !running_ids.contains(id))
        .copied()
        .collect();

    for id in to_remove {
        if let Some(entry) = state.tunnels.remove(&id) {
            if let TunnelEntry::Active { mut child, .. } = entry {
                let _ = child.kill();
            }
        }
    }

    // Start polling for new running runs
    let new_runs: Vec<u32> = running_ids
        .iter()
        .filter(|id| !state.tunnels.contains_key(id))
        .copied()
        .collect();

    for run_id in new_runs {
        state.tunnels.insert(run_id, TunnelEntry::Polling);
        let app = app.clone();
        let url = server_url.clone();
        tauri::async_runtime::spawn(async move {
            poll_and_spawn(app, url, run_id).await;
        });
    }
}

async fn poll_and_spawn(app: AppHandle, server_url: String, run_id: u32) {
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        // Stop if this run was removed while we were sleeping
        {
            let state_ref = app.state::<Mutex<TunnelState>>();
            let state = state_ref.lock().await;
            match state.tunnels.get(&run_id) {
                Some(TunnelEntry::Polling) => {}
                _ => return,
            }
        }

        let ports = match fetch_ports(&server_url, run_id).await {
            Ok(p) if !p.is_empty() => p,
            _ => continue,
        };

        // Spawn the sidecar
        let sidecar_cmd = match app.shell().sidecar("fbi-tunnel") {
            Ok(cmd) => cmd,
            Err(e) => {
                eprintln!("[tunnel] sidecar lookup failed: {e}");
                return;
            }
        };
        let (mut rx, child) = match sidecar_cmd
            .args([server_url.as_str(), &run_id.to_string()])
            .spawn()
        {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[tunnel] sidecar spawn failed for run {run_id}: {e}");
                return;
            }
        };

        // Drain sidecar stdout/stderr to avoid pipe blocking
        tauri::async_runtime::spawn(async move {
            while rx.recv().await.is_some() {}
        });

        // Transition to Active and rebuild tray
        let (runs, tunnel_ports) = {
            let state_ref = app.state::<Mutex<TunnelState>>();
            let mut state = state_ref.lock().await;
            if !state.tunnels.contains_key(&run_id) {
                // Run was removed while we were spawning; kill the child
                let mut c = child;
                let _ = c.kill();
                return;
            }
            state.tunnels.insert(run_id, TunnelEntry::Active { child, ports: ports.clone() });
            let runs = state.last_runs.clone();
            let tunnel_ports: HashMap<u32, Vec<u16>> = state
                .tunnels
                .iter()
                .filter_map(|(id, e)| {
                    if let TunnelEntry::Active { ports, .. } = e {
                        Some((*id, ports.clone()))
                    } else {
                        None
                    }
                })
                .collect();
            (runs, tunnel_ports)
        };

        // Notification
        let port_list = ports
            .iter()
            .map(|p| format!("localhost:{p}"))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = crate::tray::notify_raw(
            &app,
            format!("Tunnel active — run #{run_id}"),
            port_list,
        );

        // Rebuild tray with updated tunnel state
        crate::tray::rebuild_tray(&app, &runs, &tunnel_ports);
        return;
    }
}

async fn fetch_ports(server_url: &str, run_id: u32) -> Result<Vec<u16>, String> {
    #[derive(serde::Deserialize)]
    struct Resp {
        ports: Vec<PortEntry>,
    }
    #[derive(serde::Deserialize)]
    struct PortEntry {
        port: u16,
    }

    let url = format!(
        "{}/api/runs/{}/listening-ports",
        server_url.trim_end_matches('/'),
        run_id
    );
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        let data: Resp = resp.json().await.map_err(|e| e.to_string())?;
        Ok(data.ports.into_iter().map(|p| p.port).collect())
    } else {
        Err(format!("status {}", resp.status()))
    }
}

fn read_server_url(app: &AppHandle) -> String {
    use tauri_plugin_store::StoreExt;
    app.store("fbi-config.json")
        .ok()
        .and_then(|s| s.get("server_url"))
        .and_then(|v| v.as_str().map(|s| s.to_owned()))
        .unwrap_or_default()
}

// ---- Reconcile state logic (pure, testable without AppHandle) ----

pub struct ReconcileResult {
    pub to_kill: Vec<u32>,        // run IDs whose children should be killed
    pub to_poll: Vec<u32>,        // run IDs that should start a poll task
}

/// Pure state-mutation logic extracted for unit testing.
pub fn reconcile_state(state: &mut TunnelState, runs: &[TrayRunInfo]) -> ReconcileResult {
    state.last_runs = runs.to_vec();

    let running_ids: std::collections::HashSet<u32> = runs
        .iter()
        .filter(|r| r.state == "running")
        .map(|r| r.id)
        .collect();

    let to_kill: Vec<u32> = state
        .tunnels
        .keys()
        .filter(|id| !running_ids.contains(id))
        .copied()
        .collect();

    for id in &to_kill {
        state.tunnels.remove(id);
    }

    let to_poll: Vec<u32> = running_ids
        .iter()
        .filter(|id| !state.tunnels.contains_key(id))
        .copied()
        .collect();

    for &id in &to_poll {
        state.tunnels.insert(id, TunnelEntry::Polling);
    }

    ReconcileResult { to_kill, to_poll }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: u32, state: &str) -> TrayRunInfo {
        TrayRunInfo { id, title: None, state: state.to_string() }
    }

    #[test]
    fn new_running_run_starts_polling() {
        let mut state = TunnelState::new();
        let result = reconcile_state(&mut state, &[run(1, "running")]);
        assert!(result.to_kill.is_empty());
        assert_eq!(result.to_poll, vec![1]);
        assert!(matches!(state.tunnels.get(&1), Some(TunnelEntry::Polling)));
    }

    #[test]
    fn run_removed_from_active_list_is_killed() {
        let mut state = TunnelState::new();
        state.tunnels.insert(42, TunnelEntry::Polling);
        let result = reconcile_state(&mut state, &[]); // 42 no longer active
        assert_eq!(result.to_kill, vec![42]);
        assert!(result.to_poll.is_empty());
        assert!(state.tunnels.is_empty());
    }

    #[test]
    fn non_running_state_does_not_trigger_poll() {
        let mut state = TunnelState::new();
        let result = reconcile_state(&mut state, &[run(1, "queued"), run(2, "waiting")]);
        assert!(result.to_poll.is_empty());
        assert!(state.tunnels.is_empty());
    }

    #[test]
    fn no_double_poll_on_second_reconcile() {
        let mut state = TunnelState::new();
        reconcile_state(&mut state, &[run(1, "running")]);
        let result2 = reconcile_state(&mut state, &[run(1, "running")]);
        assert!(result2.to_poll.is_empty()); // already tracked
    }

    #[test]
    fn last_runs_updated() {
        let mut state = TunnelState::new();
        reconcile_state(&mut state, &[run(1, "running")]);
        assert_eq!(state.last_runs.len(), 1);
        assert_eq!(state.last_runs[0].id, 1);
    }
}
```

- [ ] **Step 2: Run the unit tests**

```bash
cd /workspace && cargo test -p fbi-desktop tunnel 2>&1 | tail -8
```

Expected: `test result: ok. 5 passed`

- [ ] **Step 3: Commit**

```bash
git add desktop/src/tunnel.rs && git commit -m "feat(desktop): add tunnel sidecar lifecycle manager with tests"
```

---

## Task 13: Update `tray.rs` — tunnel-aware labels + expose rebuild_tray

**Files:**
- Modify: `desktop/src/tray.rs`

The existing `build_runs_menu` and `update_tray_runs` need to be updated so:
1. `build_runs_menu` accepts a `&HashMap<u32, Vec<u16>>` of active tunnel ports per run.
2. A new public `rebuild_tray` function lets `tunnel.rs` rebuild the tray after a poll task activates.
3. A new public `notify_raw` function wraps the notification call.
4. `update_tray_runs` becomes `async` and calls `tunnel::reconcile` after rebuilding.

- [ ] **Step 1: Rewrite `desktop/src/tray.rs`**

```rust
use std::collections::HashMap;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tokio::sync::Mutex;

use crate::tunnel::TunnelState;

#[derive(serde::Deserialize, Clone, Debug)]
pub struct TrayRunInfo {
    pub id: u32,
    pub title: Option<String>,
    pub state: String,
}

pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_runs_menu(app, &[], &HashMap::new())?;

    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png")).unwrap();
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-linux.png")).unwrap();

    TrayIconBuilder::with_id("main")
        .tooltip("FBI")
        .menu(&menu)
        .icon(icon)
        .icon_as_template(true)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "quit" => app.exit(0),
                "show" => show_main_window(app),
                id if id.starts_with("run-") => {
                    show_main_window(app);
                    if let Ok(run_id) = id[4..].parse::<u32>() {
                        let _ = app.emit("navigate-to-run", run_id);
                    }
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_runs_menu<R: tauri::Runtime>(
    manager: &impl Manager<R>,
    runs: &[TrayRunInfo],
    tunnel_ports: &HashMap<u32, Vec<u16>>,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(manager)?;

    if runs.is_empty() {
        menu.append(&MenuItem::with_id(
            manager,
            "no-runs",
            "No active runs",
            false,
            None::<&str>,
        )?)?;
    } else {
        for run in runs {
            let state_label = match run.state.as_str() {
                "running" => "running",
                "waiting" | "awaiting_resume" => "waiting",
                "queued" => "queued",
                "starting" => "starting",
                other => other,
            };
            let name = run.title.as_deref().unwrap_or("Untitled");
            let tunnel_suffix = if let Some(ports) = tunnel_ports.get(&run.id) {
                format!("  ·  ↔ {} port{}", ports.len(), if ports.len() == 1 { "" } else { "s" })
            } else {
                String::new()
            };
            let label = format!("{}  ·  {}{}", name, state_label, tunnel_suffix);
            menu.append(&MenuItem::with_id(
                manager,
                format!("run-{}", run.id),
                label,
                true,
                None::<&str>,
            )?)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(&MenuItem::with_id(manager, "show", "Open FBI", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(&MenuItem::with_id(manager, "quit", "Quit", true, None::<&str>)?)?;

    Ok(menu)
}

/// Rebuilds the tray menu with current runs and tunnel state.
/// Called by tunnel.rs when a poll task transitions a run to Active.
pub fn rebuild_tray(app: &AppHandle, runs: &[TrayRunInfo], tunnel_ports: &HashMap<u32, Vec<u16>>) {
    let has_waiting = runs.iter().any(|r| r.state == "waiting" || r.state == "awaiting_resume");
    let active = runs.len();

    let tooltip = if active > 0 {
        format!("FBI — {} run{} active", active, if active == 1 { "" } else { "s" })
    } else {
        "FBI".to_string()
    };

    let Ok(menu) = build_runs_menu(app, runs, tunnel_ports) else { return };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
        let _ = tray.set_tooltip(Some(&tooltip));

        #[cfg(target_os = "macos")]
        {
            let icon_data: &[u8] = if has_waiting {
                include_bytes!("../icons/tray-waiting-template.png")
            } else {
                include_bytes!("../icons/tray-template.png")
            };
            if let Ok(icon) = tauri::image::Image::from_bytes(icon_data) {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_icon_as_template(true);
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let icon_data: &[u8] = if has_waiting {
                include_bytes!("../icons/tray-waiting-linux.png")
            } else {
                include_bytes!("../icons/tray-linux.png")
            };
            if let Ok(icon) = tauri::image::Image::from_bytes(icon_data) {
                let _ = tray.set_icon(Some(icon));
            }
        }
    }
}

#[tauri::command]
pub async fn update_tray_runs(app: AppHandle, runs: Vec<TrayRunInfo>) -> Result<(), String> {
    // Read current tunnel state for menu building
    let tunnel_ports = {
        let state_ref = app.state::<Mutex<TunnelState>>();
        let state = state_ref.lock().await;
        state
            .tunnels
            .iter()
            .filter_map(|(id, e)| {
                if let crate::tunnel::TunnelEntry::Active { ports, .. } = e {
                    Some((*id, ports.clone()))
                } else {
                    None
                }
            })
            .collect::<HashMap<u32, Vec<u16>>>()
    };

    rebuild_tray(&app, &runs, &tunnel_ports);

    // Reconcile tunnel sidecars
    crate::tunnel::reconcile(&app, runs).await;

    Ok(())
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    notify_raw(&app, title, body)
}

/// Internal notification helper usable from other modules without going through Tauri invoke.
pub fn notify_raw(app: &AppHandle, title: impl Into<String>, body: impl Into<String>) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title.into())
        .body(&body.into())
        .show()
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Build desktop to verify compilation**

```bash
cd /workspace && cargo build -p fbi-desktop 2>&1 | tail -8
```

Expected: `Finished` with no errors. Fix any type errors before continuing.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/tray.rs && git commit -m "feat(desktop): tunnel-aware tray labels, expose rebuild_tray + notify_raw"
```

---

## Task 14: Update `desktop/src/main.rs` — register plugin + state

**Files:**
- Modify: `desktop/src/main.rs`

- [ ] **Step 1: Rewrite `desktop/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod discovery;
mod tray;
mod tunnel;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(tokio::sync::Mutex::new(tunnel::TunnelState::new()))
        .invoke_handler(tauri::generate_handler![
            config::get_server_url,
            config::set_server_url,
            tray::update_tray_runs,
            tray::notify,
            discovery::discover_servers,
        ])
        .setup(|app| {
            tray::setup_tray(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_updater::UpdaterExt;
                if let Ok(updater) = handle.updater() {
                    if let Ok(Some(update)) = updater.check().await {
                        let _ = update.download_and_install(|_, _| {}, || {}).await;
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2: Build desktop**

```bash
cd /workspace && cargo build -p fbi-desktop 2>&1 | tail -5
```

Expected: `Finished` with no errors.

- [ ] **Step 3: Run all desktop tests**

```bash
cd /workspace && cargo test -p fbi-desktop 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main.rs && git commit -m "feat(desktop): register shell plugin and tunnel state"
```

---

## Task 15: Update Tauri config for sidecar + capabilities

**Files:**
- Modify: `desktop/tauri.conf.json`
- Modify: `desktop/capabilities/default.json`

- [ ] **Step 1: Add `externalBin` to `desktop/tauri.conf.json`**

Add under the `"bundle"` key (alongside `"icon"`, `"targets"`, etc.):

```json
"externalBin": ["binaries/fbi-tunnel"]
```

The full `bundle` section:

```json
"bundle": {
  "active": true,
  "targets": "all",
  "createUpdaterArtifacts": "v1Compatible",
  "externalBin": ["binaries/fbi-tunnel"],
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ],
  "category": "DeveloperTool"
}
```

Tauri will look for `desktop/binaries/fbi-tunnel-{target-triple}` at build time. The `scripts/build-fbi-tunnel.sh` script created in Task 10 produces exactly this.

- [ ] **Step 2: Do NOT add shell permissions to `desktop/capabilities/default.json`**

The shell plugin is used exclusively from Rust backend code. No changes needed to `default.json`. Verify it still has no `shell:` entries:

```bash
grep -c shell /workspace/desktop/capabilities/default.json || echo "0 — correct, no shell perms"
```

Expected: `0 — correct, no shell perms`

- [ ] **Step 3: Build sidecar binary for local dev**

```bash
bash /workspace/scripts/build-fbi-tunnel.sh
```

Expected output: `Wrote desktop/binaries/fbi-tunnel-{triple}` where `{triple}` is your host target.

- [ ] **Step 4: Verify binary is present**

```bash
ls /workspace/desktop/binaries/
```

Expected: one `fbi-tunnel-*` file.

- [ ] **Step 5: Commit**

```bash
git add desktop/tauri.conf.json scripts/build-fbi-tunnel.sh && git commit -m "feat(desktop): configure fbi-tunnel sidecar in tauri.conf.json"
```

---

## Task 16: Fix tunnel origin in desktop app (bug)

**Files:**
- Modify: `src/web/pages/RunDetail.tsx`
- Modify: `src/web/features/runs/TunnelTab.tsx`

In the Tauri desktop, `window.location.origin` is `tauri://localhost` (the embedded webview's own origin), not the configured FBI server URL. `TunnelTab` uses this as the `fbi-tunnel` command origin, so the displayed command is wrong. The download links also use relative paths that don't work from the Tauri context.

**Fix:** Use `apiBase() || window.location.origin` as the origin — `apiBase()` returns the stored server URL when configured (desktop), and `''` in the browser (falling back to `window.location.origin`). Prefix download hrefs with the same origin.

- [ ] **Step 1: Fix `RunDetail.tsx` — use `apiBase()` as tunnel origin**

In `src/web/pages/RunDetail.tsx`, find the `TunnelTab` render (around line 289):

```tsx
t === 'tunnel'  ? <TunnelTab runId={run.id} runState={run.state}
                             origin={window.location.origin} ports={ports} /> :
```

Change to:

```tsx
t === 'tunnel'  ? <TunnelTab runId={run.id} runState={run.state}
                             origin={apiBase() || window.location.origin} ports={ports} /> :
```

Make sure `apiBase` is imported at the top of the file:

```ts
import { api, apiBase } from '../lib/api.js';
```

(Check if `api` is already imported; add `apiBase` to the same import.)

- [ ] **Step 2: Fix download links in `TunnelTab.tsx` — prefix with origin**

In `src/web/features/runs/TunnelTab.tsx`, the primary download href:

```tsx
href={`/api/cli/fbi-tunnel/${plat.os}/${plat.arch}`}
```

Change to:

```tsx
href={`${origin}/api/cli/fbi-tunnel/${plat.os}/${plat.arch}`}
```

And the "other platforms" links:

```tsx
href={`/api/cli/fbi-tunnel/${p.os}/${p.arch}`}
```

Change to:

```tsx
href={`${origin}/api/cli/fbi-tunnel/${p.os}/${p.arch}`}
```

- [ ] **Step 3: Verify the fix compiles**

```bash
cd /workspace && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/RunDetail.tsx src/web/features/runs/TunnelTab.tsx
git commit -m "fix(desktop): use server URL as fbi-tunnel origin, not tauri://localhost"
```

---

## Task 17: Final build verification + run all tests

- [ ] **Step 1: Run the complete test suite**

```bash
cd /workspace && cargo test --workspace 2>&1 | tail -15
```

Expected: all tests pass across both crates.

- [ ] **Step 2: Build the desktop app in release mode**

```bash
cd /workspace && cargo build -p fbi-desktop --release 2>&1 | tail -5
```

Expected: `Finished release`.

- [ ] **Step 3: Build fbi-tunnel release binary**

```bash
cd /workspace && cargo build -p fbi-tunnel --release 2>&1 | tail -3
```

Expected: `Finished release`.

- [ ] **Step 4: Smoke test the CLI binary**

```bash
/workspace/target/release/fbi-tunnel 2>&1
echo "exit: $?"
```

Expected:
```
usage: fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...
exit: 2
```

- [ ] **Step 5: Final commit**

```bash
git add -A && git status
# verify only expected files are staged (no binaries, no go files)
git commit -m "feat: complete fbi-tunnel Rust rewrite with desktop sidecar integration"
```
