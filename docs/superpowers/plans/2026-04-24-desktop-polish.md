# Desktop Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FBI desktop app feel like a first-class macOS citizen by adding custom window controls, a context menu, and a proper app menu.

**Architecture:** Three independent layers — Rust-side app menu (Tauri `MenuBuilder`), a frameless window with CSS traffic lights in the Topbar, and a React context menu component backed by a registry. The registry follows the existing `paletteRegistry` / `sidebarRegistry` patterns already in the codebase.

**Tech Stack:** Tauri v2, `tauri-plugin-opener`, React + Tailwind, `@tauri-apps/api/window`, Vitest.

---

## File map

| File | Change |
|---|---|
| `desktop/Cargo.toml` | Add `tauri-plugin-opener = "2"` |
| `desktop/src/menu.rs` | **New** — builds the custom FBI / Edit / Window / Help menu |
| `desktop/src/main.rs` | Register opener plugin, set app menu, handle menu events |
| `desktop/tauri.conf.json` | Add `"decorations": false` to window config |
| `src/web/ui/tokens.css` | Add `--traffic-red`, `--traffic-yellow`, `--traffic-green` tokens |
| `src/web/ui/shell/Topbar.tsx` | Add traffic light buttons; `data-tauri-drag-region` on header |
| `src/web/ui/shell/contextMenuRegistry.ts` | **New** — registry mapping context-IDs to item factories |
| `src/web/ui/shell/ContextMenu.tsx` | **New** — portal component; mounts global `contextmenu` listener |
| `src/web/ui/shell/AppShell.tsx` | Render `<ContextMenu />` |
| `src/web/ui/shell/index.ts` | Export new ContextMenu and contextMenuRegistry |
| `src/web/App.tsx` | Listen for `navigate` and `open-cheatsheet` Tauri events |
| `src/web/features/runs/RunRow.tsx` | Add `data-context-id="run-row"` + data attributes |
| `src/web/features/runs/RunsList.tsx` | Register `run-row` context items |
| `src/web/pages/RunDetail.tsx` | Add `data-context-id="run-detail"` + register items |

---

### Task 1: Add tauri-plugin-opener dependency

**Files:**
- Modify: `desktop/Cargo.toml`
- Modify: `desktop/src/main.rs`

- [ ] **Step 1: Add the dependency to Cargo.toml**

Open `desktop/Cargo.toml`. In the `[dependencies]` section, add after `tauri-plugin-updater = "2"`:

```toml
tauri-plugin-opener = "2"
```

- [ ] **Step 2: Register the plugin in main.rs**

Open `desktop/src/main.rs`. Add the opener plugin after the updater plugin line:

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_opener::init())
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /workspace/desktop && cargo build 2>&1 | tail -5`

Expected: `Finished` line with no errors. The first build will fetch `tauri-plugin-opener` from crates.io.

- [ ] **Step 4: Commit**

```bash
git add desktop/Cargo.toml desktop/Cargo.lock desktop/src/main.rs
git commit -m "feat(desktop): add tauri-plugin-opener"
```

---

### Task 2: Build custom app menu in Rust

**Files:**
- Create: `desktop/src/menu.rs`
- Modify: `desktop/src/main.rs` (add `mod menu;`)

- [ ] **Step 1: Create desktop/src/menu.rs**

```rust
use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    Manager,
};

pub fn build_menu<R: tauri::Runtime>(
    app: &impl Manager<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let about = PredefinedMenuItem::about(app, Some("About FBI"), None)?;
    let check_updates =
        MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
    let settings =
        MenuItem::with_id(app, "settings", "Settings…", true, Some("cmd+,"))?;
    let hide = PredefinedMenuItem::hide(app, Some("Hide FBI"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some("Hide Others"))?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit FBI"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let fbi_menu = SubmenuBuilder::new(app, "FBI")
        .item(&about)
        .item(&check_updates)
        .item(&sep)
        .item(&settings)
        .item(&sep2)
        .item(&hide)
        .item(&hide_others)
        .item(&sep3)
        .item(&quit)
        .build()?;

    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_sep = PredefinedMenuItem::separator(app)?;
    let edit_sep2 = PredefinedMenuItem::separator(app)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .item(&edit_sep)
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&edit_sep2)
        .item(&select_all)
        .build()?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, None)?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    let win_sep = PredefinedMenuItem::separator(app)?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&minimize)
        .item(&zoom)
        .item(&win_sep)
        .item(&close)
        .build()?;

    let kb_shortcuts =
        MenuItem::with_id(app, "keyboard-shortcuts", "Keyboard Shortcuts…", true, None::<&str>)?;
    let github_issues =
        MenuItem::with_id(app, "github-issues", "Open GitHub Issues…", true, None::<&str>)?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&kb_shortcuts)
        .item(&github_issues)
        .build()?;

    MenuBuilder::new(app)
        .item(&fbi_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}
