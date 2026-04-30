import fbi/context.{type Context}
import gleam/http
import gleam/json
import wisp.{type Request, type Response}

/// All git-introspection endpoints (changes, file-diff, commits, wip, etc.)
/// return graceful empty responses until the git plumbing is implemented.
/// This stops the frontend from showing 404 errors while keeping the
/// behaviour consistent with the documented out-of-scope checklist.
pub fn handle_changes(req: Request, _ctx: Context, _id: String) -> Response {
  case req.method {
    http.Get ->
      json.object([
        #("branch_name", json.null()),
        #("branch_base", json.null()),
        #("commits", json.array([], json.string)),
        #("uncommitted", json.array([], json.string)),
        #("integrations", json.object([])),
      ])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_commit_files(
  req: Request,
  _ctx: Context,
  _id: String,
  _sha: String,
) -> Response {
  case req.method {
    http.Get ->
      json.object([#("files", json.array([], json.string))])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_submodule_commit_files(
  req: Request,
  _ctx: Context,
  _id: String,
  _path: String,
  _sha: String,
) -> Response {
  case req.method {
    http.Get ->
      json.object([#("files", json.array([], json.string))])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_file_diff(req: Request, _ctx: Context, _id: String) -> Response {
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

pub fn handle_history(req: Request, _ctx: Context, _id: String) -> Response {
  case req.method {
    http.Post ->
      json.object([
        #("kind", json.string("git-unavailable")),
        #("message", json.string("git operations not yet implemented")),
      ])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Post])
  }
}
