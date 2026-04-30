# Tauri Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing FBI React SPA in a Tauri v2 native desktop app (macOS + Linux) that connects to a user-configured remote FBI server with a server picker, system tray badge, and OS notifications.

**Architecture:** The React SPA is compiled into the Tauri binary; all HTTP and WebSocket calls are prefixed with a user-stored remote server URL. A `<ServerPicker />` screen appears on first launch. The Rust side manages persistent config, the system tray, and Tailscale-based server discovery.

**Tech Stack:** Tauri v2, Rust, `@tauri-apps/api` (JS), `@tauri-apps/cli` (build tool), `tauri-plugin-store`, `tauri-plugin-notification`, `@fastify/cors`, Vitest (existing)

---

## File Map

**New files:**
- `desktop/Cargo.toml` — Rust project manifest
- `desktop/build.rs` — required by Tauri build system
- `desktop/tauri.conf.json` — Tauri app configuration
- `desktop/capabilities/default.json` — Tauri v2 permission declarations
- `desktop/icons/` — app icons (placeholder PNGs)
- `desktop/src/main.rs` — Tauri app entry point, command registration, tray init
- `desktop/src/config.rs` — `get_server_url` / `set_server_url` commands via Store plugin
- `desktop/src/tray.rs` — system tray setup and `update_tray` command
- `desktop/src/discovery.rs` — `discover_servers` command (Tailscale probe)
- `src/web/lib/serverConfig.ts` — Tauri `invoke` wrappers, `isTauri` guard
- `src/web/pages/ServerPicker.tsx` — first-run server picker UI
- `.github/workflows/desktop.yml` — CI release workflow

**Modified files:**
- `src/web/lib/api.ts` — add `setApiBaseUrl()`, `wsBase()`, and prefix support
- `src/web/lib/ws.ts` — use `wsBase()` for shell WebSocket URL
- `src/web/hooks/useRunWatcher.ts` — use `wsBase()` + add `update_tray` / `notify` invoke calls
- `src/web/features/usage/usageStore.ts` — use `api.getUsage()` + `wsBase()`
- `src/web/main.tsx` — add `<Root>` component that gates on server URL
- `src/web/pages/Settings.tsx` — add "Change server" button
- `src/server/index.ts` — register `@fastify/cors`
- `package.json` — add `tauri:dev`, `tauri:build` scripts and new dependencies

---

## Task 1: Add `@fastify/cors` to the server

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Install `@fastify/cors`**

```bash
npm install @fastify/cors
```

Expected: package appears in `node_modules/@fastify/cors`.

- [ ] **Step 2: Register CORS in `src/server/index.ts`**

Add the import after existing `@fastify/` imports (around line 4):
```ts
import fastifyCors from '@fastify/cors';
```

Register it immediately after `await app.register(fastifyWebsocket)` (around line 92):
```ts
await app.register(fastifyCors, {
  origin: ['tauri://localhost', 'http://localhost:5173'],
});
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: passes with no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts package.json package-lock.json
git commit -m "feat(server): add @fastify/cors for Tauri desktop origin"
```

---

## Task 2: Add base URL support to `api.ts`

`api.ts` uses relative paths (`/api/...`). In the Tauri webview, the origin is `tauri://localhost` so relative paths work BUT WebSocket construction uses `location.host` (which is `localhost` in Tauri, not the remote server). We add a module-level base URL and a `wsBase()` helper so all calls can be directed to the configured remote server.

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/lib/api.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setApiBaseUrl, wsBase } from './api.js';

