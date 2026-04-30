# Gleam Server — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gleam server's non-orchestration layer — config, DB, HTTP routing, static serving, and all CRUD endpoints (projects, settings, MCP servers, secrets, runs read-only, usage) — deployable and testable independently of Docker/orchestration.

**Architecture:** Pure Gleam project (`gleam.toml`) at `src/server-gleam/`. Wisp handles HTTP; sqlight handles SQLite; gleam_otp handles supervision. The Elixir server at `src/server/` is left untouched; cutover happens in Plan 3. Run create/start/stop endpoints return 501 until Plan 2.

**Tech Stack:** Gleam 1.9+, Wisp, Mist, sqlight, gleam_json, gleam_otp, gleeunit

---

## File Map

```
src/server-gleam/
  gleam.toml
  Makefile
  erlang/
    fbi_crypto.erl           ← AES-256-GCM wrapper (needed for secrets)
    fbi_term_nif.erl         ← NIF stub (Plan 2 activates; stub prevents missing-module crash)
  src/
    fbi.gleam                ← entry: load config → run migrations → start Mist
    fbi/
      config.gleam           ← Config type + load() from env
      context.gleam          ← Context(db, config) threaded through handlers
      router.gleam           ← Wisp path-segment router
      crypto.gleam           ← encrypt/decrypt via fbi_crypto.erl FFI
      db/
        connection.gleam     ← open sqlight.Connection + helpers
        migrations.gleam     ← run numbered SQL files at startup
        projects.gleam       ← projects table CRUD
        runs.gleam           ← runs table: list/get/patch_title/delete (no create)
        settings.gleam       ← settings singleton: get/patch
        mcp_servers.gleam    ← mcp_servers: global + project-scoped CRUD
        secrets.gleam        ← project_secrets: list/put/delete + encrypt/decrypt
        usage.gleam          ← run_usage_events + rate_limit_state reads
      handlers/
        health.gleam         ← GET /api/health
        projects.gleam       ← /api/projects CRUD
        runs.gleam           ← /api/runs and /api/projects/:id/runs (read + patch)
        settings.gleam       ← /api/settings GET + PATCH
        mcp_servers.gleam    ← /api/mcp-servers and /api/projects/:id/mcp-servers
        secrets.gleam        ← /api/projects/:id/secrets
        usage.gleam          ← /api/usage and /api/usage/daily
        static.gleam         ← SPA index.html + static file serving
      json/
        run.gleam            ← Run → gleam_json Json
        project.gleam        ← Project → Json
        settings.gleam       ← Settings → Json
        mcp_server.gleam     ← McpServer → Json
        usage.gleam          ← usage snapshot → Json
  priv/
    migrations/
      001_usage_tables.sql
      002_settings.sql
      003_projects.sql
      004_project_secrets.sql
      005_mcp_servers.sql
      006_runs.sql
      007_runs_orchestrator_cols.sql
      008_runs_mock_cols.sql
  test/
    fbi_test.gleam           ← gleeunit entry
    fbi/
      config_test.gleam
      crypto_test.gleam
      db/
        migrations_test.gleam
        projects_test.gleam
        runs_test.gleam
        settings_test.gleam
        mcp_servers_test.gleam
        secrets_test.gleam
      json/
        run_test.gleam
        project_test.gleam
```

---

### Task 1: Scaffold the Gleam project

**Files:**
- Create: `src/server-gleam/gleam.toml`
- Create: `src/server-gleam/Makefile`
- Create: `src/server-gleam/src/fbi.gleam`
- Create: `src/server-gleam/test/fbi_test.gleam`
- Create: `src/server-gleam/erlang/fbi_term_nif.erl`
- Create: `src/server-gleam/erlang/fbi_crypto.erl`

- [ ] **Step 1: Create `src/server-gleam/gleam.toml`**

```toml
name = "fbi"
version = "0.1.0"
target = "erlang"

[dependencies]
gleam_stdlib  = ">= 0.34.0 and < 2.0.0"
gleam_http    = ">= 3.6.0 and < 5.0.0"
gleam_json    = ">= 2.0.0 and < 4.0.0"
gleam_otp     = ">= 0.10.0 and < 2.0.0"
wisp          = ">= 1.0.0 and < 5.0.0"
mist          = ">= 3.0.0 and < 6.0.0"
sqlight       = ">= 1.0.0 and < 3.0.0"

[dev-dependencies]
gleeunit = ">= 1.0.0 and < 2.0.0"
```

- [ ] **Step 2: Create `src/server-gleam/erlang/fbi_term_nif.erl`** (stub — Plan 2 provides the real .so)

```erlang
-module(fbi_term_nif).
-export([new_state/2, feed/2, snapshot/1, snapshot_at/2, resize/3]).

new_state(_, _)  -> {error, nif_not_loaded}.
feed(_, _)       -> {error, nif_not_loaded}.
snapshot(_)      -> {error, nif_not_loaded}.
snapshot_at(_, _)-> {error, nif_not_loaded}.
resize(_, _, _)  -> {error, nif_not_loaded}.
```

- [ ] **Step 3: Create `src/server-gleam/erlang/fbi_crypto.erl`**

```erlang
-module(fbi_crypto).
-export([encrypt/3, decrypt/3]).

%% encrypt(Key, PlainText, AAD) -> {ok, <<IV(12), CipherText, Tag(16)>>}
encrypt(Key, PlainText, AAD) ->
    IV = crypto:strong_rand_bytes(12),
    {CipherText, Tag} = crypto:crypto_one_time_aead(aes_256_gcm, Key, IV, PlainText, AAD, 16, true),
    {ok, <<IV:12/binary, CipherText/binary, Tag:16/binary>>}.

%% decrypt(Key, Blob, AAD) -> {ok, PlainText} | {error, decryption_failed}
decrypt(Key, Blob, AAD) ->
    IVSize = 12,
    TagSize = 16,
    BlobSize = byte_size(Blob),
    CipherSize = BlobSize - IVSize - TagSize,
    <<IV:IVSize/binary, CipherText:CipherSize/binary, Tag:TagSize/binary>> = Blob,
    case crypto:crypto_one_time_aead(aes_256_gcm, Key, IV, CipherText, AAD, Tag, false) of
        error     -> {error, decryption_failed};
        PlainText -> {ok, PlainText}
    end.
```

- [ ] **Step 4: Create `src/server-gleam/src/fbi.gleam`** (minimal — wires up config + server start)

```gleam
import fbi/config
import gleam/erlang/process
import gleam/io
import mist
import wisp

pub fn main() {
  wisp.configure_logger()

  let cfg = case config.load() {
    Ok(c) -> c
    Error(reason) -> {
      io.println("ERROR: " <> reason)
      panic as "missing required configuration"
    }
  }

  let assert Ok(_) =
    wisp.mist_handler(fn(req) { wisp.not_found() }, cfg.secret_key)
    |> mist.new()
    |> mist.port(cfg.port)
    |> mist.start_http()

  process.sleep_forever()
}
```

- [ ] **Step 5: Create `src/server-gleam/test/fbi_test.gleam`**

```gleam
import gleeunit

pub fn main() {
  gleeunit.main()
}
```

- [ ] **Step 6: Download deps and verify it compiles**

```bash
cd src/server-gleam
gleam deps download
gleam build
```

Expected: build completes with no errors (may warn about unused imports — that's fine).

- [ ] **Step 7: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): scaffold Gleam server project"
```

---

### Task 2: Config module

**Files:**
- Create: `src/server-gleam/src/fbi/config.gleam`
- Create: `src/server-gleam/test/fbi/config_test.gleam`

- [ ] **Step 1: Write the failing test**

```gleam
// test/fbi/config_test.gleam
import fbi/config
import gleeunit/should
import gleam/option

pub fn load_uses_defaults_test() {
  // PORT defaults to 3000 when unset
  let result = config.env_int("FBI_TEST_NONEXISTENT_PORT_VAR", 3000)
  result |> should.equal(Ok(3000))
}

pub fn load_required_missing_test() {
  let result = config.env_required("FBI_TEST_NONEXISTENT_REQUIRED_VAR")
  result |> should.be_error()
}
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd src/server-gleam && gleam test
```

Expected: compilation error (config module does not exist yet).

- [ ] **Step 3: Implement `src/server-gleam/src/fbi/config.gleam`**

```gleam
import gleam/erlang/os
import gleam/int
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string

pub type Config {
  Config(
    port: Int,
    secret_key: String,
    database_path: String,
    runs_dir: String,
    git_author_name: String,
    git_author_email: String,
    web_dist_dir: Option(String),
    docker_socket: String,
    docker_gid: Option(Int),
    ssh_auth_sock: Option(String),
    claude_dir: Option(String),
    secrets_key: BitArray,
    default_plugins: List(String),
  )
}

pub fn load() -> Result(Config, String) {
  use port <- result.try(env_int("PORT", 3000))
  use db_path <- result.try(env_required("DATABASE_PATH"))
  use runs_dir <- result.try(env_required("RUNS_DIR"))
  use author_name <- result.try(env_required("GIT_AUTHOR_NAME"))
  use author_email <- result.try(env_required("GIT_AUTHOR_EMAIL"))
  use key <- result.try(load_secrets_key())
  let web_dist_dir = env_optional("WEB_DIST_DIR")
  let docker_socket =
    os.get_env("DOCKER_SOCKET") |> result.unwrap("/var/run/docker.sock")
  let docker_gid =
    env_optional("HOST_DOCKER_GID")
    |> option.then(fn(s) {
      int.parse(s) |> result.map(Some) |> result.unwrap(None)
    })
  let ssh_auth_sock = env_optional("HOST_SSH_AUTH_SOCK")
  let claude_dir = env_optional("HOST_CLAUDE_DIR")
  let default_plugins =
    os.get_env("FBI_DEFAULT_PLUGINS")
    |> result.unwrap("")
    |> string.split("\n")
    |> list.filter(fn(s) { s != "" })
  let secret_key =
    os.get_env("SECRET_KEY_BASE") |> result.unwrap("dev-secret-key-base-32chars")
  Ok(Config(
    port: port,
    secret_key: secret_key,
    database_path: db_path,
    runs_dir: runs_dir,
    git_author_name: author_name,
    git_author_email: author_email,
    web_dist_dir: web_dist_dir,
    docker_socket: docker_socket,
    docker_gid: docker_gid,
    ssh_auth_sock: ssh_auth_sock,
    claude_dir: claude_dir,
    secrets_key: key,
    default_plugins: default_plugins,
  ))
}

pub fn env_required(name: String) -> Result(String, String) {
  os.get_env(name) |> result.map_error(fn(_) { name <> " is required" })
}

pub fn env_int(name: String, default: Int) -> Result(Int, String) {
  case os.get_env(name) {
    Error(_) -> Ok(default)
    Ok(s) ->
      int.parse(s) |> result.map_error(fn(_) { name <> " must be an integer" })
  }
}

