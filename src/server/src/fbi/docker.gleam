import fbi/docker/framing
import gleam/bit_array
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string

pub type DockerError {
  ConnectError(String)
  HttpError(Int, String)
  DecodeError(String)
  Timeout
}

pub type ImageInfo {
  ImageInfo(id: String, repo_tags: List(String), created: Int, size: Int)
}

pub type ContainerInfo {
  ContainerInfo(image_id: String)
}

pub type ContainerStatus {
  ContainerRunning
  ContainerExited(exit_code: Int)
  ContainerNotFound
}

pub fn describe_error(e: DockerError) -> String {
  case e {
    ConnectError(s) -> "connect: " <> s
    HttpError(code, msg) -> "http " <> int.to_string(code) <> ": " <> msg
    DecodeError(s) -> "decode: " <> s
    Timeout -> "timeout"
  }
}

pub opaque type Socket {
  Socket(port: Dynamic)
}

const default_socket_path = "/var/run/docker.sock"

pub fn connect(socket_path: String) -> Result(Socket, DockerError) {
  let path = case socket_path {
    "" -> default_socket_path
    p -> p
  }
  case gen_tcp_connect_unix(bit_array.from_string(path)) {
    Ok(port) -> Ok(Socket(port))
    Error(reason) -> Error(ConnectError(reason))
  }
}

pub fn close(sock: Socket) -> Nil {
  gen_tcp_close(sock.port)
}

pub fn request(
  sock: Socket,
  method: String,
  path: String,
  body: BitArray,
  content_type: String,
) -> Result(#(Int, BitArray), DockerError) {
  let body_size = bit_array.byte_size(body)
  let headers =
    method
    <> " "
    <> path
    <> " HTTP/1.1\r\n"
    <> "Host: docker\r\n"
    <> "Content-Type: "
    <> content_type
    <> "\r\n"
    <> "Content-Length: "
    <> int.to_string(body_size)
    <> "\r\n"
    <> "Connection: close\r\n\r\n"
  let req = bit_array.append(bit_array.from_string(headers), body)
  use _ <- result.try(send(sock, req))
  use #(status, resp_body) <- result.try(read_response(sock))
  Ok(#(status, resp_body))
}

pub fn create_container(
  sock: Socket,
  spec: json.Json,
  name: String,
) -> Result(String, DockerError) {
  let body = bit_array.from_string(json.to_string(spec))
  let path = "/containers/create?name=" <> uri_encode(name)
  use #(status, resp) <- result.try(request(
    sock,
    "POST",
    path,
    body,
    "application/json",
  ))
  case status {
    code if code >= 200 && code < 300 -> {
      use s <- result.try(to_string(resp))
      let id_decoder = {
        use id <- decode.field("Id", decode.string)
        decode.success(id)
      }
      json.parse(s, id_decoder)
      |> result.map_error(fn(_) { DecodeError("missing Id") })
    }
    code -> Error(HttpError(code, result.unwrap(to_string(resp), "")))
  }
}

pub fn start_container(sock: Socket, id: String) -> Result(Nil, DockerError) {
  use #(status, _) <- result.try(request(
    sock,
    "POST",
    "/containers/" <> id <> "/start",
    <<>>,
    "application/json",
  ))
  case status {
    204 | 304 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn stop_container(
  sock: Socket,
  id: String,
  timeout_s: Int,
) -> Result(Nil, DockerError) {
  let t = int.to_string(timeout_s)
  use #(status, _) <- result.try(request(
    sock,
    "POST",
    "/containers/" <> id <> "/stop?t=" <> t,
    <<>>,
    "application/json",
  ))
  case status {
    204 | 304 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn kill_container(sock: Socket, id: String) -> Result(Nil, DockerError) {
  use #(status, _) <- result.try(request(
    sock,
    "POST",
    "/containers/" <> id <> "/kill",
    <<>>,
    "application/json",
  ))
  case status {
    204 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn remove_container(
  sock: Socket,
  id: String,
  force: Bool,
) -> Result(Nil, DockerError) {
  let qs = case force {
    True -> "?force=1&v=1"
    False -> "?v=1"
  }
  use #(status, _) <- result.try(request(
    sock,
    "DELETE",
    "/containers/" <> id <> qs,
    <<>>,
    "application/json",
  ))
  case status {
    204 | 404 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

pub fn wait_container(sock: Socket, id: String) -> Result(Int, DockerError) {
  use #(status, body) <- result.try(request(
    sock,
    "POST",
    "/containers/" <> id <> "/wait",
    <<>>,
    "application/json",
  ))
  case status {
    200 -> {
      use s <- result.try(to_string(body))
      let code_decoder = {
        use code <- decode.field("StatusCode", decode.int)
        decode.success(code)
      }
      json.parse(s, code_decoder)
      |> result.map_error(fn(_) { DecodeError("missing StatusCode") })
    }
    code -> Error(HttpError(code, ""))
  }
}

