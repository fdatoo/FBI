# Reattach on Boot — Implementation Plan

> **Spec:** `docs/superpowers/specs/2026-04-29-reattach-on-boot-design.md`

**Goal:** Make non-terminal runs survive a server restart. Persist `container_id`, write transcripts to disk, serve them with `Range`, generate snapshots that let the client load history, and on boot reconnect or clean up every non-terminal run. Add an auto-resume scheduler.

**Tech Stack:** Gleam (server), Erlang (FFI for file I/O), TypeScript (client untouched — already calls these endpoints).

**Branch convention:** continue on `fdatoo/gleam`. Each task ends with a commit.

---

## Task 1 — Persist `container_id` to DB

**Files:**
- Modify: `src/server/src/fbi/db/runs.gleam` — add `mark_running`
- Modify: `src/server/src/fbi/run/actor.gleam` — call `mark_running` instead of `mark_state`

**Step 1.1: Add `mark_running` to runs.gleam.** Place it next to `mark_state`. Replaces state, container_id, and state_entered_at atomically.

```gleam
pub fn mark_running(
  db: sqlight.Connection,
  id: Int,
  container_id: String,
  now: Int,
) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET state = 'running', container_id = ?, state_entered_at = ?, started_at = COALESCE(started_at, ?)
     WHERE id = ? RETURNING " <> columns(),
    db,
    [sqlight.text(container_id), sqlight.int(now), sqlight.int(now), sqlight.int(id)],
    decoder(),
  )
}
```

**Step 1.2: Update actor.transition_to_running** — replace `runs_db.mark_state(state.db, state.run_id, "running", now_ms())` with `runs_db.mark_running(state.db, state.run_id, cid, now_ms())`.

**Step 1.3: Build and run tests.**
- `gleam build`
- `gleam test`
- Expected: all 32 tests pass.

**Step 1.4: Commit.**
```
fix(run): persist container_id when transitioning to running

Without this, a server restart could not find the Docker containers
that belong to in-flight runs.
```

---

## Task 2 — Write transcript to disk

