# MCP Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace opaque string env-var plugin config with a first-class Tools management UI covering plugin marketplaces, Claude Code plugins, and MCP servers — all configurable globally and per-project through the FBI web interface.

**Architecture:** Add a `mcp_servers` table and two columns to `settings`; move global plugins/marketplaces from env vars into the DB; extend the orchestrator to read plugins from settings and inject MCP configs into `.claude.json`; add a tag-chip `ChipInput` and `McpServerList`/`McpServerForm` UI components with a static catalog; update Settings, EditProject, and NewProject pages.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, React 18, Tailwind CSS, Vitest + @testing-library/react

---

## File Map

**New files:**
- `src/server/db/mcpServers.ts` — `McpServersRepo` class
- `src/server/db/mcpServers.test.ts` — unit tests for the repo
- `src/server/api/mcpServers.ts` — MCP server API route handlers
- `src/web/lib/catalog.ts` — static catalog of known MCP servers
- `src/web/components/ChipInput.tsx` — tag-chip input for plugins/marketplaces
- `src/web/components/ChipInput.test.tsx` — unit tests for ChipInput
- `src/web/components/McpServerForm.tsx` — add/edit form + catalog picker
- `src/web/components/McpServerList.tsx` — list of servers with inline add/edit

**Modified files:**
- `src/server/db/schema.sql` — add `mcp_servers` table
- `src/server/db/index.ts` — migrations for new settings columns
- `src/server/db/settings.ts` — add `global_marketplaces`/`global_plugins` fields
- `src/server/db/settings.test.ts` — extend with new fields tests
- `src/server/config.ts` — remove `defaultMarketplaces`/`defaultPlugins`
- `src/server/index.ts` — wire `McpServersRepo`; startup env-var migration; new routes
- `src/server/api/settings.ts` — handle new fields in GET/PATCH
- `src/server/orchestrator/index.ts` — read from settings; inject MCPs into `.claude.json`
- `src/shared/types.ts` — add `McpServer`; update `Settings`
- `src/web/lib/api.ts` — add MCP CRUD + update settings methods
- `src/web/pages/Settings.tsx` — add Tools section
- `src/web/pages/EditProject.tsx` — ChipInput + McpServerList
- `src/web/pages/NewProject.tsx` — ChipInput + McpServerList

---

### Task 1: DB schema — add `mcp_servers` table and settings columns

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts`

- [ ] **Step 1: Add `mcp_servers` table to schema.sql**

Append to the end of `src/server/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('stdio','sse')),
  command TEXT,
  args_json TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  env_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);
