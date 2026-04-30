import fbi/context.{type Context}
import fbi/handlers/changes as changes_handler
import fbi/handlers/config as config_handler
import fbi/handlers/github as github_handler
import fbi/handlers/health
import fbi/handlers/listening_ports as listening_ports_handler
import fbi/handlers/mcp_servers as mcp_servers_handler
import fbi/handlers/projects as projects_handler
import fbi/handlers/prompts as prompts_handler
import fbi/handlers/quantico as quantico_handler
import fbi/handlers/runs as runs_handler
import fbi/handlers/secrets as secrets_handler
import fbi/handlers/settings as settings_handler
import fbi/handlers/static as static_handler
import fbi/handlers/transcript as transcript_handler
import fbi/handlers/uploads as uploads_handler
import fbi/handlers/usage as usage_handler
import fbi/handlers/wip as wip_handler
import gleam/http
import gleam/list
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context) -> Response {
  use <- wisp.log_request(req)
  use <- wisp.rescue_crashes
  use <- add_cors_headers

  case wisp.path_segments(req) {
    ["api", "health"] -> health.show(req)

    // Projects
    ["api", "projects"] -> projects_handler.handle(req, ctx)
    ["api", "projects", pid] -> projects_handler.handle_one(req, ctx, pid)

    // Project runs
    ["api", "projects", pid, "runs"] ->
      runs_handler.handle_for_project(req, ctx, pid)
    ["api", "projects", pid, "prompts", "recent"] ->
      prompts_handler.handle_recent(req, ctx, pid)

    // Project secrets
    ["api", "projects", pid, "secrets"] -> secrets_handler.index(req, ctx, pid)
    ["api", "projects", pid, "secrets", name] ->
      case req.method {
        http.Put -> secrets_handler.put(req, ctx, pid, name)
        http.Delete -> secrets_handler.delete(req, ctx, pid, name)
        _ -> wisp.method_not_allowed([http.Put, http.Delete])
      }

    // Project MCP servers
    ["api", "projects", pid, "mcp-servers"] ->
      mcp_servers_handler.handle_for_project(req, ctx, pid)
    ["api", "projects", pid, "mcp-servers", sid] ->
      mcp_servers_handler.handle_for_project_one(req, ctx, pid, sid)

    // Global runs
    ["api", "runs"] -> runs_handler.handle_list(req, ctx)
    ["api", "runs", id] -> runs_handler.handle_one(req, ctx, id)
    ["api", "runs", id, "siblings"] ->
      runs_handler.handle_siblings(req, ctx, id)
    ["api", "runs", id, "stop"] -> runs_handler.handle_stop(req, ctx, id)
    ["api", "runs", id, "continue"] ->
      runs_handler.handle_continue(req, ctx, id)
    ["api", "runs", id, "resume-now"] ->
      runs_handler.handle_resume_now(req, ctx, id)
    ["api", "runs", id, "transcript"] -> transcript_handler.handle(req, ctx, id)
    ["api", "runs", id, "listening-ports"] ->
      listening_ports_handler.handle(req, ctx, id)
    ["api", "runs", id, "changes"] ->
      changes_handler.handle_changes(req, ctx, id)
    ["api", "runs", id, "file-diff"] ->
      changes_handler.handle_file_diff(req, ctx, id)
    ["api", "runs", id, "history"] ->
      changes_handler.handle_history(req, ctx, id)
    ["api", "runs", id, "commits", sha, "files"] ->
      changes_handler.handle_commit_files(req, ctx, id, sha)
    ["api", "runs", id, "submodule", path, "commits", sha, "files"] ->
      changes_handler.handle_submodule_commit_files(req, ctx, id, path, sha)
    ["api", "runs", id, "wip"] -> wip_handler.handle_status(req, ctx, id)
    ["api", "runs", id, "wip", "file"] -> wip_handler.handle_file(req, ctx, id)
    ["api", "runs", id, "wip", "discard"] ->
      wip_handler.handle_discard(req, ctx, id)
    ["api", "runs", id, "wip", "patch"] ->
      wip_handler.handle_patch(req, ctx, id)
    ["api", "runs", id, "uploads"] ->
      uploads_handler.handle_run_uploads(req, ctx, id)
    ["api", "runs", id, "uploads", filename] ->
      uploads_handler.handle_run_upload_file(req, ctx, id, filename)
    ["api", "runs", id, "github", "pr"] ->
      github_handler.handle_pr(req, ctx, id)

    // Draft uploads
    ["api", "draft-uploads"] -> uploads_handler.handle_draft_root(req, ctx)
    ["api", "draft-uploads", token, filename] ->
      uploads_handler.handle_draft_file(req, ctx, token, filename)

    // Usage
    ["api", "usage"] -> usage_handler.handle_state(req, ctx)
    ["api", "usage", "daily"] -> usage_handler.handle_daily(req, ctx)
    ["api", "usage", "runs", id] ->
      usage_handler.handle_run_breakdown(req, ctx, id)

    // Settings
    ["api", "settings"] -> settings_handler.handle(req, ctx)
    ["api", "settings", "run-gc"] -> settings_handler.handle_run_gc(req, ctx)

    // Config
    ["api", "config", "defaults"] -> config_handler.handle_defaults(req, ctx)

    // Quantico mock scenarios
    ["api", "quantico", "scenarios"] -> quantico_handler.handle_scenarios(req)

    // Global MCP servers
    ["api", "mcp-servers"] -> mcp_servers_handler.handle_global(req, ctx)
    ["api", "mcp-servers", id] ->
      mcp_servers_handler.handle_global_one(req, ctx, id)

    // Static / catch-all
    _ -> static_handler.serve(req, ctx)
  }
}

fn add_cors_headers(next: fn() -> Response) -> Response {
  let resp = next()
  let cors_headers = [
    #("access-control-allow-origin", "*"),
    #("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    #(
      "access-control-allow-headers",
      "content-type, authorization, x-requested-with",
    ),
  ]
  list.fold(cors_headers, resp, fn(r, header) {
    wisp.set_header(r, header.0, header.1)
  })
}
