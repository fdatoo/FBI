import fbi/context.{type Context}
import fbi/db/projects
import fbi/db/runs as runs_db
import fbi/git/parse
import fbi/git/repo
import gleam/http
import gleam/int
import gleam/json
import gleam/list
import gleam/option
import gleam/result
import wisp.{type Request, type Response}

pub fn handle_changes(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> serve_changes(ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_changes(ctx: Context, run_id: Int) -> Response {
  case runs_db.get(ctx.db, run_id) {
    Error(_) -> wisp.not_found()
    Ok(run) -> {
      let repo_path =
        ctx.config.runs_dir <> "/" <> int.to_string(run_id) <> "/wip"
      let default = resolve_default_branch(ctx, run.project_id)
      let branch = run.branch_name
      let commits =
        repo.commits_on_branch(repo_path, branch, default)
        |> result.unwrap([])
      let commits_with_files =
        list.map(commits, fn(c) {
          let files = repo.commit_files(repo_path, c.sha) |> result.unwrap([])
          #(c, files)
        })
      let pushed_all = run.mirror_status == option.Some("ok")
      let base =
        repo.branch_base_ahead_behind(repo_path, branch, default)
        |> result.map(option.Some)
        |> result.unwrap(option.None)
      let uncommitted = case repo.wip_files(repo_path) {
        Ok(option.Some(snap)) -> snap.files
        _ -> []
      }
      let children = runs_db.children_of(ctx.db, run_id) |> result.unwrap([])
      json.object([
        #("branch_name", json.string(branch)),
        #("branch_base", encode_branch_base(base)),
        #(
          "commits",
          json.array(commits_with_files, fn(pair) {
            let #(c, files) = pair
            encode_commit(c, files, pushed_all)
          }),
        ),
        #("uncommitted", json.array(uncommitted, encode_file)),
        #("integrations", json.object([])),
        #("dirty_submodules", json.array([], json.string)),
        #("children", json.array(children, encode_child)),
      ])
      |> json.to_string()
      |> wisp.json_response(200)
    }
  }
}

pub fn handle_commit_files(
  req: Request,
  ctx: Context,
  id_str: String,
  sha: String,
) -> Response {
  case req.method {
    http.Get ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> serve_commit_files(ctx, id, sha)
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_commit_files(ctx: Context, run_id: Int, sha: String) -> Response {
  let repo_path = ctx.config.runs_dir <> "/" <> int.to_string(run_id) <> "/wip"
  case runs_db.get(ctx.db, run_id) {
    Error(_) -> wisp.not_found()
    Ok(_) ->
      case repo.commit_files(repo_path, sha) {
        Error(_) -> wisp.not_found()
        Ok(files) ->
          json.object([#("files", json.array(files, encode_file))])
          |> json.to_string()
          |> wisp.json_response(200)
      }
  }
}

pub fn handle_submodule_commit_files(
  req: Request,
  _ctx: Context,
  _id: String,
  _path: String,
  _sha: String,
) -> Response {
  case req.method {
    http.Get ->
      json.object([#("files", json.array([], json.string))])
      |> json.to_string()
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_file_diff(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> serve_file_diff(req, ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_file_diff(req: Request, ctx: Context, run_id: Int) -> Response {
  let qs = wisp.get_query(req)
  let path = list.key_find(qs, "path") |> result.unwrap("")
  let ref = list.key_find(qs, "ref") |> result.unwrap("worktree")
  let repo_path = ctx.config.runs_dir <> "/" <> int.to_string(run_id) <> "/wip"
  case path {
    "" -> wisp.bad_request("path is required")
    _ ->
      case ref {
        "worktree" -> serve_worktree_diff(repo_path, path)
        sha -> serve_commit_diff(repo_path, sha, path)
      }
  }
}

fn serve_worktree_diff(repo_path: String, path: String) -> Response {
  case repo.wip_file_diff(repo_path, path) {
    Error(_) -> wisp.internal_server_error()
    Ok(option.None) -> empty_diff_response("worktree", path)
    Ok(option.Some(#(hunks, truncated, _, _))) ->
      diff_response(hunks, truncated, "worktree", path)
  }
}

fn serve_commit_diff(repo_path: String, sha: String, path: String) -> Response {
  case repo.file_diff(repo_path, sha, path) {
    Error(_) -> wisp.not_found()
    Ok(#(hunks, truncated)) -> diff_response(hunks, truncated, sha, path)
  }
}

fn empty_diff_response(ref: String, path: String) -> Response {
  json.object([
    #("path", json.string(path)),
    #("ref", json.string(ref)),
    #("hunks", json.array([], encode_hunk)),
    #("truncated", json.bool(False)),
  ])
  |> json.to_string()
  |> wisp.json_response(200)
}

fn diff_response(
  hunks: List(parse.Hunk),
  truncated: Bool,
  ref: String,
  path: String,
) -> Response {
  json.object([
    #("path", json.string(path)),
    #("ref", json.string(ref)),
    #("hunks", json.array(hunks, encode_hunk)),
    #("truncated", json.bool(truncated)),
  ])
  |> json.to_string()
  |> wisp.json_response(200)
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

fn encode_file(f: repo.FileEntry) -> json.Json {
  json.object([
    #("path", json.string(f.path)),
    #("status", json.string(f.status)),
    #("additions", json.int(f.additions)),
    #("deletions", json.int(f.deletions)),
  ])
}

fn encode_branch_base(b: option.Option(repo.BranchBase)) -> json.Json {
  case b {
    option.None -> json.null()
    option.Some(bb) ->
      json.object([
        #("base", json.string(bb.base)),
        #("ahead", json.int(bb.ahead)),
        #("behind", json.int(bb.behind)),
      ])
  }
}

fn encode_commit(
  c: parse.LogEntry,
  files: List(repo.FileEntry),
  pushed: Bool,
) -> json.Json {
  json.object([
    #("sha", json.string(c.sha)),
    #("subject", json.string(c.subject)),
    #("committed_at", json.int(c.committed_at)),
    #("pushed", json.bool(pushed)),
    #("files", json.array(files, encode_file)),
    #("files_loaded", json.bool(True)),
    #("submodule_bumps", json.array([], json.string)),
  ])
}

fn encode_child(c: runs_db.ChildSummary) -> json.Json {
  json.object([
    #("id", json.int(c.id)),
    #("kind", json.string(c.kind)),
    #("state", json.string(c.state)),
    #("created_at", json.int(c.created_at)),
  ])
}

fn resolve_default_branch(ctx: Context, project_id: Int) -> String {
  case projects.get(ctx.db, project_id) {
    Ok(p) -> p.default_branch
    Error(_) -> "main"
  }
}