```

- [ ] **Step 2: Add migration for settings columns in `src/server/db/index.ts`**

Inside the `migrate()` function, after the existing `settingsCols` block (after the `notifications_enabled` check), add:

```ts
  if (!settingsCols.has('global_marketplaces_json')) {
    db.exec("ALTER TABLE settings ADD COLUMN global_marketplaces_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!settingsCols.has('global_plugins_json')) {
    db.exec("ALTER TABLE settings ADD COLUMN global_plugins_json TEXT NOT NULL DEFAULT '[]'");
  }
```

- [ ] **Step 3: Run tests to confirm nothing is broken**

```bash
npm test
```

Expected: all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts
git commit -m "feat(db): add mcp_servers table and global plugin settings columns"
```

---

### Task 2: `McpServersRepo`

**Files:**
- Create: `src/server/db/mcpServers.ts`
- Create: `src/server/db/mcpServers.test.ts`

- [ ] **Step 1: Add `McpServer` type to `src/shared/types.ts`**

Append to `src/shared/types.ts`:

```ts
export interface McpServer {
  id: number;
  project_id: number | null;
  name: string;
  type: 'stdio' | 'sse';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  created_at: number;
}
```

- [ ] **Step 2: Write failing tests in `src/server/db/mcpServers.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './index.js';
import { McpServersRepo } from './mcpServers.js';
import { ProjectsRepo } from './projects.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
  return openDb(path.join(dir, 'db.sqlite'));
}

describe('McpServersRepo', () => {
  let repo: McpServersRepo;
  let projectId: number;

  beforeEach(() => {
    const db = tmpDb();
    repo = new McpServersRepo(db);
    const projects = new ProjectsRepo(db);
    const p = projects.create({
      name: 'test', repo_url: 'git@github.com:x/y.git', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    projectId = p.id;
  });

  it('creates and lists a global server', () => {
    const s = repo.create({ project_id: null, name: 'puppeteer', type: 'stdio', command: 'npx', args: ['-y', '@mcp/puppeteer'] });
    expect(s.id).toBeGreaterThan(0);
    expect(s.name).toBe('puppeteer');
    expect(repo.listGlobal()).toHaveLength(1);
  });

  it('creates and lists a per-project server', () => {
    repo.create({ project_id: projectId, name: 'github', type: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: '$GH' } });
    expect(repo.listForProject(projectId)).toHaveLength(1);
    expect(repo.listGlobal()).toHaveLength(0);
  });

  it('listEffective merges global and project, project wins on name collision', () => {
    repo.create({ project_id: null, name: 'fetch', type: 'stdio', command: 'npx', args: ['a'] });
    repo.create({ project_id: null, name: 'shared', type: 'stdio', command: 'npx', args: ['global'] });
    repo.create({ project_id: projectId, name: 'shared', type: 'stdio', command: 'npx', args: ['project'] });
    const effective = repo.listEffective(projectId);
    expect(effective).toHaveLength(2);
    const shared = effective.find((s) => s.name === 'shared')!;
    expect(shared.args).toEqual(['project']);
  });

  it('updates a server', () => {
    const s = repo.create({ project_id: null, name: 'mem', type: 'stdio', command: 'npx', args: [] });
    const updated = repo.update(s.id, { args: ['-y', 'new'] });
    expect(updated?.args).toEqual(['-y', 'new']);
  });

  it('deletes a server', () => {
    const s = repo.create({ project_id: null, name: 'del', type: 'stdio', command: 'npx', args: [] });
    repo.delete(s.id);
    expect(repo.listGlobal()).toHaveLength(0);
  });

  it('cascades delete when project is deleted', () => {
    repo.create({ project_id: projectId, name: 'github', type: 'stdio', command: 'npx', args: [] });
    const db = (repo as any).db;
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    expect(repo.listForProject(projectId)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "FAIL|McpServersRepo"
```

Expected: `Cannot find module './mcpServers.js'`

- [ ] **Step 4: Create `src/server/db/mcpServers.ts`**

```ts
import type { DB } from './index.js';
import type { McpServer } from '../../shared/types.js';

interface McpServerRow {
  id: number;
  project_id: number | null;
  name: string;
  type: 'stdio' | 'sse';
  command: string | null;
  args_json: string;
  url: string | null;
  env_json: string;
  created_at: number;
}

function fromRow(row: McpServerRow): McpServer {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    type: row.type,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    url: row.url,
    env: JSON.parse(row.env_json) as Record<string, string>,
    created_at: row.created_at,
  };
}

export interface CreateMcpServerInput {
  project_id: number | null;
  name: string;
  type: 'stdio' | 'sse';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
}

export class McpServersRepo {
  constructor(private db: DB) {}

  listGlobal(): McpServer[] {
    return (
      this.db
        .prepare('SELECT * FROM mcp_servers WHERE project_id IS NULL ORDER BY name')
        .all() as McpServerRow[]
    ).map(fromRow);
  }

  listForProject(projectId: number): McpServer[] {
    return (
      this.db
        .prepare('SELECT * FROM mcp_servers WHERE project_id = ? ORDER BY name')
        .all(projectId) as McpServerRow[]
    ).map(fromRow);
  }

  listEffective(projectId: number): McpServer[] {
    const map = new Map<string, McpServer>();
    for (const s of this.listGlobal()) map.set(s.name, s);
    for (const s of this.listForProject(projectId)) map.set(s.name, s);
    return [...map.values()];
  }

  create(input: CreateMcpServerInput): McpServer {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO mcp_servers (project_id, name, type, command, args_json, url, env_json, created_at)
         VALUES (@project_id, @name, @type, @command, @args_json, @url, @env_json, @created_at)`
      )
      .run({
        project_id: input.project_id ?? null,
        name: input.name,
        type: input.type,
        command: input.command ?? null,
        args_json: JSON.stringify(input.args ?? []),
        url: input.url ?? null,
        env_json: JSON.stringify(input.env ?? {}),
        created_at: now,
      });
    return fromRow(
      this.db
        .prepare('SELECT * FROM mcp_servers WHERE id = ?')
        .get(result.lastInsertRowid) as McpServerRow
    );
  }

  update(
    id: number,
    patch: Partial<Omit<CreateMcpServerInput, 'project_id'>>
  ): McpServer | null {
    const existing = this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id) as McpServerRow | undefined;
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE mcp_servers
         SET name=@name, type=@type, command=@command, args_json=@args_json, url=@url, env_json=@env_json
         WHERE id=@id`
      )
      .run({
        id,
        name: patch.name ?? existing.name,
        type: patch.type ?? existing.type,
        command: patch.command !== undefined ? patch.command : existing.command,
        args_json: patch.args !== undefined ? JSON.stringify(patch.args) : existing.args_json,
        url: patch.url !== undefined ? patch.url : existing.url,
        env_json: patch.env !== undefined ? JSON.stringify(patch.env) : existing.env_json,
      });
    return fromRow(
      this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow
    );
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|McpServersRepo"
```

Expected: all `McpServersRepo` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/server/db/mcpServers.ts src/server/db/mcpServers.test.ts
git commit -m "feat(db): McpServersRepo with listGlobal/listForProject/listEffective/CRUD"
```

---

### Task 3: Settings — add `global_marketplaces` / `global_plugins`

**Files:**
- Modify: `src/server/db/settings.ts`
- Modify: `src/server/db/settings.test.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Update `Settings` interface in `src/shared/types.ts`**

Replace the existing `Settings` interface:

```ts
export interface Settings {
  global_prompt: string;
  notifications_enabled: boolean;
  global_marketplaces: string[];
  global_plugins: string[];
  updated_at: number;
}
```

- [ ] **Step 2: Write failing tests in `src/server/db/settings.test.ts`**

Add to the existing `describe` block:

```ts
  it('reads and updates global_marketplaces and global_plugins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const settings = new SettingsRepo(db);
    expect(settings.get().global_marketplaces).toEqual([]);
    expect(settings.get().global_plugins).toEqual([]);
    settings.update({ global_marketplaces: ['https://reg.example.com'], global_plugins: ['my-plugin@reg'] });
    expect(settings.get().global_marketplaces).toEqual(['https://reg.example.com']);
    expect(settings.get().global_plugins).toEqual(['my-plugin@reg']);
  });
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "global_marketplaces|FAIL"
```

Expected: FAIL — `global_marketplaces` is undefined.

- [ ] **Step 4: Update `src/server/db/settings.ts`**

Replace the entire file:

