# Gleam Server — Clean-Room Rewrite Design

**Date:** 2026-04-28
**Status:** Approved

## Overview

Full clean-room rewrite of the Elixir/Phoenix server in Gleam. The goal is not a line-for-line translation but a design that uses Gleam's type system to make invalid states unrepresentable throughout. The frontend API contract may change; the proxy-router fallback is dropped entirely.

---

## Section 1 — Architecture

**Stack**

| Layer | Choice |
|---|---|
| HTTP | Wisp (built on Mist/Bandit) |
| WebSockets | Mist native WebSocket |
| Database | sqlight (SQLite via Erlang FFI) |
| Actors / supervision | gleam_otp |
| NIF | Erlang FFI → fbi_term.so (Zig) |
| Project format | Pure Gleam (`gleam.toml`, no Mix wrapper) |

**What's dropped**

- Phoenix (channels, Plug pipeline, Ecto, PubSub) — replaced by Wisp routing + gleam_otp actors
- ProxyRouter / dev-proxy fallback — static file serving is conditional on `web_dist_dir` being set; missing files return 404, never proxy
- `SECRET_KEY_BASE` — Phoenix-specific; removed

**Supervision tree**

```
Application
├── DB (sqlight connection pool)
├── RunSupervisor (one_for_one — spawns RunActor per run)
│   └── RunActor (per run)
│       └── TerminalBroadcaster (per run, child of RunActor)
└── HTTP (Mist listener)
```

---

## Section 2 — Data Layer

**sqlight over Ecto**

sqlight is a thin Erlang FFI wrapper around SQLite. No ORM, no schema macros, no migration framework — just typed queries.

```gleam
pub fn insert_run(db: Connection, run: NewRun) -> Result(Run, DbError) {
  sqlight.query(
    "INSERT INTO runs (id, status, ...) VALUES (?, ?, ...) RETURNING *",
    on: db,
    with: [sqlight.text(run.id), sqlight.text("starting"), ...],
    expecting: run_decoder(),
  )
}
```

Every query returns `Result(a, DbError)`. The compiler rejects any code path that ignores a `DbError`. No implicit `nil` results.

**Migrations**

Plain SQL files in `priv/migrations/` numbered sequentially (`001_create_runs.sql`, etc.). A small `Migrations` module runs them at startup, tracking applied migrations in a `schema_migrations` table — same behaviour as Ecto.Migrator but ~30 lines of Gleam with no framework dependency.

**Typed decoders**

Each table has a `decode_row` function built from `gleam/dynamic/decode` combinators. A schema change that removes a column breaks the decoder at compile time, not at runtime.

---

## Section 3 — HTTP Routing

**Wisp router**

```gleam
fn router(req: Request, ctx: Context) -> Response {
  case wisp.path_segments(req) {
    ["api", "runs"]              -> runs.index(req, ctx)
    ["api", "runs", id]         -> runs.show(req, id, ctx)
    ["api", "runs", id, "ws"]   -> terminal_ws.upgrade(req, id, ctx)
    []                          -> serve_spa(req, ctx)
    segments                    -> serve_static(req, segments, ctx)
  }
}
```

Pattern matching on `path_segments` replaces Plug's macro pipeline. Adding a route means adding a case arm — the compiler shows immediately if a handler's return type doesn't match `Response`.

**Static file serving**

`serve_static` checks `ctx.config.web_dist_dir`:

- `option.None` → 404 (dev mode, Vite handles statics)
- `option.Some(dir)` → stream file if it exists, 404 otherwise

No proxy fallback. No silent index.html injection for missing assets with extensions.

**SPA fallback**

`serve_spa` serves `index.html` only when the path has no file extension and `Accept: text/html` is present. All other requests get 404. Same logic as the current `SPARouter` but expressed in plain pattern matches rather than a chain of `cond` clauses.

**Typed handlers**

```gleam
fn show(req: Request, id: String, ctx: Context) -> Response {
  use run <- result_to_response(db.get_run(ctx.db, id))
  wisp.json_response(encode_run(run), 200)
}
```

`use` flattens `Result` — a `DbError` becomes a 404 or 500 without a nested `case`. JSON encoding is a plain function; the compiler catches missing fields when `Run` gains a new variant.

---

## Section 4 — Orchestrator

Three components, each with a single responsibility.

**RunActor — pure state machine**

```gleam
type Phase {
  Starting
  Running(
    container_id: String,
    branch: String,
    broadcaster: Subject(BroadcastMsg),
  )
  Waiting(result: RunResult)       // container done, clients still connected
  Finishing(outcome: RunOutcome)   // cleanup in progress
  Done(outcome: RunOutcome)
  Failed(reason: String)
}
```

Every incoming message is matched against `(phase, message)`. The compiler forces handling of every combination. Invalid transitions — e.g. receiving `ContainerExited` while `Starting`, or `Subscribe` while `Done` — are statically excluded or explicitly dropped with `actor.continue(state)`. Terminal states silently discard all messages.

