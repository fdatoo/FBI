# Port Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a port-tunnel feature so the operator can forward TCP from any running run's container into their laptop via a small Go CLI, making agent-spawned dev servers reachable as `http://localhost:<port>/` with no path mangling, DNS changes, or Tailscale ACL changes.

**Architecture:** Two new FBI HTTP/WS endpoints (`GET /api/runs/:id/listening-ports`, WS `/api/runs/:id/proxy/:port`) plus a static Go binary `fbi-tunnel` in a new `cli/fbi-tunnel/` directory. Server reads `/proc/<container-pid>/net/tcp` to discover listening ports and pipes raw bytes between WS frames and a TCP socket on the container's bridge IP. CLI auto-discovers ports, opens local listeners, and tunnels each inbound connection over its own WS.

**Tech Stack:** TypeScript / Fastify / dockerode / `ws` (server side, existing); Go ≥1.22 / `gorilla/websocket` (CLI, new). Vitest for server tests, Go's built-in `testing` package for CLI tests.

**Spec:** [`docs/superpowers/specs/2026-04-22-port-tunnel-design.md`](../specs/2026-04-22-port-tunnel-design.md)

---

## Task 1: `/proc/<pid>/net/tcp` parser

**Files:**
- Create: `src/server/proxy/procListeners.ts`
- Create: `src/server/proxy/procListeners.test.ts`
- Create: `src/server/proxy/__fixtures__/proc-net-tcp-empty.txt`
- Create: `src/server/proxy/__fixtures__/proc-net-tcp-one-listener.txt`
- Create: `src/server/proxy/__fixtures__/proc-net-tcp-many.txt`

The parser is pure: input is the raw text of `/proc/<pid>/net/tcp`, output is `{ port: number; proto: 'tcp' }[]` for sockets in the LISTEN state (`st === '0A'`). It handles the header line, ignores established connections, and dedupes by port.

- [ ] **Step 1: Write the empty fixture**

Create `src/server/proxy/__fixtures__/proc-net-tcp-empty.txt` with just the header (no socket rows):

```
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode                                                     
```

- [ ] **Step 2: Write the one-listener fixture**

Create `src/server/proxy/__fixtures__/proc-net-tcp-one-listener.txt`. Port 5173 = `1435` in hex. Local address `0.0.0.0:5173` is `00000000:1435`. State LISTEN is `0A`.

```
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode                                                     
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 87654321 1 ffff8c4a00000000 100 0 0 10 0
```

- [ ] **Step 3: Write the many-rows fixture**

Create `src/server/proxy/__fixtures__/proc-net-tcp-many.txt`. Two LISTEN sockets (5173 + 9229; `9229` hex = `240D`), one ESTABLISHED (`01`) that should be filtered out, and a duplicate LISTEN on 5173 from a second binding.

```
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode                                                     
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111111 1 ffff8c4a00000000 100 0 0 10 0
   1: 0100007F:240D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222222 1 ffff8c4a00000000 100 0 0 10 0
   2: 0100007F:1435 0100007F:8FAA 01 00000000:00000000 00:00000000 00000000  1000        0 33333333 1 ffff8c4a00000000 100 0 0 10 0
   3: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444444 1 ffff8c4a00000000 100 0 0 10 0
```

- [ ] **Step 4: Write failing tests**

Create `src/server/proxy/procListeners.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseProcNetTcp } from './procListeners.js';

const FIX = path.join(__dirname, '__fixtures__');
const read = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8');

describe('parseProcNetTcp', () => {
  it('returns [] for the header-only fixture', () => {
    expect(parseProcNetTcp(read('proc-net-tcp-empty.txt'))).toEqual([]);
  });

  it('parses a single LISTEN socket', () => {
    expect(parseProcNetTcp(read('proc-net-tcp-one-listener.txt'))).toEqual([
      { port: 5173, proto: 'tcp' },
    ]);
  });

  it('filters non-LISTEN, dedupes ports, returns sorted ascending', () => {
    expect(parseProcNetTcp(read('proc-net-tcp-many.txt'))).toEqual([
      { port: 5173, proto: 'tcp' },
      { port: 9229, proto: 'tcp' },
    ]);
  });
});
```

- [ ] **Step 5: Run tests to confirm they fail**

Run: `npx vitest run src/server/proxy/procListeners.test.ts`
Expected: FAIL — module `./procListeners.js` not found.

- [ ] **Step 6: Implement the parser**

Create `src/server/proxy/procListeners.ts`:

```ts
export interface ListeningPort {
  port: number;
  proto: 'tcp';
}

export function parseProcNetTcp(text: string): ListeningPort[] {
  const seen = new Set<number>();
  const out: ListeningPort[] = [];
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('sl')) continue;
    // Format: "  N: <local_addr> <rem_addr> <st> ..."
    const parts = line.split(/\s+/);
    // After splitting, parts[0] is "N:", parts[1] is local_address, parts[2] rem, parts[3] state.
    if (parts.length < 4) continue;
    const local = parts[1];
    const state = parts[3];
    if (state !== '0A') continue; // not LISTEN
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const portHex = local.slice(colon + 1);
    const port = parseInt(portHex, 16);
    if (!Number.isFinite(port) || port <= 0) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    out.push({ port, proto: 'tcp' });
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}
```

- [ ] **Step 7: Run tests to confirm they pass**

Run: `npx vitest run src/server/proxy/procListeners.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 9: Commit**

```bash
git add src/server/proxy/
git commit -m "feat(proxy): /proc/<pid>/net/tcp LISTEN parser"
```

---

## Task 2: Expose live container handle from orchestrator

**Files:**
- Modify: `src/server/orchestrator/index.ts`

The proxy module needs the container handle for the run's live container without depending on dockerode itself. Add one method that returns `null` when the run isn't currently running (no entry in `active`).

- [ ] **Step 1: Modify the orchestrator to expose the handle**

In `src/server/orchestrator/index.ts`, add this public method after `cancel(...)`:

```ts
  /** Returns the container handle for a run that is currently running or
   *  resuming, or null if the run has no live container. */
  getLiveContainer(runId: number): Docker.Container | null {
    return this.active.get(runId)?.container ?? null;
  }
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): getLiveContainer accessor for proxy"
```

---

## Task 3: Discovery HTTP endpoint (unit)

**Files:**
- Create: `src/server/api/proxy.ts`
- Create: `src/server/api/proxy.test.ts`

Defines `registerProxyRoutes(app, deps)`. For now only the discovery route. The WS tunnel is added in Task 4.

- [ ] **Step 1: Write the failing test**

Create `src/server/api/proxy.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { registerProxyRoutes } from './proxy.js';