```ts
import type { DB } from './index.js';
import type { Settings } from '../../shared/types.js';

interface SettingsRow {
  id: number;
  global_prompt: string;
  notifications_enabled: number;
  global_marketplaces_json: string;
  global_plugins_json: string;
  updated_at: number;
}

export class SettingsRepo {
  constructor(private db: DB) {}

  get(): Settings {
    const row = this.db
      .prepare('SELECT * FROM settings WHERE id = 1')
      .get() as SettingsRow | undefined;
    if (!row) {
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO settings (id, global_prompt, notifications_enabled, updated_at) VALUES (1, '', 1, ?)"
        )
        .run(now);
      return {
        global_prompt: '',
        notifications_enabled: true,
        global_marketplaces: [],
        global_plugins: [],
        updated_at: now,
      };
    }
    return {
      global_prompt: row.global_prompt,
      notifications_enabled: row.notifications_enabled === 1,
      global_marketplaces: JSON.parse(row.global_marketplaces_json || '[]') as string[],
      global_plugins: JSON.parse(row.global_plugins_json || '[]') as string[],
      updated_at: row.updated_at,
    };
  }

  update(patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
    global_marketplaces?: string[];
    global_plugins?: string[];
  }): Settings {
    const existing = this.get();
    const merged = {
      global_prompt: patch.global_prompt ?? existing.global_prompt,
      notifications_enabled: patch.notifications_enabled ?? existing.notifications_enabled,
      global_marketplaces: patch.global_marketplaces ?? existing.global_marketplaces,
      global_plugins: patch.global_plugins ?? existing.global_plugins,
      updated_at: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE settings
         SET global_prompt=?, notifications_enabled=?,
             global_marketplaces_json=?, global_plugins_json=?, updated_at=?
         WHERE id=1`
      )
      .run(
        merged.global_prompt,
        merged.notifications_enabled ? 1 : 0,
        JSON.stringify(merged.global_marketplaces),
        JSON.stringify(merged.global_plugins),
        merged.updated_at
      );
    return merged;
  }
}
```

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/server/db/settings.ts src/server/db/settings.test.ts
git commit -m "feat(db): settings gains global_marketplaces and global_plugins fields"
```

---

### Task 4: Config cleanup + startup env-var migration

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Remove `defaultMarketplaces` / `defaultPlugins` from `src/server/config.ts`**

Replace the entire file:

```ts
import os from 'node:os';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
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
  containerMemMb: number;
  containerCpus: number;
  containerPids: number;
}

function parseList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    dbPath: process.env.DB_PATH ?? '/var/lib/agent-manager/db.sqlite',
    runsDir: process.env.RUNS_DIR ?? '/var/lib/agent-manager/runs',
    hostSshAuthSock: process.env.HOST_SSH_AUTH_SOCK ?? process.env.SSH_AUTH_SOCK ?? '',
    hostClaudeDir: process.env.HOST_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
    secretsKeyFile: process.env.SECRETS_KEY_FILE ?? '/etc/agent-manager/secrets.key',
    gitAuthorName: required('GIT_AUTHOR_NAME'),
    gitAuthorEmail: required('GIT_AUTHOR_EMAIL'),
    webDir: process.env.WEB_DIR ?? path.resolve('dist/web'),
    containerMemMb: Number(process.env.FBI_CONTAINER_MEM_MB ?? 4096),
    containerCpus: Number(process.env.FBI_CONTAINER_CPUS ?? 2),
    containerPids: Number(process.env.FBI_CONTAINER_PIDS ?? 4096),
  };
}

// Kept for startup migration only — not part of Config.
export function legacyDefaultLists(): { marketplaces: string[]; plugins: string[] } {
  return {
    marketplaces: parseList(process.env.FBI_DEFAULT_MARKETPLACES),
    plugins: parseList(process.env.FBI_DEFAULT_PLUGINS),
  };
}
```

- [ ] **Step 2: Add startup migration in `src/server/index.ts`**

After the `const settings = new SettingsRepo(db);` line, add:

```ts
  // One-time migration: if FBI_DEFAULT_* env vars are set and the DB still has empty
  // global lists, migrate them in so existing deployments don't lose configuration.
  const { legacyDefaultLists } = await import('./config.js');
  const legacy = legacyDefaultLists();
  const currentSettings = settings.get();
  if (legacy.marketplaces.length > 0 && currentSettings.global_marketplaces.length === 0) {
    settings.update({ global_marketplaces: legacy.marketplaces });
  }
  if (legacy.plugins.length > 0 && currentSettings.global_plugins.length === 0) {
    settings.update({ global_plugins: legacy.plugins });
  }
```

Note: `legacyDefaultLists` is already imported from `./config.js` via the existing `loadConfig` import. Update the existing import line:

```ts
import { loadConfig, legacyDefaultLists } from './config.js';
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep -v "^$" | head -20
```

