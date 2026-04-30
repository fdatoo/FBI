# Image Builder Port — Design Spec

**Date:** 2026-04-29  
**Branch:** `fdatoo/gleam`  
**Status:** Approved

## Background

The Elixir server on `main` built per-project Docker images via `ImageBuilder` and `DevcontainerFetcher`. The Gleam rewrite dropped this entirely, replacing it with a hardcoded static image name (`fbi-image-default`). This spec covers porting the full image resolution pipeline to Gleam, including the image GC and its settings endpoint.

## Scope

- Broadcaster ownership refactor (actor/worker handshake)
- Docker API extensions: `list_images`, `build_image`, `remove_image`
- `fbi/run/image_builder.gleam` — per-project image resolution
- `fbi/run/devcontainer_fetcher.gleam` — sparse-clone repo for `.devcontainer/` files
- `fbi/run/image_gc.gleam` — sweep stale `fbi/p*` images
- `fbi/run/gc_scheduler.gleam` — hourly GC actor
- `POST /api/settings/run-gc` endpoint
- Erlang helper: `fbi_cmd.erl` — subprocess execution with exit codes

Out of scope: image pre-warming, concurrent build deduplication, resume/continue flows.

---

## Section 1 — Broadcaster Ownership Refactor

### Problem

The broadcaster is currently created inside `worker.do_launch` and returned to the actor via `WorkerReady`. Image-build output needs to stream to WebSocket clients during the build phase, before the container starts — so the broadcaster must exist earlier.

### Changes

**`run/supervisor.gleam`**  
`start_run` calls `broadcaster.start()` and passes the subject into the actor:
```gleam
let assert Ok(bc) = broadcaster.start()
run_actor.start(run_id, db, config, bc)
```

**`run/types.gleam`**  
- `Phase.Starting` becomes `Starting(broadcaster: Subject(BroadcastMsg))` so `Subscribe`/`Unsubscribe` are live immediately.
- `RunMsg.WorkerReady` drops the `broadcaster` field — the actor already owns it.

**`run/actor.gleam`**  
- `State` gains `broadcaster: Subject(BroadcastMsg)`.
- `Subscribe`/`Unsubscribe` handlers work in `Starting` phase using `state.broadcaster`.
- `transition_to_running` uses `state.broadcaster` instead of the message field.

**`run/worker.gleam`**  
- `LaunchInput` gains `broadcaster: Subject(BroadcastMsg)`.
- `do_launch` no longer calls `broadcaster.start()`.
- Worker streams image-build bytes via `process.send(input.broadcaster, BroadcastChunk(chunk))`.
- `WorkerReady` carries only `container_id`, `branch`, `cols`, `rows`.

---

## Section 2 — Docker API Extensions

Three new functions in `fbi/docker.gleam`.

### `list_images`

```gleam
pub type ImageInfo {
  ImageInfo(id: String, repo_tags: List(String), created: Int, size: Int)
}

pub fn list_images(sock: Socket) -> Result(List(ImageInfo), DockerError)
```

`GET /images/json` — used by `image_builder` to check tag existence and by `image_gc` to enumerate candidates.

### `remove_image`

```gleam
pub fn remove_image(sock: Socket, tag: String) -> Result(Nil, DockerError)
```

`DELETE /images/{tag}` — used by `image_gc.sweep`.

### `list_containers`

```gleam
pub type ContainerInfo {
  ContainerInfo(image_id: String)
}

pub fn list_containers(sock: Socket, all: Bool) -> Result(List(ContainerInfo), DockerError)
```

`GET /containers/json?all=1` — used by `image_gc.sweep` to exclude images that are still referenced by a container (including stopped containers).

### `build_image`

```gleam
pub fn build_image(
  sock: Socket,
  tar: BitArray,
  tag: String,
  on_chunk: fn(String) -> Nil,
) -> Result(Nil, DockerError)
```

`POST /build?t={tag}` with `Content-Type: application/x-tar`. Docker streams the response as newline-delimited JSON objects while the build runs:

