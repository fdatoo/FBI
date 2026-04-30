import fbi/context.{type Context}
import gleam/http
import gleam/http/request
import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import simplifile
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> serve(req, ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve(req: Request, ctx: Context, id: Int) -> Response {
  let path =
    ctx.config.runs_dir <> "/" <> int.to_string(id) <> "/transcript.log"
  case simplifile.file_info(path) {
    Error(_) -> wisp.not_found()
    Ok(info) -> {
      let size = info.size
      case parse_range(req, size) {
        FullBody -> serve_full(path, size)
        RangeBytes(start, length) -> serve_partial(path, start, length, size)
        Unsatisfiable ->
          wisp.response(416)
          |> wisp.set_header("content-range", "bytes */" <> int.to_string(size))
      }
    }
  }
}

fn serve_full(path: String, _size: Int) -> Response {
  wisp.response(200)
  |> wisp.set_header("content-type", "application/octet-stream")
  |> wisp.set_body(wisp.File(path: path, offset: 0, limit: None))
}

fn serve_partial(path: String, start: Int, length: Int, size: Int) -> Response {
  let end = start + length - 1
  wisp.response(206)
  |> wisp.set_header("content-type", "application/octet-stream")
  |> wisp.set_header(
    "content-range",
    "bytes "
      <> int.to_string(start)
      <> "-"
      <> int.to_string(end)
      <> "/"
      <> int.to_string(size),
  )
  |> wisp.set_body(wisp.File(path: path, offset: start, limit: Some(length)))
}

type RangeResult {
  FullBody
  RangeBytes(start: Int, length: Int)
  Unsatisfiable
}

fn parse_range(req: Request, size: Int) -> RangeResult {
  case request.get_header(req, "range") {
    Error(_) -> FullBody
    Ok(value) -> parse_range_value(string.trim(value), size)
  }
}

fn parse_range_value(value: String, size: Int) -> RangeResult {
  case string.split_once(value, "=") {
    Error(_) -> FullBody
    Ok(#(unit, spec)) ->
      case string.lowercase(string.trim(unit)) {
        "bytes" -> parse_bytes_spec(string.trim(spec), size)
        _ -> FullBody
      }
  }
}

fn parse_bytes_spec(spec: String, size: Int) -> RangeResult {
  case list.first(string.split(spec, ",")) {
    Error(_) -> FullBody
    Ok(first) -> parse_single_range(string.trim(first), size)
  }
}

fn parse_single_range(spec: String, size: Int) -> RangeResult {
  case string.split_once(spec, "-") {
    Error(_) -> Unsatisfiable
    Ok(#(start_str, end_str)) -> {
      let s = string.trim(start_str)
      let e = string.trim(end_str)
      case s, e {
        "", "" -> Unsatisfiable
        "", suffix_str ->
          case int.parse(suffix_str) {
            Error(_) -> Unsatisfiable
            Ok(n) -> {
              let start = int.max(0, size - n)
              let length = size - start
              case length > 0 {
                True -> RangeBytes(start: start, length: length)
                False -> Unsatisfiable
              }
            }
          }
        start_str, "" ->
          case int.parse(start_str) {
            Error(_) -> Unsatisfiable
            Ok(start) ->
              case start >= size {
                True -> Unsatisfiable
                False -> RangeBytes(start: start, length: size - start)
              }
          }
        start_str, end_str ->
          case int.parse(start_str), int.parse(end_str) {
            Ok(start), Ok(end) -> {
              let capped_end = int.min(end, size - 1)
              case start > capped_end || start >= size {
                True -> Unsatisfiable
                False ->
                  RangeBytes(start: start, length: capped_end - start + 1)
              }
            }
            _, _ -> Unsatisfiable
          }
      }
    }
  }
}
