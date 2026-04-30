-- Prevent rowid reuse on the runs table.
--
-- Without AUTOINCREMENT, SQLite reuses the rowid of the highest-deleted
-- row. When an e2e test calls run.destroy() (DELETE /api/runs/N) and the
-- next test creates a fresh run, the new run can land on the same id N.
-- The old run's actor is still alive in `Waiting` phase (the test page's
-- WS connection kept listener_count > 0), and when its container_monitor
-- finally reports ContainerExited, the actor calls
-- mark_finished(db, state.run_id, ...) — updating the *new* run's row
-- with the *old* run's outcome. That's the e2e hang/auto-scroll/snapshot
-- "succeeded" flake: a successful prior test (default, env-echo, …)
-- leaks state="succeeded" into a hang test.
--
-- With AUTOINCREMENT, ids strictly grow, the old actor's UPDATE matches
-- no row, and the leak becomes a harmless no-op.
--
-- SQLite doesn't support ALTER TABLE … ADD AUTOINCREMENT, so we
-- rebuild via the canonical pattern: create new table, copy rows, drop
-- old, rename. Foreign key references inside the table are rewritten to
-- the post-rename name automatically by ALTER TABLE … RENAME (this is
-- why the parent_run_id self-reference points at runs_new — it gets
-- renamed alongside).
CREATE TABLE runs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at INTEGER NOT NULL,
  state_entered_at INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  effort TEXT,
  subagent_model TEXT,
  resume_attempts INTEGER NOT NULL DEFAULT 0,
  next_resume_at INTEGER,
  claude_session_id TEXT,
  last_limit_reset_at INTEGER,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_create INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  usage_parse_errors INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  title_locked INTEGER NOT NULL DEFAULT 0,
  parent_run_id INTEGER REFERENCES runs_new(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'work',
  kind_args_json TEXT,
  mirror_status TEXT,
  mock INTEGER NOT NULL DEFAULT 0,
  mock_scenario TEXT
);

INSERT INTO runs_new
  SELECT
    id, project_id, prompt, branch_name, state, container_id, log_path,
    exit_code, error, head_commit, started_at, finished_at, created_at,
    state_entered_at, model, effort, subagent_model, resume_attempts,
    next_resume_at, claude_session_id, last_limit_reset_at, tokens_input,
    tokens_output, tokens_cache_read, tokens_cache_create, tokens_total,
    usage_parse_errors, title, title_locked, parent_run_id, kind,
    kind_args_json, mirror_status, mock, mock_scenario
  FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

-- Seed sqlite_sequence so the next auto-id is max(existing id)+1, not 1.
-- sqlite_sequence has no unique constraint on name, so INSERT OR REPLACE
-- doesn't dedupe — DELETE first then INSERT to avoid duplicate rows
-- (which AUTOINCREMENT tolerates but is messy). For a fresh DB with no
-- prior rows, MAX(id) is NULL → 0, next auto-id is 1.
DELETE FROM sqlite_sequence WHERE name = 'runs';
INSERT INTO sqlite_sequence (name, seq)
  VALUES ('runs', COALESCE((SELECT MAX(id) FROM runs), 0));

CREATE INDEX idx_runs_project ON runs (project_id);
CREATE INDEX idx_runs_state ON runs (state);
CREATE INDEX idx_runs_parent ON runs (parent_run_id);
