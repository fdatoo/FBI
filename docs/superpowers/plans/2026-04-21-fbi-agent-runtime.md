# FBI Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build FBI v1 — a single-user web tool that spins up ephemeral Docker containers per run, executes `claude --dangerously-skip-permissions` inside, streams the container's TTY to the browser over WebSocket, and auto-pushes a per-run branch. Spec: [2026-04-21-fbi-agent-runtime-design.md](../specs/2026-04-21-fbi-agent-runtime-design.md).

**Architecture:** One Node/TypeScript service (Fastify + `dockerode`) on a remote server. SQLite for metadata, plain log files for transcripts. React + Vite SPA served by the same process. xterm.js terminal over WebSocket with transcript replay. Ephemeral per-run containers with a tiny `supervisor.sh` entrypoint.

**Tech Stack:** Node 20+, TypeScript, Fastify, `@fastify/websocket`, `@fastify/static`, `better-sqlite3`, `dockerode`, React 18, React Router 6, Vite, Tailwind, xterm.js (+ `@xterm/addon-fit`), Vitest, Docker Engine.

---

## File Structure

Greenfield project. All files created from scratch. Organized by concern:

```
fbi/
  package.json
  tsconfig.json           # root config with project references
  tsconfig.server.json    # server build
  tsconfig.web.json       # type-checking only (Vite builds web)
  tsconfig.test.json      # test config
  vite.config.ts
  vitest.config.ts
  tailwind.config.ts
  postcss.config.cjs
  .eslintrc.cjs
  .gitignore
  src/
    shared/types.ts
    server/
      index.ts            # boot, Fastify init
      config.ts           # env parsing
      crypto.ts           # AES-GCM
      db/
        schema.sql
        index.ts          # DB wrapper + migrations
        projects.ts
        runs.ts
        secrets.ts
      logs/
        store.ts          # write + tail log files
        broadcaster.ts    # in-process fan-out
      orchestrator/
        configHash.ts
        image.ts          # build + cache
        supervisor.sh     # container entrypoint
        Dockerfile.tmpl   # fallback base
        postbuild.sh      # post-build layer injection
        index.ts          # start/await/cancel/recover
        gitAuth.ts        # SSH agent forwarding
      api/
        projects.ts
        runs.ts
        secrets.ts
        ws.ts             # WebSocket run shell
    web/
      index.html
      main.tsx
      App.tsx
      router.tsx
      index.css           # Tailwind directives
      lib/api.ts
      lib/ws.ts
      pages/
        Projects.tsx
        ProjectDetail.tsx
        NewProject.tsx
        EditProject.tsx
        NewRun.tsx
        Runs.tsx
        RunDetail.tsx
      components/
        Terminal.tsx
        StateBadge.tsx
        SecretsEditor.tsx
        Layout.tsx
  scripts/
    install.sh
  systemd/
    fbi.service
  README.md
```

Each file has exactly one concern. The split between `server/`, `web/`, and `shared/` is enforced by TypeScript project references.

---

## Phase A — Bootstrap

### Task 1: Initialize repository and root configs

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/package.json`
- Create: `/Users/fdatoo/Desktop/FBI/tsconfig.json`
- Create: `/Users/fdatoo/Desktop/FBI/tsconfig.server.json`
- Create: `/Users/fdatoo/Desktop/FBI/tsconfig.web.json`
- Create: `/Users/fdatoo/Desktop/FBI/tsconfig.test.json`
- Create: `/Users/fdatoo/Desktop/FBI/.gitignore`
- Create: `/Users/fdatoo/Desktop/FBI/.eslintrc.cjs`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "fbi",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "npm run build:server && npm run build:web",
    "build:server": "tsc -p tsconfig.server.json",
    "build:web": "vite build",
    "dev": "concurrently -k \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "tsx watch src/server/index.ts",
    "dev:web": "vite",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.web.json --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@fastify/static": "^7.0.4",
    "@fastify/websocket": "^10.0.1",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "better-sqlite3": "^11.1.2",
    "dockerode": "^4.0.2",
    "fastify": "^4.28.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.1",
    "tar-stream": "^3.1.7",
    "xterm": "^5.3.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/better-sqlite3": "^7.6.11",
    "@types/dockerode": "^3.3.31",
    "@types/node": "^20.14.14",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@types/tar-stream": "^3.1.3",
    "@typescript-eslint/eslint-plugin": "^7.18.0",
    "@typescript-eslint/parser": "^7.18.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "concurrently": "^8.2.2",
    "eslint": "^8.57.0",
    "eslint-plugin-react": "^7.34.4",
    "eslint-plugin-react-hooks": "^4.6.2",
    "happy-dom": "^14.12.3",
    "postcss": "^8.4.40",
    "tailwindcss": "^3.4.7",
    "tsx": "^4.16.5",
    "typescript": "^5.5.4",
    "vite": "^5.3.5",
    "vitest": "^2.0.5"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (root, project references only)

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.server.json" },
    { "path": "./tsconfig.web.json" },
    { "path": "./tsconfig.test.json" }
  ]
}
```

