# Port Tunnel v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the existing port-tunnel feature in the FBI web UI as a `tunnel` tab on the run detail page, and ship a download endpoint that serves pre-cross-compiled `fbi-tunnel` binaries for darwin/linux × amd64/arm64.

**Architecture:** One new API endpoint (`GET /api/cli/fbi-tunnel/:os/:arch`), one new React component (`TunnelTab`) wired into the existing drawer, one new build step that cross-compiles Go binaries via a short-lived `golang:1.22-alpine` container. Polling for listening ports and the `ports` state are lifted to `RunDetailPage` so the drawer tab header can show a live count (mirrors how `diff` is already lifted for the files tab).

**Tech Stack:** TypeScript (Fastify 5, React 18, Vitest), Go (cross-compiled via Docker), Makefile, Bash.

**Spec:** `docs/superpowers/specs/2026-04-22-port-tunnel-v1.1-design.md`

---

## File Structure

### New files

- `src/server/api/cli.ts` — `registerCliRoutes(app, deps)`. Validates `:os/:arch` against a static allowlist and streams the matching file from `deps.cliDistDir`.
- `src/server/api/cli.test.ts` — Vitest unit tests for the endpoint.
- `src/web/features/runs/detectPlatform.ts` — pure function that maps `Navigator` data to `{ os, arch }`.
- `src/web/features/runs/detectPlatform.test.ts` — unit tests for the detector.
- `src/web/features/runs/TunnelTab.tsx` — display component for the tab body; receives ports, runState, origin, runId from `RunDetailPage`.
- `src/web/features/runs/TunnelTab.test.tsx` — RTL tests.
- `cli/fbi-tunnel/scripts/build-dist.sh` — shell wrapper that runs `docker run --rm golang:1.22-alpine make dist`.

### Modified files

- `src/shared/types.ts` — add `ListeningPort` interface.
- `src/server/config.ts` — add `cliDistDir: string` to `Config` (env var `CLI_DIST_DIR`, default `dist/cli`).
- `src/server/index.ts` — call `registerCliRoutes` and log presence/absence of binaries at startup.
- `src/web/lib/api.ts` — add `getRunListeningPorts(runId)`.
- `src/web/pages/RunDetail.tsx` — hold `ports` state, poll while `running`+visible, pass ports into drawer (for count) and `TunnelTab` (for display).
- `src/web/features/runs/RunDrawer.tsx` — add `'tunnel'` to `RunTab`, accept `portsCount`, render the fourth tab entry with count.
- `cli/fbi-tunnel/Makefile` — add a `dist` target that accepts `OUT` and `VERSION`.
- `package.json` — add `"cli:dist"` script; chain it into `"build"`.
- `.gitignore` — add `dist/cli/`.
- `README.md` — one sentence in the Install section.

### Intentionally not changed

- `src/server/api/proxy.ts`, `src/server/proxy/procListeners.ts`, `cli/fbi-tunnel/*.go` — v1 code.

---

## Task 1: Add `ListeningPort` to shared types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add the interface at the end of the file.**

Open `src/shared/types.ts` and append:

```ts
export interface ListeningPort {
  port: number;
  proto: 'tcp';
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): add ListeningPort type"
```

---

## Task 2: API client method — `getRunListeningPorts`

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Add the import and the method.**

At the top of `src/web/lib/api.ts`, extend the existing type import so `ListeningPort` is in scope:

```ts
import type { DailyUsage, ListeningPort, McpServer, Project, RateLimitState, Run, RunUsageBreakdownRow, SecretName, Settings } from '@shared/types.js';
```

Inside the `export const api = { ... }` object, add a new method next to `getRun`:

```ts
  getRunListeningPorts: (id: number) =>
    request<{ ports: ListeningPort[] }>(`/api/runs/${id}/listening-ports`),
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add src/web/lib/api.ts
git commit -m "feat(api-client): add getRunListeningPorts"
```

---

## Task 3: Platform-detection pure function (test first)

**Files:**
- Create: `src/web/features/runs/detectPlatform.ts`
- Test: `src/web/features/runs/detectPlatform.test.ts`

The detector consumes *either* a `UAData`-shaped object (the modern, high-entropy Client Hints API) *or* a plain `userAgent` string (fallback for Safari, Firefox, older Chrome). Stable fallback when nothing parses is `{ os: 'darwin', arch: 'arm64' }` — macOS arm64 is the statistical majority among FBI operators.

- [ ] **Step 1: Write the failing tests.**

