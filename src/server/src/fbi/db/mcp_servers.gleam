import fbi/db/connection.{type DbError, SqlightError}
import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import sqlight

pub type McpServer {
  McpServer(
    id: Int,
    project_id: Option(Int),
    name: String,
    server_type: String,
    command: Option(String),
    args_json: String,
    url: Option(String),
    env_json: String,
    created_at: Int,
  )
}

fn decoder() -> decode.Decoder(McpServer) {
  use id <- decode.field(0, decode.int)
  use project_id <- decode.field(1, decode.optional(decode.int))
  use name <- decode.field(2, decode.string)
  use server_type <- decode.field(3, decode.string)
  use command <- decode.field(4, decode.optional(decode.string))
  use args_json <- decode.field(5, decode.string)
  use url <- decode.field(6, decode.optional(decode.string))
  use env_json <- decode.field(7, decode.string)
  use created_at <- decode.field(8, decode.int)
  decode.success(McpServer(
    id:,
    project_id:,
    name:,
    server_type:,
    command:,
    args_json:,
    url:,
    env_json:,
    created_at:,
  ))
}

const select = "SELECT id, project_id, name, type, command, args_json, url, env_json, created_at FROM mcp_servers"

pub fn list_global(db: sqlight.Connection) -> Result(List(McpServer), DbError) {
  connection.query_all(
    select <> " WHERE project_id IS NULL ORDER BY name",
    db,
    [],
    decoder(),
  )
}

pub fn list_for_project(
  db: sqlight.Connection,
  project_id: Int,
) -> Result(List(McpServer), DbError) {
  connection.query_all(
    select <> " WHERE project_id = ? ORDER BY name",
    db,
    [sqlight.int(project_id)],
    decoder(),
  )
}

pub fn get(db: sqlight.Connection, id: Int) -> Result(McpServer, DbError) {
  connection.query_one(
    select <> " WHERE id = ?",
    db,
    [sqlight.int(id)],
    decoder(),
  )
}

pub fn insert(
  db: sqlight.Connection,
  project_id: Option(Int),
  name: String,
  server_type: String,
  command: Option(String),
  args_json: String,
  url: Option(String),
  env_json: String,
  now: Int,
) -> Result(McpServer, DbError) {
  connection.query_one(
    "INSERT INTO mcp_servers (project_id, name, type, command, args_json, url, env_json, created_at)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id, project_id, name, type, command, args_json, url, env_json, created_at",
    db,
    [
      case project_id {
        None -> sqlight.null()
        Some(id) -> sqlight.int(id)
      },
      sqlight.text(name),
      sqlight.text(server_type),
      case command {
        None -> sqlight.null()
        Some(c) -> sqlight.text(c)
      },
      sqlight.text(args_json),
      case url {
        None -> sqlight.null()
        Some(u) -> sqlight.text(u)
      },
      sqlight.text(env_json),
      sqlight.int(now),
    ],
    decoder(),
  )
}

pub fn update(
  db: sqlight.Connection,
  id: Int,
  name: Option(String),
  server_type: Option(String),
  command: Option(Option(String)),
  args_json: Option(String),
  url: Option(Option(String)),
  env_json: Option(String),
) -> Result(McpServer, DbError) {
  let sets =
    [
      option.map(name, fn(v) { #("name = ?", sqlight.text(v)) }),
      option.map(server_type, fn(v) { #("type = ?", sqlight.text(v)) }),
      option.map(command, fn(v) {
        #("command = ?", case v {
          None -> sqlight.null()
          Some(s) -> sqlight.text(s)
        })
      }),
      option.map(args_json, fn(v) { #("args_json = ?", sqlight.text(v)) }),
      option.map(url, fn(v) {
        #("url = ?", case v {
          None -> sqlight.null()
          Some(s) -> sqlight.text(s)
        })
      }),
      option.map(env_json, fn(v) { #("env_json = ?", sqlight.text(v)) }),
    ]
    |> list.filter_map(fn(o) { option.to_result(o, Nil) })
  let set_clause =
    list.map(sets, fn(s: #(String, sqlight.Value)) { s.0 })
    |> string.join(", ")
  let args = list.map(sets, fn(s: #(String, sqlight.Value)) { s.1 })
  connection.query_one(
    "UPDATE mcp_servers SET "
      <> set_clause
      <> " WHERE id = ? RETURNING id, project_id, name, type, command, args_json, url, env_json, created_at",
    db,
    list.append(args, [sqlight.int(id)]),
    decoder(),
  )
}

pub fn delete(db: sqlight.Connection, id: Int) -> Result(Nil, DbError) {
  sqlight.query(
    "DELETE FROM mcp_servers WHERE id = ?",
    on: db,
    with: [sqlight.int(id)],
    expecting: decode.at([0], decode.int),
  )
  |> result.map_error(SqlightError)
  |> result.map(fn(_) { Nil })
}