describe('api base URL', () => {
  beforeEach(() => setApiBaseUrl(''));

  it('wsBase defaults to location-derived URL when no base URL set', () => {
    setApiBaseUrl('');
    // happy-dom sets location.protocol to 'about:' which falls back to ws:
    const url = wsBase();
    expect(url).toMatch(/^wss?:\/\//);
  });

  it('wsBase converts http:// server URL to ws://', () => {
    setApiBaseUrl('http://fbi.tailnet:3000');
    expect(wsBase()).toBe('ws://fbi.tailnet:3000');
  });

  it('wsBase converts https:// server URL to wss://', () => {
    setApiBaseUrl('https://fbi.tailnet');
    expect(wsBase()).toBe('wss://fbi.tailnet');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose src/web/lib/api.test.ts
```

Expected: FAIL — `setApiBaseUrl` and `wsBase` are not exported.

- [ ] **Step 3: Add module-level base URL state and exports to `api.ts`**

At the very top of `src/web/lib/api.ts`, before the `xhrUploadJson` function, insert:
```ts
let _baseUrl = '';

export function setApiBaseUrl(url: string): void {
  _baseUrl = url;
}

export function wsBase(): string {
  if (_baseUrl) {
    return _baseUrl.replace(/^http/, 'ws');
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}
```

- [ ] **Step 4: Update `xhrUploadJson` to prepend base URL**

Change the signature to receive the already-resolved URL (it already receives a full path string, so just change the internal open call). Find the line:
```ts
function xhrUploadJson<T>(url: string, file: File, onProgress?: (pct: number) => void): Promise<T> {
```
Change it to use the base URL internally. Replace the body's `xhr.open` call:
```ts
// Old:
xhr.open('POST', url);
// New:
xhr.open('POST', _baseUrl + url);
```

Wait — `xhrUploadJson` already receives `url` as the full relative path (e.g. `/api/draft-uploads`). Change the `xhr.open` line:
```ts
xhr.open('POST', _baseUrl + url);
```

- [ ] **Step 5: Update `request` to prepend base URL**

Find the `request` function body. Change:
```ts
res = await fetch(url, {
```
To:
```ts
res = await fetch(_baseUrl + url, {
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose src/web/lib/api.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 7: Run full test suite to check for regressions**

```bash
npm test
```

Expected: all tests pass (existing api-using tests still work since `_baseUrl` defaults to `''`).

- [ ] **Step 8: Commit**

```bash
git add src/web/lib/api.ts src/web/lib/api.test.ts
git commit -m "feat(web): add setApiBaseUrl and wsBase to api.ts"
```

---

## Task 3: Update WebSocket URL construction in `ws.ts`, `useRunWatcher.ts`, and `usageStore.ts`

Three files hardcode `location.protocol`/`location.host` for WebSocket URLs. They must all use `wsBase()`.

**Files:**
- Modify: `src/web/lib/ws.ts`
- Modify: `src/web/hooks/useRunWatcher.ts`
- Modify: `src/web/features/usage/usageStore.ts`

- [ ] **Step 1: Update `src/web/lib/ws.ts`**

Add import at the top:
```ts
import { wsBase } from './api.js';
```

Replace lines 18–19:
```ts
// Old:
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const url = `${proto}//${location.host}/api/runs/${runId}/shell`;
// New:
const url = `${wsBase()}/api/runs/${runId}/shell`;
```

- [ ] **Step 2: Update `src/web/hooks/useRunWatcher.ts`**

Add import at the top:
```ts
import { wsBase } from '../lib/api.js';
```

Replace the `statesUrl` function (lines 56–59):
```ts
// Old:
function statesUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/ws/states`;
}
// New:
function statesUrl(): string {
  return `${wsBase()}/api/ws/states`;
}
```

- [ ] **Step 3: Update `src/web/features/usage/usageStore.ts`**

Add import at the top:
```ts
import { api, wsBase } from '../../lib/api.js';
```

Replace the `fetchInitial` method body:
```ts
// Old:
private async fetchInitial(): Promise<void> {
  try {
    const res = await fetch('/api/usage');
    if (res.ok) this.apply(await res.json() as UsageState);
  } catch { /* fall through to WS */ }
}
// New:
private async fetchInitial(): Promise<void> {
  try {
    const state = await api.getUsage();
    this.apply(state);
  } catch { /* fall through to WS */ }
}
```

Replace the `connect` method's WebSocket URL (lines 52–53):
```ts
// Old:
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/api/ws/usage`);
// New:
const ws = new WebSocket(`${wsBase()}/api/ws/usage`);
```

- [ ] **Step 4: Typecheck and test**

```bash
npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/ws.ts src/web/hooks/useRunWatcher.ts src/web/features/usage/usageStore.ts
git commit -m "feat(web): use wsBase() for all WebSocket URL construction"
```

---

## Task 4: Create `src/web/lib/serverConfig.ts`

This module wraps Tauri `invoke` calls with an `isTauri()` guard so the same code works in both the web build and the desktop build.

**Files:**
- Create: `src/web/lib/serverConfig.ts`

- [ ] **Step 1: Install `@tauri-apps/api`**

```bash
npm install @tauri-apps/api
```

- [ ] **Step 2: Write the test**

Create `src/web/lib/serverConfig.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';

// Mock the tauri api — simulate non-Tauri environment (invoke not available)
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

describe('serverConfig (non-Tauri env)', () => {
  it('getServerUrl returns empty string when not in Tauri', async () => {
    const { getServerUrl } = await import('./serverConfig.js');
    expect(await getServerUrl()).toBe('');
  });

  it('setServerUrl is a no-op when not in Tauri', async () => {
    const { setServerUrl } = await import('./serverConfig.js');
    await expect(setServerUrl('http://foo:3000')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test -- --reporter=verbose src/web/lib/serverConfig.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Create `src/web/lib/serverConfig.ts`**

```ts
import { isTauri, invoke } from '@tauri-apps/api/core';

export async function getServerUrl(): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('get_server_url');
}

export async function setServerUrl(url: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('set_server_url', { url });
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- --reporter=verbose src/web/lib/serverConfig.test.ts
```

Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/serverConfig.ts src/web/lib/serverConfig.test.ts package.json package-lock.json
git commit -m "feat(web): add serverConfig Tauri invoke wrappers"
```

---

## Task 5: Create `src/web/pages/ServerPicker.tsx`

The full-window first-run screen. Uses `invoke('discover_servers')` to probe Tailscale peers, lets the user pick or type a URL, and calls `setServerUrl` then `onConnect` when confirmed.

**Files:**
- Create: `src/web/pages/ServerPicker.tsx`

- [ ] **Step 1: Write the test**

Create `src/web/pages/ServerPicker.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ServerPicker } from './ServerPicker.js';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock('../lib/serverConfig.js', () => ({
  setServerUrl: vi.fn().mockResolvedValue(undefined),
}));

describe('ServerPicker', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('renders input and buttons', () => {
    render(<ServerPicker onConnect={vi.fn()} />);
    expect(screen.getByPlaceholderText(/http:\/\//)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discover/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
  });

  it('shows discovered servers as clickable options', async () => {
    mockInvoke.mockResolvedValue([{ name: 'fbi-server', url: 'http://fbi-server:3000' }]);
    render(<ServerPicker onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /discover/i }));
    await waitFor(() => expect(screen.getByText(/fbi-server/)).toBeInTheDocument());
  });

  it('shows error message when discovery returns empty', async () => {
    mockInvoke.mockResolvedValue([]);
    render(<ServerPicker onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /discover/i }));
    await waitFor(() => expect(screen.getByText(/no fbi servers found/i)).toBeInTheDocument());
  });

  it('calls onConnect with the typed URL on Connect click', async () => {
    const onConnect = vi.fn();
    render(<ServerPicker onConnect={onConnect} />);
    const input = screen.getByPlaceholderText(/http:\/\//);
    fireEvent.change(input, { target: { value: 'http://myserver:3000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith('http://myserver:3000'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --reporter=verbose src/web/pages/ServerPicker.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/web/pages/ServerPicker.tsx`**

```tsx
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { setServerUrl } from '../lib/serverConfig.js';
import { Button, Input } from '@ui/primitives/index.js';

interface DiscoveredServer { name: string; url: string; }

export function ServerPicker({ onConnect }: { onConnect: (url: string) => void }) {
  const [input, setInput] = useState('');
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function discover() {
    setDiscovering(true);
    setError(null);
    try {
      const found = await invoke<DiscoveredServer[]>('discover_servers');
      setServers(found);
      if (found.length === 0) setError('No FBI servers found — enter a URL manually');
    } catch {
      setError('Could not reach Tailscale — enter a URL manually');
    } finally {
      setDiscovering(false);
    }
  }

  async function connect(url: string) {
    setConnecting(true);
    try {
      await setServerUrl(url);
      onConnect(url);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-bg">
      <div className="w-full max-w-md p-8 space-y-6">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Connect to FBI server</h1>
        <p className="text-[14px] text-text-dim">
          Enter your FBI server URL or discover servers on your Tailscale network.
        </p>

        <div className="space-y-3">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="http://"
            className="w-full font-mono"
            onKeyDown={(e) => { if (e.key === 'Enter' && input) void connect(input); }}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={discover}
              disabled={discovering}
              className="flex-1"
            >
              {discovering ? 'Searching…' : 'Discover'}
            </Button>
            <Button
              type="button"
              onClick={() => void connect(input)}
              disabled={!input || connecting}
              className="flex-1"
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </div>

        {error && (
          <p className="text-[13px] text-fail">{error}</p>
        )}

        {servers.length > 0 && (
          <div className="space-y-1">
            <p className="text-[12px] text-text-faint uppercase tracking-wider">Discovered servers</p>
            {servers.map((s) => (
              <button
                key={s.url}
                type="button"
                className="w-full text-left px-3 py-2 rounded text-[13px] hover:bg-surface-raised transition-colors"
                onClick={() => setInput(s.url)}
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-text-dim ml-2">{s.url}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose src/web/pages/ServerPicker.test.tsx
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/ServerPicker.tsx src/web/pages/ServerPicker.test.tsx
git commit -m "feat(web): add ServerPicker first-run page"
```

---

## Task 6: Update `src/web/main.tsx` to gate on server URL

Add a `<Root>` component that reads the stored server URL on mount and either renders `<ServerPicker>` (Tauri, no URL stored) or `<App>` (everything else).

**Files:**
- Modify: `src/web/main.tsx`

- [ ] **Step 1: Replace `main.tsx` entirely**

```tsx
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App.js';
import { ServerPicker } from './pages/ServerPicker.js';
import { getServerUrl, setServerUrl } from './lib/serverConfig.js';
import { setApiBaseUrl } from './lib/api.js';
import './index.css';

function Root() {
  const [serverUrl, setServerUrlState] = useState<string | null>(null);

  useEffect(() => {
    getServerUrl().then((url) => {
      setApiBaseUrl(url);
      setServerUrlState(url);
    }).catch(() => setServerUrlState(''));
  }, []);

  if (serverUrl === null) return null;

  if (isTauri() && serverUrl === '') {
    return (
      <ServerPicker
        onConnect={(url) => {
          setApiBaseUrl(url);
          setServerUrlState(url);
        }}
      />
    );
  }

  return (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in DOM');
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/web/main.tsx
git commit -m "feat(web): add Root component with server URL gate"
```

---

## Task 7: Add tray update calls to `useRunWatcher.ts`

After each count publish, invoke `update_tray` with the total active count. On terminal transitions, also invoke `notify`.

**Files:**
- Modify: `src/web/hooks/useRunWatcher.ts`

- [ ] **Step 1: Add import and tray helper to `useRunWatcher.ts`**

Add at the top, after existing imports:
```ts
import { isTauri, invoke } from '@tauri-apps/api/core';
```

- [ ] **Step 2: Add tray update to `publishCountsFromMap`**

The current `publishCountsFromMap` function ends after calling `_publishRunning` and `_publishWaiting`. Add after those calls:
```ts
function publishCountsFromMap(runs: Map<number, { state: RunState; project_id: number }>) {
  const running = new Map<number, number>();
  const waiting = new Map<number, number>();
  for (const { state, project_id } of runs.values()) {
    if (state === 'running') running.set(project_id, (running.get(project_id) ?? 0) + 1);
    else if (state === 'waiting') waiting.set(project_id, (waiting.get(project_id) ?? 0) + 1);
  }
  _publishRunning(running);
  _publishWaiting(waiting);
  if (isTauri()) {
    const active = [...running.values()].reduce((a, b) => a + b, 0);
    invoke('update_tray', { active }).catch(() => {});
  }
}
```

- [ ] **Step 3: Add native notify call on terminal transitions**

Inside `ws.onmessage`, after the existing `notifyComplete` call, add a Tauri-specific notification. Replace the `if (isTerminal(msg.state) && !isTerminal(prev ?? 'queued'))` block:
```ts
if (isTerminal(msg.state) && !isTerminal(prev ?? 'queued')) {
  const proj = await api.getProject(msg.project_id).catch(() => null);
  void notifyComplete({
    id: msg.run_id,
    state: msg.state as 'succeeded' | 'failed' | 'cancelled',
    project_name: proj?.name,
  });
  if (isTauri() && enabled) {
    const icon = msg.state === 'succeeded' ? '✓' : msg.state === 'failed' ? '✗' : '⊘';
    invoke('notify', {
      title: `${icon} Run #${msg.run_id} ${msg.state}`,
      body: proj?.name ? `Project: ${proj.name}` : 'Run finished',
    }).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the existing useRunWatcher tests**

```bash
npm test -- --reporter=verbose src/web/hooks/useRunWatcher.test.tsx
```

Expected: all existing tests pass (the new `isTauri()` calls return false in the test environment because `window.__TAURI__` is not defined).

- [ ] **Step 5: Commit**

```bash
git add src/web/hooks/useRunWatcher.ts
git commit -m "feat(web): invoke update_tray and notify from useRunWatcher"
```

---

## Task 8: Add "Change server" to Settings

**Files:**
- Modify: `src/web/pages/Settings.tsx`

- [ ] **Step 1: Add the change-server section to `Settings.tsx`**

Add imports at the top:
```ts
import { isTauri } from '@tauri-apps/api/core';
import { setServerUrl } from '../lib/serverConfig.js';
import { setApiBaseUrl } from '../lib/api.js';
```

Add a state variable at the start of `SettingsPage`:
```ts
const [changingServer, setChangingServer] = useState(false);
```

Add a new `<Section>` block just before the closing `</form>` tag (before the `{error && ...}` line):
```tsx
{isTauri() && (
  <Section title="Desktop connection">
    <p className="text-[13px] text-text-dim mb-3">
      Currently connected to: <span className="font-mono text-[13px]">{window.__FBI_SERVER_URL__ ?? '(unknown)'}</span>
    </p>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={changingServer}
      onClick={async () => {
        setChangingServer(true);
        await setServerUrl('');
        setApiBaseUrl('');
        window.location.reload();
      }}
    >
      Change server
    </Button>
  </Section>
)}
```

Note: `window.location.reload()` re-triggers `Root`'s `useEffect` which reads the now-empty server URL and renders `<ServerPicker>`.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes (the `window.__FBI_SERVER_URL__` may need a type declaration — if the compiler complains, add `declare const __FBI_SERVER_URL__: string | undefined;` or just cast `(window as Record<string,unknown>).__FBI_SERVER_URL__`).

If typecheck fails on `window.__FBI_SERVER_URL__`, replace that reference with just the server URL read from state. A simpler alternative that avoids the global: remove the display sentence entirely and just keep the button:
```tsx
{isTauri() && (
  <Section title="Desktop connection">
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={changingServer}
      onClick={async () => {
        setChangingServer(true);
        await setServerUrl('');
        setApiBaseUrl('');
        window.location.reload();
      }}
    >
      Change server
    </Button>
  </Section>
)}
```

- [ ] **Step 3: Commit**

```bash
git add src/web/pages/Settings.tsx
git commit -m "feat(web): add Change server button to Settings in Tauri context"
```

---

## Task 9: Scaffold the `desktop/` Tauri project

Creates the skeleton Rust project and configuration files. No business logic yet.

**Files:**
- Create: `desktop/Cargo.toml`
- Create: `desktop/build.rs`
- Create: `desktop/tauri.conf.json`
- Create: `desktop/capabilities/default.json`
- Create: `desktop/src/main.rs` (stub)
- Create: `desktop/src/config.rs` (stub)
- Create: `desktop/src/tray.rs` (stub)
- Create: `desktop/src/discovery.rs` (stub)

- [ ] **Step 1: Create `desktop/Cargo.toml`**

```toml
[package]
name = "fbi-desktop"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "fbi-desktop"
path = "src/main.rs"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-store = "2"
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "1", features = ["full"] }
```

- [ ] **Step 2: Create `desktop/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: Create `desktop/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "FBI",
  "version": "0.1.0",
  "identifier": "com.fynn-labs.fbi",
  "build": {
    "frontendDist": "../dist/web",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "",
    "beforeBuildCommand": ""
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "FBI",
        "width": 1280,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600
      }
    ],
    "security": {
      "csp": "default-src 'self' tauri: asset: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://* https://* ws://* wss://*; img-src 'self' data: asset: tauri: blob:; font-src 'self' data:"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "category": "DeveloperTool"
  }
}
```

- [ ] **Step 4: Create `desktop/capabilities/default.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2/capability",
  "identifier": "default",
  "description": "Default capability for FBI desktop",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "store:allow-load",
    "store:allow-get",
    "store:allow-set",
    "store:allow-save",
    "notification:allow-send-notification",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission"
  ]
}
```

- [ ] **Step 5: Create stub source files**

Create `desktop/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod discovery;
mod tray;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Create `desktop/src/config.rs`:
```rust
// Implemented in Task 10
```

Create `desktop/src/tray.rs`:
```rust
// Implemented in Task 11
```

Create `desktop/src/discovery.rs`:
```rust
// Implemented in Task 12
```

- [ ] **Step 6: Create placeholder icons**

Tauri requires icon files to exist. Generate minimal placeholders:
```bash
mkdir -p desktop/icons
# Create a 1x1 transparent PNG as placeholder (32x32 and 128x128)
# These will be replaced with real icons before shipping.
# Use ImageMagick if available:
if command -v convert &>/dev/null; then
  convert -size 32x32 xc:'#111827' desktop/icons/32x32.png
  convert -size 128x128 xc:'#111827' desktop/icons/128x128.png
  convert -size 256x256 xc:'#111827' desktop/icons/icon.png
else
  # Fallback: copy any existing PNG as placeholder
  cp media/banner-light.png desktop/icons/32x32.png
  cp media/banner-light.png desktop/icons/128x128.png
  cp media/banner-light.png desktop/icons/icon.png
fi
# icns and ico are needed for bundling; create empty files as placeholders
touch desktop/icons/icon.icns desktop/icons/icon.ico
```

- [ ] **Step 7: Verify the Rust project compiles (stubs only)**

```bash
cd desktop && cargo check 2>&1 | head -30
```

Expected: errors about unused modules or missing items in stub files are OK at this stage; the project should at least parse.

- [ ] **Step 8: Commit**

```bash
git add desktop/
git commit -m "feat(desktop): scaffold Tauri v2 project structure"
```

---

## Task 10: Implement `desktop/src/config.rs`

Stores and retrieves the server URL using `tauri-plugin-store`.

**Files:**
- Modify: `desktop/src/config.rs`

- [ ] **Step 1: Replace stub with full implementation**

```rust
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
```

- [ ] **Step 2: Verify it compiles**

```bash
cd desktop && cargo check 2>&1 | grep -E "^error" | head -20
```

Expected: no errors from `config.rs`.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/config.rs
git commit -m "feat(desktop): implement get/set_server_url via tauri-plugin-store"
```

---

## Task 11: Implement `desktop/src/tray.rs`

Sets up the system tray with Open/Quit menu and exposes `update_tray` command.

**Files:**
- Modify: `desktop/src/tray.rs`

- [ ] **Step 1: Replace stub with full implementation**

```rust
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open FBI", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

    TrayIconBuilder::with_id("main")
        .tooltip("FBI")
        .menu(&menu)
        .icon(app.default_window_icon().cloned().unwrap())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => show_main_window(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn update_tray(app: AppHandle, active: u32) -> Result<(), String> {
    let tooltip = if active > 0 {
        format!("FBI — {} run{} active", active, if active == 1 { "" } else { "s" })
    } else {
        "FBI".to_string()
    };
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd desktop && cargo check 2>&1 | grep -E "^error" | head -20
```

Expected: no errors from `tray.rs`.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/tray.rs
git commit -m "feat(desktop): implement system tray and notify command"
```

---

## Task 12: Implement `desktop/src/discovery.rs`

Probes Tailscale peers and checks which ones respond on `:3000/api/health`.

**Files:**
- Modify: `desktop/src/discovery.rs`

- [ ] **Step 1: Replace stub with full implementation**

```rust
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};

#[derive(Serialize)]
pub struct DiscoveredServer {
    pub name: String,
    pub url: String,
}

#[derive(Deserialize)]
struct TailscaleStatus {
    #[serde(rename = "Peer")]
    peer: Option<HashMap<String, TailscalePeer>>,
}

#[derive(Deserialize)]
struct TailscalePeer {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(rename = "TailscaleIPs")]
    tailscale_ips: Option<Vec<String>>,
    #[serde(rename = "Online")]
    online: Option<bool>,
}

#[tauri::command]
pub async fn discover_servers() -> Vec<DiscoveredServer> {
    let status = match fetch_tailscale_status().await {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let candidates: Vec<(String, String)> = status
        .peer
        .unwrap_or_default()
        .into_values()
        .filter(|p| p.online.unwrap_or(false))
        .filter_map(|peer| {
            let host = peer
                .dns_name
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_end_matches('.').to_string())
                .or_else(|| {
                    peer.tailscale_ips
                        .and_then(|ips| ips.into_iter().next())
                })?;
            let name = host.split('.').next().unwrap_or(&host).to_string();
            let url = format!("http://{}:3000", host);
            Some((name, url))
        })
        .collect();

    probe_candidates(candidates).await
}

async fn fetch_tailscale_status() -> Result<TailscaleStatus, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?
        .get("http://100.100.100.100/localapi/v0/status")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<TailscaleStatus>()
        .await
        .map_err(|e| e.to_string())
}

async fn probe_candidates(candidates: Vec<(String, String)>) -> Vec<DiscoveredServer> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let handles: Vec<_> = candidates
        .into_iter()
        .map(|(name, url)| {
            let c = client.clone();
            let health = format!("{}/api/health", url);
            tokio::spawn(async move {
                match c.get(&health).send().await {
                    Ok(r) if r.status().is_success() => Some(DiscoveredServer { name, url }),
                    _ => None,
                }
            })
        })
        .collect();

    let mut results = vec![];
    for h in handles {
        if let Ok(Some(s)) = h.await {
            results.push(s);
        }
    }
    results
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd desktop && cargo check 2>&1 | grep -E "^error" | head -20
```

Expected: no errors from `discovery.rs`.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/discovery.rs
git commit -m "feat(desktop): implement discover_servers via Tailscale probe"
```

---

## Task 13: Wire everything together in `desktop/src/main.rs`

**Files:**
- Modify: `desktop/src/main.rs`

- [ ] **Step 1: Replace stub with full implementation**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod discovery;
mod tray;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            config::get_server_url,
            config::set_server_url,
            tray::update_tray,
            tray::notify,
            discovery::discover_servers,
        ])
        .setup(|app| {
            tray::setup_tray(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2: Full cargo check**

```bash
cd desktop && cargo check 2>&1
```

Expected: clean — no errors. If `windows_subsystem` causes issues on Linux, that's fine; `cfg_attr` makes it a no-op on non-Windows.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main.rs
git commit -m "feat(desktop): wire all Tauri commands and plugins in main.rs"
```

---

## Task 14: Add npm scripts and install Tauri CLI

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `@tauri-apps/cli` as a devDependency**

```bash
npm install --save-dev @tauri-apps/cli
```

- [ ] **Step 2: Add Tauri scripts to `package.json`**

Add to the `"scripts"` object (after existing scripts):
```json
"tauri:dev": "npm run dev:web & cd desktop && cargo tauri dev --no-watch",
"tauri:build": "npm run build:web && (cd desktop && cargo tauri build)"
```

Note: `tauri:dev` starts the Vite dev server in the background and then runs the Tauri dev binary pointing at it. Developers can also run `npm run dev:web` in one terminal and `cd desktop && cargo tauri dev` in another.

A cleaner alternative for a single command is to set `beforeDevCommand` in `tauri.conf.json`. Update `desktop/tauri.conf.json` to set:
```json
"beforeDevCommand": "cd .. && npm run dev:web"
```
Then the `tauri:dev` script simplifies to:
```json
"tauri:dev": "cd desktop && cargo tauri dev"
```

Use whichever approach works in your shell. The `cd ..` version is more portable.

- [ ] **Step 3: Verify typecheck and tests still pass**

```bash
npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tauri:dev and tauri:build npm scripts"
```

---

## Task 15: Add GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/desktop.yml`

- [ ] **Step 1: Create `.github/workflows/desktop.yml`**

```bash
mkdir -p .github/workflows
```

```yaml
name: Desktop Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Cache Rust build
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: desktop

      - name: Install npm dependencies
        run: npm ci

      - name: Build web frontend
        run: npm run build:web

      - name: Build macOS desktop app
        run: cd desktop && cargo tauri build

      - name: Upload macOS artifacts
        uses: actions/upload-artifact@v4
        with:
          name: fbi-macos-${{ github.ref_name }}
          path: |
            desktop/target/release/bundle/dmg/*.dmg
            desktop/target/release/bundle/macos/*.app

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Cache Rust build
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: desktop

      - name: Install Linux system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libgtk-3-dev \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf

      - name: Install npm dependencies
        run: npm ci

      - name: Build web frontend
        run: npm run build:web

      - name: Build Linux desktop app
        run: cd desktop && cargo tauri build

      - name: Upload Linux artifacts
        uses: actions/upload-artifact@v4
        with:
          name: fbi-linux-${{ github.ref_name }}
          path: |
            desktop/target/release/bundle/deb/*.deb
            desktop/target/release/bundle/appimage/*.AppImage
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/desktop.yml
git commit -m "ci: add GitHub Actions workflow for macOS and Linux desktop builds"
```

---

## Self-Review Notes

After writing this plan, checked it against the spec:

- **CORS** ✓ Task 1
- **`api.ts` base URL** ✓ Task 2
- **WebSocket URL fix** ✓ Task 3 (covers all 3 files: `ws.ts`, `useRunWatcher.ts`, `usageStore.ts`)
- **`serverConfig.ts`** ✓ Task 4
- **`ServerPicker`** ✓ Task 5 (discover button, results list, manual entry, error state)
- **`main.tsx` gate** ✓ Task 6
- **Tray badge** ✓ Task 7 (`update_tray` invoke in `publishCountsFromMap`)
- **OS notifications** ✓ Task 7 (`notify` invoke on terminal transitions), Task 11 (Rust `notify` command)
- **"Change server" in Settings** ✓ Task 8
- **Rust project scaffold** ✓ Task 9
- **`config.rs`** ✓ Task 10
- **`tray.rs`** ✓ Task 11
- **`discovery.rs`** ✓ Task 12 (Tailscale probe, parallelised, 2-second timeout, online-only filter)
- **`main.rs`** ✓ Task 13
- **Build scripts** ✓ Task 14
- **CI workflow** ✓ Task 15 (macOS + Linux, parallel jobs, artifacts)
- **CSP** ✓ Task 9 (`tauri.conf.json` `connect-src` allows `http://*`, `ws://*`, `wss://*`)
- **WebSocket protocol conversion** ✓ Task 2 (`wsBase()` does `http → ws`, `https → wss`)
- **`isTauri()` guard** ✓ Tasks 4, 7, 8 (all Tauri-specific code is guarded)
