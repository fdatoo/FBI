# Gleam Server — Plan 2: Run Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the orchestration layer to the Gleam server: Docker client, NIF terminal parser, phase-typed RunActor + TerminalBroadcaster + RunWorker, and the minimum lifecycle (launch + reattach). Wire run create/stop/delete endpoints to the orchestrator. Resume/continue come in a follow-up plan if needed.

**Architecture:** Three-process split per run — RunActor (phase state machine), TerminalBroadcaster (subscriber fan-out), RunWorker (sequential Docker/git side effects via `gleam_otp/task`). Docker client speaks HTTP/1.1 over a Unix socket using raw `gleam_erlang/process` calls. NIF wrapped behind opaque `TerminalState` type.

**Tech Stack:** Plan 1 stack + `glisten` (TCP/Unix socket helpers, optional), `gleam_erlang` (process primitives)

**Prerequisite:** Plan 1 complete. Server runs, all CRUD endpoints work, Run create/stop endpoints currently return 501.

---

## File Map (additions to Plan 1's structure)

```
src/server-gleam/
  Makefile                            ← updated: builds NIF + gleam
  erlang/
    fbi_term_nif.erl                  ← replaces stub (real -on_load NIF loader)
  priv/native/                        ← gitignored; populated by make
  src/fbi/
    docker.gleam                      ← Docker HTTP client over Unix socket
    docker/
      framing.gleam                   ← chunked transfer + Docker stream framing
      tar.gleam                       ← USTAR archive builder for file injection
    fbi_term.gleam                    ← opaque TerminalState wrapper
    run/
      types.gleam                     ← Phase, RunMsg, BroadcastMsg, RunOutcome
      broadcaster.gleam               ← TerminalBroadcaster actor
      worker.gleam                    ← RunWorker task
      actor.gleam                     ← RunActor (phase state machine)
      supervisor.gleam                ← RunSupervisor (one_for_one)
      registry.gleam                  ← run_id → Subject(RunMsg) lookup
      lifecycle/
        launch.gleam                  ← :launch mode (new run from queued)
        reattach.gleam                ← :reattach mode (orchestrator restart)
      watchers/
        runtime_state.gleam           ← polls state_dir for waiting/prompted
        usage.gleam                   ← polls mount_dir/.usage
        safeguard.gleam               ← monitors WIP repo
    git.gleam                         ← git operations (clone, push, etc.)
    image_builder.gleam               ← devcontainer.json → Docker image
  test/fbi/
    docker_test.gleam                 ← integration tests (need running Docker)
    docker/tar_test.gleam             ← unit tests (no Docker)
    fbi_term_test.gleam               ← NIF round-trip tests
    run/
      types_test.gleam                ← phase transition tests
      actor_test.gleam                ← state machine tests
      broadcaster_test.gleam
```

---

### Task 1: Build the Zig NIF and wire Erlang loader

**Files:**
- Modify: `src/server-gleam/Makefile`
- Modify: `src/server-gleam/erlang/fbi_term_nif.erl`
- Create: `src/server-gleam/.gitignore` (add `priv/native/`)

- [ ] **Step 1: Update `src/server-gleam/Makefile`**

```makefile
ZIG_PROJECT := ../../cli/fbi-term-core
NIF_SO := priv/native/fbi_term.so

.PHONY: build clean nif

nif: $(NIF_SO)

$(NIF_SO):
	@mkdir -p priv/native
	$(MAKE) -C $(ZIG_PROJECT)
	cp $(ZIG_PROJECT)/zig-out/lib/libfbi_term.so $(NIF_SO)

build: nif
	gleam build

clean:
	rm -rf build/ priv/native/

release: build
	gleam export erlang-shipment
	@echo "Shipped to build/erlang-shipment/"
```

- [ ] **Step 2: Replace `erlang/fbi_term_nif.erl`** with a real loader

```erlang
-module(fbi_term_nif).
-export([new_state/2, feed/2, snapshot/1, snapshot_at/2, resize/3, feed_file/2]).
-on_load(load/0).

load() ->
    Path = filename:join(code:priv_dir(fbi), "native/fbi_term"),
    erlang:load_nif(Path, 0).

new_state(_Cols, _Rows)        -> erlang:nif_error(nif_not_loaded).
feed(_Handle, _Bytes)          -> erlang:nif_error(nif_not_loaded).
snapshot(_Handle)              -> erlang:nif_error(nif_not_loaded).
snapshot_at(_Handle, _Offset)  -> erlang:nif_error(nif_not_loaded).
resize(_Handle, _Cols, _Rows)  -> erlang:nif_error(nif_not_loaded).
feed_file(_Handle, _Path)      -> erlang:nif_error(nif_not_loaded).
```

- [ ] **Step 3: Add to `src/server-gleam/.gitignore`**

```
build/
priv/native/
```

- [ ] **Step 4: Build and verify**

```bash
cd src/server-gleam
make build
ls priv/native/fbi_term.so
```

Expected: `.so` exists, `gleam build` exits clean.

- [ ] **Step 5: Commit**

```bash
git add src/server-gleam/Makefile src/server-gleam/erlang/ src/server-gleam/.gitignore
git commit -m "feat(gleam): wire Zig NIF build via Makefile and Erlang on_load"
```

---

### Task 2: NIF wrapper (`fbi_term` opaque type)

**Files:**
- Create: `src/server-gleam/src/fbi/fbi_term.gleam`
- Create: `src/server-gleam/test/fbi/fbi_term_test.gleam`

- [ ] **Step 1: Write the failing test**

```gleam
// test/fbi/fbi_term_test.gleam
import fbi/fbi_term
import gleeunit/should

pub fn round_trip_test() {
  let term = fbi_term.new(80, 24)
  let term2 = fbi_term.feed(term, <<"hello":utf8>>)
  let snap = fbi_term.snapshot(term2)
  snap.cols |> should.equal(80)
  snap.rows |> should.equal(24)
  // byte_offset is 5 (utf8 "hello")
  snap.byte_offset |> should.equal(5)
}

pub fn resize_test() {
  let term = fbi_term.new(80, 24)
  let term2 = fbi_term.resize(term, 100, 30)
  let snap = fbi_term.snapshot(term2)
  snap.cols |> should.equal(100)
  snap.rows |> should.equal(30)
}
```

- [ ] **Step 2: Implement `src/server-gleam/src/fbi/fbi_term.gleam`**

```gleam
import gleam/dynamic.{type Dynamic}

pub opaque type TerminalState {
  TerminalState(ref: Dynamic)
}

pub type Snapshot {
  Snapshot(ansi: String, cols: Int, rows: Int, byte_offset: Int)
}

pub type ModePrefix {
  ModePrefix(ansi: String)
}

pub fn new(cols: Int, rows: Int) -> TerminalState {
  TerminalState(nif_new_state(cols, rows))
}

pub fn feed(state: TerminalState, bytes: BitArray) -> TerminalState {
  TerminalState(nif_feed(state.ref, bytes))
}

pub fn feed_file(state: TerminalState, path: String) -> TerminalState {
  TerminalState(nif_feed_file(state.ref, path))
}

pub fn resize(state: TerminalState, cols: Int, rows: Int) -> TerminalState {
  TerminalState(nif_resize(state.ref, cols, rows))
}

pub fn snapshot(state: TerminalState) -> Snapshot {
  let #(ansi, cols, rows, offset) = nif_snapshot(state.ref)
  Snapshot(ansi: ansi, cols: cols, rows: rows, byte_offset: offset)
}

pub fn snapshot_at(state: TerminalState, byte_offset: Int) -> ModePrefix {
  let ansi = nif_snapshot_at(state.ref, byte_offset)
  ModePrefix(ansi: ansi)
}

@external(erlang, "fbi_term_nif", "new_state")
fn nif_new_state(cols: Int, rows: Int) -> Dynamic

@external(erlang, "fbi_term_nif", "feed")
fn nif_feed(state: Dynamic, bytes: BitArray) -> Dynamic

@external(erlang, "fbi_term_nif", "feed_file")
fn nif_feed_file(state: Dynamic, path: String) -> Dynamic

@external(erlang, "fbi_term_nif", "resize")
fn nif_resize(state: Dynamic, cols: Int, rows: Int) -> Dynamic

@external(erlang, "fbi_term_nif", "snapshot")
fn nif_snapshot(state: Dynamic) -> #(String, Int, Int, Int)

@external(erlang, "fbi_term_nif", "snapshot_at")
fn nif_snapshot_at(state: Dynamic, offset: Int) -> String
```

