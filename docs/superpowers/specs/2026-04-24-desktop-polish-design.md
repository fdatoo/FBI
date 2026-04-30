# Desktop Polish Implementation Design

## Overview

Three targeted improvements to make the FBI desktop app feel like a first-class macOS app rather than a wrapped web page: a custom frameless title bar with traffic lights, a custom context menu replacing the default browser one, and a proper macOS app menu.

---

## 1. Frameless Window + Custom Title Bar

### What changes

Remove the native OS title bar and replace it with a custom header that integrates traffic light window controls inline with the existing FBI topbar.

### Tauri config

`desktop/tauri.conf.json` — add `decorations: false` to the window config:

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "FBI",
        "decorations": false,
        ...
      }
    ]
  }
}
```

### Topbar layout (Option B — chosen)

```
[ ● ● ● ] | ▮ FBI   /runs/60   ···   ⌘K search
```

- Three circles (12px, red `#FF5F56` / yellow `#FFBD2E` / green `#27C93F`) flush left
- Thin vertical divider
- **▮ FBI** logo
- Breadcrumb (existing)
- ⌘K button flush right
- Entire `<header>` has `data-tauri-drag-region` so the window is draggable by the bar
- Interactive children (traffic light buttons, ⌘K button) are naturally clickable — `data-tauri-drag-region` only needs to be on the `<header>` itself; buttons inside it receive click events normally

### Traffic light behaviour

Each button calls the corresponding Tauri window API:

- Red (close): `getCurrentWindow().close()`
- Yellow (minimize): `getCurrentWindow().minimize()`
- Green (maximize): `getCurrentWindow().toggleMaximize()`

Import from `@tauri-apps/api/window`. On web (non-Tauri), the buttons are hidden via `isTauri()` guard.

### Hover state

On hover over the traffic light group, show the ×, −, + symbols inside the circles (matching macOS native behaviour). At rest, circles are solid colour with no symbol.

### Linux

Same layout and CSS circles. Linux has no native traffic light convention, so the circles are purely functional. No hover symbols needed.

---

## 2. Custom Context Menu

### What changes

Suppress the default browser/OS context menu everywhere. Render a custom React context menu component at the cursor position, with items that depend on what was right-clicked.

### Architecture

**`src/web/ui/shell/ContextMenu.tsx`** — the menu component itself. Renders in a React portal (`document.body`), positioned at `{x, y}`, constrained to viewport bounds.

**`src/web/ui/shell/contextMenuRegistry.ts`** — a registry (same pattern as `sidebarRegistry`, `paletteRegistry`) that lets features declare what items appear when their elements are right-clicked. Items are declared via a `data-context-id` attribute on DOM elements, or by registering a handler for a context ID.

**Global handler in `AppShell`** — `document.addEventListener('contextmenu', handler)` intercepts all right-clicks:
1. Calls `e.preventDefault()`
2. Checks if the target or any ancestor has `data-context-id`
3. If yes: looks up registered items for that context ID, opens menu at cursor
4. If target is `<input>`, `<textarea>`, or there is a non-empty `window.getSelection()`: always adds Copy / Paste / Select All items
5. If no items: menu does not appear

### Menu item type

```typescript
interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}
```

### Initial context IDs and items

| `data-context-id` | Items |
|---|---|
| `run-row` | Open, Copy run ID, Copy branch name |
| `run-detail` | Copy run ID, Copy branch name |
| (text selection / input) | Copy, Paste, Select All |

### Styling

Matches OS-native dark panel: `bg-#2c2c2e`, `border-border-strong`, `border-radius: 8px`, `box-shadow` with blur, 12px font. Items highlight on hover with `bg-accent` (using the existing accent token).

---

## 3. macOS App Menu

### What changes

Replace the default Tauri-generated menu (which includes Services, Speech, Substitutions, etc.) with a minimal, FBI-specific menu built in Rust.

### Menu structure

**FBI**
- About FBI
- Check for Updates…
- ─────
- Settings… `⌘,`
- ─────
- Hide FBI `⌘H`
- Hide Others `⌥⌘H`
- ─────
- Quit FBI `⌘Q`

**Edit**
- Undo `⌘Z`
- Redo `⇧⌘Z`
- ─────
- Cut `⌘X`
- Copy `⌘C`
- Paste `⌘V`
- Select All `⌘A`

**Window**
- Minimize `⌘M`
- Zoom
- ─────
- Close `⌘W`

**Help**
- Keyboard Shortcuts… `?`
- Open GitHub Issues…

### Implementation

Built in `desktop/src/menu.rs`, called from `main.rs` during app setup. Uses Tauri's `MenuBuilder` / `SubmenuBuilder` API.

`Settings ⌘,` — emits a Tauri event `navigate` with payload `"/settings"`, frontend listener in `App.tsx` calls `nav("/settings")`.

`Check for Updates…` — triggers the updater plugin check (same logic as the background check, but surfaced to the user with a dialog on result).

`Keyboard Shortcuts… ?` — emits a Tauri event `open-cheatsheet`; `App.tsx` listens and calls `setCheatsheet(true)`.

`Open GitHub Issues…` — uses `tauri-plugin-opener` (`opener::open_url`). This plugin is not yet in the project; add it to `desktop/Cargo.toml` and register it in `main.rs`.

The Edit and Window submenus use `PredefinedMenuItem` variants where available so macOS wires up the correct system behaviours.

### Linux / Windows

Same menu is applied on all platforms. `Check for Updates…` and standard keyboard shortcuts work cross-platform. `Hide FBI` / `Hide Others` are macOS-only behaviours but the menu items are harmless on other platforms.

---

## Files changed

| File | Change |
|---|---|
| `desktop/tauri.conf.json` | Add `"decorations": false` to window config |
| `desktop/src/menu.rs` | New file — builds the custom app menu |
| `desktop/src/main.rs` | Call `menu::build_menu()` during setup; register `open-cheatsheet` and `navigate` event handlers |
| `desktop/Cargo.toml` | Add `tauri-plugin-opener = "2"` |
| `src/web/ui/shell/Topbar.tsx` | Add traffic light buttons; add `data-tauri-drag-region`; guard on `isTauri()` |
| `src/web/ui/shell/ContextMenu.tsx` | New file — context menu component + portal |
| `src/web/ui/shell/contextMenuRegistry.ts` | New file — registry for context items |
| `src/web/ui/shell/AppShell.tsx` | Mount global `contextmenu` listener; render `<ContextMenu>` |
| `src/web/pages/RunDetail.tsx` (and run list) | Add `data-context-id="run-row"` / `"run-detail"` attributes and register items |
| `src/web/App.tsx` | Listen for `open-cheatsheet` Tauri event; pass setter to shell |

---

## Out of scope

- Windows-specific title bar chrome (Minimize/Maximize/Close on the right) — Linux/Windows get the same CSS circles for now
- Context menu on the terminal pane (terminal has its own selection behaviour; leave it alone)
- Keyboard navigation within the context menu (arrow keys) — follow-up