```
{"stream":"Step 1/3 : FROM ubuntu:24.04\n"}
{"stream":"Successfully built abc123\n"}
{"error":"...","errorDetail":{"message":"..."}}
```

Implementation: send request, confirm 200 from response headers, then loop — `gen_tcp:recv(sock, 4096)`, accumulate a line buffer, emit complete JSON lines, extract and call `on_chunk` with each `stream` value, return `Error` if any `error` field is present, stop on connection close.

---

## Section 3 — ImageBuilder and DevcontainerFetcher

### `fbi/run/image_builder.gleam`

```gleam
pub fn resolve(
  project_id: Int,
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  config: Config,
  on_log: fn(String) -> Nil,
) -> Result(String, String)
```

**Flow:**
1. Read `priv/static/postbuild.sh` from disk.
2. Compute a 16-char SHA-256 hex hash over `(dc_files contents | override_json) + postbuild content`.
3. Derive `final_tag = "fbi/p{id}:{hash}"` and `base_tag = "fbi/p{id}-base:{hash}"`.
4. Open Docker socket, call `list_images` — if `final_tag` exists, return it immediately.
5. If `base_tag` is missing, build it:
   - `Some(dc_files)` → run `npx @devcontainers/cli@0.67.0 build` via `fbi_cmd` (streaming output through `on_log`)
   - `None` → generate Dockerfile from `override_json` fields (`base`, `apt`, `env`), build via `docker.build_image`
6. Apply post-layer:
   ```dockerfile
   FROM {base_tag}
   USER root
   COPY postbuild.sh /tmp/postbuild.sh
   RUN bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh
   USER agent
   WORKDIR /workspace
   ```
   Build via `docker.build_image` with a tar containing the Dockerfile and `postbuild.sh`.
7. Return `Ok(final_tag)`.

Called from `worker.do_launch` before `setup_run_dir`. The `on_log` callback is:
```gleam
fn(chunk) { process.send(input.broadcaster, BroadcastChunk(bit_array.from_string(chunk))) }
```

### `fbi/run/devcontainer_fetcher.gleam`

```gleam
pub fn fetch(
  repo_url: String,
  ssh_auth_sock: Option(String),
  on_log: fn(String) -> Nil,
) -> Option(Dict(String, String))
```

Requires exit codes and custom env vars (`SSH_AUTH_SOCK`, `GIT_TERMINAL_PROMPT=0`), which `os:cmd` doesn't provide. A new Erlang module handles this:

**`fbi_cmd.erl`**
```erlang
-module(fbi_cmd).
-export([run/3]).
%% run(Cmd, Args, Env) -> {ExitCode :: integer(), Output :: binary()}
run(Cmd, Args, Env) ->
    Port = open_port({spawn_executable, Cmd},
                     [binary, exit_status, stderr_to_stdout,
                      {args, Args}, {env, Env}]),
    collect(Port, <<>>).

collect(Port, Acc) ->
    receive
        {Port, {data, Chunk}} -> collect(Port, <<Acc/binary, Chunk/binary>>);
        {Port, {exit_status, Code}} -> {Code, Acc}
    end.
```

Called from Gleam via `@external(erlang, "fbi_cmd", "run")`. Also used by `image_builder` for the `devcontainers/cli` invocation.

**Fetcher flow:**
1. Return `None` if `ssh_auth_sock` is `None` or `repo_url` is empty.
2. Create a temp directory.
3. Run three git commands in sequence via `fbi_cmd.run`; abort to `None` on any non-zero exit:
   - `git clone --depth=1 --filter=blob:none --sparse --no-tags {repo_url} {tmp}`
   - `git -C {tmp} sparse-checkout set .devcontainer`
   - `git -C {tmp} checkout`
4. Check `{tmp}/.devcontainer/devcontainer.json` exists — if not, return `None`.
5. Read all regular files in `.devcontainer/` into `Dict(String, String)`.
6. Delete temp directory (always, even on failure).
7. Return `Some(files)`.

