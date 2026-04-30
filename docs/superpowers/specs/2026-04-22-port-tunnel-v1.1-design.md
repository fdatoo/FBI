# FBI — Port Tunnel v1.1 Design

**Date:** 2026-04-22
**Project:** FBI
**Status:** Approved for implementation planning
**Builds on:** [Port Tunnel v1 design](2026-04-22-port-tunnel-design.md)

## 1. Overview

v1 shipped the server plumbing and the `fbi-tunnel` Go CLI. It left the
feature invisible in the web UI: an operator had to know the run was live,
that listening-port discovery existed, and how to install the helper binary.

v1.1 closes that gap with two small additions:

1. A **`tunnel` tab** on the run detail page that polls the existing
   discovery endpoint and shows a copy-paste command + a live list of
   listening ports.
2. A **binary download endpoint** plus a UI button that hands an operator
   a `fbi-tunnel` build matching their OS/arch, so the flow from "see a port
   in the tab" to "run the CLI locally" has no manual install step.

Nothing about the trust model, the WS tunnel, or the discovery endpoint
changes. All v1 non-goals remain non-goals.

## 2. User experience

A new `tunnel` tab appears in the drawer at the bottom of the run detail
page, next to `files` / `prompt` / `github`. It uses the same `RunDrawer`
+ `Tabs` scaffolding as the existing tabs.

### 2.1 While the run is `running`

```
┌───────────────────────────────────────────────────────────────────────┐
│  fbi-tunnel https://fbi.tailnet:3000 42                         [📋]  │
│                                                                       │
│  [ Download fbi-tunnel for macOS (arm64) ]      other platforms ▾     │
│                                                                       │
│  Listening ports                                                      │
│  ┌─────────────┬───────┐                                              │
│  │ remote port │ note  │                                              │
│  ├─────────────┼───────┤                                              │
│  │ 5173        │       │                                              │
│  │ 9229        │       │                                              │
│  └─────────────┴───────┘                                              │
└───────────────────────────────────────────────────────────────────────┘
```

- **Command box:** one-liner `fbi-tunnel <origin> <run-id>` where `<origin>`
  is `window.location.origin`. Copy button on the right.
- **Download button:** OS/arch auto-detected via `navigator.userAgentData`
  with fallback to `navigator.userAgent` heuristics; downloads from
  `GET /api/cli/fbi-tunnel/:os/:arch` (see §3). "Other platforms ▾" toggles
  a small list with links for the remaining three (os, arch) pairs.
- **Ports table:** one row per listening port returned by the discovery
  endpoint. `note` column is rendered but always blank for v1.1 — it
  reserves layout for future agent-reported labels.
- **Empty-ports state:** a one-liner under an empty table:
  "No listening ports yet — the agent hasn't started a server."

### 2.2 Other states

The panel uses the same skeleton (command, download, empty ports table)
in all non-running states, with:

- Copy and Download buttons disabled (greyed; tooltip explains why).
- A single state-aware hint line where the ports table would be:

  | State                | Hint                                            |
  | -------------------- | ----------------------------------------------- |
  | `queued`             | `run is queued`                                 |
  | `awaiting_resume`    | `run is paused awaiting token resume`           |
  | `succeeded`          | `run ended`                                     |
  | `failed`             | `run ended`                                     |
  | `cancelled`          | `run ended`                                     |

### 2.3 Polling

- Poll `GET /api/runs/:id/listening-ports` every 2 s while `run.state ===
  'running'`.
- Immediate refetch on state-stream transition *into* `running` (piggybacks
  on the existing `subscribeState` listener in `RunDetailPage`).
- Pause polling when `document.visibilityState !== 'visible'`; resume on
  `'visibilitychange'` → visible.
- Transient network errors: silently keep last-known rows and keep polling.
  No error banner for a single blip.
- Hard errors (404 run-not-found, 409 run-not-running): collapse the table
  and show the state-appropriate hint from §2.2.

### 2.4 URL source

`window.location.origin` only. No env-var override, no in-UI edit
affordance. Matches FBI's personal/Tailscale deployment model where the
browser origin is also the CLI-reachable origin. If/when this breaks for
someone, adding an edit affordance is ~30 lines.

## 3. Server endpoints

### 3.1 New — `GET /api/cli/fbi-tunnel/:os/:arch`

- `:os` ∈ `{darwin, linux}`; `:arch` ∈ `{amd64, arm64}`. Anything else →
  `400 { error: "unsupported os/arch" }`.
- On success: streams the binary with
  - `Content-Type: application/octet-stream`
  - `Content-Disposition: attachment; filename="fbi-tunnel-<os>-<arch>"`
  - `Cache-Control: public, max-age=3600`
  - `X-FBI-CLI-Version: <FBI_VERSION>` when the env var is set; omitted
    otherwise. Same short-SHA value that's already plumbed through the web
    build as `VITE_VERSION`.
- If the file is missing on disk → `503 { error: "fbi-tunnel binary not
  built; rerun npm run build" }`.
- Source file is `${CLI_DIST_DIR}/fbi-tunnel-${os}-${arch}`. `CLI_DIST_DIR`
  is a new env var, default `dist/cli` (relative to the process cwd).
  No symlink traversal — we only read exact filenames from a static allowlist.
