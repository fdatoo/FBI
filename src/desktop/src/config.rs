use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "fbi-config.json";
const SERVER_URL_KEY: &str = "server_url";

#[tauri::command]
pub async fn get_server_url(app: tauri::AppHandle) -> String {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(SERVER_URL_KEY))
        .and_then(|v| v.as_str().map(|s| s.to_owned()))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn set_server_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(SERVER_URL_KEY, serde_json::Value::String(url));
    store.save().map_err(|e| e.to_string())
}
