# FBI — Port Tunnel Design

**Date:** 2026-04-22
**Project:** FBI
**Status:** Approved for implementation planning

## 1. Overview

When Claude runs inside a per-run FBI container, it sometimes wants to show
the operator something rendered in a server it just spun up — a Vite dev
server, a Storybook, a Next dev process, a quick `python -m http.server`. With
the current runtime, those servers are unreachable: the container has no
published ports, only a Docker bridge IP that the FBI host can see.

This spec adds a port-tunnel feature that lets the operator forward arbitrary
TCP from their laptop into a running run's container, so the agent's servers
work as ordinary `http://localhost:<port>/` URLs in the operator's browser, with
no path mangling, no DNS changes, and no Tailscale ACL changes.

The feature has two pieces:

1. **Server side (this repo, Node/TypeScript):** two new FBI endpoints — a
   port-discovery API and a WebSocket TCP tunnel — both scoped to a single
   run's live container.
2. **CLI side (new, Go):** a single static binary, `fbi-tunnel`, that
   auto-discovers the listening ports inside a run's container, opens
   matching local TCP listeners on the operator's laptop, and pipes bytes
   between each inbound local connection and a per-connection WebSocket to
   FBI.

### Trust model

Unchanged from the rest of FBI: Tailscale (or whatever network boundary the
operator chose) remains the only authentication boundary. The CLI just needs
to be able to reach FBI's existing HTTP port. No tokens, no logins.

### Goals

- Make any TCP server the agent starts inside its run container reachable as
  `localhost:<port>` on the operator's laptop, with the dev server seeing `/`
  as its root path so HMR, absolute paths, in-app WebSockets, etc. all work
  with no per-tool flags.
- Auto-discover the container's listening ports so the operator does not need
  to know which port the agent picked.
- Add no new infrastructure or configuration: no extra ports opened on the
  FBI host, no DNS, no per-port allocations, no Tailscale changes.
- Stay inside FBI's existing trust model (no extra auth).

### Non-goals (v1)

- Raw TCP advertised as a feature. Non-HTTP traffic flows correctly because
  the tunnel is byte-transparent, but the UX, output, and tests are
  HTTP-shaped.
- Multiple runs tunneled in one CLI invocation.
- Reconnecting / attaching to a fresh run when the current run ends.
- Periodic re-discovery during a CLI session — discovery is one-shot at CLI
  startup; if the agent starts a new server later, the operator re-runs the
  CLI.
- Multiplexed control WebSocket (one WS per inbound connection in v1).
- IPv6 inside the container (`/proc/.../net/tcp6` parser).
- UDP forwarding.
- Any authentication on top of FBI's existing network boundary.
- CI for the Go toolchain.

## 2. Architecture

```
┌──────────────────────┐                 ┌─────────────────────────────────────────┐
│  Operator's laptop   │                 │  FBI server (existing)                  │
│                      │                 │                                         │
│  Browser tab         │                 │  ┌─────────────────────────────────┐    │
│  http://localhost:   │  TCP            │  │ Fastify HTTP + WS               │    │
│       5173           │◄──────────────► │  │  GET /api/runs/:id/             │    │
│        ▲             │                 │  │       listening-ports           │    │
│        │             │                 │  │  GET /ws/runs/:id/proxy/:port   │    │
│        │ TCP         │                 │  └────────────┬────────────────────┘    │
│  ┌─────┴────────┐    │  WS             │               │                         │
│  │ fbi-tunnel   │◄───┼──tailscale─────►│ ┌─────────────▼─────────────────┐       │
│  │ (Go binary)  │    │                 │ │ Orchestrator (existing)       │       │
│  └──────────────┘    │                 │ │  - container handle (.active) │       │
│                      │                 │ │  - container.inspect → IP/PID │       │
└──────────────────────┘                 │ └─────────────┬─────────────────┘       │
                                         │               │                         │
                                         │  ┌────────────▼──────────┐              │
                                         │  │ Docker engine         │              │
                                         │  │ ┌──────────────────┐  │              │
                                         │  │ │ Run container    │  │              │
                                         │  │ │ supervisor.sh +  │  │              │
                                         │  │ │ claude + agent's │  │              │
                                         │  │ │ dev server :5173 │  │              │
                                         │  │ └──────────────────┘  │              │
                                         │  └───────────────────────┘              │
                                         └─────────────────────────────────────────┘
```