```

- [ ] **Step 2: Declare the module in main.rs**

Add `mod menu;` after `mod tray;` at the top of `desktop/src/main.rs`:

```rust
mod config;
mod discovery;
mod menu;
mod tray;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /workspace/desktop && cargo build 2>&1 | tail -5`

Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/menu.rs desktop/src/main.rs
git commit -m "feat(desktop): custom app menu (FBI/Edit/Window/Help)"
```

---

### Task 3: Wire menu into main.rs + frontend event listeners

**Files:**
- Modify: `desktop/src/main.rs`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Set app menu and handle menu events in main.rs**

Replace the entire contents of `desktop/src/main.rs` with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod discovery;
mod menu;
mod tray;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            config::get_server_url,
            config::set_server_url,
            tray::update_tray_runs,
            tray::notify,
            discovery::discover_servers,
        ])
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
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
            }
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /workspace/desktop && cargo build 2>&1 | tail -5`

Expected: `Finished` with no errors.

- [ ] **Step 3: Add Tauri event listeners in App.tsx**

Open `src/web/App.tsx`. The file already has a `useEffect` for `navigate-to-run` (around line 113). Add two more effects immediately after it:

```tsx
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<string>('navigate', (e) => {
      nav(e.payload);
    });
    return () => { void unlisten.then((f) => f()); };
  }, [nav]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen('open-cheatsheet', () => {
      setCheatsheet(true);
    });
    return () => { void unlisten.then((f) => f()); };
  }, []);
```

- [ ] **Step 4: Run frontend typecheck**

Run: `cd /workspace && npm run typecheck 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main.rs src/web/App.tsx
git commit -m "feat(desktop): wire app menu events + frontend listeners"
```

---

### Task 4: Frameless window + traffic light Topbar

**Files:**
- Modify: `desktop/tauri.conf.json`
- Modify: `src/web/ui/tokens.css`
- Modify: `src/web/ui/shell/Topbar.tsx`

- [ ] **Step 1: Add decorations: false to tauri.conf.json**

Open `desktop/tauri.conf.json`. Inside the `"windows"` array (the first object), add `"decorations": false`:

```json
{
  "label": "main",
  "title": "FBI",
  "width": 1280,
  "height": 800,
  "minWidth": 800,
  "minHeight": 600,
  "dragDropEnabled": false,
  "decorations": false
}
```

- [ ] **Step 2: Add traffic light color tokens to tokens.css**

Open `src/web/ui/tokens.css`. After the `--terminal-fg` line (line 70), add — these are macOS system traffic light colors, fixed regardless of theme:

```css
  /* macOS traffic light colours — fixed, not theme-dependent */
  --traffic-red: #FF5F56;
  --traffic-yellow: #FFBD2E;
  --traffic-green: #27C93F;
```

- [ ] **Step 3: Rewrite Topbar.tsx**

Replace the entire contents of `src/web/ui/shell/Topbar.tsx` with:

```tsx
import { type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Kbd } from '../primitives/Kbd.js';

export interface TopbarProps {
  breadcrumb: ReactNode;
  onOpenPalette: () => void;
}

function TrafficLights() {
  const win = getCurrentWindow();
  return (
    <div className="group flex items-center gap-[6px] shrink-0">
      <button
        type="button"
        onClick={() => void win.close()}
        className="w-3 h-3 rounded-full flex items-center justify-center bg-[var(--traffic-red)] hover:brightness-110 focus-visible:outline-none"
        aria-label="Close window"
      >
        <span className="opacity-0 group-hover:opacity-100 text-[7px] text-black/50 font-bold leading-none select-none">×</span>
      </button>
      <button
        type="button"
        onClick={() => void win.minimize()}
        className="w-3 h-3 rounded-full flex items-center justify-center bg-[var(--traffic-yellow)] hover:brightness-110 focus-visible:outline-none"
        aria-label="Minimize window"
      >
        <span className="opacity-0 group-hover:opacity-100 text-[7px] text-black/50 font-bold leading-none select-none">−</span>
      </button>
      <button
        type="button"
        onClick={() => void win.toggleMaximize()}
        className="w-3 h-3 rounded-full flex items-center justify-center bg-[var(--traffic-green)] hover:brightness-110 focus-visible:outline-none"
        aria-label="Maximize window"
      >
        <span className="opacity-0 group-hover:opacity-100 text-[7px] text-black/50 font-bold leading-none select-none">+</span>
      </button>
    </div>
  );
}