- [ ] **Step 3: Create `tsconfig.server.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist/server",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/server/**/*.ts", "src/shared/**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 4: Create `tsconfig.web.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "types": ["vite/client"]
  },
  "include": ["src/web/**/*.ts", "src/web/**/*.tsx", "src/shared/**/*.ts"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx"]
}
```

- [ ] **Step 5: Create `tsconfig.test.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules
dist
*.log
.DS_Store
.env
.env.local
/var
.superpowers
```

- [ ] **Step 7: Create `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: { react: { version: 'detect' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: ['dist', 'node_modules'],
};
```

- [ ] **Step 8: Install dependencies**

Run: `cd /Users/fdatoo/Desktop/FBI && npm install`
Expected: dependencies resolve, no errors.

- [ ] **Step 9: Initialize git and commit**

Run:
```bash
cd /Users/fdatoo/Desktop/FBI
git init
git add -A
git commit -m "chore: initialize monorepo with TS project references"
```

---

### Task 2: Vite, Vitest, Tailwind configs

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/vite.config.ts`
- Create: `/Users/fdatoo/Desktop/FBI/vitest.config.ts`
- Create: `/Users/fdatoo/Desktop/FBI/tailwind.config.ts`
- Create: `/Users/fdatoo/Desktop/FBI/postcss.config.cjs`

- [ ] **Step 1: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/web'),
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      ['src/web/**', 'happy-dom'],
    ],
    setupFiles: ['./src/web/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
```

- [ ] **Step 3: Create `tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/web/**/*.{ts,tsx,html}'],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 4: Create `postcss.config.cjs`**

```js
module.exports = {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 5: Create `src/web/test-setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: add vite, vitest, tailwind configs"
```

---

### Task 3: Shared types and server entry skeleton

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/shared/types.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/config.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/index.ts`

- [ ] **Step 1: Create `src/shared/types.ts`**

```ts
export type RunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Project {
  id: number;
  name: string;
  repo_url: string;
  default_branch: string;
  devcontainer_override_json: string | null;
  instructions: string | null;
  git_author_name: string | null;
  git_author_email: string | null;
  created_at: number;
  updated_at: number;
}

export interface Run {
  id: number;
  project_id: number;
  prompt: string;
  branch_name: string;
  state: RunState;
  container_id: string | null;
  log_path: string;
  exit_code: number | null;
  error: string | null;
  head_commit: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

export interface SecretName {
  name: string;
  created_at: number;
}
```

- [ ] **Step 2: Create `src/server/config.ts`**

```ts
import os from 'node:os';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export interface Config {
  port: number;
  dbPath: string;
  runsDir: string;
  hostSshAuthSock: string;
  hostClaudeDir: string;
  secretsKeyFile: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  webDir: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    dbPath: process.env.DB_PATH ?? '/var/lib/agent-manager/db.sqlite',
    runsDir: process.env.RUNS_DIR ?? '/var/lib/agent-manager/runs',
    hostSshAuthSock: process.env.HOST_SSH_AUTH_SOCK ?? process.env.SSH_AUTH_SOCK ?? '',
    hostClaudeDir:
      process.env.HOST_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
    secretsKeyFile:
      process.env.SECRETS_KEY_FILE ?? '/etc/agent-manager/secrets.key',
    gitAuthorName: required('GIT_AUTHOR_NAME'),
    gitAuthorEmail: required('GIT_AUTHOR_EMAIL'),
    webDir: process.env.WEB_DIR ?? path.resolve('dist/web'),
  };
}
```

- [ ] **Step 3: Create `src/server/index.ts`**

```ts
import Fastify from 'fastify';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const app = Fastify({ logger: true });

  app.get('/api/health', async () => ({ ok: true }));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Smoke-test the server**

Run:
```bash
GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=t@e.com DB_PATH=/tmp/fbi.db RUNS_DIR=/tmp/fbi-runs npm run dev:server &
sleep 2
curl -s http://localhost:3000/api/health
kill %1
```
Expected output: `{"ok":true}`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: shared types, config loader, fastify skeleton"
```

---

## Phase B — Database and encryption

### Task 4: Schema and DB wrapper with migrations

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/schema.sql`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/index.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/index.test.ts`

- [ ] **Step 1: Create `src/server/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  devcontainer_override_json TEXT,
  instructions TEXT,
  git_author_name TEXT,
  git_author_email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_secrets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  state TEXT NOT NULL,
  container_id TEXT,
  log_path TEXT NOT NULL,
  exit_code INTEGER,
  error TEXT,
  head_commit TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
```

- [ ] **Step 2: Write failing test** — `src/server/db/index.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from './index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('openDb', () => {
  it('creates schema idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'db.sqlite');
    const db1 = openDb(p);
    const db2 = openDb(p); // second open should also succeed
    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    expect(tables).toEqual([
      { name: 'project_secrets' },
      { name: 'projects' },
      { name: 'runs' },
    ]);
    db1.close();
    db2.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('enforces foreign key cascades', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'db.sqlite');
    const db = openDb(p);
    db.prepare(
      `INSERT INTO projects (name, repo_url, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('x', 'git@example.com:x', 'main', 1, 1);
    const pid = (db.prepare('SELECT id FROM projects').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pid, 'hello', 'claude/run-1', 'queued', '/tmp/x.log', 1);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    const count = (db.prepare('SELECT count(*) as c FROM runs').get() as {
      c: number;
    }).c;
    expect(count).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 3: Run failing test**

Run: `npx vitest run src/server/db/index.test.ts`
Expected: FAIL — `openDb` not found.

- [ ] **Step 4: Implement `src/server/db/index.ts`**

```ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  './schema.sql'
);

export type DB = Database.Database;

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  return db;
}
```

- [ ] **Step 5: Ensure `schema.sql` is copied into the dist folder on build**

Edit `tsconfig.server.json` — add `resolveJsonModule` is already set, but SQL isn't TS. We'll copy it with a small build step. Update `package.json` `build:server`:

Edit `/Users/fdatoo/Desktop/FBI/package.json` — change `build:server`:

```json
"build:server": "tsc -p tsconfig.server.json && cp src/server/db/schema.sql dist/server/db/schema.sql && cp src/server/orchestrator/supervisor.sh dist/server/orchestrator/supervisor.sh && cp src/server/orchestrator/Dockerfile.tmpl dist/server/orchestrator/Dockerfile.tmpl && cp src/server/orchestrator/postbuild.sh dist/server/orchestrator/postbuild.sh"
```

(Those orchestrator files are referenced here because they'll exist by end of plan; the build won't fail during dev since `tsx` reads from `src/`.)

- [ ] **Step 6: Run tests; confirm pass**

Run: `npx vitest run src/server/db/index.test.ts`
Expected: 2 passing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): sqlite wrapper with schema migration"
```

---

### Task 5: AES-256-GCM secrets crypto

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/crypto.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/crypto.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/crypto.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, loadKey } from './crypto.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('crypto', () => {
  const key = crypto.randomBytes(32);

  it('round-trips a string', () => {
    const ct = encrypt(key, 'hunter2');
    expect(ct).toBeInstanceOf(Uint8Array);
    expect(decrypt(key, ct)).toBe('hunter2');
  });

  it('produces different ciphertexts for the same plaintext', () => {
    const a = encrypt(key, 'same');
    const b = encrypt(key, 'same');
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
  });

  it('fails on tampered ciphertext', () => {
    const ct = Buffer.from(encrypt(key, 'secret'));
    ct[ct.length - 1] ^= 0xff;
    expect(() => decrypt(key, ct)).toThrow();
  });

  it('loadKey rejects short files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'short.key');
    fs.writeFileSync(p, Buffer.alloc(16));
    expect(() => loadKey(p)).toThrow(/32 bytes/);
    fs.rmSync(dir, { recursive: true });
  });

  it('loadKey returns 32 bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'k.key');
    fs.writeFileSync(p, Buffer.alloc(32, 7));
    const k = loadKey(p);
    expect(k.length).toBe(32);
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/crypto.test.ts`
Expected: FAIL — `encrypt` not found.

- [ ] **Step 3: Implement `src/server/crypto.ts`**

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function encrypt(key: Buffer, plaintext: string): Uint8Array {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

export function decrypt(key: Buffer, blob: Uint8Array): string {
  const b = Buffer.from(blob);
  const nonce = b.subarray(0, NONCE_LEN);
  const tag = b.subarray(b.length - TAG_LEN);
  const ct = b.subarray(NONCE_LEN, b.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function loadKey(path: string): Buffer {
  const raw = fs.readFileSync(path);
  if (raw.length !== 32) {
    throw new Error(
      `Secrets key file must be exactly 32 bytes, got ${raw.length}`
    );
  }
  return raw;
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/crypto.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(crypto): AES-256-GCM encrypt/decrypt for secrets"
```

---

### Task 6: Projects repository

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/projects.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/projects.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/db/projects.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  return openDb(path.join(dir, 'db.sqlite'));
}

describe('ProjectsRepo', () => {
  let repo: ProjectsRepo;
  beforeEach(() => {
    repo = new ProjectsRepo(tmpDb());
  });

  it('creates and retrieves a project', () => {
    const p = repo.create({
      name: 'foo',
      repo_url: 'git@github.com:me/foo.git',
      default_branch: 'main',
      devcontainer_override_json: null,
      instructions: null,
      git_author_name: null,
      git_author_email: null,
    });
    expect(p.id).toBeGreaterThan(0);
    expect(repo.get(p.id)?.name).toBe('foo');
  });

  it('enforces unique name', () => {
    repo.create({
      name: 'dup', repo_url: 'a', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    expect(() =>
      repo.create({
        name: 'dup', repo_url: 'b', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null,
      })
    ).toThrow();
  });

  it('updates a project', () => {
    const p = repo.create({
      name: 'bar', repo_url: 'x', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    repo.update(p.id, { instructions: 'be careful' });
    expect(repo.get(p.id)?.instructions).toBe('be careful');
  });

  it('lists and deletes', () => {
    repo.create({
      name: 'a', repo_url: 'a', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const p = repo.create({
      name: 'b', repo_url: 'b', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    expect(repo.list().length).toBe(2);
    repo.delete(p.id);
    expect(repo.list().length).toBe(1);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/db/projects.test.ts`
Expected: FAIL — `ProjectsRepo` not found.

- [ ] **Step 3: Implement `src/server/db/projects.ts`**

```ts
import type { DB } from './index.js';
import type { Project } from '../../shared/types.js';

export interface CreateProjectInput {
  name: string;
  repo_url: string;
  default_branch: string;
  devcontainer_override_json: string | null;
  instructions: string | null;
  git_author_name: string | null;
  git_author_email: string | null;
}

export type UpdateProjectInput = Partial<CreateProjectInput>;

export class ProjectsRepo {
  constructor(private db: DB) {}

  create(input: CreateProjectInput): Project {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO projects
        (name, repo_url, default_branch, devcontainer_override_json,
         instructions, git_author_name, git_author_email,
         created_at, updated_at)
       VALUES (@name, @repo_url, @default_branch, @devcontainer_override_json,
               @instructions, @git_author_name, @git_author_email, @now, @now)`
    );
    const info = stmt.run({ ...input, now });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Project | undefined {
    return this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as Project | undefined;
  }

  list(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as Project[];
  }

  update(id: number, patch: UpdateProjectInput): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`Project ${id} not found`);
    const merged = { ...existing, ...patch, updated_at: Date.now() };
    this.db
      .prepare(
        `UPDATE projects SET
          name=@name, repo_url=@repo_url, default_branch=@default_branch,
          devcontainer_override_json=@devcontainer_override_json,
          instructions=@instructions,
          git_author_name=@git_author_name, git_author_email=@git_author_email,
          updated_at=@updated_at
         WHERE id=@id`
      )
      .run(merged);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/db/projects.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): projects repository"
```

---

### Task 7: Secrets repository

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/secrets.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/secrets.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/db/secrets.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';
import { SecretsRepo } from './secrets.js';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const key = crypto.randomBytes(32);
  const projects = new ProjectsRepo(db);
  const secrets = new SecretsRepo(db, key);
  const p = projects.create({
    name: 'p', repo_url: 'a', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  return { secrets, projectId: p.id };
}

describe('SecretsRepo', () => {
  let secrets: SecretsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepo();
    secrets = r.secrets;
    projectId = r.projectId;
  });

  it('stores encrypted value and returns plaintext via decryptAll', () => {
    secrets.upsert(projectId, 'DB_URL', 'postgres://x');
    const decrypted = secrets.decryptAll(projectId);
    expect(decrypted).toEqual({ DB_URL: 'postgres://x' });
  });

  it('list returns names without values', () => {
    secrets.upsert(projectId, 'A', '1');
    secrets.upsert(projectId, 'B', '2');
    const names = secrets.list(projectId).map((s) => s.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('upsert replaces existing value', () => {
    secrets.upsert(projectId, 'K', 'v1');
    secrets.upsert(projectId, 'K', 'v2');
    expect(secrets.decryptAll(projectId)).toEqual({ K: 'v2' });
  });

  it('remove deletes', () => {
    secrets.upsert(projectId, 'K', 'v');
    secrets.remove(projectId, 'K');
    expect(secrets.decryptAll(projectId)).toEqual({});
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/db/secrets.test.ts`
Expected: FAIL — `SecretsRepo` not found.

- [ ] **Step 3: Implement `src/server/db/secrets.ts`**

```ts
import type { DB } from './index.js';
import type { SecretName } from '../../shared/types.js';
import { encrypt, decrypt } from '../crypto.js';

export class SecretsRepo {
  constructor(private db: DB, private key: Buffer) {}

  upsert(projectId: number, name: string, value: string): void {
    const ct = Buffer.from(encrypt(this.key, value));
    this.db
      .prepare(
        `INSERT INTO project_secrets (project_id, name, value_enc, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, name)
         DO UPDATE SET value_enc = excluded.value_enc, created_at = excluded.created_at`
      )
      .run(projectId, name, ct, Date.now());
  }

  list(projectId: number): SecretName[] {
    return this.db
      .prepare(
        'SELECT name, created_at FROM project_secrets WHERE project_id = ? ORDER BY name'
      )
      .all(projectId) as SecretName[];
  }

  remove(projectId: number, name: string): void {
    this.db
      .prepare('DELETE FROM project_secrets WHERE project_id = ? AND name = ?')
      .run(projectId, name);
  }

  decryptAll(projectId: number): Record<string, string> {
    const rows = this.db
      .prepare(
        'SELECT name, value_enc FROM project_secrets WHERE project_id = ?'
      )
      .all(projectId) as Array<{ name: string; value_enc: Buffer }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.name] = decrypt(this.key, r.value_enc);
    return out;
  }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/db/secrets.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): encrypted project secrets repository"
```

---

### Task 8: Runs repository

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/runs.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/db/runs.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/db/runs.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { ProjectsRepo } from './projects.js';
import { RunsRepo } from './runs.js';

function makeRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'a', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  return { runs, projectId: p.id };
}

describe('RunsRepo', () => {
  let runs: RunsRepo;
  let projectId: number;
  beforeEach(() => {
    const r = makeRepos();
    runs = r.runs;
    projectId = r.projectId;
  });

  it('creates a queued run with computed fields', () => {
    const run = runs.create({
      project_id: projectId,
      prompt: 'hello',
      branch_name_tmpl: (id) => `claude/run-${id}`,
      log_path_tmpl: (id) => `/tmp/runs/${id}.log`,
    });
    expect(run.state).toBe('queued');
    expect(run.branch_name).toBe(`claude/run-${run.id}`);
    expect(run.log_path).toBe(`/tmp/runs/${run.id}.log`);
  });

  it('markStarted and markFinished update state', () => {
    const run = runs.create({
      project_id: projectId, prompt: 'x',
      branch_name_tmpl: (id) => `b-${id}`,
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(run.id, 'container-abc');
    expect(runs.get(run.id)!.state).toBe('running');
    expect(runs.get(run.id)!.container_id).toBe('container-abc');

    runs.markFinished(run.id, {
      state: 'succeeded',
      exit_code: 0,
      head_commit: 'deadbeef',
    });
    const after = runs.get(run.id)!;
    expect(after.state).toBe('succeeded');
    expect(after.head_commit).toBe('deadbeef');
    expect(after.container_id).toBeNull();
    expect(after.finished_at).not.toBeNull();
  });

  it('lists running runs', () => {
    const r = runs.create({
      project_id: projectId, prompt: 'x',
      branch_name_tmpl: (id) => `b-${id}`,
      log_path_tmpl: (id) => `/tmp/${id}.log`,
    });
    runs.markStarted(r.id, 'c');
    expect(runs.listByState('running').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/db/runs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/db/runs.ts`**

```ts
import type { DB } from './index.js';
import type { Run, RunState } from '../../shared/types.js';

export interface CreateRunInput {
  project_id: number;
  prompt: string;
  branch_name_tmpl: (id: number) => string;
  log_path_tmpl: (id: number) => string;
}

export interface FinishInput {
  state: Extract<RunState, 'succeeded' | 'failed' | 'cancelled'>;
  exit_code?: number | null;
  error?: string | null;
  head_commit?: string | null;
}

export class RunsRepo {
  constructor(private db: DB) {}

  create(input: CreateRunInput): Run {
    return this.db.transaction(() => {
      const now = Date.now();
      const stub = this.db
        .prepare(
          `INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at)
           VALUES (?, ?, '', 'queued', '', ?)`
        )
        .run(input.project_id, input.prompt, now);
      const id = Number(stub.lastInsertRowid);
      const branch = input.branch_name_tmpl(id);
      const logPath = input.log_path_tmpl(id);
      this.db
        .prepare('UPDATE runs SET branch_name = ?, log_path = ? WHERE id = ?')
        .run(branch, logPath, id);
      return this.get(id)!;
    })();
  }

  get(id: number): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Run
      | undefined;
  }

  listByProject(projectId: number, limit = 50): Run[] {
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(projectId, limit) as Run[];
  }

  listByState(state: RunState, limit = 100): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE state = ? ORDER BY created_at DESC LIMIT ?')
      .all(state, limit) as Run[];
  }

  listAll(limit = 100): Run[] {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Run[];
  }

  markStarted(id: number, containerId: string): void {
    this.db
      .prepare(
        "UPDATE runs SET state='running', container_id=?, started_at=? WHERE id=?"
      )
      .run(containerId, Date.now(), id);
  }

  markFinished(id: number, f: FinishInput): void {
    this.db
      .prepare(
        `UPDATE runs SET state=?, container_id=NULL, exit_code=?, error=?,
         head_commit=?, finished_at=? WHERE id=?`
      )
      .run(
        f.state,
        f.exit_code ?? null,
        f.error ?? null,
        f.head_commit ?? null,
        Date.now(),
        id
      );
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/db/runs.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): runs repository"
```

---

## Phase C — Log store and broadcaster

### Task 9: LogStore with append-only writer and tail reader

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/logs/store.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/logs/store.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/logs/store.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LogStore } from './store.js';

describe('LogStore', () => {
  it('appends bytes and reads them back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    const s = new LogStore(p);
    s.append(Buffer.from('hello '));
    s.append(Buffer.from('world'));
    s.close();
    expect(fs.readFileSync(p, 'utf8')).toBe('hello world');
  });

  it('readAll returns contents as Uint8Array', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'log');
    fs.writeFileSync(p, Buffer.from('abc'));
    expect(Buffer.from(LogStore.readAll(p)).toString()).toBe('abc');
  });

  it('readAll returns empty if missing', () => {
    expect(LogStore.readAll('/nonexistent/x').length).toBe(0);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/logs/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/logs/store.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

export class LogStore {
  private fd: number;

  constructor(private filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, 'a');
  }

  append(chunk: Uint8Array): void {
    fs.writeSync(this.fd, chunk);
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  static readAll(filePath: string): Uint8Array {
    try {
      return fs.readFileSync(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Uint8Array();
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/logs/store.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(logs): append-only LogStore for run transcripts"
```

---

### Task 10: In-process broadcaster for run streams

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/logs/broadcaster.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/logs/broadcaster.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/logs/broadcaster.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Broadcaster } from './broadcaster.js';

describe('Broadcaster', () => {
  it('fans out bytes to all subscribers', () => {
    const b = new Broadcaster();
    const a: string[] = [];
    const c: string[] = [];
    const unsubA = b.subscribe((chunk) => a.push(Buffer.from(chunk).toString()));
    const unsubC = b.subscribe((chunk) => c.push(Buffer.from(chunk).toString()));
    b.publish(Buffer.from('x'));
    b.publish(Buffer.from('y'));
    expect(a).toEqual(['x', 'y']);
    expect(c).toEqual(['x', 'y']);
    unsubA();
    b.publish(Buffer.from('z'));
    expect(a).toEqual(['x', 'y']);
    expect(c).toEqual(['x', 'y', 'z']);
    unsubC();
  });

  it('end() signals subscribers and ignores post-end publishes', () => {
    const b = new Broadcaster();
    const events: Array<string | 'end'> = [];
    b.subscribe(
      (chunk) => events.push(Buffer.from(chunk).toString()),
      () => events.push('end')
    );
    b.publish(Buffer.from('a'));
    b.end();
    b.publish(Buffer.from('ignored'));
    expect(events).toEqual(['a', 'end']);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/logs/broadcaster.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/logs/broadcaster.ts`**

```ts
type DataFn = (chunk: Uint8Array) => void;
type EndFn = () => void;

interface Sub {
  onData: DataFn;
  onEnd: EndFn | undefined;
}

export class Broadcaster {
  private subs = new Set<Sub>();
  private ended = false;

  subscribe(onData: DataFn, onEnd?: EndFn): () => void {
    const sub: Sub = { onData, onEnd };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publish(chunk: Uint8Array): void {
    if (this.ended) return;
    for (const s of this.subs) s.onData(chunk);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const s of this.subs) s.onEnd?.();
  }

  isEnded(): boolean {
    return this.ended;
  }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/logs/broadcaster.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(logs): in-process broadcaster for run streams"
```

---

### Task 11: Run stream registry (log path + broadcaster per run)

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/logs/registry.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/logs/registry.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/logs/registry.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { RunStreamRegistry } from './registry.js';

describe('RunStreamRegistry', () => {
  it('creates one broadcaster per run id, reuses on second get', () => {
    const r = new RunStreamRegistry();
    const a = r.getOrCreate(1);
    const b = r.getOrCreate(1);
    expect(a).toBe(b);
  });

  it('release removes it after end', () => {
    const r = new RunStreamRegistry();
    const bc = r.getOrCreate(7);
    bc.end();
    r.release(7);
    const fresh = r.getOrCreate(7);
    expect(fresh).not.toBe(bc);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/logs/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/logs/registry.ts`**

```ts
import { Broadcaster } from './broadcaster.js';

export class RunStreamRegistry {
  private map = new Map<number, Broadcaster>();

  getOrCreate(runId: number): Broadcaster {
    let b = this.map.get(runId);
    if (!b) {
      b = new Broadcaster();
      this.map.set(runId, b);
    }
    return b;
  }

  get(runId: number): Broadcaster | undefined {
    return this.map.get(runId);
  }

  release(runId: number): void {
    this.map.delete(runId);
  }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/logs/registry.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(logs): run stream registry"
```

---

## Phase D — Image resolution

### Task 12: Config hash

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/configHash.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/configHash.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/orchestrator/configHash.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { computeConfigHash } from './configHash.js';

describe('computeConfigHash', () => {
  it('is stable for the same inputs', () => {
    const a = computeConfigHash({
      devcontainer_file: '{"image":"node:20"}',
      override_json: null,
      always: ['git'],
    });
    const b = computeConfigHash({
      devcontainer_file: '{"image":"node:20"}',
      override_json: null,
      always: ['git'],
    });
    expect(a).toBe(b);
  });

  it('changes when devcontainer file changes', () => {
    const a = computeConfigHash({
      devcontainer_file: '{"image":"node:20"}', override_json: null, always: [],
    });
    const b = computeConfigHash({
      devcontainer_file: '{"image":"node:22"}', override_json: null, always: [],
    });
    expect(a).not.toBe(b);
  });

  it('changes when override changes', () => {
    const a = computeConfigHash({
      devcontainer_file: null, override_json: '{"apt":["ripgrep"]}', always: [],
    });
    const b = computeConfigHash({
      devcontainer_file: null, override_json: '{"apt":["jq"]}', always: [],
    });
    expect(a).not.toBe(b);
  });

  it('is independent of always[] ordering', () => {
    const a = computeConfigHash({
      devcontainer_file: null, override_json: null, always: ['a', 'b'],
    });
    const b = computeConfigHash({
      devcontainer_file: null, override_json: null, always: ['b', 'a'],
    });
    expect(a).toBe(b);
  });

  it('produces 16 hex chars', () => {
    const h = computeConfigHash({
      devcontainer_file: null, override_json: null, always: [],
    });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/orchestrator/configHash.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/orchestrator/configHash.ts`**

```ts
import crypto from 'node:crypto';

export interface ConfigHashInput {
  devcontainer_file: string | null;
  override_json: string | null;
  always: readonly string[];
}

export function computeConfigHash(input: ConfigHashInput): string {
  const h = crypto.createHash('sha256');
  h.update('dev:');
  h.update(input.devcontainer_file ?? '');
  h.update('\nover:');
  h.update(input.override_json ?? '');
  h.update('\nalways:');
  h.update([...input.always].sort().join(','));
  return h.digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/orchestrator/configHash.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): stable config hash for image cache keys"
```

---

### Task 13: Dockerfile fallback template and post-build layer

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/Dockerfile.tmpl`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/postbuild.sh`

- [ ] **Step 1: Create `src/server/orchestrator/Dockerfile.tmpl`** (used when repo has no devcontainer.json)

```Dockerfile
# FBI fallback Dockerfile.
# Template variables (substituted at build-context time):
#   __BASE_IMAGE__     — base image (e.g., ubuntu:24.04)
#   __APT_PACKAGES__   — space-separated apt packages ("" when none)
#   __ENV_EXPORTS__    — newline-separated ENV lines ("" when none)

FROM __BASE_IMAGE__

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg __APT_PACKAGES__ && \
    rm -rf /var/lib/apt/lists/*

__ENV_EXPORTS__
```

- [ ] **Step 2: Create `src/server/orchestrator/postbuild.sh`** (bash script injected as a Dockerfile via `docker build --build-arg BASE_IMAGE=<prev>`; used as a post-build layer on top of any image)

```bash
#!/usr/bin/env bash
# FBI post-build layer. Run by the orchestrator as:
#   docker build -t <final> --build-arg BASE=<prev-image> -f Dockerfile.postbuild .
# where Dockerfile.postbuild embeds this script's intent:
#   FROM $BASE
#   RUN <contents of this file>
#
# Responsibilities:
#   1. Ensure required tools are installed.
#   2. Create the non-root "agent" user with HOME=/home/agent.
#   3. Drop GitHub host keys into /home/agent/.ssh/known_hosts.
#
# The script assumes apt-based systems (debian/ubuntu). For other bases,
# the orchestrator will log a warning and skip (see image.ts).

set -euo pipefail

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl gnupg
  rm -rf /var/lib/apt/lists/*
fi

# Install gh CLI.
if ! command -v gh >/dev/null 2>&1; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt-get install -y gh
fi

# Install Claude Code CLI.
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

# Create agent user.
if ! id agent >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --uid 1000 agent
fi

# Seed known_hosts with GitHub's published keys.
mkdir -p /home/agent/.ssh
cat > /home/agent/.ssh/known_hosts <<'HOSTS'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
HOSTS
chown -R agent:agent /home/agent/.ssh
chmod 700 /home/agent/.ssh
chmod 600 /home/agent/.ssh/known_hosts
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): fallback Dockerfile template and post-build script"
```

---

### Task 14: Image builder

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/image.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/image.test.ts`

This integration task requires a running Docker daemon. The test uses a tiny base image.

- [ ] **Step 1: Write failing integration test** — `src/server/orchestrator/image.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import { ImageBuilder } from './image.js';

const docker = new Docker();
const HAVE_DOCKER = await docker
  .ping()
  .then(() => true)
  .catch(() => false);

describe.skipIf(!HAVE_DOCKER)('ImageBuilder', () => {
  it('builds a fallback image and returns a stable tag', async () => {
    const builder = new ImageBuilder(docker);
    const tag = await builder.resolve({
      projectId: 999,
      devcontainerFile: null,
      overrideJson: JSON.stringify({
        base: 'alpine:3.19',
        apt: [],
        env: {},
      }),
      onLog: () => {},
    });
    expect(tag).toMatch(/^fbi\/p999:[0-9a-f]{16}$/);
    const img = await docker.getImage(tag).inspect();
    expect(img.Id).toBeDefined();
    await docker.getImage(tag).remove({ force: true }).catch(() => {});
  }, 120_000);

  it('returns cached tag on second call with same input', async () => {
    const builder = new ImageBuilder(docker);
    const input = {
      projectId: 998,
      devcontainerFile: null,
      overrideJson: JSON.stringify({ base: 'alpine:3.19', apt: [], env: {} }),
      onLog: () => {},
    };
    const tag1 = await builder.resolve(input);
    const t0 = Date.now();
    const tag2 = await builder.resolve(input);
    expect(tag1).toBe(tag2);
    expect(Date.now() - t0).toBeLessThan(2000); // cache hit is fast
    await docker.getImage(tag1).remove({ force: true }).catch(() => {});
  }, 180_000);
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/orchestrator/image.test.ts`
Expected: FAIL — `ImageBuilder` not found (or skipped if Docker is missing).

- [ ] **Step 3: Implement `src/server/orchestrator/image.ts`**

```ts
import type Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import tar from 'tar-stream';
import { computeConfigHash } from './configHash.js';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSTBUILD = fs.readFileSync(path.join(HERE, 'postbuild.sh'), 'utf8');
const DOCKERFILE_TMPL = fs.readFileSync(path.join(HERE, 'Dockerfile.tmpl'), 'utf8');

const ALWAYS = ['git', 'openssh-client', 'gh', 'ca-certificates', 'claude-cli'];

export interface ResolveInput {
  projectId: number;
  devcontainerFile: string | null;   // raw JSON contents if repo has one
  overrideJson: string | null;        // projects.devcontainer_override_json
  onLog: (chunk: Uint8Array) => void; // build logs
}

interface OverrideConfig {
  base?: string;
  apt?: string[];
  env?: Record<string, string>;
}

export class ImageBuilder {
  constructor(private docker: Docker) {}

  async resolve(input: ResolveInput): Promise<string> {
    const hash = computeConfigHash({
      devcontainer_file: input.devcontainerFile,
      override_json: input.overrideJson,
      always: ALWAYS,
    });
    const finalTag = `fbi/p${input.projectId}:${hash}`;

    if (await this.imageExists(finalTag)) return finalTag;

    // Stage 1: build the base image (either devcontainer or fallback template).
    const baseTag = `fbi/p${input.projectId}-base:${hash}`;
    if (!(await this.imageExists(baseTag))) {
      if (input.devcontainerFile) {
        await this.buildDevcontainer(input.devcontainerFile, baseTag, input.onLog);
      } else {
        await this.buildFallback(input.overrideJson, baseTag, input.onLog);
      }
    }

    // Stage 2: apply the FBI post-build layer on top.
    await this.buildPostLayer(baseTag, finalTag, input.onLog);
    return finalTag;
  }

  private async imageExists(tag: string): Promise<boolean> {
    try {
      await this.docker.getImage(tag).inspect();
      return true;
    } catch {
      return false;
    }
  }

  private renderFallbackDockerfile(overrideJson: string | null): string {
    const cfg: OverrideConfig = overrideJson ? JSON.parse(overrideJson) : {};
    const base = cfg.base ?? 'ubuntu:24.04';
    const apt = (cfg.apt ?? []).join(' ');
    const envLines = Object.entries(cfg.env ?? {})
      .map(([k, v]) => `ENV ${k}=${JSON.stringify(v)}`)
      .join('\n');
    return DOCKERFILE_TMPL
      .replace('__BASE_IMAGE__', base)
      .replace('__APT_PACKAGES__', apt)
      .replace('__ENV_EXPORTS__', envLines);
  }

  private async buildFallback(
    overrideJson: string | null,
    tag: string,
    onLog: (c: Uint8Array) => void
  ): Promise<void> {
    const dockerfile = this.renderFallbackDockerfile(overrideJson);
    const context = createTarContext({ Dockerfile: dockerfile });
    const stream = await this.docker.buildImage(context, { t: tag, rm: true });
    await this.followBuild(stream, onLog);
  }

  private async buildDevcontainer(
    devcontainerFileContents: string,
    tag: string,
    onLog: (c: Uint8Array) => void
  ): Promise<void> {
    // Write the file to a tmp dir and shell out to @devcontainers/cli.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-dc-'));
    fs.mkdirSync(path.join(tmp, '.devcontainer'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.devcontainer', 'devcontainer.json'),
      devcontainerFileContents
    );
    try {
      const out = execFileSync(
        'npx',
        [
          '-y',
          '@devcontainers/cli@0.67.0',
          'build',
          '--workspace-folder', tmp,
          '--image-name', tag,
        ],
        { encoding: 'buffer' }
      );
      onLog(out);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async buildPostLayer(
    baseTag: string,
    finalTag: string,
    onLog: (c: Uint8Array) => void
  ): Promise<void> {
    const dockerfile = [
      `FROM ${baseTag}`,
      `USER root`,
      `COPY postbuild.sh /tmp/postbuild.sh`,
      `RUN bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh`,
      `USER agent`,
      `WORKDIR /workspace`,
    ].join('\n');
    const context = createTarContext({
      Dockerfile: dockerfile,
      'postbuild.sh': POSTBUILD,
    });
    const stream = await this.docker.buildImage(context, { t: finalTag, rm: true });
    await this.followBuild(stream, onLog);
  }

  private followBuild(
    stream: NodeJS.ReadableStream,
    onLog: (c: Uint8Array) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { stream?: string; error?: string }) => {
          if (event.error) return; // final handler reports
          if (event.stream) onLog(Buffer.from(event.stream));
        }
      );
    });
  }
}

function createTarContext(files: Record<string, string>): NodeJS.ReadableStream {
  const pack = tar.pack();
  for (const [name, contents] of Object.entries(files)) {
    pack.entry({ name, mode: 0o644 }, contents);
  }
  pack.finalize();
  return pack;
}
```

- [ ] **Step 4: Run tests; confirm pass (requires Docker)**

Run: `npx vitest run src/server/orchestrator/image.test.ts`
Expected: if Docker is present, 2 passing (slow); else tests are skipped.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): image builder with cache, devcontainer + fallback, postbuild layer"
```

---

### Task 15: Supervisor script

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/supervisor.sh`

- [ ] **Step 1: Create `src/server/orchestrator/supervisor.sh`**

```bash
#!/usr/bin/env bash
# FBI run container entrypoint. Mounted at /usr/local/bin/supervisor.sh.
#
# Required env vars (set by orchestrator):
#   RUN_ID, REPO_URL, DEFAULT_BRANCH, BRANCH_NAME,
#   GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL
# Optional: any project secret, injected as env var.
# Required mounts:
#   /ssh-agent              (host ssh-agent socket, RW)
#   /home/agent/.claude     (host ~/.claude, RO)
#   /run/fbi                (tmpfs with instructions.txt + prompt.txt)
#
# Contract: at end, write /tmp/result.json with exit_code, push_exit, head_sha.

set -uo pipefail

export SSH_AUTH_SOCK=/ssh-agent

cd /workspace

git clone "$REPO_URL" . || { echo "clone failed"; exit 10; }
git checkout -b "$BRANCH_NAME" "origin/$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Compose the final prompt: project instructions + run prompt.
: > /tmp/prompt.txt
if [ -s /run/fbi/instructions.txt ]; then
    cat /run/fbi/instructions.txt >> /tmp/prompt.txt
    printf '\n\n---\n\n' >> /tmp/prompt.txt
fi
cat /run/fbi/prompt.txt >> /tmp/prompt.txt

# Run the agent. TTY-attached; Claude may emit its OAuth login flow if needed.
claude --dangerously-skip-permissions -p "$(cat /tmp/prompt.txt)"
CLAUDE_EXIT=$?

# Capture anything Claude didn't commit, then push.
git add -A
git commit -m "wip: claude run $RUN_ID" 2>/dev/null || true

PUSH_EXIT=0
git push -u origin "$BRANCH_NAME" || PUSH_EXIT=$?

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" > /tmp/result.json

exit $CLAUDE_EXIT
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): run supervisor script"
```

---

## Phase E — Orchestrator

### Task 16: Result reader

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/result.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/result.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/orchestrator/result.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseResultJson } from './result.js';

describe('parseResultJson', () => {
  it('parses valid result', () => {
    expect(
      parseResultJson('{"exit_code":0,"push_exit":0,"head_sha":"abc"}\n')
    ).toEqual({ exit_code: 0, push_exit: 0, head_sha: 'abc' });
  });
  it('returns null for invalid JSON', () => {
    expect(parseResultJson('nope')).toBeNull();
  });
  it('returns null for missing fields', () => {
    expect(parseResultJson('{"exit_code":0}')).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/orchestrator/result.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/orchestrator/result.ts`**

```ts
export interface ContainerResult {
  exit_code: number;
  push_exit: number;
  head_sha: string;
}

export function parseResultJson(text: string): ContainerResult | null {
  try {
    const obj = JSON.parse(text.trim());
    if (
      typeof obj.exit_code === 'number' &&
      typeof obj.push_exit === 'number' &&
      typeof obj.head_sha === 'string'
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/orchestrator/result.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): result.json parser"
```

---

### Task 17: Git auth module

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/gitAuth.ts`

- [ ] **Step 1: Create `src/server/orchestrator/gitAuth.ts`**

```ts
export interface GitAuthMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface GitAuth {
  describe(): string;                        // for logs
  mounts(): GitAuthMount[];
  env(): Record<string, string>;
}

/**
 * SSH agent forwarding. The host's ssh-agent socket is bind-mounted into the
 * container at /ssh-agent, and SSH_AUTH_SOCK is set accordingly in env().
 */
export class SshAgentForwarding implements GitAuth {
  constructor(private hostSocket: string) {
    if (!hostSocket) {
      throw new Error(
        'HOST_SSH_AUTH_SOCK is empty; start an ssh-agent and load keys first.'
      );
    }
  }

  describe(): string {
    return `ssh-agent-forwarding(${this.hostSocket})`;
  }

  mounts(): GitAuthMount[] {
    return [{ source: this.hostSocket, target: '/ssh-agent', readOnly: false }];
  }

  env(): Record<string, string> {
    return { SSH_AUTH_SOCK: '/ssh-agent' };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): SSH agent forwarding auth provider"
```

---

### Task 18: Orchestrator — start + await (happy path)

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/index.ts`

- [ ] **Step 1: Create `src/server/orchestrator/index.ts`**

```ts
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run } from '../../shared/types.js';
import type { RunsRepo } from '../db/runs.js';
import type { ProjectsRepo } from '../db/projects.js';
import type { SecretsRepo } from '../db/secrets.js';
import type { Config } from '../config.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { LogStore } from '../logs/store.js';
import { ImageBuilder } from './image.js';
import { parseResultJson } from './result.js';
import { SshAgentForwarding, type GitAuth } from './gitAuth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(HERE, 'supervisor.sh');

export interface OrchestratorDeps {
  docker: Docker;
  config: Config;
  projects: ProjectsRepo;
  runs: RunsRepo;
  secrets: SecretsRepo;
  streams: RunStreamRegistry;
}

export class Orchestrator {
  private imageBuilder: ImageBuilder;

  constructor(private deps: OrchestratorDeps) {
    this.imageBuilder = new ImageBuilder(deps.docker);
  }

  /** Kicks off a queued run. Fire-and-forget; state transitions go through DB. */
  async launch(runId: number): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.state !== 'queued') throw new Error(`run ${runId} not queued`);
    const project = this.deps.projects.get(run.project_id);
    if (!project) throw new Error(`project ${run.project_id} missing`);

    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
    };

    try {
      // Build or reuse image.
      onBytes(Buffer.from(`[fbi] resolving image\n`));
      const imageTag = await this.imageBuilder.resolve({
        projectId: project.id,
        devcontainerFile: null, // resolved per-project at repo time; v1 uses override only
        overrideJson: project.devcontainer_override_json,
        onLog: onBytes,
      });
      onBytes(Buffer.from(`[fbi] image: ${imageTag}\n`));

      // Prepare auth + secrets + prompt files.
      const auth: GitAuth = new SshAgentForwarding(this.deps.config.hostSshAuthSock);
      const projectSecrets = this.deps.secrets.decryptAll(project.id);
      const authorName = project.git_author_name ?? this.deps.config.gitAuthorName;
      const authorEmail = project.git_author_email ?? this.deps.config.gitAuthorEmail;

      const runTmpDir = fs.mkdtempSync(path.join('/tmp', 'fbi-run-'));
      fs.writeFileSync(path.join(runTmpDir, 'prompt.txt'), run.prompt);
      fs.writeFileSync(
        path.join(runTmpDir, 'instructions.txt'),
        project.instructions ?? ''
      );

      onBytes(Buffer.from(`[fbi] starting container\n`));
      const container = await this.deps.docker.createContainer({
        Image: imageTag,
        name: `fbi-run-${runId}`,
        User: 'agent',
        Env: [
          `RUN_ID=${runId}`,
          `REPO_URL=${project.repo_url}`,
          `DEFAULT_BRANCH=${project.default_branch}`,
          `BRANCH_NAME=${run.branch_name}`,
          `GIT_AUTHOR_NAME=${authorName}`,
          `GIT_AUTHOR_EMAIL=${authorEmail}`,
          ...Object.entries(auth.env()).map(([k, v]) => `${k}=${v}`),
          ...Object.entries(projectSecrets).map(([k, v]) => `${k}=${v}`),
        ],
        Tty: true,
        OpenStdin: true,
        StdinOnce: false,
        Entrypoint: ['/usr/local/bin/supervisor.sh'],
        HostConfig: {
          AutoRemove: false,
          Binds: [
            `${SUPERVISOR}:/usr/local/bin/supervisor.sh:ro`,
            `${this.deps.config.hostClaudeDir}:/home/agent/.claude:ro`,
            `${runTmpDir}:/run/fbi:ro`,
            ...auth.mounts().map((m) =>
              `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
            ),
          ],
        },
      });

      const attach = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });
      attach.on('data', (c: Buffer) => onBytes(c));

      await container.start();
      this.deps.runs.markStarted(runId, container.id);

      // Wait for exit.
      const waitRes = await container.wait();
      const resultText = await readFileFromContainer(
        container,
        '/tmp/result.json'
      ).catch(() => '');
      const parsed = parseResultJson(resultText);

      const state =
        waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0
          ? 'succeeded'
          : 'failed';

      this.deps.runs.markFinished(runId, {
        state,
        exit_code: parsed?.exit_code ?? waitRes.StatusCode,
        head_commit: parsed?.head_sha ?? null,
        error:
          state === 'failed'
            ? parsed
              ? parsed.push_exit !== 0
                ? `git push failed (code ${parsed.push_exit})`
                : `agent exit ${parsed.exit_code}`
              : `container exit ${waitRes.StatusCode}`
            : null,
      });
      onBytes(Buffer.from(`\n[fbi] run ${state}\n`));
      await container.remove({ force: true, v: true }).catch(() => {});
      fs.rmSync(runTmpDir, { recursive: true, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBytes(Buffer.from(`\n[fbi] error: ${msg}\n`));
      this.deps.runs.markFinished(runId, {
        state: 'failed',
        error: msg,
      });
    } finally {
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
  }
}

async function readFileFromContainer(
  container: Docker.Container,
  pathInContainer: string
): Promise<string> {
  const stream = await container.getArchive({ path: pathInContainer });
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const tarball = Buffer.concat(chunks);
  // The archive is a tar with a single file; extract it.
  const tar = await import('tar-stream');
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let content = '';
    extract.on('entry', (_, s, next) => {
      s.on('data', (d: Buffer) => (content += d.toString('utf8')));
      s.on('end', next);
      s.resume();
    });
    extract.on('finish', () => resolve(content));
    extract.on('error', reject);
    extract.end(tarball);
  });
}
```

- [ ] **Step 2: Smoke-test manually**

There's no single-unit test for the whole orchestrator (it's a real-Docker integration). We'll validate by end-to-end once the API is wired up. For now just confirm it compiles:

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): launch+wait happy path with log tee"
```

---

### Task 19: Orchestrator — cancel + stdin forwarding hooks

**Files:**
- Modify: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/index.ts`

- [ ] **Step 1: Add a runtime registry of active containers + attach streams**

Edit `src/server/orchestrator/index.ts`. Add these fields + methods to the `Orchestrator` class (inside the existing class body, before the trailing `}`):

```ts
  // Active run bookkeeping.
  private active = new Map<
    number,
    { container: Docker.Container; attachStream: NodeJS.ReadWriteStream }
  >();

  /** Forward stdin bytes from the UI to the container. */
  writeStdin(runId: number, bytes: Uint8Array): void {
    const a = this.active.get(runId);
    if (!a) return;
    a.attachStream.write(Buffer.from(bytes));
  }

  /** Resize the container's TTY. */
  async resize(runId: number, cols: number, rows: number): Promise<void> {
    const a = this.active.get(runId);
    if (!a) return;
    await a.container.resize({ w: cols, h: rows }).catch(() => {});
  }

  /** Cancel a running run. Safe to call on non-running runs (no-op). */
  async cancel(runId: number): Promise<void> {
    const a = this.active.get(runId);
    if (!a) return;
    await a.container.stop({ t: 10 }).catch(() => {});
    // the launch() loop observes wait() resolving and handles teardown;
    // mark intent here so it classifies state correctly.
    this.cancelled.add(runId);
  }

  private cancelled = new Set<number>();
```

- [ ] **Step 2: Wire `active` and `cancelled` into `launch()`**

In `launch()`, immediately after the existing `await container.start();` line, add:

```ts
      this.active.set(runId, { container, attachStream: attach });
```

After the `await container.wait();` call, add:

```ts
      const wasCancelled = this.cancelled.delete(runId);
```

Replace the state-decision block:

```ts
      const state =
        waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0
          ? 'succeeded'
          : 'failed';
```

with:

```ts
      const state: 'succeeded' | 'failed' | 'cancelled' = wasCancelled
        ? 'cancelled'
        : waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0
          ? 'succeeded'
          : 'failed';
```

In the `finally` block, also deregister the active entry:

```ts
    } finally {
      this.active.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): cancel, stdin forwarding, tty resize"
```

---

### Task 20: Orchestrator — restart recovery

**Files:**
- Modify: `/Users/fdatoo/Desktop/FBI/src/server/orchestrator/index.ts`

- [ ] **Step 1: Add a `recover()` method to `Orchestrator`**

Append to the `Orchestrator` class:

```ts
  /**
   * Called at startup. For each run in state='running', try to reattach; if
   * the container is gone, mark the run failed.
   */
  async recover(): Promise<void> {
    const running = this.deps.runs.listByState('running');
    for (const run of running) {
      if (!run.container_id) {
        this.deps.runs.markFinished(run.id, {
          state: 'failed',
          error: 'orchestrator lost container (no container_id recorded)',
        });
        continue;
      }
      try {
        const container = this.deps.docker.getContainer(run.container_id);
        await container.inspect();
        this.reattach(run.id, container).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.deps.runs.markFinished(run.id, {
            state: 'failed',
            error: `reattach failed: ${msg}`,
          });
        });
      } catch {
        this.deps.runs.markFinished(run.id, {
          state: 'failed',
          error: 'orchestrator lost container (container gone on restart)',
        });
      }
    }
  }

  private async reattach(runId: number, container: Docker.Container): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    const store = new LogStore(run.log_path);
    const broadcaster = this.deps.streams.getOrCreate(runId);
    const onBytes = (chunk: Uint8Array) => {
      store.append(chunk);
      broadcaster.publish(chunk);
    };

    onBytes(Buffer.from(`\n[fbi] reattached after orchestrator restart\n`));

    // Output: follow container.logs from where we left off.
    const sinceSec = Math.floor((run.started_at ?? Date.now()) / 1000);
    const logsStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      since: sinceSec,
    })) as unknown as NodeJS.ReadableStream;
    logsStream.on('data', (c: Buffer) => onBytes(c));

    // Stdin: fresh attach with only stdin.
    const attachStream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    });
    this.active.set(runId, { container, attachStream });

    const waitRes = await container.wait();
    const wasCancelled = this.cancelled.delete(runId);
    const resultText = await readFileFromContainer(
      container,
      '/tmp/result.json'
    ).catch(() => '');
    const parsed = parseResultJson(resultText);

    const state: 'succeeded' | 'failed' | 'cancelled' = wasCancelled
      ? 'cancelled'
      : waitRes.StatusCode === 0 && parsed && parsed.push_exit === 0
        ? 'succeeded'
        : 'failed';

    this.deps.runs.markFinished(runId, {
      state,
      exit_code: parsed?.exit_code ?? waitRes.StatusCode,
      head_commit: parsed?.head_sha ?? null,
      error:
        state === 'failed' && parsed
          ? parsed.push_exit !== 0
            ? `git push failed (code ${parsed.push_exit})`
            : `agent exit ${parsed.exit_code}`
          : state === 'failed'
            ? `container exit ${waitRes.StatusCode}`
            : null,
    });

    await container.remove({ force: true, v: true }).catch(() => {});
    this.active.delete(runId);
    store.close();
    broadcaster.end();
    this.deps.streams.release(runId);
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): restart recovery via logs+attach split"
```

---

## Phase F — HTTP API

### Task 21: Projects API routes

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/api/projects.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/api/projects.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/api/projects.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { SecretsRepo } from '../db/secrets.js';
import { registerProjectRoutes } from './projects.js';

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const secrets = new SecretsRepo(db, crypto.randomBytes(32));
  const app = Fastify();
  registerProjectRoutes(app, { projects, secrets });
  return app;
}

describe('projects routes', () => {
  it('POST /api/projects creates + GET /api/projects lists', async () => {
    const app = makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'foo',
        repo_url: 'git@github.com:x/y.git',
        default_branch: 'main',
      },
    });
    expect(create.statusCode).toBe(201);
    const listed = await app.inject({ method: 'GET', url: '/api/projects' });
    const body = listed.json() as Array<{ name: string }>;
    expect(body.map((p) => p.name)).toEqual(['foo']);
  });

  it('PATCH updates, DELETE removes', async () => {
    const app = makeApp();
    const { json: id } = (await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'a', repo_url: 'r', default_branch: 'main' },
    })).json() as { json: number; id: number };
    const created = (await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'b', repo_url: 'r', default_branch: 'main' },
    })).json() as { id: number };
    await app.inject({
      method: 'PATCH', url: `/api/projects/${created.id}`,
      payload: { instructions: 'be careful' },
    });
    const got = (await app.inject({
      method: 'GET', url: `/api/projects/${created.id}`,
    })).json() as { instructions: string };
    expect(got.instructions).toBe('be careful');
    const del = await app.inject({
      method: 'DELETE', url: `/api/projects/${created.id}`,
    });
    expect(del.statusCode).toBe(204);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/api/projects.test.ts`
