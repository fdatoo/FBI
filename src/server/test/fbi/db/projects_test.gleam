import fbi/db/migrations
import fbi/db/projects
import gleam/list
import gleam/option.{None, Some}
import gleeunit/should
import sqlight

fn setup() -> sqlight.Connection {
  let assert Ok(db) = sqlight.open(":memory:")
  let assert Ok(_) = migrations.run(db)
  db
}

fn new_project(name: String) -> projects.NewProject {
  projects.NewProject(
    name: name,
    repo_url: "https://github.com/test/" <> name,
    default_branch: "main",
    devcontainer_override_json: None,
    instructions: None,
    git_author_name: None,
    git_author_email: None,
    marketplaces_json: "[]",
    plugins_json: "[]",
    mem_mb: None,
    cpus: None,
    pids_limit: None,
    created_at: 1_000_000,
    updated_at: 1_000_000,
  )
}

pub fn insert_and_get_test() {
  let db = setup()

  let assert Ok(p) = projects.insert(db, new_project("my-project"))

  p.name |> should.equal("my-project")
  p.repo_url |> should.equal("https://github.com/test/my-project")
  p.default_branch |> should.equal("main")
  p.marketplaces_json |> should.equal("[]")
  p.plugins_json |> should.equal("[]")
  p.devcontainer_override_json |> should.equal(None)
  p.instructions |> should.equal(None)
  p.created_at |> should.equal(1_000_000)

  let assert Ok(fetched) = projects.get(db, p.id)
  fetched.id |> should.equal(p.id)
  fetched.name |> should.equal("my-project")

  let _ = sqlight.close(db)
}

pub fn get_not_found_test() {
  let db = setup()

  projects.get(db, 9999)
  |> should.be_error()

  let _ = sqlight.close(db)
}

pub fn list_test() {
  let db = setup()

  let assert Ok(_) = projects.insert(db, new_project("alpha"))
  let assert Ok(_) = projects.insert(db, new_project("beta"))
  let assert Ok(_) = projects.insert(db, new_project("gamma"))

  let assert Ok(ps) = projects.list(db)
  list.length(ps) |> should.equal(3)

  // ordered by id
  let names = list.map(ps, fn(p) { p.name })
  names |> should.equal(["alpha", "beta", "gamma"])

  let _ = sqlight.close(db)
}

pub fn delete_test() {
  let db = setup()

  let assert Ok(p) = projects.insert(db, new_project("to-delete"))

  projects.delete(db, p.id) |> should.be_ok()

  projects.get(db, p.id) |> should.be_error()

  let _ = sqlight.close(db)
}

pub fn update_test() {
  let db = setup()

  let assert Ok(p) = projects.insert(db, new_project("orig-name"))

  let patch =
    projects.PatchProject(
      name: Some("new-name"),
      repo_url: None,
      default_branch: None,
      devcontainer_override_json: None,
      instructions: Some(Some("some instructions")),
      git_author_name: None,
      git_author_email: None,
      marketplaces_json: None,
      plugins_json: None,
      mem_mb: None,
      cpus: None,
      pids_limit: None,
    )

  let assert Ok(updated) = projects.update(db, p.id, patch, 2_000_000)
  updated.name |> should.equal("new-name")
  updated.instructions |> should.equal(Some("some instructions"))
  updated.updated_at |> should.equal(2_000_000)
  // repo_url unchanged
  updated.repo_url |> should.equal("https://github.com/test/orig-name")

  let _ = sqlight.close(db)
}

pub fn insert_with_optional_fields_test() {
  let db = setup()

  let np =
    projects.NewProject(
      name: "full-project",
      repo_url: "https://github.com/test/full-project",
      default_branch: "develop",
      devcontainer_override_json: Some("{\"image\": \"node:20\"}"),
      instructions: Some("Do the thing"),
      git_author_name: Some("Bot"),
      git_author_email: Some("bot@example.com"),
      marketplaces_json: "[\"npm\"]",
      plugins_json: "[\"plugin1\"]",
      mem_mb: Some(2048),
      cpus: Some(2.0),
      pids_limit: Some(1024),
      created_at: 1_000_000,
      updated_at: 1_000_000,
    )

  let assert Ok(p) = projects.insert(db, np)
  p.default_branch |> should.equal("develop")
  p.devcontainer_override_json |> should.equal(Some("{\"image\": \"node:20\"}"))
  p.instructions |> should.equal(Some("Do the thing"))
  p.git_author_name |> should.equal(Some("Bot"))
  p.git_author_email |> should.equal(Some("bot@example.com"))
  p.mem_mb |> should.equal(Some(2048))
  p.cpus |> should.equal(Some(2.0))
  p.pids_limit |> should.equal(Some(1024))

  let _ = sqlight.close(db)
}