Expected: no errors related to `defaultMarketplaces` / `defaultPlugins`.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts src/server/index.ts
git commit -m "feat(config): remove defaultMarketplaces/Plugins from Config, add one-time env-var migration to DB"
```

---

### Task 5: MCP server API routes

**Files:**
- Create: `src/server/api/mcpServers.ts`
- Modify: `src/server/api/settings.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Create `src/server/api/mcpServers.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { McpServersRepo } from '../db/mcpServers.js';

interface Deps {
  mcpServers: McpServersRepo;
}

export function registerMcpServerRoutes(
  app: FastifyInstance,
  deps: Deps
): void {
  // Global MCP servers
  app.get('/api/mcp-servers', async () => deps.mcpServers.listGlobal());

  app.post('/api/mcp-servers', async (req, reply) => {
    const body = req.body as {
      name: string;
      type: 'stdio' | 'sse';
      command?: string | null;
      args?: string[];
      url?: string | null;
      env?: Record<string, string>;
    };
    const created = deps.mcpServers.create({ project_id: null, ...body });
    reply.code(201);
    return created;
  });

  app.patch('/api/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const updated = deps.mcpServers.update(Number(id), req.body as Parameters<McpServersRepo['update']>[1]);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  });

  app.delete('/api/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.mcpServers.delete(Number(id));
    reply.code(204);
  });

  // Per-project MCP servers
  app.get('/api/projects/:id/mcp-servers', async (req) => {
    const { id } = req.params as { id: string };
    return deps.mcpServers.listForProject(Number(id));
  });

  app.post('/api/projects/:id/mcp-servers', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      name: string;
      type: 'stdio' | 'sse';
      command?: string | null;
      args?: string[];
      url?: string | null;
      env?: Record<string, string>;
    };
    const created = deps.mcpServers.create({ project_id: Number(id), ...body });
    reply.code(201);
    return created;
  });

  app.patch('/api/projects/:id/mcp-servers/:sid', async (req, reply) => {
    const { sid } = req.params as { id: string; sid: string };
    const updated = deps.mcpServers.update(Number(sid), req.body as Parameters<McpServersRepo['update']>[1]);
    if (!updated) return reply.code(404).send({ error: 'not found' });
    return updated;
  });

  app.delete('/api/projects/:id/mcp-servers/:sid', async (req, reply) => {
    const { sid } = req.params as { id: string; sid: string };
    deps.mcpServers.delete(Number(sid));
    reply.code(204);
  });
}
```

- [ ] **Step 2: Update `src/server/api/settings.ts` to handle new fields**

Replace the entire file:

```ts
import type { FastifyInstance } from 'fastify';
import type { SettingsRepo } from '../db/settings.js';

interface Deps {
  settings: SettingsRepo;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/settings', async () => deps.settings.get());

  app.patch('/api/settings', async (req) => {
    const body = req.body as {
      global_prompt?: string;
      notifications_enabled?: boolean;
      global_marketplaces?: string[];
      global_plugins?: string[];
    };
    return deps.settings.update({
      global_prompt: body.global_prompt,
      notifications_enabled: body.notifications_enabled,
      global_marketplaces: body.global_marketplaces,
      global_plugins: body.global_plugins,
    });
  });
}
```

- [ ] **Step 3: Wire `McpServersRepo` and new routes into `src/server/index.ts`**

Add the import at the top with the other DB imports:

```ts
import { McpServersRepo } from './db/mcpServers.js';
import { registerMcpServerRoutes } from './api/mcpServers.js';
```

After `const settings = new SettingsRepo(db);`, add:

```ts
  const mcpServers = new McpServersRepo(db);
```

After `registerSettingsRoutes(app, { settings });`, add:

```ts
  registerMcpServerRoutes(app, { mcpServers });
```

Also update the `Orchestrator` constructor call to include `mcpServers` (Task 6 will use it — add the field now so TypeScript doesn't complain later):

```ts
  const orchestrator = new Orchestrator({
    docker, config, projects, runs, secrets, settings, streams, mcpServers,
  });
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

Expected: errors about `mcpServers` not being in `OrchestratorDeps` — that's expected, Task 6 fixes it.

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: all tests PASS (orchestrator deps error is a type-only error, not a runtime error, so tests pass).

- [ ] **Step 6: Commit**

```bash
git add src/server/api/mcpServers.ts src/server/api/settings.ts src/server/index.ts
git commit -m "feat(api): MCP server CRUD routes (global + per-project) and settings new fields"
```

---

### Task 6: Orchestrator — read from settings, inject MCPs into `.claude.json`

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 1: Add `McpServersRepo` to `OrchestratorDeps` and replace `sanitizedClaudeJson`**

In `src/server/orchestrator/index.ts`, add the import at the top:

```ts
import type { McpServersRepo } from '../db/mcpServers.js';
import type { McpServer } from '../../shared/types.js';
```

Update `OrchestratorDeps`:

```ts
export interface OrchestratorDeps {
  docker: Docker;
  config: Config;
  projects: ProjectsRepo;
  runs: RunsRepo;
  secrets: SecretsRepo;
  settings: SettingsRepo;
  streams: RunStreamRegistry;
  mcpServers: McpServersRepo;
}
```

- [ ] **Step 2: Replace plugins/marketplaces to read from settings**

In `launch()`, replace:

```ts
      const marketplaces = uniq([
        ...this.deps.config.defaultMarketplaces,
        ...project.marketplaces,
      ]);
      const plugins = uniq([
        ...this.deps.config.defaultPlugins,
        ...project.plugins,
      ]);
```

with:

```ts
      const settingsData = this.deps.settings.get();
      const marketplaces = uniq([
        ...settingsData.global_marketplaces,
        ...project.marketplaces,
      ]);
      const plugins = uniq([
        ...settingsData.global_plugins,
        ...project.plugins,
      ]);
```

- [ ] **Step 3: Replace `sanitizedClaudeJson` call with MCP-aware version**

In `launch()`, replace:

```ts
      const claudeJson = sanitizedClaudeJson(this.deps.config.hostClaudeDir);
      if (claudeJson) {
        await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);
      }
```

with:

```ts
      const effectiveMcps = this.deps.mcpServers.listEffective(project.id);
      const claudeJson = buildContainerClaudeJson(
        this.deps.config.hostClaudeDir,
        effectiveMcps,
        projectSecrets,
      );
      await injectFiles(container, '/home/agent', { '.claude.json': claudeJson }, 1000);
