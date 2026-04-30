use std::collections::HashMap;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tokio::sync::Mutex as TokioMutex;

use crate::tunnel::TunnelState;

#[derive(serde::Deserialize, Clone, Debug)]
pub struct TrayRunInfo {
    pub id: u32,
    pub title: Option<String>,
    pub state: String,
}

pub struct TrayState {
    pub runs: Vec<TrayRunInfo>,
    pub tunnel_ports: HashMap<u32, Vec<u16>>,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            runs: Vec::new(),
            tunnel_ports: HashMap::new(),
        }
    }
}

#[cfg(target_os = "macos")]
fn select_waiting_icon(theme: tauri::Theme) -> (&'static [u8], bool) {
    match theme {
        tauri::Theme::Light => (include_bytes!("../icons/tray-waiting-light.png"), false),
        _ => (
            // Dark and any future unknown variants fall back to the template icon.
            include_bytes!("../icons/tray-waiting-template.png"),
            true,
        ),
    }
}

pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_runs_menu(app, &[], &HashMap::new())?;

    #[cfg(target_os = "macos")]
    let icon =
        tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png")).unwrap();
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

    // On macOS, rebuild the tray immediately when the user switches light/dark mode.
    #[cfg(target_os = "macos")]
    {
        let handle = app.handle().clone();
        if let Some(window) = app.get_webview_window("main") {
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::ThemeChanged(_) = event {
                    let state = handle.state::<std::sync::Mutex<TrayState>>();
                    let (runs, tunnel_ports) = {
                        let s = state.lock().unwrap();
                        (s.runs.clone(), s.tunnel_ports.clone())
                    };
                    rebuild_tray(&handle, &runs, &tunnel_ports);
                }
            });
        } else {
            eprintln!("[tray] warning: 'main' window not found at setup; theme-change listener not registered");
        }
    }

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
                format!(
                    "  ·  ↔ {} port{}",
                    ports.len(),
                    if ports.len() == 1 { "" } else { "s" }
                )
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
    menu.append(&MenuItem::with_id(
        manager,
        "show",
        "Open FBI",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(&MenuItem::with_id(
        manager,
        "quit",
        "Quit",
        true,
        None::<&str>,
    )?)?;

    Ok(menu)
}

/// Rebuilds the tray menu with current runs and tunnel state.
/// Called by tunnel.rs when a poll task transitions a run to Active.
pub fn rebuild_tray(app: &AppHandle, runs: &[TrayRunInfo], tunnel_ports: &HashMap<u32, Vec<u16>>) {
    let has_waiting = runs
        .iter()
        .any(|r| r.state == "waiting" || r.state == "awaiting_resume");
    let active = runs.len();

    let tooltip = if active > 0 {
        format!(
            "FBI — {} run{} active",
            active,
            if active == 1 { "" } else { "s" }
        )
    } else {
        "FBI".to_string()
    };

    let Ok(menu) = build_runs_menu(app, runs, tunnel_ports) else {
        return;
    };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
        let _ = tray.set_tooltip(Some(&tooltip));

        #[cfg(target_os = "macos")]
        {
            // Persist run data so the theme-change handler can rebuild without a frontend message.
            {
                let tray_state = app.state::<std::sync::Mutex<TrayState>>();
                let mut state = tray_state.lock().unwrap();
                state.runs = runs.to_vec();
                state.tunnel_ports = tunnel_ports.clone();
            }

            if has_waiting {
                // Fall back to Dark: the template icon renders correctly on any background,
                // so it is the safe default when the window is unavailable.
                let theme = app
                    .get_webview_window("main")
                    .and_then(|w| w.theme().ok())
                    .unwrap_or(tauri::Theme::Dark);
                let (icon_data, as_template) = select_waiting_icon(theme);
                if let Ok(icon) = tauri::image::Image::from_bytes(icon_data) {
                    let _ = tray.set_icon(Some(icon));
                    let _ = tray.set_icon_as_template(as_template);
                }
            } else {
                let icon_data = include_bytes!("../icons/tray-template.png");
                if let Ok(icon) = tauri::image::Image::from_bytes(icon_data) {
                    let _ = tray.set_icon(Some(icon));
                    let _ = tray.set_icon_as_template(true);
                }
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
        let state_ref = app.state::<TokioMutex<TunnelState>>();
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
pub fn notify_raw(
    app: &AppHandle,
    title: impl Into<String>,
    body: impl Into<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title.into())
        .body(body.into())
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn select_waiting_icon_light_returns_no_template() {
        let (_, as_template) = select_waiting_icon(tauri::Theme::Light);
        assert!(!as_template, "light mode icon must not use template mode");
    }

    #[test]
    fn select_waiting_icon_dark_returns_template() {
        let (_, as_template) = select_waiting_icon(tauri::Theme::Dark);
        assert!(as_template, "dark mode icon must use template mode");
    }

    #[test]
    fn select_waiting_icon_light_returns_light_bytes() {
        let (bytes, _) = select_waiting_icon(tauri::Theme::Light);
        assert_eq!(bytes, include_bytes!("../icons/tray-waiting-light.png"));
    }

    #[test]
    fn select_waiting_icon_dark_returns_template_bytes() {
        let (bytes, _) = select_waiting_icon(tauri::Theme::Dark);
        assert_eq!(bytes, include_bytes!("../icons/tray-waiting-template.png"));
    }
}