- Streams via `fs.createReadStream(...)` passed to `reply.send()` so binaries
  don't load into memory.

Lives in a new `src/server/api/cli.ts`; wired from `src/server/index.ts`
next to the existing `registerProxyRoutes` call.

### 3.2 Unchanged — existing v1 endpoints

- `GET /api/runs/:id/listening-ports` is unchanged. v1.1 just calls it on a
  2 s tick.
- `GET /api/runs/:id/proxy/:port` (WS tunnel) is unchanged.

### 3.3 Not added

- No `POST /api/cli/fbi-tunnel/build` build-trigger endpoint. Builds are a
  deploy-time concern (§4). If binaries are missing, the UI surfaces the
  503 verbatim.
- No manifest endpoint. The UI knows the four (os, arch) pairs at compile
  time; adding a manifest is trivial if that set grows.

## 4. Build & distribution

**Goal:** `npm run build` produces
`dist/cli/fbi-tunnel-{darwin,linux}-{amd64,arm64}` with **zero new host
prerequisites**. FBI already requires Docker, so we reuse it for cross
compilation.

### 4.1 New script — `cli/fbi-tunnel/scripts/build-dist.sh`

Runs a short-lived `golang:1.22-alpine` container that mounts the
`cli/fbi-tunnel` source, invokes `make dist`, and writes outputs to
`dist/cli/` at the repo root. Image is pulled at most once per build.

```bash
#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$SRC/../../dist/cli"
mkdir -p "$OUT"
docker run --rm \
  -v "$SRC":/src -v "$OUT":/out \
  -e VERSION="${VITE_VERSION:-dev}" \
  -w /src \
  golang:1.22-alpine \
  sh -c 'apk add --no-cache make >/dev/null && make dist OUT=/out'
chmod +x "$OUT"/fbi-tunnel-*
```

### 4.2 New Makefile target — `dist`

```makefile
dist:
	for os in darwin linux; do \
	  for arch in amd64 arm64; do \
	    CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
	      go build -ldflags="-s -w -X main.version=$(VERSION)" \
	      -o $(OUT)/fbi-tunnel-$$os-$$arch . ; \
	  done ; \
	done
```

Targets are `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64`.
Windows is out of scope (FBI itself has no Windows deploy story).

### 4.3 `package.json` changes

- New script: `"cli:dist": "bash cli/fbi-tunnel/scripts/build-dist.sh"`
- `"build"` becomes: `"npm run build:server && npm run build:web && npm run cli:dist"`

This means `scripts/install.sh` (which already runs `npm run build`) and
`scripts/dev.sh` pick it up automatically.

### 4.4 `.gitignore` and repo hygiene

- Add `dist/cli/` to root `.gitignore`.
- `cli/fbi-tunnel/dist/` (the existing `make install` output for
  single-host installs) stays gitignored.

### 4.5 README

One sentence added to the "Install" section: `npm run build` now also
cross-compiles the `fbi-tunnel` helper binaries via Docker; no Go toolchain
needed on the host.

### 4.6 Failure modes (intentional)

- Docker daemon not running during `npm run build` → loud build failure
  with the underlying Docker error. Not soft-skipped: FBI won't run
  without Docker anyway.
- Docker Hub unreachable during first build → same, loud failure.
  `install.sh` is online by construction (it runs `npm ci`).

### 4.7 Server startup

Server logs a single line at startup:

- `fbi-tunnel binaries: dist/cli (4 platforms)` when all four files are
  present.
- `fbi-tunnel binaries: not built — /api/cli/fbi-tunnel/* will 503` when
  the directory is missing or empty.

## 5. UI components

### 5.1 New file — `src/web/features/runs/TunnelTab.tsx`

The entire tab UI lives in one component, following the pattern of
`PromptTab.tsx` and `GithubTab.tsx` (small, self-contained, takes props
derived from `run`).

Props:

```ts
interface TunnelTabProps {
  runId: number;
  runState: Run['state'];
  origin: string; // window.location.origin, passed in for testability
}
```

Internal state:

- `ports: { port: number; proto: string }[]` — last-known list.
- `loadError: string | null` — last hard error (404/409).

Effects:

- `useEffect` scoped to `[runId, runState]`: starts/stops a
  `setInterval(2000)` polling `api.getRunListeningPorts(runId)` only when
  `runState === 'running'`. Cleans up on unmount / state change.
- `useEffect` for `visibilitychange` on `document`: clears the interval
  when hidden, restarts when visible. Avoided for non-running states
  since there's no interval then.
- No separate state-stream subscription for "transition into running":
  the parent `RunDetailPage` already re-renders `<TunnelTab runState=…>`
  on state changes, so the polling-start effect fires naturally.

### 5.2 Sub-components (inline, no new files)

- `CommandBox`: a monospace box with `fbi-tunnel {origin} {runId}` and a
  copy button using the existing `CodeBlock` primitive where possible.
- `DownloadButton`: platform-detection + primary download button; uses an
  existing or minimal `Disclosure`-style toggle for "other platforms".
