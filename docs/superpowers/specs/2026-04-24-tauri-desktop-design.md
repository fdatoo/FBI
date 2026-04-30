# FBI — Tauri Desktop App Design

**Date:** 2026-04-24
**Project:** FBI
**Status:** Approved for implementation planning

## 1. Overview

Add a native desktop app for FBI targeting macOS and Linux. The app is a thin Tauri v2 wrapper around the existing React SPA: the frontend is compiled into the binary and makes API calls to a user-configured remote FBI server (running unchanged on its current systemd host). No local Docker, no local server.

### Goals

- Provide a native windowed experience instead of a browser tab.
- Server picker with Tailscale auto-discovery on first launch and via Settings.
- System tray with active-run badge and quick-open menu.
- OS notifications when a run finishes or fails.
- macOS and Linux builds from a GitHub Actions release workflow.

### Non-goals

- Running FBI's backend locally (Docker, SQLite, Node all stay on the remote server).
- Windows support.
- In-app updates / auto-updater.
- Multiple simultaneous server connections.

## 2. Architecture

The Tauri app embeds the React SPA as its webview content. In production the webview loads from the embedded `tauri://localhost` origin; in dev it proxies to the Vite dev server at `http://localhost:5173`.

On startup, Rust reads a stored server URL from Tauri's Store plugin. If none is set, the webview renders `<ServerPicker />` full-screen. Once a URL is selected, all HTTP and WebSocket calls in `api.ts` are prefixed with that URL. The rest of the React app is unchanged.

The FBI Fastify server gains `@fastify/cors` allowing `tauri://localhost` and `http://localhost:5173` so API calls from the Tauri webview are accepted.

```
┌─────────────────────────────────────────┐
│  Desktop (macOS / Linux)                │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │  Tauri window                    │   │
│  │  ┌────────────────────────────┐  │   │
│  │  │  React SPA (embedded)      │  │   │
│  │  │  api.ts → {serverUrl}/api/ │  │   │
│  │  └────────────────────────────┘  │   │
│  │  System tray  Notifications      │   │
│  └───────────────┬──────────────────┘   │
└──────────────────┼──────────────────────┘
                   │ HTTP + WS (Tailscale)
┌──────────────────▼──────────────────────┐
│  Remote server (unchanged)              │
│  Fastify + CORS + Docker + SQLite       │
└─────────────────────────────────────────┘
```

## 3. Components

### 3.1 `desktop/` — Rust / Tauri

Standard Tauri v2 project layout:

```
desktop/
  Cargo.toml
  tauri.conf.json          # points at ../dist/web as frontendDist
  src/
    main.rs                # app bootstrap, window, tray init, command registration
    config.rs              # get_server_url / set_server_url via Tauri Store plugin
    tray.rs                # tray icon, badge update, menu
    discovery.rs           # discover_servers() — Tailscale probe
```

**Tauri commands exposed to React:**

| Command | Args | Returns |
|---|---|---|
| `get_server_url` | — | `String` |
| `set_server_url` | `{ url: String }` | — |
| `discover_servers` | — | `Vec<{ name, url }>` |
| `update_tray` | `{ active: u32 }` | — |
| `notify` | `{ title: String, body: String }` | — |

**Tauri plugins required:**
- `tauri-plugin-store` — persistent config
- `tauri-plugin-notification` — OS notifications

**CSP note:** `tauri.conf.json` must set `connect-src 'self' http://* https://* ws://* wss://*` so the webview's `fetch()` and WebSocket connections to the (user-configured) remote server are permitted. Without this, Tauri's default restrictive CSP blocks them.

### 3.2 Frontend changes (`src/web/`)

**`lib/serverConfig.ts`** (new)

