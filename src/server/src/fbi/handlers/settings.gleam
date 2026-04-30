import fbi/context.{type Context}
import fbi/db/projects
import fbi/db/settings
import fbi/json/settings as settings_json
import fbi/run/image_builder
import fbi/run/image_gc
import gleam/dynamic/decode
import gleam/http
import gleam/json
import gleam/option.{type Option, None}
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get -> show(ctx)
    http.Patch -> update(req, ctx)
    _ -> wisp.method_not_allowed([http.Get, http.Patch])
  }
}

fn show(ctx: Context) -> Response {
  case settings.get(ctx.db) {
    Ok(s) ->
      settings_json.encode(s)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(_) -> wisp.internal_server_error()
  }
}

fn update(req: Request, ctx: Context) -> Response {
  use body <- wisp.require_json(req)
  let decoder = {
    use global_prompt <- decode.optional_field(
      "global_prompt",
      None,
      decode.optional(decode.string),
    )
    use notifications_enabled <- decode.optional_field(
      "notifications_enabled",
      None,
      decode.optional(decode.bool),
    )
    use auto_resume_enabled <- decode.optional_field(
      "auto_resume_enabled",
      None,
      decode.optional(decode.bool),
    )
    use auto_resume_max_attempts <- decode.optional_field(
      "auto_resume_max_attempts",
      None,
      decode.optional(decode.int),
    )
    use concurrency_warn_at <- decode.optional_field(
      "concurrency_warn_at",
      None,
      decode.optional(decode.int),
    )
    use image_gc_enabled <- decode.optional_field(
      "image_gc_enabled",
      None,
      decode.optional(decode.bool),
    )
    use global_marketplaces <- decode.optional_field(
      "global_marketplaces",
      None,
      decode.optional(decode.list(decode.string)),
    )
    use global_plugins <- decode.optional_field(
      "global_plugins",
      None,
      decode.optional(decode.list(decode.string)),
    )
    use usage_notifications_enabled <- decode.optional_field(
      "usage_notifications_enabled",
      None,
      decode.optional(decode.bool),
    )
    decode.success(#(
      global_prompt,
      notifications_enabled,
      auto_resume_enabled,
      auto_resume_max_attempts,
      concurrency_warn_at,
      image_gc_enabled,
      global_marketplaces,
      global_plugins,
      usage_notifications_enabled,
    ))
  }
  case decode.run(body, decoder) {
    Error(_) -> wisp.bad_request("Invalid request body")
    Ok(#(
      global_prompt,
      notifications_enabled,
      auto_resume_enabled,
      auto_resume_max_attempts,
      concurrency_warn_at,
      image_gc_enabled,
      global_marketplaces,
      global_plugins,
      usage_notifications_enabled,
    )) -> {
      let now = now_ms()
      let encode_list = fn(ms: Option(List(String))) {
        option.map(ms, fn(xs) {
          json.array(xs, json.string) |> json.to_string()
        })
      }
      case
        settings.patch(
          ctx.db,
          global_prompt,
          notifications_enabled,
          auto_resume_enabled,
          auto_resume_max_attempts,
          concurrency_warn_at,
          image_gc_enabled,
          encode_list(global_marketplaces),
          encode_list(global_plugins),
          usage_notifications_enabled,
          now,
        )
      {
        Ok(s) ->
          settings_json.encode(s)
          |> json.to_string()
          |> wisp.json_response(200)
        Error(_) -> wisp.internal_server_error()
      }
    }
  }
}

pub fn handle_run_gc(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Post -> run_gc_now(ctx)
    _ -> wisp.method_not_allowed([http.Post])
  }
}

fn run_gc_now(ctx: Context) -> Response {
  case image_builder.read_postbuild() {
    Error(_) -> wisp.internal_server_error()
    Ok(postbuild) ->
      case projects.list(ctx.db) {
        Error(_) -> wisp.internal_server_error()
        Ok(all_projects) -> {
          let now = now_ms()
          let result = image_gc.sweep(all_projects, postbuild, now, ctx.config)
          let _ =
            settings.update_gc_result(
              ctx.db,
              result.deleted_count,
              result.deleted_bytes,
              now,
            )
          json.object([
            #("deleted_count", json.int(result.deleted_count)),
            #("deleted_bytes", json.int(result.deleted_bytes)),
            #(
              "errors",
              json.array(result.errors, fn(e) {
                json.object([
                  #("tag", json.string(e.tag)),
                  #("message", json.string(e.message)),
                ])
              }),
            ),
          ])
          |> json.to_string()
          |> wisp.json_response(200)
        }
      }
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
