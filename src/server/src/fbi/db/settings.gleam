import fbi/db/connection.{type DbError, SqlightError}
import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option}
import gleam/result
import gleam/string
import sqlight

pub type Settings {
  Settings(
    id: Int,
    global_prompt: String,
    notifications_enabled: Bool,
    concurrency_warn_at: Int,
    image_gc_enabled: Bool,
    last_gc_at: Option(Int),
    last_gc_count: Option(Int),
    last_gc_bytes: Option(Int),
    global_marketplaces_json: String,
    global_plugins_json: String,
    auto_resume_enabled: Bool,
    auto_resume_max_attempts: Int,
    usage_notifications_enabled: Bool,
    tokens_total_recomputed_at: Option(Int),
    updated_at: Int,
  )
}

fn decoder() -> decode.Decoder(Settings) {
  use id <- decode.field(0, decode.int)
  use global_prompt <- decode.field(1, decode.string)
  use notifications_enabled <- decode.field(2, decode.int)
  use concurrency_warn_at <- decode.field(3, decode.int)
  use image_gc_enabled <- decode.field(4, decode.int)
  use last_gc_at <- decode.field(5, decode.optional(decode.int))
  use last_gc_count <- decode.field(6, decode.optional(decode.int))
  use last_gc_bytes <- decode.field(7, decode.optional(decode.int))
  use global_marketplaces_json <- decode.field(8, decode.string)
  use global_plugins_json <- decode.field(9, decode.string)
  use auto_resume_enabled <- decode.field(10, decode.int)
  use auto_resume_max_attempts <- decode.field(11, decode.int)
  use usage_notifications_enabled <- decode.field(12, decode.int)
  use tokens_total_recomputed_at <- decode.field(
    13,
    decode.optional(decode.int),
  )
  use updated_at <- decode.field(14, decode.int)
  decode.success(Settings(
    id:,
    global_prompt:,
    notifications_enabled: notifications_enabled != 0,
    concurrency_warn_at:,
    image_gc_enabled: image_gc_enabled != 0,
    last_gc_at:,
    last_gc_count:,
    last_gc_bytes:,
    global_marketplaces_json:,
    global_plugins_json:,
    auto_resume_enabled: auto_resume_enabled != 0,
    auto_resume_max_attempts:,
    usage_notifications_enabled: usage_notifications_enabled != 0,
    tokens_total_recomputed_at:,
    updated_at:,
  ))
}

const select_sql = "SELECT id, global_prompt, notifications_enabled, concurrency_warn_at,
       image_gc_enabled, last_gc_at, last_gc_count, last_gc_bytes,
       global_marketplaces_json, global_plugins_json,
       auto_resume_enabled, auto_resume_max_attempts,
       usage_notifications_enabled, tokens_total_recomputed_at, updated_at
FROM settings WHERE id = 1"

pub fn get(db: sqlight.Connection) -> Result(Settings, DbError) {
  use _ <- result.try(
    sqlight.query(
      "INSERT OR IGNORE INTO settings (id, global_prompt, updated_at) VALUES (1, '', unixepoch() * 1000)",
      on: db,
      with: [],
      expecting: decode.at([0], decode.int),
    )
    |> result.map_error(SqlightError)
    |> result.map(fn(_) { Nil }),
  )
  connection.query_one(select_sql, db, [], decoder())
}

pub fn patch(
  db: sqlight.Connection,
  global_prompt: Option(String),
  notifications_enabled: Option(Bool),
  auto_resume_enabled: Option(Bool),
  auto_resume_max_attempts: Option(Int),
  concurrency_warn_at: Option(Int),
  image_gc_enabled: Option(Bool),
  global_marketplaces_json: Option(String),
  global_plugins_json: Option(String),
  usage_notifications_enabled: Option(Bool),
  now: Int,
) -> Result(Settings, DbError) {
  let bool_val = fn(b: Bool) {
    sqlight.int(case b {
      True -> 1
      False -> 0
    })
  }
  let sets =
    [
      option.map(global_prompt, fn(v) {
        #("global_prompt = ?", sqlight.text(v))
      }),
      option.map(notifications_enabled, fn(v) {
        #("notifications_enabled = ?", bool_val(v))
      }),
      option.map(auto_resume_enabled, fn(v) {
        #("auto_resume_enabled = ?", bool_val(v))
      }),
      option.map(auto_resume_max_attempts, fn(v) {
        #("auto_resume_max_attempts = ?", sqlight.int(v))
      }),
      option.map(concurrency_warn_at, fn(v) {
        #("concurrency_warn_at = ?", sqlight.int(v))
      }),
      option.map(image_gc_enabled, fn(v) {
        #("image_gc_enabled = ?", bool_val(v))
      }),
      option.map(global_marketplaces_json, fn(v) {
        #("global_marketplaces_json = ?", sqlight.text(v))
      }),
      option.map(global_plugins_json, fn(v) {
        #("global_plugins_json = ?", sqlight.text(v))
      }),
      option.map(usage_notifications_enabled, fn(v) {
        #("usage_notifications_enabled = ?", bool_val(v))
      }),
    ]
    |> list.filter_map(fn(o) { option.to_result(o, Nil) })

  let set_clause =
    list.map(sets, fn(s: #(String, sqlight.Value)) { s.0 })
    |> string.join(", ")
  let args = list.map(sets, fn(s: #(String, sqlight.Value)) { s.1 })

  use _ <- result.try(
    sqlight.query(
      "INSERT OR IGNORE INTO settings (id, global_prompt, updated_at) VALUES (1, '', ?)",
      on: db,
      with: [sqlight.int(now)],
      expecting: decode.at([0], decode.int),
    )
    |> result.map_error(SqlightError)
    |> result.map(fn(_) { Nil }),
  )
  case set_clause {
    "" -> get(db)
    _ -> {
      use _ <- result.try(
        sqlight.query(
          "UPDATE settings SET "
            <> set_clause
            <> ", updated_at = ? WHERE id = 1",
          on: db,
          with: list.append(args, [sqlight.int(now)]),
          expecting: decode.at([0], decode.int),
        )
        |> result.map_error(SqlightError)
        |> result.map(fn(_) { Nil }),
      )
      get(db)
    }
  }
}

pub fn update_gc_result(
  db: sqlight.Connection,
  deleted_count: Int,
  deleted_bytes: Int,
  now_ms: Int,
) -> Result(Nil, DbError) {
  sqlight.query(
    "UPDATE settings SET last_gc_at = ?, last_gc_count = ?, last_gc_bytes = ?, updated_at = ? WHERE id = 1",
    on: db,
    with: [
      sqlight.int(now_ms),
      sqlight.int(deleted_count),
      sqlight.int(deleted_bytes),
      sqlight.int(now_ms),
    ],
    expecting: decode.at([0], decode.int),
  )
  |> result.map(fn(_) { Nil })
  |> result.map_error(SqlightError)
}
