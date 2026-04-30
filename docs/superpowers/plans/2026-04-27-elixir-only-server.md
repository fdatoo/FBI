# Elixir-Only Server Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the TypeScript server entirely, relocate shared types into the web tree, move the Elixir server into `src/server`, and scrub every trace of dual-server history from code, config, docs, and scripts.

**Architecture:** The Elixir/Phoenix server is the sole backend. `src/shared` types used only by the web move to `src/web/shared`; types only used by the old TS server are deleted. `server-elixir/` becomes `src/server/` via a single `git mv`. All build scripts, CI, systemd units, and documentation are rewritten as if only one server ever existed.

**Tech Stack:** Elixir/Phoenix (backend), React/TypeScript/Vite (frontend), vitest (web tests), mix test (server tests), Playwright (e2e).

---

### Task 1: Move src/shared into src/web/shared

**Files:**
- Move: `src/shared/types.ts` → `src/web/shared/types.ts`
- Move: `src/shared/types.test.ts` → `src/web/shared/types.test.ts`
- Move: `src/shared/parseGitHubRepo.ts` → `src/web/shared/parseGitHubRepo.ts`
- Move: `src/shared/parseGitHubRepo.test.ts` → `src/web/shared/parseGitHubRepo.test.ts`
- Delete: `src/shared/composePrompt.ts`, `src/shared/composePrompt.test.ts`
- Delete: `src/shared/usage.ts`, `src/shared/usage.test.ts`
- Delete: `src/shared/__fixtures__/` (entire directory — only used by TS server tests)
- Modify: `tsconfig.web.json`
- Modify: `tsconfig.test.json`
- Modify: `vite.config.ts`

- [ ] **Step 1: Create the destination directory and move web-relevant files**

```bash
mkdir -p src/web/shared
git mv src/shared/types.ts src/web/shared/types.ts
git mv src/shared/types.test.ts src/web/shared/types.test.ts
git mv src/shared/parseGitHubRepo.ts src/web/shared/parseGitHubRepo.ts
git mv src/shared/parseGitHubRepo.test.ts src/web/shared/parseGitHubRepo.test.ts
```

- [ ] **Step 2: Delete server-only shared files**

```bash
git rm -r src/shared/
```

- [ ] **Step 3: Update tsconfig.web.json**

Change:
```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@ui/*": ["src/web/ui/*"]
    }
  },
  "include": ["src/web/**/*.ts", "src/web/**/*.tsx", "src/shared/**/*.ts"]
}
```

To:
```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["src/web/shared/*"],
      "@ui/*": ["src/web/ui/*"]
    }
  },
  "include": ["src/web/**/*.ts", "src/web/**/*.tsx"]
}
```

- [ ] **Step 4: Update tsconfig.test.json**

Change the `paths` entry from:
```json
"@shared/*": ["src/shared/*"]
```
To:
```json
"@shared/*": ["src/web/shared/*"]
```

- [ ] **Step 5: Update vite.config.ts**

Change:
```js
'@shared': path.resolve(__dirname, 'src/shared'),
```
To:
```js
'@shared': path.resolve(__dirname, 'src/web/shared'),
```

- [ ] **Step 6: Verify typecheck passes**

```bash
npm run typecheck
```
Expected: no errors. The `@shared` alias now resolves to `src/web/shared/`.

- [ ] **Step 7: Commit**

```bash
git add tsconfig.web.json tsconfig.test.json vite.config.ts
git commit -m "refactor: move src/shared into src/web/shared; delete server-only shared files"
```

---

### Task 2: Delete the TypeScript server

**Files:**
- Delete: `src/server/` (entire directory, ~237 files)
- Delete: `tsconfig.server.json`
- Modify: `package.json`

- [ ] **Step 1: Delete src/server and tsconfig.server.json**

```bash
git rm -r src/server/
git rm tsconfig.server.json
```

- [ ] **Step 2: Update package.json scripts**

Remove `build:server`, `dev:server` scripts. Simplify `build`, `dev`, and `typecheck`:

