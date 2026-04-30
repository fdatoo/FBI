import fbi/db/mcp_servers.{type McpServer}
import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/result

fn parse_string_list(raw: String) -> List(String) {
  json.parse(raw, decode.list(decode.string))
  |> result.unwrap([])
}

fn parse_string_dict(raw: String) -> Dict(String, String) {
  json.parse(raw, decode.dict(decode.string, decode.string))
  |> result.unwrap(dict.new())
}

fn dict_to_json(d: Dict(String, String)) -> json.Json {
  dict.to_list(d)
  |> list.map(fn(pair) { #(pair.0, json.string(pair.1)) })
  |> json.object
}

pub fn encode(s: McpServer) -> json.Json {
  json.object([
    #("id", json.int(s.id)),
    #("project_id", json.nullable(s.project_id, json.int)),
    #("name", json.string(s.name)),
    #("type", json.string(s.server_type)),
    #("command", json.nullable(s.command, json.string)),
    #("args", json.array(parse_string_list(s.args_json), json.string)),
    #("url", json.nullable(s.url, json.string)),
    #("env", dict_to_json(parse_string_dict(s.env_json))),
    #("created_at", json.int(s.created_at)),
  ])
}