Create `src/web/features/runs/detectPlatform.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectPlatform } from './detectPlatform.js';

describe('detectPlatform', () => {
  it('detects macOS arm64 from UAData platform+architecture', () => {
    expect(detectPlatform({ platform: 'macOS', architecture: 'arm' })).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  it('detects macOS amd64 from UAData platform+architecture', () => {
    expect(detectPlatform({ platform: 'macOS', architecture: 'x86' })).toEqual({ os: 'darwin', arch: 'amd64' });
  });

  it('detects Linux amd64 from UAData', () => {
    expect(detectPlatform({ platform: 'Linux', architecture: 'x86' })).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it('detects Linux arm64 from UAData', () => {
    expect(detectPlatform({ platform: 'Linux', architecture: 'arm' })).toEqual({ os: 'linux', arch: 'arm64' });
  });

  it('falls back to darwin/arm64 for an empty UAData platform', () => {
    expect(detectPlatform({ platform: '', architecture: '' })).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  it('parses macOS arm64 from a modern Safari UA string', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15';
    // Safari still reports "Intel Mac OS X" on Apple Silicon; treat bare macOS UA as arm64 per fallback.
    expect(detectPlatform(ua)).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  it('parses Linux x86_64 from a UA string', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';
    expect(detectPlatform(ua)).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it('parses Linux aarch64 from a UA string', () => {
    const ua = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36';
    expect(detectPlatform(ua)).toEqual({ os: 'linux', arch: 'arm64' });
  });

  it('falls back to darwin/arm64 when given an undefined input', () => {
    expect(detectPlatform(undefined)).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  it('falls back to darwin/arm64 for an unknown UA string', () => {
    expect(detectPlatform('Mozilla/5.0 (ZX Spectrum; Z80)')).toEqual({ os: 'darwin', arch: 'arm64' });
  });
});
```

- [ ] **Step 2: Run the tests — they should fail (module not found).**

Run: `npx vitest run src/web/features/runs/detectPlatform.test.ts`
Expected: FAIL, `Cannot find module './detectPlatform.js'`.

- [ ] **Step 3: Write the implementation.**

Create `src/web/features/runs/detectPlatform.ts`:

```ts
export type OsId = 'darwin' | 'linux';
export type ArchId = 'amd64' | 'arm64';
export interface Platform { os: OsId; arch: ArchId }

export interface UADataLike {
  platform: string;
  architecture: string;
}

const FALLBACK: Platform = { os: 'darwin', arch: 'arm64' };

export function detectPlatform(input?: UADataLike | string): Platform {
  if (input == null) return FALLBACK;
  if (typeof input === 'object') return fromUAData(input);
  return fromUAString(input);
}

function fromUAData(d: UADataLike): Platform {
  const os = d.platform.toLowerCase() === 'macos' ? 'darwin'
    : d.platform.toLowerCase() === 'linux' ? 'linux'
    : null;
  if (!os) return FALLBACK;
  const arch = d.architecture.toLowerCase() === 'arm' ? 'arm64'
    : d.architecture.toLowerCase() === 'x86' ? 'amd64'
    : null;
  if (!arch) return FALLBACK;
  return { os, arch };
}

function fromUAString(ua: string): Platform {
  const lower = ua.toLowerCase();
  if (lower.includes('mac os x') || lower.includes('macintosh')) {
    // Safari on Apple Silicon still reports "Intel Mac OS X"; there is no
    // reliable way to distinguish without Client Hints, so we default to the
    // dominant case (arm64). Operators on Intel Macs can use the "other
    // platforms" link.
    return { os: 'darwin', arch: 'arm64' };
  }
  if (lower.includes('linux')) {
    if (lower.includes('aarch64') || lower.includes('arm64')) return { os: 'linux', arch: 'arm64' };
    return { os: 'linux', arch: 'amd64' };
  }
  return FALLBACK;
}
```

- [ ] **Step 4: Run the tests — they should pass.**

Run: `npx vitest run src/web/features/runs/detectPlatform.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit.**

```bash
git add src/web/features/runs/detectPlatform.ts src/web/features/runs/detectPlatform.test.ts
git commit -m "feat(tunnel): platform-detection helper for download button"
```

---

## Task 4: Server config — `cliDistDir`

**Files:**
- Modify: `src/server/config.ts`

- [ ] **Step 1: Add the field and the env-var lookup.**

In `src/server/config.ts`, add to the `Config` interface (place next to `webDir`):

```ts
  cliDistDir: string;
```

In `loadConfig()`, add to the returned object (next to `webDir`):

```ts
    cliDistDir: process.env.CLI_DIST_DIR ?? path.resolve('dist/cli'),
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add src/server/config.ts
git commit -m "feat(config): add CLI_DIST_DIR / cliDistDir"
```

---

## Task 5: CLI download endpoint — tests first

**Files:**
- Create: `src/server/api/cli.ts`
- Create: `src/server/api/cli.test.ts`

The endpoint streams a binary when present, returns 400 for unknown `os`/`arch`, returns 503 when the file is missing, always sets `Content-Disposition` and `Cache-Control`, and includes `X-FBI-CLI-Version` when the `version` dep is a non-empty string.

- [ ] **Step 1: Write the failing tests.**

Create `src/server/api/cli.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCliRoutes } from './cli.js';

