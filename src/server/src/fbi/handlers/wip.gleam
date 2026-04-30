import fbi/context.{type Context}
import fbi/db/runs as runs_db
import fbi/docker
import fbi/git/parse
import fbi/git/repo
import fbi/run/registry as run_registry
import gleam/http
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import wisp.{type Request, type Response}

pub fn handle_status(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      with_repo_path(ctx, id_str, fn(_run, repo_path) {
        case repo.wip_files(repo_path) {
          Error(_) -> wisp.internal_server_error()
          Ok(None) -> no_wip_response()
          Ok(Some(snap)) ->
            json.object([
              #("ok", json.bool(True)),
              #("snapshot_sha", json.string(snap.snapshot_sha)),
              #("parent_sha", json.string(snap.parent_sha)),
              #("files", json.array(snap.files, encode_file)),
            ])
            |> json.to_string()
            |> wisp.json_response(200)
        }
      })
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_file(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      with_repo_path(ctx, id_str, fn(_run, repo_path) {
        let qs = wisp.get_query(req)
        let path = list.key_find(qs, "path") |> result.unwrap("")
        case path {
          "" -> wisp.bad_request("path is required")
          _ ->
            case repo.wip_file_diff(repo_path, path) {
              Error(_) -> wisp.internal_server_error()
              Ok(None) -> empty_diff(path)
              Ok(Some(#(hunks, truncated, _, _))) ->
                json.object([
                  #("path", json.string(path)),
                  #("ref", json.string("worktree")),
                  #("hunks", json.array(hunks, encode_hunk)),
                  #("truncated", json.bool(truncated)),
                ])
                |> json.to_string()
                |> wisp.json_response(200)
            }
        }
      })
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_patch(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      with_repo_path(ctx, id_str, fn(_run, repo_path) {
        case repo.wip_patch(repo_path) {
          Error(_) -> wisp.internal_server_error()
          Ok(body) ->
            wisp.response(200)
            |> wisp.set_header("content-type", "text/x-patch; charset=utf-8")
            |> wisp.set_header(
              "content-disposition",
              "attachment; filename=\"run-" <> id_str <> "-wip.patch\"",
            )
            |> wisp.set_body(wisp.Text(body))
        }
      })
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_discard(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Post ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> do_discard(ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Post])
  }
}

fn do_discard(ctx: Context, run_id: Int) -> Response {
  case runs_db.get(ctx.db, run_id) {
    Error(_) -> wisp.not_found()
    Ok(run) ->
      case run.container_id {
        None -> conflict_no_container()
        Some(cid) ->
          case run_registry.lookup(ctx.run_registry, run_id) {
            None -> conflict_no_container()
            _ -> exec_discard(ctx, cid)
          }
      }
  }
}

fn exec_discard(ctx: Context, cid: String) -> Response {
  case docker.connect(ctx.config.docker_socket) {
    Error(e) -> {
      wisp.log_warning("wip discard connect: " <> docker.describe_error(e))
      wisp.internal_server_error()
    }
    Ok(sock) -> {
      let result =
        docker.exec_container(
          sock,
          cid,
          [
            "sh", "-c",
            "cd /workspace && git restore --staged --worktree . && git clean -fd",
          ],
          "agent",
        )
      docker.close(sock)
      case result {
        Ok(_) -> wisp.response(204)
        Error(e) -> {
          wisp.log_warning("wip discard exec: " <> docker.describe_error(e))
          json.object([
            #("kind", json.string("git-error")),
            #("message", json.string(docker.describe_error(e))),
          ])
          |> json.to_string()
          |> wisp.json_response(500)
        }
      }
    }
  }
}

fn with_repo_path(
  ctx: Context,
  id_str: String,
  next: fn(runs_db.Run, String) -> Response,
) -> Response {
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid run ID")
    Ok(id) ->
      case runs_db.get(ctx.db, id) {
        Error(_) -> wisp.not_found()
        Ok(run) -> {
          let path = ctx.config.runs_dir <> "/" <> int.to_string(id) <> "/wip"
          next(run, path)
        }
      }
  }
}

fn no_wip_response() -> Response {
  json.object([#("ok", json.bool(False)), #("reason", json.string("no-wip"))])
  |> json.to_string()
  |> wisp.json_response(200)
}

fn empty_diff(path: String) -> Response {
  json.object([
    #("path", json.string(path)),
    #("ref", json.string("worktree")),
    #("hunks", json.array([], encode_hunk)),
    #("truncated", json.bool(False)),
  ])
  |> json.to_string()
  |> wisp.json_response(200)
}

fn conflict_no_container() -> Response {
  json.object([#("error", json.string("container_not_running"))])
  |> json.to_string()
  |> wisp.json_response(409)
}

fn encode_file(f: repo.FileEntry) -> json.Json {
  json.object([
    #("path", json.string(f.path)),
    #("status", json.string(f.status)),
    #("additions", json.int(f.additions)),
    #("deletions", json.int(f.deletions)),
  ])
}

fn encode_hunk(h: parse.Hunk) -> json.Json {
  json.object([
    #("header", json.string(h.header)),
    #(
      "lines",
      json.array(h.lines, fn(l) {
        json.object([
          #("kind", json.string(l.kind)),
          #("text", json.string(l.text)),
        ])
      }),
    ),
  ])
}