The orchestrator already keeps the live `Docker.Container` per run in
`Orchestrator.active`. The new endpoints reuse that handle — they need
nothing the orchestrator does not already track.

## 3. Server-side endpoints

Both endpoints live in a new `src/server/api/proxy.ts` and reuse the
orchestrator's container handle. Validation is the same in both places: the
run must exist (or 404) and must be in `running` or `resuming` state — these
are the two states for which `Orchestrator.active` holds a live container
(or 409 otherwise).

### 3.1 `GET /api/runs/:id/listening-ports`

Returns the set of TCP ports the run's container is currently listening on.

- `container.inspect()` → `State.Pid`. This is the host PID of `supervisor.sh`,
  which lives inside the container's net namespace.
- The orchestrator process reads `/proc/<pid>/net/tcp` from the host. (Docker
  containers share their net namespace across the container's processes, so
  any container PID's `net/tcp` shows the namespace's full LISTEN set.)
- Filter to listening sockets (`st == 0A`); parse the local port out of the
  hex `local_address` field (`<hex-ip>:<hex-port>`).
- Dedupe, sort ascending, return:

  ```json
  { "ports": [ { "port": 5173, "proto": "tcp" }, { "port": 9229, "proto": "tcp" } ] }
  ```

- Empty `ports` array if the container is up but nothing is listening.

### 3.2 `GET /ws/runs/:id/proxy/:port` (WebSocket upgrade)

A byte-transparent tunnel between the WS connection and a TCP socket on the
container's bridge IP.

- Resolve the container's bridge IP from
  `inspect().NetworkSettings.IPAddress` (or
  `.Networks.bridge.IPAddress` if `IPAddress` is empty — depends on Docker
  network config; both should be checked).
- `net.connect(<bridge-ip>, <port>)`.
- Pipe binary WS frames ↔ TCP bytes, both directions.
- Either side closes/errors → close the other; surface meaningful WS close
  codes:
  - `1000` clean close (EOF from either side).
  - `1011` upstream connect failure (container refused or unreachable).
  - `1001` "going away" if the run terminated mid-tunnel (orchestrator
    notifies via the existing `RunStreamRegistry` state stream — when the run
    leaves `running`/`resuming`, all proxy WSes for that run are closed).