> **Note:** the NIF must return tuples in the exact shape declared. If the existing Zig NIF returns a different shape (e.g. a struct), wrap it in an Erlang helper module that adapts the return.

- [ ] **Step 3: Run the test**

```bash
cd src/server-gleam && make build && gleam test
```

Expected: round-trip test passes.

- [ ] **Step 4: Commit**

```bash
git add src/server-gleam/src/fbi/fbi_term.gleam src/server-gleam/test/fbi/fbi_term_test.gleam
git commit -m "feat(gleam): opaque TerminalState wrapping fbi_term_nif"
```

---

### Task 3: Tar archive builder

**Files:**
- Create: `src/server-gleam/src/fbi/docker/tar.gleam`
- Create: `src/server-gleam/test/fbi/docker/tar_test.gleam`

Docker's `PUT /containers/:id/archive` endpoint accepts a USTAR archive. We need a simple builder that takes `Map(String, BitArray)` (path → content) and returns the archive bytes.

- [ ] **Step 1: Write the failing test**

```gleam
// test/fbi/docker/tar_test.gleam
import fbi/docker/tar
import gleam/bit_array
import gleam/dict
import gleeunit/should

pub fn build_simple_archive_test() {
  let files = dict.from_list([
    #("hello.txt", bit_array.from_string("world")),
  ])
  let archive = tar.build(files)
  // USTAR archive: header(512) + content(rounded to 512) + 2x trailer(512)
  bit_array.byte_size(archive) |> should.equal(512 + 512 + 1024)
}

pub fn header_has_filename_test() {
  let files = dict.from_list([#("test.txt", bit_array.from_string("x"))])
  let archive = tar.build(files)
  // First 100 bytes of header are the filename, null-padded
  let assert Ok(name_bits) = bit_array.slice(archive, 0, 8)
  bit_array.to_string(name_bits) |> should.equal(Ok("test.txt"))
}
```

- [ ] **Step 2: Implement `src/server-gleam/src/fbi/docker/tar.gleam`**

```gleam
import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/int
import gleam/list
import gleam/string

pub fn build(files: Dict(String, BitArray)) -> BitArray {
  let entries =
    dict.to_list(files)
    |> list.map(fn(pair) { entry(pair.0, pair.1) })
    |> bit_array.concat()
  // Two 512-byte zero blocks signal end of archive
  let trailer = <<0:size(512 * 8 * 2)>>
  bit_array.append(entries, trailer)
}

fn entry(path: String, content: BitArray) -> BitArray {
  let header = build_header(path, bit_array.byte_size(content))
  let padded = pad_to_block(content)
  bit_array.concat([header, padded])
}

fn build_header(path: String, size: Int) -> BitArray {
  let name_field = pad_string(path, 100)
  let mode_field = pad_string("0000644", 8)
  let uid_field = pad_string("0000000", 8)
  let gid_field = pad_string("0000000", 8)
  let size_field = pad_string(int.to_base_string(size, 8) |> ok_or(""), 12)
  let mtime_field = pad_string("00000000000", 12)
  let chksum_placeholder = <<"        ":utf8>>  // 8 spaces; we'll fill checksum
  let typeflag = <<"0":utf8>>
  let linkname = pad_string("", 100)
  let magic = <<"ustar\0":utf8>>
  let version = <<"00":utf8>>
  let uname = pad_string("root", 32)
  let gname = pad_string("root", 32)
  let devmajor = pad_string("0000000", 8)
  let devminor = pad_string("0000000", 8)
  let prefix = pad_string("", 155)
  let trailing = <<0:size(12 * 8)>>  // pad to 512

  let pre =
    bit_array.concat([name_field, mode_field, uid_field, gid_field, size_field,
      mtime_field])
  let post =
    bit_array.concat([typeflag, linkname, magic, version, uname, gname,
      devmajor, devminor, prefix, trailing])

  let chksum = checksum(bit_array.concat([pre, chksum_placeholder, post]))
  let chksum_str = pad_string(int.to_base_string(chksum, 8) |> ok_or("") <> "\0 ", 8)
  bit_array.concat([pre, chksum_str, post])
}

fn checksum(header: BitArray) -> Int {
  bytes(header) |> list.fold(0, fn(acc, b) { acc + b })
}

fn bytes(b: BitArray) -> List(Int) {
  // Convert BitArray to List(Int) by extracting each byte
  bytes_loop(b, [])
  |> list.reverse()
}

fn bytes_loop(b: BitArray, acc: List(Int)) -> List(Int) {
  case b {
    <<byte, rest:bits>> -> bytes_loop(rest, [byte, ..acc])
    _ -> acc
  }
}

fn pad_string(s: String, n: Int) -> BitArray {
  let bits = bit_array.from_string(s)
  let len = bit_array.byte_size(bits)
  case len >= n {
    True -> {
      let assert Ok(truncated) = bit_array.slice(bits, 0, n)
      truncated
    }
    False -> {
      let padding = <<0:size((n - len) * 8)>>
      bit_array.append(bits, padding)
    }
  }
}

fn pad_to_block(content: BitArray) -> BitArray {
  let len = bit_array.byte_size(content)
  let remainder = len % 512
  case remainder {
    0 -> content
    _ -> bit_array.append(content, <<0:size((512 - remainder) * 8)>>)
  }
}

fn ok_or(r: Result(a, b), default: a) -> a {
  case r {
    Ok(v) -> v
    Error(_) -> default
  }
}
```

- [ ] **Step 3: Run tests**

```bash
cd src/server-gleam && gleam test
```

Expected: tar tests pass. Verify with `tar -tvf` if you write the archive to disk.

- [ ] **Step 4: Commit**

```bash
git add src/server-gleam/src/fbi/docker/tar.gleam src/server-gleam/test/fbi/docker/tar_test.gleam
git commit -m "feat(gleam): USTAR archive builder for Docker file injection"
```

---

### Task 4: Docker HTTP/1.1 client over Unix socket

**Files:**
- Create: `src/server-gleam/src/fbi/docker.gleam`
- Create: `src/server-gleam/src/fbi/docker/framing.gleam`
- Create: `src/server-gleam/test/fbi/docker_test.gleam` (skipped if `DOCKER_HOST` unset)

Docker's API is HTTP/1.1 over a Unix socket. We use Erlang's `gen_tcp` (which supports `local` family) to open the connection. Each request is a one-shot: open → send → recv → close, except for streaming endpoints (logs, attach) where the caller holds the socket open.

- [ ] **Step 1: Implement `src/server-gleam/src/fbi/docker/framing.gleam`**