export function Topbar({ breadcrumb, onOpenPalette }: TopbarProps) {
  const inTauri = isTauri();
  const dragProps = inTauri ? { 'data-tauri-drag-region': '' } : {};
  return (
    <header
      className="h-[36px] flex items-center gap-2 px-3 border-b border-border-strong bg-surface"
      {...dragProps}
    >
      {inTauri && <TrafficLights />}
      {inTauri && <div className="w-px h-[14px] bg-border-strong shrink-0" />}
      <span className="font-semibold text-[15px] tracking-tight shrink-0">▮ FBI</span>
      <span className="font-mono text-[13px] text-text-faint truncate">{breadcrumb}</span>
      <button
        type="button"
        onClick={onOpenPalette}
        className="ml-auto flex items-center gap-1 text-[13px] text-text-faint hover:text-text shrink-0"
        aria-label="Open command palette"
      >
        <Kbd>⌘</Kbd><Kbd>K</Kbd><span>search</span>
      </button>
    </header>
  );
}
```

- [ ] **Step 4: Write a test for the traffic light buttons**

Create `src/web/ui/shell/Topbar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Topbar } from './Topbar.js';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
  }),
}));

describe('Topbar (Tauri mode)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders traffic light buttons', () => {
    render(<Topbar breadcrumb="/runs/1" onOpenPalette={() => {}} />);
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize window' })).toBeInTheDocument();
  });

  it('renders the FBI logo and breadcrumb', () => {
    render(<Topbar breadcrumb="/runs/42" onOpenPalette={() => {}} />);
    expect(screen.getByText('▮ FBI')).toBeInTheDocument();
    expect(screen.getByText('/runs/42')).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run tests**

Run: `cd /workspace && npm test -- Topbar 2>&1 | tail -15`

Expected: 2 tests pass.

- [ ] **Step 6: Typecheck**

Run: `cd /workspace && npm run typecheck 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add desktop/tauri.conf.json src/web/ui/tokens.css src/web/ui/shell/Topbar.tsx src/web/ui/shell/Topbar.test.tsx
git commit -m "feat(desktop): frameless window with traffic light controls"
```

---

### Task 5: Context menu registry

**Files:**
- Create: `src/web/ui/shell/contextMenuRegistry.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/ui/shell/contextMenuRegistry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { contextMenuRegistry } from './contextMenuRegistry.js';

describe('contextMenuRegistry', () => {
  beforeEach(() => { contextMenuRegistry._reset(); });

  it('returns empty array for unregistered context ID', () => {
    const el = document.createElement('div');
    expect(contextMenuRegistry.resolve('unknown', el)).toEqual([]);
  });

  it('returns items from a registered factory', () => {
    const el = document.createElement('div');
    el.dataset.contextRunId = '42';
    contextMenuRegistry.register('run-row', (target) => [
      { id: 'copy-id', label: 'Copy run ID', onSelect: () => {} },
    ]);
    const items = contextMenuRegistry.resolve('run-row', el);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Copy run ID');
  });

  it('unregisters on cleanup', () => {
    const el = document.createElement('div');
    const off = contextMenuRegistry.register('run-row', () => [
      { id: 'x', label: 'X', onSelect: () => {} },
    ]);
    off();
    expect(contextMenuRegistry.resolve('run-row', el)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && npm test -- contextMenuRegistry 2>&1 | tail -10`

Expected: FAIL — `contextMenuRegistry` not found.

- [ ] **Step 3: Create contextMenuRegistry.ts**

```typescript
export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  onSelect: () => void;
}

export type ContextItemFactory = (el: HTMLElement) => readonly ContextMenuItem[];

class Registry {
  private factories = new Map<string, ContextItemFactory>();

  register(contextId: string, factory: ContextItemFactory): () => void {
    this.factories.set(contextId, factory);
    return () => { this.factories.delete(contextId); };
  }

  resolve(contextId: string, el: HTMLElement): readonly ContextMenuItem[] {
    return this.factories.get(contextId)?.(el) ?? [];
  }

  _reset(): void { this.factories.clear(); }
}

export const contextMenuRegistry = new Registry();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && npm test -- contextMenuRegistry 2>&1 | tail -10`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/ui/shell/contextMenuRegistry.ts src/web/ui/shell/contextMenuRegistry.test.ts
git commit -m "feat(web): context menu registry"
```

---

### Task 6: ContextMenu component

**Files:**
- Create: `src/web/ui/shell/ContextMenu.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/web/ui/shell/ContextMenu.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from './ContextMenu.js';
import { contextMenuRegistry } from './contextMenuRegistry.js';

describe('ContextMenu', () => {
  beforeEach(() => {
    contextMenuRegistry._reset();
    vi.clearAllMocks();
  });

  it('does not render when no items', () => {
    render(<ContextMenu />);
    fireEvent.contextMenu(document.body);
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });

  it('renders items for a registered context-id', () => {
    contextMenuRegistry.register('run-row', () => [
      { id: 'copy-id', label: 'Copy run ID', onSelect: vi.fn() },
    ]);
    const div = document.createElement('div');
    div.dataset.contextId = 'run-row';
    div.dataset.contextRunId = '5';
    document.body.appendChild(div);

    render(<ContextMenu />);
    fireEvent.contextMenu(div);
    expect(screen.getByText('Copy run ID')).toBeInTheDocument();

    document.body.removeChild(div);
  });

  it('calls onSelect and closes on item click', () => {
    const onSelect = vi.fn();
    contextMenuRegistry.register('run-row', () => [
      { id: 'copy-id', label: 'Copy run ID', onSelect },
    ]);
    const div = document.createElement('div');
    div.dataset.contextId = 'run-row';
    document.body.appendChild(div);

    render(<ContextMenu />);
    fireEvent.contextMenu(div);
    fireEvent.click(screen.getByText('Copy run ID'));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByText('Copy run ID')).toBeNull();

    document.body.removeChild(div);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && npm test -- ContextMenu.test 2>&1 | tail -10`

Expected: FAIL — `ContextMenu` not found.

- [ ] **Step 3: Create ContextMenu.tsx**

```tsx
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { contextMenuRegistry, type ContextMenuItem } from './contextMenuRegistry.js';

interface MenuState {
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
}

function textItems(): ContextMenuItem[] {
  return [
    { id: 'copy', label: 'Copy', shortcut: '⌘C', onSelect: () => { document.execCommand('copy'); } },
    { id: 'paste', label: 'Paste', shortcut: '⌘V', onSelect: () => { document.execCommand('paste'); } },
    { id: 'select-all', label: 'Select All', shortcut: '⌘A', onSelect: () => { document.execCommand('selectAll'); } },
  ];
}

export function ContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      const items: ContextMenuItem[] = [];

      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-context-id]');
      if (el?.dataset.contextId) {
        items.push(...contextMenuRegistry.resolve(el.dataset.contextId, el));
      }

      const target = e.target as HTMLElement;
      const isEditable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as HTMLElement).isContentEditable;
      const hasSelection = (window.getSelection()?.toString().length ?? 0) > 0;
      if (isEditable || hasSelection) {
        if (items.length > 0) items.push({ id: 'sep-text', label: '', separator: true, onSelect: () => {} });
        items.push(...textItems());
      }

      if (items.length === 0) return;

      const menuW = 200;
      const menuH = items.length * 32 + 8;
      const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
      const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
      setMenu({ x, y, items });
    };

    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!menu) return null;

  return createPortal(
    <div
      style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 'var(--z-palette)' } as React.CSSProperties}
      className="bg-surface-raised border border-border-strong rounded-lg shadow-popover py-1 min-w-[180px]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.items.map((item) =>
        item.separator ? (
          <div key={item.id} className="my-1 border-t border-border" />
        ) : (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={() => { item.onSelect(); setMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text hover:bg-accent-subtle hover:text-accent-strong disabled:opacity-40 flex justify-between items-center gap-4"
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="text-text-faint font-mono">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd /workspace && npm test -- ContextMenu.test 2>&1 | tail -15`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/ui/shell/ContextMenu.tsx src/web/ui/shell/ContextMenu.test.tsx
git commit -m "feat(web): ContextMenu component"
```

---

### Task 7: Mount ContextMenu in AppShell + update exports

**Files:**
- Modify: `src/web/ui/shell/AppShell.tsx`
- Modify: `src/web/ui/shell/index.ts`

- [ ] **Step 1: Add ContextMenu to AppShell**

Open `src/web/ui/shell/AppShell.tsx`. Add the import after the existing imports:

```tsx
import { ContextMenu } from './ContextMenu.js';
```

Then, inside the returned JSX, add `<ContextMenu />` right before the closing `</div>`:

```tsx
  return (
    <div className="h-screen w-screen flex flex-col bg-bg text-text">
      <Topbar breadcrumb={breadcrumb} onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex-1 min-h-0 flex">
        {!hideSidebar && <Sidebar projects={projects} collapsed={sidebarCollapsed} />}
        <main className="flex-1 min-w-0 min-h-0 overflow-auto">{children}</main>
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ContextMenu />
    </div>
  );
```

- [ ] **Step 2: Export from index.ts**

Open `src/web/ui/shell/index.ts`. Add two lines at the end:

```ts
export * from './ContextMenu.js';
export * from './contextMenuRegistry.js';
```

- [ ] **Step 3: Typecheck**

Run: `cd /workspace && npm run typecheck 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 4: Run all tests**

Run: `cd /workspace && npm test 2>&1 | tail -15`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/ui/shell/AppShell.tsx src/web/ui/shell/index.ts
git commit -m "feat(web): mount ContextMenu in AppShell"
```

---

### Task 8: Add context IDs to run surfaces

**Files:**
- Modify: `src/web/features/runs/RunRow.tsx`
- Modify: `src/web/features/runs/RunsList.tsx`
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Add data attributes to RunRow**

Open `src/web/features/runs/RunRow.tsx`. The `<NavLink>` element starts at line 31. Add `data-context-id`, `data-context-run-id`, and `data-context-branch` attributes to it:

```tsx
export function RunRow({ run, to }: RunRowProps) {
  const label = run.title || run.branch_name || run.prompt.split('\n')[0] || 'untitled';
  return (
    <NavLink
      to={to}
      data-context-id="run-row"
      data-context-run-id={String(run.id)}
      data-context-branch={run.branch_name ?? ''}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-1.5 border-b border-border text-[14px] transition-colors duration-fast ease-out ${
          isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text'
        }`
      }
    >
```

- [ ] **Step 2: Register run-row context items in RunsList**

Open `src/web/features/runs/RunsList.tsx`. Add the import after the existing imports:

```tsx
import { contextMenuRegistry } from '@ui/shell/contextMenuRegistry.js';
```

Then add a `useEffect` registration inside `RunsList` (after the existing `useKeyBinding` call, before the `return`):

```tsx
  useEffect(() => {
    return contextMenuRegistry.register('run-row', (el) => {
      const runId = el.dataset.contextRunId ?? '';
      const branch = el.dataset.contextBranch ?? '';
      return [
        {
          id: 'open',
          label: 'Open run',
          onSelect: () => nav(`/runs/${runId}`),
        },
        {
          id: 'copy-run-id',
          label: 'Copy run ID',
          onSelect: () => void navigator.clipboard.writeText(`#${runId}`),
        },
        ...(branch
          ? [{
              id: 'copy-branch',
              label: 'Copy branch name',
              onSelect: () => void navigator.clipboard.writeText(branch),
            }]
          : []),
      ];
    });
  }, [nav]);
```

- [ ] **Step 3: Add data attribute to RunDetailPage and register items**

Open `src/web/pages/RunDetail.tsx`. First, add the contextMenuRegistry import after the existing imports:

```tsx
import { contextMenuRegistry } from '@ui/shell/contextMenuRegistry.js';
```

Then find the main `return (` at line 245. The outermost `<div` on line 246 is:
```tsx
<div className="h-full flex flex-col min-h-0">
```

Add `data-context-id` and `data-context-run-id` to it:

```tsx
  return (
    <div
      className="h-full flex flex-col min-h-0"
      data-context-id="run-detail"
      data-context-run-id={String(run.id)}
    >
```

Then add a `useEffect` to register the items (inside `RunDetailPage`, after the other effects):

```tsx
  useEffect(() => {
    if (!run) return;
    return contextMenuRegistry.register('run-detail', () => [
      {
        id: 'copy-run-id',
        label: 'Copy run ID',
        onSelect: () => void navigator.clipboard.writeText(`#${run.id}`),
      },
      ...(run.branch_name
        ? [{
            id: 'copy-branch',
            label: 'Copy branch name',
            onSelect: () => void navigator.clipboard.writeText(run.branch_name!),
          }]
        : []),
    ]);
  }, [run]);
```

- [ ] **Step 4: Typecheck**

Run: `cd /workspace && npm run typecheck 2>&1 | tail -10`

Expected: no errors.

- [ ] **Step 5: Run all tests**

Run: `cd /workspace && npm test 2>&1 | tail -15`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/features/runs/RunRow.tsx src/web/features/runs/RunsList.tsx src/web/pages/RunDetail.tsx
git commit -m "feat(web): add context-menu IDs to run surfaces"
```
