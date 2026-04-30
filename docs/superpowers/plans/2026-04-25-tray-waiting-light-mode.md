# Tray Waiting Icon — Light Mode Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a dark-subject waiting icon in the macOS system tray when the system is in light mode, and the existing white-subject icon in dark mode, updating immediately when the user switches appearances.

**Architecture:** Add a `TrayState` struct (behind `std::sync::Mutex`) to app state to cache current run/tunnel data so a `WindowEvent::ThemeChanged` handler can rebuild the tray without a new frontend message. Extract a pure `select_waiting_icon(theme)` helper for the icon/template-flag selection, making it independently testable. All new logic is inside `#[cfg(target_os = "macos")]` blocks; Linux/Windows are untouched.

**Tech Stack:** Tauri v2 (Rust), `tauri::Theme`, `tauri::WebviewWindow::on_window_event`, `WindowEvent::ThemeChanged`, `std::sync::Mutex`

---

### Task 1: Copy icon assets

**Files:**
- Create: `desktop/icons/tray-waiting-light.png`
- Create: `desktop/icons/tray-waiting-light@2x.png`

- [ ] **Step 1: Copy both assets into the icons directory**

```bash
cp /fbi/uploads/tray-waiting-light.png /workspace/desktop/icons/tray-waiting-light.png
cp "/fbi/uploads/tray-waiting-light@2x.png" "/workspace/desktop/icons/tray-waiting-light@2x.png"
```

- [ ] **Step 2: Verify both files exist and are non-empty**

```bash
ls -la /workspace/desktop/icons/tray-waiting-light*.png
```

Expected: two files, both non-zero size.

- [ ] **Step 3: Commit**

```bash
cd /workspace
git add desktop/icons/tray-waiting-light.png "desktop/icons/tray-waiting-light@2x.png"
git commit -m "feat: add light mode tray waiting icon assets"
```

---

### Task 2: Add `TrayState` struct and register it in app state

**Files:**
- Modify: `desktop/src/tray.rs` — add `TrayState` struct after `TrayRunInfo` (around line 17)
- Modify: `desktop/src/main.rs` — add `.manage()` call alongside `TunnelState` (around line 12)

- [ ] **Step 1: Add `TrayState` to `tray.rs`**

Insert after the closing brace of the `TrayRunInfo` struct (after line 16):

```rust
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
```

- [ ] **Step 2: Register `TrayState` in `main.rs`**

In `main.rs`, add a second `.manage()` call directly after the existing one for `TunnelState`:

```rust
.manage(tokio::sync::Mutex::new(tunnel::TunnelState::new()))
.manage(std::sync::Mutex::new(tray::TrayState::new()))
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /workspace/desktop && cargo build 2>&1 | tail -20
```

Expected: no errors (warnings OK).

- [ ] **Step 4: Commit**

```bash
cd /workspace
git add desktop/src/tray.rs desktop/src/main.rs
git commit -m "feat: add TrayState to cache run data for theme-change rebuilds"
```

---

### Task 3: Add `select_waiting_icon` with unit tests (TDD)

**Files:**
- Modify: `desktop/src/tray.rs` — add function and test module

- [ ] **Step 1: Write the failing tests**

Add a test module at the bottom of `tray.rs`. It is gated on both `test` and `target_os = "macos"` since `select_waiting_icon` is macOS-only:

```rust
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
}
```

- [ ] **Step 2: Run tests to verify they fail (function not yet defined)**

```bash
cd /workspace/desktop && cargo test select_waiting_icon 2>&1
```

Expected: compile error — `select_waiting_icon` not found.

- [ ] **Step 3: Implement `select_waiting_icon`**

Add this function before `setup_tray` in `tray.rs`:

```rust
#[cfg(target_os = "macos")]
fn select_waiting_icon(theme: tauri::Theme) -> (&'static [u8], bool) {
    match theme {
        tauri::Theme::Light => (
            include_bytes!("../icons/tray-waiting-light.png"),
            false,
        ),
        _ => (
            include_bytes!("../icons/tray-waiting-template.png"),
            true,
        ),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /workspace/desktop && cargo test select_waiting_icon 2>&1
```

Expected:

```
test tests::select_waiting_icon_light_returns_no_template ... ok
test tests::select_waiting_icon_dark_returns_template ... ok

test result: ok. 2 passed; 0 failed
```

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add desktop/src/tray.rs
git commit -m "feat: add select_waiting_icon for macOS light/dark mode switching"
```

---

### Task 4: Update `rebuild_tray` to detect theme and persist state

**Files:**
- Modify: `desktop/src/tray.rs` — update the macOS `#[cfg]` block in `rebuild_tray` (lines 144–155)

- [ ] **Step 1: Replace the macOS icon block in `rebuild_tray`**

The current macOS block (lines 144–155) looks like:

```rust
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
```

Replace it entirely with:

```rust
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
```

- [ ] **Step 2: Build to verify it compiles**

```bash
cd /workspace/desktop && cargo build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Run all tests to verify nothing regressed**

```bash
cd /workspace/desktop && cargo test 2>&1
```

Expected: all existing tests still pass, plus the two `select_waiting_icon` tests.

- [ ] **Step 4: Commit**

```bash
cd /workspace
git add desktop/src/tray.rs
git commit -m "feat: detect macOS theme in rebuild_tray for waiting icon selection"
```

---

### Task 5: Add theme-change listener in `setup_tray`

**Files:**
- Modify: `desktop/src/tray.rs` — inside `setup_tray`, after the `TrayIconBuilder` `.build(app)?` call

- [ ] **Step 1: Add the theme-change listener**

Insert the following block inside `setup_tray`, just before the final `Ok(())` return:

```rust
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
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

```bash
cd /workspace/desktop && cargo build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Run all tests**

```bash
cd /workspace/desktop && cargo test 2>&1
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /workspace
git add desktop/src/tray.rs
git commit -m "feat: rebuild tray on macOS theme change for waiting icon"
```

---

### Task 6: Manual verification

The end-to-end behavior is macOS UI–level and cannot be covered by unit tests. Verify manually after building.

- [ ] **Step 1: Start the dev app**

```bash
cd /workspace && ./scripts/dev.sh
```

- [ ] **Step 2: Trigger a waiting run**

In the app, start or simulate a run that enters `waiting` or `awaiting_resume` state. The tray icon should show the waiting indicator.

- [ ] **Step 3: Toggle system appearance and verify icons**

Open System Settings → Appearance and switch between Light and Dark mode while a run is in the waiting state. Verify:
- **Dark mode:** tray shows the existing white-subject icon (orange dot visible against dark menu bar).
- **Light mode:** tray shows the new dark-subject icon (dark subject visible against light menu bar).

- [ ] **Step 4: Verify the normal (non-waiting) icon is unchanged**

With no waiting runs, toggle between Light and Dark mode. The normal tray icon should continue to adapt correctly via macOS template mode in both appearances.
