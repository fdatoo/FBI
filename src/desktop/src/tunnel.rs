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

    #[allow(dead_code)]
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
        return;
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
        if let Some(TunnelEntry::Active { child, .. }) = state.tunnels.remove(&id) {
            let _ = child.kill();
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
        tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });

        // Transition to Active and rebuild tray
        let (runs, tunnel_ports) = {
            let state_ref = app.state::<Mutex<TunnelState>>();
            let mut state = state_ref.lock().await;
            if !state.tunnels.contains_key(&run_id) {
                let _ = child.kill();
                return;
            }
            state.tunnels.insert(
                run_id,
                TunnelEntry::Active {
                    child,
                    ports: ports.clone(),
                },
            );
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
        let _ = crate::tray::notify_raw(&app, format!("Tunnel active — run #{run_id}"), port_list);

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

// ---- Pure reconcile logic (testable without AppHandle) ----

#[allow(dead_code)]
pub struct ReconcileResult {
    pub to_kill: Vec<u32>,
    pub to_poll: Vec<u32>,
}

#[allow(dead_code)]
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
        TrayRunInfo {
            id,
            title: None,
            state: state.to_string(),
        }
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
        let result = reconcile_state(&mut state, &[]);
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
        assert!(result2.to_poll.is_empty());
    }

    #[test]
    fn last_runs_updated() {
        let mut state = TunnelState::new();
        reconcile_state(&mut state, &[run(1, "running")]);
        assert_eq!(state.last_runs.len(), 1);
        assert_eq!(state.last_runs[0].id, 1);
    }
}