```json
"build": "npm run build:web && npm run cli:dist",
"build:web": "VITE_VERSION=${VITE_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)} vite build",
"dev": "npm run dev:web",
"dev:web": "VITE_VERSION=${VITE_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)} vite",
"typecheck": "tsc -p tsconfig.web.json --noEmit && tsc -p tsconfig.test.json --noEmit",
```

Also remove the `concurrently` dependency from `package.json` `devDependencies` since it's no longer needed.

- [ ] **Step 3: Verify typecheck still passes**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "refactor: delete TypeScript server and tsconfig.server.json"
```

---

### Task 3: Move server-elixir → src/server

**Files:**
- Move: `server-elixir/` → `src/server/`

- [ ] **Step 1: git mv the entire directory**

```bash
git mv server-elixir src/server
```

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor: rename server-elixir/ to src/server/"
```

---

### Task 4: Update CI for new paths

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Remove the `ts` job entirely**

Delete lines from `jobs:` to before the `rust:` job — specifically the entire `ts:` block:

```yaml
  ts:
    name: TypeScript (vitest + tsc + eslint)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - name: Install dependencies
        run: npm ci
      - name: Typecheck
        run: npm run typecheck
      - name: Lint
        run: npm run lint
      - name: Test
        run: npm test -- --exclude '**/*.integration.test.ts' --exclude 'src/server/orchestrator/image.test.ts'
```

- [ ] **Step 2: Update the `elixir` job's working-directory and cache paths**

Change:
```yaml
  elixir:
    name: Elixir (mix test + format check + warnings-as-errors)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: server-elixir
    ...
      - name: Cache mix deps + build
        uses: actions/cache@v4
        with:
          path: |
            server-elixir/deps
            server-elixir/_build
          key: mix-${{ runner.os }}-otp27.2-elixir1.18.1-${{ hashFiles('server-elixir/mix.lock') }}
          restore-keys: |
            mix-${{ runner.os }}-otp27.2-elixir1.18.1-
```

To:
```yaml
  elixir:
    name: Elixir (mix test + format check + warnings-as-errors)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: src/server
    ...
      - name: Cache mix deps + build
        uses: actions/cache@v4
        with:
          path: |
            src/server/deps
            src/server/_build
          key: mix-${{ runner.os }}-otp27.2-elixir1.18.1-${{ hashFiles('src/server/mix.lock') }}
          restore-keys: |
            mix-${{ runner.os }}-otp27.2-elixir1.18.1-
```

- [ ] **Step 3: Update the `e2e-quantico` job's paths**

Change the mix cache path block:
```yaml
          path: |
            server-elixir/deps
            server-elixir/_build
          key: mix-${{ runner.os }}-otp27.2-elixir1.18.1-${{ hashFiles('server-elixir/mix.lock') }}
```
To:
```yaml
          path: |
            src/server/deps
            src/server/_build
          key: mix-${{ runner.os }}-otp27.2-elixir1.18.1-${{ hashFiles('src/server/mix.lock') }}
```

Change both `working-directory: server-elixir` occurrences in the e2e job (the "Compile Elixir + Zig NIF" and "Migrate DB" steps) to `working-directory: src/server`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: remove ts job; update elixir and e2e paths to src/server"
```

---

### Task 5: Update deploy scripts

**Files:**
- Modify: `scripts/install.sh`
- Modify: `scripts/update.sh`
- Modify: `scripts/dev.sh`

- [ ] **Step 1: Rewrite scripts/dev.sh**

Remove the `npm run dev` call (which ran both servers via concurrently). The new dev workflow runs the Elixir server directly. Replace the final section:

```bash
echo "▸ npm run dev  (server :3000, vite :5173)"
exec npm run dev
```

With:

```bash
echo "▸ starting vite dev server (web :5173)"
npm run dev:web &
VITE_PID=$!