interface Container {
  inspect: () => Promise<{ State: { Pid: number }; NetworkSettings: { IPAddress: string; Networks?: Record<string, { IPAddress: string }> } }>;
}

function makeApp(opts: {
  runsRepo: RunsRepo;
  streams?: RunStreamRegistry;
  getLiveContainer: (runId: number) => Container | null;
  procReader?: (pid: number) => string;
}): Promise<FastifyInstance> {
  const app = Fastify();
  registerProxyRoutes(app, {
    runs: opts.runsRepo,
    streams: opts.streams ?? new RunStreamRegistry(),
    orchestrator: { getLiveContainer: opts.getLiveContainer as never },
    procReader: opts.procReader,
  });
  return app.ready().then(() => app);
}

function setupRunsRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-proxy-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const make = () => runs.create({
    project_id: p.id, prompt: 'hi',
    log_path_tmpl: (id) => path.join(dir, `${id}.log`),
  });
  return { runs, make };
}

describe('GET /api/runs/:id/listening-ports', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it('returns 404 when run does not exist', async () => {
    const { runs } = setupRunsRepo();
    app = await makeApp({ runsRepo: runs, getLiveContainer: () => null });
    const res = await app.inject({ method: 'GET', url: '/api/runs/999/listening-ports' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when run exists but has no live container', async () => {
    const { runs, make } = setupRunsRepo();
    const run = make(); // queued, no container
    app = await makeApp({ runsRepo: runs, getLiveContainer: () => null });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/listening-ports` });
    expect(res.statusCode).toBe(409);
  });

  it('returns the parsed LISTEN ports for a running container', async () => {
    const { runs, make } = setupRunsRepo();
    const run = make();
    runs.markStarted(run.id, 'cid');
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 12345 },
        NetworkSettings: { IPAddress: '172.17.0.5' },
      }),
    };
    const procReader = vi.fn().mockReturnValue(
      `  sl  local_address rem_address   st ...
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 a 100 0 0 10 0
`,
    );
    app = await makeApp({
      runsRepo: runs,
      getLiveContainer: () => container,
      procReader,
    });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/listening-ports` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ports: [{ port: 5173, proto: 'tcp' }] });
    expect(procReader).toHaveBeenCalledWith(12345);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `npx vitest run src/server/api/proxy.test.ts`
Expected: FAIL — module `./proxy.js` not found.

- [ ] **Step 3: Implement the route**

Create `src/server/api/proxy.ts`. Note: `streams` is declared in the interface from the start (Task 4 will use it for state-driven WS close); the discovery route does not consume it.

```ts
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { RunsRepo } from '../db/runs.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { parseProcNetTcp } from '../proxy/procListeners.js';

export interface ProxyOrchestrator {
  getLiveContainer(runId: number): {
    inspect: () => Promise<{
      State: { Pid: number };
      NetworkSettings: { IPAddress: string; Networks?: Record<string, { IPAddress: string }> };
    }>;
  } | null;
}

export interface ProxyDeps {
  runs: RunsRepo;
  streams: RunStreamRegistry;
  orchestrator: ProxyOrchestrator;
  /** Override for tests; defaults to fs.readFileSync('/proc/<pid>/net/tcp'). */
  procReader?: (pid: number) => string;
}

const defaultProcReader = (pid: number): string =>
  fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8');

export function registerProxyRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  const procReader = deps.procReader ?? defaultProcReader;

  app.get('/api/runs/:id/listening-ports', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    if (!Number.isFinite(runId)) return reply.code(400).send({ error: 'invalid run id' });
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const container = deps.orchestrator.getLiveContainer(runId);
    if (!container) return reply.code(409).send({ error: `run ${runId} is not running` });
    const inspect = await container.inspect();
    const pid = inspect.State.Pid;
    if (!pid) return reply.code(409).send({ error: 'container has no pid' });
    let text: string;
    try { text = procReader(pid); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `read /proc failed: ${msg}` });
    }
    return reply.send({ ports: parseProcNetTcp(text) });
  });
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run: `npx vitest run src/server/api/proxy.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/api/proxy.ts src/server/api/proxy.test.ts
git commit -m "feat(api): GET /api/runs/:id/listening-ports"
```

---

## Task 4: WebSocket TCP-tunnel endpoint

**Files:**
- Modify: `src/server/api/proxy.ts`
- Modify: `src/server/api/proxy.test.ts`

Adds the WS upgrade route `/api/runs/:id/proxy/:port`. Pipes binary frames ↔ TCP. Subscribes to the run's state stream and closes the WS with code 1001 if the run leaves `running`/`resuming`. Implements basic backpressure: pause TCP socket on `socket.send` with a not-yet-drained buffer; resume on `bufferedAmount === 0` poll.

- [ ] **Step 1: Add the WS test (failing)**

Add these imports to the **top** of `src/server/api/proxy.test.ts` (next to the existing imports — `RunStreamRegistry` is already imported from Task 3, do not duplicate):

```ts
import net from 'node:net';
import WebSocket from 'ws';
import fastifyWebsocket from '@fastify/websocket';
```

Then append to the bottom of the file:

```ts
async function makeWsApp(opts: {
  runsRepo: RunsRepo;
  streams: RunStreamRegistry;
  getLiveContainer: (runId: number) => Container | null;
  procReader?: (pid: number) => string;
}): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  registerProxyRoutes(app, {
    runs: opts.runsRepo,
    streams: opts.streams,
    orchestrator: { getLiveContainer: opts.getLiveContainer as never },
    procReader: opts.procReader,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { app, port: addr.port };
}

describe('WS /api/runs/:id/proxy/:port', () => {
  let app: FastifyInstance | null = null;
  let upstream: net.Server | null = null;
  afterEach(async () => {
    await app?.close(); app = null;
    if (upstream) { await new Promise<void>((r) => upstream!.close(() => r())); upstream = null; }
  });

  it('echoes bytes between WS and an upstream TCP socket', async () => {
    // Upstream echo server bound to a free port on localhost.
    const received = await new Promise<{ port: number }>((resolve) => {
      upstream = net.createServer((s) => s.on('data', (d) => s.write(d)));
      upstream.listen(0, '127.0.0.1', () => {
        const a = upstream!.address();
        if (!a || typeof a === 'string') throw new Error('no port');
        resolve({ port: a.port });
      });
    });

    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/${received.port}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

    const echoed = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      ws.on('message', (d, isBinary) => {
        if (!isBinary) return;
        chunks.push(d as Buffer);
        if (Buffer.concat(chunks).toString() === 'hello') resolve(Buffer.concat(chunks));
      });
      ws.send(Buffer.from('hello'), { binary: true });
    });
    expect(echoed.toString()).toBe('hello');
    ws.close();
  });

  it('closes WS with 1011 when upstream connect fails', async () => {
    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/1`); // port 1: refused
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1011);
  });

  it('closes WS with 1001 when run leaves running state', async () => {
    const received = await new Promise<{ port: number }>((resolve) => {
      upstream = net.createServer((s) => s.on('data', () => { /* swallow */ }));
      upstream.listen(0, '127.0.0.1', () => {
        const a = upstream!.address();
        if (!a || typeof a === 'string') throw new Error('no port');
        resolve({ port: a.port });
      });
    });
    const { runs, make } = setupRunsRepo();
    const run = make(); runs.markStarted(run.id, 'cid');
    const streams = new RunStreamRegistry();
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'running', next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const container: Container = {
      inspect: async () => ({
        State: { Pid: 1 },
        NetworkSettings: { IPAddress: '127.0.0.1' },
      }),
    };
    const r = await makeWsApp({ runsRepo: runs, streams, getLiveContainer: () => container });
    app = r.app;

    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/runs/${run.id}/proxy/${received.port}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    streams.getOrCreateState(run.id).publish({ type: 'state', state: 'succeeded', next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1001);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run src/server/api/proxy.test.ts`
Expected: FAIL — `streams` not in `ProxyDeps`, no WS route registered.

- [ ] **Step 3: Update `proxy.ts` to add WS route + state-driven close**

Replace the contents of `src/server/api/proxy.ts` with:

```ts
import fs from 'node:fs';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { RunsRepo } from '../db/runs.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { parseProcNetTcp } from '../proxy/procListeners.js';

export interface ProxyOrchestrator {
  getLiveContainer(runId: number): {
    inspect: () => Promise<{
      State: { Pid: number };
      NetworkSettings: {
        IPAddress: string;
        Networks?: Record<string, { IPAddress: string }>;
      };
    }>;
  } | null;
}

export interface ProxyDeps {
  runs: RunsRepo;
  streams: RunStreamRegistry;
  orchestrator: ProxyOrchestrator;
  procReader?: (pid: number) => string;
}

const defaultProcReader = (pid: number): string =>
  fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8');

function pickBridgeIp(inspect: {
  NetworkSettings: { IPAddress: string; Networks?: Record<string, { IPAddress: string }> };
}): string | null {
  if (inspect.NetworkSettings.IPAddress) return inspect.NetworkSettings.IPAddress;
  const nets = inspect.NetworkSettings.Networks;
  if (!nets) return null;
  for (const k of Object.keys(nets)) {
    const ip = nets[k]?.IPAddress;
    if (ip) return ip;
  }
  return null;
}

export function registerProxyRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  const procReader = deps.procReader ?? defaultProcReader;

  app.get('/api/runs/:id/listening-ports', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    if (!Number.isFinite(runId)) return reply.code(400).send({ error: 'invalid run id' });
    const run = deps.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const container = deps.orchestrator.getLiveContainer(runId);
    if (!container) return reply.code(409).send({ error: `run ${runId} is not running` });
    const inspect = await container.inspect();
    const pid = inspect.State.Pid;
    if (!pid) return reply.code(409).send({ error: 'container has no pid' });
    let text: string;
    try { text = procReader(pid); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `read /proc failed: ${msg}` });
    }
    return reply.send({ ports: parseProcNetTcp(text) });
  });

  app.get('/api/runs/:id/proxy/:port', { websocket: true }, async (socket: WebSocket, req) => {
    const { id, port } = req.params as { id: string; port: string };
    const runId = Number(id);
    const targetPort = Number(port);
    if (!Number.isFinite(runId)) return socket.close(4004, 'invalid run id');
    if (!Number.isFinite(targetPort) || targetPort <= 0 || targetPort > 65535) {
      return socket.close(4004, 'invalid port');
    }
    const run = deps.runs.get(runId);
    if (!run) return socket.close(4004, 'run not found');
    const container = deps.orchestrator.getLiveContainer(runId);
    if (!container) return socket.close(4009, 'run not running');
    let inspect: Awaited<ReturnType<typeof container.inspect>>;
    try { inspect = await container.inspect(); }
    catch { return socket.close(1011, 'inspect failed'); }
    const ip = pickBridgeIp(inspect);
    if (!ip) return socket.close(1011, 'no bridge ip');

    const tcp = net.connect(targetPort, ip);
    let closed = false;
    let stateUnsub: () => void = () => {};
    const closeBoth = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      try { socket.close(code, reason); } catch { /* noop */ }
      tcp.destroy();
      stateUnsub();
    };

    tcp.on('error', () => closeBoth(1011, 'upstream error'));
    tcp.on('end', () => closeBoth(1000, 'upstream end'));
    tcp.on('data', (chunk: Buffer) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(chunk, { binary: true });
      // Backpressure: pause if WS send buffer is filling up.
      if (socket.bufferedAmount > 1 << 20) tcp.pause();
    });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return; // text frames are not part of this protocol
      tcp.write(data);
    });
    socket.on('close', () => closeBoth(1000, 'client closed'));
    socket.on('error', () => closeBoth(1011, 'ws error'));

    // Drain poll: resume TCP once buffered WS data drops.
    const drain = setInterval(() => {
      if (closed) { clearInterval(drain); return; }
      if (tcp.isPaused() && socket.bufferedAmount < 1 << 18) tcp.resume();
    }, 50);
    socket.on('close', () => clearInterval(drain));

    // State-driven close. Subscribe AFTER closeBoth/stateUnsub are defined so
    // an immediate replay of a non-running frame can call closeBoth safely.
    stateUnsub = deps.streams.getOrCreateState(runId).subscribe((frame) => {
      if (frame.state !== 'running' && frame.state !== 'resuming') {
        closeBoth(1001, 'run ended');
      }
    });
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run src/server/api/proxy.test.ts`
Expected: PASS — all 6 tests pass (3 discovery + 3 WS).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/api/proxy.ts src/server/api/proxy.test.ts
git commit -m "feat(api): WS /api/runs/:id/proxy/:port byte tunnel"
```

---

## Task 5: Wire proxy routes in the server entrypoint

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add the import and route registration**

In `src/server/index.ts`, add the import next to the other api route imports:

```ts
import { registerProxyRoutes } from './api/proxy.js';
```

Add the registration call alongside the other `register*Routes` lines (after `registerWsRoute`):

```ts
  registerProxyRoutes(app, {
    runs, streams,
    orchestrator: { getLiveContainer: (id) => orchestrator.getLiveContainer(id) },
  });
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All passing (no regressions).

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(server): wire proxy routes"
```

---

## Task 6: Docker-gated end-to-end integration test

**Files:**
- Create: `src/server/api/proxy.integration.test.ts`

Spins up a real container that listens on a port, then exercises both endpoints over HTTP/WS against the live container's bridge IP. Auto-skips when Docker is unreachable.

- [ ] **Step 1: Write the failing integration test**

Create `src/server/api/proxy.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { RunStreamRegistry } from '../logs/registry.js';
import { registerProxyRoutes } from './proxy.js';

async function dockerAvailable(): Promise<boolean> {
  try { await new Docker().ping(); return true; } catch { return false; }
}

describe('proxy integration (Docker-gated)', () => {
  it('discovers a port and tunnels an HTTP request through the WS', async () => {
    if (!(await dockerAvailable())) return;
    const docker = new Docker();

    // Start a tiny HTTP server inside an alpine container on port 8000.
    const container = await docker.createContainer({
      Image: 'python:3-alpine',
      Cmd: ['python3', '-m', 'http.server', '8000'],
      HostConfig: { AutoRemove: false },
    });
    try {
      await container.start();

      // Repo plumbing for the route.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-pi-'));
      const db = openDb(path.join(dir, 'db.sqlite'));
      const projects = new ProjectsRepo(db);
      const runs = new RunsRepo(db);
      const streams = new RunStreamRegistry();
      const p = projects.create({
        name: 'p', repo_url: 'r', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null,
      });
      const run = runs.create({
        project_id: p.id, prompt: 'hi',
        log_path_tmpl: (id) => path.join(dir, `${id}.log`),
      });
      runs.markStarted(run.id, container.id);
      streams.getOrCreateState(run.id).publish({
        type: 'state', state: 'running',
        next_resume_at: null, resume_attempts: 0, last_limit_reset_at: null,
      });

      const app = Fastify();
      await app.register(fastifyWebsocket);
      registerProxyRoutes(app, {
        runs, streams,
        orchestrator: { getLiveContainer: () => container as never },
      });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const port = addr.port;

      // Wait briefly for python http.server to bind.
      for (let i = 0; i < 20; i++) {
        const r = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/listening-ports`);
        const body = await r.json() as { ports: { port: number }[] };
        if (body.ports.some((p2) => p2.port === 8000)) break;
        await new Promise((r2) => setTimeout(r2, 250));
      }

      // Now tunnel an HTTP/1.1 GET / through the WS.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${run.id}/proxy/8000`);
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      const response = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        ws.on('message', (d, isBinary) => {
          if (!isBinary) return;
          chunks.push(d as Buffer);
          const buf = Buffer.concat(chunks).toString();
          if (buf.includes('\r\n\r\n')) resolve(buf);
        });
        ws.send(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'), { binary: true });
      });
      ws.close();
      await app.close();

      expect(response.startsWith('HTTP/1.0 200') || response.startsWith('HTTP/1.1 200')).toBe(true);
    } finally {
      await container.remove({ force: true, v: true }).catch(() => {});
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run src/server/api/proxy.integration.test.ts`
Expected:
- If Docker is available: PASS — discovery returns `8000`, tunneled request returns an HTTP 200 response.
- If Docker is unreachable: PASS (auto-skip — no assertions hit).

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: All passing.

- [ ] **Step 4: Commit**

```bash
git add src/server/api/proxy.integration.test.ts
git commit -m "test(api): Docker-gated proxy end-to-end"
```

---

## Task 7: Scaffold `cli/fbi-tunnel` Go module

**Files:**
- Create: `cli/fbi-tunnel/go.mod`
- Create: `cli/fbi-tunnel/main.go`
- Create: `cli/fbi-tunnel/Makefile`
- Create: `cli/fbi-tunnel/.gitignore`
- Create: `cli/fbi-tunnel/README.md`

A minimal "hello, world" main that we'll grow over the next tasks. Goal of this task is to verify Go is available and the build works.

- [ ] **Step 1: Verify Go is installed**

Run: `go version`
Expected: prints `go version go1.22+ ...`. If missing, install Go ≥1.22 before continuing (`brew install go`, `apt install golang`, etc.). Stop and ask the operator if Go cannot be installed in this environment.

- [ ] **Step 2: Create the Go module**

Run from the repo root:
```bash
mkdir -p cli/fbi-tunnel
cd cli/fbi-tunnel
go mod init github.com/fynn-labs/FBI/cli/fbi-tunnel
```

- [ ] **Step 3: Create `main.go`**

Create `cli/fbi-tunnel/main.go`:

```go
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...")
		os.Exit(2)
	}
	fmt.Println("fbi-tunnel scaffold")
}
```

- [ ] **Step 4: Create the Makefile**

Create `cli/fbi-tunnel/Makefile`:

```make
.PHONY: build test install clean

DIST := dist
BINARIES := \
  $(DIST)/fbi-tunnel-darwin-amd64 \
  $(DIST)/fbi-tunnel-darwin-arm64 \
  $(DIST)/fbi-tunnel-linux-amd64 \
  $(DIST)/fbi-tunnel-linux-arm64

build: $(BINARIES)

$(DIST)/fbi-tunnel-%:
	@mkdir -p $(DIST)
	GOOS=$(word 1,$(subst -, ,$*)) GOARCH=$(word 2,$(subst -, ,$*)) \
	  go build -trimpath -ldflags='-s -w' -o $@ .

test:
	go test ./...

install:
	go build -trimpath -ldflags='-s -w' -o $(HOME)/.local/bin/fbi-tunnel .

clean:
	rm -rf $(DIST)
```

- [ ] **Step 5: Create `.gitignore`**

Create `cli/fbi-tunnel/.gitignore`:

```
dist/
```

- [ ] **Step 6: Create README**

Create `cli/fbi-tunnel/README.md`:

```markdown
# fbi-tunnel

Local CLI that forwards TCP from your laptop into an FBI run's container.
See [the design spec](../../docs/superpowers/specs/2026-04-22-port-tunnel-design.md).

## Usage

    fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...

Examples:

    fbi-tunnel http://fbi.tailnet:3000 42
    fbi-tunnel http://fbi.tailnet:3000 42 -L 5173:5173 -L 9229:9229
    fbi-tunnel http://fbi.tailnet:3000 42 -L 8080:5173

## Build

    make build              # cross-compiles to dist/
    make install            # installs host binary to ~/.local/bin
    make test
```

- [ ] **Step 7: Run the build**

Run from the repo root: `make -C cli/fbi-tunnel install`
Expected: succeeds, `~/.local/bin/fbi-tunnel` exists.

Run: `~/.local/bin/fbi-tunnel http://x 1`
Expected: prints `fbi-tunnel scaffold` and exits 0.

- [ ] **Step 8: Commit**

```bash
git add cli/fbi-tunnel/
git commit -m "feat(cli): scaffold fbi-tunnel Go module"
```

---

## Task 8: CLI argument parsing

**Files:**
- Create: `cli/fbi-tunnel/args.go`
- Create: `cli/fbi-tunnel/args_test.go`

Pure parsing: takes `[]string` of os.Args[1:], returns a struct with `FBIUrl`, `RunID`, and `[]Override{Local, Remote int}` plus a usage error string.

- [ ] **Step 1: Write the failing test**

Create `cli/fbi-tunnel/args_test.go`:

```go
package main

import (
	"reflect"
	"testing"
)

func TestParseArgs_minimum(t *testing.T) {
	got, err := parseArgs([]string{"http://x:3000", "42"})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	want := Args{FBIUrl: "http://x:3000", RunID: 42, Overrides: nil}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestParseArgs_overrides(t *testing.T) {
	got, err := parseArgs([]string{
		"http://x:3000", "42",
		"-L", "5173:5173", "-L", "8080:9229",
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	want := Args{
		FBIUrl: "http://x:3000", RunID: 42,
		Overrides: []Override{{Local: 5173, Remote: 5173}, {Local: 8080, Remote: 9229}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestParseArgs_errors(t *testing.T) {
	cases := [][]string{
		{},                                  // missing url+id
		{"http://x"},                        // missing id
		{"http://x", "abc"},                 // non-numeric id
		{"http://x", "42", "-L"},            // -L missing value
		{"http://x", "42", "-L", "abc"},     // -L bad format
		{"http://x", "42", "-L", "5173:0"},  // remote out of range
		{"http://x", "42", "-L", "0:5173"},  // local out of range
	}
	for _, c := range cases {
		if _, err := parseArgs(c); err == nil {
			t.Errorf("parseArgs(%v) expected error, got nil", c)
		}
	}
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: FAIL — `parseArgs` undefined.

- [ ] **Step 3: Implement `parseArgs`**

Create `cli/fbi-tunnel/args.go`:

```go
package main

import (
	"fmt"
	"strconv"
	"strings"
)

type Override struct {
	Local  int
	Remote int
}

type Args struct {
	FBIUrl    string
	RunID     int
	Overrides []Override
}

func parseArgs(argv []string) (Args, error) {
	if len(argv) < 2 {
		return Args{}, fmt.Errorf("usage: fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...")
	}
	out := Args{FBIUrl: argv[0]}
	id, err := strconv.Atoi(argv[1])
	if err != nil {
		return Args{}, fmt.Errorf("invalid run id %q", argv[1])
	}
	out.RunID = id
	for i := 2; i < len(argv); i++ {
		switch argv[i] {
		case "-L":
			if i+1 >= len(argv) {
				return Args{}, fmt.Errorf("-L requires a value")
			}
			ov, err := parseLFlag(argv[i+1])
			if err != nil {
				return Args{}, err
			}
			out.Overrides = append(out.Overrides, ov)
			i++
		default:
			return Args{}, fmt.Errorf("unknown argument %q", argv[i])
		}
	}
	return out, nil
}

func parseLFlag(v string) (Override, error) {
	parts := strings.SplitN(v, ":", 2)
	if len(parts) != 2 {
		return Override{}, fmt.Errorf("-L must be localport:remoteport, got %q", v)
	}
	local, err := strconv.Atoi(parts[0])
	if err != nil || local <= 0 || local > 65535 {
		return Override{}, fmt.Errorf("invalid local port in %q", v)
	}
	remote, err := strconv.Atoi(parts[1])
	if err != nil || remote <= 0 || remote > 65535 {
		return Override{}, fmt.Errorf("invalid remote port in %q", v)
	}
	return Override{Local: local, Remote: remote}, nil
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/fbi-tunnel/
git commit -m "feat(cli): argument parsing"
```

---

## Task 9: Mapping merge logic

**Files:**
- Create: `cli/fbi-tunnel/mapping.go`
- Create: `cli/fbi-tunnel/mapping_test.go`

Pure merge: takes the discovered ports from the server and a list of `-L` overrides. Returns a sorted list of `(local, remote)` pairs. Override semantics: if an override's `Remote` matches a discovered port, it replaces the local side; otherwise it's appended as a new mapping.

- [ ] **Step 1: Write the failing test**

Create `cli/fbi-tunnel/mapping_test.go`:

```go
package main

import (
	"reflect"
	"sort"
	"testing"
)

func sortPairs(p []Mapping) []Mapping {
	cp := append([]Mapping(nil), p...)
	sort.Slice(cp, func(i, j int) bool { return cp[i].Remote < cp[j].Remote })
	return cp
}

func TestMerge_discoveryOnly(t *testing.T) {
	got := mergeMappings([]int{5173, 9229}, nil)
	want := []Mapping{{Local: 5173, Remote: 5173}, {Local: 9229, Remote: 9229}}
	if !reflect.DeepEqual(sortPairs(got), want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestMerge_overrideWins(t *testing.T) {
	got := mergeMappings(
		[]int{5173, 9229},
		[]Override{{Local: 8080, Remote: 5173}},
	)
	want := []Mapping{{Local: 8080, Remote: 5173}, {Local: 9229, Remote: 9229}}
	if !reflect.DeepEqual(sortPairs(got), want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestMerge_overrideAdds(t *testing.T) {
	got := mergeMappings(
		[]int{5173},
		[]Override{{Local: 9000, Remote: 9000}},
	)
	want := []Mapping{{Local: 5173, Remote: 5173}, {Local: 9000, Remote: 9000}}
	if !reflect.DeepEqual(sortPairs(got), want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestMerge_overridesOnlyWhenNoDiscovery(t *testing.T) {
	got := mergeMappings(nil, []Override{{Local: 5173, Remote: 5173}})
	want := []Mapping{{Local: 5173, Remote: 5173}}
	if !reflect.DeepEqual(sortPairs(got), want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: FAIL — `mergeMappings`, `Mapping` undefined.

- [ ] **Step 3: Implement merge**

Create `cli/fbi-tunnel/mapping.go`:

```go
package main

type Mapping struct {
	Local  int
	Remote int
}

func mergeMappings(discovered []int, overrides []Override) []Mapping {
	byRemote := make(map[int]int) // remote -> local
	for _, p := range discovered {
		byRemote[p] = p
	}
	for _, o := range overrides {
		byRemote[o.Remote] = o.Local
	}
	out := make([]Mapping, 0, len(byRemote))
	for remote, local := range byRemote {
		out = append(out, Mapping{Local: local, Remote: remote})
	}
	return out
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/fbi-tunnel/
git commit -m "feat(cli): mapping merge logic"
```

---

## Task 10: Discovery client

**Files:**
- Create: `cli/fbi-tunnel/client.go`
- Create: `cli/fbi-tunnel/client_test.go`

Single function: `discoverPorts(baseUrl string, runId int) ([]int, error)` that hits `GET /api/runs/<id>/listening-ports`, parses the response, returns the port numbers (or a useful error for 4xx/5xx).

- [ ] **Step 1: Write the failing test**

Create `cli/fbi-tunnel/client_test.go`:

```go
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDiscover_ok(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runs/42/listening-ports" {
			t.Errorf("bad path %s", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ports":[{"port":5173,"proto":"tcp"},{"port":9229,"proto":"tcp"}]}`))
	}))
	defer srv.Close()
	got, err := discoverPorts(srv.URL, 42)
	if err != nil { t.Fatalf("err: %v", err) }
	if len(got) != 2 || got[0] != 5173 || got[1] != 9229 {
		t.Errorf("got %v", got)
	}
}

func TestDiscover_404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"run not found"}`, 404)
	}))
	defer srv.Close()
	_, err := discoverPorts(srv.URL, 42)
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("expected 404 error, got %v", err)
	}
}

func TestDiscover_409(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"run is not running"}`, 409)
	}))
	defer srv.Close()
	_, err := discoverPorts(srv.URL, 42)
	if err == nil || !strings.Contains(err.Error(), "409") {
		t.Errorf("expected 409 error, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: FAIL — `discoverPorts` undefined.

- [ ] **Step 3: Implement the client**

Create `cli/fbi-tunnel/client.go`:

```go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type discoveryResp struct {
	Ports []struct {
		Port  int    `json:"port"`
		Proto string `json:"proto"`
	} `json:"ports"`
}

func discoverPorts(baseUrl string, runId int) ([]int, error) {
	url := fmt.Sprintf("%s/api/runs/%d/listening-ports", strings.TrimRight(baseUrl, "/"), runId)
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out discoveryResp
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}
	ports := make([]int, 0, len(out.Ports))
	for _, p := range out.Ports {
		ports = append(ports, p.Port)
	}
	return ports, nil
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: PASS — 3 client tests pass plus existing tests.

- [ ] **Step 5: Commit**

```bash
git add cli/fbi-tunnel/
git commit -m "feat(cli): discovery client"
```

---

## Task 11: WebSocket forwarder

**Files:**
- Create: `cli/fbi-tunnel/forwarder.go`
- Create: `cli/fbi-tunnel/forwarder_test.go`

`forwardConn(baseUrl, runId, remotePort, local net.Conn)` — opens a WS to the proxy endpoint, pipes bytes both directions until either side closes. Tested against an in-process WS server that echoes binary frames.

- [ ] **Step 1: Add gorilla/websocket dep**

Run from `cli/fbi-tunnel/`:
```bash
go get github.com/gorilla/websocket@v1.5.3
```

Expected: `go.mod` and `go.sum` updated.

- [ ] **Step 2: Write the failing test**

Create `cli/fbi-tunnel/forwarder_test.go`:

```go
package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestForwardConn_echo(t *testing.T) {
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/runs/42/proxy/") {
			t.Errorf("bad path %s", r.URL.Path)
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil { t.Fatal(err) }
		defer ws.Close()
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil { return }
			if err := ws.WriteMessage(websocket.BinaryMessage, msg); err != nil { return }
		}
	}))
	defer srv.Close()

	a, b := net.Pipe()
	defer a.Close(); defer b.Close()

	done := make(chan error, 1)
	go func() { done <- forwardConn(srv.URL, 42, 8000, b) }()

	if _, err := a.Write([]byte("hello")); err != nil { t.Fatal(err) }
	buf := make([]byte, 5)
	if _, err := a.Read(buf); err != nil { t.Fatal(err) }
	if string(buf) != "hello" {
		t.Errorf("got %q want hello", string(buf))
	}
	a.Close()
	<-done
}
```

- [ ] **Step 3: Run test to confirm it fails**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: FAIL — `forwardConn` undefined.

- [ ] **Step 4: Implement the forwarder**

Create `cli/fbi-tunnel/forwarder.go`:

```go
package main

import (
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"

	"github.com/gorilla/websocket"
)

func wsUrl(baseUrl string) (string, error) {
	u, err := url.Parse(strings.TrimRight(baseUrl, "/"))
	if err != nil { return "", err }
	switch u.Scheme {
	case "http":  u.Scheme = "ws"
	case "https": u.Scheme = "wss"
	case "ws", "wss": // already
	default: return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	return u.String(), nil
}

func forwardConn(baseUrl string, runId int, remotePort int, local net.Conn) error {
	wsBase, err := wsUrl(baseUrl)
	if err != nil { return err }
	dialUrl := fmt.Sprintf("%s/api/runs/%d/proxy/%d", wsBase, runId, remotePort)
	ws, _, err := websocket.DefaultDialer.Dial(dialUrl, nil)
	if err != nil { return fmt.Errorf("ws dial: %w", err) }
	defer ws.Close()

	done := make(chan error, 2)

	// local -> ws
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := local.Read(buf)
			if n > 0 {
				if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					done <- werr; return
				}
			}
			if err != nil {
				if err == io.EOF { done <- nil; return }
				done <- err; return
			}
		}
	}()

	// ws -> local
	go func() {
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				done <- err; return
			}
			if _, werr := local.Write(msg); werr != nil {
				done <- werr; return
			}
		}
	}()

	err = <-done
	ws.Close()
	local.Close()
	<-done
	return err
}
```

- [ ] **Step 5: Run test to confirm it passes**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: PASS — all tests pass.

- [ ] **Step 6: Commit**

```bash
git add cli/fbi-tunnel/
git commit -m "feat(cli): WebSocket TCP forwarder"
```

---

## Task 12: Local listener with collision fallback

**Files:**
- Create: `cli/fbi-tunnel/listener.go`
- Create: `cli/fbi-tunnel/listener_test.go`

`bindLocal(preferred int) (net.Listener, int, error)` — tries `127.0.0.1:preferred`. On `EADDRINUSE`, falls back to `127.0.0.1:0` and returns the actually-bound port.

- [ ] **Step 1: Write the failing test**

Create `cli/fbi-tunnel/listener_test.go`:

```go
package main