function withTempDir(setup: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-cli-'));
  setup(dir);
  return dir;
}

async function makeApp(opts: { cliDistDir: string; version?: string }): Promise<FastifyInstance> {
  const app = Fastify();
  registerCliRoutes(app, { cliDistDir: opts.cliDistDir, version: opts.version });
  await app.ready();
  return app;
}

describe('GET /api/cli/fbi-tunnel/:os/:arch', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  it('streams the binary with the right headers', async () => {
    const dir = withTempDir((d) => {
      fs.writeFileSync(path.join(d, 'fbi-tunnel-darwin-arm64'), 'BINARY_CONTENTS');
    });
    app = await makeApp({ cliDistDir: dir, version: 'abc1234' });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/darwin/arm64' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="fbi-tunnel-darwin-arm64"');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['x-fbi-cli-version']).toBe('abc1234');
    expect(res.body).toBe('BINARY_CONTENTS');
  });

  it('omits X-FBI-CLI-Version when version is undefined', async () => {
    const dir = withTempDir((d) => {
      fs.writeFileSync(path.join(d, 'fbi-tunnel-linux-amd64'), 'X');
    });
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/linux/amd64' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-fbi-cli-version']).toBeUndefined();
  });

  it('returns 400 for an unsupported os', async () => {
    const dir = withTempDir(() => {});
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/windows/amd64' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unsupported os/arch' });
  });

  it('returns 400 for an unsupported arch', async () => {
    const dir = withTempDir(() => {});
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/linux/riscv' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for path-traversal attempts in os', async () => {
    const dir = withTempDir(() => {});
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/..%2Fetc/amd64' });
    // Fastify decodes %2F into a literal "/" before matching; the route then
    // does not match and returns 404. Either way, no bytes leave the server.
    expect([400, 404]).toContain(res.statusCode);
  });

  it('returns 503 when the binary file is missing', async () => {
    const dir = withTempDir(() => {}); // empty dir
    app = await makeApp({ cliDistDir: dir });
    const res = await app.inject({ method: 'GET', url: '/api/cli/fbi-tunnel/darwin/arm64' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'fbi-tunnel binary not built; rerun npm run build' });
  });
});
```

- [ ] **Step 2: Run the tests — they should fail (module not found).**

Run: `npx vitest run src/server/api/cli.test.ts`
Expected: FAIL, `Cannot find module './cli.js'`.

- [ ] **Step 3: Write the implementation.**

Create `src/server/api/cli.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const ALLOWED_OS = new Set(['darwin', 'linux']);
const ALLOWED_ARCH = new Set(['amd64', 'arm64']);

export interface CliDeps {
  cliDistDir: string;
  version?: string;
}

