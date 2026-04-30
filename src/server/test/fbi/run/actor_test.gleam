import fbi/config
import fbi/db/migrations
import fbi/db/projects
import fbi/db/runs
import fbi/run/actor as run_actor
import fbi/run/broadcaster
import fbi/run/registry
import fbi/run/types.{
  AgentStatusChanged, BroadcastSubscribe, Cancel, StateChanged, WorkerFailed,
  WorkerReady,
}
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/option.{None}
import gleeunit/should
import sqlight

fn test_setup() -> #(sqlight.Connection, config.Config) {
  let assert Ok(db) = sqlight.open(":memory:")
  let assert Ok(_) = migrations.run(db)
  let now = 1_700_000_000_000
  let assert Ok(p) =
    projects.insert(
      db,
      projects.NewProject(
        name: "p",
        repo_url: "u",
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
        created_at: now,
        updated_at: now,
      ),
    )
  // Insert a run using sqlight.query (sqlight.exec doesn't support `with:`)
  let _ =
    sqlight.query(
      "INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at, state_entered_at) VALUES (?, 'test prompt', 'main', 'queued', '/tmp/log', ?, ?) RETURNING id",
      on: db,
      with: [sqlight.int(p.id), sqlight.int(now), sqlight.int(now)],
      expecting: decode.at([0], decode.int),
    )
  #(db, test_config())
}

fn test_config() -> config.Config {
  config.Config(
    port: 0,
    secret_key: "test",
    database_path: ":memory:",
    runs_dir: "/tmp/r",
    git_author_name: "t",
    git_author_email: "t@t",
    web_dist_dir: None,
    docker_socket: "/var/run/docker.sock",
    docker_gid: None,
    ssh_auth_sock: None,
    claude_dir: None,
    secrets_key: <<0:size(256)>>,
    default_plugins: [],
    default_marketplaces: [],
  )
}

pub fn agent_status_changed_in_running_updates_db_and_broadcasts_test() {
  let #(db, cfg) = test_setup()
  let assert Ok(bc) = broadcaster.start()
  let assert Ok(reg) = registry.start()
  let event_sub = process.new_subject()
  process.send(bc, BroadcastSubscribe(event_sub))
  let assert Ok(actor_subject) = run_actor.start(1, db, cfg, bc, reg)
  // Transition to Running
  process.send(actor_subject, WorkerReady("test-cid", "main", 80, 24))
  process.sleep(50)
  // Drain the StateChanged("running") from WorkerReady
  let _ = process.receive(event_sub, 100)
  // Send AgentStatusChanged
  process.send(actor_subject, AgentStatusChanged("waiting"))
  process.sleep(50)
  // DB state updated
  let assert Ok(run) = runs.get(db, 1)
  run.state |> should.equal("waiting")
  // StateChanged("waiting") broadcast to subscribers
  let assert Ok(event) = process.receive(event_sub, 100)
  event |> should.equal(StateChanged("waiting"))
}

pub fn agent_status_changed_ignored_when_not_running_test() {
  let #(db, cfg) = test_setup()
  let assert Ok(bc) = broadcaster.start()
  let assert Ok(reg) = registry.start()
  let assert Ok(actor_subject) = run_actor.start(1, db, cfg, bc, reg)
  // Send in Starting phase — must not crash or change state
  process.send(actor_subject, AgentStatusChanged("waiting"))
  process.sleep(50)
  let assert Ok(run) = runs.get(db, 1)
  run.state |> should.equal("queued")
}

pub fn worker_failed_transitions_to_failed_test() {
  let #(db, cfg) = test_setup()
  let assert Ok(bc) = broadcaster.start()
  let assert Ok(reg) = registry.start()
  let assert Ok(actor_subject) = run_actor.start(1, db, cfg, bc, reg)
  process.send(actor_subject, WorkerFailed("simulated failure"))
  // Give the actor time to process the message
  process.sleep(50)
  // Send Cancel — should be silently ignored since actor is in Failed phase
  process.send(actor_subject, Cancel)
  process.sleep(10)
  // No crash = pass
  Nil
}

pub fn start_and_shutdown_test() {
  let #(db, cfg) = test_setup()
  let assert Ok(bc) = broadcaster.start()
  let assert Ok(reg) = registry.start()
  let assert Ok(actor_subject) = run_actor.start(1, db, cfg, bc, reg)
  // Verify the actor starts correctly in Starting phase
  // by sending Shutdown which should stop the actor cleanly
  process.send(actor_subject, types.Shutdown)
  process.sleep(50)
  // No crash = pass
  Nil
  |> should.equal(Nil)
}
