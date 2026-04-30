#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod discovery;
mod menu;
mod tray;
mod tunnel;

use tauri::Emitter;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(tokio::sync::Mutex::new(tunnel::TunnelState::new()))
        .manage(std::sync::Mutex::new(tray::TrayState::new()))
        .invoke_handler(tauri::generate_handler![
            config::get_server_url,
            config::set_server_url,
            tray::update_tray_runs,
            tray::notify,
            discovery::discover_servers,
        ])
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                let _ = app.emit("navigate", "/settings");
            }
            "keyboard-shortcuts" => {
                let _ = app.emit("open-cheatsheet", ());
            }
            "github-issues" => {
                use tauri_plugin_opener::OpenerExt;
                app.opener()
                    .open_url("https://github.com/fynn-labs/FBI/issues", None::<&str>)
                    .ok();
            }
            "check-updates" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    if let Ok(updater) = handle.updater() {
                        if let Ok(Some(update)) = updater.check().await {
                            let _ = update.download_and_install(|_, _| {}, || {}).await;
                        }
                    }
                });
            }
            _ => {}
        })
        .setup(|app| {
            let app_menu = menu::build_menu(app.handle())?;
            app.set_menu(app_menu)?;
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