Wraps `invoke('get_server_url')` / `invoke('set_server_url')`. Returns `''` when not running inside Tauri (preserving the existing web deployment's relative-URL behaviour).

**`lib/api.ts`**

`ApiClient` constructor accepts an optional `baseUrl: string`. All `fetch('/api/...')` calls become `fetch(`${baseUrl}/api/...`)`. WebSocket URLs likewise. The default remains `''` for the web build.

**`pages/ServerPicker.tsx`** (new)

Full-window screen shown when no server URL is stored:
- Text input pre-filled with `http://`
- "Discover" button → calls `invoke('discover_servers')` → renders responding hosts as a list
- Clicking a host fills the input; "Connect" calls `setServerUrl(url)` then re-renders main app
- Inline error if Tailscale unreachable ("No servers found — enter a URL manually")

**`main.tsx`**

On mount: reads stored URL via `getServerUrl()`. If empty → renders `<ServerPicker />`; otherwise bootstraps `ApiClient` with that URL and renders `<App />`.

**`hooks/useRunWatcher.ts`**

Existing state-change detection gains:
1. `invoke('update_tray', { active })` after each poll — updates tray badge
2. `invoke('notify', { title: 'FBI', body: 'Run #N finished' })` on `done` / `failed` transitions

Both calls are fire-and-forget (no await, errors silently dropped) and are no-ops outside Tauri via a `isTauri()` guard.

**`pages/Settings.tsx`** (minor addition)

"Change server" button → calls `setServerUrl('')` then re-renders `<ServerPicker />`.

### 3.3 Server changes (`src/server/index.ts`)

Add `@fastify/cors`:

```ts
await app.register(fastifyCors, {
  origin: ['tauri://localhost', 'http://localhost:5173'],
});
```

## 4. Data Flow

1. App launch → Rust reads stored URL from Tauri Store.
2. No URL → webview renders `<ServerPicker />`.
3. User clicks "Discover" → `discover_servers()`:
   - Rust GETs `http://100.100.100.100/localapi/v0/status` (Tailscale magic IP).
   - Extracts all peer `DNSName` / `TailscaleIPs` entries.
   - Probes each at `:3000/api/health` with 2-second timeout.
   - Returns responding hosts.
4. User confirms URL → `set_server_url(url)` → `main.tsx` re-renders `<App />`.
5. `ApiClient` prefixes all HTTP calls with stored URL; WebSocket URLs are derived by replacing `http://` → `ws://` and `https://` → `wss://` in the stored URL before appending `/api/ws`.
6. `useRunWatcher` polls every 5 s:
   - Calls `update_tray({ active: N })` → Rust redraws badge.
   - On run completion/failure → calls `notify(...)` → Rust fires OS notification.

## 5. System Tray

- **Idle** (0 active): standard FBI icon.
- **Active** (N > 0): icon + numeric badge.
- **Menu:** "Open FBI" (focus window) | separator | "Quit".
- macOS: menu-bar icon. Linux: system-tray icon (requires `libayatana-appindicator` or equivalent on the host).

## 6. Auto-discovery

Implemented entirely in Rust (`discovery.rs`). Queries Tailscale's local daemon at `http://100.100.100.100/localapi/v0/status`. If the daemon is unreachable (Tailscale not running), returns an empty list immediately — no hang. Probes are parallelised with a 2-second per-host timeout.

Fallback: manual URL entry always available regardless of discovery result.

## 7. Build Pipeline

### Local scripts

```json
"tauri:dev":   "tauri dev",
"tauri:build": "npm run build:web && tauri build"
```

`tauri dev` starts the Vite dev server and opens the Tauri window pointed at it. `tauri:build` compiles the web assets first then invokes the Tauri bundler.

### GitHub Actions (`.github/workflows/desktop.yml`)

Triggers on version tags (`v*`). Two parallel jobs:

| Job | Runner | Artifacts |
|---|---|---|
| `build-macos` | `macos-latest` | `.app`, `.dmg` |
| `build-linux` | `ubuntu-latest` | `.deb`, `.AppImage` |

Artifacts are uploaded to the GitHub release. No cross-compilation — each platform builds natively.

### Directory layout after integration

```
desktop/          ← new (Rust/Tauri)
cli/              ← unchanged
src/
  server/         ← unchanged except @fastify/cors
  web/            ← small additions: serverConfig, ServerPicker, api baseUrl
  shared/         ← unchanged
```

## 8. Error handling

- **Server unreachable at startup:** `<ServerPicker />` is shown again with an error banner ("Could not connect — check the URL or pick a different server").
- **Connection lost mid-session:** existing `useConnectionState` / WS reconnect logic handles this; Tauri adds nothing.
- **Notification permission denied:** silently suppressed (fire-and-forget).
- **Tailscale not running:** `discover_servers` returns `[]`; UI shows inline message, manual entry still works.