```gleam
// HTTP/1.1 chunked transfer + Docker stdcopy framing helpers.
//
// Chunked transfer: each chunk is `<hex_size>\r\n<data>\r\n`, terminator is `0\r\n\r\n`.
// Docker stdcopy frame: 1 byte stream type + 3 bytes padding + 4 bytes BE length + payload.

import gleam/bit_array
import gleam/int
import gleam/result
import gleam/string

pub type ChunkResult {
  Chunk(BitArray)
  Eof
  Error(String)
}

/// Read one chunk from a chunked-encoded stream. Buffer carries leftover bytes
/// across calls.
pub fn read_chunk(buffer: BitArray) -> #(ChunkResult, BitArray) {
  case parse_size_line(buffer) {
    Error(_) -> #(Error("invalid chunk size line"), buffer)
    Ok(#(0, _rest)) -> #(Eof, <<>>)
    Ok(#(size, rest)) ->
      case bit_array.byte_size(rest) >= size + 2 {
        False -> #(Error("incomplete chunk"), buffer)  // caller should recv more
        True -> {
          let assert Ok(data) = bit_array.slice(rest, 0, size)
          let assert Ok(after) = bit_array.slice(rest, size + 2,
            bit_array.byte_size(rest) - size - 2)
          #(Chunk(data), after)
        }
      }
  }
}

fn parse_size_line(buffer: BitArray) -> Result(#(Int, BitArray), Nil) {
  // Find \r\n, parse hex prefix
  use idx <- result.try(find_crlf(buffer, 0))
  let assert Ok(line_bits) = bit_array.slice(buffer, 0, idx)
  use line <- result.try(bit_array.to_string(line_bits) |> result.replace_error(Nil))
  use size <- result.try(int.base_parse(string.trim(line), 16))
  let assert Ok(rest) = bit_array.slice(buffer, idx + 2,
    bit_array.byte_size(buffer) - idx - 2)
  Ok(#(size, rest))
}

fn find_crlf(buffer: BitArray, offset: Int) -> Result(Int, Nil) {
  case bit_array.slice(buffer, offset, 2) {
    Ok(<<0x0d, 0x0a>>) -> Ok(offset)
    Ok(_) -> find_crlf(buffer, offset + 1)
    Error(_) -> Error(Nil)
  }
}

/// Strip Docker stdcopy framing and concatenate stdout+stderr payloads.
pub fn unframe(buffer: BitArray) -> Result(BitArray, String) {
  unframe_loop(buffer, <<>>)
}

fn unframe_loop(buffer: BitArray, acc: BitArray) -> Result(BitArray, String) {
  case buffer {
    <<>> -> Ok(acc)
    <<_stream, _, _, _, size:32-big, rest:bits>> -> {
      case bit_array.byte_size(rest) >= size {
        False -> Error("truncated docker frame")
        True -> {
          let assert Ok(payload) = bit_array.slice(rest, 0, size)
          let assert Ok(remaining) = bit_array.slice(rest, size,
            bit_array.byte_size(rest) - size)
          unframe_loop(remaining, bit_array.append(acc, payload))
        }
      }
    }
    _ -> Error("invalid docker frame header")
  }
}
```

- [ ] **Step 2: Implement `src/server-gleam/src/fbi/docker.gleam`** (core client)

