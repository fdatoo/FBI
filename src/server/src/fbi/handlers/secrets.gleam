import fbi/context.{type Context}
import fbi/db/secrets
import gleam/dynamic/decode
import gleam/http
import gleam/int
import gleam/json
import wisp.{type Request, type Response}

pub fn index(req: Request, ctx: Context, project_id_str: String) -> Response {
  case req.method {
    http.Get ->
      case int.parse(project_id_str) {
        Error(_) -> wisp.bad_request("")
        Ok(project_id) ->
          case secrets.list(ctx.db, project_id) {
            Ok(ss) ->
              json.array(ss, fn(s) {
                json.object([
                  #("id", json.int(s.id)),
                  #("project_id", json.int(s.project_id)),
                  #("name", json.string(s.name)),
                  #("created_at", json.int(s.created_at)),
                ])
              })
              |> json.to_string()
              |> wisp.json_response(200)
            Error(_) -> wisp.internal_server_error()
          }
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn put(
  req: Request,
  ctx: Context,
  project_id_str: String,
  name: String,
) -> Response {
  case req.method {
    http.Put -> {
      use body <- wisp.require_json(req)
      case int.parse(project_id_str) {
        Error(_) -> wisp.bad_request("")
        Ok(project_id) -> {
          let decoder = {
            use value <- decode.field("value", decode.string)
            decode.success(value)
          }
          case decode.run(body, decoder) {
            Error(_) -> wisp.bad_request("")
            Ok(value) ->
              case
                secrets.put(
                  ctx.db,
                  project_id,
                  name,
                  value,
                  ctx.config.secrets_key,
                  now_ms(),
                )
              {
                Ok(_) -> wisp.response(204)
                Error(_) -> wisp.internal_server_error()
              }
          }
        }
      }
    }
    _ -> wisp.method_not_allowed([http.Put])
  }
}

pub fn delete(
  req: Request,
  ctx: Context,
  project_id_str: String,
  name: String,
) -> Response {
  case req.method {
    http.Delete ->
      case int.parse(project_id_str) {
        Error(_) -> wisp.bad_request("")
        Ok(project_id) ->
          case secrets.delete(ctx.db, project_id, name) {
            Ok(_) -> wisp.response(204)
            Error(_) -> wisp.internal_server_error()
          }
      }
    _ -> wisp.method_not_allowed([http.Delete])
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
