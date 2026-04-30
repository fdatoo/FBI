CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  devcontainer_override_json TEXT,
  instructions TEXT,
  git_author_name TEXT,
  git_author_email TEXT,
  marketplaces_json TEXT NOT NULL DEFAULT '[]',
  plugins_json TEXT NOT NULL DEFAULT '[]',
  mem_mb INTEGER,
  cpus REAL,
  pids_limit INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_projects_name ON projects (name);