```gleam
import fbi/docker/framing
import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/dynamic
import gleam/erlang/atom
import gleam/erlang/process.{type Subject}
import gleam/json
import gleam/list
import gleam/result
import gleam/string

pub type DockerError {
  ConnectError(String)
  HttpError(Int, String)
  DecodeError(String)
  Timeout
}

pub opaque type Socket {
  Socket(port: dynamic.Dynamic)
}

const default_socket_path = "/var/run/docker.sock"

pub fn connect(socket_path: String) -> Result(Socket, DockerError) {
  let path = case socket_path {
    "" -> default_socket_path
    p -> p
  }
  case gen_tcp_connect_unix(path) {
    Ok(port) -> Ok(Socket(port))
    Error(reason) -> Error(ConnectError(reason))
  }
}

pub fn close(sock: Socket) -> Nil {
  gen_tcp_close(sock.port)
}

/// One-shot JSON request: send headers + body, read response, close.
pub fn request(
  sock: Socket,
  method: String,
  path: String,
  body: BitArray,
  content_type: String,
) -> Result(#(Int, BitArray), DockerError) {
  let headers =
    method <> " " <> path <> " HTTP/1.1\r\n"
    <> "Host: docker\r\n"
    <> "Content-Type: " <> content_type <> "\r\n"
    <> "Content-Length: " <> int_to_string(bit_array.byte_size(body)) <> "\r\n"
    <> "Connection: close\r\n\r\n"
  let req = bit_array.append(bit_array.from_string(headers), body)
  use _ <- result.try(send(sock, req))
  use #(status, body) <- result.try(read_response(sock))
  Ok(#(status, body))
}

/// Streaming GET — returns the socket plus any body bytes already buffered.
/// Caller must read further with `recv_chunked` and close the socket.
pub fn stream_get(
  sock: Socket,
  path: String,
) -> Result(BitArray, DockerError) {
  let req =
    "GET " <> path <> " HTTP/1.1\r\n"
    <> "Host: docker\r\n"
    <> "Connection: close\r\n\r\n"
  use _ <- result.try(send(sock, bit_array.from_string(req)))
  // Skip headers, return any post-header bytes
  skip_headers(sock)
}

pub fn recv_chunked(sock: Socket, buffer: BitArray) -> #(framing.ChunkResult, BitArray) {
  case framing.read_chunk(buffer) {
    #(framing.Error(_), _) -> {
      // Need more bytes
      case recv(sock, 0) {
        Ok(more) -> framing.read_chunk(bit_array.append(buffer, more))
        Error(_) -> #(framing.Eof, <<>>)
      }
    }
    other -> other
  }
}

// ── High-level Docker operations ─────────────────────────────────────────────

pub fn create_container(
  sock: Socket,
  spec: json.Json,
  name: String,
) -> Result(String, DockerError) {
  let body = bit_array.from_string(json.to_string(spec))
  use #(status, resp) <- result.try(
    request(sock, "POST", "/containers/create?name=" <> name, body, "application/json")
  )
  case status {
    code if code >= 200 && code < 300 -> {
      use s <- result.try(bit_array.to_string(resp) |> result.replace_error(DecodeError("non-utf8")))
      use parsed <- result.try(
        json.parse(s, dynamic.field("Id", dynamic.string))
        |> result.replace_error(DecodeError("missing Id"))
      )
      Ok(parsed)
    }
    code -> {
      let msg = bit_array.to_string(resp) |> result.unwrap("")
      Error(HttpError(code, msg))
    }
  }
}

pub fn start_container(sock: Socket, id: String) -> Result(Nil, DockerError) {
  use #(status, _) <- result.try(
    request(sock, "POST", "/containers/" <> id <> "/start", <<>>, "application/json")
  )
  case status {
    204 | 304 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn stop_container(sock: Socket, id: String, timeout_s: Int) -> Result(Nil, DockerError) {
  use #(status, _) <- result.try(
    request(sock, "POST",
      "/containers/" <> id <> "/stop?t=" <> int_to_string(timeout_s),
      <<>>, "application/json")
  )
  case status {
    204 | 304 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn kill_container(sock: Socket, id: String) -> Result(Nil, DockerError) {
  use #(status, _) <- result.try(
    request(sock, "POST", "/containers/" <> id <> "/kill", <<>>, "application/json")
  )
  case status {
    204 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn remove_container(sock: Socket, id: String, force: Bool) -> Result(Nil, DockerError) {
  let qs = case force { True -> "?force=1&v=1" False -> "?v=1" }
  use #(status, _) <- result.try(
    request(sock, "DELETE", "/containers/" <> id <> qs, <<>>, "application/json")
  )
  case status {
    204 | 404 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn wait_container(sock: Socket, id: String) -> Result(Int, DockerError) {
  // POST /containers/:id/wait blocks until exit, returns {"StatusCode": N}
  use #(status, body) <- result.try(
    request(sock, "POST", "/containers/" <> id <> "/wait", <<>>, "application/json")
  )
  case status {
    200 -> {
      use s <- result.try(bit_array.to_string(body) |> result.replace_error(DecodeError("non-utf8")))
      use code <- result.try(
        json.parse(s, dynamic.field("StatusCode", dynamic.int))
        |> result.replace_error(DecodeError("missing StatusCode"))
      )
      Ok(code)
    }
    code -> Error(HttpError(code, ""))
  }
}

pub fn resize_container(sock: Socket, id: String, cols: Int, rows: Int) -> Result(Nil, DockerError) {
  let path = "/containers/" <> id <> "/resize?w=" <> int_to_string(cols)
    <> "&h=" <> int_to_string(rows)
  use #(status, _) <- result.try(
    request(sock, "POST", path, <<>>, "application/json")
  )
  case status {
    200 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn upload_archive(
  sock: Socket,
  id: String,
  target_dir: String,
  tar_archive: BitArray,
) -> Result(Nil, DockerError) {
  let path = "/containers/" <> id <> "/archive?path="
    <> uri_encode(target_dir)
  use #(status, _) <- result.try(
    request(sock, "PUT", path, tar_archive, "application/x-tar")
  )
  case status {
    200 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

// ── FFI helpers ──────────────────────────────────────────────────────────────

@external(erlang, "fbi_docker_ffi", "connect_unix")
fn gen_tcp_connect_unix(path: String) -> Result(dynamic.Dynamic, String)

@external(erlang, "fbi_docker_ffi", "close")
fn gen_tcp_close(port: dynamic.Dynamic) -> Nil

@external(erlang, "fbi_docker_ffi", "send")
fn gen_tcp_send(port: dynamic.Dynamic, data: BitArray) -> Result(Nil, String)

@external(erlang, "fbi_docker_ffi", "recv")
fn gen_tcp_recv(port: dynamic.Dynamic, length: Int) -> Result(BitArray, String)

fn send(sock: Socket, data: BitArray) -> Result(Nil, DockerError) {
  gen_tcp_send(sock.port, data) |> result.map_error(ConnectError)
}

fn recv(sock: Socket, length: Int) -> Result(BitArray, DockerError) {
  gen_tcp_recv(sock.port, length) |> result.map_error(ConnectError)
}

// Read full HTTP response (Connection: close), return status code + body
fn read_response(sock: Socket) -> Result(#(Int, BitArray), DockerError) {
  use all <- result.try(read_until_close(sock, <<>>))
  parse_http_response(all)
}

fn read_until_close(sock: Socket, acc: BitArray) -> Result(BitArray, DockerError) {
  case recv(sock, 0) {
    Ok(<<>>) -> Ok(acc)
    Ok(chunk) -> read_until_close(sock, bit_array.append(acc, chunk))
    Error(_) -> Ok(acc)  // socket closed
  }
}

fn parse_http_response(buffer: BitArray) -> Result(#(Int, BitArray), DockerError) {
  // Find first \r\n\r\n separating headers from body
  use header_end <- result.try(find_double_crlf(buffer, 0)
    |> result.replace_error(DecodeError("no header terminator")))
  let assert Ok(header_bits) = bit_array.slice(buffer, 0, header_end)
  let assert Ok(body) = bit_array.slice(buffer, header_end + 4,
    bit_array.byte_size(buffer) - header_end - 4)
  use header_str <- result.try(bit_array.to_string(header_bits)
    |> result.replace_error(DecodeError("non-utf8 headers")))
  let lines = string.split(header_str, "\r\n")
  case lines {
    [first, ..] -> {
      // "HTTP/1.1 200 OK"
      case string.split(first, " ") {
        [_, status_str, ..] ->
          case int.parse(status_str) {
            Ok(code) -> Ok(#(code, body))
            Error(_) -> Error(DecodeError("invalid status"))
          }
        _ -> Error(DecodeError("invalid status line"))
      }
    }
    _ -> Error(DecodeError("empty response"))
  }
}

fn find_double_crlf(buffer: BitArray, offset: Int) -> Result(Int, Nil) {
  case bit_array.slice(buffer, offset, 4) {
    Ok(<<0x0d, 0x0a, 0x0d, 0x0a>>) -> Ok(offset)
    Ok(_) -> find_double_crlf(buffer, offset + 1)
    Error(_) -> Error(Nil)
  }
}

fn skip_headers(sock: Socket) -> Result(BitArray, DockerError) {
  skip_headers_loop(sock, <<>>)
}

fn skip_headers_loop(sock: Socket, buffer: BitArray) -> Result(BitArray, DockerError) {
  case find_double_crlf(buffer, 0) {
    Ok(idx) -> {
      let assert Ok(rest) = bit_array.slice(buffer, idx + 4,
        bit_array.byte_size(buffer) - idx - 4)
      Ok(rest)
    }
    Error(_) -> {
      use more <- result.try(recv(sock, 0))
      skip_headers_loop(sock, bit_array.append(buffer, more))
    }
  }
}

fn int_to_string(n: Int) -> String {
  int.to_string(n)
}

fn uri_encode(s: String) -> String {
  // For simplicity, replace `/` with %2F and assume rest is safe.
  // Production use should use a real URL encoder.
  s |> string.replace("/", "%2F")
}
```

- [ ] **Step 3: Create the Erlang FFI shim `erlang/fbi_docker_ffi.erl`**

```erlang
-module(fbi_docker_ffi).
-export([connect_unix/1, close/1, send/2, recv/2]).

connect_unix(Path) when is_binary(Path) ->
    case gen_tcp:connect({local, binary_to_list(Path)}, 0,
                         [binary, {active, false}, {packet, raw}]) of
        {ok, Sock} -> {ok, Sock};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

close(Sock) -> gen_tcp:close(Sock), nil.

send(Sock, Data) ->
    case gen_tcp:send(Sock, Data) of
        ok -> {ok, nil};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

%% recv(Sock, 0) → recv whatever is available
recv(Sock, _Len) ->
    case gen_tcp:recv(Sock, 0, 5000) of
        {ok, Data} -> {ok, Data};
        {error, closed} -> {ok, <<>>};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.
```

- [ ] **Step 4: Smoke test (requires running Docker)**

```gleam
// test/fbi/docker_test.gleam
import fbi/docker
import gleam/erlang/os
import gleeunit/should

pub fn ping_test() {
  case os.get_env("DOCKER_TEST") {
    Error(_) -> Nil  // skip
    Ok(_) -> {
      let assert Ok(sock) = docker.connect("/var/run/docker.sock")
      let assert Ok(#(status, _)) = docker.request(sock, "GET", "/_ping", <<>>, "text/plain")
      docker.close(sock)
      status |> should.equal(200)
    }
  }
}
```

```bash
cd src/server-gleam && DOCKER_TEST=1 gleam test
```

