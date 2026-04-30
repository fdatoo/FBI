import fbi/context.{type Context}
import gleam/http
import gleam/json
import wisp.{type Request, type Response}

/// POST /api/runs/:id/github/pr — create a PR from the run's branch.
/// Currently unimplemented; returns 501 with a JSON body the UI can
/// surface as an error.
pub fn handle_pr(req: Request, _ctx: Context, _id: String) -> Response {
  case req.method {
    http.Post ->
      json.object([
        #("error", json.string("not_implemented")),
        #("message", json.string("PR creation is not yet implemented")),
      ])
      |> json.to_string()
      |> wisp.json_response(501)
    _ -> wisp.method_not_allowed([http.Post])
  }
}
