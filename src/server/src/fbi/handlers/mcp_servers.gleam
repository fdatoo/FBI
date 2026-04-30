import fbi/context.{type Context}
import fbi/db/connection
import fbi/db/mcp_servers
import fbi/json/mcp_server as mcp_server_json
import gleam/dynamic/decode
import gleam/http
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}
import wisp.{type Request, type Response}

// Global MCP servers (no project)
pub fn handle_global(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get -> list_global(ctx)
    http.Post -> create_global(req, ctx)
    _ -> wisp.method_not_allowed([http.Get, http.Post])
  }
}

pub fn handle_global_one(
  req: Request,
  ctx: Context,
  id_str: String,
) -> Response {
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid MCP server ID")
    Ok(id) ->
      case req.method {
        http.Get -> show(ctx, id)
        http.Patch -> update(req, ctx, id)
        http.Delete -> delete(ctx, id)
        _ -> wisp.method_not_allowed([http.Get, http.Patch, http.Delete])
      }
  }
}

// Project-scoped MCP servers
pub fn handle_for_project(
  req: Request,
  ctx: Context,
  project_id_str: String,
) -> Response {
  case int.parse(project_id_str) {
    Error(_) -> wisp.bad_request("Invalid project ID")
    Ok(project_id) ->
      case req.method {
        http.Get -> list_for_project(ctx, project_id)
        http.Post -> create_for_project(req, ctx, project_id)
        _ -> wisp.method_not_allowed([http.Get, http.Post])
      }
  }
}

pub fn handle_for_project_one(
  req: Request,
  ctx: Context,
  _project_id_str: String,
  id_str: String,
) -> Response {
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid MCP server ID")
    Ok(id) ->
      case req.method {
        http.Get -> show(ctx, id)
        http.Patch -> update(req, ctx, id)
        http.Delete -> delete(ctx, id)
        _ -> wisp.method_not_allowed([http.Get, http.Patch, http.Delete])
      }
  }
}

fn list_global(ctx: Context) -> Response {
  case mcp_servers.list_global(ctx.db) {
    Ok(servers) ->
      json.array(servers, mcp_server_json.encode)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(_) -> wisp.internal_server_error()
  }
}

fn list_for_project(ctx: Context, project_id: Int) -> Response {
  case mcp_servers.list_for_project(ctx.db, project_id) {
    Ok(servers) ->
      json.array(servers, mcp_server_json.encode)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(_) -> wisp.internal_server_error()
  }
}

fn show(ctx: Context, id: Int) -> Response {
  case mcp_servers.get(ctx.db, id) {
    Ok(s) ->
      mcp_server_json.encode(s)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(connection.NotFound) -> wisp.not_found()
    Error(_) -> wisp.internal_server_error()
  }
}

fn decode_body(
  body: decode.Dynamic,
) -> Result(
  #(String, String, Option(String), String, Option(String), String),
  List(decode.DecodeError),
) {
  let decoder = {
    use name <- decode.field("name", decode.string)
    use server_type <- decode.field("type", decode.string)
    use command <- decode.optional_field(
      "command",
      None,
      decode.optional(decode.string),
    )
    use args_json <- decode.optional_field("args_json", "[]", decode.string)
    use url <- decode.optional_field(
      "url",
      None,
      decode.optional(decode.string),
    )
    use env_json <- decode.optional_field("env_json", "{}", decode.string)
    decode.success(#(name, server_type, command, args_json, url, env_json))
  }
  decode.run(body, decoder)
}

fn create_global(req: Request, ctx: Context) -> Response {
  use body <- wisp.require_json(req)
  case decode_body(body) {
    Error(_) -> wisp.bad_request("Invalid request body")
    Ok(#(name, server_type, command, args_json, url, env_json)) -> {
      let now = now_ms()
      case
        mcp_servers.insert(
          ctx.db,
          None,
          name,
          server_type,
          command,
          args_json,
          url,
          env_json,
          now,
        )
      {
        Ok(s) ->
          mcp_server_json.encode(s)
          |> json.to_string()
          |> wisp.json_response(201)
        Error(_) -> wisp.internal_server_error()
      }
    }
  }
}

fn create_for_project(req: Request, ctx: Context, project_id: Int) -> Response {
  use body <- wisp.require_json(req)
  case decode_body(body) {
    Error(_) -> wisp.bad_request("Invalid request body")
    Ok(#(name, server_type, command, args_json, url, env_json)) -> {
      let now = now_ms()
      case
        mcp_servers.insert(
          ctx.db,
          Some(project_id),
          name,
          server_type,
          command,
          args_json,
          url,
          env_json,
          now,
        )
      {
        Ok(s) ->
          mcp_server_json.encode(s)
          |> json.to_string()
          |> wisp.json_response(201)
        Error(_) -> wisp.internal_server_error()
      }
    }
  }
}

fn update(req: Request, ctx: Context, id: Int) -> Response {
  use body <- wisp.require_json(req)
  let decoder = {
    use name <- decode.optional_field(
      "name",
      None,
      decode.optional(decode.string),
    )
    use server_type <- decode.optional_field(
      "type",
      None,
      decode.optional(decode.string),
    )
    use command <- decode.optional_field(
      "command",
      None,
      decode.optional(decode.optional(decode.string)),
    )
    use args_json <- decode.optional_field(
      "args_json",
      None,
      decode.optional(decode.string),
    )
    use url <- decode.optional_field(
      "url",
      None,
      decode.optional(decode.optional(decode.string)),
    )
    use env_json <- decode.optional_field(
      "env_json",
      None,
      decode.optional(decode.string),
    )
    decode.success(#(name, server_type, command, args_json, url, env_json))
  }
  case decode.run(body, decoder) {
    Error(_) -> wisp.bad_request("Invalid request body")
    Ok(#(name, server_type, command, args_json, url, env_json)) ->
      case
        mcp_servers.update(
          ctx.db,
          id,
          name,
          server_type,
          command,
          args_json,
          url,
          env_json,
        )
      {
        Ok(s) ->
          mcp_server_json.encode(s)
          |> json.to_string()
          |> wisp.json_response(200)
        Error(connection.NotFound) -> wisp.not_found()
        Error(_) -> wisp.internal_server_error()
      }
  }
}

fn delete(ctx: Context, id: Int) -> Response {
  case mcp_servers.delete(ctx.db, id) {
    Ok(_) -> wisp.response(204)
    Error(_) -> wisp.internal_server_error()
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