**Files:**
- Modify: `src/server/src/fbi/run/container_monitor.gleam`
- Add: `src/server/src/fbi_file_writer.erl` — small Erlang FFI for file append (Gleam's `simplifile.append_bits` reopens the file on every call; we want a persistent handle)

**Step 2.1: Add the Erlang FFI.** Create `src/server/src/fbi_file_writer.erl`:

```erlang
-module(fbi_file_writer).
-export([open/1, append/2, close/1]).

open(Path) when is_binary(Path) ->
    PathStr = binary_to_list(Path),
    case file:open(PathStr, [append, raw, binary]) of
        {ok, IoDevice} -> {ok, IoDevice};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

append(IoDevice, Data) ->
    case file:write(IoDevice, Data) of
        ok -> {ok, nil};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

close(IoDevice) -> file:close(IoDevice), nil.
```

**Step 2.2: Wrap the FFI in a Gleam module.** Add at the top of `container_monitor.gleam`:

```gleam
@external(erlang, "fbi_file_writer", "open")
fn file_open(path: BitArray) -> Result(Dynamic, String)

@external(erlang, "fbi_file_writer", "append")
fn file_append(handle: Dynamic, data: BitArray) -> Result(Nil, String)

@external(erlang, "fbi_file_writer", "close")
fn file_close(handle: Dynamic) -> Nil
```

(Add `import gleam/dynamic.{type Dynamic}` if not already imported.)

**Step 2.3: Wire the writer into the attach reader process.** In `connect_and_attach`, before spawning the reader, open the transcript file. Inside the reader callback, append every chunk to the file in addition to broadcasting. On stream end, close the handle.

```gleam
fn connect_and_attach(
  config: Config,
  cid: String,
  run_id: Int,
  broadcaster: Subject(BroadcastMsg),
) -> Result(docker.Socket, docker.DockerError) {
  use sock <- result.try(docker.connect(config.docker_socket))
  case docker.start_bidirectional_attach(sock, cid) {
    Error(e) -> {
      docker.close(sock)
      Error(e)
    }
    Ok(initial_bytes) -> {
      let transcript_path =
        config.runs_dir <> "/" <> int.to_string(run_id) <> "/transcript.log"
      let writer = case file_open(bit_array.from_string(transcript_path)) {
        Ok(h) -> Some(h)
        Error(reason) -> {
          wisp.log_warning(
            "transcript open failed for " <> transcript_path <> ": " <> reason,
          )
          None
        }
      }
      process.spawn_unlinked(fn() {
        let _ =
          docker.stream_raw_output(sock, initial_bytes, fn(chunk) {
            case writer {
              Some(h) -> {
                let _ = file_append(h, chunk)
                Nil
              }
              None -> Nil
            }
            process.send(broadcaster, BroadcastChunk(chunk))
          })
        case writer {
          Some(h) -> file_close(h)
          None -> Nil
        }
      })
      Ok(sock)
    }
  }
}
```

Note: `container_monitor.start` currently doesn't take `run_id` for `connect_and_attach` — it's passed only to `wait_and_notify`. Pass it to both.

**Step 2.4: Update the call site in `actor.gleam`.** `transition_to_running` already calls `container_monitor.start(state.config, cid, state.run_id, state.actor_subject, bc)`. Verify the new signature still matches.

**Step 2.5: Build and test.**
- `make nif` (in case there's a make target for Erlang)
- `gleam build`
- `gleam test`

**Step 2.6: Manual verify.** Start a run via the API. Once it's running, check `/tmp/fbi-runs/{run_id}/transcript.log` — should be growing as the container writes output.

**Step 2.7: Commit.**
```
feat(run): write container output to transcript.log

Per-run transcript at {runs_dir}/{run_id}/transcript.log, written
by the attach reader. Append-only with one open file handle for the
duration of the container. Future history-replay endpoint reads from
this file.
```

---

## Task 3 — Add `byte_offset` to Snapshot type and JSON

**Files:**
- Modify: `src/server/src/fbi/run/types.gleam`
- Modify: `src/server/src/fbi/handlers/shell_ws.gleam`

**Step 3.1: Add the field.**

```gleam
// types.gleam
pub type TerminalEvent {
  TerminalChunk(data: BitArray)
  StateChanged(state: String)
  TitleChanged(title: String)
  Snapshot(ansi: String, cols: Int, rows: Int, byte_offset: Int)
}
```

**Step 3.2: Update the JSON encoder.** In `shell_ws.gleam`, the `mist.Custom(types.Snapshot(...))` arm gets the new field:

```gleam
mist.Custom(types.Snapshot(ansi, cols, rows, byte_offset)) -> {
  let body =
    json.object([
      #("type", json.string("snapshot")),
      #("ansi", json.string(ansi)),
      #("cols", json.int(cols)),
      #("rows", json.int(rows)),
      #("byte_offset", json.int(byte_offset)),
    ])
    |> json.to_string()
  let _ = mist.send_text_frame(conn, body)
  mist.continue(state)
}
```

**Step 3.3: Build.** Compiler will flag any unhandled construction of `Snapshot`. Fix.

**Step 3.4: Commit.**
```
feat(run): add byte_offset to Snapshot terminal event

Lets the client know the transcript size at snapshot time so it can
fetch the appropriate suffix range for history replay.
```

---

## Task 4 — Generate snapshot on Subscribe

**Files:**
- Modify: `src/server/src/fbi/run/actor.gleam`
- Add helper: read transcript file size

**Step 4.1: Add a helper to read transcript size.** In `actor.gleam`:

```gleam
fn transcript_size(config: Config, run_id: Int) -> Int {
  let path = config.runs_dir <> "/" <> int.to_string(run_id) <> "/transcript.log"
  case simplifile.file_info(path) {
    Ok(info) -> info.size
    Error(_) -> 0
  }
}
```

**Step 4.2: Send a Snapshot to each new subscriber.** In each `Subscribe(client)` arm of the `handle` function (Starting, Running, Waiting), after `process.send(bc, BroadcastSubscribe(client))`, also send a snapshot directly to that client:

```gleam
let cols_rows = case state.phase {
  Running(_, _, _, c, r) -> #(c, r)
  _ -> #(80, 24)
}
let #(cols, rows) = cols_rows
process.send(client, Snapshot(
  ansi: "",
  cols: cols,
  rows: rows,
  byte_offset: transcript_size(state.config, state.run_id),
))
```

Send directly to `client` (not `bc`) so only the new subscriber receives it.

**Step 4.3: Imports** — `import simplifile` and `Snapshot` from types.

**Step 4.4: Build, test, commit.**
```
feat(run): emit snapshot to new subscribers anchored to transcript size

Lets the client locate the suffix range it should fetch from the
transcript endpoint to replay history.
```

---

## Task 5 — Transcript HTTP endpoint with Range support

**Files:**
- Add: `src/server/src/fbi/handlers/transcript.gleam`
- Modify: `src/server/src/fbi/router.gleam`

**Step 5.1: Add the handler.** Skeleton:

```gleam
import fbi/context.{type Context}
import fbi/db/runs
import gleam/http
import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import simplifile
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get -> serve(req, ctx, id_str)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve(req: Request, ctx: Context, id_str: String) -> Response {
  use id <- with_id(id_str)
  let path = ctx.config.runs_dir <> "/" <> int.to_string(id) <> "/transcript.log"
  case simplifile.file_info(path) {
    Error(_) -> wisp.not_found()
    Ok(info) -> {
      let size = info.size
      case parse_range(req, size) {
        FullBody -> read_and_serve(path, 0, size, size, False)
        Range(start, end) -> read_and_serve(path, start, end - start + 1, size, True)
        Unsatisfiable -> {
          wisp.response(416)
          |> wisp.set_header("content-range", "bytes */" <> int.to_string(size))
        }
      }
    }
  }
}
```

with `parse_range` handling:
- No header → `FullBody`
- `bytes=START-END` → `Range(start, end)`
- `bytes=-N` (suffix) → `Range(max(0, size-N), size-1)`
- Out-of-range → `Unsatisfiable`

`read_and_serve` reads the byte range from the file and returns it with `200` (or `206` if `partial=True`), `Content-Type: application/octet-stream`, and a `Content-Range` header for partial responses.

**Step 5.2: Helper `with_id`** — parse `id_str` as Int, 400 if invalid (mirror existing handlers).

**Step 5.3: Wire into router.gleam.**

```gleam
["api", "runs", id, "transcript"] -> transcript_handler.handle(req, ctx, id)
```

**Step 5.4: Manual verify.**
- Create a run.
- Once running, `curl -i http://localhost:3000/api/runs/N/transcript -H 'Range: bytes=-1024'` — should return 206 with last 1024 bytes.
- `curl http://localhost:3000/api/runs/N/transcript | wc -c` — should equal file size.

**Step 5.5: Commit.**
```
feat(api): add GET /api/runs/:id/transcript with Range support

Serves the per-run transcript.log file. Supports byte ranges
(start-end and suffix -N) so the frontend's loadBoundedHistory can
fetch only the last 5 MB anchored to the snapshot's byte_offset.
```

---

## Task 6 — Boot reattach module

**Files:**
- Add: `src/server/src/fbi/run/reattach.gleam`
- Modify: `src/server/src/fbi.gleam` to call it

**Step 6.1: Add helpers to runs.gleam:**

```gleam
pub fn list_non_terminal(db: sqlight.Connection) -> Result(List(Run), DbError) {
  connection.query_all(
    select_sql <> " WHERE state IN ('queued', 'running', 'waiting', 'awaiting_resume')",
    db, [], decoder(),
  )
}

pub fn delete_run(db: sqlight.Connection, id: Int) -> Result(Nil, DbError) {
  ...
}
```

(`delete_run` already exists as `delete` — reuse.)

**Step 6.2: Add an `inspect_container` function to docker.gleam** if not present. Returns whether the container is running, exited (with exit code), or not found.

```gleam
pub type ContainerStatus {
  ContainerRunning
  ContainerExited(exit_code: Int)
  ContainerNotFound
}

pub fn inspect_container(sock: Socket, id: String) -> Result(ContainerStatus, DockerError) {
  // GET /containers/:id/json — parse State.Running and State.ExitCode
}
```

Use this with `with_docker` in reattach.

**Step 6.3: Write `reattach.gleam`:**

```gleam
pub fn run_all(
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
) -> Nil {
  case runs_db.list_non_terminal(db) {
    Error(e) -> wisp.log_warning("reattach: list failed: " <> connection.describe_error(e))
    Ok(runs) -> {
      list.each(runs, fn(run) { reattach_one(run, db, config, registry) })
    }
  }
}

fn reattach_one(run: Run, db, config, registry) {
  case run.state {
    "queued" -> { let _ = runs_db.delete(db, run.id); Nil }
    "running" | "waiting" -> reattach_active(run, db, config, registry)
    "awaiting_resume" -> reattach_awaiting(run, db, config, registry)
    _ -> Nil
  }
}

fn reattach_active(run, db, config, registry) {
  case run.container_id {
    None -> { let _ = runs_db.mark_failed(db, run.id, "no container id on boot", now_ms()); Nil }
    Some(cid) -> {
      case with_docker(config.docker_socket, fn(s) { docker.inspect_container(s, cid) }) {
        Error(reason) -> { /* mark failed */ }
        Ok(ContainerNotFound) -> { /* mark failed */ }
        Ok(ContainerExited(code)) -> { /* read result.json or mark with code */ }
        Ok(ContainerRunning) -> {
          // start broadcaster + actor in Running phase, register, attach
          ...
        }
      }
    }
  }
}

fn reattach_awaiting(run, db, config, registry) {
  let now = now_ms()
  case run.next_resume_at {
    Some(t) if t <= now -> resurrect(run, db, config, registry)
    _ -> Nil  // scheduler will handle later
  }
}
```

**Step 6.4: Add `actor.start_attached`** — like `actor.start`, but takes `cid`, `branch`, `cols`, `rows` and initialises directly into the `Running` phase. Calls `container_monitor.start` from the initialiser.

**Step 6.5: Wire into fbi.gleam.** After `let assert Ok(registry) = run_registry.start()`:

```gleam
reattach.run_all(db, cfg, registry)
```

Before `let assert Ok(_) = combined |> mist.new() ... mist.start()`. This way the reattach completes before HTTP starts accepting requests.

**Step 6.6: Tests.** Mock the Docker calls; verify each branch of `reattach_one` produces the expected DB state changes / actor start calls.

**Step 6.7: Manual verify (full integration).**
- Start dev-server + dev-client.
- Create a run via Playwright; let it reach the running state.
- Kill the server; verify the Docker container is still running.
- Restart the server; check that:
  - The run row still has state `running`.
  - The registry has an actor for it.
  - The WebSocket reconnects (Playwright check).
  - Terminal history loads from the transcript endpoint.

**Step 6.8: Commit.**
```
feat(run): reattach to live containers on server boot

On startup, query non-terminal runs and route each:
  queued           → delete (no container existed)
  running/waiting  → inspect container; reattach if running, mark
                     finished if exited, mark failed if missing
  awaiting_resume  → resurrect if next_resume_at has passed; else
                     leave for the scheduler

Restores a key property: containers run independently of the server
process, and a server restart does not interrupt user runs.
```

---

## Task 7 — Auto-resume scheduler

**Files:**
- Add: `src/server/src/fbi/run/resume_scheduler.gleam`
- Modify: `src/server/src/fbi.gleam` to start it

**Step 7.1: Add the actor**, modeled on `gc_scheduler.gleam`. Every 60s, send itself a `Tick`. On `Tick`, query `runs WHERE state='awaiting_resume' AND next_resume_at <= now`, and for each, call the same `resurrect` function used by reattach.

**Step 7.2: Refactor `resurrect`** out of `reattach.gleam` and into a shared helper (e.g., `run/resume.gleam`) that both modules can call.

**Step 7.3: Start in fbi.gleam.**

```gleam
let assert Ok(_resume_scheduler) = resume_scheduler.start(db, cfg, registry)
```

**Step 7.4: Tests** — schedule fires, picks up runs whose time has passed, leaves runs whose time hasn't. Use a small interval for the test.

**Step 7.5: Commit.**
```
feat(run): auto-resume scheduler for awaiting_resume runs

Polls every 60s for runs in awaiting_resume state whose
next_resume_at has passed, and resurrects them via the same path
boot reattach uses.
```

---

## Task 8 — Update the design doc index

**Step 8.1: No-op if there is no index** — just verify the spec and plan are committed under `docs/superpowers/`.

---

## Verification at end

Run all tests, then end-to-end via Playwright:

1. `gleam build && gleam test` — all pass.
2. Start dev-server + dev-client.
3. Create a run that takes time (e.g., a prompt that sleeps 30 seconds).
4. Kill the server mid-run. Verify Docker container still running (`docker ps`).
5. Restart server. Check server log for `reattach: cid=... reattached`.
6. In Playwright, reload the page. Confirm:
   - WebSocket connects (no console spam).
   - Terminal renders the historical output (transcript replay).
   - New output continues to appear.
7. Verify `awaiting_resume` path: insert a fake row with `state='awaiting_resume'` and `next_resume_at=now-60`. Restart server. Verify a continue-child run is started.

If any step fails: stop, diagnose, fix, re-verify.

---

## Out-of-scope checklist (future work)

Already documented in the spec under "Out of scope, to restore later" — listed here as a forward reference so we have a checklist:

- [ ] Usage tracking endpoints + token-counting pipeline
- [ ] Run-list filtering & pagination
- [ ] Changes / diff / commits / file-diff / history endpoints
- [ ] WIP endpoints (wip, wip/file, wip/discard, wip/patch)
- [ ] File upload endpoints (draft + run uploads)
- [ ] Listening ports endpoint
- [ ] GitHub PR creation endpoint
- [ ] Recent prompts endpoint
- [ ] Config defaults endpoint
- [ ] Quantico mock scenarios endpoint
- [ ] resume-now endpoint (currently 501)
- [ ] fbi_term-based snapshot rendering (vs the bulk-replay approach this work uses)
