import fbi/context.{type Context}
import gleam/http
import gleam/json
import wisp.{type Request, type Response}

/// Listening ports inside a run's container. A real implementation needs
/// `docker exec ss -tnlp` (or equivalent) and parsing — until then this
/// returns an empty list to satisfy the UI.
pub fn handle(req: Request, _ctx: Context, _id_str: String) -> Response {
  case req.method {
    http.Get ->
      json.object([#("ports", json.array([], json.string))])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}