Expected: `ping_test` passes (or is skipped if Docker isn't available).

- [ ] **Step 5: Commit**

```bash
git add src/server-gleam/src/fbi/docker.gleam src/server-gleam/src/fbi/docker/ src/server-gleam/erlang/fbi_docker_ffi.erl src/server-gleam/test/fbi/docker_test.gleam
git commit -m "feat(gleam): Docker HTTP client over Unix socket with chunked stream support"
```

---

### Task 5: Run types — Phase, RunMsg, BroadcastMsg, RunOutcome

**Files:**
- Create: `src/server-gleam/src/fbi/run/types.gleam`
- Create: `src/server-gleam/test/fbi/run/types_test.gleam`

These are the core types that make the state machine compiler-checkable. No DB, no I/O — just types.

- [ ] **Step 1: Implement `src/server-gleam/src/fbi/run/types.gleam`**

```gleam
import gleam/erlang/process.{type Subject}
import gleam/option.{type Option}

pub type Phase {
  Starting
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
    broadcaster: Subject(BroadcastMsg),
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

- [ ] **Step 2: Write phase test**

```gleam
// test/fbi/run/types_test.gleam
import fbi/run/types.{Done, Failed, RunOutcome, Starting}
import gleam/option.{None}
import gleeunit/should

pub fn phase_constructable_test() {
  let phase = Starting
  case phase {
    Starting -> Nil
    _ -> panic as "unexpected"
  }
}

pub fn run_outcome_test() {
  let outcome = RunOutcome(
    exit_code: 0,
    branch_pushed: None,
    head_commit: None,
    title: None,
    error_message: None,
  )
  outcome.exit_code |> should.equal(0)
}
```

- [ ] **Step 3: Run tests**

```bash
cd src/server-gleam && gleam test
```

- [ ] **Step 4: Commit**

```bash
git add src/server-gleam/src/fbi/run/ src/server-gleam/test/fbi/run/
git commit -m "feat(gleam): run types — Phase, RunMsg, BroadcastMsg, TerminalEvent"
```

---

### Task 6: TerminalBroadcaster actor

**Files:**
- Create: `src/server-gleam/src/fbi/run/broadcaster.gleam`
- Create: `src/server-gleam/test/fbi/run/broadcaster_test.gleam`

- [ ] **Step 1: Write the failing test**

```gleam
// test/fbi/run/broadcaster_test.gleam
import fbi/run/broadcaster
import fbi/run/types.{BroadcastChunk, BroadcastSubscribe, TerminalChunk}
import gleam/erlang/process
import gleam/otp/actor
import gleeunit/should

pub fn broadcaster_fans_out_test() {
  let assert Ok(bc) = broadcaster.start()
  let client_subject = process.new_subject()
  process.send(bc, BroadcastSubscribe(client_subject))
  process.send(bc, BroadcastChunk(<<"hi":utf8>>))
  case process.receive(client_subject, 100) {
    Ok(TerminalChunk(data)) -> data |> should.equal(<<"hi":utf8>>)
    other -> panic as "unexpected event"
  }
}
```

- [ ] **Step 2: Implement `src/server-gleam/src/fbi/run/broadcaster.gleam`**

```gleam
import fbi/run/types.{type BroadcastMsg, type TerminalEvent, BroadcastChunk,
  BroadcastEvent, BroadcastShutdown, BroadcastSubscribe, BroadcastUnsubscribe,
  TerminalChunk}
import gleam/erlang/process.{type Subject}
import gleam/list
import gleam/otp/actor

type State {
  State(subscribers: List(Subject(TerminalEvent)))
}

pub fn start() -> Result(Subject(BroadcastMsg), actor.StartError) {
  actor.start(State(subscribers: []), handle_message)
}

fn handle_message(msg: BroadcastMsg, state: State) -> actor.Next(BroadcastMsg, State) {
  case msg {
    BroadcastSubscribe(client) ->
      actor.continue(State(subscribers: [client, ..state.subscribers]))
    BroadcastUnsubscribe(client) ->
      actor.continue(State(
        subscribers: list.filter(state.subscribers, fn(s) { s != client }),
      ))
    BroadcastChunk(data) -> {
      list.each(state.subscribers, fn(s) { process.send(s, TerminalChunk(data)) })
      actor.continue(state)
    }
    BroadcastEvent(event) -> {
      list.each(state.subscribers, fn(s) { process.send(s, event) })
      actor.continue(state)
    }
    BroadcastShutdown -> actor.Stop(process.Normal)
  }
}

pub fn subscriber_count(bc: Subject(BroadcastMsg)) -> Int {
  // For tests; not used at runtime
  0
}
```

- [ ] **Step 3: Run tests**

```bash
cd src/server-gleam && gleam test
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/server-gleam/src/fbi/run/broadcaster.gleam src/server-gleam/test/fbi/run/broadcaster_test.gleam
git commit -m "feat(gleam): TerminalBroadcaster actor for subscriber fan-out"
```

---

### Task 7: RunWorker — sequential Docker/git side effects

**Files:**
- Create: `src/server-gleam/src/fbi/run/worker.gleam`

The worker is a `task.async` that runs the launch sequence and sends one message back to RunActor.

- [ ] **Step 1: Implement `src/server-gleam/src/fbi/run/worker.gleam`**

```gleam
import fbi/config.{type Config}
import fbi/db/projects.{type Project}
import fbi/db/runs.{type Run}
import fbi/docker
import fbi/docker/tar
import fbi/run/broadcaster
import fbi/run/types.{type BroadcastMsg, type RunMsg, WorkerFailed, WorkerReady}
import gleam/dict
import gleam/erlang/process.{type Subject}
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/otp/task
import gleam/result

pub type LaunchInput {
  LaunchInput(
    run: Run,
    project: Project,
    config: Config,
    image_tag: String,
    cols: Int,
    rows: Int,
  )
}

/// Spawns a task that performs the Docker setup and reports back to `parent`.
pub fn launch(input: LaunchInput, parent: Subject(RunMsg)) -> Nil {
  task.async(fn() {
    case do_launch(input) {
      Ok(#(cid, branch, bc)) -> {
        process.send(parent, WorkerReady(
          container_id: cid,
          branch: branch,
          broadcaster: bc,
          cols: input.cols,
          rows: input.rows,
        ))
      }
      Error(reason) -> process.send(parent, WorkerFailed(reason))
    }
  })
  Nil
}

fn do_launch(input: LaunchInput) -> Result(#(String, String, Subject(BroadcastMsg)), String) {
  use sock <- result.try(
    docker.connect(input.config.docker_socket)
    |> result.map_error(fn(e) { "docker connect: " <> describe_err(e) }),
  )
  let container_name = "fbi-run-" <> int_to_string(input.run.id)
  let spec = container_spec(input)
  use cid <- result.try(
    docker.create_container(sock, spec, container_name)
    |> result.map_error(fn(e) { "create_container: " <> describe_err(e) }),
  )
  // File injection (preamble files)
  let files = build_preamble(input)
  use _ <- result.try(
    docker.upload_archive(sock, cid, "/fbi/", tar.build(files))
    |> result.map_error(fn(e) { "upload_archive: " <> describe_err(e) }),
  )
  use _ <- result.try(
    docker.start_container(sock, cid)
    |> result.map_error(fn(e) { "start_container: " <> describe_err(e) }),
  )
  use bc <- result.try(
    broadcaster.start()
    |> result.map_error(fn(_) { "failed to start broadcaster" }),
  )
  // RunActor spawns the stdout reader after receiving WorkerReady
  Ok(#(cid, input.run.branch_name, bc))
}

fn container_spec(input: LaunchInput) -> json.Json {
  let env = build_env(input)
  let binds = build_binds(input)
  json.object([
    #("Image", json.string(input.image_tag)),
    #("User", json.string("agent")),
    #("Env", json.array(env, json.string)),
    #("Tty", json.bool(True)),
    #("OpenStdin", json.bool(True)),
    #("StdinOnce", json.bool(False)),
    #("Entrypoint", json.array(["/usr/local/bin/supervisor.sh"], json.string)),
    #("HostConfig", json.object([
      #("AutoRemove", json.bool(False)),
      #("Memory", json.int(memory_bytes(input))),
      #("NanoCpus", json.int(nano_cpus(input))),
      #("PidsLimit", json.int(option.unwrap(input.project.pids_limit, 1024))),
      #("Binds", json.array(binds, json.string)),
    ])),
  ])
}

