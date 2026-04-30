CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  global_prompt TEXT NOT NULL DEFAULT '',
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  concurrency_warn_at INTEGER NOT NULL DEFAULT 3,
  image_gc_enabled INTEGER NOT NULL DEFAULT 0,
  last_gc_at INTEGER,
  last_gc_count INTEGER,
  last_gc_bytes INTEGER,
  global_marketplaces_json TEXT NOT NULL DEFAULT '[]',
  global_plugins_json TEXT NOT NULL DEFAULT '[]',
  auto_resume_enabled INTEGER NOT NULL DEFAULT 1,
  auto_resume_max_attempts INTEGER NOT NULL DEFAULT 5,
  usage_notifications_enabled INTEGER NOT NULL DEFAULT 0,
  tokens_total_recomputed_at INTEGER,
  updated_at INTEGER NOT NULL
);
