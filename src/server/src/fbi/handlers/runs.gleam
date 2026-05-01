import fbi/context.{type Context}
import fbi/db/connection
import fbi/db/projects
import fbi/db/runs
import fbi/db/secrets as db_secrets
import fbi/db/settings
import fbi/json/run as run_json
import fbi/run/reattach as run_reattach
import fbi/run/registry as run_registry
import fbi/run/supervisor as run_supervisor
import fbi/run/types as run_types
import fbi/run/worker as run_worker
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/http
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import wisp.{type Request, type Response}

pub fn handle_list(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get -> index(req, ctx)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_one(req: Request, ctx: Context, id_str: String) -> Response {
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid run ID")
    Ok(id) ->
      case req.method {
        http.Get -> show(ctx, id)
        http.Patch -> patch(req, ctx, id)
        http.Delete -> delete(ctx, id)
        _ -> wisp.method_not_allowed([http.Get, http.Patch, http.Delete])
      }
  }
}

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
        http.Post -> create(req, ctx, project_id)
        _ -> wisp.method_not_allowed([http.Get, http.Post])
      }
  }
}

pub fn handle_siblings(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) ->
          case runs.siblings(ctx.db, id) {
            Ok(rs) ->
              json.array(rs, run_json.encode)
              |> json.to_string()
              |> wisp.json_response(200)
            Error(_) -> wisp.internal_server_error()
          }
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_stop(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Post ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) ->
          case run_registry.lookup(ctx.run_registry, id) {
            Some(actor_subject) -> {
              process.send(actor_subject, run_types.Cancel)
              wisp.response(202)
            }
            None -> wisp.not_found()
          }
      }
    _ -> wisp.method_not_allowed([http.Post])
  }
}

pub fn handle_continue(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Post ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> do_continue(req, ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Post])
  }
}

