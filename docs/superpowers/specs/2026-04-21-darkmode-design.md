# Dark Mode Design

**Date:** 2026-04-21  
**Status:** Approved

## Overview

Add dark mode to the FBI web app using Tailwind CSS's `class`-based dark mode strategy. The user can manually toggle between light and dark, with the initial state defaulting to the OS preference (`prefers-color-scheme`). The preference is persisted in `localStorage`.

## Architecture

### New files

**`src/web/lib/theme.ts`** — `useTheme()` hook  
- On init: reads `localStorage` key `fbi-theme` (`"dark"` | `"light"` | absent)  
- If absent, checks `window.matchMedia('(prefers-color-scheme: dark)')` for the default  
- Applies/removes the `dark` class on `document.documentElement`  
- Watches `prefers-color-scheme` for live OS-level changes (only when no localStorage override exists)  
- Returns `{ theme, toggle }` — `theme` is `"dark" | "light"`, `toggle` flips and persists to `localStorage`

**`src/web/components/ThemeToggle.tsx`** — icon button  
- Renders ☾ when in light mode (clicking → dark), ☀ when in dark mode (clicking → light)  
- Consumes `useTheme()` directly (no prop drilling needed)  
- Placed at the far right of the nav bar in `Layout.tsx`

### Modified files

**`tailwind.config.ts`**  
- Add `darkMode: 'class'`

**`src/web/index.html`**  
- Add an inline `<script>` in `<head>`, before any stylesheet, that reads `localStorage` and applies the `dark` class to `<html>` synchronously — prevents the flash of light content on page load when the user has dark mode saved

**`src/web/components/Layout.tsx`**  
- Import and render `<ThemeToggle />` on the far-right of the nav (`ml-auto`)  
- Add `bg-white dark:bg-gray-900` to the root `min-h-screen` div  
- Add `dark:bg-gray-900 dark:border-gray-700` to the nav  
- Add `dark:text-gray-500` to the footer

## Color Palette

All `dark:` variants are additive — the existing light-mode classes are unchanged.

| Surface | Light | Dark added |
|---|---|---|
| Page background | `bg-white` | `dark:bg-gray-900` |
| Nav | `bg-white border-b` | `dark:bg-gray-900 dark:border-gray-700` |
| Elevated cards | `bg-white border` | `dark:bg-gray-800 dark:border-gray-700` |
| Inputs / textareas | `border` | `dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100` |
| Muted text | `text-gray-500` | `dark:text-gray-400` |
| Nav links | `text-gray-700` | `dark:text-gray-300` |
| Links | `text-blue-700` | `dark:text-blue-400` |
| Inline links | `text-blue-600` | `dark:text-blue-400` |
| Primary button | `bg-blue-600 hover:bg-blue-700` | `dark:bg-blue-500 dark:hover:bg-blue-600` |
| Ghost button | `border` | `dark:border-gray-600 dark:text-gray-200` |
| State badge — queued | `bg-gray-200 text-gray-800` | `dark:bg-gray-700 dark:text-gray-200` |
| State badge — running | `bg-blue-200 text-blue-800` | `dark:bg-blue-900 dark:text-blue-200` |
| State badge — succeeded | `bg-green-200 text-green-800` | `dark:bg-green-900 dark:text-green-200` |
| State badge — failed | `bg-red-200 text-red-800` | `dark:bg-red-900 dark:text-red-200` |
| State badge — cancelled | `bg-yellow-200 text-yellow-800` | `dark:bg-yellow-900 dark:text-yellow-200` |
| Code inline | `bg-gray-100` | `dark:bg-gray-800` |
| Footer / dim text | `text-gray-400` | `dark:text-gray-500` |

**No changes to the terminal.** `Terminal.tsx` uses xterm.js with a hardcoded `#111827` background — it's already dark and looks correct in both modes.

**No changes to the `bg-gray-800 text-white` "New Run" button** — it's dark enough to work in both modes.

## Files changed

| File | Change |
|---|---|
| `tailwind.config.ts` | Add `darkMode: 'class'` |
| `src/web/index.html` | Flash-prevention inline script |
| `src/web/lib/theme.ts` | New — `useTheme()` hook |
| `src/web/components/ThemeToggle.tsx` | New — toggle button |
| `src/web/components/Layout.tsx` | Add toggle, dark: variants |
| `src/web/components/StateBadge.tsx` | dark: variants on all badge colors |
| `src/web/components/SecretsEditor.tsx` | dark: variants on card, inputs, buttons |
| `src/web/pages/Projects.tsx` | dark: variants on cards, links, buttons |
| `src/web/pages/ProjectDetail.tsx` | dark: variants on card, links, buttons |
| `src/web/pages/Runs.tsx` | dark: variants on list, links |
| `src/web/pages/RunDetail.tsx` | dark: variants on code, details, buttons |
| `src/web/pages/NewProject.tsx` | dark: variants on inputs |
| `src/web/pages/EditProject.tsx` | dark: variants on inputs |
| `src/web/pages/NewRun.tsx` | dark: variants on textarea |