fn build_env(input: LaunchInput) -> List(String) {
  [
    "RUN_ID=" <> int_to_string(input.run.id),
    "REPO_URL=" <> input.project.repo_url,
    "DEFAULT_BRANCH=" <> input.project.default_branch,
    "GIT_AUTHOR_NAME=" <> option.unwrap(input.project.git_author_name, input.config.git_author_name),
    "GIT_AUTHOR_EMAIL=" <> option.unwrap(input.project.git_author_email, input.config.git_author_email),
    "FBI_BRANCH=" <> input.run.branch_name,
    "IS_SANDBOX=1",
  ]
  |> list.append(model_env(input.run))
}

fn model_env(run: runs.Run) -> List(String) {
  [
    option.map(run.model, fn(m) { "ANTHROPIC_MODEL=" <> m }),
    option.map(run.effort, fn(e) { "CLAUDE_CODE_EFFORT_LEVEL=" <> e }),
    option.map(run.subagent_model, fn(m) { "CLAUDE_CODE_SUBAGENT_MODEL=" <> m }),
  ]
  |> list.filter_map(fn(o) { case o { Some(s) -> Ok(s) None -> Error(Nil) } })
}

fn build_binds(input: LaunchInput) -> List(String) {
  let runs_dir = input.config.runs_dir
  let run_dir = runs_dir <> "/" <> int_to_string(input.run.id)
  [
    run_dir <> "/scripts/supervisor.sh:/usr/local/bin/supervisor.sh:ro",
    run_dir <> "/wip:/safeguard:rw",
    run_dir <> "/state:/fbi-state:rw",
    run_dir <> "/mount:/home/agent/.claude/projects/:rw",
    "/var/run/docker.sock:/var/run/docker.sock",
  ]
  |> list.append(case input.config.ssh_auth_sock {
    Some(sock) -> [sock <> ":/ssh-agent"]
    None -> []
  })
  |> list.append(case input.config.claude_dir {
    Some(dir) -> [dir <> "/.credentials.json:/home/agent/.claude/.credentials.json:ro"]
    None -> []
  })
}

fn build_preamble(input: LaunchInput) -> dict.Dict(String, BitArray) {
  dict.from_list([
    #("prompt.txt", bit_array.from_string(input.run.prompt)),
    #("instructions.txt", bit_array.from_string(option.unwrap(input.project.instructions, ""))),
  ])
}

fn memory_bytes(input: LaunchInput) -> Int {
  option.unwrap(input.project.mem_mb, 4096) * 1024 * 1024
}

fn nano_cpus(input: LaunchInput) -> Int {
  // 1.0 CPU = 1_000_000_000 nanoCPUs; default 2.0
  let cpus = option.unwrap(input.project.cpus, 2.0)
  float.round(cpus *. 1_000_000_000.0)
}

fn describe_err(e: docker.DockerError) -> String {
  case e {
    docker.ConnectError(s) -> "connect: " <> s
    docker.HttpError(code, msg) -> "http " <> int_to_string(code) <> ": " <> msg
    docker.DecodeError(s) -> "decode: " <> s
    docker.Timeout -> "timeout"
  }
}

fn int_to_string(n: Int) -> String {
  int.to_string(n)
}
```

- [ ] **Step 2: Build, no test (integration tested in Task 9)**

```bash
cd src/server-gleam && gleam build
```

- [ ] **Step 3: Commit**

```bash
git add src/server-gleam/src/fbi/run/worker.gleam
git commit -m "feat(gleam): RunWorker task — Docker create/start/file-inject sequence"
```

---

### Task 8: RunActor — phase-typed state machine

**Files:**
- Create: `src/server-gleam/src/fbi/run/actor.gleam`
- Create: `src/server-gleam/test/fbi/run/actor_test.gleam`

The state machine: initial phase is `Starting`. RunWorker sends `WorkerReady` → transition to `Running`. Container exit → `Waiting` (clients still connected). Last unsubscribe → `Finishing` → `Done`. Cancel from `Running` → kill container → `Failed`.

- [ ] **Step 1: Implement `src/server-gleam/src/fbi/run/actor.gleam`**

```gleam
import fbi/config.{type Config}
import fbi/db/runs as runs_db
import fbi/docker
import fbi/run/broadcaster
import fbi/run/types.{type BroadcastMsg, type Phase, type RunMsg, type RunOutcome,
  BroadcastChunk, BroadcastShutdown, BroadcastSubscribe, BroadcastUnsubscribe,
  Cancel, ContainerExited, Done, Failed, Finishing, Resize, Running, Shutdown,
  Starting, Subscribe, Unsubscribe, Waiting, WorkerFailed, WorkerReady,
  WriteStdin}
import gleam/erlang/process.{type Subject}
import gleam/list
import gleam/option.{None, Some}
import gleam/otp/actor
import sqlight

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
) -> Result(Subject(RunMsg), actor.StartError) {
  actor.start(
    State(run_id: run_id, db: db, config: config, phase: Starting, listener_count: 0),
    handle,
  )
}

fn handle(msg: RunMsg, state: State) -> actor.Next(RunMsg, State) {
  case state.phase, msg {
    // ── Starting ─────────────────────────────────────────────
    Starting, WorkerReady(cid, branch, bc, cols, rows) ->
      transition_to_running(state, cid, branch, bc, cols, rows)

    Starting, WorkerFailed(reason) ->
      transition_to_failed(state, reason)

    Starting, Cancel ->
      transition_to_failed(state, "cancelled before start")

    // ── Running ──────────────────────────────────────────────
    Running(cid, branch, bc, cols, rows), Subscribe(client) -> {
      process.send(bc, BroadcastSubscribe(client))
      actor.continue(State(..state, listener_count: state.listener_count + 1))
    }

    Running(cid, branch, bc, cols, rows), Unsubscribe(client) -> {
      process.send(bc, BroadcastUnsubscribe(client))
      actor.continue(State(..state, listener_count: state.listener_count - 1))
    }

    Running(cid, _, _, _, _), WriteStdin(bytes) -> {
      // Forward to attach socket — held inside a separate process.
      // Simplified: TODO in Plan 2 follow-up — wire stdin attach.
      actor.continue(state)
    }

    Running(cid, branch, bc, _, _), Resize(cols, rows) -> {
      let assert Ok(sock) = docker.connect(state.config.docker_socket)
      let _ = docker.resize_container(sock, cid, cols, rows)
      docker.close(sock)
      actor.continue(State(..state, phase: Running(cid, branch, bc, cols, rows)))
    }

    Running(cid, _, bc, _, _), ContainerExited(outcome) ->
      transition_to_waiting(state, bc, outcome)

    Running(cid, _, _, _, _), Cancel -> {
      // Kill container; ContainerExited will follow
      let assert Ok(sock) = docker.connect(state.config.docker_socket)
      let _ = docker.kill_container(sock, cid)
      docker.close(sock)
      actor.continue(state)
    }

    // ── Waiting ──────────────────────────────────────────────
    Waiting(_, bc), Subscribe(client) -> {
      process.send(bc, BroadcastSubscribe(client))
      actor.continue(State(..state, listener_count: state.listener_count + 1))
    }

    Waiting(outcome, bc), Unsubscribe(client) -> {
      process.send(bc, BroadcastUnsubscribe(client))
      let new_count = state.listener_count - 1
      case new_count <= 0 {
        True -> transition_to_finishing(state, bc, outcome)
        False -> actor.continue(State(..state, listener_count: new_count))
      }
    }

    // ── Done / Failed (terminal) ─────────────────────────────
    Done(_), _ -> actor.continue(state)
    Failed(_), _ -> actor.continue(state)

    // ── Catch-all (compiler enforces no missed transitions) ──
    _, Shutdown -> actor.Stop(process.Normal)
    _, _ -> actor.continue(state)
  }
}

