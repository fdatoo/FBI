import gleam/json
import wisp.{type Request, type Response}

pub fn show(_req: Request) -> Response {
  json.object([#("status", json.string("ok"))])
  |> json.to_string()
  |> wisp.json_response(200)
}