export function registerCliRoutes(app: FastifyInstance, deps: CliDeps): void {
  app.get('/api/cli/fbi-tunnel/:os/:arch', async (req, reply) => {
    const { os: osParam, arch: archParam } = req.params as { os: string; arch: string };
    if (!ALLOWED_OS.has(osParam) || !ALLOWED_ARCH.has(archParam)) {
      return reply.code(400).send({ error: 'unsupported os/arch' });
    }
    const filename = `fbi-tunnel-${osParam}-${archParam}`;
    const filePath = path.join(deps.cliDistDir, filename);
    try { fs.statSync(filePath); }
    catch {
      return reply.code(503).send({ error: 'fbi-tunnel binary not built; rerun npm run build' });
    }
    reply
      .type('application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'public, max-age=3600');
    if (deps.version) reply.header('X-FBI-CLI-Version', deps.version);
    return reply.send(fs.createReadStream(filePath));
  });
}
```

- [ ] **Step 4: Run the tests — they should pass.**

Run: `npx vitest run src/server/api/cli.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit.**

```bash
git add src/server/api/cli.ts src/server/api/cli.test.ts
git commit -m "feat(api): GET /api/cli/fbi-tunnel/:os/:arch binary download"
```

---

## Task 6: Wire the CLI route in the server entrypoint

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add the import.**

Near the other route imports in `src/server/index.ts`:

```ts
import { registerCliRoutes } from './api/cli.js';
```

- [ ] **Step 2: Register the route and log binary presence at startup.**

After the existing `registerProxyRoutes(...)` call, add:

```ts
  registerCliRoutes(app, {
    cliDistDir: config.cliDistDir,
    version: process.env.FBI_VERSION,
  });

  // Startup log: is the fbi-tunnel dist dir populated?
  try {
    const entries = fs.readdirSync(config.cliDistDir).filter((f) => f.startsWith('fbi-tunnel-'));
    if (entries.length >= 4) app.log.info({ dir: config.cliDistDir, count: entries.length }, 'fbi-tunnel binaries present');
    else app.log.warn({ dir: config.cliDistDir, count: entries.length }, 'fbi-tunnel binaries missing — /api/cli/fbi-tunnel/* will 503');
  } catch {
    app.log.warn({ dir: config.cliDistDir }, 'fbi-tunnel binaries missing — /api/cli/fbi-tunnel/* will 503');
  }
```

- [ ] **Step 3: Typecheck and run all tests.**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all existing tests still pass; new `cli.test.ts` passes.

- [ ] **Step 4: Commit.**

```bash
git add src/server/index.ts
git commit -m "feat(server): wire CLI download route + startup log"
```

---

## Task 7: Makefile — add `dist` target

**Files:**
- Modify: `cli/fbi-tunnel/Makefile`

The existing `build` target writes to `$(DIST)/fbi-tunnel-<os>-<arch>`. We need a second target that writes into a caller-supplied `$(OUT)` directory (defaults to `$(DIST)` for parity) and takes a `$(VERSION)` linker-ldflag so we can embed the build SHA.

- [ ] **Step 1: Replace the file with the new version.**

Open `cli/fbi-tunnel/Makefile` and replace its contents with:

```makefile
.PHONY: build test install clean dist

DIST := dist
OUT ?= $(DIST)
VERSION ?= dev
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

dist:
	@mkdir -p $(OUT)
	@for os in darwin linux; do \
	  for arch in amd64 arm64; do \
	    CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
	      go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" \
	      -o $(OUT)/fbi-tunnel-$$os-$$arch . ; \
	  done ; \
	done

test:
	go test ./...

install:
	go build -trimpath -ldflags='-s -w' -o $(HOME)/.local/bin/fbi-tunnel .

clean:
	rm -rf $(DIST)
```

- [ ] **Step 2: Local smoke (skip if Go toolchain isn't on host).**

Run: `command -v go && make -C cli/fbi-tunnel dist OUT=/tmp/fbi-tunnel-smoke VERSION=smoke-test && ls -la /tmp/fbi-tunnel-smoke`
Expected: four files named `fbi-tunnel-{darwin,linux}-{amd64,arm64}`.
If `go` is not installed, skip — the Docker path validates it next task.

- [ ] **Step 3: Commit.**

```bash
git add cli/fbi-tunnel/Makefile
git commit -m "build(cli): add dist target with OUT/VERSION knobs"
```

---

## Task 8: `scripts/build-dist.sh` — Docker-wrapped cross-compile

**Files:**
- Create: `cli/fbi-tunnel/scripts/build-dist.sh`

- [ ] **Step 1: Create the script.**

Create `cli/fbi-tunnel/scripts/build-dist.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Cross-compile fbi-tunnel for darwin/linux × amd64/arm64 inside a short-lived
# golang:1.22-alpine container, writing binaries to <repo>/dist/cli/.
# Prereqs: Docker daemon reachable. No Go toolchain needed on the host.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLI_DIR/../.." && pwd)"
OUT="$REPO_ROOT/dist/cli"

mkdir -p "$OUT"

VERSION="${VITE_VERSION:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)}"

docker run --rm \
  -v "$CLI_DIR":/src \
  -v "$OUT":/out \
  -e VERSION="$VERSION" \
  -w /src \
  golang:1.22-alpine \
  sh -c 'apk add --no-cache make >/dev/null && make dist OUT=/out VERSION=$VERSION'

chmod +x "$OUT"/fbi-tunnel-* 2>/dev/null || true

echo "fbi-tunnel binaries written to $OUT (version=$VERSION):"
ls -la "$OUT"
```

- [ ] **Step 2: Mark executable.**

Run: `chmod +x cli/fbi-tunnel/scripts/build-dist.sh`

- [ ] **Step 3: Smoke-test the script (requires Docker).**

Run: `VITE_VERSION=plan-smoke bash cli/fbi-tunnel/scripts/build-dist.sh && ls -la dist/cli`
Expected: four `fbi-tunnel-*` files exist in `dist/cli`, each ≥ a few MB, with the exec bit set.
If Docker is unavailable, note the skip; CI/install.sh runs this next.

- [ ] **Step 4: Commit.**

```bash
git add cli/fbi-tunnel/scripts/build-dist.sh
git commit -m "build(cli): Docker-wrapped cross-compile to dist/cli"
```

---

## Task 9: `package.json` — wire `cli:dist` into `build`

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Update `package.json` scripts.**

In `package.json`, change the two relevant lines:

```diff
-    "build": "npm run build:server && npm run build:web",
+    "build": "npm run build:server && npm run build:web && npm run cli:dist",
```

And add this next to the other `cli:*` scripts:

```json
    "cli:dist": "bash cli/fbi-tunnel/scripts/build-dist.sh",
```

Final `scripts` section should look like:

```json
  "scripts": {
    "build": "npm run build:server && npm run build:web && npm run cli:dist",
    "build:server": "tsc -p tsconfig.server.json && cp src/server/db/schema.sql dist/server/db/schema.sql && cp src/server/orchestrator/supervisor.sh dist/server/orchestrator/supervisor.sh && cp src/server/orchestrator/finalizeBranch.sh dist/server/orchestrator/finalizeBranch.sh && cp src/server/orchestrator/Dockerfile.tmpl dist/server/orchestrator/Dockerfile.tmpl && cp src/server/orchestrator/postbuild.sh dist/server/orchestrator/postbuild.sh",
    "build:web": "VITE_VERSION=${VITE_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)} vite build",
    "dev": "concurrently -k \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "tsx watch --tsconfig tsconfig.server.json src/server/index.ts",
    "dev:web": "vite",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.web.json --noEmit && tsc -p tsconfig.test.json --noEmit",
    "cli:build": "make -C cli/fbi-tunnel build",
    "cli:dist": "bash cli/fbi-tunnel/scripts/build-dist.sh",
    "cli:install": "make -C cli/fbi-tunnel install",
    "cli:test": "make -C cli/fbi-tunnel test",
    "lint": "eslint src"
  },
```

- [ ] **Step 2: Update `.gitignore`.**

Open `.gitignore` and add one line:

```
dist/cli/
```

- [ ] **Step 3: Verify `git status` does not show `dist/cli/`.**

Run: `git status --short | grep -F 'dist/cli' || echo 'clean'`
Expected: `clean`.

- [ ] **Step 4: Commit.**

```bash
git add package.json .gitignore
git commit -m "build: cli:dist runs on npm run build; ignore dist/cli"
```

---

## Task 10: `TunnelTab` component — tests first

**Files:**
- Create: `src/web/features/runs/TunnelTab.tsx`
- Create: `src/web/features/runs/TunnelTab.test.tsx`

Props:

```ts
interface TunnelTabProps {
  runId: number;
  runState: RunState;
  origin: string;
  ports: readonly ListeningPort[];
  detected?: Platform; // for tests; default = detectPlatform(navigator.userAgentData ?? navigator.userAgent)
}
```

No fetching inside this component — `RunDetailPage` owns the polling loop. The tab is a pure display.

- [ ] **Step 1: Write the failing tests.**

Create `src/web/features/runs/TunnelTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TunnelTab } from './TunnelTab.js';

describe('TunnelTab', () => {
  const origin = 'https://fbi.tailnet:3000';

  it('renders command, download URL, and port rows when running', () => {
    render(
      <TunnelTab
        runId={42}
        runState="running"
        origin={origin}
        ports={[{ port: 5173, proto: 'tcp' }, { port: 9229, proto: 'tcp' }]}
        detected={{ os: 'darwin', arch: 'arm64' }}
      />,
    );
    expect(screen.getByText('fbi-tunnel https://fbi.tailnet:3000 42')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download fbi-tunnel for macos \(arm64\)/i }))
      .toHaveAttribute('href', '/api/cli/fbi-tunnel/darwin/arm64');
    expect(screen.getByText('5173')).toBeInTheDocument();
    expect(screen.getByText('9229')).toBeInTheDocument();
  });

  it('shows the empty-ports hint when running but ports=[]', () => {
    render(
      <TunnelTab runId={42} runState="running" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByText(/no listening ports yet/i)).toBeInTheDocument();
  });

  it('shows state-specific hint when run is queued', () => {
    render(
      <TunnelTab runId={42} runState="queued" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByText(/run is queued/i)).toBeInTheDocument();
  });

  it('shows state-specific hint when run is awaiting_resume', () => {
    render(
      <TunnelTab runId={42} runState="awaiting_resume" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByText(/paused awaiting token resume/i)).toBeInTheDocument();
  });

  it('shows "run ended" hint for terminal states', () => {
    for (const s of ['succeeded', 'failed', 'cancelled'] as const) {
      const { unmount } = render(
        <TunnelTab runId={42} runState={s} origin={origin} ports={[]}
          detected={{ os: 'darwin', arch: 'arm64' }} />,
      );
      expect(screen.getByText(/run ended/i)).toBeInTheDocument();
      unmount();
    }
  });

  it('disables the copy button when runState is not running', () => {
    render(
      <TunnelTab runId={42} runState="succeeded" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByRole('button', { name: /copy command/i })).toBeDisabled();
  });

  it('copies the command to clipboard when the copy button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <TunnelTab runId={42} runState="running" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy command/i }));
    expect(writeText).toHaveBeenCalledWith('fbi-tunnel https://fbi.tailnet:3000 42');
  });

  it('renders an "other platforms" toggle listing the three non-detected binaries', () => {
    render(
      <TunnelTab runId={42} runState="running" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /other platforms/i }));
    expect(screen.getByRole('link', { name: /darwin\/amd64/i })).toHaveAttribute('href', '/api/cli/fbi-tunnel/darwin/amd64');
    expect(screen.getByRole('link', { name: /linux\/amd64/i })).toHaveAttribute('href', '/api/cli/fbi-tunnel/linux/amd64');
    expect(screen.getByRole('link', { name: /linux\/arm64/i })).toHaveAttribute('href', '/api/cli/fbi-tunnel/linux/arm64');
    // The detected one should not also appear in the "other" list.
    expect(screen.queryByRole('link', { name: /darwin\/arm64/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests — they should fail.**

Run: `npx vitest run src/web/features/runs/TunnelTab.test.tsx`
Expected: FAIL, `Cannot find module './TunnelTab.js'`.

- [ ] **Step 3: Write the component.**

Create `src/web/features/runs/TunnelTab.tsx`:

```tsx
import { useState } from 'react';
import type { RunState, ListeningPort } from '@shared/types.js';
import { Button } from '@ui/primitives/Button.js';
import { detectPlatform, type Platform } from './detectPlatform.js';

const OS_LABEL: Record<Platform['os'], string> = { darwin: 'macOS', linux: 'Linux' };
const ALL: Platform[] = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
];

function platformKey(p: Platform): string { return `${p.os}/${p.arch}`; }

function hintFor(state: RunState, hasPorts: boolean): string | null {
  if (state === 'queued') return 'run is queued';
  if (state === 'awaiting_resume') return 'run is paused awaiting token resume';
  if (state === 'succeeded' || state === 'failed' || state === 'cancelled') return 'run ended';
  if (state === 'running' && !hasPorts) return "No listening ports yet — the agent hasn't started a server.";
  return null;
}

function detectFromNavigator(): Platform {
  if (typeof navigator === 'undefined') return { os: 'darwin', arch: 'arm64' };
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  if (uaData?.platform) {
    // Client Hints "architecture" needs getHighEntropyValues(), which is async.
    // For v1.1 we only use the sync `platform` and fall back to userAgent for arch.
    return detectPlatform(navigator.userAgent);
  }
  return detectPlatform(navigator.userAgent);
}

export interface TunnelTabProps {
  runId: number;
  runState: RunState;
  origin: string;
  ports: readonly ListeningPort[];
  detected?: Platform;
}

export function TunnelTab({ runId, runState, origin, ports, detected }: TunnelTabProps) {
  const plat = detected ?? detectFromNavigator();
  const [showOther, setShowOther] = useState(false);
  const command = `fbi-tunnel ${origin} ${runId}`;
  const isRunning = runState === 'running';
  const hint = hintFor(runState, ports.length > 0);

  async function copy() {
    try { await navigator.clipboard.writeText(command); }
    catch { /* no-op; user can select+copy */ }
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-[13px] px-2 py-1 rounded-sm bg-surface-raised border border-border">
          {command}
        </code>
        <Button variant="secondary" size="sm" onClick={copy} disabled={!isRunning} aria-label="Copy command">
          Copy
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <a
          className={`inline-flex items-center gap-1.5 font-medium rounded-md border px-3 py-1.5 text-xs ${
            isRunning ? 'bg-accent text-surface border-accent hover:bg-accent-strong'
                       : 'bg-surface-raised text-text-faint border-border cursor-not-allowed pointer-events-none'
          }`}
          href={`/api/cli/fbi-tunnel/${plat.os}/${plat.arch}`}
          download
          aria-label={`Download fbi-tunnel for ${OS_LABEL[plat.os]} (${plat.arch})`}
        >
          Download fbi-tunnel for {OS_LABEL[plat.os]} ({plat.arch})
        </a>
        <button
          type="button"
          className="text-[13px] text-text-faint hover:text-text underline"
          onClick={() => setShowOther((v) => !v)}
          aria-expanded={showOther}
        >
          other platforms {showOther ? '▴' : '▾'}
        </button>
      </div>

      {showOther && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {ALL.filter((p) => platformKey(p) !== platformKey(plat)).map((p) => (
            <li key={platformKey(p)}>
              <a className="text-accent hover:text-accent-strong underline"
                 href={`/api/cli/fbi-tunnel/${p.os}/${p.arch}`}
                 download
                 aria-label={`${p.os}/${p.arch}`}>
                {p.os}/{p.arch}
              </a>
            </li>
          ))}
        </ul>
      )}

      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint pb-1 border-b border-border mb-1">
          Listening ports
        </h3>
        {hint ? (
          <p className="text-[13px] text-text-faint p-2">{hint}</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-text-faint text-[12px] uppercase tracking-[0.08em]">
              <tr className="border-b border-border">
                <th className="text-left px-2 py-1 font-semibold">remote port</th>
                <th className="text-left px-2 py-1 font-semibold">note</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((p) => (
                <tr key={p.port} className="border-b border-border last:border-0">
                  <td className="px-2 py-1 font-mono">{p.port}</td>
                  <td className="px-2 py-1 font-mono text-text-faint" />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests — they should pass.**

Run: `npx vitest run src/web/features/runs/TunnelTab.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit.**

```bash
git add src/web/features/runs/TunnelTab.tsx src/web/features/runs/TunnelTab.test.tsx
git commit -m "feat(ui): TunnelTab component"
```

---

## Task 11: `RunDrawer` — add `tunnel` tab with count

**Files:**
- Modify: `src/web/features/runs/RunDrawer.tsx`

- [ ] **Step 1: Update the tab union, props, and tabs array.**

Replace the contents of `src/web/features/runs/RunDrawer.tsx` with:

```tsx
import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';

export type RunTab = 'files' | 'prompt' | 'github' | 'tunnel';

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  filesCount: number;
  portsCount: number | null;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({ open, onToggle, filesCount, portsCount, children }: RunDrawerProps) {
  const [tab, setTab] = useState<RunTab>('files');
  const pickTab = (next: RunTab) => {
    setTab(next);
    if (!open) onToggle(true);
  };
  return (
    <Drawer
      open={open}
      onToggle={onToggle}
      header={
        <Tabs
          value={tab}
          onChange={pickTab}
          tabs={[
            { value: 'files', label: 'files', count: filesCount },
            { value: 'prompt', label: 'prompt' },
            { value: 'github', label: 'github' },
            { value: 'tunnel', label: 'tunnel', count: portsCount ?? undefined },
          ]}
        />
      }
    >
      <div className="max-h-[35vh] overflow-auto">{children(tab)}</div>
    </Drawer>
  );
}
```

`portsCount: null` (callers pass it when the run isn't running) suppresses the count pill; a numeric value (including 0) shows it.

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: one error in `src/web/pages/RunDetail.tsx` — `portsCount` prop not supplied. That's the next task.

- [ ] **Step 3: Commit (allowing the typecheck failure — it resolves in Task 12).**

```bash
git add src/web/features/runs/RunDrawer.tsx
git commit -m "feat(ui): RunDrawer gains tunnel tab with count"
```

---

## Task 12: `RunDetailPage` — lift ports state and wire TunnelTab

**Files:**
- Modify: `src/web/pages/RunDetail.tsx`

The page already holds `diff` state and polls on a timer for other things. Add `ports` state plus a polling effect that runs only when `run.state === 'running'` and `document.visibilityState === 'visible'`; clear ports when leaving `running`.

- [ ] **Step 1: Add imports.**

In `src/web/pages/RunDetail.tsx`, add to the existing imports:

```ts
import { TunnelTab } from '../features/runs/TunnelTab.js';
import type { ListeningPort } from '@shared/types.js';
```

- [ ] **Step 2: Add ports state and the polling effect.**

Inside `RunDetailPage`, next to the other `useState` calls:

```ts
  const [ports, setPorts] = useState<ListeningPort[]>([]);
```

Add this `useEffect` below the existing ones (e.g. just above `if (error) return <ErrorState …`):

```ts
  useEffect(() => {
    if (!run) return;
    if (run.state !== 'running') {
      setPorts([]);
      return;
    }
    let alive = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const { ports: p } = await api.getRunListeningPorts(run.id);
        if (alive) setPorts(p);
      } catch { /* transient errors retained the last-known list */ }
    };

    const start = () => {
      if (interval != null) return;
      void tick();
      interval = setInterval(tick, 2000);
    };
    const stop = () => {
      if (interval != null) { clearInterval(interval); interval = null; }
    };

    const onVis = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    document.addEventListener('visibilitychange', onVis);
    if (document.visibilityState === 'visible') start();

    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.state]);
```

- [ ] **Step 3: Pass `portsCount` to the drawer and render `TunnelTab`.**

Find this block (around line 153–161):

```tsx
          <RunDrawer
            open={drawerOpen}
            onToggle={setDrawerOpen}
            filesCount={diff?.files.length ?? 0}
          >
            {(t) => t === 'files' ? <FilesTab diff={diff} project={project} runState={run.state} />
                 : t === 'prompt' ? <PromptTab prompt={run.prompt} />
                 : <GithubTab github={gh} runState={run.state} />}
          </RunDrawer>
```

Replace with:

```tsx
          <RunDrawer
            open={drawerOpen}
            onToggle={setDrawerOpen}
            filesCount={diff?.files.length ?? 0}
            portsCount={run.state === 'running' ? ports.length : null}
          >
            {(t) => t === 'files' ? <FilesTab diff={diff} project={project} runState={run.state} />
                 : t === 'prompt' ? <PromptTab prompt={run.prompt} />
                 : t === 'github' ? <GithubTab github={gh} runState={run.state} />
                 : <TunnelTab runId={run.id} runState={run.state} origin={window.location.origin} ports={ports} />}
          </RunDrawer>
```

- [ ] **Step 4: Typecheck and run all tests.**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all tests pass (existing suites unaffected, new `TunnelTab` and `cli` tests pass).

- [ ] **Step 5: Commit.**

```bash
git add src/web/pages/RunDetail.tsx
git commit -m "feat(ui): wire TunnelTab; poll listening-ports while running"
```

---

## Task 13: README — one-sentence note

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Open `README.md` and find the `## Install` section.**

Immediately after the `npm run build` bullet (or equivalent prose), add a sentence. Find the section that reads:

```
sudo bash scripts/install.sh
```

…and append this paragraph *after* the existing code block, before the next `##` heading:

```markdown
`npm run build` (invoked by `install.sh`) also cross-compiles the
`fbi-tunnel` helper for darwin/linux × amd64/arm64 via a one-shot
`golang:1.22-alpine` container. No Go toolchain required on the host;
Docker must be running.
```

- [ ] **Step 2: Commit.**

```bash
git add README.md
git commit -m "docs: note fbi-tunnel cross-compile during npm run build"
```

---

## Task 14: Visual smoke — run the dev server and eyeball the tab

**Files:** none

- [ ] **Step 1: Ensure binaries exist locally.**

Run: `npm run cli:dist`
Expected: four files in `dist/cli/`. If Docker is unavailable, fake it for the smoke with `mkdir -p dist/cli && for f in darwin-arm64 darwin-amd64 linux-amd64 linux-arm64; do echo fake > dist/cli/fbi-tunnel-$f; done && chmod +x dist/cli/fbi-tunnel-*`. (Real binaries will be produced when install.sh runs.)

- [ ] **Step 2: Start the dev server.**

Run: `bash scripts/dev.sh` (in the background or a separate shell).

- [ ] **Step 3: Open the app in a browser and drive it with Playwright MCP.**

Using the Playwright MCP tools, navigate to `http://localhost:3000`, open a live running run, click the `tunnel` tab, and confirm:
- The command `fbi-tunnel http://localhost:3000 <id>` is shown.
- The download button renders with a sensible platform label and its `href` matches `/api/cli/fbi-tunnel/<os>/<arch>`.
- Clicking "other platforms" expands three non-matching links.
- The listening-ports table updates within ~2 seconds after a port change inside the container.
- For a non-running run, the command box and download button appear disabled; the hint reads "run ended" / "run is queued" as appropriate.

Record what you saw directly — this replaces a Playwright end-to-end test for v1.1.

- [ ] **Step 4: Stop the dev server.**

Run: `pkill -f 'npm run dev'` or the equivalent for your shell.

- [ ] **Step 5: No commit** — this task has no code changes.

---

## Task 15: Final verification

**Files:** none

- [ ] **Step 1: Run the full test suite.**

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 2: Run the linter.**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 3: Run the typechecker.**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Produce a full build (proves the Docker-wrapped CLI build path works).**

Run: `npm run build`
Expected: exits 0; `dist/web/`, `dist/server/`, and `dist/cli/` all populated; `dist/cli/` has four `fbi-tunnel-*` executables.

- [ ] **Step 5: Smoke-test the download endpoint.**

With a dev server running (`bash scripts/dev.sh`):

Run: `curl -I http://localhost:3000/api/cli/fbi-tunnel/darwin/arm64`
Expected: `HTTP/1.1 200 OK`, `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="fbi-tunnel-darwin-arm64"`.

Run: `curl -sS http://localhost:3000/api/cli/fbi-tunnel/windows/amd64`
Expected: `{"error":"unsupported os/arch"}`.

- [ ] **Step 6: No commit** — verification only.