---

## Section 4 — Image GC, Scheduler, and Settings Endpoint

### `fbi/run/image_gc.gleam`

```gleam
pub type GcResult {
  GcResult(deleted_count: Int, deleted_bytes: Int, errors: List(GcError))
}
pub type GcError { GcError(tag: String, message: String) }

pub fn sweep(
  projects: List(Project),
  postbuild: String,
  now_ms: Int,
  config: Config,
) -> GcResult
```

**Logic:**
1. Compute the reachable tag set: for every project, derive `final_tag` and `base_tag` using the **exact same hash function as `image_builder`** (same inputs in the same order). Divergence here would cause GC to incorrectly treat live images as stale. The hash logic must live in a shared private function, not be duplicated.
2. `docker.list_images` to get all images.
3. `docker.list_containers(all: true)` to get all container image IDs (including stopped).
4. For each image with a `fbi/p*` tag: skip if its ID is used by any container, skip if `created > cutoff` (now − 30 days), skip if any of its tags are in the reachable set. Otherwise, delete via `docker.remove_image` and accumulate the result.
5. Return `GcResult`.

A `list_containers` function is also needed in `docker.gleam` (see Section 2):
```gleam
pub fn list_containers(sock: Socket, all: Bool) -> Result(List(ContainerInfo), DockerError)
```
where `ContainerInfo` carries at minimum `image_id: String`.

### `fbi/run/gc_scheduler.gleam`

OTP actor, same structural pattern as `broadcaster.gleam`:
- Receives a single `Tick` message.
- On `Tick`: checks `settings.image_gc_enabled` from DB. If disabled, reschedules and returns. If enabled: reads `priv/static/postbuild.sh`, lists projects, calls `image_gc.sweep`, writes `last_gc_at / last_gc_count / last_gc_bytes` to the settings row, reschedules.
- Schedules the first tick at startup (1-hour interval).
- Subject stored in `Context`; started in `fbi.gleam` alongside the run registry.

### Settings Endpoint

`fbi/handlers/settings.gleam` gets `handle_run_gc`:
- Reads postbuild, lists projects, calls `image_gc.sweep` inline.
- Updates `last_gc_at / last_gc_count / last_gc_bytes` in DB.
- Returns JSON: `{"deleted_count": N, "deleted_bytes": N, "errors": [{"tag": "...", "message": "..."}]}`.

`fbi/router.gleam` adds:
```
POST /api/settings/run-gc  →  settings.handle_run_gc
```

---

## File Inventory

| File | Change |
|------|--------|
| `src/fbi/run/types.gleam` | `Starting` carries broadcaster; `WorkerReady` drops broadcaster |
| `src/fbi/run/actor.gleam` | `State` gains broadcaster; `start` takes broadcaster arg |
| `src/fbi/run/supervisor.gleam` | Creates broadcaster before starting actor |
| `src/fbi/run/worker.gleam` | `LaunchInput` gains broadcaster; calls image_builder; WorkerReady trimmed |
| `src/fbi/docker.gleam` | Add `list_images`, `build_image`, `remove_image`, `list_containers` |
| `src/fbi/run/image_builder.gleam` | New — image resolution |
| `src/fbi/run/devcontainer_fetcher.gleam` | New — sparse-clone devcontainer files |
| `src/fbi/run/image_gc.gleam` | New — GC sweep logic |
| `src/fbi/run/gc_scheduler.gleam` | New — hourly GC actor |
| `src/fbi/handlers/settings.gleam` | Add `handle_run_gc` |
| `src/fbi/router.gleam` | Add `POST /api/settings/run-gc` |
| `src/fbi/context.gleam` | Add gc_scheduler subject |
| `src/fbi/fbi.gleam` | Start gc_scheduler at boot |
| `src/server/src/fbi_cmd.erl` | New — subprocess execution with exit codes |
| `test/fbi/run/actor_test.gleam` | Update for new `start` signature and `Starting` shape |
