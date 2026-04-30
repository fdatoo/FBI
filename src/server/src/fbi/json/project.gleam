import fbi/db/projects.{type Project}
import gleam/json

pub fn encode(p: Project) -> json.Json {
  json.object([
    #("id", json.int(p.id)),
    #("name", json.string(p.name)),
    #("repo_url", json.string(p.repo_url)),
    #("default_branch", json.string(p.default_branch)),
    #(
      "devcontainer_override_json",
      json.nullable(p.devcontainer_override_json, json.string),
    ),
    #("instructions", json.nullable(p.instructions, json.string)),
    #("git_author_name", json.nullable(p.git_author_name, json.string)),
    #("git_author_email", json.nullable(p.git_author_email, json.string)),
    #("marketplaces_json", json.string(p.marketplaces_json)),
    #("plugins_json", json.string(p.plugins_json)),
    #("mem_mb", json.nullable(p.mem_mb, json.int)),
    #("cpus", json.nullable(p.cpus, json.float)),
    #("pids_limit", json.nullable(p.pids_limit, json.int)),
    #("created_at", json.int(p.created_at)),
    #("updated_at", json.int(p.updated_at)),
  ])
}