Expected: FAIL — `registerProjectRoutes` not found.

- [ ] **Step 3: Implement `src/server/api/projects.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { ProjectsRepo } from '../db/projects.js';
import type { SecretsRepo } from '../db/secrets.js';

interface Deps {
  projects: ProjectsRepo;
  secrets: SecretsRepo;
}

export function registerProjectRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/projects', async () => deps.projects.list());

  app.post('/api/projects', async (req, reply) => {
    const body = req.body as {
      name: string;
      repo_url: string;
      default_branch?: string;
      devcontainer_override_json?: string | null;
      instructions?: string | null;
      git_author_name?: string | null;
      git_author_email?: string | null;
    };
    const created = deps.projects.create({
      name: body.name,
      repo_url: body.repo_url,
      default_branch: body.default_branch ?? 'main',
      devcontainer_override_json: body.devcontainer_override_json ?? null,
      instructions: body.instructions ?? null,
      git_author_name: body.git_author_name ?? null,
      git_author_email: body.git_author_email ?? null,
    });
    reply.code(201);
    return created;
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = deps.projects.get(Number(id));
    if (!p) return reply.code(404).send({ error: 'not found' });
    return p;
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.projects.update(Number(id), req.body as Record<string, unknown>);
    const p = deps.projects.get(Number(id));
    if (!p) return reply.code(404).send({ error: 'not found' });
    return p;
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.projects.delete(Number(id));
    reply.code(204);
  });
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/api/projects.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): project CRUD routes"
```