import (
	"net"
	"testing"
)

func TestBindLocal_takesPreferred(t *testing.T) {
	l, port, err := bindLocal(0) // 0 = let kernel pick a free port
	if err != nil { t.Fatal(err) }
	defer l.Close()
	if port <= 0 { t.Errorf("port not set: %d", port) }
}

func TestBindLocal_fallsBackOnCollision(t *testing.T) {
	// Hold a port to force a collision.
	hold, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil { t.Fatal(err) }
	defer hold.Close()
	taken := hold.Addr().(*net.TCPAddr).Port

	l, port, err := bindLocal(taken)
	if err != nil { t.Fatal(err) }
	defer l.Close()
	if port == taken {
		t.Errorf("expected fallback to a different port, got the same: %d", port)
	}
	if port <= 0 {
		t.Errorf("invalid port: %d", port)
	}
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: FAIL — `bindLocal` undefined.

- [ ] **Step 3: Implement the listener**

Create `cli/fbi-tunnel/listener.go`:

```go
package main

import (
	"fmt"
	"net"
)

func bindLocal(preferred int) (net.Listener, int, error) {
	if preferred > 0 {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferred))
		if err == nil {
			return l, preferred, nil
		}
		// fall through to random
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil { return nil, 0, err }
	port := l.Addr().(*net.TCPAddr).Port
	return l, port, nil
}
```

- [ ] **Step 4: Run test to confirm it passes**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/fbi-tunnel/
git commit -m "feat(cli): local listener with collision fallback"
```

---

## Task 13: Wire it all together — main loop, table output, signal handling

**Files:**
- Modify: `cli/fbi-tunnel/main.go`
- Create: `cli/fbi-tunnel/main_test.go`

Replaces the scaffold `main.go` with the real CLI. Tests run the binary against a mocked HTTP/WS server in-process.

- [ ] **Step 1: Write the integration test**

Create `cli/fbi-tunnel/main_test.go`:

```go
package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// stubServer answers the discovery API and a single proxy WS that echoes bytes.
func stubServer(t *testing.T) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/runs/42/listening-ports", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"ports":[{"port":5173,"proto":"tcp"}]}`)
	})
	up := websocket.Upgrader{}
	mux.HandleFunc("/api/runs/42/proxy/5173", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil { t.Fatal(err) }
		defer ws.Close()
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil { return }
			ws.WriteMessage(websocket.BinaryMessage, msg)
		}
	})
	return httptest.NewServer(mux)
}

