# Monorepo Restructure + Makefile Design

**Date:** 2026-04-29
**Status:** Approved

## Goal

Consolidate the repo layout so all source lives under `src/`, test infrastructure lives under `tests/`, and a root Makefile is the single entry point for build and test. Eliminate the `cli/` grouping, remove the now-redundant `build-fbi-tunnel.sh` and `build-cli-dist.sh` scripts, strip dead Zig CI, and update all path references consistently.

---

## Directory layout

Before → After:

```
cli/fbi-tunnel/    →  src/fbi-tunnel/
cli/fbi-term-core/ →  src/fbi-term-core/
cli/quantico/      →  tests/quantico/
desktop/           →  src/desktop/
```

`cli/` and top-level `desktop/` are removed entirely.

Unchanged:
```
src/server/        Gleam backend
src/web/           React/TS frontend
tests/e2e/         Playwright specs
scripts/           Ops scripts (see below)
```

---

## Root Makefile

Single entry point for build and test. `make help` is the default target.

```
make help            List all targets (default)
make build           Web bundle + Gleam release + build-dist
make build-sidecar   Build fbi-tunnel into src/desktop/binaries/ for Tauri sidecar
make build-dist      Cross-compile fbi-tunnel + quantico into dist/cli/
make test            Run all unit tests: web + server + rust
make test-web        vitest + typecheck
make test-server     gleam test
make test-rust       cargo test (all workspace members)
make test-e2e        Playwright (requires a running server)
```

`make test` runs `test-web`, `test-server`, `test-rust` in sequence.
`make test-e2e` is explicit-only — it requires a running server.

`make build-sidecar` and `make build-dist` inline the logic from the deleted shell scripts.

---

## Scripts (ops only)

The `scripts/` directory shrinks from 5 files to 3. Build logic moves into the Makefile; only genuinely complex ops flows stay as scripts:

| File | Purpose |
|------|---------|
| `scripts/dev.sh` | Start Gleam + Vite dev servers (background PID, trap cleanup, env defaults) |
| `scripts/install.sh` | Full server provisioning (systemd, rsync, /opt/fbi, /etc/default/fbi) |
| `scripts/update.sh` | Redeploy to live server (git pull, build, rsync, restart service) |

Deleted:
- `scripts/build-fbi-tunnel.sh` → absorbed into `make build-sidecar`
- `scripts/build-cli-dist.sh` → absorbed into `make build-dist`

`make dev` and `make install`/`make update` are intentionally absent from the Makefile:
- `make dev` is not idiomatic (long-running process, no artifact)
- `make install`/`make update` are not idiomatic at this scope (full server provisioning/redeployment, not local artifact installation)

---

## File-by-file changes

### `Cargo.toml` (root workspace)
```toml
members = ["src/desktop", "src/fbi-tunnel", "src/fbi-term-core", "tests/quantico"]
```

### `src/server/Makefile`
```
RUST_PROJECT := ../fbi-term-core   # was ../../cli/fbi-term-core
```

### `package.json`
- Remove `cli:build`, `cli:dist`, `cli:install`, `cli:test`, `cli:quantico:build`, `cli:quantico:test` — replaced by `make` targets
- `"tauri:dev"`: `cd desktop` → `cd src/desktop`
- `"tauri:build"`: `cd desktop` → `cd src/desktop`
- `"build"`: remove `npm run cli:dist` (now `make build-dist`)

### `.gitignore`
- `desktop/binaries/fbi-tunnel-*` → `src/desktop/binaries/fbi-tunnel-*`
- `desktop/gen/` → `src/desktop/gen/`

### `README.md`
- Architecture section: update paths
- Local dev section: document `make test` and `make test-e2e`
- Add "Deploying" section covering `scripts/install.sh` and `scripts/update.sh`

---

## CI / workflow changes

### `ci.yml`
- **Remove** entire `zig` job (Zig removed from project)
- **Remove** stale `Install Zig` step from `e2e-quantico` job (nothing in that job uses Zig)
- No path changes needed — `cargo test -p fbi-tunnel` etc. use package names, not paths

### `desktop.yml`
- `working-directory: desktop` → `working-directory: src/desktop`
- `bash scripts/build-fbi-tunnel.sh` → `make build-sidecar`
- `bash scripts/build-cli-dist.sh` → `make build-dist`

### `quantico-fidelity.yml`
- `cli/quantico/fidelity-snapshot.json` → `tests/quantico/fidelity-snapshot.json` (two occurrences)

---

### `desktop/tauri.conf.json` (moves to `src/desktop/tauri.conf.json`)
Relative paths shift one level deeper:
- `"frontendDist": "../dist/web"` → `"../../dist/web"`
- `"beforeDevCommand": "cd .. && npm run dev:web"` → `"cd ../.. && npm run dev:web"`
- `"beforeBuildCommand": "npm run build:web"` → `"cd ../.. && npm run build:web"`
- `"externalBin": ["binaries/fbi-tunnel"]` — relative to `tauri.conf.json`, no change needed

### `RELEASING.md`
- `desktop/tauri.conf.json` → `src/desktop/tauri.conf.json` (two references)

---

## What is not changing

- `src/server/`, `src/web/`, `tests/e2e/` — untouched
- `scripts/dev.sh`, `scripts/install.sh`, `scripts/update.sh` — kept, paths inside updated as needed
- Playwright config, vitest config, vite config — no changes
- `devcontainer.json` `postCreateCommand` — already references `src/server`, unchanged
