import fbi/context.{type Context}
import gleam/bytes_tree
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
  case simplifile.is_file(full_path) {
    Ok(True) -> stream_file(full_path)
    _ ->
      case is_spa_route(req, rel) {
        True -> {
          let index = dir <> "/index.html"
          case simplifile.is_file(index) {
            Ok(True) -> stream_file(index)
            _ -> wisp.not_found()
          }
        }
        False -> wisp.not_found()
      }
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
  case simplifile.read_bits(path) {
    Ok(bits) ->
      wisp.response(200)
      |> wisp.set_header("content-type", content_type)
      |> wisp.set_body(wisp.Bytes(bytes_tree.from_bit_array(bits)))
    Error(_) -> wisp.not_found()
  }
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