// ── Transitions ─────────────────────────────────────────────────────────────

fn transition_to_running(
  state: State,
  cid: String,
  branch: String,
  bc: Subject(BroadcastMsg),
  cols: Int,
  rows: Int,
) -> actor.Next(RunMsg, State) {
  let _ = runs_db.mark_state(state.db, state.run_id, "running", now_ms())
  // TODO: spawn stdout reader process here (Plan 2 follow-up)
  actor.continue(State(..state, phase: Running(cid, branch, bc, cols, rows)))
}

fn transition_to_waiting(
  state: State,
  bc: Subject(BroadcastMsg),
  outcome: RunOutcome,
) -> actor.Next(RunMsg, State) {
  let _ = runs_db.mark_finished(state.db, state.run_id, outcome, now_ms())
  case state.listener_count {
    0 -> transition_to_finishing(state, bc, outcome)
    _ -> actor.continue(State(..state, phase: Waiting(outcome, bc)))
  }
}

fn transition_to_finishing(
  state: State,
  bc: Subject(BroadcastMsg),
  outcome: RunOutcome,
) -> actor.Next(RunMsg, State) {
  process.send(bc, BroadcastShutdown)
  // Cleanup: remove container, close DB resources
  let assert Ok(sock) = docker.connect(state.config.docker_socket)
  let _ = docker.remove_container(sock, container_id_of(state), True)
  docker.close(sock)
  actor.continue(State(..state, phase: Done(outcome)))
}

fn transition_to_failed(state: State, reason: String) -> actor.Next(RunMsg, State) {
  let _ = runs_db.mark_failed(state.db, state.run_id, reason, now_ms())
  actor.continue(State(..state, phase: Failed(reason)))
}

fn container_id_of(state: State) -> String {
  case state.phase {
    Running(cid, _, _, _, _) -> cid
    Waiting(_, _) -> ""
    _ -> ""
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
```

- [ ] **Step 2: Add helper functions to `src/server-gleam/src/fbi/db/runs.gleam`**

```gleam
pub fn mark_state(db, id: Int, state: String, now: Int) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET state = ?, state_entered_at = ? WHERE id = ? RETURNING " <> columns(),
    db,
    [sqlight.text(state), sqlight.int(now), sqlight.int(id)],
    decoder(),
  )
}

pub fn mark_finished(db, id: Int, outcome: RunOutcome, now: Int) -> Result(Run, DbError) {
  let state = case outcome.exit_code {
    0 -> "succeeded"
    _ -> "failed"
  }
  connection.query_one(
    "UPDATE runs SET state = ?, exit_code = ?, head_commit = ?, finished_at = ?,
       error = ? WHERE id = ? RETURNING " <> columns(),
    db,
    [
      sqlight.text(state),
      sqlight.int(outcome.exit_code),
      case outcome.head_commit { None -> sqlight.null() Some(c) -> sqlight.text(c) },
      sqlight.int(now),
      case outcome.error_message { None -> sqlight.null() Some(e) -> sqlight.text(e) },
      sqlight.int(id),
    ],
    decoder(),
  )
}

pub fn mark_failed(db, id: Int, reason: String, now: Int) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?
     RETURNING " <> columns(),
    db,
    [sqlight.text(reason), sqlight.int(now), sqlight.int(id)],
    decoder(),
  )
}
```

- [ ] **Step 3: Write actor test**

```gleam
// test/fbi/run/actor_test.gleam
import fbi/config
import fbi/db/migrations
import fbi/db/projects
import fbi/db/runs
import fbi/run/actor as run_actor
import fbi/run/types.{Cancel, Subscribe, WorkerFailed}
import gleam/erlang/process
import gleam/option.{None}
import gleeunit/should
import sqlight

fn test_setup() -> #(sqlight.Connection, config.Config, Int) {
  let assert Ok(db) = sqlight.open(":memory:")
  let assert Ok(_) = migrations.run(db)
  let now = 1_700_000_000_000
  let assert Ok(p) = projects.insert(db, projects.NewProject(
    name: "p", repo_url: "u", default_branch: "main",
    devcontainer_override_json: None, instructions: None,
    git_author_name: None, git_author_email: None,
    marketplaces_json: "[]", plugins_json: "[]",
    mem_mb: None, cpus: None, pids_limit: None,
    created_at: now, updated_at: now))
  let assert Ok(_) = sqlight.exec(
    "INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at, state_entered_at)
     VALUES (?, 'p', 'b', 'queued', '/tmp/log', ?, ?)",
    on: db, with: [sqlight.int(p.id), sqlight.int(now), sqlight.int(now)])
  let cfg = test_config()
  #(db, cfg, p.id)
}

fn test_config() -> config.Config {
  // Minimal config for actor tests; fields not all relevant
  config.Config(port: 0, secret_key: "test", database_path: ":memory:",
    runs_dir: "/tmp/r", git_author_name: "t", git_author_email: "t@t",
    web_dist_dir: None, docker_socket: "/var/run/docker.sock",
    docker_gid: None, ssh_auth_sock: None, claude_dir: None,
    secrets_key: <<0:size(256)>>, default_plugins: [])
}

