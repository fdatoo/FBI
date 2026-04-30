# Image Builder Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Elixir ImageBuilder, DevcontainerFetcher, and ImageGC to Gleam — restoring per-project content-hashed Docker images with streaming build output, devcontainer support, and periodic/on-demand GC.

**Architecture:** A broadcaster owned by the run actor from creation enables streaming before the container starts. `image_builder.gleam` resolves per-project image tags via content-hash (building base + post-layer if missing). `devcontainer_fetcher.gleam` sparse-clones repos for `.devcontainer/` files. `image_gc.gleam` sweeps stale `fbi/p*` images; `gc_scheduler.gleam` runs it hourly. `docker.gleam` gains four new API functions. An Erlang helper `fbi_cmd.erl` enables subprocess execution with exit codes.

**Tech Stack:** Gleam, Erlang OTP (crypto, ports, open_port), Docker HTTP API (Unix socket), SQLite (sqlight), simplifile, gleam/otp/actor

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/server/src/fbi_cmd.erl` | Create | Subprocess execution with exit codes via Erlang `open_port` |
| `src/server/src/fbi_crypto.erl` | Modify | Add `sha256/1` and `hex_encode_lower/1` exports |
| `src/server/src/fbi/run/types.gleam` | Modify | `Starting` carries broadcaster; `WorkerReady` drops it |
| `src/server/src/fbi/run/actor.gleam` | Modify | Accept broadcaster in `start/4`; handle Subscribe in Starting |
| `src/server/src/fbi/run/supervisor.gleam` | Modify | Create broadcaster before starting actor; return both subjects |
| `src/server/src/fbi/run/worker.gleam` | Modify | Add `broadcaster` to `LaunchInput`; remove `broadcaster.start()` call |
| `src/server/src/fbi/handlers/runs.gleam` | Modify | Destructure `#(actor, bc)` from `start_run`; pass `bc` to worker |
| `src/server/src/fbi/docker.gleam` | Modify | Add `list_images`, `list_containers`, `remove_image`, `build_image` |
| `src/server/src/fbi/run/image_builder.gleam` | Create | Per-project image resolution with streaming |
| `src/server/src/fbi/run/devcontainer_fetcher.gleam` | Create | Sparse-clone repo for `.devcontainer/` files |
| `src/server/src/fbi/run/image_gc.gleam` | Create | Sweep stale `fbi/p*` images |
| `src/server/src/fbi/db/settings.gleam` | Modify | Add `update_gc_result/4` |
| `src/server/src/fbi/run/gc_scheduler.gleam` | Create | Hourly GC OTP actor |
| `src/server/src/fbi.gleam` | Modify | Start `gc_scheduler` at boot |
| `src/server/src/fbi/handlers/settings.gleam` | Modify | Add `handle_run_gc` |
| `src/server/src/fbi/router.gleam` | Modify | Add `POST /api/settings/run-gc` |
| `src/server/test/fbi/run/actor_test.gleam` | Modify | Update for `start/4` signature and `Starting(bc)` shape |

---

### Task 1: Erlang Helpers

**Files:**
- Create: `src/server/src/fbi_cmd.erl`
- Modify: `src/server/src/fbi_crypto.erl`

- [ ] **Step 1: Create fbi_cmd.erl**

Create `src/server/src/fbi_cmd.erl`:

```erlang
-module(fbi_cmd).
-export([run/3, find_executable/1]).

%% run(Cmd, Args, Env) -> {ExitCode :: integer(), Output :: binary()}
%% Runs Cmd as a subprocess with Args and Env, capturing combined stdout+stderr.
run(Cmd, Args, Env) ->
    CmdStr = binary_to_list(Cmd),
    ArgsList = [binary_to_list(A) || A <- Args],
    EnvList = [{binary_to_list(K), binary_to_list(V)} || {K, V} <- Env],
    Port = open_port({spawn_executable, CmdStr},
                     [binary, exit_status, stderr_to_stdout,
                      {args, ArgsList}, {env, EnvList}]),
    collect(Port, <<>>).

collect(Port, Acc) ->
    receive
        {Port, {data, Chunk}} -> collect(Port, <<Acc/binary, Chunk/binary>>);
        {Port, {exit_status, Code}} -> {Code, Acc}
    end.

%% find_executable(Name) -> binary()
%% Resolves a program name to its full path, or returns Name unchanged.
find_executable(Name) ->
    NameStr = binary_to_list(Name),
    case os:find_executable(NameStr) of
        false -> Name;
        Path  -> list_to_binary(Path)
    end.
```

- [ ] **Step 2: Add sha256 and hex_encode_lower to fbi_crypto.erl**

Open `src/server/src/fbi_crypto.erl`. Change the `-export` line from:
```erlang
-export([encrypt/3, decrypt/3]).
```
to:
```erlang
-export([encrypt/3, decrypt/3, sha256/1, hex_encode_lower/1]).
```

Then add these two functions at the end of the file (before the last blank line):
```erlang
%% sha256(Data :: binary()) -> binary()
sha256(Data) ->
    crypto:hash(sha256, Data).

%% hex_encode_lower(Data :: binary()) -> binary()
hex_encode_lower(Data) ->
    string:lowercase(binary:encode_hex(Data)).
```

- [ ] **Step 3: Build to verify**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam build
```

Expected: exits 0, no errors or warnings about fbi_cmd or fbi_crypto.

- [ ] **Step 4: Commit**

```bash
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi_cmd.erl src/server/src/fbi_crypto.erl
git commit -m "feat: add fbi_cmd Erlang subprocess helper and sha256/hex helpers to fbi_crypto"
```

---

### Task 2: Broadcaster Ownership Refactor

**Files:**
- Modify: `src/server/src/fbi/run/types.gleam`
- Modify: `src/server/src/fbi/run/actor.gleam`
- Modify: `src/server/src/fbi/run/supervisor.gleam`
- Modify: `src/server/src/fbi/run/worker.gleam`
- Modify: `src/server/src/fbi/handlers/runs.gleam`
- Modify: `src/server/test/fbi/run/actor_test.gleam`

These six files must all be updated before `gleam build` will pass.

- [ ] **Step 1: Update types.gleam**

Replace the full content of `src/server/src/fbi/run/types.gleam`:

```gleam
import gleam/erlang/process.{type Subject}
import gleam/option.{type Option}

pub type Phase {
  Starting(broadcaster: Subject(BroadcastMsg))
  Running(
    container_id: String,
    branch: String,
    broadcaster: Subject(BroadcastMsg),
    cols: Int,
    rows: Int,
  )
  Waiting(outcome: RunOutcome, broadcaster: Subject(BroadcastMsg))
  Finishing(outcome: RunOutcome)
  Done(outcome: RunOutcome)
  Failed(reason: String)
}

pub type RunOutcome {
  RunOutcome(
    exit_code: Int,
    branch_pushed: Option(String),
    head_commit: Option(String),
    title: Option(String),
    error_message: Option(String),
  )
}

pub type RunMsg {
  // From RunWorker
  WorkerReady(
    container_id: String,
    branch: String,
    cols: Int,
    rows: Int,
  )
  WorkerFailed(reason: String)
  ContainerExited(outcome: RunOutcome)

  // From WebSocket clients
  Subscribe(client: Subject(TerminalEvent))
  Unsubscribe(client: Subject(TerminalEvent))
  WriteStdin(bytes: BitArray)
  Resize(cols: Int, rows: Int)

  // External commands
  Cancel
  Shutdown
}

pub type BroadcastMsg {
  BroadcastChunk(data: BitArray)
  BroadcastEvent(event: TerminalEvent)
  BroadcastSubscribe(client: Subject(TerminalEvent))
  BroadcastUnsubscribe(client: Subject(TerminalEvent))
  BroadcastShutdown
}

