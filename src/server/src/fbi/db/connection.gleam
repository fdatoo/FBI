import gleam/dynamic/decode
import gleam/result
import sqlight

pub type DbError {
  SqlightError(sqlight.Error)
  NotFound
  MultipleRows
}

pub fn open(path: String) -> Result(sqlight.Connection, String) {
  sqlight.open(path)
  |> result.map_error(fn(e) { "Cannot open database: " <> e.message })
}

pub fn close(db: sqlight.Connection) -> Nil {
  let _ = sqlight.close(db)
  Nil
}

pub fn query_one(
  sql: String,
  db: sqlight.Connection,
  args: List(sqlight.Value),
  decoder: decode.Decoder(a),
) -> Result(a, DbError) {
  sqlight.query(sql, on: db, with: args, expecting: decoder)
  |> result.map_error(SqlightError)
  |> result.try(fn(rows) {
    case rows {
      [row] -> Ok(row)
      [] -> Error(NotFound)
      _ -> Error(MultipleRows)
    }
  })
}

pub fn query_all(
  sql: String,
  db: sqlight.Connection,
  args: List(sqlight.Value),
  decoder: decode.Decoder(a),
) -> Result(List(a), DbError) {
  sqlight.query(sql, on: db, with: args, expecting: decoder)
  |> result.map_error(SqlightError)
}

pub fn exec(sql: String, db: sqlight.Connection) -> Result(Nil, DbError) {
  sqlight.exec(sql, on: db)
  |> result.map_error(SqlightError)
}

pub fn describe_error(e: DbError) -> String {
  case e {
    SqlightError(err) -> err.message
    NotFound -> "not found"
    MultipleRows -> "multiple rows"
  }
}