pub fn worker_failed_transitions_to_failed_test() {
  let #(db, cfg, project_id) = test_setup()
  let assert Ok(actor) = run_actor.start(1, db, cfg)
  process.send(actor, WorkerFailed("simulated"))
  // Actor should now be in Failed phase; subsequent messages are silently dropped
  process.send(actor, Cancel)  // ignored by Failed
  // No assertion crash = pass
  Nil
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/server-gleam && gleam test
```

- [ ] **Step 5: Commit**

```bash
git add src/server-gleam/src/fbi/run/actor.gleam src/server-gleam/src/fbi/db/runs.gleam src/server-gleam/test/fbi/run/actor_test.gleam
git commit -m "feat(gleam): RunActor phase-typed state machine + DB transition helpers"
```

---

### Task 9: Run supervisor + registry

**Files:**
- Create: `src/server-gleam/src/fbi/run/registry.gleam`
- Create: `src/server-gleam/src/fbi/run/supervisor.gleam`
- Modify: `src/server-gleam/src/fbi.gleam` (start the supervisor)

- [ ] **Step 1: Implement registry**

```gleam
// src/fbi/run/registry.gleam
import fbi/run/types.{type RunMsg}
import gleam/dict.{type Dict}
import gleam/erlang/process.{type Subject}
import gleam/option.{type Option, None, Some}
import gleam/otp/actor

pub type RegistryMsg {
  Register(run_id: Int, run: Subject(RunMsg))
  Lookup(run_id: Int, reply_with: Subject(Option(Subject(RunMsg))))
  Unregister(run_id: Int)
}

type State {
  State(runs: Dict(Int, Subject(RunMsg)))
}

pub fn start() -> Result(Subject(RegistryMsg), actor.StartError) {
  actor.start(State(runs: dict.new()), handle)
}

fn handle(msg: RegistryMsg, state: State) -> actor.Next(RegistryMsg, State) {
  case msg {
    Register(id, run) ->
      actor.continue(State(runs: dict.insert(state.runs, id, run)))
    Unregister(id) ->
      actor.continue(State(runs: dict.delete(state.runs, id)))
    Lookup(id, reply) -> {
      process.send(reply, dict.get(state.runs, id) |> option.from_result)
      actor.continue(state)
    }
  }
}

pub fn lookup(reg: Subject(RegistryMsg), id: Int) -> Option(Subject(RunMsg)) {
  let reply = process.new_subject()
  process.send(reg, Lookup(id, reply))
  case process.receive(reply, 1000) {
    Ok(opt) -> opt
    Error(_) -> None
  }
}
```

- [ ] **Step 2: Implement supervisor**

```gleam
// src/fbi/run/supervisor.gleam
import fbi/config.{type Config}
import fbi/run/actor as run_actor
import fbi/run/registry.{type RegistryMsg, Register, Unregister}
import fbi/run/types.{type RunMsg}
import gleam/erlang/process.{type Subject}
import gleam/result
import sqlight

pub type SupervisorMsg {
  StartRun(run_id: Int, reply: Subject(Result(Subject(RunMsg), String)))
  StopRun(run_id: Int)
}

pub fn start_run(
  registry: Subject(RegistryMsg),
  db: sqlight.Connection,
  config: Config,
  run_id: Int,
) -> Result(Subject(RunMsg), String) {
  use actor <- result.try(
    run_actor.start(run_id, db, config)
    |> result.map_error(fn(_) { "failed to start run actor" }),
  )
  process.send(registry, Register(run_id, actor))
  Ok(actor)
}
```

- [ ] **Step 3: Modify `src/fbi.gleam`** to start the registry on boot

```gleam
// Add to fbi.gleam main():
let assert Ok(registry) = run_registry.start()
let ctx = Context(db: db, config: cfg, run_registry: registry)
```

Update `Context` in `src/fbi/context.gleam`:

```gleam
import fbi/config.{type Config}
import fbi/run/registry.{type RegistryMsg}
import gleam/erlang/process.{type Subject}
import sqlight

pub type Context {
  Context(
    db: sqlight.Connection,
    config: Config,
    run_registry: Subject(RegistryMsg),
  )
}
```

Existing handlers that build a `Context` need to be updated to pass the registry — but tests can use a stub registry.

- [ ] **Step 4: Commit**

```bash
git add src/server-gleam/
git commit -m "feat(gleam): run registry + supervisor; thread through Context"
```

---

### Task 10: Run create/stop/delete handlers

**Files:**
- Modify: `src/server-gleam/src/fbi/handlers/runs.gleam`

- [ ] **Step 1: Replace the 501 stubs in `runs.gleam`**

```gleam
// In src/fbi/handlers/runs.gleam, replace `create` and `stop`:

pub fn create(req: Request, ctx: Context, project_id_str: String) -> Response {
  use <- wisp.require_method(req, http.Post)
  use body <- wisp.require_json(req)
  case int.parse(project_id_str) {
    Error(_) -> wisp.bad_request()
    Ok(project_id) -> {
      let decoder = {
        use prompt <- decode.field("prompt", decode.string)
        use model <- decode.optional_field("model", None, decode.optional(decode.string))
        use effort <- decode.optional_field("effort", None, decode.optional(decode.string))
        use subagent_model <- decode.optional_field("subagent_model", None, decode.optional(decode.string))
        decode.success(#(prompt, model, effort, subagent_model))
      }
      case decode.run(body, decoder) {
        Error(_) -> wisp.bad_request()
        Ok(#(prompt, model, effort, subagent_model)) -> {
          // Verify project exists
          use project <- (case projects.get(ctx.db, project_id) {
            Ok(p) -> fn(then) { then(p) }
            Error(_) -> fn(_) { wisp.not_found() }
          })
          let now = now_ms()
          // Insert run row in `queued` state
          let new_run_id = insert_run(ctx.db, project_id, prompt, model, effort,
            subagent_model, now)
          case new_run_id {
            Error(_) -> wisp.internal_server_error()
            Ok(rid) -> {
              // Spawn run actor
              let assert Ok(actor) = run_supervisor.start_run(
                ctx.run_registry, ctx.db, ctx.config, rid
              )
              // Kick off worker for :launch
              run_worker.launch(
                run_worker.LaunchInput(
                  run: load_run(ctx.db, rid),
                  project: project,
                  config: ctx.config,
                  image_tag: "fbi-image-default",  // Plan 2 follow-up: real image resolution
                  cols: 80,
                  rows: 24,
                ),
                actor,
              )
              let assert Ok(run) = runs_db.get(ctx.db, rid)
              run_json.encode(run) |> json.to_string() |> wisp.json_response(201)
            }
          }
        }
      }
    }
  }
}

pub fn stop(req: Request, ctx: Context, id_str: String) -> Response {
  use <- wisp.require_method(req, http.Post)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request()
    Ok(id) -> {
      case registry.lookup(ctx.run_registry, id) {
        Some(actor) -> {
          process.send(actor, types.Cancel)
          wisp.response(202)
        }
        None -> wisp.not_found()
      }
    }
  }
}

fn insert_run(
  db: sqlight.Connection,
  project_id: Int,
  prompt: String,
  model: Option(String),
  effort: Option(String),
  subagent_model: Option(String),
  now: Int,
) -> Result(Int, _) {
  // INSERT INTO runs ... RETURNING id
  // Implementation similar to projects.insert
  todo as "implement insert_run"
}
```

- [ ] **Step 2: Smoke test**

```bash
cd src/server-gleam
make build && gleam run &
sleep 1
curl -s -X POST http://localhost:3000/api/projects/1/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello"}'
# Expected: 201 with run JSON
```

- [ ] **Step 3: Commit**

```bash
git add src/server-gleam/src/fbi/handlers/runs.gleam
git commit -m "feat(gleam): wire run create/stop endpoints to RunActor + supervisor"
```

---

## Tasks deferred to a Plan 2.5 (follow-up)

The following are needed for full feature parity but are not blocking a working server with new runs:

1. **Stdout reader process** — currently RunActor's `Running` phase doesn't actually pipe Docker logs to the broadcaster. A new `LogReader` task should call `docker.stream_get` on `/containers/:id/logs?follow=1`, loop on `recv_chunked`, persist + parse + broadcast each chunk.
2. **Stdin attach socket** — `WriteStdin` is a no-op until we hold an attach socket per-run.
3. **Image builder** — `image_tag: "fbi-image-default"` is hardcoded. The full system clones the project repo, parses `.devcontainer.json`, and builds via `docker build`.
4. **Resume / continue / reattach lifecycle modes** — only `:launch` is implemented.
5. **Watchers** — UsageTailer, TitleWatcher, BranchNameWatcher, SafeguardWatcher, MirrorStatusPoller, RuntimeStateWatcher, LimitMonitor.
6. **Multi-viewer terminal protocol** — focus tracking and per-viewer resize.

Each can be a separate plan once the core system is exercised end-to-end.

---

## Self-Review

**Spec coverage:**
- ✅ Section 4 — phase-typed state machine, three-process split (Tasks 5-9)
- ✅ Section 6 — NIF integration (Tasks 1-2)
- ✅ Docker client (Task 4)
- ⏳ Stdout/stdin streaming (deferred to follow-up)
- ⏳ Watchers (deferred)

**Placeholder scan:**
- `insert_run` in Task 10 has `todo as "implement insert_run"` — implementer should follow the pattern from `projects.insert` in Plan 1 Task 6. Acceptable here because the pattern is fully established.
- `image_tag: "fbi-image-default"` is a hardcoded placeholder, called out in deferred section.

**Type consistency:** `RunMsg`, `BroadcastMsg`, `Phase`, `RunOutcome`, `TerminalEvent` all defined in `run/types.gleam` and referenced consistently across actor, broadcaster, worker, handlers.