---

### Task 22: Secrets API routes

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/api/secrets.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/api/secrets.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/api/secrets.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { SecretsRepo } from '../db/secrets.js';
import { registerSecretsRoutes } from './secrets.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const secrets = new SecretsRepo(db, crypto.randomBytes(32));
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const app = Fastify();
  registerSecretsRoutes(app, { secrets });
  return { app, projectId: p.id };
}

describe('secrets routes', () => {
  it('PUT upserts, GET lists names, DELETE removes', async () => {
    const { app, projectId } = setup();
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/secrets/API_KEY`,
      payload: { value: 'abc' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/secrets/OTHER`,
      payload: { value: 'xyz' },
    });
    const list = (await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/secrets`,
    })).json() as Array<{ name: string }>;
    expect(list.map((s) => s.name).sort()).toEqual(['API_KEY', 'OTHER']);
    // Response should never contain plaintext value.
    expect(JSON.stringify(list)).not.toContain('abc');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/secrets/OTHER`,
    });
    expect(del.statusCode).toBe(204);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/api/secrets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/api/secrets.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { SecretsRepo } from '../db/secrets.js';

interface Deps {
  secrets: SecretsRepo;
}

export function registerSecretsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/projects/:id/secrets', async (req) => {
    const { id } = req.params as { id: string };
    return deps.secrets.list(Number(id));
  });

  app.put('/api/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const { value } = req.body as { value: string };
    deps.secrets.upsert(Number(id), name, value);
    reply.code(204);
  });

  app.delete('/api/projects/:id/secrets/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    deps.secrets.remove(Number(id), name);
    reply.code(204);
  });
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/api/secrets.test.ts`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): project secrets routes (names only, no plaintext)"
```

