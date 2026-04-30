import fbi/context.{type Context}
import fbi/db/connection
import fbi/db/projects
import fbi/json/project as project_json
import gleam/dynamic/decode
import gleam/http
import gleam/int
import gleam/json
import gleam/option.{None}
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get -> index(req, ctx)
    http.Post -> create(req, ctx)
    _ -> wisp.method_not_allowed([http.Get, http.Post])
  }
}

pub fn handle_one(req: Request, ctx: Context, id: String) -> Response {
  case req.method {
    http.Get -> show(req, ctx, id)
    http.Patch -> update(req, ctx, id)
    http.Delete -> delete(req, ctx, id)
    _ -> wisp.method_not_allowed([http.Get, http.Patch, http.Delete])
  }
}

fn index(_req: Request, ctx: Context) -> Response {
  case projects.list(ctx.db) {
    Ok(ps) ->
      json.array(ps, project_json.encode)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(e) -> {
      wisp.log_error("list projects: " <> connection.describe_error(e))
      wisp.internal_server_error()
    }
  }
}

fn create(req: Request, ctx: Context) -> Response {
  use body <- wisp.require_json(req)
  let decoder = {
    use name <- decode.field("name", decode.string)
    use repo_url <- decode.field("repo_url", decode.string)
    use default_branch <- decode.optional_field(
      "default_branch",
      "main",
      decode.string,
    )
    use instructions <- decode.optional_field(
      "instructions",
      None,
      decode.optional(decode.string),
    )
    use git_author_name <- decode.optional_field(
      "git_author_name",
      None,
      decode.optional(decode.string),
    )
    use git_author_email <- decode.optional_field(
      "git_author_email",
      None,
      decode.optional(decode.string),
    )
    use marketplaces_json <- decode.optional_field(
      "marketplaces_json",
      "[]",
      decode.string,
    )
    use plugins_json <- decode.optional_field(
      "plugins_json",
      "[]",
      decode.string,
    )
    use mem_mb <- decode.optional_field(
      "mem_mb",
      None,
      decode.optional(decode.int),
    )
    use cpus <- decode.optional_field(
      "cpus",
      None,
      decode.optional(decode.float),
    )
    use pids_limit <- decode.optional_field(
      "pids_limit",
      None,
      decode.optional(decode.int),
    )
    decode.success(#(
      name,
      repo_url,
      default_branch,
      instructions,
      git_author_name,
      git_author_email,
      marketplaces_json,
      plugins_json,
      mem_mb,
      cpus,
      pids_limit,
    ))
  }
  case decode.run(body, decoder) {
    Error(_) -> wisp.bad_request("Invalid request body")
    Ok(#(
      name,
      repo_url,
      default_branch,
      instructions,
      git_author_name,
      git_author_email,
      marketplaces_json,
      plugins_json,
      mem_mb,
      cpus,
      pids_limit,
    )) -> {
      let now = now_ms()
      let new_project =
        projects.NewProject(
          name: name,
          repo_url: repo_url,
          default_branch: default_branch,
          devcontainer_override_json: None,
          instructions: instructions,
          git_author_name: git_author_name,
          git_author_email: git_author_email,
          marketplaces_json: marketplaces_json,
          plugins_json: plugins_json,
          mem_mb: mem_mb,
          cpus: cpus,
          pids_limit: pids_limit,
          created_at: now,
          updated_at: now,
        )
      case projects.insert(ctx.db, new_project) {
        Ok(p) ->
          project_json.encode(p)
          |> json.to_string()
          |> wisp.json_response(201)
        Error(e) -> {
          wisp.log_error("insert project: " <> connection.describe_error(e))
          wisp.internal_server_error()
        }
      }
    }
  }
}

fn show(_req: Request, ctx: Context, id_str: String) -> Response {
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid project ID")
    Ok(id) ->
      case projects.get(ctx.db, id) {
        Ok(p) ->
          project_json.encode(p)
          |> json.to_string()
          |> wisp.json_response(200)
        Error(connection.NotFound) -> wisp.not_found()
        Error(e) -> {
          wisp.log_error(
            "get project " <> id_str <> ": " <> connection.describe_error(e),
          )
          wisp.internal_server_error()
        }
      }
  }
}

fn update(req: Request, ctx: Context, id_str: String) -> Response {
  use body <- wisp.require_json(req)
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid project ID")
    Ok(id) -> {
      let decoder = {
        use name <- decode.optional_field(
          "name",
          None,
          decode.optional(decode.string),
        )
        use repo_url <- decode.optional_field(
          "repo_url",
          None,
          decode.optional(decode.string),
        )
        use default_branch <- decode.optional_field(
          "default_branch",
          None,
          decode.optional(decode.string),
        )
        use devcontainer_override_json <- decode.optional_field(
          "devcontainer_override_json",
          None,
          decode.optional(decode.optional(decode.string)),
        )
        use instructions <- decode.optional_field(
          "instructions",
          None,
          decode.optional(decode.optional(decode.string)),
        )
        use git_author_name <- decode.optional_field(
          "git_author_name",
          None,
          decode.optional(decode.optional(decode.string)),
        )
        use git_author_email <- decode.optional_field(
          "git_author_email",
          None,
          decode.optional(decode.optional(decode.string)),
        )
        use marketplaces_json <- decode.optional_field(
          "marketplaces_json",
          None,
          decode.optional(decode.string),
        )
        use plugins_json <- decode.optional_field(
          "plugins_json",
          None,
          decode.optional(decode.string),
        )
        use mem_mb <- decode.optional_field(
          "mem_mb",
          None,
          decode.optional(decode.optional(decode.int)),
        )
        use cpus <- decode.optional_field(
          "cpus",
          None,
          decode.optional(decode.optional(decode.float)),
        )
        use pids_limit <- decode.optional_field(
          "pids_limit",
          None,
          decode.optional(decode.optional(decode.int)),
        )
        decode.success(projects.PatchProject(
          name: name,
          repo_url: repo_url,
          default_branch: default_branch,
          devcontainer_override_json: devcontainer_override_json,
          instructions: instructions,
          git_author_name: git_author_name,
          git_author_email: git_author_email,
          marketplaces_json: marketplaces_json,
          plugins_json: plugins_json,
          mem_mb: mem_mb,
          cpus: cpus,
          pids_limit: pids_limit,
        ))
      }
      case decode.run(body, decoder) {
        Error(_) -> wisp.bad_request("Invalid request body")
        Ok(patch) ->
          case projects.update(ctx.db, id, patch, now_ms()) {
            Ok(p) ->
              project_json.encode(p)
              |> json.to_string()
              |> wisp.json_response(200)
            Error(connection.NotFound) -> wisp.not_found()
            Error(e) -> {
              wisp.log_error(
                "update project "
                <> int.to_string(id)
                <> ": "
                <> connection.describe_error(e),
              )
              wisp.internal_server_error()
            }
          }
      }
    }
  }
}

fn delete(_req: Request, ctx: Context, id_str: String) -> Response {
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid project ID")
    Ok(id) ->
      case projects.delete(ctx.db, id) {
        Ok(_) -> wisp.response(204)
        Error(e) -> {
          wisp.log_error(
            "delete project "
            <> int.to_string(id)
            <> ": "
            <> connection.describe_error(e),
          )
          wisp.internal_server_error()
        }
      }
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
