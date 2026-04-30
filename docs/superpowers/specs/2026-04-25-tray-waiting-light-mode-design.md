# Tray Waiting Icon — Light Mode Support

**Date:** 2026-04-25
**Scope:** macOS only (`desktop/src/tray.rs`)

## Problem

The system tray waiting indicator (shown when any run is in `waiting` or `awaiting_resume` state) uses a single icon on macOS: `tray-waiting-template.png`, loaded with `icon_as_template(true)`. Template mode is designed for monochromatic (black + alpha) images; the waiting icon includes an orange dot, which breaks this assumption. The icon appears as a white subject with an orange dot in both light and dark mode, making it invisible against a light menu bar.

## Solution

Use explicit light- and dark-mode assets for the waiting state on macOS. Detect the current system theme at render time and switch icons accordingly. Listen for theme-change events so the icon updates immediately when the user changes their system appearance.

## Assets

| File | Purpose |
|---|---|
| `desktop/icons/tray-waiting-template.png` | Waiting, dark mode (existing) |
| `desktop/icons/tray-waiting-template@2x.png` | Waiting, dark mode, Retina (existing) |
| `desktop/icons/tray-waiting-light.png` | Waiting, light mode (new) |
| `desktop/icons/tray-waiting-light@2x.png` | Waiting, light mode, Retina (new) |

The new assets are copied from `/fbi/uploads/tray-waiting-light.png` and `/fbi/uploads/tray-waiting-light@2x.png`.

## Icon Selection Logic (macOS only)

| Run state | System theme | Icon file | `icon_as_template` |
|---|---|---|---|
| Waiting | Dark | `tray-waiting-template.png` | `true` |
| Waiting | Light | `tray-waiting-light.png` | `false` |
| Idle | Either | `tray-template.png` | `true` |

Linux and Windows are unchanged.

## New State: `TrayState`

Add a `TrayState` struct to app state (behind `tokio::sync::Mutex`) that caches the most recent values passed to `rebuild_tray`:

```rust
pub struct TrayState {
    pub runs: Vec<TrayRunInfo>,
    pub tunnel_ports: HashMap<u32, Vec<u16>>,
}
```

`rebuild_tray` writes to `TrayState` each call. The theme-change listener reads from it to trigger a rebuild without waiting for a frontend message.

## Theme Detection

Inside the macOS block in `rebuild_tray`, detect theme via:

```rust
let theme = app
    .get_webview_window("main")
    .and_then(|w| w.theme().ok())
    .unwrap_or(tauri::Theme::Dark);
```

Default to `Dark` if the window is unavailable (e.g., before first show).

## Theme-Change Listener

Registered in `setup_tray` via `app.on_window_event`. On `WindowEvent::ThemeChanged(_)`:

1. Lock `TrayState`
2. Clone the stored `runs` and `tunnel_ports`
3. Call `rebuild_tray` with the cloned values

## Data Flow

```
Frontend run poll
  → update_tray_runs (Tauri command)
  → update TrayState
  → rebuild_tray
      → read window theme
      → select icon + template flag
      → set tray icon

System theme change
  → WindowEvent::ThemeChanged
  → read TrayState (stored runs + tunnel_ports)
  → rebuild_tray
      → read new window theme
      → select icon + template flag
      → set tray icon
```

## Files Changed

| File | Change |
|---|---|
| `desktop/icons/tray-waiting-light.png` | New asset (copied from upload) |
| `desktop/icons/tray-waiting-light@2x.png` | New asset (copied from upload) |
| `desktop/src/tray.rs` | Add `TrayState`, update `rebuild_tray` icon logic, add theme-change listener in `setup_tray` |

## Out of Scope

- Normal (non-waiting) tray icon: unchanged; template mode works correctly for monochromatic icons
- Linux / Windows: unchanged
- Frontend changes: none