fn do_continue(req: Request, ctx: Context, run_id: Int) -> Response {
  use body <- wisp.require_json(req)
  let params_decoder = {
    use model <- decode.optional_field(
      "model",
      None,
      decode.optional(decode.string),
    )
    use effort <- decode.optional_field(
      "effort",
      None,
      decode.optional(decode.string),
    )
    use subagent_model <- decode.optional_field(
      "subagent_model",
      None,
      decode.optional(decode.string),
    )
    decode.success(#(model, effort, subagent_model))
  }
  case decode.run(body, params_decoder) {
    Error(_) -> wisp.bad_request("Invalid request body")
    Ok(#(model, effort, subagent_model)) ->
      case runs.get(ctx.db, run_id) {
        Error(connection.NotFound) -> wisp.not_found()
        Error(e) -> {
          wisp.log_error(
            "get run "
            <> int.to_string(run_id)
            <> ": "
            <> connection.describe_error(e),
          )
          wisp.internal_server_error()
        }
        Ok(parent_run) ->
          case parent_run.claude_session_id {
            None -> wisp.response(422)
            Some(session_id) ->
              case projects.get(ctx.db, parent_run.project_id) {
                Error(_) -> wisp.internal_server_error()
                Ok(project) -> {
                  let now = now_ms()
                  case
                    runs.insert_continue_run(
                      ctx.db,
                      parent_run,
                      model,
                      effort,
                      subagent_model,
                      session_id,
                      now,
                    )
                  {
                    Error(e) -> {
                      wisp.log_error(
                        "insert continue run for "
                        <> int.to_string(run_id)
                        <> ": "
                        <> connection.describe_error(e),
                      )
                      wisp.internal_server_error()
                    }
                    Ok(new_run) ->
                      case
                        run_supervisor.start_run(
                          ctx.run_registry,
                          ctx.db,
                          ctx.config,
                          new_run.id,
                          ctx.pubsub,
                        )
                      {
                        Error(reason) -> {
                          wisp.log_error(
                            "start continue run "
                            <> int.to_string(new_run.id)
                            <> ": "
                            <> reason,
                          )
                          wisp.internal_server_error()
                        }
                        Ok(#(actor_subject, bc)) -> {
                          let global_prompt = case settings.get(ctx.db) {
                            Ok(s) -> s.global_prompt
                            Error(_) -> ""
                          }
                          let secrets =
                            db_secrets.list_plaintext(
                              ctx.db,
                              project.id,
                              ctx.config.secrets_key,
                            )
                          run_worker.launch(
                            run_worker.LaunchInput(
                              run: new_run,
                              project: project,
                              config: ctx.config,
                              cols: 80,
                              rows: 24,
                              broadcaster: bc,
                              global_prompt: global_prompt,
                              secrets: secrets,
                            ),
                            actor_subject,
                          )
                          run_json.encode(new_run)
                          |> json.to_string()
                          |> wisp.json_response(201)
                        }
                      }
                  }
                }
              }
          }
      }
  }
}

pub fn handle_resume_now(
  req: Request,
  ctx: Context,
  id_str: String,
) -> Response {
  case req.method {
    http.Post ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> do_resume_now(ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Post])
  }
}

fn do_resume_now(ctx: Context, id: Int) -> Response {
  case runs.get(ctx.db, id) {
    Error(connection.NotFound) -> wisp.not_found()
    Error(e) -> {
      wisp.log_error(
        "resume_now get run "
        <> int.to_string(id)
        <> ": "
        <> connection.describe_error(e),
      )
      wisp.internal_server_error()
    }
    Ok(run) ->
      case run.state {
        "awaiting_resume" -> {
          run_reattach.resurrect(
            run,
            ctx.db,
            ctx.config,
            ctx.run_registry,
            ctx.pubsub,
          )
          wisp.response(202)
        }
        _ -> wisp.bad_request("Run is not awaiting_resume")
      }
  }
}

fn create(req: Request, ctx: Context, project_id: Int) -> Response {
  use body <- wisp.require_json(req)
  let decoder = {
    use prompt <- decode.field("prompt", decode.string)
    use branch <- decode.optional_field(
      "branch",
      None,
      decode.optional(decode.string),
    )
    use model <- decode.optional_field(
      "model",
      None,
      decode.optional(decode.string),
    )
    use effort <- decode.optional_field(
      "effort",
      None,
      decode.optional(decode.string),
    )
    use subagent_model <- decode.optional_field(
      "subagent_model",
      None,
      decode.optional(decode.string),
    )
    use mock <- decode.optional_field("mock", False, decode.bool)
    use mock_scenario <- decode.optional_field(
      "mock_scenario",
      None,
      decode.optional(decode.string),
    )
    use force <- decode.optional_field("force", False, decode.bool)
    decode.success(#(
      prompt,
      branch,
      model,
      effort,
      subagent_model,
      mock,
      mock_scenario,
      force,
    ))
  }
  case decode.run(body, decoder) {
    Error(_) -> wisp.bad_request("Invalid request body")
    Ok(#(
      prompt,
      branch,
      model,
      effort,
      subagent_model,
      mock,
      mock_scenario,
      force,
    )) ->
      case projects.get(ctx.db, project_id) {
        Error(_) -> wisp.not_found()
        Ok(project) ->
          case branch, force {
            Some(b), False ->
              case runs.branch_in_use(ctx.db, b) {
                Error(_) -> wisp.internal_server_error()
                Ok(True) ->
                  json.object([
                    #("error", json.string("branch_in_use")),
                    #(
                      "message",
                      json.string(
                        "Branch '"
                        <> b
                        <> "' is already in use by an active run.",
                      ),
                    ),
                  ])
                  |> json.to_string()
                  |> wisp.json_response(409)
                Ok(False) ->
                  do_create(
                    ctx,
                    project,
                    prompt,
                    branch,
                    model,
                    effort,
                    subagent_model,
                    mock,
                    mock_scenario,
                  )
              }
            _, _ ->
              do_create(
                ctx,
                project,
                prompt,
                branch,
                model,
                effort,
                subagent_model,
                mock,
                mock_scenario,
              )
          }
      }
  }
}

fn do_create(
  ctx: Context,
  project: projects.Project,
  prompt: String,
  branch: option.Option(String),
  model: option.Option(String),
  effort: option.Option(String),
  subagent_model: option.Option(String),
  mock: Bool,
  mock_scenario: option.Option(String),
) -> Response {
  let now = now_ms()
  let global_prompt = case settings.get(ctx.db) {
    Ok(s) -> s.global_prompt
    Error(_) -> ""
  }
  case
    runs.insert_run(
      ctx.db,
      project.id,
      prompt,
      branch,
      model,
      effort,
      subagent_model,
      mock,
      mock_scenario,
      now,
    )
  {
    Error(e) -> {
      wisp.log_error(
        "insert run for project "
        <> int.to_string(project.id)
        <> ": "
        <> connection.describe_error(e),
      )
      wisp.internal_server_error()
    }
    Ok(run) ->
      case
        run_supervisor.start_run(
          ctx.run_registry,
          ctx.db,
          ctx.config,
          run.id,
          ctx.pubsub,
        )
      {
        Error(reason) -> {
          wisp.log_error(
            "start run " <> int.to_string(run.id) <> ": " <> reason,
          )
          wisp.internal_server_error()
        }
        Ok(#(actor_subject, bc)) -> {
          let secrets =
            db_secrets.list_plaintext(
              ctx.db,
              project.id,
              ctx.config.secrets_key,
            )
          run_worker.launch(
            run_worker.LaunchInput(
              run: run,
              project: project,
              config: ctx.config,
              cols: 80,
              rows: 24,
              broadcaster: bc,
              global_prompt: global_prompt,
              secrets: secrets,
            ),
            actor_subject,
          )
          run_json.encode(run)
          |> json.to_string()
          |> wisp.json_response(201)
        }
      }
  }
}

