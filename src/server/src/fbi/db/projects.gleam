import fbi/db/connection.{type DbError, SqlightError}
import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import sqlight

pub type Project {
  Project(
    id: Int,
    name: String,
    repo_url: String,
    default_branch: String,
    devcontainer_override_json: Option(String),
    instructions: Option(String),
    git_author_name: Option(String),
    git_author_email: Option(String),
    marketplaces_json: String,
    plugins_json: String,
    mem_mb: Option(Int),
    cpus: Option(Float),
    pids_limit: Option(Int),
    created_at: Int,
    updated_at: Int,
  )
}

pub type NewProject {
  NewProject(
    name: String,
    repo_url: String,
    default_branch: String,
    devcontainer_override_json: Option(String),
    instructions: Option(String),
    git_author_name: Option(String),
    git_author_email: Option(String),
    marketplaces_json: String,
    plugins_json: String,
    mem_mb: Option(Int),
    cpus: Option(Float),
    pids_limit: Option(Int),
    created_at: Int,
    updated_at: Int,
  )
}

pub type PatchProject {
  PatchProject(
    name: Option(String),
    repo_url: Option(String),
    default_branch: Option(String),
    devcontainer_override_json: Option(Option(String)),
    instructions: Option(Option(String)),
    git_author_name: Option(Option(String)),
    git_author_email: Option(Option(String)),
    marketplaces_json: Option(String),
    plugins_json: Option(String),
    mem_mb: Option(Option(Int)),
    cpus: Option(Option(Float)),
    pids_limit: Option(Option(Int)),
  )
}

fn decoder() -> decode.Decoder(Project) {
  use id <- decode.field(0, decode.int)
  use name <- decode.field(1, decode.string)
  use repo_url <- decode.field(2, decode.string)
  use default_branch <- decode.field(3, decode.string)
  use devcontainer_override_json <- decode.field(
    4,
    decode.optional(decode.string),
  )
  use instructions <- decode.field(5, decode.optional(decode.string))
  use git_author_name <- decode.field(6, decode.optional(decode.string))
  use git_author_email <- decode.field(7, decode.optional(decode.string))
  use marketplaces_json <- decode.field(8, decode.string)
  use plugins_json <- decode.field(9, decode.string)
  use mem_mb <- decode.field(10, decode.optional(decode.int))
  use cpus <- decode.field(11, decode.optional(decode.float))
  use pids_limit <- decode.field(12, decode.optional(decode.int))
  use created_at <- decode.field(13, decode.int)
  use updated_at <- decode.field(14, decode.int)
  decode.success(Project(
    id:,
    name:,
    repo_url:,
    default_branch:,
    devcontainer_override_json:,
    instructions:,
    git_author_name:,
    git_author_email:,
    marketplaces_json:,
    plugins_json:,
    mem_mb:,
    cpus:,
    pids_limit:,
    created_at:,
    updated_at:,
  ))
}

const select_all = "
  SELECT id, name, repo_url, default_branch,
         devcontainer_override_json, instructions,
         git_author_name, git_author_email,
         marketplaces_json, plugins_json,
         mem_mb, cpus, pids_limit,
         created_at, updated_at
  FROM projects"

pub fn list(db: sqlight.Connection) -> Result(List(Project), DbError) {
  connection.query_all(select_all <> " ORDER BY id", db, [], decoder())
}

pub fn get(db: sqlight.Connection, id: Int) -> Result(Project, DbError) {
  connection.query_one(
    select_all <> " WHERE id = ?",
    db,
    [sqlight.int(id)],
    decoder(),
  )
}