```gleam
fn handle(state: State, msg: Msg) -> actor.Next(Msg, State) {
  case state.phase, msg {
    Starting,      WorkerReady(cid, branch, bc) -> transition_to_running(...)
    Running(..) as r, Subscribe(client)         -> add_subscriber(r, client)
    Running(..) as r, ContainerExited(outcome)  -> transition_to_waiting(r, outcome)
    Waiting(..) as w, Unsubscribe(client)       -> maybe_finish(w, client)
    Done(..),    _                              -> actor.continue(state)
    _,           _                              -> actor.continue(state)
  }
}
```

**TerminalBroadcaster — independent actor, owns the subscriber list**

Subscriber churn (WebSocket connects/disconnects) is completely decoupled from the lifecycle state machine. TerminalBroadcaster is a small actor with one job: fan terminal chunks out to connected clients.

```gleam
type BroadcastMsg {
  Chunk(data: BitArray)
  Subscribe(client: Subject(TerminalEvent))
  Unsubscribe(client: Subject(TerminalEvent))
  Shutdown
}
```

RunActor passes the broadcaster's `Subject` to clients on subscribe. Docker stdout goes RunWorker → RunActor → broadcaster subject without touching RunActor's phase state. A slow or crashing client affects only its own subject, not the broadcaster or the state machine.

**RunWorker — plain `gleam_otp/task`**

Docker pull, `docker run`, and git operations are sequential and imperative. A task process fits exactly — it runs to completion and sends one message back:

```gleam
task.async(fn() {
  use container_id <- result.try(docker.start(config))
  use branch       <- result.try(git.create_branch(run_id, config.base_branch))
  WorkerReady(container_id, branch, broadcaster_subject)
})
```

`use` flattens the `Result` chain — no nested `case` pyramids. Any step failure short-circuits and arrives at RunActor as `WorkerFailed(reason)`.

---

## Section 5 — WebSockets

Each WebSocket connection is a Mist-managed process. No Phoenix channels, no registry.

**Upgrade and lifecycle**

```gleam
mist.websocket(
  request: req,
  on_open:    fn(conn) { start_ws_state(conn, run_id) },
  on_message: fn(state, conn, msg) { handle_frame(state, conn, msg) },
  on_close:   fn(state) { unsubscribe(state) },
)
```

`on_open` subscribes to the run's `TerminalBroadcaster` by sending a `Subscribe` message with a fresh `Subject(TerminalEvent)`. That subject is the connection's receive channel — terminal chunks arrive there and are forwarded as WebSocket frames.

**Typed inbound messages**

```gleam
type ClientMsg {
  Resize(cols: Int, rows: Int)
  SendInput(data: String)
  Ping
}
```

Frames are decoded with `gleam_json` into `Result(ClientMsg, DecodeError)`. An `Error(_)` closes the connection — no partial handling, no silent ignore.

**Typed outbound events**

```gleam
type ServerMsg {
  TerminalChunk(data: String)
  RunStateChanged(phase: String)
  Pong
}
```

`server_msg_to_json(msg) -> String` is a plain function. The compiler catches missing cases when `ServerMsg` gains a new variant.

**Back-pressure naturally**

Each connection process has its own mailbox. A slow client doesn't block the broadcaster — it `send`s and moves on. If the mailbox grows too large the process can be killed by its supervisor without affecting any other connection.

**Supervision**

WebSocket processes sit under a `one_for_one` supervisor. A crashing connection restarts cleanly. RunActor never notices because the subscriber unregisters via `on_close`.

---

## Section 6 — NIF Integration (fbi_term.so)

The Zig terminal-state NIF is wrapped behind a fully typed, opaque Gleam interface.

**Layer 1 — Erlang stub (one .erl file)**

```erlang
-module(fbi_term_nif).
-export([load/0, new_state/0, process_chunk/2, render_cells/1]).
-on_load(load/0).

load() -> erlang:load_nif(filename:join(code:priv_dir(fbi), "fbi_term"), 0).

new_state()          -> erlang:nif_error(nif_not_loaded).
process_chunk(_, _)  -> erlang:nif_error(nif_not_loaded).
render_cells(_)      -> erlang:nif_error(nif_not_loaded).
```

`-on_load` fires when the BEAM loads the module — no manual init call required anywhere.

**Layer 2 — Gleam wrapper (opaque type)**

```gleam
pub opaque type TerminalState {
  TerminalState(ref: dynamic.Dynamic)
}

@external(erlang, "fbi_term_nif", "new_state")
fn nif_new_state() -> dynamic.Dynamic

@external(erlang, "fbi_term_nif", "process_chunk")
fn nif_process_chunk(state: dynamic.Dynamic, chunk: BitArray) -> dynamic.Dynamic

pub fn new() -> TerminalState {
  TerminalState(nif_new_state())
}

pub fn process(state: TerminalState, chunk: BitArray) -> TerminalState {
  TerminalState(nif_process_chunk(state.ref, chunk))
}
```