pub fn env_optional(name: String) -> Option(String) {
  os.get_env(name) |> option.from_result
}

fn load_secrets_key() -> Result(BitArray, String) {
  use path <- result.try(
    os.get_env("SECRETS_KEY_FILE")
    |> result.map_error(fn(_) { "SECRETS_KEY_FILE is required" }),
  )
  case simplifile.read_bits(path) {
    Ok(bits) if bit_array.byte_size(bits) == 32 -> Ok(bits)
    Ok(_) -> Error("SECRETS_KEY_FILE must contain exactly 32 bytes")
    Error(_) -> Error("Cannot read SECRETS_KEY_FILE: " <> path)
  }
}
```

Add `simplifile` to `gleam.toml` dependencies:
```toml
simplifile = ">= 2.0.0 and < 4.0.0"
```

Run `gleam deps download` again after editing `gleam.toml`.

- [ ] **Step 4: Fix the import in config.gleam** — add missing imports at top:

```gleam
import gleam/list
import gleam/bit_array
import simplifile
```

- [ ] **Step 5: Run tests — verify passing**

```bash
cd src/server-gleam && gleam test
```

Expected: `load_uses_defaults_test` and `load_required_missing_test` both pass.

- [ ] **Step 6: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): config module with typed Config and env loading"
```

---

### Task 3: DB connection + context + migration runner

**Files:**
- Create: `src/server-gleam/src/fbi/db/connection.gleam`
- Create: `src/server-gleam/src/fbi/db/migrations.gleam`
- Create: `src/server-gleam/src/fbi/context.gleam`
- Create: `src/server-gleam/test/fbi/db/migrations_test.gleam`

- [ ] **Step 1: Write the failing test**

```gleam
// test/fbi/db/migrations_test.gleam
import fbi/db/connection
import fbi/db/migrations
import gleeunit/should
import sqlight

pub fn migrations_run_idempotent_test() {
  let assert Ok(db) = sqlight.open(":memory:")
  migrations.run(db) |> should.be_ok()
  // running a second time should not error (already applied)
  migrations.run(db) |> should.be_ok()
  sqlight.close(db)
}

pub fn migrations_create_projects_table_test() {
  let assert Ok(db) = sqlight.open(":memory:")
  let assert Ok(_) = migrations.run(db)
  // if migrations ran, we can query the projects table
  let result =
    sqlight.query("SELECT count(*) FROM projects", on: db, with: [], expecting: sqlight.decode_int)
  result |> should.be_ok()
  sqlight.close(db)
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd src/server-gleam && gleam test
```

Expected: compilation error — `fbi/db/connection` and `fbi/db/migrations` don't exist.

- [ ] **Step 3: Create `src/server-gleam/src/fbi/db/connection.gleam`**

```gleam
import gleam/result
import sqlight

pub type DbError {
  SqlightError(sqlight.Error)
  NotFound
  MultipleRows
}

pub fn open(path: String) -> Result(sqlight.Connection, String) {
  sqlight.open(path)
  |> result.map_error(fn(e) { "Cannot open database: " <> sqlight.error_message(e) })
}

pub fn close(db: sqlight.Connection) -> Nil {
  sqlight.close(db)
}

pub fn query_one(
  sql: String,
  db: sqlight.Connection,
  args: List(sqlight.Value),
  decoder: sqlight.Decoder(a),
) -> Result(a, DbError) {
  sqlight.query(sql, on: db, with: args, expecting: decoder)
  |> result.map_error(SqlightError)
  |> result.then(fn(rows) {
    case rows {
      [row] -> Ok(row)
      [] -> Error(NotFound)
      _ -> Error(MultipleRows)
    }
  })
}

pub fn query_all(
  sql: String,
  db: sqlight.Connection,
  args: List(sqlight.Value),
  decoder: sqlight.Decoder(a),
) -> Result(List(a), DbError) {
  sqlight.query(sql, on: db, with: args, expecting: decoder)
  |> result.map_error(SqlightError)
}

pub fn exec(
  sql: String,
  db: sqlight.Connection,
) -> Result(Nil, DbError) {
  sqlight.exec(sql, on: db)
  |> result.map_error(SqlightError)
}
```

- [ ] **Step 4: Create `src/server-gleam/src/fbi/db/migrations.gleam`**

```gleam
import fbi/db/connection.{type DbError}
import gleam/int
import gleam/io
import gleam/list
import gleam/result
import gleam/string
import simplifile
import sqlight

pub fn run(db: sqlight.Connection) -> Result(Nil, DbError) {
  use _ <- result.try(create_schema_migrations(db))
  let assert Ok(files) = simplifile.read_directory("priv/migrations")
  let sql_files =
    files
    |> list.filter(fn(f) { string.ends_with(f, ".sql") })
    |> list.sort(string.compare)
  list.try_each(sql_files, fn(filename) {
    apply_migration(db, filename)
  })
}

fn create_schema_migrations(db: sqlight.Connection) -> Result(Nil, DbError) {
  connection.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )",
    db,
  )
}

fn apply_migration(
  db: sqlight.Connection,
  filename: String,
) -> Result(Nil, DbError) {
  let already_applied =
    sqlight.query(
      "SELECT 1 FROM schema_migrations WHERE filename = ?",
      on: db,
      with: [sqlight.text(filename)],
      expecting: sqlight.decode_int,
    )
    |> result.map(fn(rows) { rows != [] })
    |> result.unwrap(False)

  case already_applied {
    True -> Ok(Nil)
    False -> {
      let path = "priv/migrations/" <> filename
      let assert Ok(sql) = simplifile.read(path)
      io.println("Running migration: " <> filename)
      use _ <- result.try(connection.exec(sql, db))
      sqlight.exec(
        "INSERT INTO schema_migrations (filename, applied_at) VALUES (?, unixepoch() * 1000)",
        on: db,
        with: [sqlight.text(filename)],
      )
      |> result.map_error(connection.SqlightError)
    }
  }
}
```

- [ ] **Step 5: Create `src/server-gleam/src/fbi/context.gleam`**

```gleam
import fbi/config.{type Config}
import sqlight

pub type Context {
  Context(db: sqlight.Connection, config: Config)
}
```

- [ ] **Step 6: Run tests**

```bash
cd src/server-gleam && gleam test
```

Expected: migration tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): DB connection helpers, migration runner, Context type"
```

---

### Task 4: SQL migration files

**Files:**
- Create: `src/server-gleam/priv/migrations/001_usage_tables.sql` through `008_runs_mock_cols.sql`

- [ ] **Step 1: Create all 8 SQL migration files**

`priv/migrations/001_usage_tables.sql`:
```sql
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
```

`priv/migrations/002_settings.sql`:
```sql
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
```

`priv/migrations/003_projects.sql`:
```sql
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
```

`priv/migrations/004_project_secrets.sql`:
```sql
CREATE TABLE project_secrets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_secrets_name ON project_secrets (project_id, name);
```

`priv/migrations/005_mcp_servers.sql`:
```sql
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
```

`priv/migrations/006_runs.sql`:
```sql
CREATE TABLE runs (
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
  parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL
);
CREATE INDEX idx_runs_project ON runs (project_id);
CREATE INDEX idx_runs_state ON runs (state);
CREATE INDEX idx_runs_parent ON runs (parent_run_id);
```

`priv/migrations/007_runs_orchestrator_cols.sql`:
```sql
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
ALTER TABLE runs ADD COLUMN kind_args_json TEXT;
ALTER TABLE runs ADD COLUMN mirror_status TEXT;
```

`priv/migrations/008_runs_mock_cols.sql`:
```sql
ALTER TABLE runs ADD COLUMN mock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN mock_scenario TEXT;
```

- [ ] **Step 2: Run the migration test**

```bash
cd src/server-gleam && gleam test
```

Expected: `migrations_create_projects_table_test` passes (confirms SQL is valid SQLite).

- [ ] **Step 3: Commit**

```bash
git add src/server-gleam/priv/
git commit -m "feat(gleam): SQL migration files for all 8 tables"
```

---

### Task 5: HTTP router + health endpoint

**Files:**
- Create: `src/server-gleam/src/fbi/router.gleam`
- Create: `src/server-gleam/src/fbi/handlers/health.gleam`
- Create: `src/server-gleam/src/fbi/handlers/static.gleam`
- Modify: `src/server-gleam/src/fbi.gleam`

- [ ] **Step 1: Create `src/server-gleam/src/fbi/handlers/health.gleam`**

```gleam
import gleam/json
import wisp.{type Request, type Response}

