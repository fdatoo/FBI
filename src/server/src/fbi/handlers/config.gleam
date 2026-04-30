import fbi/context.{type Context}
import gleam/http
import gleam/json
import wisp.{type Request, type Response}

pub fn handle_defaults(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get ->
      json.object([
        #(
          "defaultMarketplaces",
          json.array(ctx.config.default_marketplaces, json.string),
        ),
        #("defaultPlugins", json.array(ctx.config.default_plugins, json.string)),
      ])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}
