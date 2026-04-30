# Keyboard Pane Navigation & Run Shortcuts

**Date:** 2026-04-25

## Overview

Four related keyboard features that let power users navigate the FBI UI without a mouse:

1. **Mod+1–9 shortcuts** — hold Cmd/Ctrl to reveal numbered hints on active runs (and active projects); press the shortcut to jump there
2. **Pane focus + arrow key navigation** — ArrowLeft/Right moves focus between the three horizontal panes; ArrowDown/Up moves between the terminal and bottom drawer within the run detail area
3. **Shift+Tab drawer tab cycling** — cycles through the bottom drawer's tabs (changes → ship → tunnel → meta)
4. **KeyMap shift fix** — prerequisite bugfix so `shift+tab` doesn't collide with plain `tab`

---

## Layout Model

The app has three horizontal pane columns (left to right):

| Order | Pane ID | Component | When visible |
|---|---|---|---|
| 0 | `projects-sidebar` | `<Sidebar>` in AppShell | Always (unless `hideSidebar`) |
| 1 | `runs-sidebar` | `<RunsList>` in ProjectDetail / RunsPage | On `/projects/:id` and `/runs` |
| 2 | `run-terminal` | Terminal area in `<RunDetailPage>` | On any run detail route |

Within the run detail area, a vertical sub-axis:

| Vertical position | Pane ID | Component |
|---|---|---|
| top | `run-terminal` | RunTerminal |
| bottom | `run-bottom` | RunDrawer |

---

## Architecture

### PaneFocusContext (`ui/shell/PaneFocusContext.tsx`) — new file

```
PaneFocusProvider
  state: focusedPane: PaneId | null
  state: registeredPanes: { id: PaneId; order: number }[]  (sorted by order)
  registerPane(id, order) → cleanup fn
  setFocusedPane(id | null)
```

**Arrow key bindings** — registered once in the provider via `useEffect`:
- `ArrowRight` (not typing, active element not a separator, active element not inside `[data-pane-id="run-terminal"]`): advance to next horizontal pane (order 0→1→2, clamps at ends — no wrap)
- `ArrowLeft` (same guards): retreat to previous horizontal pane
- `ArrowDown` (not typing, focused === 'run-terminal'): set focused to 'run-bottom'
- `ArrowUp` (not typing, focused === 'run-bottom'): set focused to 'run-terminal'

The `[data-pane-id="run-terminal"]` guard prevents ArrowLeft/Right from triggering pane navigation while xterm has DOM focus inside the terminal container.

If `focusedPane` is null when ArrowRight is pressed, focus the lowest-order registered pane.

**Opening the drawer on ArrowDown:** `RunDetailPage` watches `focusedPane === 'run-bottom'` in a `useEffect` and calls `setDrawerOpen(true)` if the drawer is closed.

**Exported hooks:**
- `usePaneFocus(id: PaneId): { isFocused: boolean; focus: () => void }` — returns focus state and a setter; does NOT register (registration is separate)
- `usePaneRegistration(id: PaneId, order: number): void` — registers the pane on mount, cleans up on unmount

**Visual indicator:** Each pane wrapper applies `border-t-2 border-accent` when `isFocused`. The border is only visible when a pane IS focused (null state = no borders shown anywhere). A click anywhere inside a pane calls `focus()`.

**Separator guard:** The ArrowLeft/Right global bindings check `document.activeElement?.getAttribute('role') !== 'separator'` to avoid double-firing with the sidebar resize handle.

---

### `useModifierKeyHeld` hook — new file (`hooks/useModifierKeyHeld.ts`)

Listens to `keydown` / `keyup` on `window`; returns `true` while `e.metaKey || e.ctrlKey` is held. Resets on `window blur`.

---

### KeyMap shift fix (`ui/shell/KeyMap.ts`)

Current gap: `parse()` extracts `shift` from chord strings but `onKey` never checks it, so `shift+tab` matches any `tab` press (and vice versa).

Fix: in `onKey`, read `const shift = e.shiftKey` and add `if (p.shift !== shift) continue;` in the single-binding match loop, alongside the existing `p.mod !== mod` check.

---

## Feature Details

### Mod+1–9 for active runs (RunsList)

- **Active run** = state in `{ starting, running, waiting, awaiting_resume, queued }`
- Take the first 9 active runs in the flat navigation order (same order as `flatForNav`, which already puts active runs first)
- When `modifierHeld && isFocused('runs-sidebar')`: render a `<Kbd>` badge (`⌘1`…`⌘9`) on the right side of each active RunRow (passed as an optional `shortcutLabel` prop)
- Register `mod+1` through `mod+9` in a single `useEffect` (stable ref for live data), guarded by `when: () => focusedPane === 'runs-sidebar'`
- On activation: `nav(toHref(activeRuns[n - 1]))`
- The hints appear/disappear smoothly (no animation needed — just conditional render)

### Mod+1–9 for active projects (Sidebar)

- **Active project** = `hasRunning || hasWaiting`
- Take the first 9 active projects from the `projects` prop (in prop order)
- Same badge rendering on the project NavLink row; same `useEffect` pattern
- Bindings guarded by `when: () => focusedPane === 'projects-sidebar'`
- On activation: `nav(`/projects/${project.id}`)`

### RunRow shortcut label

`RunRow` receives an optional `shortcutLabel?: string` prop (e.g. `"1"`, `"2"`). When provided, renders `<Kbd className="ml-auto text-[11px]">⌘{shortcutLabel}</Kbd>` before the pill. The `⌘` vs `Ctrl` symbol is determined by `navigator.platform.includes('Mac')` (same pattern used in `Cheatsheet.tsx`).

### Shift+Tab drawer tab cycling

In `RunDrawer`, register `shift+tab` binding via `useKeyBinding`:
- `when: () => open`
- Cycles tabs forward: `changes → ship → tunnel → meta → changes`
- `description: 'Cycle drawer tab'`

The tab cycle also opens the drawer if it is closed.

---

## Files Changed

| File | Type | Summary |
|---|---|---|
| `src/web/ui/shell/PaneFocusContext.tsx` | new | Context, provider, `usePaneFocus`, `usePaneRegistration` |
| `src/web/ui/shell/AppShell.tsx` | edit | Wrap with `<PaneFocusProvider>` |
| `src/web/ui/shell/KeyMap.ts` | edit | Fix shift matching in `onKey` |
| `src/web/hooks/useModifierKeyHeld.ts` | new | Cmd/Ctrl hold tracker |
| `src/web/ui/shell/Sidebar.tsx` | edit | Register pane, click-to-focus, mod hints + mod+1–9 |
| `src/web/features/runs/RunsList.tsx` | edit | Register pane, click-to-focus, mod hints + mod+1–9 |
| `src/web/features/runs/RunRow.tsx` | edit | Accept `shortcutLabel` prop |
| `src/web/features/runs/RunDrawer.tsx` | edit | Shift+Tab tab cycling |
| `src/web/pages/RunDetail.tsx` | edit | Register `run-terminal` and `run-bottom` panes, click-to-focus |

---

## Out of Scope

- Animating pane focus transitions
- Persisting the focused pane across navigation
- Keyboard navigation *within* a focused pane (j/k for runs already exists; terminal scrolling is native)
- Screen reader / accessibility audit (follow-up)