echo "▸ starting elixir server (phx :3000)"
cd "$REPO_ROOT/src/server"
exec mix phx.server
```

- [ ] **Step 2: Rewrite scripts/install.sh**

Remove the entire Node server setup:
- Remove `npm --prefix "$APP_DIR" ci` and `npm --prefix "$APP_DIR" run build` blocks
- Remove `systemctl stop fbi.service` / `systemctl enable fbi.service` for the Node service
- Remove the `/etc/default/fbi` env file block (the old Node one with `PORT=3000`, `WEB_DIR=...`)
- Remove the "Crossover" section that moved Node to loopback

Update Elixir section:
- Change `ELIXIR_DIR=/opt/fbi-elixir` → `ELIXIR_DIR=/opt/fbi`
- Change `"$SOURCE_DIR/server-elixir"` → `"$SOURCE_DIR/src/server"`
- Change `fbi-elixir.service` → `fbi.service`
- Rename `/etc/default/fbi-elixir` → `/etc/default/fbi`
- Update the `install` line for the systemd service:
  ```bash
  install -m 644 "$SOURCE_DIR/systemd/fbi.service" /etc/systemd/system/fbi.service
  ```
- Update final echo to remove Node server line:
  ```bash
  echo "FBI installed and running."
  echo "  Edit /etc/default/fbi with real GIT_AUTHOR_NAME/EMAIL and SECRET_KEY_BASE"
  echo "Run 'systemctl status fbi' to verify the service is active."
  ```

- [ ] **Step 3: Rewrite scripts/update.sh**

Remove all Node server (TS) sections:
- Remove `SERVICE_TS="${SERVICE_TS:-fbi}"` variable
- Remove `VITE_VERSION` / `npm ci` / `npm run build` block
- Remove darwin binary overlay block
- Remove `sudo systemctl stop "$SERVICE_TS"` and `sudo systemctl start "$SERVICE_TS"` calls
- Remove `cargo` from the required-commands check (no longer needed here; Zig NIF build is handled by mix)

Update Elixir section:
- Change `RELEASE_DIR="${RELEASE_DIR:-/opt/fbi-elixir}"` → `RELEASE_DIR="${RELEASE_DIR:-/opt/fbi}"`
- Change `SERVICE_ELIXIR="${SERVICE_ELIXIR:-fbi-elixir}"` → `SERVICE="${SERVICE:-fbi}"`
- Change `cd '$SOURCE_DIR/server-elixir'` → `cd '$SOURCE_DIR/src/server'`
- Update final echo:
  ```bash
  echo "FBI updated to $REV. fbi running."
  ```

- [ ] **Step 4: Commit**

```bash
git add scripts/dev.sh scripts/install.sh scripts/update.sh
git commit -m "refactor: update deploy scripts for single Elixir server"
```

---

### Task 6: Systemd unit cleanup

**Files:**
- Delete: `systemd/fbi.service` (old Node.js unit)
- Modify: `systemd/fbi-elixir.service` → rename to `systemd/fbi.service`

- [ ] **Step 1: Delete the Node.js service unit**

```bash
git rm systemd/fbi.service
```

- [ ] **Step 2: Rename the Elixir service unit**

```bash
git mv systemd/fbi-elixir.service systemd/fbi.service
```

- [ ] **Step 3: Update the Description line inside the unit**

Open `systemd/fbi.service` and change:
```
Description=FBI Elixir/Phoenix Server
```
To:
```
Description=FBI Server
```

Remove any `After=fbi.service` or `Requires=fbi.service` lines if present (leftovers from two-service setup).

- [ ] **Step 4: Commit**

```bash
git add systemd/
git commit -m "refactor: replace two systemd units with single fbi.service"
```

---

### Task 7: Scrub all TS-port language

**Files:**
- Delete: `docs/ts-vs-elixir-orchestrator-audit.md`
- Modify: `docs/elixir-hardening.md` — remove "port" / "elixir port" language
- Modify: `docs/feature-gaps.md` — remove any TS/Elixir gap framing (if present)
- Modify: `playwright.config.ts` — remove "deprecated TS one" comment
- Modify: `README.md` — rewrite install/architecture section
- Delete: `src/server/test/fbi/fidelity/` (TS↔Elixir parity tests, now obsolete)
- Modify: Elixir test files — remove `@moduledoc "Mirrors src/server/api/..."` lines
- Modify: Elixir migration files — remove "TS is authoritative schema owner" comments
- Modify: `src/server/AGENTS.md` (was server-elixir/AGENTS.md) — remove "port" framing

- [ ] **Step 1: Delete obsolete docs**

```bash
git rm docs/ts-vs-elixir-orchestrator-audit.md
```

- [ ] **Step 2: Clean docs/elixir-hardening.md**

Open the file and remove or reword any sentences containing "Elixir port", "TS does", "elixir doesn't yet", or similar comparative language. The document should read as hardening guidance for *the* server, with no reference to a TypeScript predecessor.

- [ ] **Step 3: Clean playwright.config.ts**

Find and remove the comment:
```ts
// Drive the Elixir/Phoenix server (not the deprecated TS one)
```
Leave the actual configuration line unchanged.

- [ ] **Step 4: Update README.md install section**

Replace the dual-server install description:

```
The install script builds and starts both servers side-by-side:

- **Elixir/Phoenix server** (`fbi-elixir.service`) — listens publicly on `:3000`, proxies unrecognised routes to the Node server.
- **Node server** (`fbi.service`) — moves to `127.0.0.1:3001` (loopback only).
```

With:

```
The install script builds the Elixir release and starts `fbi.service` on `:3000`.
```

Update the install commands block to remove the two-service `systemctl restart` and update to:
```bash
sudo systemctl restart fbi
```

Remove the Node server prerequisites (Node 20+, npm) from the prerequisites list. Keep Erlang/OTP and Elixir prerequisites.

- [ ] **Step 5: Delete fidelity tests**

These tests compared TS and Elixir JSON outputs and are now meaningless:

```bash
git rm -r src/server/test/fbi/fidelity/
```

- [ ] **Step 6: Remove @moduledoc "Mirrors..." from Elixir test files**

The following files have `@moduledoc` referencing old TS test files. Remove those `@moduledoc` lines (or the whole moduledoc block if it contains nothing else useful):

- `src/server/test/fbi_web/controllers/runs_controller_test.exs`
- `src/server/test/fbi_web/controllers/secrets_controller_test.exs`
- `src/server/test/fbi_web/controllers/cli_controller_test.exs`
- `src/server/test/fbi_web/controllers/mcp_servers_controller_test.exs`
- `src/server/test/fbi_web/controllers/settings_controller_test.exs`
- `src/server/test/fbi/config/defaults_test.exs`

For each file, remove the `@moduledoc` line (or the entire `@moduledoc "..."` block) that contains a `src/server/` path reference.

- [ ] **Step 7: Remove "TS is authoritative" migration comments**

Open these two migration files and delete the comments that say TS owns the schema:

- `src/server/priv/repo/migrations/20260424000003_create_projects_table.exs` — remove comment referencing `src/server/db/index.ts`
- `src/server/priv/repo/migrations/20260424000007_add_runs_orchestrator_columns.exs` — remove comment referencing `src/server/db/index.ts`

- [ ] **Step 8: Verify no remaining stale references**

```bash
grep -r "server-elixir\|fbi-elixir\|ts server\|typescript server\|node server\|TS does\|elixir port\|port of\|mirrors src/server\|tsconfig\.server\|dev:server\|build:server" \
  --include="*.ts" --include="*.tsx" --include="*.ex" --include="*.exs" \
  --include="*.md" --include="*.sh" --include="*.yml" --include="*.json" \
  -l
```

Expected: empty output. Investigate and fix any files listed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: scrub all TS-server and dual-server references"
```

---

## Self-Review

**Spec coverage:**
- ✅ Delete src/server (TypeScript) — Tasks 1 & 2
- ✅ Move src/shared into web — Task 1
- ✅ Move server-elixir → src/server — Task 3
- ✅ Remove "fbi-elixir" references — Tasks 5, 6, 7
- ✅ Remove TypeScript port comments — Task 7
- ✅ CI updated — Task 4
- ✅ Scripts updated — Task 5
- ✅ Systemd updated — Task 6

**Dependency order:** Tasks 3 must precede Task 7 (Task 7 edits files inside src/server, which only exists after Task 3 moves them there). All other tasks are independent.

**Placeholder scan:** No TBDs or vague steps — all file paths are exact, all shell commands are complete.