`TerminalState` is opaque — the `Dynamic` ref is invisible outside `fbi_term.gleam`. No caller can forge a state or pass a wrong value. The type boundary is the NIF's only public interface.

---

## Section 7 — Configuration

Gleam has no `Application.get_env` or config files. Config is a value, not global state.

**One typed struct, read once at startup**

```gleam
pub type Config {
  Config(
    port: Int,
    database_path: String,
    web_dist_dir: option.Option(String),  // None → skip static serving
    runs_dir: String,
    git_author_name: String,
    git_author_email: String,
    docker_socket: String,
    docker_gid: option.Option(Int),
    ssh_auth_sock: option.Option(String),
    claude_dir: option.Option(String),
    secrets_key: BitArray,
    default_plugins: List(String),
  )
}
```

**Loaded with `use`-chained Results**

```gleam
pub fn load() -> Result(Config, String) {
  use port         <- result.try(env_int("PORT", 3000))
  use db_path      <- result.try(env_required("DATABASE_PATH"))
  use runs_dir     <- result.try(env_required("RUNS_DIR"))
  use author_name  <- result.try(env_required("GIT_AUTHOR_NAME"))
  use author_email <- result.try(env_required("GIT_AUTHOR_EMAIL"))
  use key          <- result.try(read_secrets_key())
  Ok(Config(port: port, database_path: db_path, ...))
}
```

If any required variable is missing, `Error` short-circuits. The application entry point pattern-matches the result and crashes with a clear message before binding any port — no partial startup, no silent defaults for required fields.

**Passed explicitly, never looked up**

`Config` is passed as an argument to every component that needs it — router, run supervisor, Docker client. No process dictionary, no ETS lookup, no module attribute. A function's dependencies are visible in its signature. Tests construct a `Config` directly without touching the environment.

**Optional vs required, encoded in the type**

`web_dist_dir: option.Option(String)` means the router pattern-matches on `None` and skips static file serving rather than crashing on a missing directory. Required fields are plain `String` — the compiler won't let you ignore a missing value.

---

## Section 8 — Build & Deploy

**Project layout**

```
src/server/
  gleam.toml
  Makefile
  src/
    fbi.gleam              ← entry point: load config, start supervision tree
    fbi/
      config.gleam
      router.gleam
      run_actor.gleam
      terminal_broadcaster.gleam
      run_worker.gleam
      docker.gleam
      db.gleam
      fbi_term.gleam       ← NIF wrapper
  erlang/
    fbi_term_nif.erl       ← NIF loader stub
  priv/
    native/fbi_term.so     ← compiled by make, gitignored
    migrations/            ← plain SQL files
```

**Build pipeline**

```makefile
priv/native/fbi_term.so:
	$(MAKE) -C ../../cli/fbi-term-core
	cp ../../cli/fbi-term-core/zig-out/lib/libfbi_term.so priv/native/fbi_term.so

build: priv/native/fbi_term.so
	gleam export erlang-shipment

clean:
	rm -rf build/ priv/native/fbi_term.so
```

`gleam export erlang-shipment` compiles Gleam → BEAM and writes a self-contained `build/erlang-shipment/` directory with a `run.sh` entry point. No rebar3 or Mix required at deploy time.

**Install / update scripts**

Replace the `mix release` block with:

```bash
make -C "$SOURCE_DIR/src/server" build
rsync -a --delete "$SOURCE_DIR/src/server/build/erlang-shipment/" "$RELEASE_DIR/"
chown -R fbi:fbi "$RELEASE_DIR"
```

The systemd unit `ExecStart` changes from the Mix release binary to:

```ini
ExecStart=/opt/fbi/run.sh start
```

`/etc/default/fbi` stays identical — same env vars, same `EnvironmentFile=` line. `SECRET_KEY_BASE` is removed (Phoenix-only). Config is validated at process start, so a missing required var surfaces in `journalctl` within the first second.

**Dev workflow**

```bash
# first time
make -C src/server priv/native/fbi_term.so
cd src/server && gleam deps download

# daily
bash scripts/dev.sh   # starts Vite + gleam run
```

**Devcontainer changes**

`Dockerfile`:
- Remove Elixir asdf plugin/install
- Remove `MIX_HOME`, `mix local.hex/rebar`, `phx_new`, `/tmp/mix_pubsub`
- Add Gleam via asdf (`asdf plugin add gleam`, pin `GLEAM_VERSION`)
- Erlang/OTP and Zig stay unchanged — both still required

`devcontainer.json`:
- Port label `"4000"` removed; `"3000"` relabelled to `"FBI Server (Gleam)"`
- VS Code extension `JakeBecker.elixir-ls` → `gleam.gleam` (bundles the language server)
- `postCreateCommand` adds `cd src/server && gleam deps download`