- `PortsTable`: uses existing primitives (`Tag`, table layout reused from
  other panes). `note` column placeholder for future use.

Detection logic (isolated, testable):

```ts
export function detectPlatform(ua?: NavigatorUAData | string): { os: 'darwin' | 'linux'; arch: 'amd64' | 'arm64' } {
  // Prefer navigator.userAgentData.platform + userAgentData.getHighEntropyValues() -> architecture
  // Fallback to userAgent string matching.
  // Default: darwin/arm64 (statistical majority for operators).
}
```

Pure function — tested with a small table of UA strings / UAData shapes.

### 5.3 New file — `src/web/features/runs/TunnelTab.test.tsx`

RTL test covering:

- Renders the polling table with rows matching `api.getRunListeningPorts`
  mock response.
- Does not poll when `runState !== 'running'`.
- Shows the right hint line for each non-running state.
- Copy button emits the correct string.
- Download button computes the correct URL from a fixed platform.

### 5.4 `RunDrawer.tsx` change

Add a fourth tab value `'tunnel'`, include it in the `tabs` array, and
update the `RunTab` union type. The tunnel tab takes an optional `count`
matching the current listening-ports length when `runState === 'running'`
(omitted otherwise) — mirroring how `files` shows its diff count.

The count flows from `RunDetailPage` into `RunDrawer`; the page lifts the
`ports.length` out of `TunnelTab` by holding the last-fetched ports list
at the page level and passing it into both the tab content and the
drawer header. The fetch logic still lives in the effect that
`TunnelTab` controls — the page exposes an `onPortsChange` setter that
`TunnelTab` calls after each successful poll, and reads back the count
to feed to the drawer.

The drawer tab renderer in `RunDetail.tsx` gets one more branch:

```ts
{(t) =>
  t === 'files'  ? <FilesTab ... />  :
  t === 'prompt' ? <PromptTab ... /> :
  t === 'github' ? <GithubTab ... /> :
                   <TunnelTab runId={run.id} runState={run.state}
                              origin={window.location.origin}
                              onPortsChange={setPorts} />
}
```

### 5.5 New API client method — `src/web/lib/api.ts`

```ts
getRunListeningPorts(runId: number): Promise<{ ports: { port: number; proto: string }[] }>
```

Shallow wrapper over `fetch('/api/runs/' + runId + '/listening-ports')`.

Binary download is a plain `<a href="/api/cli/fbi-tunnel/:os/:arch"
download>` — no client wrapper.

### 5.6 Shared types

Add a `ListeningPort` interface to `src/shared/types.ts` so the client
and server don't drift:

```ts
export interface ListeningPort { port: number; proto: 'tcp' }
```

## 6. Testing strategy

### 6.1 Server — `src/server/api/cli.test.ts`

- `200` happy path: temp dir with a known fake binary, endpoint streams it
  back; headers include `Content-Disposition` with correct filename and
  `Cache-Control: public, max-age=3600`.
- `X-FBI-CLI-Version` present when `FBI_VERSION` is set; absent when not.
- `400` for unsupported os (e.g. `windows`) and unsupported arch (e.g.
  `riscv`).
- `503` when the binary file is missing.
- Path-safety: a request path that tries `../../etc/passwd`-style tricks
  is rejected by the strict allowlist (not even reached as a path — both
  params are checked against the `{darwin,linux}` × `{amd64,arm64}` set
  before any filesystem access).

No integration test for the endpoint; the unit test fully covers it.

### 6.2 UI — `TunnelTab.test.tsx`

Covered in §5.3. RTL + a mocked `api.getRunListeningPorts`. No new
end-to-end Playwright test in v1.1 — the existing run-detail smoke test
can be extended in a follow-up if we want.

### 6.3 Platform detection — pure function test

`src/web/features/runs/detectPlatform.test.ts`:

- macOS arm64 UA string and UAData → `{darwin, arm64}`
- macOS Intel UA string → `{darwin, amd64}`
- Linux UA string → `{linux, amd64}`
- Unknown UA → fallback `{darwin, arm64}` (and assertion that the fallback
  is stable, i.e. doesn't pick e.g. `linux/riscv`).

### 6.4 Build script — no test

`scripts/build-dist.sh` is exercised by `npm run build` on every install;
a dedicated test would be test-for-test's-sake. The `install.sh` path
implicitly validates it.

### 6.5 Existing tests

No v1 tests are modified. v1.1 does not touch `proxy.ts`,
`procListeners.ts`, or the CLI Go code.

## 7. Non-goals / deferred (v1.1)

- Per-port `-L` command UI or auto-generation of scoped commands.
- Windows binaries.
- Historical/ghost-port display (ports seen earlier but no longer
  listening).
- `FBI_EXTERNAL_URL` env var or per-device URL edit affordance.
- In-running-CLI re-discovery (still one-shot at CLI start, per v1).
- Agent-reported port notes (column reserved but always blank).
- Build-on-demand or lazy compile in the server process.
- GitHub Releases pipeline / tagged distribution.
- CI for the Go toolchain.
- Playwright end-to-end coverage of the tunnel tab.
