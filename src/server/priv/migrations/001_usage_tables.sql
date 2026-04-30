CREATE TABLE run_usage_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_create_tokens INTEGER NOT NULL,
  rl_requests_remaining INTEGER,
  rl_requests_limit INTEGER,
  rl_tokens_remaining INTEGER,
  rl_tokens_limit INTEGER,
  rl_reset_at INTEGER
);
CREATE INDEX idx_run_usage_events_run ON run_usage_events (run_id, ts);
CREATE INDEX idx_run_usage_events_ts ON run_usage_events (ts);

CREATE TABLE rate_limit_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  plan TEXT,
  observed_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER
);

CREATE TABLE rate_limit_buckets (
  bucket_id TEXT PRIMARY KEY,
  utilization REAL NOT NULL,
  reset_at INTEGER,
  window_started_at INTEGER,
  last_notified_threshold INTEGER,
  last_notified_reset_at INTEGER,
  observed_at INTEGER NOT NULL
);
