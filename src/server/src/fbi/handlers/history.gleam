import fbi/context.{type Context}
import fbi/db/projects
import fbi/db/runs as runs_db
import fbi/git
import fbi/git/history_ops
import fbi/git/mutex as history_mutex
import gleam/dynamic
import gleam/dynamic/decode
import gleam/http
import gleam/int
import gleam/json
import gleam/option.{None, Some}
import gleam/result
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Post ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> dispatch(req, ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Post])
  }
}

fn dispatch(req: Request, ctx: Context, run_id: Int) -> Response {
  use body <- wisp.require_json(req)
  let op_decoder = {
    use op <- decode.field("op", decode.string)
    decode.success(op)
  }
  case decode.run(body, op_decoder) {
    Error(_) -> result_response(history_ops.Invalid(message: "missing op"))
    Ok(op) -> {
      case history_mutex.try_acquire(ctx.history_mutex, run_id) {
        False -> result_response(history_ops.Invalid(message: "agent-busy"))
        True -> {
          let outcome = run_op(ctx, run_id, op, body)
          history_mutex.release(ctx.history_mutex, run_id)
          result_response(outcome)
        }
      }
    }
  }
}

fn run_op(
  ctx: Context,
  run_id: Int,
  op: String,
  body: dynamic.Dynamic,
) -> history_ops.Outcome {
  case runs_db.get(ctx.db, run_id) {
    Error(_) -> history_ops.Invalid(message: "run not found")
    Ok(run) -> {
      let repo_path =
        ctx.config.runs_dir <> "/" <> int.to_string(run_id) <> "/wip"
      let default = resolve_default_branch(ctx, run.project_id)
      case op {
        "squash-local" -> {
          let dec = {
            use subject <- decode.field("subject", decode.string)
            decode.success(subject)
          }
          case decode.run(body, dec) {
            Ok(subject) ->
              case
                history_ops.squash_local(
                  repo_path,
                  run.branch_name,
                  default,
                  subject,
                )
              {
                Ok(o) -> o
                Error(e) -> history_ops.GitError(message: git.describe_error(e))
              }
            Error(_) -> history_ops.Invalid(message: "subject required")
          }
        }
        "mirror-rebase" ->
          case
            history_ops.mirror_rebase(
              repo_path,
              run.branch_name,
              "origin",
              default,
            )
          {
            Ok(o) -> dispatch_if_conflict(ctx, run, o)
            Error(e) -> history_ops.GitError(message: git.describe_error(e))
          }
        "sync" ->
          case run.container_id {
            None -> history_ops.GitError(message: "container not running")
            Some(cid) ->
              case history_ops.sync_in_container(ctx.config, cid) {
                Ok(o) -> dispatch_if_conflict(ctx, run, o)
                Error(e) -> history_ops.GitError(message: e)
              }
          }
        "merge" -> {
          let strat_dec = {
            use strat <- decode.optional_field(
              "strategy",
              "no-ff",
              decode.string,
            )
            decode.success(strat)
          }
          let strategy = case
            decode.run(body, strat_dec) |> result.unwrap("no-ff")
          {
            "ff-only" -> history_ops.FfOnly
            "squash" -> history_ops.Squash
            _ -> history_ops.NoFf
          }
          case run.container_id {
            None -> history_ops.GitError(message: "container not running")
            Some(cid) ->
              case
                history_ops.merge_in_container(
                  ctx.config,
                  cid,
                  default,
                  strategy,
                )
              {
                Ok(o) -> dispatch_if_conflict(ctx, run, o)
                Error(e) -> history_ops.GitError(message: e)
              }
          }
        }
        "polish" ->
          case
            history_ops.dispatch_polish(
              ctx.db,
              ctx.config,
              ctx.run_registry,
              ctx.pubsub,
              run,
            )
          {
            history_ops.AgentDispatched(child_id) ->
              history_ops.Agent(child_run_id: child_id)
            history_ops.AgentBusy -> history_ops.Invalid(message: "agent-busy")
            history_ops.DispatchError(m) -> history_ops.GitError(message: m)
          }
        "push-submodule" ->
          history_ops.Invalid(message: "submodules not supported in this build")
        _ -> history_ops.Invalid(message: "unknown op: " <> op)
      }
    }
  }
}

fn dispatch_if_conflict(
  ctx: Context,
  run: runs_db.Run,
  outcome: history_ops.Outcome,
) -> history_ops.Outcome {
  case outcome {
    history_ops.Conflict(_) ->
      case
        history_ops.dispatch_merge_conflict(
          ctx.db,
          ctx.config,
          ctx.run_registry,
          ctx.pubsub,
          run,
        )
      {
        history_ops.AgentDispatched(child_id) ->
          history_ops.Conflict(child_run_id: child_id)
        history_ops.AgentBusy -> history_ops.Invalid(message: "agent-busy")
        history_ops.DispatchError(m) -> history_ops.GitError(message: m)
      }
    o -> o
  }
}

fn result_response(o: history_ops.Outcome) -> Response {
  let body = case o {
    history_ops.Complete(sha) ->
      json.object([
        #("kind", json.string("complete")),
        #("sha", json.string(sha)),
      ])
    history_ops.Agent(child_id) ->
      json.object([
        #("kind", json.string("agent")),
        #("child_run_id", json.int(child_id)),
      ])
    history_ops.Conflict(child_id) ->
      json.object([
        #("kind", json.string("conflict")),
        #("child_run_id", json.int(child_id)),
      ])
    history_ops.Invalid(m) ->
      json.object([
        #("kind", json.string("invalid")),
        #("message", json.string(m)),
      ])
    history_ops.GitError(m) ->
      json.object([
        #("kind", json.string("git-error")),
        #("message", json.string(m)),
      ])
  }
  body |> json.to_string() |> wisp.json_response(200)
}

fn resolve_default_branch(ctx: Context, project_id: Int) -> String {
  case projects.get(ctx.db, project_id) {
    Ok(p) -> p.default_branch
    Error(_) -> "main"
  }
}
