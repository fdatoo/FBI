import fbi/db/mcp_servers.{type McpServer}
import gleam/json

pub fn encode(s: McpServer) -> json.Json {
  json.object([
    #("id", json.int(s.id)),
    #("project_id", json.nullable(s.project_id, json.int)),
    #("name", json.string(s.name)),
    #("server_type", json.string(s.server_type)),
    #("command", json.nullable(s.command, json.string)),
    #("args_json", json.string(s.args_json)),
    #("url", json.nullable(s.url, json.string)),
    #("env_json", json.string(s.env_json)),
    #("created_at", json.int(s.created_at)),
  ])
}
