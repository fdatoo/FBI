import fbi/db/connection.{type DbError, SqlightError}
import gleam/dynamic/decode
import gleam/io
import gleam/list
import gleam/result
import gleam/string
import simplifile
import sqlight

pub fn run(db: sqlight.Connection) -> Result(Nil, DbError) {
  use _ <- result.try(create_schema_migrations(db))
  case simplifile.read_directory("priv/migrations") {
    // directory doesn't exist yet; no migrations to run
    Error(_) -> Ok(Nil)
    Ok(entries) -> {
      let sql_files =
        entries
        |> list.filter(fn(f) { string.ends_with(f, ".sql") })
        |> list.sort(string.compare)
      list.try_each(sql_files, fn(filename) {
        let full_path = "priv/migrations/" <> filename
        apply_migration(db, filename, full_path)
      })
    }
  }
}

fn create_schema_migrations(db: sqlight.Connection) -> Result(Nil, DbError) {
  connection.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )",
    db,
  )
}

fn apply_migration(
  db: sqlight.Connection,
  filename: String,
  full_path: String,
) -> Result(Nil, DbError) {
  let already_applied =
    sqlight.query(
      "SELECT 1 FROM schema_migrations WHERE filename = ?",
      on: db,
      with: [sqlight.text(filename)],
      expecting: decode.at([0], decode.int),
    )
    |> result.map(fn(rows) { rows != [] })
    |> result.unwrap(False)

  case already_applied {
    True -> Ok(Nil)
    False -> {
      case simplifile.read(full_path) {
        // skip if file can't be read
        Error(_) -> Ok(Nil)
        Ok(sql) -> {
          io.println("Running migration: " <> filename)
          use _ <- result.try(connection.exec(sql, db))
          sqlight.query(
            "INSERT INTO schema_migrations (filename, applied_at) VALUES (?, unixepoch() * 1000)",
            on: db,
            with: [sqlight.text(filename)],
            expecting: decode.dynamic,
          )
          |> result.map(fn(_) { Nil })
          |> result.map_error(SqlightError)
        }
      }
    }
  }
}