```

- [ ] **Step 4: Add `buildContainerClaudeJson` and `buildMcpServersConfig` helpers**

Remove the existing `sanitizedClaudeJson` function at the bottom of the file and replace it with:

```ts
type McpEntry =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; env?: Record<string, string> };

function buildMcpServersConfig(
  mcps: McpServer[],
  secrets: Record<string, string>,
): Record<string, McpEntry> {
  const result: Record<string, McpEntry> = {};
  for (const mcp of mcps) {
    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(mcp.env)) {
      resolvedEnv[k] = v.startsWith('$') ? (secrets[v.slice(1)] ?? '') : v;
    }
    const env = Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined;
    if (mcp.type === 'stdio') {
      result[mcp.name] = { type: 'stdio', command: mcp.command ?? 'npx', args: mcp.args, ...(env ? { env } : {}) };
    } else {
      result[mcp.name] = { type: 'sse', url: mcp.url ?? '', ...(env ? { env } : {}) };
    }
  }
  return result;
}

function buildContainerClaudeJson(
  hostClaudeDir: string,
  mcps: McpServer[],
  secrets: Record<string, string>,
): string {
  let obj: Record<string, unknown> = {};
  const hostJson = path.join(path.dirname(hostClaudeDir), '.claude.json');
  if (fs.existsSync(hostJson)) {
    try {
      obj = JSON.parse(fs.readFileSync(hostJson, 'utf8')) as Record<string, unknown>;
    } catch { /* fall through with empty obj */ }
  }
  delete obj.installMethod;
  delete obj.autoUpdates;

  const projects = (obj.projects as Record<string, Record<string, unknown>>) ?? {};
  projects['/workspace'] = {
    ...(projects['/workspace'] ?? {}),
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    projectOnboardingSeenCount: 1,
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
  };
  obj.projects = projects;

  const mcpConfig = buildMcpServersConfig(mcps, secrets);
  if (Object.keys(mcpConfig).length > 0) obj.mcpServers = mcpConfig;

  return JSON.stringify(obj);
}
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

Expected: no errors.

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): read plugins from settings, inject MCP servers into .claude.json"
```

---

### Task 7: API client updates

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Update `src/web/lib/api.ts`**

Replace the entire file:

```ts
import type { McpServer, Project, Run, SecretName, Settings } from '@shared/types.js';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init?.body != null ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON but got ${contentType}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

