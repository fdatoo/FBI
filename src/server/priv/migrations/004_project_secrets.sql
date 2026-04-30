CREATE TABLE project_secrets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_secrets_name ON project_secrets (project_id, name);
