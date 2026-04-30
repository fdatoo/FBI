import fbi/context.{type Context}
import gleam/http
import gleam/json
import wisp.{type Request, type Response}

/// WIP endpoints (status, file diff, discard, patch download). These all
/// return graceful empty/no-wip responses until git plumbing is added.
pub fn handle_status(req: Request, _ctx: Context, _id: String) -> Response {
  case req.method {
    http.Get ->
      json.object([
        #("ok", json.bool(False)),
        #("reason", json.string("no-wip")),
      ])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_file(req: Request, _ctx: Context, _id: String) -> Response {
  case req.method {
    http.Get ->
      json.object([
        #("path", json.string("")),
        #("ref", json.string("worktree")),
        #("hunks", json.array([], json.string)),
        #("truncated", json.bool(False)),
      ])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_discard(req: Request, _ctx: Context, _id: String) -> Response {
  case req.method {
    http.Post -> wisp.response(204)
    _ -> wisp.method_not_allowed([http.Post])
  }
}

pub fn handle_patch(req: Request, _ctx: Context, _id: String) -> Response {
  case req.method {
    http.Get ->
      wisp.response(200)
      |> wisp.set_header("content-type", "text/plain; charset=utf-8")
      |> wisp.set_body(wisp.Text(""))
    _ -> wisp.method_not_allowed([http.Get])
  }
}