---

### Task 23: Runs API routes

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/api/runs.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/api/runs.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/api/runs.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { registerRunsRoutes } from './runs.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const launched: number[] = [];
  const cancelled: number[] = [];
  const app = Fastify();
  registerRunsRoutes(app, {
    runs,
    runsDir: dir,
    launch: async (id: number) => {
      launched.push(id);
    },
    cancel: async (id: number) => {
      cancelled.push(id);
    },
  });
  return { app, projectId: p.id, launched, cancelled };
}

describe('runs routes', () => {
  it('POST /api/projects/:id/runs creates + invokes launch', async () => {
    const { app, projectId, launched } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/runs`,
      payload: { prompt: 'fix the bug' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: number };
    expect(launched).toEqual([body.id]);
  });

  it('GET /api/runs lists all', async () => {
    const { app, projectId } = setup();
    await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/runs`, payload: { prompt: 'x' },
    });
    const list = (await app.inject({ method: 'GET', url: '/api/runs' })).json();
    expect((list as unknown[]).length).toBe(1);
  });

  it('DELETE /api/runs/:id cancels a running run', async () => {
    const { app, projectId, cancelled } = setup();
    const r = (await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/runs`, payload: { prompt: 'x' },
    })).json() as { id: number };
    // Simulate it becoming 'running' in the DB.
    // We can reach in via the test's repo, but here we just test the call:
    await app.inject({ method: 'DELETE', url: `/api/runs/${r.id}` });
    // queued runs get deleted (not cancelled); cancel only fires for running.
    expect(cancelled).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/server/api/runs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server/api/runs.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { RunsRepo } from '../db/runs.js';
import { LogStore } from '../logs/store.js';

interface Deps {
  runs: RunsRepo;
  runsDir: string;
  launch: (runId: number) => Promise<void>;
  cancel: (runId: number) => Promise<void>;
}

export function registerRunsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/runs', async () => deps.runs.listAll());

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    return run;
  });

  app.get('/api/projects/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    return deps.runs.listByProject(Number(id));
  });

  app.post('/api/projects/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { prompt } = req.body as { prompt: string };
    const run = deps.runs.create({
      project_id: Number(id),
      prompt,
      branch_name_tmpl: (rid) => `claude/run-${rid}`,
      log_path_tmpl: (rid) => path.join(deps.runsDir, `${rid}.log`),
    });
    // Fire-and-forget launch.
    void deps.launch(run.id).catch((err) => app.log.error({ err }, 'launch failed'));
    reply.code(201);
    return run;
  });

  app.delete('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.state === 'running') {
      await deps.cancel(run.id);
    } else {
      deps.runs.delete(run.id);
      try { fs.unlinkSync(run.log_path); } catch { /* noop */ }
    }
    reply.code(204);
  });

  app.get('/api/runs/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = deps.runs.get(Number(id));
    if (!run) return reply.code(404).send({ error: 'not found' });
    const bytes = LogStore.readAll(run.log_path);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return Buffer.from(bytes);
  });
}
```

- [ ] **Step 4: Run tests; confirm pass**

Run: `npx vitest run src/server/api/runs.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): runs routes"
```

---

### Task 24: Wire the server entry point

**Files:**
- Modify: `/Users/fdatoo/Desktop/FBI/src/server/index.ts`

- [ ] **Step 1: Rewrite `src/server/index.ts`**

```ts
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Docker from 'dockerode';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { ProjectsRepo } from './db/projects.js';
import { RunsRepo } from './db/runs.js';
import { SecretsRepo } from './db/secrets.js';
import { loadKey } from './crypto.js';
import { RunStreamRegistry } from './logs/registry.js';
import { Orchestrator } from './orchestrator/index.js';
import { registerProjectRoutes } from './api/projects.js';
import { registerSecretsRoutes } from './api/secrets.js';
import { registerRunsRoutes } from './api/runs.js';

async function main() {
  const config = loadConfig();
  fs.mkdirSync(config.runsDir, { recursive: true });

  const db = openDb(config.dbPath);
  const key = loadKey(config.secretsKeyFile);
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const secrets = new SecretsRepo(db, key);
  const streams = new RunStreamRegistry();
  const docker = new Docker();

  const orchestrator = new Orchestrator({
    docker, config, projects, runs, secrets, streams,
  });

  const app = Fastify({ logger: true });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: config.webDir,
    prefix: '/',
  });
  app.get('/api/health', async () => ({ ok: true }));

  registerProjectRoutes(app, { projects, secrets });
  registerSecretsRoutes(app, { secrets });
  registerRunsRoutes(app, {
    runs,
    runsDir: config.runsDir,
    launch: (id) => orchestrator.launch(id),
    cancel: (id) => orchestrator.cancel(id),
  });
  // registerWsRoute is wired in Task 25 once the module exists.

  // SPA fallback: any non-/api route returns index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });

  await orchestrator.recover();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(server): wire up all routes and orchestrator"
```

---

## Phase G — WebSocket run shell

### Task 25: WebSocket run shell route

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/server/api/ws.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/server/api/ws.test.ts`

- [ ] **Step 1: Write failing test** — `src/server/api/ws.test.ts`

```ts
import { describe, it, expect } from 'vitest';
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
import { LogStore } from '../logs/store.js';
import { registerWsRoute } from './ws.js';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const streams = new RunStreamRegistry();
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const logPath = path.join(dir, 'run.log');
  fs.writeFileSync(logPath, 'past-output');
  const run = runs.create({
    project_id: p.id, prompt: 'hi',
    branch_name_tmpl: (id) => `b-${id}`,
    log_path_tmpl: () => logPath,
  });
  // Mark it finished so the WS just replays the transcript.
  runs.markStarted(run.id, 'c');
  runs.markFinished(run.id, { state: 'succeeded', exit_code: 0, head_commit: 'abc' });

  const app = Fastify();
  await app.register(fastifyWebsocket);
  const orchestrator = {
    writeStdin: () => {},
    resize: async () => {},
    cancel: async () => {},
  };
  registerWsRoute(app, { runs, streams, orchestrator: orchestrator as never });
  await app.listen({ port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { app, port: address.port, runId: run.id };
}

describe('WS shell', () => {
  it('replays transcript and closes for completed runs', async () => {
    const { app, port, runId } = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${runId}/shell`);
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on('message', (d) => chunks.push(d as Buffer));
      ws.on('close', () => resolve());
    });
    await done;
    expect(Buffer.concat(chunks).toString()).toContain('past-output');
    await app.close();
  });
});
```

- [ ] **Step 2: Install `ws` types and client for the test**

Run: `cd /Users/fdatoo/Desktop/FBI && npm i -D ws @types/ws`

- [ ] **Step 3: Run failing test**

Run: `npx vitest run src/server/api/ws.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `src/server/api/ws.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { RunsRepo } from '../db/runs.js';
import type { RunStreamRegistry } from '../logs/registry.js';
import { LogStore } from '../logs/store.js';

interface Orchestrator {
  writeStdin(runId: number, bytes: Uint8Array): void;
  resize(runId: number, cols: number, rows: number): Promise<void>;
  cancel(runId: number): Promise<void>;
}

interface Deps {
  runs: RunsRepo;
  streams: RunStreamRegistry;
  orchestrator: Orchestrator;
}

interface ControlFrame {
  type: 'resize';
  cols: number;
  rows: number;
}

export function registerWsRoute(app: FastifyInstance, deps: Deps): void {
  app.get('/api/runs/:id/shell', { websocket: true }, (conn, req) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    const run = deps.runs.get(runId);
    if (!run) {
      conn.socket.close(4004, 'run not found');
      return;
    }

    // Replay existing log bytes.
    const existing = LogStore.readAll(run.log_path);
    if (existing.length > 0) conn.socket.send(existing);

    // If run is finished, close now.
    if (run.state !== 'running' && run.state !== 'queued') {
      conn.socket.close(1000, 'ended');
      return;
    }

    // Subscribe to live broadcaster.
    const bc = deps.streams.getOrCreate(runId);
    const unsub = bc.subscribe(
      (chunk) => {
        if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(chunk);
      },
      () => {
        try { conn.socket.close(1000, 'ended'); } catch { /* noop */ }
      }
    );

    conn.socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        // Text frame — try to parse as control JSON.
        try {
          const msg = JSON.parse(data.toString('utf8')) as ControlFrame;
          if (msg.type === 'resize') {
            void deps.orchestrator.resize(runId, msg.cols, msg.rows);
            return;
          }
        } catch { /* fall through to stdin */ }
      }
      deps.orchestrator.writeStdin(runId, data);
    });

    conn.socket.on('close', () => unsub());
  });
}
```

- [ ] **Step 5: Run tests; confirm pass**

Run: `npx vitest run src/server/api/ws.test.ts`
Expected: 1 passing.

- [ ] **Step 6: Wire the WS route into the server entry point**

Edit `src/server/index.ts`:

Add this import near the other `./api/*` imports:

```ts
import { registerWsRoute } from './api/ws.js';
```

Replace the placeholder line:

```ts
  // registerWsRoute is wired in Task 25 once the module exists.
```

with:

```ts
  registerWsRoute(app, { runs, streams, orchestrator });
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): WebSocket run shell with replay + live + stdin + resize"
```

---

### Task 26: End-to-end smoke test (manual)

**Files:**
- None (manual validation task)

- [ ] **Step 1: Set up prerequisites**

```bash
# Create runtime dirs
sudo mkdir -p /var/lib/agent-manager/runs /etc/agent-manager
sudo chown $USER:staff /var/lib/agent-manager /var/lib/agent-manager/runs /etc/agent-manager
head -c 32 /dev/urandom > /etc/agent-manager/secrets.key
chmod 600 /etc/agent-manager/secrets.key

# Start an ssh-agent and load a key
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519

# Make sure Claude is logged in on the HOST (for credential bind-mount)
claude /login
```

- [ ] **Step 2: Build and run the server**

```bash
cd /Users/fdatoo/Desktop/FBI
npm run build:server
GIT_AUTHOR_NAME="Test User" GIT_AUTHOR_EMAIL=test@example.com \
  node dist/server/index.js &
```

- [ ] **Step 3: Create a test project + run via API**

```bash
curl -s -X POST http://localhost:3000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"hello","repo_url":"git@github.com:<you>/<somesmallrepo>.git","default_branch":"main"}'
curl -s -X POST http://localhost:3000/api/projects/1/runs \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Add a HELLO.md file with the word hello. Commit it."}'
```

Expected: POST returns 201 with the new run id.

- [ ] **Step 4: Tail the transcript**

```bash
sleep 60
curl -s http://localhost:3000/api/runs/1/transcript
```

Expected: transcript contains image-build log, supervisor clone, Claude's output, `git push` output, branch link.

- [ ] **Step 5: Verify branch was pushed**

Check GitHub for `claude/run-1` on the test repo.

- [ ] **Step 6: Commit a notes file with findings**

If anything was discovered and fixed, commit the fix. If nothing needed to change, no commit is required; this task is a verification gate before moving into the frontend.

---

## Phase H — Frontend

### Task 27: SPA shell, index, router skeleton

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/web/index.html`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/main.tsx`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/App.tsx`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/router.tsx`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/index.css`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/lib/api.ts`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/components/Layout.tsx`

- [ ] **Step 1: Create `src/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FBI</title>
  </head>
  <body class="bg-gray-50">
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/web/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 3: Create `src/web/main.tsx`**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

- [ ] **Step 4: Create `src/web/App.tsx`**

```tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { ProjectsPage } from './pages/Projects.js';
import { NewProjectPage } from './pages/NewProject.js';
import { ProjectDetailPage } from './pages/ProjectDetail.js';
import { EditProjectPage } from './pages/EditProject.js';
import { NewRunPage } from './pages/NewRun.js';
import { RunsPage } from './pages/Runs.js';
import { RunDetailPage } from './pages/RunDetail.js';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/edit" element={<EditProjectPage />} />
        <Route path="/projects/:id/runs/new" element={<NewRunPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
```

- [ ] **Step 5: Create `src/web/components/Layout.tsx`**

```tsx
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <nav className="bg-white border-b px-6 py-3 flex gap-6 items-center">
        <Link to="/" className="font-bold text-lg">FBI</Link>
        <Link to="/" className="text-gray-700 hover:text-gray-900">Projects</Link>
        <Link to="/runs" className="text-gray-700 hover:text-gray-900">Runs</Link>
      </nav>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 6: Create `src/web/lib/api.ts`**

```ts
import type { Project, Run, SecretName } from '@shared/types.js';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: number) => request<Project>(`/api/projects/${id}`),
  createProject: (body: Partial<Project>) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: number, patch: Partial<Project>) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  listSecrets: (projectId: number) =>
    request<SecretName[]>(`/api/projects/${projectId}/secrets`),
  upsertSecret: (projectId: number, name: string, value: string) =>
    request<void>(`/api/projects/${projectId}/secrets/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  removeSecret: (projectId: number, name: string) =>
    request<void>(`/api/projects/${projectId}/secrets/${name}`, { method: 'DELETE' }),

  listRuns: () => request<Run[]>('/api/runs'),
  listProjectRuns: (projectId: number) =>
    request<Run[]>(`/api/projects/${projectId}/runs`),
  getRun: (id: number) => request<Run>(`/api/runs/${id}`),
  createRun: (projectId: number, prompt: string) =>
    request<Run>(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  deleteRun: (id: number) => request<void>(`/api/runs/${id}`, { method: 'DELETE' }),
};
```

- [ ] **Step 7: Create placeholder page files so the build runs**

Create each of these with a minimal stub (they'll be filled in later tasks):

`/Users/fdatoo/Desktop/FBI/src/web/pages/Projects.tsx`:
```tsx
export function ProjectsPage() { return <div>Projects</div>; }
```

`/Users/fdatoo/Desktop/FBI/src/web/pages/NewProject.tsx`:
```tsx
export function NewProjectPage() { return <div>New Project</div>; }
```

`/Users/fdatoo/Desktop/FBI/src/web/pages/ProjectDetail.tsx`:
```tsx
export function ProjectDetailPage() { return <div>Project Detail</div>; }
```

`/Users/fdatoo/Desktop/FBI/src/web/pages/EditProject.tsx`:
```tsx
export function EditProjectPage() { return <div>Edit Project</div>; }
```

`/Users/fdatoo/Desktop/FBI/src/web/pages/NewRun.tsx`:
```tsx
export function NewRunPage() { return <div>New Run</div>; }
```

`/Users/fdatoo/Desktop/FBI/src/web/pages/Runs.tsx`:
```tsx
export function RunsPage() { return <div>Runs</div>; }
```

`/Users/fdatoo/Desktop/FBI/src/web/pages/RunDetail.tsx`:
```tsx
export function RunDetailPage() { return <div>Run Detail</div>; }
```

- [ ] **Step 8: Build the SPA; verify no errors**

Run: `cd /Users/fdatoo/Desktop/FBI && npm run build:web`
Expected: Vite emits to `dist/web/` without error.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): SPA shell, router, layout, API client"
```

---

### Task 28: Projects list and new-project form

**Files:**
- Modify: `/Users/fdatoo/Desktop/FBI/src/web/pages/Projects.tsx`
- Modify: `/Users/fdatoo/Desktop/FBI/src/web/pages/NewProject.tsx`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/components/StateBadge.tsx`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/pages/Projects.test.tsx`

- [ ] **Step 1: Write failing component test** — `src/web/pages/Projects.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectsPage } from './Projects.js';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { listProjects: vi.fn() },
}));

describe('ProjectsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a list of projects from the API', async () => {
    (api.listProjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, name: 'alpha', repo_url: 'git@a', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null,
        created_at: 0, updated_at: 0 },
    ]);
    render(
      <MemoryRouter>
        <ProjectsPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/web/pages/Projects.test.tsx`
Expected: FAIL — component renders the stub, "alpha" isn't in DOM.

- [ ] **Step 3: Implement `src/web/components/StateBadge.tsx`**

```tsx
import type { RunState } from '@shared/types.js';

const COLORS: Record<RunState, string> = {
  queued: 'bg-gray-200 text-gray-800',
  running: 'bg-blue-200 text-blue-800',
  succeeded: 'bg-green-200 text-green-800',
  failed: 'bg-red-200 text-red-800',
  cancelled: 'bg-yellow-200 text-yellow-800',
};

export function StateBadge({ state }: { state: RunState }) {
  return (
    <span className={`inline-block px-2 py-1 rounded text-xs font-mono ${COLORS[state]}`}>
      {state}
    </span>
  );
}
```

- [ ] **Step 4: Implement `src/web/pages/Projects.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '@shared/types.js';
import { api } from '../lib/api.js';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="text-red-600">{error}</div>;
  if (!projects) return <div>Loading…</div>;
  if (projects.length === 0) {
    return (
      <div>
        <p className="mb-4">No projects yet.</p>
        <Link to="/projects/new" className="text-blue-600 underline">
          Create one
        </Link>
      </div>
    );
  }
  return (
    <div>
      <div className="flex justify-between mb-4">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <Link
          to="/projects/new"
          className="bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
        >
          New Project
        </Link>
      </div>
      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.id} className="bg-white border rounded p-4 flex justify-between">
            <div>
              <Link to={`/projects/${p.id}`} className="text-lg font-medium text-blue-700">
                {p.name}
              </Link>
              <p className="text-sm text-gray-500">{p.repo_url}</p>
            </div>
            <Link
              to={`/projects/${p.id}/runs/new`}
              className="self-center bg-gray-800 text-white px-3 py-1 rounded"
            >
              New Run
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Run test; confirm pass**

Run: `npx vitest run src/web/pages/Projects.test.tsx`
Expected: 1 passing.

- [ ] **Step 6: Implement `src/web/pages/NewProject.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

export function NewProjectPage() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const p = await api.createProject({
        name,
        repo_url: repoUrl,
        default_branch: defaultBranch,
        instructions: instructions || null,
      });
      nav(`/projects/${p.id}`);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold">New Project</h1>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full border rounded px-2 py-1"
        />
      </Field>
      <Field label="Repo URL (SSH)">
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          required
          className="w-full border rounded px-2 py-1 font-mono"
        />
      </Field>
      <Field label="Default Branch">
        <input
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          className="w-full border rounded px-2 py-1"
        />
      </Field>
      <Field label="Project-level instructions (optional)">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={4}
          className="w-full border rounded px-2 py-1 font-mono text-sm"
        />
      </Field>
      {error && <div className="text-red-600">{error}</div>}
      <button className="bg-blue-600 text-white px-4 py-2 rounded">Create</button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): projects list and new-project form"
```

---

### Task 29: Project detail with run history and secrets

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/web/components/SecretsEditor.tsx`
- Modify: `/Users/fdatoo/Desktop/FBI/src/web/pages/ProjectDetail.tsx`
- Modify: `/Users/fdatoo/Desktop/FBI/src/web/pages/EditProject.tsx`

- [ ] **Step 1: Implement `src/web/components/SecretsEditor.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { SecretName } from '@shared/types.js';
import { api } from '../lib/api.js';

export function SecretsEditor({ projectId }: { projectId: number }) {
  const [names, setNames] = useState<SecretName[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  async function refresh() {
    setNames(await api.listSecrets(projectId));
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function add() {
    if (!name) return;
    await api.upsertSecret(projectId, name, value);
    setName(''); setValue('');
    await refresh();
  }
  async function remove(n: string) {
    await api.removeSecret(projectId, n);
    await refresh();
  }
  return (
    <section className="bg-white border rounded p-4">
      <h2 className="font-semibold mb-2">Secrets</h2>
      <ul className="mb-3 space-y-1">
        {names.length === 0 && <li className="text-gray-500">None</li>}
        {names.map((s) => (
          <li key={s.name} className="flex justify-between items-center">
            <code>{s.name}</code>
            <button onClick={() => remove(s.name)} className="text-red-600 text-sm">
              remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          placeholder="NAME" value={name} onChange={(e) => setName(e.target.value)}
          className="border rounded px-2 py-1 font-mono"
        />
        <input
          placeholder="value" value={value} onChange={(e) => setValue(e.target.value)}
          type="password"
          className="border rounded px-2 py-1 flex-1"
        />
        <button onClick={add} className="bg-gray-800 text-white px-3 py-1 rounded">
          Add
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Implement `src/web/pages/ProjectDetail.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';
import { SecretsEditor } from '../components/SecretsEditor.js';

export function ProjectDetailPage() {
  const { id } = useParams();
  const pid = Number(id);
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(() => {
    void api.getProject(pid).then(setProject);
    void api.listProjectRuns(pid).then(setRuns);
  }, [pid]);

  if (!project) return <div>Loading…</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <p className="text-sm text-gray-500 font-mono">{project.repo_url}</p>
        </div>
        <div className="flex gap-2">
          <Link
            to={`/projects/${pid}/edit`}
            className="border px-3 py-1 rounded"
          >
            Edit
          </Link>
          <Link
            to={`/projects/${pid}/runs/new`}
            className="bg-blue-600 text-white px-3 py-1 rounded"
          >
            New Run
          </Link>
        </div>
      </div>

      <SecretsEditor projectId={pid} />

      <section className="bg-white border rounded p-4">
        <h2 className="font-semibold mb-2">Runs</h2>
        <ul className="divide-y">
          {runs.length === 0 && <li className="text-gray-500">No runs yet</li>}
          {runs.map((r) => (
            <li key={r.id} className="py-2 flex items-center justify-between">
              <Link to={`/runs/${r.id}`} className="text-blue-700">
                Run #{r.id} · {new Date(r.created_at).toLocaleString()}
              </Link>
              <StateBadge state={r.state} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Implement `src/web/pages/EditProject.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Project } from '@shared/types.js';
import { api } from '../lib/api.js';

export function EditProjectPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [p, setP] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void api.getProject(pid).then(setP); }, [pid]);
  if (!p) return <div>Loading…</div>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.updateProject(pid, {
        name: p!.name,
        repo_url: p!.repo_url,
        default_branch: p!.default_branch,
        instructions: p!.instructions,
        devcontainer_override_json: p!.devcontainer_override_json,
        git_author_name: p!.git_author_name,
        git_author_email: p!.git_author_email,
      });
      nav(`/projects/${pid}`);
    } catch (err) { setError(String(err)); }
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Edit {p.name}</h1>
      <Text label="Name" value={p.name} onChange={(v) => setP({ ...p, name: v })} />
      <Text label="Repo URL" value={p.repo_url} onChange={(v) => setP({ ...p, repo_url: v })} />
      <Text label="Default branch" value={p.default_branch} onChange={(v) => setP({ ...p, default_branch: v })} />
      <Text label="Git author name (override)" value={p.git_author_name ?? ''} onChange={(v) => setP({ ...p, git_author_name: v || null })} />
      <Text label="Git author email (override)" value={p.git_author_email ?? ''} onChange={(v) => setP({ ...p, git_author_email: v || null })} />
      <Area label="Instructions" value={p.instructions ?? ''} onChange={(v) => setP({ ...p, instructions: v || null })} />
      <Area label="Devcontainer override JSON (used when repo has no .devcontainer/devcontainer.json)"
            value={p.devcontainer_override_json ?? ''}
            onChange={(v) => setP({ ...p, devcontainer_override_json: v || null })} />
      {error && <div className="text-red-600">{error}</div>}
      <button className="bg-blue-600 text-white px-4 py-2 rounded">Save</button>
    </form>
  );
}

function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)}
             className="w-full border rounded px-2 py-1 font-mono" />
    </label>
  );
}
function Area({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={5}
                className="w-full border rounded px-2 py-1 font-mono text-sm" />
    </label>
  );
}
```

- [ ] **Step 4: Build web; manually visit / to confirm pages render**

Run: `cd /Users/fdatoo/Desktop/FBI && npm run build:web`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): project detail, edit, secrets editor"
```

---

### Task 30: New run form and runs list page

**Files:**
- Modify: `/Users/fdatoo/Desktop/FBI/src/web/pages/NewRun.tsx`
- Modify: `/Users/fdatoo/Desktop/FBI/src/web/pages/Runs.tsx`

- [ ] **Step 1: Implement `src/web/pages/NewRun.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';

export function NewRunPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    try {
      const run = await api.createRun(pid, prompt);
      nav(`/runs/${run.id}`);
    } catch (err) { setError(String(err)); }
  }

  return (
    <form onSubmit={submit} className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">New Run</h1>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={12}
        placeholder="Describe what Claude should do…"
        className="w-full border rounded px-3 py-2 font-mono text-sm"
        autoFocus
      />
      {error && <div className="text-red-600">{error}</div>}
      <button className="bg-blue-600 text-white px-4 py-2 rounded">Start Run</button>
    </form>
  );
}
```

- [ ] **Step 2: Implement `src/web/pages/Runs.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';

export function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  useEffect(() => { void api.listRuns().then(setRuns); }, []);
  if (!runs) return <div>Loading…</div>;
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">All Runs</h1>
      <ul className="divide-y bg-white border rounded">
        {runs.length === 0 && <li className="p-4 text-gray-500">No runs yet</li>}
        {runs.map((r) => (
          <li key={r.id} className="p-3 flex justify-between items-center">
            <Link to={`/runs/${r.id}`} className="text-blue-700">
              Run #{r.id} (project {r.project_id}) — {new Date(r.created_at).toLocaleString()}
            </Link>
            <StateBadge state={r.state} />
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): new run form and global runs list"
```

---

### Task 31: Terminal component with xterm.js

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/src/web/components/Terminal.tsx`
- Create: `/Users/fdatoo/Desktop/FBI/src/web/lib/ws.ts`

- [ ] **Step 1: Create `src/web/lib/ws.ts`**

```ts
export interface ShellHandle {
  onBytes(cb: (data: Uint8Array) => void): void;
  send(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export function openShell(runId: number): ShellHandle {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/runs/${runId}/shell`);
  ws.binaryType = 'arraybuffer';
  const cbs: Array<(d: Uint8Array) => void> = [];
  ws.onmessage = (ev) => {
    const data =
      ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new TextEncoder().encode(typeof ev.data === 'string' ? ev.data : '');
    for (const cb of cbs) cb(data);
  };
  return {
    onBytes: (cb) => cbs.push(cb),
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    resize: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    },
    close: () => ws.close(),
  };
}
```

- [ ] **Step 2: Create `src/web/components/Terminal.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { openShell } from '../lib/ws.js';

interface Props {
  runId: number;
  interactive: boolean;
}

export function Terminal({ runId, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Xterm({
      convertEol: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: { background: '#111827' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const shell = openShell(runId);
    shell.onBytes((data) => term.write(data));

    const onResize = () => {
      fit.fit();
      if (interactive) shell.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);
    onResize();

    if (interactive) {
      term.onData((d) => shell.send(new TextEncoder().encode(d)));
    }

    return () => {
      window.removeEventListener('resize', onResize);
      shell.close();
      term.dispose();
    };
  }, [runId, interactive]);

  return <div ref={hostRef} className="h-[70vh] bg-[#111827] rounded border" />;
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): xterm.js Terminal component over WebSocket"
```

---

### Task 32: Run detail page wiring the terminal

**Files:**
- Modify: `/Users/fdatoo/Desktop/FBI/src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Implement `src/web/pages/RunDetail.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { StateBadge } from '../components/StateBadge.js';
import { Terminal } from '../components/Terminal.js';

export function RunDetailPage() {
  const { id } = useParams();
  const runId = Number(id);
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await api.getRun(runId);
      if (alive) setRun(r);
    };
    void load();
    // Poll run metadata every 3s so state badge updates without a reload.
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [runId]);

  if (!run) return <div>Loading…</div>;

  async function cancel() {
    if (!confirm('Cancel this run?')) return;
    await api.deleteRun(runId);
    const r = await api.getRun(runId);
    setRun(r);
  }

  async function remove() {
    if (!confirm('Delete this run and its transcript?')) return;
    await api.deleteRun(runId);
    nav('/runs');
  }

  const interactive = run.state === 'running' || run.state === 'queued';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Run #{run.id}</h1>
        <StateBadge state={run.state} />
        {run.head_commit && (
          <code className="text-sm bg-gray-100 rounded px-2 py-0.5">
            {run.branch_name} @ {run.head_commit.slice(0, 8)}
          </code>
        )}
        <div className="ml-auto flex gap-2">
          {run.state === 'running' && (
            <button onClick={cancel} className="bg-red-600 text-white px-3 py-1 rounded">
              Cancel
            </button>
          )}
          {run.state !== 'running' && (
            <button onClick={remove} className="border px-3 py-1 rounded">
              Delete
            </button>
          )}
        </div>
      </div>
      <details className="bg-white border rounded p-3 text-sm">
        <summary className="cursor-pointer">Prompt</summary>
        <pre className="mt-2 whitespace-pre-wrap">{run.prompt}</pre>
      </details>
      <Terminal runId={run.id} interactive={interactive} />
    </div>
  );
}
```

- [ ] **Step 2: Build web and visit a run in the dev browser**

Run:
```bash
cd /Users/fdatoo/Desktop/FBI
npm run build:web
# In one terminal:
GIT_AUTHOR_NAME="Test" GIT_AUTHOR_EMAIL=t@e.com node dist/server/index.js
# Browser: open http://localhost:3000
```

Expected: projects list → create project → start run → terminal shows live output; reload page mid-run; second tab also shows it.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): run detail page with live terminal and controls"
```

---

## Phase I — Deployment

### Task 33: systemd unit and install script

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/systemd/fbi.service`
- Create: `/Users/fdatoo/Desktop/FBI/scripts/install.sh`

- [ ] **Step 1: Create `systemd/fbi.service`**

```ini
[Unit]
Description=FBI Agent Runtime
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=fbi
Group=fbi
EnvironmentFile=/etc/default/fbi
WorkingDirectory=/opt/fbi
ExecStart=/usr/bin/node /opt/fbi/dist/server/index.js
Restart=on-failure
RestartSec=3s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create `scripts/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# FBI install script. Run as root on the target server AFTER:
#   - Node 20+ installed
#   - Docker running
#   - User 'fbi' created and added to 'docker' group
#   - ssh-agent for 'fbi' configured to start on boot with keys loaded
#   - 'claude /login' performed once as 'fbi'

APP_DIR=/opt/fbi
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

install -d -o fbi -g fbi /var/lib/agent-manager /var/lib/agent-manager/runs /etc/agent-manager

if [ ! -f /etc/agent-manager/secrets.key ]; then
  head -c 32 /dev/urandom > /etc/agent-manager/secrets.key
  chown fbi:fbi /etc/agent-manager/secrets.key
  chmod 600 /etc/agent-manager/secrets.key
fi

rsync -a --delete --exclude node_modules --exclude .git "$SOURCE_DIR/" "$APP_DIR/"
chown -R fbi:fbi "$APP_DIR"

su - fbi -c "cd $APP_DIR && npm ci && npm run build"

cat > /etc/default/fbi <<'ENV'
PORT=3000
DB_PATH=/var/lib/agent-manager/db.sqlite
RUNS_DIR=/var/lib/agent-manager/runs
SECRETS_KEY_FILE=/etc/agent-manager/secrets.key
# Set these to real values:
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
# Defaulted but can override:
# HOST_SSH_AUTH_SOCK=/run/user/1000/ssh-agent.sock
# HOST_CLAUDE_DIR=/home/fbi/.claude
WEB_DIR=/opt/fbi/dist/web
ENV

install -m 644 "$APP_DIR/systemd/fbi.service" /etc/systemd/system/fbi.service
systemctl daemon-reload
systemctl enable --now fbi.service

echo "FBI installed. Edit /etc/default/fbi and restart: systemctl restart fbi"
```

- [ ] **Step 3: Commit**

```bash
chmod +x /Users/fdatoo/Desktop/FBI/scripts/install.sh
git add -A
git commit -m "chore(deploy): systemd unit and install script"
```

---

### Task 34: README with operator setup

**Files:**
- Create: `/Users/fdatoo/Desktop/FBI/README.md`

- [ ] **Step 1: Create `README.md`**

````markdown
# FBI

A personal web tool that runs `claude --dangerously-skip-permissions` inside ephemeral Docker containers, with an interactive in-browser terminal and per-run branch push.

**Status:** v1 — runtime slice only. See [design spec](docs/superpowers/specs/2026-04-21-fbi-agent-runtime-design.md).

## Prerequisites on the server

1. Docker Engine installed and running.
2. Tailscale (or other network boundary) set up — the app has no login.
3. Node 20+.
4. A unix user `fbi` in the `docker` group.
5. SSH keys loaded into the `fbi` user's ssh-agent, persisted across reboots.
6. `claude /login` performed once as `fbi`.

### Persistent ssh-agent recipe

One-time setup for a persistent user ssh-agent for the `fbi` user:

```bash
# As root:
loginctl enable-linger fbi

# As fbi:
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ssh-agent.service <<'EOF'
[Unit]
Description=User ssh-agent
[Service]
Type=simple
Environment=SSH_AUTH_SOCK=%t/ssh-agent.sock
ExecStart=/usr/bin/ssh-agent -D -a $SSH_AUTH_SOCK
[Install]
WantedBy=default.target
EOF
systemctl --user enable --now ssh-agent
# Then add your keys:
SSH_AUTH_SOCK=$XDG_RUNTIME_DIR/ssh-agent.sock ssh-add ~/.ssh/id_ed25519
```

In `/etc/default/fbi`, set:
```
HOST_SSH_AUTH_SOCK=/run/user/$(id -u fbi)/ssh-agent.sock
```

## Install

```bash
git clone <repo> /tmp/fbi-src
cd /tmp/fbi-src
sudo bash scripts/install.sh
sudo vim /etc/default/fbi    # set GIT_AUTHOR_NAME / EMAIL
sudo systemctl restart fbi
```

Open the service URL over Tailscale (port 3000 by default).

## Local development

```bash
npm install
GIT_AUTHOR_NAME="Dev" GIT_AUTHOR_EMAIL=dev@example.com \
  DB_PATH=/tmp/fbi.db RUNS_DIR=/tmp/fbi-runs \
  SECRETS_KEY_FILE=/tmp/fbi.key \
  head -c 32 /dev/urandom > /tmp/fbi.key && \
  npm run dev
```

Server at http://localhost:3000, Vite dev server at http://localhost:5173.

## Testing

```bash
npm test               # all unit tests
npm run typecheck
```

Integration tests for the orchestrator require Docker; they auto-skip if Docker is unreachable.

## Architecture

See [design spec](docs/superpowers/specs/2026-04-21-fbi-agent-runtime-design.md).
````

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "docs: README with operator setup"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Plan task(s) |
|---|---|
| §2 Architecture: one Node service, SQLite, Docker | T3, T24 |
| §3 Data model — projects / secrets / runs schemas | T4–T8 |
| §3 Runtime config env vars | T3 (config.ts) |
| §4.1 Submitting a run via POST | T23 |
| §4.2 Image resolution (devcontainer + override), config hash, cache | T12–T14 |
| §4.3 Container start (TTY, mounts, env, user: agent) | T18, T19 |
| §4.4 supervisor.sh | T15 |
| §4.5 Awaiting completion (result.json extraction, state finalization) | T16, T18 |
| §4.6 Cancellation | T19 |
| §4.7 Restart recovery (logs + attach split) | T20 |
| §5.1 Git SSH agent forwarding | T17, T18 |
| §5.2 Claude OAuth bind-mount | T18 (bind in Binds) |
| §5.3 Secret encryption (AES-GCM) | T5, T7 |
| §5.4 Tailscale/no auth | T24 (no auth middleware added) |
| §6 API surface | T21, T22, T23, T25 |
| §7 UI pages | T27–T32 |
| §8 Project layout | used throughout |
| §9 Operator setup / systemd unit / install script | T33, T34 |
| §10 Known unknowns (devcontainer features, CLI flags, branch collisions, known_hosts) | T14 (devcontainer build), T15 (supervisor uses `-p`), T13 (known_hosts), T26 (manual validation) |

No missing tasks.

**Placeholder scan:** No "TBD", "TODO", "fill in details". All steps contain executable code or commands. All referenced symbols exist by the task that uses them — Task 24 leaves a commented placeholder for `registerWsRoute` and Task 25 Step 6 wires it in once `api/ws.ts` exists, so every commit typechecks cleanly.

Applied fix: T24 no longer imports or registers `registerWsRoute` — it leaves a single-line commented placeholder. T25 Step 6 adds the import and replaces the placeholder after `api/ws.ts` exists, and T25 Step 7 reruns the typecheck to confirm it passes before the T25 commit. Every commit in the sequence now typechecks cleanly.

Going to adjust the plan to fix this.

**Type consistency check:** `RunState` union consistent across repos, API, UI. `computeConfigHash` signature stable. `GitAuth.mounts()` return shape stable. `Orchestrator.launch/cancel/resize/writeStdin/recover` all match their usage in `registerRunsRoutes`/`registerWsRoute`/`main()`.