func TestRun_discoversAndForwards(t *testing.T) {
	srv := stubServer(t)
	defer srv.Close()

	args := Args{FBIUrl: srv.URL, RunID: 42}
	logBuf := &strings.Builder{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var ports []Mapping
	var mu sync.Mutex
	onReady := func(m []Mapping) { mu.Lock(); ports = m; mu.Unlock() }

	done := make(chan error, 1)
	go func() { done <- run(ctx, args, logBuf, onReady) }()

	// Wait for ready.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock(); ok := len(ports) == 1; mu.Unlock()
		if ok { break }
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock(); ready := append([]Mapping(nil), ports...); mu.Unlock()
	if len(ready) != 1 || ready[0].Remote != 5173 {
		t.Fatalf("ready ports = %+v", ready)
	}

	// Connect to the local listener and exchange a byte.
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", ready[0].Local))
	if err != nil { t.Fatal(err) }
	if _, err := conn.Write([]byte("ping")); err != nil { t.Fatal(err) }
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil { t.Fatal(err) }
	if string(buf) != "ping" {
		t.Errorf("echo failed, got %q", string(buf))
	}
	conn.Close()

	cancel()
	<-done
}
```

- [ ] **Step 2: Run test to confirm it fails**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: FAIL — `run` undefined.

- [ ] **Step 3: Replace `main.go` with the real CLI**

Replace the contents of `cli/fbi-tunnel/main.go`:

```go
package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	args, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, args, os.Stderr, func(m []Mapping) { printTable(args, m, os.Stdout) }); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run wires the full CLI: discover, bind, accept, forward. onReady is called
// once with the final mappings after listeners are bound. Returns when ctx is
// cancelled or all listeners have failed.
func run(ctx context.Context, args Args, logger io.Writer, onReady func([]Mapping)) error {
	discovered, err := discoverPorts(args.FBIUrl, args.RunID)
	if err != nil {
		return fmt.Errorf("discovery failed: %w", err)
	}
	mappings := mergeMappings(discovered, args.Overrides)

	type bound struct {
		l        net.Listener
		mapping  Mapping
	}
	bounds := make([]bound, 0, len(mappings))
	for i, m := range mappings {
		l, port, err := bindLocal(m.Local)
		if err != nil {
			fmt.Fprintf(logger, "bind failed for remote %d: %v\n", m.Remote, err)
			continue
		}
		mappings[i].Local = port
		bounds = append(bounds, bound{l: l, mapping: mappings[i]})
	}
	if len(bounds) == 0 {
		return fmt.Errorf("no listeners bound")
	}
	onReady(mappings)

	var wg sync.WaitGroup
	for _, b := range bounds {
		b := b
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer b.l.Close()
			for {
				conn, err := b.l.Accept()
				if err != nil { return }
				go func() {
					fmt.Fprintf(logger, "open  remote %d  from %s\n", b.mapping.Remote, conn.RemoteAddr())
					ferr := forwardConn(args.FBIUrl, args.RunID, b.mapping.Remote, conn)
					fmt.Fprintf(logger, "close remote %d  from %s  err=%v\n", b.mapping.Remote, conn.RemoteAddr(), ferr)
				}()
			}
		}()
	}

	<-ctx.Done()
	for _, b := range bounds { b.l.Close() }
	wg.Wait()
	return nil
}