type McpServerInput = {
  name: string;
  type: 'stdio' | 'sse';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
};

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: number) => request<Project>(`/api/projects/${id}`),
  createProject: (body: Omit<Project, 'id' | 'created_at' | 'updated_at'>) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: number, patch: Partial<Omit<Project, 'id' | 'created_at' | 'updated_at'>>) =>
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

  listRuns: (state?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled') =>
    request<Run[]>(state ? `/api/runs?state=${state}` : '/api/runs'),
  listProjectRuns: (projectId: number) =>
    request<Run[]>(`/api/projects/${projectId}/runs`),
  getRun: (id: number) => request<Run>(`/api/runs/${id}`),
  getRecentPrompts: (projectId: number, limit = 10) =>
    request<{ prompt: string; last_used_at: number; run_id: number }[]>(
      `/api/projects/${projectId}/prompts/recent?limit=${limit}`
    ),
  createRun: (projectId: number, prompt: string, branch?: string) =>
    request<Run>(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        branch: branch && branch.trim() !== '' ? branch.trim() : undefined,
      }),
    }),
  deleteRun: (id: number) => request<void>(`/api/runs/${id}`, { method: 'DELETE' }),

  getSettings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
    global_marketplaces?: string[];
    global_plugins?: string[];
  }) => request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  // Global MCP servers
  listMcpServers: () => request<McpServer[]>('/api/mcp-servers'),
  createMcpServer: (input: McpServerInput) =>
    request<McpServer>('/api/mcp-servers', { method: 'POST', body: JSON.stringify(input) }),
  updateMcpServer: (id: number, patch: Partial<McpServerInput>) =>
    request<McpServer>(`/api/mcp-servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMcpServer: (id: number) =>
    request<void>(`/api/mcp-servers/${id}`, { method: 'DELETE' }),

  // Per-project MCP servers
  listProjectMcpServers: (projectId: number) =>
    request<McpServer[]>(`/api/projects/${projectId}/mcp-servers`),
  createProjectMcpServer: (projectId: number, input: McpServerInput) =>
    request<McpServer>(`/api/projects/${projectId}/mcp-servers`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProjectMcpServer: (projectId: number, serverId: number, patch: Partial<McpServerInput>) =>
    request<McpServer>(`/api/projects/${projectId}/mcp-servers/${serverId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteProjectMcpServer: (projectId: number, serverId: number) =>
    request<void>(`/api/projects/${projectId}/mcp-servers/${serverId}`, { method: 'DELETE' }),
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/lib/api.ts
git commit -m "feat(api-client): add MCP server CRUD methods and update settings types"
```

---

### Task 8: `ChipInput` component

**Files:**
- Create: `src/web/components/ChipInput.tsx`
- Create: `src/web/components/ChipInput.test.tsx`

- [ ] **Step 1: Write failing tests in `src/web/components/ChipInput.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChipInput } from './ChipInput.js';

describe('ChipInput', () => {
  it('renders label and existing values as chips', () => {
    render(<ChipInput label="Plugins" values={['foo', 'bar']} onChange={() => {}} />);
    expect(screen.getByText('Plugins')).toBeInTheDocument();
    expect(screen.getByText('foo')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
  });

  it('adds a value on Enter', async () => {
    const onChange = vi.fn();
    render(<ChipInput label="Plugins" values={[]} onChange={onChange} placeholder="add…" />);
    const input = screen.getByPlaceholderText('add…');
    await userEvent.type(input, 'new-plugin{Enter}');
    expect(onChange).toHaveBeenCalledWith(['new-plugin']);
  });

  it('does not add empty or duplicate values', async () => {
    const onChange = vi.fn();
    render(<ChipInput label="Plugins" values={['existing']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'existing{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.type(input, '   {Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a value when × is clicked', async () => {
    const onChange = vi.fn();
    render(<ChipInput label="Plugins" values={['foo', 'bar']} onChange={onChange} />);
    const removeButtons = screen.getAllByRole('button');
    await userEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith(['bar']);
  });

  it('removes last chip on Backspace when input is empty', async () => {
    const onChange = vi.fn();
    render(<ChipInput label="Plugins" values={['foo', 'bar']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await userEvent.click(input);
    await userEvent.keyboard('{Backspace}');
    expect(onChange).toHaveBeenCalledWith(['foo']);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "ChipInput|Cannot find"
```

Expected: `Cannot find module './ChipInput.js'`

- [ ] **Step 3: Create `src/web/components/ChipInput.tsx`**

```tsx
import { useState } from 'react';

interface ChipInputProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}

export function ChipInput({ label, values, onChange, placeholder }: ChipInputProps) {
  const [draft, setDraft] = useState('');

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && !values.includes(trimmed)) onChange([...values, trimmed]);
    setDraft('');
  }

  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      <div className="flex flex-wrap gap-1.5 p-2 border rounded dark:border-gray-600 dark:bg-gray-900 min-h-[38px]">
        {values.map((v) => (
          <span
            key={v}
            className="flex items-center gap-1 bg-gray-200 dark:bg-gray-700 rounded px-2 py-0.5 text-sm"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="opacity-50 hover:opacity-100 leading-none"
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[160px] bg-transparent outline-none text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
            if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={values.length === 0 ? placeholder : ''}
        />
      </div>
    </label>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|ChipInput"
```

Expected: all `ChipInput` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/ChipInput.tsx src/web/components/ChipInput.test.tsx
git commit -m "feat(ui): ChipInput tag-chip component for plugins/marketplaces"
```

---

### Task 9: Catalog, `McpServerForm`, and `McpServerList`

**Files:**
- Create: `src/web/lib/catalog.ts`
- Create: `src/web/components/McpServerForm.tsx`
- Create: `src/web/components/McpServerList.tsx`

- [ ] **Step 1: Create `src/web/lib/catalog.ts`**

```ts
export interface CatalogEntry {
  name: string;
  description: string;
  emoji: string;
  type: 'stdio' | 'sse';
  command: string;
  args: string[];
  requiredEnv: string[];
}

export const CATALOG: CatalogEntry[] = [
  {
    name: 'fetch',
    description: 'HTTP requests from the agent',
    emoji: '🌐',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    requiredEnv: [],
  },
  {
    name: 'github',
    description: 'GitHub API',
    emoji: '🐙',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnv: ['GITHUB_TOKEN'],
  },
  {
    name: 'postgres',
    description: 'Query a Postgres database',
    emoji: '🗄️',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    requiredEnv: ['POSTGRES_CONNECTION_STRING'],
  },
  {
    name: 'puppeteer',
    description: 'Headless browser — screenshots, clicks',
    emoji: '🖥️',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    requiredEnv: [],
  },
  {
    name: 'sequential-thinking',
    description: 'Structured multi-step reasoning',
    emoji: '🧠',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    requiredEnv: [],
  },
  {
    name: 'brave-search',
    description: 'Web search',
    emoji: '🔍',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiredEnv: ['BRAVE_API_KEY'],
  },
  {
    name: 'memory',
    description: 'Persistent memory across runs',
    emoji: '💾',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    requiredEnv: [],
  },
];
```

- [ ] **Step 2: Create `src/web/components/McpServerForm.tsx`**

This component handles both adding (with optional catalog picker) and editing. When `initial` is `null` it's an add form; when it's an `McpServer` it's an edit form.

```tsx
import { useState } from 'react';
import type { McpServer } from '@shared/types.js';
import { CATALOG } from '../lib/catalog.js';

interface McpServerFormProps {
  initial: McpServer | null;
  onSave: (data: {
    name: string;
    type: 'stdio' | 'sse';
    command: string | null;
    args: string[];
    url: string | null;
    env: Record<string, string>;
  }) => void;
  onCancel: () => void;
}

export function McpServerForm({ initial, onSave, onCancel }: McpServerFormProps) {
  const [showCatalog, setShowCatalog] = useState(initial === null);
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<'stdio' | 'sse'>(initial?.type ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? 'npx');
  const [argsText, setArgsText] = useState((initial?.args ?? []).join('\n'));
  const [url, setUrl] = useState(initial?.url ?? '');
  const [envRows, setEnvRows] = useState<{ key: string; value: string }[]>(
    Object.entries(initial?.env ?? {}).map(([key, value]) => ({ key, value }))
  );

  function applyEntry(entry: (typeof CATALOG)[0]) {
    setName(entry.name);
    setType(entry.type);
    setCommand(entry.command);
    setArgsText(entry.args.join('\n'));
    setEnvRows(entry.requiredEnv.map((key) => ({ key, value: '' })));
    setShowCatalog(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const env: Record<string, string> = {};
    for (const { key, value } of envRows) {
      if (key.trim()) env[key.trim()] = value;
    }
    onSave({
      name: name.trim(),
      type,
      command: type === 'stdio' ? command.trim() || null : null,
      args: type === 'stdio' ? argsText.split('\n').map((s) => s.trim()).filter(Boolean) : [],
      url: type === 'sse' ? url.trim() || null : null,
      env,
    });
  }

  if (showCatalog) {
    return (
      <div className="border rounded dark:border-gray-600 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b dark:border-gray-600 bg-gray-50 dark:bg-gray-800">
          <span className="text-sm font-medium">Choose from catalog</span>
          <button type="button" onClick={() => setShowCatalog(false)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Add custom instead →
          </button>
        </div>
        {CATALOG.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center justify-between px-3 py-2.5 border-b last:border-0 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50"
          >
            <div>
              <span className="text-sm font-medium">{entry.emoji} {entry.name}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{entry.description}</span>
              {entry.requiredEnv.length > 0 && (
                <span className="text-xs text-amber-600 dark:text-amber-400 ml-2">
                  requires {entry.requiredEnv.join(', ')}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => applyEntry(entry)}
              className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded hover:bg-blue-700"
            >
              Add
            </button>
          </div>
        ))}
        <div className="px-3 py-2 border-t dark:border-gray-700">
          <button type="button" onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="border rounded dark:border-gray-600 p-4 space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1">Name</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border rounded px-2 py-1 text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Type</label>
        <div className="flex gap-4">
          {(['stdio', 'sse'] as const).map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={type === t} onChange={() => setType(t)} /> {t}
            </label>
          ))}
        </div>
      </div>
      {type === 'stdio' ? (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Command</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Args <span className="font-normal text-gray-500">(one per line)</span></label>
            <textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              rows={3}
              className="w-full border rounded px-2 py-1 text-sm font-mono dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
          </div>
        </>
      ) : (
        <div>
          <label className="block text-sm font-medium mb-1">URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
          />
        </div>
      )}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium">Environment variables</label>
          <button
            type="button"
            onClick={() => setEnvRows([...envRows, { key: '', value: '' }])}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            + Add
          </button>
        </div>
        {envRows.length > 0 && (
          <div className="border rounded dark:border-gray-600 overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_auto] text-xs font-medium bg-gray-50 dark:bg-gray-800 border-b dark:border-gray-600">
              <div className="px-2 py-1.5">Key</div>
              <div className="px-2 py-1.5 border-l dark:border-gray-600">Value</div>
              <div className="px-2 py-1.5" />
            </div>
            {envRows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] border-t dark:border-gray-600">
                <input
                  value={row.key}
                  onChange={(e) => {
                    const next = [...envRows];
                    next[i] = { ...next[i], key: e.target.value };
                    setEnvRows(next);
                  }}
                  placeholder="KEY"
                  className="px-2 py-1 text-sm font-mono bg-transparent outline-none dark:text-gray-100"
                />
                <input
                  value={row.value}
                  onChange={(e) => {
                    const next = [...envRows];
                    next[i] = { ...next[i], value: e.target.value };
                    setEnvRows(next);
                  }}
                  placeholder="value or $SECRET_NAME"
                  className="px-2 py-1 text-sm font-mono bg-transparent outline-none border-l dark:border-gray-600 dark:text-gray-100"
                />
                <button
                  type="button"
                  onClick={() => setEnvRows(envRows.filter((_, j) => j !== i))}
                  className="px-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Use <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">$SECRET_NAME</code> to reference a project secret
        </p>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 border rounded dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">
          Cancel
        </button>
        <button type="submit" className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700">
          {initial ? 'Save' : 'Add server'}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Create `src/web/components/McpServerList.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { McpServer } from '@shared/types.js';
import { api } from '../lib/api.js';
import { McpServerForm } from './McpServerForm.js';

interface McpServerListProps {
  projectId: number | null; // null = global
  label?: string;
}

type FormState =
  | { mode: 'closed' }
  | { mode: 'catalog' }
  | { mode: 'edit'; server: McpServer };

export function McpServerList({ projectId, label = 'MCP servers' }: McpServerListProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [form, setForm] = useState<FormState>({ mode: 'closed' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [projectId]);

  async function load() {
    const list =
      projectId === null
        ? await api.listMcpServers()
        : await api.listProjectMcpServers(projectId);
    setServers(list);
  }

  async function handleSave(data: Parameters<typeof api.createMcpServer>[0]) {
    setError(null);
    try {
      if (form.mode === 'edit') {
        const updated =
          projectId === null
            ? await api.updateMcpServer(form.server.id, data)
            : await api.updateProjectMcpServer(projectId, form.server.id, data);
        setServers(servers.map((s) => (s.id === updated.id ? updated : s)));
      } else {
        const created =
          projectId === null
            ? await api.createMcpServer(data)
            : await api.createProjectMcpServer(projectId, data);
        setServers([...servers, created]);
      }
      setForm({ mode: 'closed' });
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete(server: McpServer) {
    setError(null);
    try {
      if (projectId === null) {
        await api.deleteMcpServer(server.id);
      } else {
        await api.deleteProjectMcpServer(projectId, server.id);
      }
      setServers(servers.filter((s) => s.id !== server.id));
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{label}</span>
        {form.mode === 'closed' && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setForm({ mode: 'catalog' })}
              className="text-xs px-2.5 py-1 border rounded dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              + From catalog
            </button>
            <button
              type="button"
              onClick={() => setForm({ mode: 'catalog' })}
              className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              + Add custom
            </button>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</p>}

      {servers.length > 0 && (
        <div className="border rounded dark:border-gray-600 overflow-hidden mb-3">
          {servers.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between px-3 py-2.5 border-b last:border-0 dark:border-gray-700 text-sm"
            >
              <div className="min-w-0">
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                  {s.type} ·{' '}
                  {s.type === 'stdio'
                    ? `${s.command} ${s.args.join(' ')}`
                    : s.url}
                </span>
              </div>
              <div className="flex gap-1.5 ml-3 shrink-0">
                {Object.keys(s.env).length > 0 && (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    {Object.keys(s.env).length} env
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setForm({ mode: 'edit', server: s })}
                  className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-1.5"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(s)}
                  className="text-xs text-red-500 hover:text-red-700 px-1.5"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(form.mode === 'catalog' || form.mode === 'edit') && (
        <McpServerForm
          initial={form.mode === 'edit' ? form.server : null}
          onSave={handleSave}
          onCancel={() => setForm({ mode: 'closed' })}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/catalog.ts src/web/components/McpServerForm.tsx src/web/components/McpServerList.tsx
git commit -m "feat(ui): catalog, McpServerForm, and McpServerList components"
```

---

### Task 10: Settings page — add Tools section

**Files:**
- Modify: `src/web/pages/Settings.tsx`

- [ ] **Step 1: Update `src/web/pages/Settings.tsx`**

Replace the entire file:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { ChipInput } from '../components/ChipInput.js';
import { McpServerList } from '../components/McpServerList.js';

export function SettingsPage() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [marketplaces, setMarketplaces] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setPrompt(s.global_prompt);
      setEnabled(s.notifications_enabled);
      setMarketplaces(s.global_marketplaces);
      setPlugins(s.global_plugins);
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (prompt == null) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.updateSettings({
        global_prompt: prompt,
        notifications_enabled: enabled,
        global_marketplaces: marketplaces,
        global_plugins: plugins,
      });
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  if (prompt == null) return <div>Loading…</div>;

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <label className="block">
        <span className="block text-sm font-medium mb-1">Global prompt</span>
        <span className="block text-xs text-gray-500 dark:text-gray-400 mb-2">
          Prepended to every run across every project, before project instructions.
        </span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={10}
          className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="text-sm">Enable run-completion notifications</span>
      </label>

      <hr className="dark:border-gray-700" />

      <div className="space-y-4">
        <div>
          <h2 className="text-base font-semibold mb-0.5">Tools</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">Available in every run across all projects.</p>
        </div>

        <ChipInput
          label="Plugin marketplaces"
          values={marketplaces}
          onChange={setMarketplaces}
          placeholder="https://registry.example.com"
        />

        <ChipInput
          label="Plugins"
          values={plugins}
          onChange={setPlugins}
          placeholder="name@marketplace"
        />

        <div>
          <McpServerList projectId={null} label="MCP servers" />
        </div>
      </div>

      {error && <div className="text-red-600 text-sm">{error}</div>}
      {saved && <div className="text-green-600 text-sm">Saved.</div>}
      <button
        type="submit"
        disabled={saving}
        className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/pages/Settings.tsx
git commit -m "feat(ui): Settings page Tools section with ChipInput and McpServerList"
```

---

### Task 11: EditProject and NewProject — replace textareas with ChipInput + McpServerList

**Files:**
- Modify: `src/web/pages/EditProject.tsx`
- Modify: `src/web/pages/NewProject.tsx`

- [ ] **Step 1: Update `src/web/pages/EditProject.tsx`**

Add imports at the top:

```tsx
import { ChipInput } from '../components/ChipInput.js';
import { McpServerList } from '../components/McpServerList.js';
```

Replace the two `<Area>` fields for marketplaces and plugins with `<ChipInput>`:

```tsx
      <ChipInput
        label="Extra plugin marketplaces (merged with global defaults)"
        values={p.marketplaces}
        onChange={(v) => setP({ ...p, marketplaces: v })}
        placeholder="https://registry.example.com"
      />
      <ChipInput
        label="Extra plugins (merged with global defaults, format: name@marketplace)"
        values={p.plugins}
        onChange={(v) => setP({ ...p, plugins: v })}
        placeholder="name@marketplace"
      />
```

Add `McpServerList` after the plugins field (before the NumberField for memory):

```tsx
      <div>
        <span className="block text-sm font-medium mb-1">Additional MCP servers</span>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Added on top of global defaults for this project.</p>
        <McpServerList projectId={pid} />
      </div>
```

- [ ] **Step 2: Update `src/web/pages/NewProject.tsx`**

Add imports at the top:

```tsx
import { ChipInput } from '../components/ChipInput.js';
```

Replace the two `<Area>` fields for marketplaces and plugins in the form with `<ChipInput>`:

```tsx
      <ChipInput
        label="Extra plugin marketplaces (merged with global defaults)"
        values={marketplaces}
        onChange={setMarketplaces}
        placeholder="https://registry.example.com"
      />
      <ChipInput
        label="Extra plugins (merged with global defaults, format: name@marketplace)"
        values={plugins}
        onChange={setPlugins}
        placeholder="name@marketplace"
      />
```

Note: `McpServerList` is not included on NewProject because the project doesn't have an ID yet. MCPs can be added on the Edit page after creation. This matches the existing secrets pattern (also only available after creation).

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Build**

```bash
npm run build 2>&1 | tail -5
```

Expected: build succeeds, no `error during build`.

- [ ] **Step 6: Commit**

```bash
git add src/web/pages/EditProject.tsx src/web/pages/NewProject.tsx
git commit -m "feat(ui): replace textarea plugin fields with ChipInput; add McpServerList to EditProject"
```