pub fn insert(db: sqlight.Connection, p: NewProject) -> Result(Project, DbError) {
  let sql =
    "INSERT INTO projects
       (name, repo_url, default_branch, devcontainer_override_json, instructions,
        git_author_name, git_author_email, marketplaces_json, plugins_json,
        mem_mb, cpus, pids_limit, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     RETURNING id, name, repo_url, default_branch,
       devcontainer_override_json, instructions,
       git_author_name, git_author_email,
       marketplaces_json, plugins_json,
       mem_mb, cpus, pids_limit,
       created_at, updated_at"

  connection.query_one(
    sql,
    db,
    [
      sqlight.text(p.name),
      sqlight.text(p.repo_url),
      sqlight.text(p.default_branch),
      nullable_text(p.devcontainer_override_json),
      nullable_text(p.instructions),
      nullable_text(p.git_author_name),
      nullable_text(p.git_author_email),
      sqlight.text(p.marketplaces_json),
      sqlight.text(p.plugins_json),
      nullable_int(p.mem_mb),
      nullable_float(p.cpus),
      nullable_int(p.pids_limit),
      sqlight.int(p.created_at),
      sqlight.int(p.updated_at),
    ],
    decoder(),
  )
}

pub fn delete(db: sqlight.Connection, id: Int) -> Result(Nil, DbError) {
  sqlight.query(
    "DELETE FROM projects WHERE id = ?",
    on: db,
    with: [sqlight.int(id)],
    expecting: decode.dynamic,
  )
  |> result.map(fn(_) { Nil })
  |> result.map_error(SqlightError)
}

pub fn update(
  db: sqlight.Connection,
  id: Int,
  p: PatchProject,
  now: Int,
) -> Result(Project, DbError) {
  let sets =
    [
      option.map(p.name, fn(v) { #("name = ?", sqlight.text(v)) }),
      option.map(p.repo_url, fn(v) { #("repo_url = ?", sqlight.text(v)) }),
      option.map(p.default_branch, fn(v) {
        #("default_branch = ?", sqlight.text(v))
      }),
      option.map(p.devcontainer_override_json, fn(v) {
        #("devcontainer_override_json = ?", nullable_text(v))
      }),
      option.map(p.instructions, fn(v) {
        #("instructions = ?", nullable_text(v))
      }),
      option.map(p.git_author_name, fn(v) {
        #("git_author_name = ?", nullable_text(v))
      }),
      option.map(p.git_author_email, fn(v) {
        #("git_author_email = ?", nullable_text(v))
      }),
      option.map(p.marketplaces_json, fn(v) {
        #("marketplaces_json = ?", sqlight.text(v))
      }),
      option.map(p.plugins_json, fn(v) {
        #("plugins_json = ?", sqlight.text(v))
      }),
      option.map(p.mem_mb, fn(v) { #("mem_mb = ?", nullable_int(v)) }),
      option.map(p.cpus, fn(v) { #("cpus = ?", nullable_float(v)) }),
      option.map(p.pids_limit, fn(v) { #("pids_limit = ?", nullable_int(v)) }),
    ]
    |> list.filter_map(fn(opt) { option.to_result(opt, Nil) })

  let set_clause =
    list.map(sets, fn(s) { s.0 })
    |> string.join(", ")
  let args = list.map(sets, fn(s) { s.1 })

  let sql =
    "UPDATE projects SET "
    <> set_clause
    <> ", updated_at = ?"
    <> " WHERE id = ? RETURNING id, name, repo_url, default_branch,
       devcontainer_override_json, instructions, git_author_name, git_author_email,
       marketplaces_json, plugins_json, mem_mb, cpus, pids_limit, created_at, updated_at"

  connection.query_one(
    sql,
    db,
    list.append(args, [sqlight.int(now), sqlight.int(id)]),
    decoder(),
  )
}

fn nullable_text(opt: Option(String)) -> sqlight.Value {
  case opt {
    None -> sqlight.null()
    Some(v) -> sqlight.text(v)
  }
}

fn nullable_int(opt: Option(Int)) -> sqlight.Value {
  case opt {
    None -> sqlight.null()
    Some(v) -> sqlight.int(v)
  }
}

fn nullable_float(opt: Option(Float)) -> sqlight.Value {
  case opt {
    None -> sqlight.null()
    Some(v) -> sqlight.float(v)
  }
}
