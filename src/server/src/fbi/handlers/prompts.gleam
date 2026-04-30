import fbi/context.{type Context}
import fbi/db/connection
import fbi/db/runs
import gleam/http
import gleam/int
import gleam/json
import gleam/list
import gleam/result
import wisp.{type Request, type Response}

pub fn handle_recent(
  req: Request,
  ctx: Context,
  project_id_str: String,
) -> Response {
  case req.method {
    http.Get -> serve_recent(req, ctx, project_id_str)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_recent(req: Request, ctx: Context, project_id_str: String) -> Response {
  case int.parse(project_id_str) {
    Error(_) -> wisp.bad_request("Invalid project ID")
    Ok(pid) -> {
      let limit =
        wisp.get_query(req)
        |> list.key_find("limit")
        |> result.try(int.parse)
        |> result.unwrap(10)
      case runs.recent_prompts(ctx.db, pid, limit) {
        Error(e) -> {
          wisp.log_error("recent prompts: " <> connection.describe_error(e))
          wisp.internal_server_error()
        }
        Ok(rs) ->
          json.array(rs, fn(r) {
            json.object([
              #("prompt", json.string(r.prompt)),
              #("last_used_at", json.int(r.last_used_at)),
              #("run_id", json.int(r.run_id)),
            ])
          })
          |> json.to_string()
          |> wisp.json_response(200)
      }
    }
  }
}
