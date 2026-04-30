import fbi/db/migrations
import gleam/dynamic/decode
import gleeunit/should
import sqlight

pub fn migrations_run_idempotent_test() {
  let assert Ok(db) = sqlight.open(":memory:")
  migrations.run(db) |> should.be_ok()
  // running a second time should not error (already applied)
  migrations.run(db) |> should.be_ok()
  let _ = sqlight.close(db)
}

pub fn migrations_create_schema_migrations_table_test() {
  let assert Ok(db) = sqlight.open(":memory:")
  let assert Ok(_) = migrations.run(db)
  // schema_migrations table should exist
  let result =
    sqlight.query(
      "SELECT count(*) FROM schema_migrations",
      on: db,
      with: [],
      expecting: decode.at([0], decode.int),
    )
  result |> should.be_ok()
  let _ = sqlight.close(db)
}

pub fn migrations_create_projects_table_test() {
  let assert Ok(db) = sqlight.open(":memory:")
  let assert Ok(_) = migrations.run(db)
  // projects table should exist and be queryable
  let result =
    sqlight.query(
      "SELECT count(*) FROM projects",
      on: db,
      with: [],
      expecting: decode.at([0], decode.int),
    )
  result |> should.be_ok()
  let _ = sqlight.close(db)
}