func printTable(args Args, mappings []Mapping, w io.Writer) {
	fmt.Fprintf(w, "run %d → %s\n", args.RunID, args.FBIUrl)
	for _, m := range mappings {
		note := ""
		if m.Local != m.Remote {
			note = fmt.Sprintf("  (local %d was busy)", m.Remote)
		}
		fmt.Fprintf(w, "  remote %d  →  http://localhost:%d%s\n", m.Remote, m.Local, note)
	}
}
```

- [ ] **Step 4: Run all tests**

Run from `cli/fbi-tunnel/`: `go test ./...`
Expected: PASS — all tests pass including the new integration test.

- [ ] **Step 5: Re-build and smoke-check**

Run from the repo root: `make -C cli/fbi-tunnel install`
Expected: succeeds.

Run: `~/.local/bin/fbi-tunnel`
Expected: prints the usage line on stderr, exits 2.

- [ ] **Step 6: Commit**

```bash
git add cli/fbi-tunnel/
git commit -m "feat(cli): main loop, table output, signal handling"
```

---

## Task 14: Wire `cli:build` into `package.json` and ignore CLI artifacts at repo root

**Files:**
- Modify: `package.json`
- Modify: `.gitignore` (or create one for `cli/fbi-tunnel/dist/` if a top-level `.gitignore` is missing)

- [ ] **Step 1: Add the script**

In `package.json`, add to `"scripts"`:

```json
    "cli:build": "make -C cli/fbi-tunnel build",
    "cli:install": "make -C cli/fbi-tunnel install",
    "cli:test": "make -C cli/fbi-tunnel test",
```

- [ ] **Step 2: Verify the scripts work**

Run: `npm run cli:test`
Expected: Go tests pass.

Run: `npm run cli:build`
Expected: cross-compile produces `cli/fbi-tunnel/dist/fbi-tunnel-{darwin,linux}-{amd64,arm64}`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: cli:build/install/test scripts"
```

---

## Task 15: Final verification

- [ ] **Step 1: Run the full server suite**

Run: `npm test`
Expected: all passing.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the Go suite**

Run: `npm run cli:test`
Expected: all passing.

- [ ] **Step 4: Manual smoke test (optional, requires Docker)**

Start a local FBI dev server (`npm run dev`), kick off a run that spawns a server on a known port, then:

```bash
~/.local/bin/fbi-tunnel http://localhost:3000 <run-id>
```

Expected: prints the table; `curl http://localhost:<port>/` returns the agent's content; Ctrl-C exits cleanly.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/port-tunnel
```

Expected: branch pushed; nothing committed to `main`.
