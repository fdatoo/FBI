import fbi/crypto
import fbi/db/connection.{type DbError, SqlightError}
import gleam/bit_array
import gleam/dynamic/decode
import gleam/list
import gleam/result
import sqlight

pub type Secret {
  Secret(id: Int, project_id: Int, name: String, created_at: Int)
}

pub fn list(
  db: sqlight.Connection,
  project_id: Int,
) -> Result(List(Secret), DbError) {
  connection.query_all(
    "SELECT id, project_id, name, created_at FROM project_secrets
     WHERE project_id = ? ORDER BY name",
    db,
    [sqlight.int(project_id)],
    secret_decoder(),
  )
}

pub fn put(
  db: sqlight.Connection,
  project_id: Int,
  name: String,
  plaintext: String,
  key: BitArray,
  now: Int,
) -> Result(Secret, DbError) {
  let assert Ok(encrypted) =
    crypto.encrypt(key, bit_array.from_string(plaintext))
  use _ <- result.try(
    sqlight.query(
      "INSERT INTO project_secrets (project_id, name, value_enc, created_at)
       VALUES (?,?,?,?)
       ON CONFLICT (project_id, name) DO UPDATE SET value_enc = excluded.value_enc",
      on: db,
      with: [
        sqlight.int(project_id),
        sqlight.text(name),
        sqlight.blob(encrypted),
        sqlight.int(now),
      ],
      expecting: decode.at([0], decode.int),
    )
    |> result.map_error(SqlightError)
    |> result.map(fn(_) { Nil }),
  )
  connection.query_one(
    "SELECT id, project_id, name, created_at FROM project_secrets
     WHERE project_id = ? AND name = ?",
    db,
    [sqlight.int(project_id), sqlight.text(name)],
    secret_decoder(),
  )
}

pub fn delete(
  db: sqlight.Connection,
  project_id: Int,
  name: String,
) -> Result(Nil, DbError) {
  sqlight.query(
    "DELETE FROM project_secrets WHERE project_id = ? AND name = ?",
    on: db,
    with: [sqlight.int(project_id), sqlight.text(name)],
    expecting: decode.at([0], decode.int),
  )
  |> result.map_error(SqlightError)
  |> result.map(fn(_) { Nil })
}

/// Fetch all secrets for a project and return decrypted name/value pairs.
/// Rows that fail to decrypt or have non-UTF-8 values are silently skipped.
pub fn list_plaintext(
  db: sqlight.Connection,
  project_id: Int,
  key: BitArray,
) -> List(#(String, String)) {
  let row_decoder = {
    use name <- decode.field(0, decode.string)
    use value_enc <- decode.field(1, decode.bit_array)
    decode.success(#(name, value_enc))
  }
  case
    connection.query_all(
      "SELECT name, value_enc FROM project_secrets WHERE project_id = ? ORDER BY name",
      db,
      [sqlight.int(project_id)],
      row_decoder,
    )
  {
    Error(_) -> []
    Ok(rows) ->
      list.filter_map(rows, fn(row) {
        let #(name, enc) = row
        case crypto.decrypt(key, enc) {
          Error(_) -> Error(Nil)
          Ok(bits) ->
            case bit_array.to_string(bits) {
              Error(_) -> Error(Nil)
              Ok(value) -> Ok(#(name, value))
            }
        }
      })
  }
}

fn secret_decoder() -> decode.Decoder(Secret) {
  use id <- decode.field(0, decode.int)
  use project_id <- decode.field(1, decode.int)
  use name <- decode.field(2, decode.string)
  use created_at <- decode.field(3, decode.int)
  decode.success(Secret(id:, project_id:, name:, created_at:))
}