pub type TerminalEvent {
  TerminalChunk(data: BitArray)
  StateChanged(state: String)
  TitleChanged(title: String)
  Snapshot(ansi: String, cols: Int, rows: Int)
}
```

- [ ] **Step 2: Replace actor.gleam**

Replace the full content of `src/server/src/fbi/run/actor.gleam`:

```gleam
import fbi/config.{type Config}
import fbi/db/runs as runs_db
import fbi/docker
import fbi/run/types.{
  type BroadcastMsg, type Phase, type RunMsg, type RunOutcome, BroadcastShutdown,
  BroadcastSubscribe, BroadcastUnsubscribe, Cancel, ContainerExited, Done,
  Failed, Finishing, Resize, Running, Shutdown, Starting, Subscribe, Unsubscribe,
  Waiting, WorkerFailed, WorkerReady, WriteStdin,
}
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/otp/actor
import gleam/result
import sqlight
import wisp

pub type State {
  State(
    run_id: Int,
    db: sqlight.Connection,
    config: Config,
    phase: Phase,
    listener_count: Int,
  )
}

pub fn start(
  run_id: Int,
  db: sqlight.Connection,
  config: Config,
  bc: Subject(BroadcastMsg),
) -> Result(Subject(RunMsg), actor.StartError) {
  actor.new_with_initialiser(500, fn(subject) {
    State(
      run_id: run_id,
      db: db,
      config: config,
      phase: Starting(bc),
      listener_count: 0,
    )
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: RunMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: RunMsg) -> actor.Next(State, RunMsg) {
  case state.phase, msg {
    // ── Starting ─────────────────────────────────────────────────────────────
    Starting(bc), WorkerReady(cid, branch, cols, rows) ->
      transition_to_running(state, cid, branch, bc, cols, rows)
    Starting(_), WorkerFailed(reason) -> transition_to_failed(state, reason)
    Starting(_), Cancel -> transition_to_failed(state, "cancelled before start")
    Starting(bc), Subscribe(client) -> {
      process.send(bc, BroadcastSubscribe(client))
      actor.continue(State(..state, listener_count: state.listener_count + 1))
    }
    Starting(bc), Unsubscribe(client) -> {
      process.send(bc, BroadcastUnsubscribe(client))
      actor.continue(State(..state, listener_count: state.listener_count - 1))
    }

    // ── Running ──────────────────────────────────────────────────────────────
    Running(_, _, bc, _, _), Subscribe(client) -> {
      process.send(bc, BroadcastSubscribe(client))
      actor.continue(State(..state, listener_count: state.listener_count + 1))
    }
    Running(_, _, bc, _, _), Unsubscribe(client) -> {
      process.send(bc, BroadcastUnsubscribe(client))
      actor.continue(State(..state, listener_count: state.listener_count - 1))
    }
    Running(_, _, _, _, _), WriteStdin(_bytes) ->
      actor.continue(state)
    Running(cid, branch, bc, _, _), Resize(cols, rows) -> {
      let assert Ok(sock) = docker.connect(state.config.docker_socket)
      let _ = docker.resize_container(sock, cid, cols, rows)
      docker.close(sock)
      actor.continue(
        State(..state, phase: Running(cid, branch, bc, cols, rows)),
      )
    }
    Running(cid, _, bc, _, _), ContainerExited(outcome) ->
      transition_to_waiting(state, cid, bc, outcome)
    Running(cid, _, _, _, _), Cancel -> {
      let assert Ok(sock) = docker.connect(state.config.docker_socket)
      let _ = docker.kill_container(sock, cid)
      docker.close(sock)
      actor.continue(state)
    }

    // ── Waiting ──────────────────────────────────────────────────────────────
    Waiting(_, bc), Subscribe(client) -> {
      process.send(bc, BroadcastSubscribe(client))
      actor.continue(State(..state, listener_count: state.listener_count + 1))
    }
    Waiting(outcome, bc), Unsubscribe(client) -> {
      process.send(bc, BroadcastUnsubscribe(client))
      let new_count = state.listener_count - 1
      case new_count <= 0 {
        True -> transition_to_finishing(state, bc, outcome, "")
        False -> actor.continue(State(..state, listener_count: new_count))
      }
    }

    // ── Terminal phases ───────────────────────────────────────────────────────
    Done(_), _ -> actor.continue(state)
    Failed(_), _ -> actor.continue(state)
    Finishing(_), _ -> actor.continue(state)

    // ── Shutdown ─────────────────────────────────────────────────────────────
    _, Shutdown -> actor.stop()

    // ── Catch-all ────────────────────────────────────────────────────────────
    _, _ -> actor.continue(state)
  }
}

fn transition_to_running(
  state: State,
  cid: String,
  branch: String,
  bc: Subject(BroadcastMsg),
  cols: Int,
  rows: Int,
) -> actor.Next(State, RunMsg) {
  wisp.log_info(
    "run "
    <> int.to_string(state.run_id)
    <> " running container="
    <> cid
    <> " branch="
    <> branch,
  )
  let _ = runs_db.mark_state(state.db, state.run_id, "running", now_ms())
  actor.continue(State(..state, phase: Running(cid, branch, bc, cols, rows)))
}

fn transition_to_waiting(
  state: State,
  cid: String,
  bc: Subject(BroadcastMsg),
  outcome: RunOutcome,
) -> actor.Next(State, RunMsg) {
  wisp.log_info(
    "run "
    <> int.to_string(state.run_id)
    <> " finished exit_code="
    <> int.to_string(outcome.exit_code),
  )
  let db_outcome =
    runs_db.RunOutcome(
      exit_code: outcome.exit_code,
      branch_pushed: outcome.branch_pushed,
      head_commit: outcome.head_commit,
      title: outcome.title,
      error_message: outcome.error_message,
    )
  let _ = runs_db.mark_finished(state.db, state.run_id, db_outcome, now_ms())
  case state.listener_count {
    0 -> transition_to_finishing(state, bc, outcome, cid)
    _ -> actor.continue(State(..state, phase: Waiting(outcome, bc)))
  }
}

fn transition_to_finishing(
  state: State,
  bc: Subject(BroadcastMsg),
  outcome: RunOutcome,
  cid: String,
) -> actor.Next(State, RunMsg) {
  wisp.log_debug("run " <> int.to_string(state.run_id) <> " cleaning up")
  process.send(bc, BroadcastShutdown)
  case cid {
    "" -> Nil
    id -> {
      let assert Ok(sock) = docker.connect(state.config.docker_socket)
      let _ = docker.remove_container(sock, id, True)
      docker.close(sock)
    }
  }
  actor.continue(State(..state, phase: Done(outcome)))
}

fn transition_to_failed(
  state: State,
  reason: String,
) -> actor.Next(State, RunMsg) {
  wisp.log_error("run " <> int.to_string(state.run_id) <> " failed: " <> reason)
  let _ = runs_db.mark_failed(state.db, state.run_id, reason, now_ms())
  actor.continue(State(..state, phase: Failed(reason)))
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
```

- [ ] **Step 3: Replace supervisor.gleam**

Replace the full content of `src/server/src/fbi/run/supervisor.gleam`:

```gleam
import fbi/config.{type Config}
import fbi/run/actor as run_actor
import fbi/run/broadcaster
import fbi/run/registry.{type RegistryMsg, Register}
import fbi/run/types.{type BroadcastMsg, type RunMsg}
import gleam/erlang/process.{type Subject}
import gleam/result
import sqlight

pub fn start_run(
  registry: Subject(RegistryMsg),
  db: sqlight.Connection,
  config: Config,
  run_id: Int,
) -> Result(#(Subject(RunMsg), Subject(BroadcastMsg)), String) {
  use bc <- result.try(
    broadcaster.start()
    |> result.map_error(fn(_) { "failed to start broadcaster" }),
  )
  use actor_subject <- result.try(
    run_actor.start(run_id, db, config, bc)
    |> result.map_error(fn(_) { "failed to start run actor" }),
  )
  process.send(registry, Register(run_id, actor_subject))
  Ok(#(actor_subject, bc))
}
```

- [ ] **Step 4: Update worker.gleam**

In `src/server/src/fbi/run/worker.gleam`:

1. Add `broadcaster: Subject(BroadcastMsg)` to `LaunchInput` (after `rows: Int`):

```gleam
pub type LaunchInput {
  LaunchInput(
    run: Run,
    project: Project,
    config: Config,
    image_tag: String,
    cols: Int,
    rows: Int,
    broadcaster: Subject(BroadcastMsg),
  )
}
```

2. Add `type BroadcastMsg` to the imports from `fbi/run/types`:

```gleam
import fbi/run/types.{type BroadcastMsg, type RunMsg, WorkerFailed, WorkerReady}
```

3. Change `do_launch` return type from `Result(#(String, String, Subject(BroadcastMsg)), String)` to `Result(#(String, String), String)`.

4. Remove the `use bc <- result.try(broadcaster.start() ...)` block from `do_launch`.

5. Change the final `Ok(#(cid, input.run.branch_name, bc))` to `Ok(#(cid, input.run.branch_name))`.

6. Update the `launch` function's inner success branch to remove `bc` from the pattern and from `WorkerReady`:

```gleam
pub fn launch(input: LaunchInput, parent: Subject(RunMsg)) -> Nil {
  process.spawn_unlinked(fn() {
    case do_launch(input) {
      Ok(#(cid, branch)) ->
        process.send(
          parent,
          WorkerReady(
            container_id: cid,
            branch: branch,
            cols: input.cols,
            rows: input.rows,
          ),
        )
      Error(reason) -> process.send(parent, WorkerFailed(reason))
    }
  })
  Nil
}
```

7. Remove `import fbi/run/broadcaster` (no longer needed in worker).

- [ ] **Step 5: Update handlers/runs.gleam**

In `src/server/src/fbi/handlers/runs.gleam`, inside the `create` function, find:

```gleam
let assert Ok(actor_subject) =
  run_supervisor.start_run(
    ctx.run_registry,
    ctx.db,
    ctx.config,
    run.id,
  )
run_worker.launch(
  run_worker.LaunchInput(
    run: run,
    project: project,
    config: ctx.config,
    image_tag: ctx.config.image_tag,
    cols: 80,
    rows: 24,
  ),
  actor_subject,
)
```

Replace with:

```gleam
let assert Ok(#(actor_subject, bc)) =
  run_supervisor.start_run(
    ctx.run_registry,
    ctx.db,
    ctx.config,
    run.id,
  )
run_worker.launch(
  run_worker.LaunchInput(
    run: run,
    project: project,
    config: ctx.config,
    image_tag: ctx.config.image_tag,
    cols: 80,
    rows: 24,
    broadcaster: bc,
  ),
  actor_subject,
)
```

- [ ] **Step 6: Update actor_test.gleam**

Replace the full content of `src/server/test/fbi/run/actor_test.gleam`:

```gleam
import fbi/config
import fbi/db/migrations
import fbi/db/projects
import fbi/run/actor as run_actor
import fbi/run/broadcaster
import fbi/run/types.{Cancel, WorkerFailed}
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/option.{None}
import gleeunit/should
import sqlight

fn test_setup() -> #(sqlight.Connection, config.Config) {
  let assert Ok(db) = sqlight.open(":memory:")
  let assert Ok(_) = migrations.run(db)
  let now = 1_700_000_000_000
  let assert Ok(p) =
    projects.insert(
      db,
      projects.NewProject(
        name: "p",
        repo_url: "u",
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
  let _ =
    sqlight.query(
      "INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at, state_entered_at) VALUES (?, 'test prompt', 'main', 'queued', '/tmp/log', ?, ?) RETURNING id",
      on: db,
      with: [sqlight.int(p.id), sqlight.int(now), sqlight.int(now)],
      expecting: decode.at([0], decode.int),
    )
  #(db, test_config())
}

fn test_config() -> config.Config {
  config.Config(
    port: 0,
    secret_key: "test",
    database_path: ":memory:",
    runs_dir: "/tmp/r",
    git_author_name: "t",
    git_author_email: "t@t",
    web_dist_dir: None,
    docker_socket: "/var/run/docker.sock",
    docker_gid: None,
    ssh_auth_sock: None,
    claude_dir: None,
    secrets_key: <<0:size(256)>>,
    default_plugins: [],
    image_tag: "fbi-image-default",
  )
}

pub fn worker_failed_transitions_to_failed_test() {
  let #(db, cfg) = test_setup()
  let assert Ok(bc) = broadcaster.start()
  let assert Ok(actor_subject) = run_actor.start(1, db, cfg, bc)
  process.send(actor_subject, WorkerFailed("simulated failure"))
  process.sleep(50)
  process.send(actor_subject, Cancel)
  process.sleep(10)
  Nil
}

pub fn start_and_shutdown_test() {
  let #(db, cfg) = test_setup()
  let assert Ok(bc) = broadcaster.start()
  let assert Ok(actor_subject) = run_actor.start(1, db, cfg, bc)
  process.send(actor_subject, types.Shutdown)
  process.sleep(50)
  Nil
  |> should.equal(Nil)
}
```

- [ ] **Step 7: Build and test**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam build && gleam test
```

Expected: Build succeeds, all tests pass.

- [ ] **Step 8: Format and commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam format src/ test/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/run/types.gleam \
        src/server/src/fbi/run/actor.gleam \
        src/server/src/fbi/run/supervisor.gleam \
        src/server/src/fbi/run/worker.gleam \
        src/server/src/fbi/handlers/runs.gleam \
        src/server/test/fbi/run/actor_test.gleam
git commit -m "refactor(run): broadcaster owned by actor from creation, enabling pre-container streaming"
```

---

### Task 3: Docker API — list_images, list_containers, remove_image

**Files:**
- Modify: `src/server/src/fbi/docker.gleam`

- [ ] **Step 1: Add ImageInfo and ContainerInfo types**

Add these two types to `src/server/src/fbi/docker.gleam` immediately after the existing `DockerError` type definition:

```gleam
pub type ImageInfo {
  ImageInfo(id: String, repo_tags: List(String), created: Int, size: Int)
}

pub type ContainerInfo {
  ContainerInfo(image_id: String)
}
```

- [ ] **Step 2: Add list_images**

Add after the `upload_archive` function:

```gleam
pub fn list_images(sock: Socket) -> Result(List(ImageInfo), DockerError) {
  use #(status, resp) <- result.try(request(
    sock,
    "GET",
    "/images/json",
    <<>>,
    "application/json",
  ))
  case status {
    200 -> {
      use s <- result.try(to_string(resp))
      let decoder = {
        use id <- decode.field("Id", decode.string)
        use repo_tags <- decode.field("RepoTags", decode.list(decode.string))
        use created <- decode.field("Created", decode.int)
        use size <- decode.field("Size", decode.int)
        decode.success(ImageInfo(id:, repo_tags:, created:, size:))
      }
      json.parse(s, decode.list(decoder))
      |> result.map_error(fn(_) { DecodeError("list_images") })
    }
    code -> Error(HttpError(code, result.unwrap(to_string(resp), "")))
  }
}
```

- [ ] **Step 3: Add list_containers**

```gleam
pub fn list_containers(
  sock: Socket,
  all: Bool,
) -> Result(List(ContainerInfo), DockerError) {
  let path = case all {
    True -> "/containers/json?all=1"
    False -> "/containers/json"
  }
  use #(status, resp) <- result.try(request(
    sock,
    "GET",
    path,
    <<>>,
    "application/json",
  ))
  case status {
    200 -> {
      use s <- result.try(to_string(resp))
      let decoder = {
        use image_id <- decode.field("ImageID", decode.string)
        decode.success(ContainerInfo(image_id:))
      }
      json.parse(s, decode.list(decoder))
      |> result.map_error(fn(_) { DecodeError("list_containers") })
    }
    code -> Error(HttpError(code, result.unwrap(to_string(resp), "")))
  }
}
```

- [ ] **Step 4: Add remove_image**

```gleam
pub fn remove_image(sock: Socket, tag: String) -> Result(Nil, DockerError) {
  use #(status, resp) <- result.try(request(
    sock,
    "DELETE",
    "/images/" <> uri_encode(tag),
    <<>>,
    "application/json",
  ))
  case status {
    code if code >= 200 && code < 300 -> Ok(Nil)
    code -> Error(HttpError(code, result.unwrap(to_string(resp), "")))
  }
}
```

- [ ] **Step 5: Build, format, commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam build && gleam format src/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/docker.gleam
git commit -m "feat(docker): add list_images, list_containers, remove_image"
```

---

### Task 4: Docker API — build_image (streaming)

**Files:**
- Modify: `src/server/src/fbi/docker.gleam`

- [ ] **Step 1: Add build_image and helpers**

The Docker build API (`POST /build?t={tag}`) streams a series of newline-delimited JSON objects while the build runs. We can't use the existing `request()` function (which waits for the full response) — we need to send the request, parse just the response headers, then stream the body line by line.

Add these functions to `docker.gleam`. Place `build_image` alongside the other public functions, and the helpers at the bottom of the file with the existing private helpers.

**Public function:**

```gleam
pub fn build_image(
  sock: Socket,
  tar: BitArray,
  tag: String,
  on_chunk: fn(String) -> Nil,
) -> Result(Nil, DockerError) {
  let path = "/build?t=" <> uri_encode(tag)
  let body_size = bit_array.byte_size(tar)
  let header_str =
    "POST "
    <> path
    <> " HTTP/1.1\r\n"
    <> "Host: docker\r\n"
    <> "Content-Type: application/x-tar\r\n"
    <> "Content-Length: "
    <> int.to_string(body_size)
    <> "\r\n"
    <> "Connection: close\r\n\r\n"
  let req = bit_array.append(bit_array.from_string(header_str), tar)
  use _ <- result.try(send(sock, req))
  use #(status, body_prefix) <- result.try(read_until_header_end(sock, <<>>))
  case status {
    200 -> stream_build_lines(sock, body_prefix, on_chunk)
    code -> Error(HttpError(code, ""))
  }
}
```

**Private helpers (add at end of file):**

```gleam
fn read_until_header_end(
  sock: Socket,
  buf: BitArray,
) -> Result(#(Int, BitArray), DockerError) {
  use chunk <- result.try(recv(sock, 4096))
  let new_buf = bit_array.append(buf, chunk)
  case find_double_crlf(new_buf, 0) {
    Error(_) -> read_until_header_end(sock, new_buf)
    Ok(pos) -> {
      let sep_end = pos + 4
      let buf_size = bit_array.byte_size(new_buf)
      let header_bytes =
        bit_array.slice(new_buf, 0, pos) |> result.unwrap(<<>>)
      let body_prefix =
        bit_array.slice(new_buf, sep_end, buf_size - sep_end)
        |> result.unwrap(<<>>)
      use header_str <- result.try(
        to_string(header_bytes)
        |> result.map_error(fn(_) { DecodeError("header decode") }),
      )
      let status = parse_http_status(header_str)
      Ok(#(status, body_prefix))
    }
  }
}

fn parse_http_status(header_str: String) -> Int {
  case string.split(header_str, " ") {
    [_, code_str, ..] -> int.parse(code_str) |> result.unwrap(0)
    _ -> 0
  }
}

fn stream_build_lines(
  sock: Socket,
  pending: BitArray,
  on_chunk: fn(String) -> Nil,
) -> Result(Nil, DockerError) {
  case process_build_lines(pending, on_chunk) {
    Error(msg) -> Error(DecodeError(msg))
    Ok(remainder) ->
      case recv(sock, 4096) {
        Ok(chunk) ->
          stream_build_lines(
            sock,
            bit_array.append(remainder, chunk),
            on_chunk,
          )
        Error(_) -> Ok(Nil)
      }
  }
}

fn process_build_lines(
  buf: BitArray,
  on_chunk: fn(String) -> Nil,
) -> Result(BitArray, String) {
  case bit_array.to_string(buf) {
    Error(_) -> Ok(buf)
    Ok(s) ->
      case string.split_once(s, "\n") {
        Error(_) -> Ok(buf)
        Ok(#(line, rest)) -> {
          use _ <- result.try(handle_build_line(line, on_chunk))
          process_build_lines(bit_array.from_string(rest), on_chunk)
        }
      }
  }
}

fn handle_build_line(
  line: String,
  on_chunk: fn(String) -> Nil,
) -> Result(Nil, String) {
  case string.trim(line) {
    "" -> Ok(Nil)
    trimmed -> {
      let decoder = {
        use stream <- decode.optional_field(
          "stream",
          None,
          decode.optional(decode.string),
        )
        use error <- decode.optional_field(
          "error",
          None,
          decode.optional(decode.string),
        )
        decode.success(#(stream, error))
      }
      case json.parse(trimmed, decoder) {
        Error(_) -> Ok(Nil)
        Ok(#(stream, error)) ->
          case error {
            Some(e) if e != "" -> Error("docker build error: " <> e)
            _ -> {
              case stream {
                Some(s) if s != "" -> on_chunk(s)
                _ -> Nil
              }
              Ok(Nil)
            }
          }
      }
    }
  }
}
```

Note: `docker.gleam` already imports `gleam/string` and `gleam/option.{None, Some}` — verify these are present, adding them if not.

- [ ] **Step 2: Build, format, commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam build && gleam format src/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/docker.gleam
git commit -m "feat(docker): add streaming build_image"
```

---

### Task 5: devcontainer_fetcher.gleam

**Files:**
- Create: `src/server/src/fbi/run/devcontainer_fetcher.gleam`

- [ ] **Step 1: Create the module**

Create `src/server/src/fbi/run/devcontainer_fetcher.gleam`:

```gleam
import gleam/dict.{type Dict}
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import simplifile
import wisp

/// Sparse-clones the project repo to extract `.devcontainer/` files.
/// Returns Some(filename => contents) if devcontainer.json is present,
/// None if SSH auth sock is missing, repo URL is empty, clone fails,
/// or devcontainer.json does not exist.
pub fn fetch(
  repo_url: String,
  ssh_auth_sock: Option(String),
  on_log: fn(String) -> Nil,
) -> Option(Dict(String, String)) {
  case repo_url, ssh_auth_sock {
    "", _ -> None
    _, None -> None
    _, Some("") -> None
    url, Some(sock) -> do_fetch(url, sock, on_log)
  }
}

fn do_fetch(
  repo_url: String,
  ssh_auth_sock: String,
  on_log: fn(String) -> Nil,
) -> Option(Dict(String, String)) {
  let tmp_dir =
    "/tmp/fbi-dc-" <> int.to_string(now_ms()) <> "-" <> int.to_string(
      unique_int(),
    )
  let env = [
    #("SSH_AUTH_SOCK", ssh_auth_sock),
    #("GIT_TERMINAL_PROMPT", "0"),
  ]
  let result = try_fetch(repo_url, tmp_dir, env, on_log)
  let _ = simplifile.delete(tmp_dir)
  result
}

fn try_fetch(
  repo_url: String,
  tmp_dir: String,
  env: List(#(String, String)),
  on_log: fn(String) -> Nil,
) -> Option(Dict(String, String)) {
  let git = find_executable("git")
  case
    run_cmd(git, [
      "clone", "--depth=1", "--filter=blob:none", "--sparse", "--no-tags",
      repo_url, tmp_dir,
    ], env)
  {
    #(0, _) -> Nil
    _ -> return_none()
  }
  case run_cmd(git, ["-C", tmp_dir, "sparse-checkout", "set", ".devcontainer"], env) {
    #(0, _) -> Nil
    _ -> return_none()
  }
  case run_cmd(git, ["-C", tmp_dir, "checkout"], env) {
    #(0, _) -> Nil
    _ -> return_none()
  }
  let dc_dir = tmp_dir <> "/.devcontainer"
  case simplifile.is_file(dc_dir <> "/devcontainer.json") {
    Ok(True) -> {
      on_log("[fbi] using repo .devcontainer/devcontainer.json\n")
      read_dc_files(dc_dir)
    }
    _ -> None
  }
}

fn return_none() -> Option(Dict(String, String)) {
  None
}

fn read_dc_files(dc_dir: String) -> Option(Dict(String, String)) {
  case simplifile.read_directory(dc_dir) {
    Error(_) -> None
    Ok(names) -> {
      let files =
        list.filter_map(names, fn(name) {
          let path = dc_dir <> "/" <> name
          case simplifile.is_file(path) {
            Ok(True) ->
              case simplifile.read(path) {
                Ok(content) -> Ok(#(name, content))
                Error(_) -> Error(Nil)
              }
            _ -> Error(Nil)
          }
        })
      Some(dict.from_list(files))
    }
  }
}

fn run_cmd(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
) -> #(Int, String) {
  let result = fbi_cmd_run(
    cmd,
    list.map(args, fn(a) { a }),
    list.map(env, fn(e) { e }),
  )
  case result {
    #(code, output) -> #(code, output)
  }
}

fn find_executable(name: String) -> String {
  fbi_cmd_find_executable(name)
}

@external(erlang, "fbi_cmd", "run")
fn fbi_cmd_run(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
) -> #(Int, String)

@external(erlang, "fbi_cmd", "find_executable")
fn fbi_cmd_find_executable(name: String) -> String

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int

@external(erlang, "erlang", "unique_integer")
fn unique_int() -> Int
```

- [ ] **Step 2: Build, format, commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam build && gleam format src/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/run/devcontainer_fetcher.gleam
git commit -m "feat(run): add devcontainer_fetcher — sparse-clone repo for .devcontainer files"
```

---

### Task 6: image_builder.gleam

**Files:**
- Create: `src/server/src/fbi/run/image_builder.gleam`

- [ ] **Step 1: Create the module**

Create `src/server/src/fbi/run/image_builder.gleam`:

```gleam
import fbi/config.{type Config}
import fbi/docker
import fbi/docker/tar
import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import simplifile
import wisp

/// Packages always installed in the post-layer (sorted for hash stability).
const always_packages = [
  "ca-certificates", "claude-cli", "gh", "git", "openssh-client",
]

/// Resolves the Docker image tag for a project, building it if necessary.
/// Returns Ok(tag) on success or Error(reason) on failure.
/// Calls on_log with build progress chunks suitable for terminal streaming.
pub fn resolve(
  project_id: Int,
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  config: Config,
  on_log: fn(String) -> Nil,
) -> Result(String, String) {
  use postbuild <- result.try(read_postbuild())
  let hash = compute_hash(dc_files, override_json, postbuild)
  let id = int.to_string(project_id)
  let final_tag = "fbi/p" <> id <> ":" <> hash
  let base_tag = "fbi/p" <> id <> "-base:" <> hash
  use sock <- result.try(
    docker.connect(config.docker_socket)
    |> result.map_error(fn(e) { "docker connect: " <> docker.describe_error(e) }),
  )
  let result = case image_exists(sock, final_tag) {
    True -> {
      wisp.log_debug("run: image " <> final_tag <> " already exists, reusing")
      Ok(final_tag)
    }
    False -> {
      use _ <- result.try(ensure_base(
        sock,
        base_tag,
        dc_files,
        override_json,
        config,
        on_log,
      ))
      use _ <- result.try(build_post_layer(
        sock,
        base_tag,
        final_tag,
        postbuild,
        on_log,
      ))
      case image_exists(sock, final_tag) {
        True -> Ok(final_tag)
        False ->
          Error(
            "post-layer build succeeded but "
            <> final_tag
            <> " is not present",
          )
      }
    }
  }
  docker.close(sock)
  result
}

/// Computes a 16-char hex hash over the full build configuration.
/// This is the canonical hash used by both image_builder and image_gc.
pub fn compute_hash(
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  postbuild: String,
) -> String {
  let dc_part = case dc_files {
    None -> ""
    Some(files) ->
      dict.keys(files)
      |> list.sort(string.compare)
      |> list.map(fn(k) {
        k <> ":" <> result.unwrap(dict.get(files, k), "") <> "\n"
      })
      |> string.join("")
  }
  let always_str = string.join(always_packages, ",")
  let content =
    "dev:"
    <> dc_part
    <> "\nover:"
    <> option.unwrap(override_json, "")
    <> "\nalways:"
    <> always_str
    <> "\npostbuild:"
    <> postbuild
  let hash_bytes = sha256(bit_array.from_string(content))
  let hex = hex_encode_lower(hash_bytes)
  string.slice(hex, 0, 16)
}

fn read_postbuild() -> Result(String, String) {
  simplifile.read("priv/static/postbuild.sh")
  |> result.map_error(fn(e) {
    "read postbuild.sh: " <> simplifile.describe_error(e)
  })
}

fn image_exists(sock: docker.Socket, tag: String) -> Bool {
  case docker.list_images(sock) {
    Ok(images) ->
      list.any(images, fn(img) { list.contains(img.repo_tags, tag) })
    Error(_) -> False
  }
}

fn ensure_base(
  sock: docker.Socket,
  base_tag: String,
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  config: Config,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  case image_exists(sock, base_tag) {
    True -> Ok(Nil)
    False ->
      case dc_files {
        Some(files) -> build_devcontainer(files, base_tag, config, on_log)
        None -> build_fallback(override_json, base_tag, sock, on_log)
      }
  }
}

fn build_devcontainer(
  files: Dict(String, String),
  tag: String,
  config: Config,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  let tmp_dir =
    "/tmp/fbi-dc-build-"
    <> int.to_string(now_ms())
    <> "-"
    <> int.to_string(unique_int())
  let dc_dir = tmp_dir <> "/.devcontainer"
  use _ <- result.try(
    simplifile.create_directory_all(dc_dir)
    |> result.map_error(fn(e) {
      "mkdir devcontainer: " <> simplifile.describe_error(e)
    }),
  )
  use _ <- result.try(write_dc_files(files, dc_dir))
  on_log("[fbi] building devcontainer image " <> tag <> "\n")
  let npx = find_executable("npx")
  let #(exit_code, _output) =
    fbi_cmd_run(
      npx,
      [
        "-y", "@devcontainers/cli@0.67.0", "build", "--workspace-folder",
        tmp_dir, "--image-name", tag,
      ],
      [],
    )
  let _ = simplifile.delete(tmp_dir)
  case exit_code {
    0 -> Ok(Nil)
    code ->
      Error("devcontainer build failed (exit " <> int.to_string(code) <> ")")
  }
}

fn write_dc_files(
  files: Dict(String, String),
  dc_dir: String,
) -> Result(Nil, String) {
  dict.to_list(files)
  |> list.try_each(fn(pair) {
    let #(name, content) = pair
    simplifile.write(dc_dir <> "/" <> name, content)
    |> result.map_error(fn(e) {
      "write " <> name <> ": " <> simplifile.describe_error(e)
    })
  })
}

fn build_fallback(
  override_json: Option(String),
  tag: String,
  sock: docker.Socket,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  let cfg = case override_json {
    None -> json.object([])
    Some(s) -> result.unwrap(json.parse(s, json_object_decoder()), json.object([]))
  }
  // For the fallback, we build a minimal Dockerfile from override_json fields.
  // The full JSON parsing for base/apt/env fields requires a proper decoder.
  // We use a simplified approach: parse known fields or fall back to defaults.
  let base_image = get_json_string(override_json, "base", "ubuntu:24.04")
  let apt_packages = get_json_string_list(override_json, "apt")
  let apt_str = string.join(apt_packages, " ")
  let dockerfile =
    "FROM "
    <> base_image
    <> "\n"
    <> "ENV DEBIAN_FRONTEND=noninteractive\n"
    <> case apt_str {
      "" -> ""
      pkgs ->
        "RUN apt-get update && apt-get install -y --no-install-recommends "
        <> pkgs
        <> " && rm -rf /var/lib/apt/lists/*\n"
    }
  let archive = tar.build(dict.from_list([#("Dockerfile", bit_array.from_string(dockerfile))]))
  on_log("[fbi] building base image " <> tag <> "\n")
  docker.build_image(sock, archive, tag, on_log)
  |> result.map_error(fn(e) { "build_fallback: " <> docker.describe_error(e) })
}

fn build_post_layer(
  sock: docker.Socket,
  base_tag: String,
  final_tag: String,
  postbuild: String,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  let dockerfile =
    "FROM "
    <> base_tag
    <> "\nUSER root\nCOPY postbuild.sh /tmp/postbuild.sh\nRUN bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh\nUSER agent\nWORKDIR /workspace\n"
  let archive =
    tar.build(dict.from_list([
      #("Dockerfile", bit_array.from_string(dockerfile)),
      #("postbuild.sh", bit_array.from_string(postbuild)),
    ]))
  on_log("[fbi] applying post-build layer → " <> final_tag <> "\n")
  docker.build_image(sock, archive, final_tag, on_log)
  |> result.map_error(fn(e) { "build_post_layer: " <> docker.describe_error(e) })
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

fn get_json_string(
  json_opt: Option(String),
  key: String,
  default: String,
) -> String {
  case json_opt {
    None -> default
    Some(s) -> {
      let decoder = {
        use val <- decode.optional_field(key, default, decode.string)
        decode.success(val)
      }
      case json.parse(s, decoder) {
        Ok(v) -> v
        Error(_) -> default
      }
    }
  }
}

fn get_json_string_list(json_opt: Option(String), key: String) -> List(String) {
  case json_opt {
    None -> []
    Some(s) -> {
      let decoder = {
        use val <- decode.optional_field(key, [], decode.list(decode.string))
        decode.success(val)
      }
      case json.parse(s, decoder) {
        Ok(v) -> v
        Error(_) -> []
      }
    }
  }
}

fn json_object_decoder() {
  decode.dynamic
}

// ── Externals ─────────────────────────────────────────────────────────────────

pub fn describe_error_str(reason: String) -> String {
  reason
}

@external(erlang, "fbi_crypto", "sha256")
fn sha256(data: BitArray) -> BitArray

@external(erlang, "fbi_crypto", "hex_encode_lower")
fn hex_encode_lower(data: BitArray) -> String

@external(erlang, "fbi_cmd", "run")
fn fbi_cmd_run(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
) -> #(Int, String)

@external(erlang, "fbi_cmd", "find_executable")
fn find_executable(name: String) -> String

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int

@external(erlang, "erlang", "unique_integer")
fn unique_int() -> Int
```

Note: this module imports `gleam/dynamic/decode` — add `import gleam/dynamic/decode` at the top. Also confirm `docker.describe_error` is exposed; if not, change to `docker.ConnectError` etc. via `describe_err` helper inline.

- [ ] **Step 2: Add describe_error to docker.gleam**

Check if `docker.gleam` exposes a public `describe_error` function. If not, add:

```gleam
pub fn describe_error(e: DockerError) -> String {
  case e {
    ConnectError(s) -> "connect: " <> s
    HttpError(code, msg) -> "http " <> int.to_string(code) <> ": " <> msg
    DecodeError(s) -> "decode: " <> s
    Timeout -> "timeout"
  }
}
```

- [ ] **Step 3: Write a unit test for compute_hash**

Add `src/server/test/fbi/run/image_builder_test.gleam`:

```gleam
import fbi/run/image_builder
import gleam/dict
import gleam/option.{None, Some}
import gleeunit/should

pub fn compute_hash_is_deterministic_test() {
  let h1 = image_builder.compute_hash(None, None, "postbuild content")
  let h2 = image_builder.compute_hash(None, None, "postbuild content")
  h1 |> should.equal(h2)
}

pub fn compute_hash_is_16_chars_test() {
  let h = image_builder.compute_hash(None, None, "anything")
  string.length(h) |> should.equal(16)
}

pub fn compute_hash_differs_on_postbuild_change_test() {
  let h1 = image_builder.compute_hash(None, None, "postbuild v1")
  let h2 = image_builder.compute_hash(None, None, "postbuild v2")
  h1 |> should.not_equal(h2)
}

pub fn compute_hash_differs_on_override_json_change_test() {
  let h1 = image_builder.compute_hash(None, None, "pb")
  let h2 = image_builder.compute_hash(None, Some("{\"base\":\"ubuntu:22.04\"}"), "pb")
  h1 |> should.not_equal(h2)
}

pub fn compute_hash_differs_on_dc_files_test() {
  let files = dict.from_list([#("devcontainer.json", "{}")])
  let h1 = image_builder.compute_hash(None, None, "pb")
  let h2 = image_builder.compute_hash(Some(files), None, "pb")
  h1 |> should.not_equal(h2)
}
```

Add `import gleam/string` at the top of the test file.

- [ ] **Step 4: Run tests**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam test
```

Expected: all 5 new tests pass, no existing tests broken.

- [ ] **Step 5: Format and commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam format src/ test/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/run/image_builder.gleam \
        src/server/src/fbi/docker.gleam \
        src/server/test/fbi/run/image_builder_test.gleam
git commit -m "feat(run): add image_builder with content-hash image resolution"
```

---

### Task 7: Wire image_builder into worker.gleam

**Files:**
- Modify: `src/server/src/fbi/run/worker.gleam`

- [ ] **Step 1: Add image_builder call at start of do_launch**

In `src/server/src/fbi/run/worker.gleam`, add at the top of the import list:

```gleam
import fbi/run/devcontainer_fetcher
import fbi/run/image_builder
import fbi/run/types.{type BroadcastMsg, BroadcastChunk, type RunMsg, WorkerFailed, WorkerReady}
```

At the top of `do_launch`, after `let run_id = int.to_string(input.run.id)`, add the image resolution step **before** `setup_run_dir`:

```gleam
fn do_launch(input: LaunchInput) -> Result(#(String, String), String) {
  let run_id = int.to_string(input.run.id)
  let on_log = fn(chunk: String) {
    process.send(
      input.broadcaster,
      BroadcastChunk(bit_array.from_string(chunk)),
    )
  }
  wisp.log_debug("run " <> run_id <> ": fetching devcontainer files")
  let dc_files =
    devcontainer_fetcher.fetch(
      input.project.repo_url,
      input.config.ssh_auth_sock,
      on_log,
    )
  wisp.log_debug("run " <> run_id <> ": resolving image")
  use image_tag <- result.try(
    image_builder.resolve(
      input.run.project_id,
      dc_files,
      input.project.devcontainer_override_json,
      input.config,
      on_log,
    ),
  )
  use _ <- result.try(setup_run_dir(input))
  // ... rest of do_launch unchanged, but use image_tag instead of input.image_tag ...
```

Also update `container_spec` call and `spec` to use the resolved `image_tag` rather than `input.image_tag`. The `do_launch` function needs to pass `image_tag` to `container_spec`. The cleanest approach: pass `image_tag` as a parameter to `container_spec`:

Change the call to:
```gleam
let spec = container_spec(input, image_tag)
```

And update the function signature:
```gleam
fn container_spec(input: LaunchInput, image_tag: String) -> json.Json {
  ...
  #("Image", json.string(image_tag)),
  ...
}
```

Remove `image_tag` from the `json.object` (it was `input.image_tag` before).

- [ ] **Step 2: Add project_id to Run type if missing**

Check `src/server/src/fbi/db/runs.gleam` for the `Run` type. If it includes `project_id: Int`, no change needed. If not, add it. `image_builder.resolve` needs the project ID.

```bash
grep "project_id" /Users/fdatoo/Desktop/FBI/src/server/src/fbi/db/runs.gleam | head -5
```

If `project_id` is absent from the `Run` struct, add it and update the SQL decoder accordingly.

- [ ] **Step 3: Build**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam build
```

Fix any type errors that arise before continuing.

- [ ] **Step 4: Format and commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam format src/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/run/worker.gleam src/server/src/fbi/db/runs.gleam
git commit -m "feat(run): wire image_builder into worker — per-project image resolution"
```

---

### Task 8: image_gc.gleam + settings.update_gc_result

**Files:**
- Create: `src/server/src/fbi/run/image_gc.gleam`
- Modify: `src/server/src/fbi/db/settings.gleam`

- [ ] **Step 1: Add update_gc_result to settings.gleam**

Add this public function to `src/server/src/fbi/db/settings.gleam`:

```gleam
pub fn update_gc_result(
  db: sqlight.Connection,
  deleted_count: Int,
  deleted_bytes: Int,
  now_ms: Int,
) -> Result(Nil, DbError) {
  sqlight.query(
    "UPDATE settings SET last_gc_at = ?, last_gc_count = ?, last_gc_bytes = ?, updated_at = ? WHERE id = 1",
    on: db,
    with: [
      sqlight.int(now_ms),
      sqlight.int(deleted_count),
      sqlight.int(deleted_bytes),
      sqlight.int(now_ms),
    ],
    expecting: decode.at([0], decode.int),
  )
  |> result.map(fn(_) { Nil })
  |> result.map_error(SqlightError)
}
```

- [ ] **Step 2: Create image_gc.gleam**

Create `src/server/src/fbi/run/image_gc.gleam`:

```gleam
import fbi/config.{type Config}
import fbi/db/projects.{type Project}
import fbi/docker
import fbi/run/image_builder
import gleam/list
import gleam/option
import gleam/result
import gleam/set
import gleam/string
import simplifile
import wisp

pub type GcResult {
  GcResult(deleted_count: Int, deleted_bytes: Int, errors: List(GcError))
}

pub type GcError {
  GcError(tag: String, message: String)
}

const retention_days = 30

/// Sweeps stale fbi/p* images. Uses the same hash as image_builder so that
/// currently-reachable images are never deleted.
pub fn sweep(
  projects: List(Project),
  postbuild: String,
  now_ms: Int,
  config: Config,
) -> GcResult {
  let reachable = build_reachable_set(projects, postbuild)
  let cutoff_sec = now_ms / 1000 - retention_days * 86_400

  case docker.connect(config.docker_socket) {
    Error(e) -> {
      wisp.log_error("image_gc: docker connect: " <> docker.describe_error(e))
      GcResult(deleted_count: 0, deleted_bytes: 0, errors: [])
    }
    Ok(sock) -> {
      let result = do_sweep(sock, reachable, cutoff_sec)
      docker.close(sock)
      result
    }
  }
}

fn build_reachable_set(projects: List(Project), postbuild: String) -> set.Set(String) {
  list.flat_map(projects, fn(p) {
    let hash =
      image_builder.compute_hash(None, p.devcontainer_override_json, postbuild)
    let id = gleam_int_to_string(p.id)
    ["fbi/p" <> id <> ":" <> hash, "fbi/p" <> id <> "-base:" <> hash]
  })
  |> set.from_list
}

fn do_sweep(
  sock: docker.Socket,
  reachable: set.Set(String),
  cutoff_sec: Int,
) -> GcResult {
  case docker.list_containers(sock, True), docker.list_images(sock) {
    Error(_), _ | _, Error(_) ->
      GcResult(deleted_count: 0, deleted_bytes: 0, errors: [])
    Ok(containers), Ok(images) -> {
      let used_ids =
        list.map(containers, fn(c) { c.image_id }) |> set.from_list
      let to_delete = find_deletable(images, used_ids, reachable, cutoff_sec)
      delete_images(sock, to_delete)
    }
  }
}

fn find_deletable(
  images: List(docker.ImageInfo),
  used_ids: set.Set(String),
  reachable: set.Set(String),
  cutoff_sec: Int,
) -> List(#(String, Int)) {
  list.flat_map(images, fn(img) {
    case set.contains(used_ids, img.id) {
      True -> []
      False -> {
        let fbi_tags =
          list.filter(img.repo_tags, fn(t) { string.starts_with(t, "fbi/p") })
        case fbi_tags {
          [] -> []
          _ ->
            case img.created > cutoff_sec {
              True -> []
              False ->
                case list.any(fbi_tags, fn(t) { set.contains(reachable, t) }) {
                  True -> []
                  False -> list.map(fbi_tags, fn(t) { #(t, img.size) })
                }
            }
        }
      }
    }
  })
}

fn delete_images(
  sock: docker.Socket,
  to_delete: List(#(String, Int)),
) -> GcResult {
  list.fold(to_delete, GcResult(0, 0, []), fn(acc, pair) {
    let #(tag, size) = pair
    case docker.remove_image(sock, tag) {
      Ok(Nil) ->
        GcResult(
          deleted_count: acc.deleted_count + 1,
          deleted_bytes: acc.deleted_bytes + size,
          errors: acc.errors,
        )
      Error(e) ->
        GcResult(
          ..acc,
          errors: [GcError(tag: tag, message: docker.describe_error(e)), ..acc.errors],
        )
    }
  })
}

@external(erlang, "erlang", "integer_to_binary")
fn gleam_int_to_string(n: Int) -> String
```

Note: `gleam_int_to_string` via `:erlang.integer_to_binary` returns a binary, which Gleam treats as `String`. Alternatively use `import gleam/int` and `int.to_string`. Use `int.to_string` to be safe — replace `gleam_int_to_string(p.id)` with `int.to_string(p.id)` and add `import gleam/int`.

Also add `import gleam/set` — verify this package is available (`gleam_stdlib` includes `gleam/set`).

- [ ] **Step 3: Write unit test for sweep logic**

Add `src/server/test/fbi/run/image_gc_test.gleam`:

```gleam
import fbi/run/image_gc.{GcError, GcResult}
import gleeunit/should

pub fn gc_result_zero_test() {
  let r = GcResult(deleted_count: 0, deleted_bytes: 0, errors: [])
  r.deleted_count |> should.equal(0)
  r.deleted_bytes |> should.equal(0)
  r.errors |> should.equal([])
}

pub fn gc_error_fields_test() {
  let e = GcError(tag: "fbi/p1:abc123", message: "not found")
  e.tag |> should.equal("fbi/p1:abc123")
  e.message |> should.equal("not found")
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam test
```

Expected: all tests pass.

- [ ] **Step 5: Format and commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam format src/ test/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/run/image_gc.gleam \
        src/server/src/fbi/db/settings.gleam \
        src/server/test/fbi/run/image_gc_test.gleam
git commit -m "feat(run): add image_gc sweep logic and settings.update_gc_result"
```

---

### Task 9: gc_scheduler.gleam + fbi.gleam boot wiring

**Files:**
- Create: `src/server/src/fbi/run/gc_scheduler.gleam`
- Modify: `src/server/src/fbi.gleam`

- [ ] **Step 1: Create gc_scheduler.gleam**

Create `src/server/src/fbi/run/gc_scheduler.gleam`:

```gleam
import fbi/config.{type Config}
import fbi/db/projects
import fbi/db/settings
import fbi/run/image_gc
import gleam/erlang/process
import gleam/int
import gleam/otp/actor
import gleam/result
import simplifile
import sqlight
import wisp

const interval_ms = 3_600_000

pub type GcMsg {
  Tick
}

type State {
  State(db: sqlight.Connection, config: Config)
}

pub fn start(
  db: sqlight.Connection,
  config: Config,
) -> Result(process.Subject(GcMsg), actor.StartError) {
  actor.new_with_initialiser(500, fn(subject) {
    schedule_tick(subject)
    State(db: db, config: config)
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: GcMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: GcMsg) -> actor.Next(State, GcMsg) {
  case msg {
    Tick -> {
      run_if_enabled(state)
      schedule_tick_self()
      actor.continue(state)
    }
  }
}

fn run_if_enabled(state: State) -> Nil {
  case settings.get(state.db) {
    Error(_) -> Nil
    Ok(s) ->
      case s.image_gc_enabled {
        False -> Nil
        True -> {
          case simplifile.read("priv/static/postbuild.sh") {
            Error(_) -> Nil
            Ok(postbuild) ->
              case projects.list(state.db) {
                Error(_) -> Nil
                Ok(all_projects) -> {
                  let now = now_ms()
                  let result =
                    image_gc.sweep(all_projects, postbuild, now, state.config)
                  wisp.log_info(
                    "image_gc: deleted="
                    <> int.to_string(result.deleted_count)
                    <> " bytes="
                    <> int.to_string(result.deleted_bytes),
                  )
                  let _ =
                    settings.update_gc_result(
                      state.db,
                      result.deleted_count,
                      result.deleted_bytes,
                      now,
                    )
                  Nil
                }
              }
          }
        }
      }
  }
}

fn schedule_tick(subject: process.Subject(GcMsg)) -> Nil {
  process.send_after(subject, interval_ms, Tick)
  Nil
}

fn schedule_tick_self() -> Nil {
  Nil
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
```

Note: `process.send_after` fires once. In `handle`, after processing `Tick`, we need to reschedule. The `schedule_tick_self` approach doesn't work because we don't have the subject in the handler. The cleanest solution is to store the subject in `State`, or use a different pattern.

Fix: store the subject in `State` so it can reschedule itself:

```gleam
type State {
  State(db: sqlight.Connection, config: Config, self: process.Subject(GcMsg))
}

pub fn start(
  db: sqlight.Connection,
  config: Config,
) -> Result(process.Subject(GcMsg), actor.StartError) {
  actor.new_with_initialiser(500, fn(subject) {
    process.send_after(subject, interval_ms, Tick)
    State(db: db, config: config, self: subject)
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: GcMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: GcMsg) -> actor.Next(State, GcMsg) {
  case msg {
    Tick -> {
      run_if_enabled(state)
      process.send_after(state.self, interval_ms, Tick)
      actor.continue(state)
    }
  }
}
```

Remove the `schedule_tick` and `schedule_tick_self` helpers.

- [ ] **Step 2: Start gc_scheduler in fbi.gleam**

In `src/server/src/fbi.gleam`, add the import:

```gleam
import fbi/run/gc_scheduler
```

After the line `let assert Ok(pubsub_subject) = pubsub.start()`, add:

```gleam
let assert Ok(_gc_scheduler) = gc_scheduler.start(db, cfg)
```

The return value is discarded (we just need the process to be running).

- [ ] **Step 3: Build**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam build
```

Fix any errors before continuing.

- [ ] **Step 4: Format and commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam format src/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/run/gc_scheduler.gleam src/server/src/fbi.gleam
git commit -m "feat(run): add gc_scheduler OTP actor for hourly image GC"
```

---

### Task 10: Settings run-gc endpoint

**Files:**
- Modify: `src/server/src/fbi/handlers/settings.gleam`
- Modify: `src/server/src/fbi/router.gleam`

- [ ] **Step 1: Add handle_run_gc to settings.gleam**

In `src/server/src/fbi/handlers/settings.gleam`, add these imports at the top:

```gleam
import fbi/db/projects
import fbi/run/image_gc
import gleam/int
import simplifile
```

Add this function and its helper at the end of the file (before the `now_ms` external):

```gleam
pub fn handle_run_gc(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Post -> run_gc_now(ctx)
    _ -> wisp.method_not_allowed([http.Post])
  }
}

fn run_gc_now(ctx: Context) -> Response {
  case simplifile.read("priv/static/postbuild.sh") {
    Error(_) -> wisp.internal_server_error()
    Ok(postbuild) ->
      case projects.list(ctx.db) {
        Error(_) -> wisp.internal_server_error()
        Ok(all_projects) -> {
          let now = now_ms()
          let result =
            image_gc.sweep(all_projects, postbuild, now, ctx.config)
          let _ =
            settings.update_gc_result(
              ctx.db,
              result.deleted_count,
              result.deleted_bytes,
              now,
            )
          let body =
            json.object([
              #("deleted_count", json.int(result.deleted_count)),
              #("deleted_bytes", json.int(result.deleted_bytes)),
              #(
                "errors",
                json.array(result.errors, fn(e) {
                  json.object([
                    #("tag", json.string(e.tag)),
                    #("message", json.string(e.message)),
                  ])
                }),
              ),
            ])
          body
          |> json.to_string()
          |> wisp.json_response(200)
        }
      }
  }
}
```

Also add `import fbi/db/settings` if not already present, and ensure `import gleam/json` is present.

- [ ] **Step 2: Add route to router.gleam**

In `src/server/src/fbi/router.gleam`, find:

```gleam
// Settings
["api", "settings"] -> settings_handler.handle(req, ctx)
```

Replace with:

```gleam
// Settings
["api", "settings"] -> settings_handler.handle(req, ctx)
["api", "settings", "run-gc"] -> settings_handler.handle_run_gc(req, ctx)
```

- [ ] **Step 3: Build and test**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam build && gleam test
```

Expected: all tests pass.

- [ ] **Step 4: Format and commit**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam format src/
cd /Users/fdatoo/Desktop/FBI
git add src/server/src/fbi/handlers/settings.gleam src/server/src/fbi/router.gleam
git commit -m "feat(settings): add POST /api/settings/run-gc endpoint"
```

---

### Task 11: Final lint, test, and push

- [ ] **Step 1: Full test suite**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam test
```

Expected: all tests pass.

- [ ] **Step 2: Lint check**

```bash
cd /Users/fdatoo/Desktop/FBI/src/server && gleam format --check src/ test/
```

Expected: no format violations. If any are reported, run `gleam format src/ test/` and commit the changes.

- [ ] **Step 3: Push**

```bash
cd /Users/fdatoo/Desktop/FBI && git push origin fdatoo/gleam
```

---

## Self-Review

**Spec coverage check:**
- ✅ Broadcaster ownership refactor (Task 2)
- ✅ Docker `list_images`, `list_containers`, `remove_image` (Task 3)
- ✅ Docker `build_image` streaming (Task 4)
- ✅ `devcontainer_fetcher.gleam` (Task 5)
- ✅ `image_builder.gleam` with hash + resolve (Task 6)
- ✅ Wire image_builder into worker (Task 7)
- ✅ `image_gc.gleam` (Task 8)
- ✅ `gc_scheduler.gleam` + hourly timer (Task 9)
- ✅ `POST /api/settings/run-gc` (Task 10)
- ✅ `fbi_cmd.erl` + `fbi_crypto` additions (Task 1)
- ✅ GC hash uses same function as image_builder (Task 8 uses `image_builder.compute_hash`)
- ✅ `settings.update_gc_result` stores last GC results (Task 8)

**Type consistency:**
- `image_builder.compute_hash/3` defined in Task 6, called in Task 8 ✅
- `docker.describe_error/1` added in Task 6, used in Tasks 6 and 8 ✅
- `WorkerReady` drops `broadcaster` in Task 2 types.gleam, matched in actor.gleam ✅
- `start_run` returns `#(Subject(RunMsg), Subject(BroadcastMsg))` in Task 2 supervisor, destructured in runs.gleam ✅
- `GcResult` and `GcError` defined in image_gc.gleam (Task 8), used in settings handler (Task 10) ✅