- Backpressure: pause the TCP socket when the WS send buffer hits high-water
  (Node's `socket.write()` returning `false`), resume on `'drain'`. Standard
  pattern, but worth being explicit so a fast dev server feeding a slow
  client cannot OOM the FBI process.

### 3.3 File layout

```
src/server/api/proxy.ts             -- HTTP discovery + WS upgrade route
src/server/proxy/procListeners.ts   -- /proc/<pid>/net/tcp parser (pure)
src/server/proxy/procListeners.test.ts
src/server/api/proxy.test.ts        -- mocked-orchestrator route tests
src/server/api/proxy.integration.test.ts  -- Docker-gated end-to-end
```

The orchestrator gets a small new method (e.g.,
`Orchestrator.getLiveContainer(runId)`) that returns the container handle
plus a snapshot of its inspect data, so the proxy module does not need its
own `dockerode` dependency or its own `active` map.

## 4. CLI: `fbi-tunnel`

A single static Go binary, in a new top-level `cli/fbi-tunnel/` directory
with its own `go.mod` (Go ≥1.22). The only third-party dependency is
`github.com/gorilla/websocket`.

### 4.1 Invocation

```
fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...
```

Examples:

- `fbi-tunnel http://fbi.tailnet:3000 42` — auto-discover, forward all.
- `fbi-tunnel http://fbi.tailnet:3000 42 -L 5173:5173 -L 9229:9229` —
  explicit only.
- `fbi-tunnel http://fbi.tailnet:3000 42 -L 8080:5173` — auto-discovery plus
  one override (forward the discovered remote 5173 to local 8080 instead of
  local 5173).

### 4.2 Behavior

1. `GET <fbi-url>/api/runs/<id>/listening-ports` for the auto-discovered set.
   If the response is 404/409, print the server's error and exit 2.
2. Merge with any `-L` overrides:
   - Each `-L localport:remoteport` either *adds* a new mapping (if no
     auto-discovered entry has that remote port) or *overrides the local
     side* of an existing one.
   - With no `-L` flags, the merged set is just the discovered set with
     `local == remote`.
3. For each `(local, remote)` pair, bind the local TCP listener.
   - If the local port is already in use on the laptop, bind a random free
     port instead and remember the mapping. No prompt, no failure.
4. Print one table to stdout, then go quiet:

   ```
   run 42 → http://fbi.tailnet:3000
     remote 5173  →  http://localhost:5173
     remote 9229  →  http://localhost:47291  (local 9229 was busy)
   ```

5. Per inbound TCP connection on a local listener:
   - Dial `ws://<fbi-url>/ws/runs/<id>/proxy/<remote-port>`.
   - Pipe bytes both directions until either side closes.
   - On WS close code `1011`/`1001`/etc., close the local TCP connection
     with the same intent (RST on `1011`, FIN on `1001`/`1000`).
6. Exit conditions:
   - WS reports the run ended (close code `1001`): print `run <id> ended`,
     close all listeners, exit 0.
   - Ctrl-C (SIGINT/SIGTERM): close all listeners, drain in-flight
     connections briefly, exit 0.
7. Logging:
   - Default: one line per inbound connection at info level
     (`open  remote 5173  from 127.0.0.1:54321`,
     `close remote 5173  from 127.0.0.1:54321  rx=12345 tx=678`).
   - `-v`: byte-counts continuously updated, plus WS lifecycle events.

### 4.3 Internals

- `gorilla/websocket` for the client.
- `net.Listen("tcp", "127.0.0.1:<port>")` for each forward — bound to
  loopback only so the listener is not exposed on the LAN.
- Per connection: `io.Copy` in both directions on goroutines; the first to
  return triggers shutdown of the other.

### 4.4 Layout

```
cli/fbi-tunnel/
  go.mod
  main.go              -- arg parsing, run loop, signal handling
  client.go            -- HTTP discovery + WS dial helpers
  forwarder.go         -- net.Listen + per-connection pipe
  Makefile             -- cross-compile target
  README.md            -- install + usage
```

A tiny extra script `cli/fbi-tunnel/scripts/install-local.sh` builds for the
host platform and copies to `~/.local/bin/fbi-tunnel`, for the personal-use
common case.

## 5. Data flow walkthrough

A typical session:

1. Operator starts an FBI run that includes "spin up the dev server when you
   have something to show me". The agent eventually runs `npm run dev`,
   which binds `0.0.0.0:5173` inside the container.
2. Operator runs `fbi-tunnel http://fbi.tailnet:3000 42` on their laptop.
3. CLI calls `GET /api/runs/42/listening-ports`. FBI inspects container,
   reads `/proc/<pid>/net/tcp`, returns `{ ports: [{port: 5173, proto: "tcp"}] }`.
4. CLI binds `127.0.0.1:5173`, prints
   `remote 5173 → http://localhost:5173`.
5. Operator opens `http://localhost:5173` in their browser.
6. Browser → CLI's local listener → CLI dials
   `ws://fbi.tailnet:3000/ws/runs/42/proxy/5173`.
7. FBI accepts the upgrade, opens `net.connect("172.17.0.5", 5173)`.
8. Bytes flow both directions. Vite serves its HTML+HMR WebSocket through
   the same proxy path.
9. Run finishes / fails / is cancelled. FBI closes all proxy WSes for
   run 42 with code `1001`. CLI prints `run 42 ended`, closes its
   listeners, exits 0.

## 6. Error handling

| Condition                                     | FBI response                                        | CLI behavior                                                     |
| --------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Run id does not exist                         | 404 from discovery; same on WS upgrade              | Print server error, exit 2                                       |
| Run not in `running`/`resuming`               | 409                                                 | Print server error, exit 2                                       |
| Container's TCP port refuses connection       | WS close code `1011` (upstream connect failure)     | Close inbound TCP with RST; log line, keep listener open         |
| Container vanishes mid-tunnel                 | WS close code `1001` on all proxy WSes for that run | Print `run <id> ended`, close all listeners, exit 0              |
| WS dropped (network blip)                     | n/a (server is upstream of the drop)                | Close affected local TCP connection; log warn; keep listener open |
| Local port already in use                     | n/a                                                 | Bind random free port; record mapping; print in table            |
| Backpressure (slow client, fast dev server)   | Pause container TCP socket; resume on WS drain      | n/a (handled by OS TCP)                                          |

## 7. Testing strategy

### 7.1 Server, unit

- `procListeners.ts`: golden-fixture tests against checked-in
  `/proc/.../net/tcp` snapshots covering: LISTEN-only filtering,
  hex-port decode, dedupe across many sockets, an empty fixture, and a
  "lots of established connections, one LISTEN" fixture.
- Discovery handler (`proxy.test.ts`): mocked orchestrator; verifies
  404/409 paths and JSON response shape.

### 7.2 Server, integration (Docker-gated, like the existing orchestrator
tests in `usage.integration.test.ts`)