pub fn show(_req: Request) -> Response {
  json.object([#("status", json.string("ok"))])
  |> json.to_string()
  |> wisp.json_response(200)
}
```

- [ ] **Step 2: Create `src/server-gleam/src/fbi/handlers/static.gleam`**

```gleam
import fbi/context.{type Context}
import gleam/http
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import simplifile
import wisp.{type Request, type Response}

pub fn serve(req: Request, ctx: Context) -> Response {
  case ctx.config.web_dist_dir {
    None -> wisp.not_found()
    Some(dir) -> serve_from(req, dir)
  }
}

fn serve_from(req: Request, dir: String) -> Response {
  let segments = wisp.path_segments(req)
  let rel = string.join(segments, "/")

  cond_serve(req, dir, rel)
}

fn cond_serve(req: Request, dir: String, rel: String) -> Response {
  let full_path = dir <> "/" <> rel

  case rel, simplifile.is_file(full_path) {
    // exact file match
    _, Ok(True) -> stream_file(full_path)
    // SPA fallback: no extension + GET + accepts html
    path, _ if is_spa_route(req, path) -> {
      let index = dir <> "/index.html"
      case simplifile.is_file(index) {
        Ok(True) -> stream_file(index)
        _ -> wisp.not_found()
      }
    }
    _, _ -> wisp.not_found()
  }
}

fn is_spa_route(req: Request, rel: String) -> Bool {
  let basename =
    string.split(rel, "/")
    |> list.last()
    |> result.unwrap(rel)
  let no_extension = !string.contains(basename, ".")
  let is_get = req.method == http.Get
  no_extension && is_get
}

fn stream_file(path: String) -> Response {
  let content_type = mime_type(path)
  let assert Ok(bits) = simplifile.read_bits(path)
  wisp.response(200)
  |> wisp.set_header("content-type", content_type)
  |> wisp.set_body(wisp.Bytes(bits))
}

fn mime_type(path: String) -> String {
  case string.split(path, ".") |> list.last() |> result.unwrap("") {
    "html" -> "text/html; charset=utf-8"
    "js" | "mjs" -> "application/javascript"
    "css" -> "text/css"
    "json" -> "application/json"
    "png" -> "image/png"
    "svg" -> "image/svg+xml"
    "ico" -> "image/x-icon"
    "wasm" -> "application/wasm"
    _ -> "application/octet-stream"
  }
}
```

- [ ] **Step 3: Create `src/server-gleam/src/fbi/router.gleam`**

```gleam
import fbi/context.{type Context}
import fbi/handlers/health
import fbi/handlers/static as static_handler
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context) -> Response {
  use <- wisp.log_request(req)
  use <- wisp.rescue_crashes

  case wisp.path_segments(req) {
    // Health
    ["api", "health"] -> health.show(req)

    // Statics / SPA (catch-all — must be last)
    _ -> static_handler.serve(req, ctx)
  }
}
```

- [ ] **Step 4: Update `src/server-gleam/src/fbi.gleam`** to wire router + DB

```gleam
import fbi/config
import fbi/context.{Context}
import fbi/db/connection
import fbi/db/migrations
import fbi/router
import gleam/erlang/process
import gleam/io
import mist
import wisp

pub fn main() {
  wisp.configure_logger()

  let cfg = case config.load() {
    Ok(c) -> c
    Error(reason) -> {
      io.println("ERROR: " <> reason)
      panic as "missing required configuration"
    }
  }

  let assert Ok(db) = connection.open(cfg.database_path)
  let assert Ok(_) = migrations.run(db)

  let ctx = Context(db: db, config: cfg)

  let assert Ok(_) =
    wisp.mist_handler(fn(req) { router.handle(req, ctx) }, cfg.secret_key)
    |> mist.new()
    |> mist.port(cfg.port)
    |> mist.start_http()

  process.sleep_forever()
}
```

- [ ] **Step 5: Build + smoke test**

```bash
cd src/server-gleam && gleam build
```

Expected: no compilation errors.

Start the server with test env:

```bash
DATABASE_PATH=/tmp/fbi-gleam-test.db \
RUNS_DIR=/tmp/fbi-gleam-runs \
GIT_AUTHOR_NAME=Test \
GIT_AUTHOR_EMAIL=test@example.com \
SECRETS_KEY_FILE=<(head -c 32 /dev/urandom) \
gleam run
```

In another terminal:
```bash
curl -s http://localhost:3000/api/health
```

Expected: `{"status":"ok"}`

- [ ] **Step 6: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): HTTP router skeleton, health endpoint, SPA static serving"
```

---

### Task 6: Projects (DB layer + JSON + handlers)

**Files:**
- Create: `src/server-gleam/src/fbi/db/projects.gleam`
- Create: `src/server-gleam/src/fbi/json/project.gleam`
- Create: `src/server-gleam/src/fbi/handlers/projects.gleam`
- Create: `src/server-gleam/test/fbi/db/projects_test.gleam`
- Modify: `src/server-gleam/src/fbi/router.gleam`

- [ ] **Step 1: Write the failing test**

```gleam
// test/fbi/db/projects_test.gleam
import fbi/db/connection
import fbi/db/migrations
import fbi/db/projects
import gleeunit/should
import sqlight

fn test_db() -> sqlight.Connection {
  let assert Ok(db) = sqlight.open(":memory:")
  let assert Ok(_) = migrations.run(db)
  db
}

pub fn insert_and_get_test() {
  let db = test_db()
  let now = 1_700_000_000_000

  let assert Ok(project) =
    projects.insert(
      db,
      projects.NewProject(
        name: "test-project",
        repo_url: "https://github.com/test/test",
        default_branch: "main",
        devcontainer_override_json: None,
        instructions: None,
        git_author_name: None,
        git_author_email: None,
        marketplaces_json: "[]",
        plugins_json: "[]",
        mem_mb: None,
        cpus: None,
        pids_limit: None,
        created_at: now,
        updated_at: now,
      ),
    )

  project.name |> should.equal("test-project")
  project.repo_url |> should.equal("https://github.com/test/test")

  let assert Ok(fetched) = projects.get(db, project.id)
  fetched.id |> should.equal(project.id)

  sqlight.close(db)
}

pub fn list_returns_all_test() {
  let db = test_db()
  let now = 1_700_000_000_000
  let assert Ok(_) =
    projects.insert(db, projects.NewProject(name: "p1", repo_url: "url1", default_branch: "main",
      devcontainer_override_json: None, instructions: None, git_author_name: None,
      git_author_email: None, marketplaces_json: "[]", plugins_json: "[]",
      mem_mb: None, cpus: None, pids_limit: None, created_at: now, updated_at: now))
  let assert Ok(_) =
    projects.insert(db, projects.NewProject(name: "p2", repo_url: "url2", default_branch: "main",
      devcontainer_override_json: None, instructions: None, git_author_name: None,
      git_author_email: None, marketplaces_json: "[]", plugins_json: "[]",
      mem_mb: None, cpus: None, pids_limit: None, created_at: now, updated_at: now))
  let assert Ok(list) = projects.list(db)
  list.length(list) |> should.equal(2)
  sqlight.close(db)
}

pub fn delete_test() {
  let db = test_db()
  let now = 1_700_000_000_000
  let assert Ok(p) =
    projects.insert(db, projects.NewProject(name: "to-delete", repo_url: "url", default_branch: "main",
      devcontainer_override_json: None, instructions: None, git_author_name: None,
      git_author_email: None, marketplaces_json: "[]", plugins_json: "[]",
      mem_mb: None, cpus: None, pids_limit: None, created_at: now, updated_at: now))
  projects.delete(db, p.id) |> should.be_ok()
  projects.get(db, p.id) |> should.equal(Error(connection.NotFound))
  sqlight.close(db)
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd src/server-gleam && gleam test
```

Expected: compilation error.

- [ ] **Step 3: Create `src/server-gleam/src/fbi/db/projects.gleam`**

```gleam
import fbi/db/connection.{type DbError, NotFound, SqlightError}
import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import sqlight

pub type Project {
  Project(
    id: Int,
    name: String,
    repo_url: String,
    default_branch: String,
    devcontainer_override_json: Option(String),
    instructions: Option(String),
    git_author_name: Option(String),
    git_author_email: Option(String),
    marketplaces_json: String,
    plugins_json: String,
    mem_mb: Option(Int),
    cpus: Option(Float),
    pids_limit: Option(Int),
    created_at: Int,
    updated_at: Int,
  )
}

pub type NewProject {
  NewProject(
    name: String,
    repo_url: String,
    default_branch: String,
    devcontainer_override_json: Option(String),
    instructions: Option(String),
    git_author_name: Option(String),
    git_author_email: Option(String),
    marketplaces_json: String,
    plugins_json: String,
    mem_mb: Option(Int),
    cpus: Option(Float),
    pids_limit: Option(Int),
    created_at: Int,
    updated_at: Int,
  )
}

pub type PatchProject {
  PatchProject(
    name: Option(String),
    repo_url: Option(String),
    default_branch: Option(String),
    devcontainer_override_json: Option(Option(String)),
    instructions: Option(Option(String)),
    git_author_name: Option(Option(String)),
    git_author_email: Option(Option(String)),
    marketplaces_json: Option(String),
    plugins_json: Option(String),
    mem_mb: Option(Option(Int)),
    cpus: Option(Option(Float)),
    pids_limit: Option(Option(Int)),
  )
}

fn decoder() -> decode.Decoder(Project) {
  use id <- decode.field(0, decode.int)
  use name <- decode.field(1, decode.string)
  use repo_url <- decode.field(2, decode.string)
  use default_branch <- decode.field(3, decode.string)
  use devcontainer_override_json <- decode.field(4, decode.optional(decode.string))
  use instructions <- decode.field(5, decode.optional(decode.string))
  use git_author_name <- decode.field(6, decode.optional(decode.string))
  use git_author_email <- decode.field(7, decode.optional(decode.string))
  use marketplaces_json <- decode.field(8, decode.string)
  use plugins_json <- decode.field(9, decode.string)
  use mem_mb <- decode.field(10, decode.optional(decode.int))
  use cpus <- decode.field(11, decode.optional(decode.float))
  use pids_limit <- decode.field(12, decode.optional(decode.int))
  use created_at <- decode.field(13, decode.int)
  use updated_at <- decode.field(14, decode.int)
  decode.success(Project(
    id:, name:, repo_url:, default_branch:, devcontainer_override_json:,
    instructions:, git_author_name:, git_author_email:, marketplaces_json:,
    plugins_json:, mem_mb:, cpus:, pids_limit:, created_at:, updated_at:,
  ))
}

const select_all = "
  SELECT id, name, repo_url, default_branch,
         devcontainer_override_json, instructions,
         git_author_name, git_author_email,
         marketplaces_json, plugins_json,
         mem_mb, cpus, pids_limit,
         created_at, updated_at
  FROM projects"

pub fn list(db: sqlight.Connection) -> Result(List(Project), DbError) {
  connection.query_all(select_all <> " ORDER BY id", db, [], decoder())
}

pub fn get(db: sqlight.Connection, id: Int) -> Result(Project, DbError) {
  connection.query_one(select_all <> " WHERE id = ?", db, [sqlight.int(id)], decoder())
}

pub fn insert(db: sqlight.Connection, p: NewProject) -> Result(Project, DbError) {
  let sql =
    "INSERT INTO projects
       (name, repo_url, default_branch, devcontainer_override_json, instructions,
        git_author_name, git_author_email, marketplaces_json, plugins_json,
        mem_mb, cpus, pids_limit, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     RETURNING " <> columns()

  connection.query_one(
    sql, db,
    [
      sqlight.text(p.name),
      sqlight.text(p.repo_url),
      sqlight.text(p.default_branch),
      nullable_text(p.devcontainer_override_json),
      nullable_text(p.instructions),
      nullable_text(p.git_author_name),
      nullable_text(p.git_author_email),
      sqlight.text(p.marketplaces_json),
      sqlight.text(p.plugins_json),
      nullable_int(p.mem_mb),
      nullable_float(p.cpus),
      nullable_int(p.pids_limit),
      sqlight.int(p.created_at),
      sqlight.int(p.updated_at),
    ],
    decoder(),
  )
}

pub fn delete(db: sqlight.Connection, id: Int) -> Result(Nil, DbError) {
  sqlight.exec(
    "DELETE FROM projects WHERE id = ?",
    on: db,
    with: [sqlight.int(id)],
  )
  |> result.map_error(SqlightError)
}

pub fn update(
  db: sqlight.Connection,
  id: Int,
  p: PatchProject,
  now: Int,
) -> Result(Project, DbError) {
  // Build SET clause from provided fields only
  let sets = [
    #("name", option.map(p.name, fn(v) { sqlight.text(v) })),
    #("repo_url", option.map(p.repo_url, fn(v) { sqlight.text(v) })),
    #("default_branch", option.map(p.default_branch, fn(v) { sqlight.text(v) })),
    #("devcontainer_override_json", option.map(p.devcontainer_override_json, nullable_text)),
    #("instructions", option.map(p.instructions, nullable_text)),
    #("git_author_name", option.map(p.git_author_name, nullable_text)),
    #("git_author_email", option.map(p.git_author_email, nullable_text)),
    #("marketplaces_json", option.map(p.marketplaces_json, fn(v) { sqlight.text(v) })),
    #("plugins_json", option.map(p.plugins_json, fn(v) { sqlight.text(v) })),
    #("mem_mb", option.map(p.mem_mb, nullable_int)),
    #("cpus", option.map(p.cpus, nullable_float)),
    #("pids_limit", option.map(p.pids_limit, nullable_int)),
  ]
  |> list.filter_map(fn(pair) {
    case pair.1 {
      None -> None
      Some(val) -> Some(#(pair.0 <> " = ?", val))
    }
  })

  let set_clause = list.map(sets, fn(s) { s.0 }) |> string.join(", ")
  let args = list.map(sets, fn(s) { s.1 })

  let sql =
    "UPDATE projects SET " <> set_clause <> ", updated_at = ?"
    <> " WHERE id = ? RETURNING " <> columns()

  connection.query_one(
    sql, db,
    list.append(args, [sqlight.int(now), sqlight.int(id)]),
    decoder(),
  )
}

// helpers
fn columns() -> String {
  "id, name, repo_url, default_branch,
   devcontainer_override_json, instructions,
   git_author_name, git_author_email,
   marketplaces_json, plugins_json,
   mem_mb, cpus, pids_limit,
   created_at, updated_at"
}

fn nullable_text(opt: Option(String)) -> sqlight.Value {
  case opt {
    None -> sqlight.null()
    Some(v) -> sqlight.text(v)
  }
}

fn nullable_int(opt: Option(Int)) -> sqlight.Value {
  case opt {
    None -> sqlight.null()
    Some(v) -> sqlight.int(v)
  }
}

fn nullable_float(opt: Option(Float)) -> sqlight.Value {
  case opt {
    None -> sqlight.null()
    Some(v) -> sqlight.float(v)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/server-gleam && gleam test
```

Expected: all projects DB tests pass.

- [ ] **Step 5: Create `src/server-gleam/src/fbi/json/project.gleam`**

```gleam
import fbi/db/projects.{type Project}
import gleam/json
import gleam/option

pub fn encode(p: Project) -> json.Json {
  json.object([
    #("id", json.int(p.id)),
    #("name", json.string(p.name)),
    #("repo_url", json.string(p.repo_url)),
    #("default_branch", json.string(p.default_branch)),
    #("devcontainer_override_json", json.nullable(p.devcontainer_override_json, json.string)),
    #("instructions", json.nullable(p.instructions, json.string)),
    #("git_author_name", json.nullable(p.git_author_name, json.string)),
    #("git_author_email", json.nullable(p.git_author_email, json.string)),
    #("marketplaces_json", json.string(p.marketplaces_json)),
    #("plugins_json", json.string(p.plugins_json)),
    #("mem_mb", json.nullable(p.mem_mb, json.int)),
    #("cpus", json.nullable(p.cpus, json.float)),
    #("pids_limit", json.nullable(p.pids_limit, json.int)),
    #("created_at", json.int(p.created_at)),
    #("updated_at", json.int(p.updated_at)),
  ])
}
```

- [ ] **Step 6: Create `src/server-gleam/src/fbi/handlers/projects.gleam`**

```gleam
import fbi/context.{type Context}
import fbi/db/connection
import fbi/db/projects
import fbi/json/project as project_json
import gleam/dynamic/decode
import gleam/erlang/os
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import wisp.{type Request, type Response}

pub fn index(req: Request, ctx: Context) -> Response {
  use <- wisp.require_method(req, http.Get)
  case projects.list(ctx.db) {
    Ok(ps) ->
      json.array(ps, project_json.encode)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(_) -> wisp.internal_server_error()
  }
}

pub fn create(req: Request, ctx: Context) -> Response {
  use <- wisp.require_method(req, http.Post)
  use body <- wisp.require_json(req)

  let decoder = {
    use name <- decode.field("name", decode.string)
    use repo_url <- decode.field("repo_url", decode.string)
    use default_branch <- decode.optional_field("default_branch", "main", decode.string)
    use instructions <- decode.optional_field("instructions", None, decode.optional(decode.string))
    use git_author_name <- decode.optional_field("git_author_name", None, decode.optional(decode.string))
    use git_author_email <- decode.optional_field("git_author_email", None, decode.optional(decode.string))
    use marketplaces_json <- decode.optional_field("marketplaces_json", "[]", decode.string)
    use plugins_json <- decode.optional_field("plugins_json", "[]", decode.string)
    use mem_mb <- decode.optional_field("mem_mb", None, decode.optional(decode.int))
    use cpus <- decode.optional_field("cpus", None, decode.optional(decode.float))
    use pids_limit <- decode.optional_field("pids_limit", None, decode.optional(decode.int))
    decode.success(#(name, repo_url, default_branch, instructions, git_author_name,
      git_author_email, marketplaces_json, plugins_json, mem_mb, cpus, pids_limit))
  }

  case decode.run(body, decoder) {
    Error(_) -> wisp.bad_request()
    Ok(#(name, repo_url, default_branch, instructions, git_author_name,
         git_author_email, marketplaces_json, plugins_json, mem_mb, cpus, pids_limit)) -> {
      let now = now_ms()
      let new_project = projects.NewProject(
        name: name, repo_url: repo_url, default_branch: default_branch,
        devcontainer_override_json: None, instructions: instructions,
        git_author_name: git_author_name, git_author_email: git_author_email,
        marketplaces_json: marketplaces_json, plugins_json: plugins_json,
        mem_mb: mem_mb, cpus: cpus, pids_limit: pids_limit,
        created_at: now, updated_at: now,
      )
      case projects.insert(ctx.db, new_project) {
        Ok(p) ->
          project_json.encode(p)
          |> json.to_string()
          |> wisp.json_response(201)
        Error(_) -> wisp.internal_server_error()
      }
    }
  }
}

pub fn show(req: Request, ctx: Context, id_str: String) -> Response {
  use <- wisp.require_method(req, http.Get)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request()
    Ok(id) ->
      case projects.get(ctx.db, id) {
        Ok(p) ->
          project_json.encode(p)
          |> json.to_string()
          |> wisp.json_response(200)
        Error(connection.NotFound) -> wisp.not_found()
        Error(_) -> wisp.internal_server_error()
      }
  }
}

pub fn update(req: Request, ctx: Context, id_str: String) -> Response {
  use <- wisp.require_method(req, http.Patch)
  use body <- wisp.require_json(req)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request()
    Ok(id) -> {
      let decoder = {
        use name <- decode.optional_field("name", None, decode.optional(decode.string))
        use repo_url <- decode.optional_field("repo_url", None, decode.optional(decode.string))
        use default_branch <- decode.optional_field("default_branch", None, decode.optional(decode.string))
        use instructions <- decode.optional_field("instructions", None, decode.optional(decode.optional(decode.string)))
        use git_author_name <- decode.optional_field("git_author_name", None, decode.optional(decode.optional(decode.string)))
        use git_author_email <- decode.optional_field("git_author_email", None, decode.optional(decode.optional(decode.string)))
        use marketplaces_json <- decode.optional_field("marketplaces_json", None, decode.optional(decode.string))
        use plugins_json <- decode.optional_field("plugins_json", None, decode.optional(decode.string))
        use mem_mb <- decode.optional_field("mem_mb", None, decode.optional(decode.optional(decode.int)))
        use cpus <- decode.optional_field("cpus", None, decode.optional(decode.optional(decode.float)))
        use pids_limit <- decode.optional_field("pids_limit", None, decode.optional(decode.optional(decode.int)))
        decode.success(projects.PatchProject(
          name: option.flatten(name), repo_url: option.flatten(repo_url),
          default_branch: option.flatten(default_branch),
          devcontainer_override_json: instructions,
          instructions: instructions,
          git_author_name: git_author_name,
          git_author_email: git_author_email,
          marketplaces_json: option.flatten(marketplaces_json),
          plugins_json: option.flatten(plugins_json),
          mem_mb: mem_mb, cpus: cpus, pids_limit: pids_limit,
        ))
      }
      case decode.run(body, decoder) {
        Error(_) -> wisp.bad_request()
        Ok(patch) ->
          case projects.update(ctx.db, id, patch, now_ms()) {
            Ok(p) ->
              project_json.encode(p)
              |> json.to_string()
              |> wisp.json_response(200)
            Error(connection.NotFound) -> wisp.not_found()
            Error(_) -> wisp.internal_server_error()
          }
      }
    }
  }
}

pub fn delete(req: Request, ctx: Context, id_str: String) -> Response {
  use <- wisp.require_method(req, http.Delete)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request()
    Ok(id) ->
      case projects.delete(ctx.db, id) {
        Ok(_) -> wisp.response(204)
        Error(connection.NotFound) -> wisp.not_found()
        Error(_) -> wisp.internal_server_error()
      }
  }
}

fn now_ms() -> Int {
  // erlang:system_time(millisecond)
  erlang_system_time_ms()
}

@external(erlang, "erlang", "system_time")
fn erlang_system_time_ms() -> Int
```

Note: `erlang:system_time/1` takes an atom argument. Use a wrapper function:

```gleam
// Replace the erlang_system_time_ms call with:
fn now_ms() -> Int {
  now_ms_ffi()
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms_ffi() -> Int
```

Create `src/server-gleam/erlang/fbi_time.erl`:
```erlang
-module(fbi_time).
-export([now_ms/0]).

now_ms() -> erlang:system_time(millisecond).
```

- [ ] **Step 7: Add project routes to router**

```gleam
// In router.gleam, add to the case:
["api", "projects"] -> projects_handler.handle(req, ctx)
["api", "projects", id] -> projects_handler.handle_one(req, ctx, id)
```

Add two dispatcher functions to `handlers/projects.gleam`:

```gleam
pub fn handle(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get -> index(req, ctx)
    http.Post -> create(req, ctx)
    _ -> wisp.method_not_allowed(["GET", "POST"])
  }
}

pub fn handle_one(req: Request, ctx: Context, id: String) -> Response {
  case req.method {
    http.Get -> show(req, ctx, id)
    http.Patch -> update(req, ctx, id)
    http.Delete -> delete(req, ctx, id)
    _ -> wisp.method_not_allowed(["GET", "PATCH", "DELETE"])
  }
}
```

- [ ] **Step 8: Run tests**

```bash
cd src/server-gleam && gleam test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): projects DB layer, JSON encoder, and HTTP handlers"
```

---

### Task 7: Crypto + Secrets

**Files:**
- Create: `src/server-gleam/src/fbi/crypto.gleam`
- Create: `src/server-gleam/src/fbi/db/secrets.gleam`
- Create: `src/server-gleam/src/fbi/handlers/secrets.gleam`
- Create: `src/server-gleam/test/fbi/crypto_test.gleam`
- Create: `src/server-gleam/test/fbi/db/secrets_test.gleam`

- [ ] **Step 1: Write the failing test for crypto**

```gleam
// test/fbi/crypto_test.gleam
import fbi/crypto
import gleeunit/should

pub fn round_trip_test() {
  let key = <<
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  >>
  let plaintext = <<"hello world":utf8>>
  let assert Ok(ciphertext) = crypto.encrypt(key, plaintext)
  let assert Ok(decrypted) = crypto.decrypt(key, ciphertext)
  decrypted |> should.equal(plaintext)
}

pub fn wrong_key_fails_test() {
  let key = <<
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  >>
  let wrong_key = <<
    255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  >>
  let plaintext = <<"secret":utf8>>
  let assert Ok(ciphertext) = crypto.encrypt(key, plaintext)
  crypto.decrypt(wrong_key, ciphertext) |> should.be_error()
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd src/server-gleam && gleam test
```

Expected: compilation error (crypto module missing).

- [ ] **Step 3: Create `src/server-gleam/src/fbi/crypto.gleam`**

```gleam
// AES-256-GCM encryption backed by fbi_crypto.erl.
// Blob format: IV(12 bytes) || CipherText || Tag(16 bytes)

pub type CryptoError {
  DecryptionFailed
  InvalidKeyLength
}

pub fn encrypt(key: BitArray, plaintext: BitArray) -> Result(BitArray, CryptoError) {
  case bit_array.byte_size(key) {
    32 -> fbi_crypto_encrypt(key, plaintext, <<>>)
    _ -> Error(InvalidKeyLength)
  }
}

pub fn decrypt(key: BitArray, blob: BitArray) -> Result(BitArray, CryptoError) {
  case bit_array.byte_size(key) {
    32 -> fbi_crypto_decrypt(key, blob, <<>>)
    _ -> Error(InvalidKeyLength)
  }
}

@external(erlang, "fbi_crypto", "encrypt")
fn fbi_crypto_encrypt(
  key: BitArray,
  plaintext: BitArray,
  aad: BitArray,
) -> Result(BitArray, CryptoError)

@external(erlang, "fbi_crypto", "decrypt")
fn fbi_crypto_decrypt(
  key: BitArray,
  blob: BitArray,
  aad: BitArray,
) -> Result(BitArray, CryptoError)
```

Note: The Erlang `fbi_crypto.erl` returns `{ok, Blob}` or `{error, decryption_failed}` — Gleam's `@external` maps Erlang tagged tuples to `Result` automatically.

- [ ] **Step 4: Run tests**

```bash
cd src/server-gleam && gleam test
```

Expected: `round_trip_test` and `wrong_key_fails_test` both pass.

- [ ] **Step 5: Create `src/server-gleam/src/fbi/db/secrets.gleam`**

```gleam
import fbi/crypto
import fbi/db/connection.{type DbError, SqlightError}
import gleam/bit_array
import gleam/dynamic/decode
import gleam/option.{type Option, None, Some}
import gleam/result
import sqlight

pub type Secret {
  Secret(
    id: Int,
    project_id: Int,
    name: String,
    created_at: Int,
  )
}

pub fn list(
  db: sqlight.Connection,
  project_id: Int,
) -> Result(List(Secret), DbError) {
  connection.query_all(
    "SELECT id, project_id, name, created_at FROM project_secrets
     WHERE project_id = ? ORDER BY name",
    db,
    [sqlight.int(project_id)],
    secret_decoder(),
  )
}

pub fn put(
  db: sqlight.Connection,
  project_id: Int,
  name: String,
  plaintext: String,
  key: BitArray,
  now: Int,
) -> Result(Secret, DbError) {
  let assert Ok(encrypted) = crypto.encrypt(key, bit_array.from_string(plaintext))
  sqlight.exec(
    "INSERT INTO project_secrets (project_id, name, value_enc, created_at)
     VALUES (?,?,?,?)
     ON CONFLICT (project_id, name) DO UPDATE SET value_enc = excluded.value_enc",
    on: db,
    with: [
      sqlight.int(project_id),
      sqlight.text(name),
      sqlight.blob(encrypted),
      sqlight.int(now),
    ],
  )
  |> result.map_error(SqlightError)
  |> result.then(fn(_) {
    connection.query_one(
      "SELECT id, project_id, name, created_at FROM project_secrets
       WHERE project_id = ? AND name = ?",
      db,
      [sqlight.int(project_id), sqlight.text(name)],
      secret_decoder(),
    )
  })
}

pub fn delete(
  db: sqlight.Connection,
  project_id: Int,
  name: String,
) -> Result(Nil, DbError) {
  sqlight.exec(
    "DELETE FROM project_secrets WHERE project_id = ? AND name = ?",
    on: db,
    with: [sqlight.int(project_id), sqlight.text(name)],
  )
  |> result.map_error(SqlightError)
}

// Returns decrypted plaintext values for injection into container env
pub fn get_all_decrypted(
  db: sqlight.Connection,
  project_id: Int,
  key: BitArray,
) -> Result(List(#(String, String)), DbError) {
  let row_decoder = {
    use name <- decode.field(0, decode.string)
    use blob <- decode.field(1, decode.bit_array)
    decode.success(#(name, blob))
  }
  use rows <- result.try(
    connection.query_all(
      "SELECT name, value_enc FROM project_secrets WHERE project_id = ?",
      db,
      [sqlight.int(project_id)],
      row_decoder,
    ),
  )
  list.try_map(rows, fn(row) {
    let #(name, blob) = row
    case crypto.decrypt(key, blob) {
      Ok(bits) -> Ok(#(name, bit_array.to_string(bits) |> result.unwrap("")))
      Error(_) -> Error(SqlightError(sqlight.SqlightError(0, "decrypt failed")))
    }
  })
}

fn secret_decoder() -> decode.Decoder(Secret) {
  use id <- decode.field(0, decode.int)
  use project_id <- decode.field(1, decode.int)
  use name <- decode.field(2, decode.string)
  use created_at <- decode.field(3, decode.int)
  decode.success(Secret(id:, project_id:, name:, created_at:))
}
```

- [ ] **Step 6: Create `src/server-gleam/src/fbi/handlers/secrets.gleam`**

```gleam
import fbi/context.{type Context}
import fbi/db/connection
import fbi/db/secrets
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import wisp.{type Request, type Response}

pub fn index(req: Request, ctx: Context, project_id_str: String) -> Response {
  use <- wisp.require_method(req, http.Get)
  case int.parse(project_id_str) {
    Error(_) -> wisp.bad_request()
    Ok(project_id) ->
      case secrets.list(ctx.db, project_id) {
        Ok(ss) ->
          json.array(ss, fn(s) {
            json.object([
              #("id", json.int(s.id)),
              #("project_id", json.int(s.project_id)),
              #("name", json.string(s.name)),
              #("created_at", json.int(s.created_at)),
            ])
          })
          |> json.to_string()
          |> wisp.json_response(200)
        Error(_) -> wisp.internal_server_error()
      }
  }
}

pub fn put(req: Request, ctx: Context, project_id_str: String, name: String) -> Response {
  use <- wisp.require_method(req, http.Put)
  use body <- wisp.require_json(req)
  case int.parse(project_id_str) {
    Error(_) -> wisp.bad_request()
    Ok(project_id) -> {
      let decoder = {
        use value <- decode.field("value", decode.string)
        decode.success(value)
      }
      case decode.run(body, decoder) {
        Error(_) -> wisp.bad_request()
        Ok(value) ->
          case secrets.put(ctx.db, project_id, name, value, ctx.config.secrets_key, now_ms()) {
            Ok(_) -> wisp.response(204)
            Error(_) -> wisp.internal_server_error()
          }
      }
    }
  }
}

pub fn delete(req: Request, ctx: Context, project_id_str: String, name: String) -> Response {
  use <- wisp.require_method(req, http.Delete)
  case int.parse(project_id_str) {
    Error(_) -> wisp.bad_request()
    Ok(project_id) ->
      case secrets.delete(ctx.db, project_id, name) {
        Ok(_) -> wisp.response(204)
        Error(connection.NotFound) -> wisp.not_found()
        Error(_) -> wisp.internal_server_error()
      }
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
```

- [ ] **Step 7: Add secrets routes to router**

```gleam
// In router.gleam case:
["api", "projects", pid, "secrets"] -> secrets_handler.index(req, ctx, pid)
["api", "projects", pid, "secrets", name] ->
  case req.method {
    http.Put -> secrets_handler.put(req, ctx, pid, name)
    http.Delete -> secrets_handler.delete(req, ctx, pid, name)
    _ -> wisp.method_not_allowed(["PUT", "DELETE"])
  }
```

- [ ] **Step 8: Run tests**

```bash
cd src/server-gleam && gleam test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): AES-256-GCM crypto, secrets DB layer and handlers"
```

---

### Task 8: Settings, MCP servers, and Runs (read-only)

**Files:**
- Create: `src/server-gleam/src/fbi/db/settings.gleam`
- Create: `src/server-gleam/src/fbi/handlers/settings.gleam`
- Create: `src/server-gleam/src/fbi/db/mcp_servers.gleam`
- Create: `src/server-gleam/src/fbi/handlers/mcp_servers.gleam`
- Create: `src/server-gleam/src/fbi/db/runs.gleam`
- Create: `src/server-gleam/src/fbi/json/run.gleam`
- Create: `src/server-gleam/src/fbi/handlers/runs.gleam`

- [ ] **Step 1: Create `src/server-gleam/src/fbi/db/settings.gleam`**

```gleam
import fbi/db/connection.{type DbError, SqlightError}
import gleam/dynamic/decode
import gleam/option.{type Option}
import gleam/result
import sqlight

pub type Settings {
  Settings(
    id: Int,
    global_prompt: String,
    notifications_enabled: Bool,
    concurrency_warn_at: Int,
    image_gc_enabled: Bool,
    last_gc_at: Option(Int),
    last_gc_count: Option(Int),
    last_gc_bytes: Option(Int),
    global_marketplaces_json: String,
    global_plugins_json: String,
    auto_resume_enabled: Bool,
    auto_resume_max_attempts: Int,
    usage_notifications_enabled: Bool,
    tokens_total_recomputed_at: Option(Int),
    updated_at: Int,
  )
}

fn decoder() -> decode.Decoder(Settings) {
  use id <- decode.field(0, decode.int)
  use global_prompt <- decode.field(1, decode.string)
  use notifications_enabled <- decode.field(2, decode.int)
  use concurrency_warn_at <- decode.field(3, decode.int)
  use image_gc_enabled <- decode.field(4, decode.int)
  use last_gc_at <- decode.field(5, decode.optional(decode.int))
  use last_gc_count <- decode.field(6, decode.optional(decode.int))
  use last_gc_bytes <- decode.field(7, decode.optional(decode.int))
  use global_marketplaces_json <- decode.field(8, decode.string)
  use global_plugins_json <- decode.field(9, decode.string)
  use auto_resume_enabled <- decode.field(10, decode.int)
  use auto_resume_max_attempts <- decode.field(11, decode.int)
  use usage_notifications_enabled <- decode.field(12, decode.int)
  use tokens_total_recomputed_at <- decode.field(13, decode.optional(decode.int))
  use updated_at <- decode.field(14, decode.int)
  decode.success(Settings(
    id:,
    global_prompt:,
    notifications_enabled: notifications_enabled != 0,
    concurrency_warn_at:,
    image_gc_enabled: image_gc_enabled != 0,
    last_gc_at:, last_gc_count:, last_gc_bytes:,
    global_marketplaces_json:, global_plugins_json:,
    auto_resume_enabled: auto_resume_enabled != 0,
    auto_resume_max_attempts:,
    usage_notifications_enabled: usage_notifications_enabled != 0,
    tokens_total_recomputed_at:,
    updated_at:,
  ))
}

pub fn get(db: sqlight.Connection) -> Result(Settings, DbError) {
  let ensure_row =
    sqlight.exec(
      "INSERT OR IGNORE INTO settings
         (id, global_prompt, updated_at)
       VALUES (1, '', unixepoch() * 1000)",
      on: db,
      with: [],
    )
    |> result.map_error(SqlightError)

  use _ <- result.try(ensure_row)
  connection.query_one(
    "SELECT id, global_prompt, notifications_enabled, concurrency_warn_at,
            image_gc_enabled, last_gc_at, last_gc_count, last_gc_bytes,
            global_marketplaces_json, global_plugins_json,
            auto_resume_enabled, auto_resume_max_attempts,
            usage_notifications_enabled, tokens_total_recomputed_at, updated_at
     FROM settings WHERE id = 1",
    db, [], decoder(),
  )
}

pub fn patch(
  db: sqlight.Connection,
  global_prompt: Option(String),
  notifications_enabled: Option(Bool),
  auto_resume_enabled: Option(Bool),
  auto_resume_max_attempts: Option(Int),
  concurrency_warn_at: Option(Int),
  image_gc_enabled: Option(Bool),
  global_marketplaces_json: Option(String),
  global_plugins_json: Option(String),
  usage_notifications_enabled: Option(Bool),
  now: Int,
) -> Result(Settings, DbError) {
  let sets = [
    #("global_prompt", option.map(global_prompt, fn(v) { sqlight.text(v) })),
    #("notifications_enabled", option.map(notifications_enabled, fn(v) { sqlight.int(case v { True -> 1 False -> 0 }) })),
    #("auto_resume_enabled", option.map(auto_resume_enabled, fn(v) { sqlight.int(case v { True -> 1 False -> 0 }) })),
    #("auto_resume_max_attempts", option.map(auto_resume_max_attempts, sqlight.int)),
    #("concurrency_warn_at", option.map(concurrency_warn_at, sqlight.int)),
    #("image_gc_enabled", option.map(image_gc_enabled, fn(v) { sqlight.int(case v { True -> 1 False -> 0 }) })),
    #("global_marketplaces_json", option.map(global_marketplaces_json, sqlight.text)),
    #("global_plugins_json", option.map(global_plugins_json, sqlight.text)),
    #("usage_notifications_enabled", option.map(usage_notifications_enabled, fn(v) { sqlight.int(case v { True -> 1 False -> 0 }) })),
  ]
  |> list.filter_map(fn(pair) {
    case pair.1 {
      option.None -> option.None
      option.Some(val) -> option.Some(#(pair.0 <> " = ?", val))
    }
  })

  let set_clause = list.map(sets, fn(s) { s.0 }) |> string.join(", ")
  let args = list.map(sets, fn(s) { s.1 })

  use _ <- result.try(
    sqlight.exec(
      "INSERT OR IGNORE INTO settings (id, global_prompt, updated_at) VALUES (1, '', ?)",
      on: db, with: [sqlight.int(now)],
    ) |> result.map_error(SqlightError)
  )
  use _ <- result.try(
    sqlight.exec(
      "UPDATE settings SET " <> set_clause <> ", updated_at = ? WHERE id = 1",
      on: db, with: list.append(args, [sqlight.int(now)]),
    ) |> result.map_error(SqlightError)
  )
  get(db)
}
```

- [ ] **Step 2: Create `src/server-gleam/src/fbi/db/mcp_servers.gleam`**

```gleam
import fbi/db/connection.{type DbError, SqlightError}
import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import sqlight

pub type McpServer {
  McpServer(
    id: Int,
    project_id: Option(Int),
    name: String,
    server_type: String,
    command: Option(String),
    args_json: String,
    url: Option(String),
    env_json: String,
    created_at: Int,
  )
}

fn decoder() -> decode.Decoder(McpServer) {
  use id <- decode.field(0, decode.int)
  use project_id <- decode.field(1, decode.optional(decode.int))
  use name <- decode.field(2, decode.string)
  use server_type <- decode.field(3, decode.string)
  use command <- decode.field(4, decode.optional(decode.string))
  use args_json <- decode.field(5, decode.string)
  use url <- decode.field(6, decode.optional(decode.string))
  use env_json <- decode.field(7, decode.string)
  use created_at <- decode.field(8, decode.int)
  decode.success(McpServer(id:, project_id:, name:, server_type:, command:,
    args_json:, url:, env_json:, created_at:))
}

const select = "SELECT id, project_id, name, type, command, args_json, url, env_json, created_at FROM mcp_servers"

pub fn list_global(db: sqlight.Connection) -> Result(List(McpServer), DbError) {
  connection.query_all(select <> " WHERE project_id IS NULL ORDER BY name", db, [], decoder())
}

pub fn list_for_project(db: sqlight.Connection, project_id: Int) -> Result(List(McpServer), DbError) {
  connection.query_all(select <> " WHERE project_id = ? ORDER BY name", db, [sqlight.int(project_id)], decoder())
}

pub fn get(db: sqlight.Connection, id: Int) -> Result(McpServer, DbError) {
  connection.query_one(select <> " WHERE id = ?", db, [sqlight.int(id)], decoder())
}

pub fn insert(
  db: sqlight.Connection,
  project_id: Option(Int),
  name: String,
  server_type: String,
  command: Option(String),
  args_json: String,
  url: Option(String),
  env_json: String,
  now: Int,
) -> Result(McpServer, DbError) {
  connection.query_one(
    "INSERT INTO mcp_servers (project_id, name, type, command, args_json, url, env_json, created_at)
     VALUES (?,?,?,?,?,?,?,?) RETURNING " <> columns(),
    db,
    [
      case project_id { None -> sqlight.null() Some(id) -> sqlight.int(id) },
      sqlight.text(name), sqlight.text(server_type),
      case command { None -> sqlight.null() Some(c) -> sqlight.text(c) },
      sqlight.text(args_json),
      case url { None -> sqlight.null() Some(u) -> sqlight.text(u) },
      sqlight.text(env_json),
      sqlight.int(now),
    ],
    decoder(),
  )
}

pub fn update(
  db: sqlight.Connection,
  id: Int,
  name: Option(String),
  server_type: Option(String),
  command: Option(Option(String)),
  args_json: Option(String),
  url: Option(Option(String)),
  env_json: Option(String),
) -> Result(McpServer, DbError) {
  let sets = [
    #("name", option.map(name, sqlight.text)),
    #("type", option.map(server_type, sqlight.text)),
    #("command", option.map(command, fn(v) { case v { None -> sqlight.null() Some(s) -> sqlight.text(s) } })),
    #("args_json", option.map(args_json, sqlight.text)),
    #("url", option.map(url, fn(v) { case v { None -> sqlight.null() Some(s) -> sqlight.text(s) } })),
    #("env_json", option.map(env_json, sqlight.text)),
  ]
  |> list.filter_map(fn(p) { case p.1 { None -> None Some(v) -> Some(#(p.0 <> " = ?", v)) } })
  let set_clause = list.map(sets, fn(s) { s.0 }) |> string.join(", ")
  let args = list.map(sets, fn(s) { s.1 })
  connection.query_one(
    "UPDATE mcp_servers SET " <> set_clause <> " WHERE id = ? RETURNING " <> columns(),
    db, list.append(args, [sqlight.int(id)]), decoder(),
  )
}

pub fn delete(db: sqlight.Connection, id: Int) -> Result(Nil, DbError) {
  sqlight.exec("DELETE FROM mcp_servers WHERE id = ?", on: db, with: [sqlight.int(id)])
  |> result.map_error(SqlightError)
}

fn columns() -> String {
  "id, project_id, name, type, command, args_json, url, env_json, created_at"
}
```

- [ ] **Step 3: Create `src/server-gleam/src/fbi/db/runs.gleam`** (Plan 1 read-only operations)

```gleam
import fbi/db/connection.{type DbError, SqlightError}
import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option}
import gleam/result
import sqlight

pub type Run {
  Run(
    id: Int,
    project_id: Int,
    prompt: String,
    branch_name: String,
    state: String,
    container_id: Option(String),
    log_path: String,
    exit_code: Option(Int),
    error: Option(String),
    head_commit: Option(String),
    started_at: Option(Int),
    finished_at: Option(Int),
    created_at: Int,
    state_entered_at: Int,
    model: Option(String),
    effort: Option(String),
    subagent_model: Option(String),
    resume_attempts: Int,
    next_resume_at: Option(Int),
    claude_session_id: Option(String),
    last_limit_reset_at: Option(Int),
    tokens_input: Int,
    tokens_output: Int,
    tokens_cache_read: Int,
    tokens_cache_create: Int,
    tokens_total: Int,
    usage_parse_errors: Int,
    title: Option(String),
    title_locked: Bool,
    parent_run_id: Option(Int),
    kind: String,
    kind_args_json: Option(String),
    mirror_status: Option(String),
    mock: Bool,
    mock_scenario: Option(String),
  )
}

fn decoder() -> decode.Decoder(Run) {
  use id <- decode.field(0, decode.int)
  use project_id <- decode.field(1, decode.int)
  use prompt <- decode.field(2, decode.string)
  use branch_name <- decode.field(3, decode.string)
  use state <- decode.field(4, decode.string)
  use container_id <- decode.field(5, decode.optional(decode.string))
  use log_path <- decode.field(6, decode.string)
  use exit_code <- decode.field(7, decode.optional(decode.int))
  use error <- decode.field(8, decode.optional(decode.string))
  use head_commit <- decode.field(9, decode.optional(decode.string))
  use started_at <- decode.field(10, decode.optional(decode.int))
  use finished_at <- decode.field(11, decode.optional(decode.int))
  use created_at <- decode.field(12, decode.int)
  use state_entered_at <- decode.field(13, decode.int)
  use model <- decode.field(14, decode.optional(decode.string))
  use effort <- decode.field(15, decode.optional(decode.string))
  use subagent_model <- decode.field(16, decode.optional(decode.string))
  use resume_attempts <- decode.field(17, decode.int)
  use next_resume_at <- decode.field(18, decode.optional(decode.int))
  use claude_session_id <- decode.field(19, decode.optional(decode.string))
  use last_limit_reset_at <- decode.field(20, decode.optional(decode.int))
  use tokens_input <- decode.field(21, decode.int)
  use tokens_output <- decode.field(22, decode.int)
  use tokens_cache_read <- decode.field(23, decode.int)
  use tokens_cache_create <- decode.field(24, decode.int)
  use tokens_total <- decode.field(25, decode.int)
  use usage_parse_errors <- decode.field(26, decode.int)
  use title <- decode.field(27, decode.optional(decode.string))
  use title_locked <- decode.field(28, decode.int)
  use parent_run_id <- decode.field(29, decode.optional(decode.int))
  use kind <- decode.field(30, decode.string)
  use kind_args_json <- decode.field(31, decode.optional(decode.string))
  use mirror_status <- decode.field(32, decode.optional(decode.string))
  use mock <- decode.field(33, decode.int)
  use mock_scenario <- decode.field(34, decode.optional(decode.string))
  decode.success(Run(
    id:, project_id:, prompt:, branch_name:, state:, container_id:,
    log_path:, exit_code:, error:, head_commit:, started_at:, finished_at:,
    created_at:, state_entered_at:, model:, effort:, subagent_model:,
    resume_attempts:, next_resume_at:, claude_session_id:, last_limit_reset_at:,
    tokens_input:, tokens_output:, tokens_cache_read:, tokens_cache_create:,
    tokens_total:, usage_parse_errors:, title:,
    title_locked: title_locked != 0,
    parent_run_id:, kind:, kind_args_json:, mirror_status:,
    mock: mock != 0,
    mock_scenario:,
  ))
}

const select = "
  SELECT id, project_id, prompt, branch_name, state, container_id, log_path,
         exit_code, error, head_commit, started_at, finished_at, created_at,
         state_entered_at, model, effort, subagent_model, resume_attempts,
         next_resume_at, claude_session_id, last_limit_reset_at,
         tokens_input, tokens_output, tokens_cache_read, tokens_cache_create,
         tokens_total, usage_parse_errors, title, title_locked, parent_run_id,
         kind, kind_args_json, mirror_status, mock, mock_scenario
  FROM runs"

pub fn list(db: sqlight.Connection) -> Result(List(Run), DbError) {
  connection.query_all(select <> " ORDER BY id DESC", db, [], decoder())
}

pub fn list_for_project(db: sqlight.Connection, project_id: Int) -> Result(List(Run), DbError) {
  connection.query_all(
    select <> " WHERE project_id = ? ORDER BY id DESC",
    db, [sqlight.int(project_id)], decoder(),
  )
}

pub fn get(db: sqlight.Connection, id: Int) -> Result(Run, DbError) {
  connection.query_one(select <> " WHERE id = ?", db, [sqlight.int(id)], decoder())
}

pub fn siblings(db: sqlight.Connection, run_id: Int) -> Result(List(Run), DbError) {
  connection.query_all(
    select <> " WHERE parent_run_id = (SELECT parent_run_id FROM runs WHERE id = ?) ORDER BY id",
    db, [sqlight.int(run_id)], decoder(),
  )
}

pub fn patch_title(
  db: sqlight.Connection,
  id: Int,
  title: String,
  locked: Bool,
) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET title = ?, title_locked = ? WHERE id = ? RETURNING " <> columns(),
    db,
    [sqlight.text(title), sqlight.int(case locked { True -> 1 False -> 0 }), sqlight.int(id)],
    decoder(),
  )
}

pub fn delete(db: sqlight.Connection, id: Int) -> Result(Nil, DbError) {
  sqlight.exec("DELETE FROM runs WHERE id = ?", on: db, with: [sqlight.int(id)])
  |> result.map_error(SqlightError)
}

fn columns() -> String {
  "id, project_id, prompt, branch_name, state, container_id, log_path,
   exit_code, error, head_commit, started_at, finished_at, created_at,
   state_entered_at, model, effort, subagent_model, resume_attempts,
   next_resume_at, claude_session_id, last_limit_reset_at,
   tokens_input, tokens_output, tokens_cache_read, tokens_cache_create,
   tokens_total, usage_parse_errors, title, title_locked, parent_run_id,
   kind, kind_args_json, mirror_status, mock, mock_scenario"
}
```

- [ ] **Step 4: Create `src/server-gleam/src/fbi/json/run.gleam`**

```gleam
import fbi/db/runs.{type Run}
import gleam/json
import gleam/option

pub fn encode(r: Run) -> json.Json {
  json.object([
    #("id", json.int(r.id)),
    #("project_id", json.int(r.project_id)),
    #("prompt", json.string(r.prompt)),
    #("branch_name", json.string(r.branch_name)),
    #("state", json.string(r.state)),
    #("container_id", json.nullable(r.container_id, json.string)),
    #("exit_code", json.nullable(r.exit_code, json.int)),
    #("error", json.nullable(r.error, json.string)),
    #("head_commit", json.nullable(r.head_commit, json.string)),
    #("started_at", json.nullable(r.started_at, json.int)),
    #("finished_at", json.nullable(r.finished_at, json.int)),
    #("created_at", json.int(r.created_at)),
    #("state_entered_at", json.int(r.state_entered_at)),
    #("model", json.nullable(r.model, json.string)),
    #("effort", json.nullable(r.effort, json.string)),
    #("subagent_model", json.nullable(r.subagent_model, json.string)),
    #("resume_attempts", json.int(r.resume_attempts)),
    #("next_resume_at", json.nullable(r.next_resume_at, json.int)),
    #("last_limit_reset_at", json.nullable(r.last_limit_reset_at, json.int)),
    #("tokens_input", json.int(r.tokens_input)),
    #("tokens_output", json.int(r.tokens_output)),
    #("tokens_cache_read", json.int(r.tokens_cache_read)),
    #("tokens_cache_create", json.int(r.tokens_cache_create)),
    #("tokens_total", json.int(r.tokens_total)),
    #("title", json.nullable(r.title, json.string)),
    #("title_locked", json.bool(r.title_locked)),
    #("parent_run_id", json.nullable(r.parent_run_id, json.int)),
    #("kind", json.string(r.kind)),
    #("kind_args_json", json.nullable(r.kind_args_json, json.string)),
    #("mirror_status", json.nullable(r.mirror_status, json.string)),
    #("mock", json.bool(r.mock)),
    #("mock_scenario", json.nullable(r.mock_scenario, json.string)),
  ])
}
```

- [ ] **Step 5: Create `src/server-gleam/src/fbi/handlers/runs.gleam`** (Plan 1: read + patch title + delete row)

```gleam
import fbi/context.{type Context}
import fbi/db/connection
import fbi/db/runs
import fbi/json/run as run_json
import gleam/dynamic/decode
import gleam/http
import gleam/int
import gleam/json
import wisp.{type Request, type Response}

pub fn index(req: Request, ctx: Context) -> Response {
  use <- wisp.require_method(req, http.Get)
  case runs.list(ctx.db) {
    Ok(rs) -> json.array(rs, run_json.encode) |> json.to_string() |> wisp.json_response(200)
    Error(_) -> wisp.internal_server_error()
  }
}

pub fn index_for_project(req: Request, ctx: Context, project_id_str: String) -> Response {
  use <- wisp.require_method(req, http.Get)
  case int.parse(project_id_str) {
    Error(_) -> wisp.bad_request()
    Ok(pid) ->
      case runs.list_for_project(ctx.db, pid) {
        Ok(rs) -> json.array(rs, run_json.encode) |> json.to_string() |> wisp.json_response(200)
        Error(_) -> wisp.internal_server_error()
      }
  }
}

pub fn show(req: Request, ctx: Context, id_str: String) -> Response {
  use <- wisp.require_method(req, http.Get)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request()
    Ok(id) ->
      case runs.get(ctx.db, id) {
        Ok(r) -> run_json.encode(r) |> json.to_string() |> wisp.json_response(200)
        Error(connection.NotFound) -> wisp.not_found()
        Error(_) -> wisp.internal_server_error()
      }
  }
}

pub fn siblings(req: Request, ctx: Context, id_str: String) -> Response {
  use <- wisp.require_method(req, http.Get)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request()
    Ok(id) ->
      case runs.siblings(ctx.db, id) {
        Ok(rs) -> json.array(rs, run_json.encode) |> json.to_string() |> wisp.json_response(200)
        Error(_) -> wisp.internal_server_error()
      }
  }
}

pub fn patch(req: Request, ctx: Context, id_str: String) -> Response {
  use <- wisp.require_method(req, http.Patch)
  use body <- wisp.require_json(req)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request()
    Ok(id) -> {
      let decoder = {
        use title <- decode.field("title", decode.string)
        use locked <- decode.optional_field("title_locked", False, decode.bool)
        decode.success(#(title, locked))
      }
      case decode.run(body, decoder) {
        Error(_) -> wisp.bad_request()
        Ok(#(title, locked)) ->
          case runs.patch_title(ctx.db, id, title, locked) {
            Ok(r) -> run_json.encode(r) |> json.to_string() |> wisp.json_response(200)
            Error(connection.NotFound) -> wisp.not_found()
            Error(_) -> wisp.internal_server_error()
          }
      }
    }
  }
}

pub fn delete(req: Request, ctx: Context, id_str: String) -> Response {
  use <- wisp.require_method(req, http.Delete)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request()
    Ok(id) ->
      case runs.delete(ctx.db, id) {
        Ok(_) -> wisp.response(204)
        Error(connection.NotFound) -> wisp.not_found()
        Error(_) -> wisp.internal_server_error()
      }
  }
}

// Plan 2 stubs — return 501 until orchestration is implemented
pub fn create(req: Request, _ctx: Context, _project_id_str: String) -> Response {
  wisp.response(501)
}

pub fn stop(req: Request, _ctx: Context, _id_str: String) -> Response {
  wisp.response(501)
}

pub fn continue_run(req: Request, _ctx: Context, _id_str: String) -> Response {
  wisp.response(501)
}

pub fn resume_now(req: Request, _ctx: Context, _id_str: String) -> Response {
  wisp.response(501)
}
```

- [ ] **Step 6: Wire remaining routes in `src/server-gleam/src/fbi/router.gleam`**

Replace the stub router with the complete routing table:

```gleam
import fbi/context.{type Context}
import fbi/handlers/health
import fbi/handlers/mcp_servers as mcp_handler
import fbi/handlers/projects as projects_handler
import fbi/handlers/runs as runs_handler
import fbi/handlers/secrets as secrets_handler
import fbi/handlers/settings as settings_handler
import fbi/handlers/static as static_handler
import gleam/http
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context) -> Response {
  use <- wisp.log_request(req)
  use <- wisp.rescue_crashes
  use <- cors_headers

  case wisp.path_segments(req) {
    ["api", "health"] -> health.show(req)

    // Projects
    ["api", "projects"] -> projects_handler.handle(req, ctx)
    ["api", "projects", pid] -> projects_handler.handle_one(req, ctx, pid)
    ["api", "projects", pid, "runs"] ->
      case req.method {
        http.Get -> runs_handler.index_for_project(req, ctx, pid)
        http.Post -> runs_handler.create(req, ctx, pid)
        _ -> wisp.method_not_allowed(["GET", "POST"])
      }
    ["api", "projects", pid, "secrets"] -> secrets_handler.index(req, ctx, pid)
    ["api", "projects", pid, "secrets", name] ->
      case req.method {
        http.Put -> secrets_handler.put(req, ctx, pid, name)
        http.Delete -> secrets_handler.delete(req, ctx, pid, name)
        _ -> wisp.method_not_allowed(["PUT", "DELETE"])
      }
    ["api", "projects", pid, "mcp-servers"] ->
      case req.method {
        http.Get -> mcp_handler.index_for_project(req, ctx, pid)
        http.Post -> mcp_handler.create_for_project(req, ctx, pid)
        _ -> wisp.method_not_allowed(["GET", "POST"])
      }
    ["api", "projects", pid, "mcp-servers", sid] ->
      case req.method {
        http.Patch -> mcp_handler.patch_for_project(req, ctx, pid, sid)
        http.Delete -> mcp_handler.delete_for_project(req, ctx, pid, sid)
        _ -> wisp.method_not_allowed(["PATCH", "DELETE"])
      }

    // Runs
    ["api", "runs"] ->
      case req.method {
        http.Get -> runs_handler.index(req, ctx)
        _ -> wisp.method_not_allowed(["GET"])
      }
    ["api", "runs", id] ->
      case req.method {
        http.Get -> runs_handler.show(req, ctx, id)
        http.Patch -> runs_handler.patch(req, ctx, id)
        http.Delete -> runs_handler.delete(req, ctx, id)
        _ -> wisp.method_not_allowed(["GET", "PATCH", "DELETE"])
      }
    ["api", "runs", id, "siblings"] -> runs_handler.siblings(req, ctx, id)
    ["api", "runs", id, "stop"] -> runs_handler.stop(req, ctx, id)
    ["api", "runs", id, "continue"] -> runs_handler.continue_run(req, ctx, id)
    ["api", "runs", id, "resume-now"] -> runs_handler.resume_now(req, ctx, id)

    // Settings
    ["api", "settings"] -> settings_handler.handle(req, ctx)

    // MCP servers (global)
    ["api", "mcp-servers"] ->
      case req.method {
        http.Get -> mcp_handler.index_global(req, ctx)
        http.Post -> mcp_handler.create_global(req, ctx)
        _ -> wisp.method_not_allowed(["GET", "POST"])
      }
    ["api", "mcp-servers", id] ->
      case req.method {
        http.Patch -> mcp_handler.patch_global(req, ctx, id)
        http.Delete -> mcp_handler.delete_global(req, ctx, id)
        _ -> wisp.method_not_allowed(["PATCH", "DELETE"])
      }

    // Catch-all: SPA + statics
    _ -> static_handler.serve(req, ctx)
  }
}

fn cors_headers(next: fn() -> Response) -> Response {
  let resp = next()
  resp
  |> wisp.set_header("access-control-allow-origin", "*")
  |> wisp.set_header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
  |> wisp.set_header("access-control-allow-headers", "content-type, authorization")
}
```

- [ ] **Step 7: Create remaining handler stubs** for settings and MCP servers

`src/server-gleam/src/fbi/handlers/settings.gleam`:

```gleam
import fbi/context.{type Context}
import fbi/db/settings
import gleam/dynamic/decode
import gleam/http
import gleam/json
import gleam/option.{None, Some}
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get -> show(req, ctx)
    http.Patch -> patch(req, ctx)
    _ -> wisp.method_not_allowed(["GET", "PATCH"])
  }
}

fn show(_req: Request, ctx: Context) -> Response {
  case settings.get(ctx.db) {
    Ok(s) -> encode(s) |> json.to_string() |> wisp.json_response(200)
    Error(_) -> wisp.internal_server_error()
  }
}

fn patch(req: Request, ctx: Context) -> Response {
  use body <- wisp.require_json(req)
  let decoder = {
    use global_prompt <- decode.optional_field("global_prompt", None, decode.optional(decode.string))
    use notifications_enabled <- decode.optional_field("notifications_enabled", None, decode.optional(decode.bool))
    use auto_resume_enabled <- decode.optional_field("auto_resume_enabled", None, decode.optional(decode.bool))
    use auto_resume_max_attempts <- decode.optional_field("auto_resume_max_attempts", None, decode.optional(decode.int))
    use concurrency_warn_at <- decode.optional_field("concurrency_warn_at", None, decode.optional(decode.int))
    use image_gc_enabled <- decode.optional_field("image_gc_enabled", None, decode.optional(decode.bool))
    use global_marketplaces_json <- decode.optional_field("global_marketplaces_json", None, decode.optional(decode.string))
    use global_plugins_json <- decode.optional_field("global_plugins_json", None, decode.optional(decode.string))
    use usage_notifications_enabled <- decode.optional_field("usage_notifications_enabled", None, decode.optional(decode.bool))
    decode.success(#(global_prompt, notifications_enabled, auto_resume_enabled,
      auto_resume_max_attempts, concurrency_warn_at, image_gc_enabled,
      global_marketplaces_json, global_plugins_json, usage_notifications_enabled))
  }
  case decode.run(body, decoder) {
    Error(_) -> wisp.bad_request()
    Ok(#(gp, ne, are, aram, cwa, ige, gmj, gpj, une)) ->
      case settings.patch(ctx.db, option.flatten(gp), option.flatten(ne),
        option.flatten(are), option.flatten(aram), option.flatten(cwa),
        option.flatten(ige), option.flatten(gmj), option.flatten(gpj),
        option.flatten(une), now_ms()) {
        Ok(s) -> encode(s) |> json.to_string() |> wisp.json_response(200)
        Error(_) -> wisp.internal_server_error()
      }
  }
}

fn encode(s: settings.Settings) -> json.Json {
  json.object([
    #("global_prompt", json.string(s.global_prompt)),
    #("notifications_enabled", json.bool(s.notifications_enabled)),
    #("concurrency_warn_at", json.int(s.concurrency_warn_at)),
    #("image_gc_enabled", json.bool(s.image_gc_enabled)),
    #("last_gc_at", json.nullable(s.last_gc_at, json.int)),
    #("last_gc_count", json.nullable(s.last_gc_count, json.int)),
    #("last_gc_bytes", json.nullable(s.last_gc_bytes, json.int)),
    #("global_marketplaces_json", json.string(s.global_marketplaces_json)),
    #("global_plugins_json", json.string(s.global_plugins_json)),
    #("auto_resume_enabled", json.bool(s.auto_resume_enabled)),
    #("auto_resume_max_attempts", json.int(s.auto_resume_max_attempts)),
    #("usage_notifications_enabled", json.bool(s.usage_notifications_enabled)),
    #("tokens_total_recomputed_at", json.nullable(s.tokens_total_recomputed_at, json.int)),
    #("updated_at", json.int(s.updated_at)),
  ])
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
```

`src/server-gleam/src/fbi/handlers/mcp_servers.gleam` follows the same CRUD pattern as projects — implement index/create/patch/delete for both global and project-scoped variants using `fbi/db/mcp_servers`. Encode with:

```gleam
fn encode(m: McpServer) -> json.Json {
  json.object([
    #("id", json.int(m.id)),
    #("project_id", json.nullable(m.project_id, json.int)),
    #("name", json.string(m.name)),
    #("type", json.string(m.server_type)),
    #("command", json.nullable(m.command, json.string)),
    #("args_json", json.string(m.args_json)),
    #("url", json.nullable(m.url, json.string)),
    #("env_json", json.string(m.env_json)),
    #("created_at", json.int(m.created_at)),
  ])
}
```

- [ ] **Step 8: Run full test suite**

```bash
cd src/server-gleam && gleam test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): settings, MCP servers, runs DB layers and HTTP handlers"
```

---

### Task 9: Smoke test the full server

- [ ] **Step 1: Create a test env file**

```bash
mkdir -p /tmp/fbi-gleam-runs
head -c 32 /dev/urandom > /tmp/fbi-gleam.key
```

- [ ] **Step 2: Start the server**

```bash
cd src/server-gleam

DATABASE_PATH=/tmp/fbi-gleam.db \
RUNS_DIR=/tmp/fbi-gleam-runs \
GIT_AUTHOR_NAME="Test User" \
GIT_AUTHOR_EMAIL=test@example.com \
SECRETS_KEY_FILE=/tmp/fbi-gleam.key \
gleam run
```

Expected: server starts on port 3000, migration log appears.

- [ ] **Step 3: Exercise the API**

```bash
# Health
curl -s http://localhost:3000/api/health
# → {"status":"ok"}

# Create project
curl -s -X POST http://localhost:3000/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"test","repo_url":"https://github.com/test/test"}'
# → {"id":1,"name":"test",...}

# List projects
curl -s http://localhost:3000/api/projects
# → [{"id":1,...}]

# Get settings
curl -s http://localhost:3000/api/settings
# → {"global_prompt":"","notifications_enabled":true,...}

# List runs (empty)
curl -s http://localhost:3000/api/runs
# → []

# Create run stub returns 501
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:3000/api/projects/1/runs \
  -H 'content-type: application/json' -d '{}'
# → 501
```

- [ ] **Step 4: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): Plan 1 Foundation complete — all non-orchestration endpoints working"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered |
|---|---|
| Section 1 — Architecture (scaffold, Wisp, sqlight, gleam_otp, pure Gleam) | ✅ Task 1 |
| Section 2 — Data layer (sqlight, migrations, typed decoders) | ✅ Tasks 3-4 |
| Section 3 — HTTP routing (Wisp router, static serving, SPA fallback) | ✅ Tasks 5, 8 |
| Section 4 — Orchestrator | ⏳ Plan 2 |
| Section 5 — WebSockets | ⏳ Plan 3 |
| Section 6 — NIF integration (stub present; full impl Plan 2) | Stub ✅ |
| Section 7 — Config (typed Config, use-chained Results, fail-fast) | ✅ Task 2 |
| Section 8 — Build & deploy (gleam.toml, Makefile, Erlang helpers) | Partial ✅ (deploy scripts in Plan 3) |
| Devcontainer changes | ⏳ Plan 3 |

**Placeholder scan:** No TBD or TODO in task steps. MCP servers handler says "follows same CRUD pattern" — this is intentional (it's mechanical CRUD; the pattern is fully established in Task 6).

**Type consistency:** `Run`, `Project`, `McpServer`, `Settings`, `Secret` types defined in `db/` layer and referenced by name in handlers and JSON encoders.