pub fn resize_container(
  sock: Socket,
  id: String,
  cols: Int,
  rows: Int,
) -> Result(Nil, DockerError) {
  let path =
    "/containers/"
    <> id
    <> "/resize?w="
    <> int.to_string(cols)
    <> "&h="
    <> int.to_string(rows)
  use #(status, _) <- result.try(request(
    sock,
    "POST",
    path,
    <<>>,
    "application/json",
  ))
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
  let path = "/containers/" <> id <> "/archive?path=" <> uri_encode(target_dir)
  use #(status, _) <- result.try(request(
    sock,
    "PUT",
    path,
    tar_archive,
    "application/x-tar",
  ))
  case status {
    200 -> Ok(Nil)
    code -> Error(HttpError(code, ""))
  }
}

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

pub fn inspect_container(
  sock: Socket,
  id: String,
) -> Result(ContainerStatus, DockerError) {
  use #(status, resp) <- result.try(request(
    sock,
    "GET",
    "/containers/" <> id <> "/json",
    <<>>,
    "application/json",
  ))
  case status {
    404 -> Ok(ContainerNotFound)
    200 -> {
      use s <- result.try(to_string(resp))
      let decoder = {
        use running <- decode.subfield(["State", "Running"], decode.bool)
        use exit_code <- decode.subfield(["State", "ExitCode"], decode.int)
        decode.success(#(running, exit_code))
      }
      case json.parse(s, decoder) {
        Error(_) -> Error(DecodeError("inspect_container"))
        Ok(#(True, _)) -> Ok(ContainerRunning)
        Ok(#(False, code)) -> Ok(ContainerExited(code))
      }
    }
    code -> Error(HttpError(code, result.unwrap(to_string(resp), "")))
  }
}

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

pub fn attach_container_output(
  sock: Socket,
  id: String,
  on_chunk: fn(BitArray) -> Nil,
) -> Result(Nil, DockerError) {
  let path = "/containers/" <> id <> "/attach?stream=1&stdout=1&stderr=1&logs=0"
  let header_str =
    "POST "
    <> path
    <> " HTTP/1.1\r\n"
    <> "Host: docker\r\n"
    <> "Connection: close\r\n\r\n"
  use _ <- result.try(send(sock, bit_array.from_string(header_str)))
  use #(status, body_prefix) <- result.try(read_until_header_end(sock, <<>>))
  case status {
    200 -> stream_raw_chunks(sock, body_prefix, on_chunk)
    code -> Error(HttpError(code, ""))
  }
}

/// Sends the HTTP Upgrade request for a bidirectional (stdin+stdout) attach.
/// Returns the body bytes already received after the response headers.
/// After this returns Ok, use stream_raw_output in a spawned process to read
/// output, and send_bytes from any process to write stdin.
pub fn start_bidirectional_attach(
  sock: Socket,
  id: String,
) -> Result(BitArray, DockerError) {
  let path =
    "/containers/" <> id <> "/attach?stream=1&stdin=1&stdout=1&stderr=1"
  let header_str =
    "POST "
    <> path
    <> " HTTP/1.1\r\n"
    <> "Host: docker\r\n"
    <> "Upgrade: tcp\r\n"
    <> "Connection: Upgrade\r\n\r\n"
  use _ <- result.try(send(sock, bit_array.from_string(header_str)))
  use #(status, body_prefix) <- result.try(read_until_header_end(sock, <<>>))
  case status {
    101 | 200 -> Ok(body_prefix)
    code -> Error(HttpError(code, "attach rejected"))
  }
}

/// Stream raw bytes from sock until the connection closes, forwarding each
/// chunk to on_chunk. Pass initial_bytes if any data was already read during
/// header parsing. Handles 5-second recv timeouts transparently.
pub fn stream_raw_output(
  sock: Socket,
  initial_bytes: BitArray,
  on_chunk: fn(BitArray) -> Nil,
) -> Result(Nil, DockerError) {
  stream_raw_chunks(sock, initial_bytes, on_chunk)
}

/// Write raw bytes to a Docker socket — used for stdin on a bidirectional attach.
/// Safe to call from any process; gen_tcp send is not ownership-restricted.
pub fn send_bytes(sock: Socket, data: BitArray) -> Result(Nil, DockerError) {
  gen_tcp_send(sock.port, data)
  |> result.map_error(ConnectError)
}

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

// ── FFI ──────────────────────────────────────────────────────────────────────

@external(erlang, "fbi_docker_ffi", "connect_unix")
fn gen_tcp_connect_unix(path: BitArray) -> Result(Dynamic, String)

@external(erlang, "fbi_docker_ffi", "close")
fn gen_tcp_close(port: Dynamic) -> Nil

@external(erlang, "fbi_docker_ffi", "send")
fn gen_tcp_send(port: Dynamic, data: BitArray) -> Result(Nil, String)

@external(erlang, "fbi_docker_ffi", "recv")
fn gen_tcp_recv(port: Dynamic, length: Int) -> Result(BitArray, String)

fn send(sock: Socket, data: BitArray) -> Result(Nil, DockerError) {
  gen_tcp_send(sock.port, data)
  |> result.map_error(ConnectError)
}

fn recv(sock: Socket, length: Int) -> Result(BitArray, DockerError) {
  gen_tcp_recv(sock.port, length)
  |> result.map_error(ConnectError)
}

fn read_response(sock: Socket) -> Result(#(Int, BitArray), DockerError) {
  use all <- result.try(read_until_close(sock, <<>>))
  parse_http_response(all)
}

fn read_until_close(
  sock: Socket,
  acc: BitArray,
) -> Result(BitArray, DockerError) {
  case recv(sock, 0) {
    Ok(<<>>) -> Ok(acc)
    Ok(chunk) -> read_until_close(sock, bit_array.append(acc, chunk))
    Error(ConnectError("timeout")) -> read_until_close(sock, acc)
    Error(_) -> Ok(acc)
  }
}

fn parse_http_response(
  buffer: BitArray,
) -> Result(#(Int, BitArray), DockerError) {
  case find_double_crlf(buffer, 0) {
    Error(_) -> Error(DecodeError("no header terminator"))
    Ok(header_end) -> {
      let buf_size = bit_array.byte_size(buffer)
      let assert Ok(header_bits) = bit_array.slice(buffer, 0, header_end)
      let body_size = buf_size - header_end - 4
      let assert Ok(raw_body) =
        bit_array.slice(buffer, header_end + 4, body_size)
      case bit_array.to_string(header_bits) {
        Error(_) -> Error(DecodeError("non-utf8 headers"))
        Ok(header_str) -> {
          case string.split(header_str, "\r\n") {
            [first, ..rest] -> {
              case string.split(first, " ") {
                [_, status_str, ..] ->
                  case int.parse(status_str) {
                    Ok(code) -> {
                      let body = case is_chunked(rest) {
                        True -> dechunk(raw_body)
                        False -> raw_body
                      }
                      Ok(#(code, body))
                    }
                    Error(_) ->
                      Error(DecodeError("invalid status: " <> status_str))
                  }
                _ -> Error(DecodeError("invalid status line"))
              }
            }
            _ -> Error(DecodeError("empty response"))
          }
        }
      }
    }
  }
}

fn is_chunked(headers: List(String)) -> Bool {
  list.any(headers, fn(h) {
    let lower = string.lowercase(h)
    string.starts_with(lower, "transfer-encoding:")
    && string.contains(lower, "chunked")
  })
}

/// Decode an HTTP/1.1 chunked transfer body to its payload bytes.
/// Format: <hex-size>\r\n<data>\r\n... terminated by 0\r\n\r\n.
/// On malformed input, returns whatever was successfully decoded so far.
fn dechunk(body: BitArray) -> BitArray {
  dechunk_loop(body, <<>>)
}

fn dechunk_loop(body: BitArray, acc: BitArray) -> BitArray {
  case find_crlf(body, 0) {
    Error(_) -> acc
    Ok(size_line_end) -> {
      let assert Ok(size_bits) = bit_array.slice(body, 0, size_line_end)
      case bit_array.to_string(size_bits) {
        Error(_) -> acc
        Ok(size_str) -> {
          let hex = case string.split_once(size_str, ";") {
            Ok(#(h, _)) -> h
            Error(_) -> size_str
          }
          case parse_hex(string.trim(hex)) {
            Error(_) -> acc
            Ok(0) -> acc
            Ok(size) -> {
              let data_start = size_line_end + 2
              case bit_array.slice(body, data_start, size) {
                Error(_) -> acc
                Ok(chunk_data) -> {
                  let next_start = data_start + size + 2
                  let body_size = bit_array.byte_size(body)
                  case next_start >= body_size {
                    True -> bit_array.append(acc, chunk_data)
                    False -> {
                      let assert Ok(rest) =
                        bit_array.slice(
                          body,
                          next_start,
                          body_size - next_start,
                        )
                      dechunk_loop(rest, bit_array.append(acc, chunk_data))
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

fn find_crlf(buf: BitArray, offset: Int) -> Result(Int, Nil) {
  case bit_array.slice(buf, offset, 2) {
    Ok(<<0x0d, 0x0a>>) -> Ok(offset)
    Ok(_) -> find_crlf(buf, offset + 1)
    Error(_) -> Error(Nil)
  }
}

fn parse_hex(s: String) -> Result(Int, Nil) {
  parse_hex_loop(string.to_graphemes(string.lowercase(s)), 0)
}

fn parse_hex_loop(chars: List(String), acc: Int) -> Result(Int, Nil) {
  case chars {
    [] -> Ok(acc)
    [c, ..rest] -> {
      case hex_digit(c) {
        Ok(d) -> parse_hex_loop(rest, acc * 16 + d)
        Error(_) -> Error(Nil)
      }
    }
  }
}

fn hex_digit(c: String) -> Result(Int, Nil) {
  case c {
    "0" -> Ok(0)
    "1" -> Ok(1)
    "2" -> Ok(2)
    "3" -> Ok(3)
    "4" -> Ok(4)
    "5" -> Ok(5)
    "6" -> Ok(6)
    "7" -> Ok(7)
    "8" -> Ok(8)
    "9" -> Ok(9)
    "a" -> Ok(10)
    "b" -> Ok(11)
    "c" -> Ok(12)
    "d" -> Ok(13)
    "e" -> Ok(14)
    "f" -> Ok(15)
    _ -> Error(Nil)
  }
}

fn find_double_crlf(buffer: BitArray, offset: Int) -> Result(Int, Nil) {
  case bit_array.slice(buffer, offset, 4) {
    Ok(<<0x0d, 0x0a, 0x0d, 0x0a>>) -> Ok(offset)
    Ok(_) -> find_double_crlf(buffer, offset + 1)
    Error(_) -> Error(Nil)
  }
}

fn to_string(b: BitArray) -> Result(String, DockerError) {
  bit_array.to_string(b)
  |> result.map_error(fn(_) { DecodeError("non-utf8 body") })
}

fn uri_encode(s: String) -> String {
  string.replace(s, "/", "%2F")
}

fn stream_raw_chunks(
  sock: Socket,
  pending: BitArray,
  on_chunk: fn(BitArray) -> Nil,
) -> Result(Nil, DockerError) {
  case bit_array.byte_size(pending) > 0 {
    True -> on_chunk(pending)
    False -> Nil
  }
  case recv(sock, 0) {
    Ok(<<>>) -> Ok(Nil)
    Ok(chunk) -> {
      on_chunk(chunk)
      stream_raw_chunks(sock, <<>>, on_chunk)
    }
    Error(ConnectError("timeout")) -> stream_raw_chunks(sock, <<>>, on_chunk)
    Error(_) -> Ok(Nil)
  }
}

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
      let header_bytes = bit_array.slice(new_buf, 0, pos) |> result.unwrap(<<>>)
      let body_prefix =
        bit_array.slice(new_buf, sep_end, buf_size - sep_end)
        |> result.unwrap(<<>>)
      use header_str <- result.try(
        to_string(header_bytes)
        |> result.map_error(fn(_) { DecodeError("header decode") }),
      )
      let status = parse_build_status(header_str)
      Ok(#(status, body_prefix))
    }
  }
}

fn parse_build_status(header_str: String) -> Int {
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
        Ok(<<>>) -> Ok(Nil)
        Ok(chunk) ->
          stream_build_lines(sock, bit_array.append(remainder, chunk), on_chunk)
        Error(ConnectError("timeout")) ->
          stream_build_lines(sock, remainder, on_chunk)
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

// Suppress unused import warning for framing module
pub fn unframe_output(b: BitArray) -> Result(BitArray, String) {
  framing.unframe(b)
}
