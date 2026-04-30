CREATE TABLE mcp_servers (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('stdio','sse')),
  command TEXT,
  args_json TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  env_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_mcp_servers_project_name ON mcp_servers (project_id, name);
CREATE UNIQUE INDEX idx_mcp_servers_global_name ON mcp_servers (name) WHERE project_id IS NULL;