- Spin up a tiny test container (e.g., `python:3-alpine` running
  `python -m http.server 8000`).
- Hit `/api/runs/:id/listening-ports`; assert `[{port: 8000, proto: "tcp"}]`.
- Open WS to `/ws/runs/:id/proxy/8000`; send a real HTTP/1.1 `GET /` request
  through the WS; read the response; assert it parses as a valid HTTP
  response with status 200.
- Auto-skips when Docker is unreachable (same pattern as existing
  orchestrator tests).

### 7.3 CLI, unit (Go)

- `-L` parsing (well-formed, malformed, duplicates).
- Mapping merge logic (discovered ∪ overrides, override-wins-by-remote).
- Local-port-collision fallback (mock the listener factory).
- Table rendering.

### 7.4 CLI, integration (Go)

- In-process stub HTTP+WS server that responds to `/api/runs/:id/listening-ports`
  with a fixed payload and accepts WS upgrades on `/ws/runs/:id/proxy/:port`,
  echoing bytes.
- Test exercises the full discovery → listen → pipe → close cycle without
  needing FBI or Docker.

## 8. Build & distribution

- `cli/fbi-tunnel/Makefile` with a `build` target that cross-compiles to
  `dist/fbi-tunnel-{darwin,linux}-{amd64,arm64}` via `GOOS`/`GOARCH`. No
  CGO, so cross-compile is trivial.
- Root `package.json` gets a `cli:build` script that shells out to
  `make -C cli/fbi-tunnel build`, so `npm run cli:build` works for parity
  with the existing dev experience.
- `cli/fbi-tunnel/dist/` is gitignored; binaries are not committed.
- Personal distribution: `make install` copies the host-platform binary to
  `~/.local/bin/fbi-tunnel`. For broader distribution later, GitHub Releases
  would be the natural step but is out of scope for v1.
- CI: not added in v1. The existing repo's CI does not cover a Go
  toolchain, and adding it is not load-bearing for shipping the feature
  for personal use.

## 9. Open / explicitly deferred

These are noted here so future iterations have a record of what was
considered and intentionally left out:

- **Periodic re-discovery during a CLI session.** v1 is one-shot at CLI
  startup. If the agent starts a new server after the CLI is up, the
  operator re-runs the CLI.
- **Multiplexed control WebSocket** (yamux/h2-style). v1 opens one WS per
  inbound TCP connection. Browsers cap at ~6 concurrent connections per
  origin so this is fine for HTTP/HMR workloads.
- **IPv6 in the container** (`/proc/.../net/tcp6` parser). Docker bridge
  default is v4-only; revisit when a real use case appears.
- **UDP forwarding.** No current use case; the WS-as-byte-stream design
  does not extend to datagrams cleanly anyway.
- **Reconnect / attach-to-next-run.** v1 exits cleanly when the run ends.
- **First-class raw TCP UX** (DBs, LSPs, etc.). Works incidentally because
  the tunnel is byte-transparent; not advertised, documented, or tested.
- **Auth above the existing network boundary.** Tailscale stays the only
  trust boundary, matching the rest of FBI.