fn index(req: Request, ctx: Context) -> Response {
  let qs = wisp.get_query(req)
  let filter =
    runs.ListFilter(
      state: get_param(qs, "state"),
      project_id: get_param(qs, "project_id") |> option_int(),
      q: get_param(qs, "q"),
      limit: get_param(qs, "limit") |> option_int(),
      offset: get_param(qs, "offset") |> option_int() |> option.unwrap(0),
    )
  case filter.limit {
    Some(_) -> index_paged(ctx, filter)
    None -> index_flat(ctx, filter)
  }
}

fn index_flat(ctx: Context, filter: runs.ListFilter) -> Response {
  case runs.list_filtered(ctx.db, filter) {
    Ok(rs) ->
      json.array(rs, run_json.encode)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(e) -> {
      wisp.log_error("list runs: " <> connection.describe_error(e))
      wisp.internal_server_error()
    }
  }
}

fn index_paged(ctx: Context, filter: runs.ListFilter) -> Response {
  case runs.list_filtered(ctx.db, filter), runs.count_filtered(ctx.db, filter) {
    Ok(items), Ok(total) ->
      json.object([
        #("items", json.array(items, run_json.encode)),
        #("total", json.int(total)),
      ])
      |> json.to_string()
      |> wisp.json_response(200)
    Error(e), _ | _, Error(e) -> {
      wisp.log_error("list runs paged: " <> connection.describe_error(e))
      wisp.internal_server_error()
    }
  }
}

fn get_param(
  qs: List(#(String, String)),
  key: String,
) -> option.Option(String) {
  case list.key_find(qs, key) {
    Ok(v) if v != "" -> Some(v)
    _ -> None
  }
}

fn option_int(s: option.Option(String)) -> option.Option(Int) {
  case s {
    Some(v) ->
      case int.parse(v) {
        Ok(n) -> Some(n)
        Error(_) -> None
      }
    None -> None
  }
}

fn show(ctx: Context, id: Int) -> Response {
  case runs.get(ctx.db, id) {
    Ok(r) ->
      run_json.encode(r)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(connection.NotFound) -> wisp.not_found()
    Error(e) -> {
      wisp.log_error(
        "get run " <> int.to_string(id) <> ": " <> connection.describe_error(e),
      )
      wisp.internal_server_error()
    }
  }
}

fn list_for_project(ctx: Context, project_id: Int) -> Response {
  case runs.list_for_project(ctx.db, project_id) {
    Ok(rs) ->
      json.array(rs, run_json.encode)
      |> json.to_string()
      |> wisp.json_response(200)
    Error(e) -> {
      wisp.log_error(
        "list runs for project "
        <> int.to_string(project_id)
        <> ": "
        <> connection.describe_error(e),
      )
      wisp.internal_server_error()
    }
  }
}

fn patch(req: Request, ctx: Context, id: Int) -> Response {
  use body <- wisp.require_json(req)
  let decoder = {
    use title <- decode.optional_field(
      "title",
      None,
      decode.optional(decode.string),
    )
    use title_locked <- decode.optional_field(
      "title_locked",
      None,
      decode.optional(decode.bool),
    )
    decode.success(#(title, title_locked))
  }
  case decode.run(body, decoder) {
    Error(_) -> wisp.bad_request("Invalid request body")
    Ok(#(title, title_locked)) ->
      case title {
        None -> wisp.bad_request("title is required")
        Some(t) -> {
          let locked = case title_locked {
            Some(v) -> v
            None -> False
          }
          case runs.patch_title(ctx.db, id, t, locked) {
            Ok(r) ->
              run_json.encode(r)
              |> json.to_string()
              |> wisp.json_response(200)
            Error(connection.NotFound) -> wisp.not_found()
            Error(e) -> {
              wisp.log_error(
                "patch run "
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

fn delete(ctx: Context, id: Int) -> Response {
  case runs.delete(ctx.db, id) {
    Ok(_) -> wisp.response(204)
    Error(e) -> {
      wisp.log_error(
        "delete run "
        <> int.to_string(id)
        <> ": "
        <> connection.describe_error(e),
      )
      wisp.internal_server_error()
    }
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
