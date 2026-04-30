# MCP Management Design

## Goal

Replace the opaque string-based plugin/marketplace system with a first-class Tools management UI covering plugin marketplaces, Claude Code plugins, and MCP servers — all configurable globally and per-project through the FBI web interface.

## Background

Today, global plugins and marketplaces are configured via `FBI_DEFAULT_PLUGINS` and `FBI_DEFAULT_MARKETPLACES` environment variables. Per-project additions are stored as JSON blobs in the `projects` table. MCP servers are not supported at all — there is no way to inject `mcpServers` into the container's `.claude.json` through the UI.

## Design

### Data model

**`settings` table** gains two new columns:

```sql
ALTER TABLE settings ADD COLUMN global_marketplaces_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE settings ADD COLUMN global_plugins_json TEXT NOT NULL DEFAULT '[]';
```

These replace `FBI_DEFAULT_MARKETPLACES` / `FBI_DEFAULT_PLUGINS`. On first startup after migration, if the env vars are set and the DB columns are still empty, values are automatically migrated into the DB so existing deployments lose nothing.

**New `mcp_servers` table:**

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  -- NULL = global; non-null = per-project addition
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('stdio', 'sse')),
  command TEXT,              -- stdio only: executable (e.g. 'npx')
  args_json TEXT NOT NULL DEFAULT '[]',  -- stdio only: args array
  url TEXT,                  -- sse only: server URL
  env_json TEXT NOT NULL DEFAULT '{}',
  -- env values may be literal strings or '$SECRET_NAME' references
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);
```

`env_json` values may be literal strings (`"my-value"`) or secret references (`"$GITHUB_TOKEN"`). The orchestrator resolves references against the project's decrypted secrets at run time.

### API

Follows existing REST patterns in the codebase.

**Global MCP servers:**
```
GET    /api/mcp-servers
POST   /api/mcp-servers
PATCH  /api/mcp-servers/:id
DELETE /api/mcp-servers/:id
```

**Per-project MCP servers** (returns only the project's own additions, not globals):
```
GET    /api/projects/:id/mcp-servers
POST   /api/projects/:id/mcp-servers
PATCH  /api/projects/:id/mcp-servers/:sid
DELETE /api/projects/:id/mcp-servers/:sid
```

**Global plugins/marketplaces** — folded into the existing `PATCH /api/settings` endpoint as two new optional fields: `global_plugins` (`string[]`) and `global_marketplaces` (`string[]`). `GET /api/settings` is extended to return these fields.

### Orchestrator changes

`launch()` in `src/server/orchestrator/index.ts`:

1. **Plugins/marketplaces** — reads `settings.global_plugins` and `settings.global_marketplaces` from the DB instead of `config.defaultPlugins` / `config.defaultMarketplaces`. Per-project additions merge on top with `uniq()` as today. Values are passed to the container as `FBI_PLUGINS` / `FBI_MARKETPLACES` env vars in the same newline-separated format — supervisor.sh is unchanged.

2. **MCP injection** — queries `mcp_servers` for globals (`project_id IS NULL`) and per-project entries, merges them (per-project wins on name collision), resolves `$SECRET_NAME` references against decrypted project secrets, and writes the resulting `mcpServers` object into the `.claude.json` injected via `injectFiles`. Uses the existing `sanitizedClaudeJson` path: the `mcpServers` key is added to the JSON object before serialisation.

3. **Config cleanup** — `defaultPlugins` and `defaultMarketplaces` are removed from `Config` and the corresponding env vars deprecated. Startup migration (step 1 in Data model above) handles existing deployments.

The `mcpServers` entry written to `.claude.json` follows the Claude Code format:

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "<resolved-value>" }
    },
    "my-sse-server": {
      "type": "sse",
      "url": "https://my-server.example.com/sse"
    }
  }
}
```

### Frontend

**Settings page** — existing global prompt section gains a "Tools" section below it with three parts:

- **Plugin marketplaces** — tag-chip input (type + Enter to add, click × to remove). Replaces textarea.
- **Plugins** — tag-chip input in `name@marketplace` format. Replaces textarea.
- **MCP servers** — structured list (name, type, command summary, env var count) with "Edit" and remove controls per row. Two add buttons: "From catalog" and "Add custom".

**Edit Project / New Project pages** — identical "Tools" section but labelled "Additional tools (added on top of global defaults)". Same three components.

**Catalog** — static `CATALOG` const in the frontend (no API). Each entry has: `name`, `description`, `emoji`, `type`, `command`, `args`, and `requiredEnv` (array of key names that get pre-populated as empty rows in the env table). Clicking "Add" pre-fills the add form. Initial catalog:

| Name | Description |
|---|---|
| fetch | HTTP requests |
| github | GitHub API (requires `GITHUB_TOKEN`) |
| postgres | Query Postgres (requires `POSTGRES_CONNECTION_STRING`) |
| puppeteer | Headless browser |
| sequential-thinking | Structured reasoning |
| brave-search | Web search (requires `BRAVE_API_KEY`) |
| memory | Persistent memory across runs |

**MCP add/edit form** — modal or inline panel with: name (text), type (radio: stdio/sse), command (text, stdio only), args (textarea, one per line, stdio only), URL (text, sse only), env vars (key/value table with add/remove rows; value field accepts literal string or `$SECRET_NAME`).

### Shared types

`McpServer` type added to `src/shared/types.ts`:

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

`Project` and `Settings` types extended with the new fields.

### Deprecation of env vars

`FBI_DEFAULT_PLUGINS` and `FBI_DEFAULT_MARKETPLACES` are deprecated but not removed. On startup, if either is set and the corresponding DB column is empty, the value is migrated into the DB and a deprecation warning is logged. The env vars are ignored once the DB columns have values.

## What is not in scope

- Disabling a global tool at the project level (additive model only)
- Tool connectivity validation before saving
- Per-run tool override (tools are configured at project/global level only)
- Authentication flows for MCP servers beyond env var injection
