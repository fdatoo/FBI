import fbi/context.{type Context}
import gleam/http
import gleam/json
import wisp.{type Request, type Response}

/// File upload endpoints. Currently unimplemented — return empty lists for
/// GET and 501 for mutating requests so the frontend can render the
/// attachment UI without errors but won't see uploaded content. A real
/// implementation needs multipart parsing + per-run/per-draft storage
/// under runs_dir.
pub fn handle_draft_root(req: Request, _ctx: Context) -> Response {
  case req.method {
    http.Post -> wisp.response(501)
    _ -> wisp.method_not_allowed([http.Post])
  }
}

pub fn handle_draft_file(
  req: Request,
  _ctx: Context,
  _token: String,
  _filename: String,
) -> Response {
  case req.method {
    http.Delete -> wisp.response(204)
    _ -> wisp.method_not_allowed([http.Delete])
  }
}

pub fn handle_run_uploads(req: Request, _ctx: Context, _id: String) -> Response {
  case req.method {
    http.Get ->
      json.object([#("files", json.array([], json.string))])
      |> json.to_string()
      |> wisp.json_response(200)
    http.Post -> wisp.response(501)
    _ -> wisp.method_not_allowed([http.Get, http.Post])
  }
}

pub fn handle_run_upload_file(
  req: Request,
  _ctx: Context,
  _id: String,
  _filename: String,
) -> Response {
  case req.method {
    http.Delete -> wisp.response(204)
    _ -> wisp.method_not_allowed([http.Delete])
  }
}
