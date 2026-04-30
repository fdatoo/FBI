import fbi/config.{type Config}
import fbi/db/projects
import fbi/db/runs as runs_db
import fbi/docker
import fbi/git.{type GitError}
import fbi/run/actor as run_actor
import fbi/run/broadcaster
import fbi/run/registry.{type RegistryMsg, Register}
import fbi/run/types.{type BroadcastMsg, type RunMsg}
import fbi/run/worker as run_worker
import gleam/erlang/process.{type Subject}
import gleam/result
import gleam/string
import sqlight

pub type Outcome {
  Complete(sha: String)
  Agent(child_run_id: Int)
  Conflict(child_run_id: Int)
  GitError(message: String)
  Invalid(message: String)
}

pub type MergeStrategy {
  NoFf
  FfOnly
  Squash
}

pub type DispatchResult {
  AgentDispatched(child_run_id: Int)
  AgentBusy
  DispatchError(message: String)
}

pub fn squash_local(
  repo_path: String,
  branch: String,
  base: String,
  subject: String,
) -> Result(Outcome, GitError) {
  use base_sha <- result_try(rev_parse(repo_path, base))
  use original_tip <- result_try(rev_parse(repo_path, branch))
  use tree <- result_try(rev_parse(repo_path, original_tip <> "^{tree}"))
  use new_commit <- result_try(
    git.run(repo_path, ["commit-tree", tree, "-p", base_sha, "-m", subject])
    |> result.map(string.trim),
  )
  use _ <- result_try(
    git.run(repo_path, [
      "update-ref",
      "refs/heads/" <> branch,
      new_commit,
    ]),
  )
  Ok(Complete(sha: new_commit))
}

pub fn mirror_rebase(
  repo_path: String,
  branch: String,
  remote: String,
  remote_branch: String,
) -> Result(Outcome, GitError) {
  use _ <- result_try(git.run(repo_path, ["fetch", remote, remote_branch]))
  use _ <- result_try(
    git.run(repo_path, [
      "update-ref",
      "refs/heads/" <> remote_branch,
      "FETCH_HEAD",
    ]),
  )
  case
    git.run(repo_path, [
      "merge-base",
      "--is-ancestor",
      "FETCH_HEAD",
      "refs/heads/" <> branch,
    ])
  {
    Ok(_) -> Ok(Complete(sha: ""))
    Error(_) -> Ok(Conflict(child_run_id: 0))
  }
}

pub fn sync_in_container(
  config: Config,
  cid: String,
) -> Result(Outcome, String) {
  exec_in_container(config, cid, "cd /workspace && git pull --no-rebase 2>&1")
}

pub fn merge_in_container(
  config: Config,
  cid: String,
  remote_branch: String,
  strategy: MergeStrategy,
) -> Result(Outcome, String) {
  let flag = case strategy {
    NoFf -> "--no-ff"
    FfOnly -> "--ff-only"
    Squash -> "--squash"
  }
  exec_in_container(
    config,
    cid,
    "cd /workspace && git fetch origin "
      <> remote_branch
      <> " && git merge "
      <> flag
      <> " FETCH_HEAD 2>&1",
  )
}

fn exec_in_container(
  config: Config,
  cid: String,
  shell_cmd: String,
) -> Result(Outcome, String) {
  case docker.connect(config.docker_socket) {
    Error(e) -> Error(docker.describe_error(e))
    Ok(sock) -> {
      let r = docker.exec_container(sock, cid, ["sh", "-c", shell_cmd], "agent")
      docker.close(sock)
      case r {
        Error(e) -> Error(docker.describe_error(e))
        Ok(res) ->
          case res.exit_code {
            0 -> Ok(Complete(sha: ""))
            _ ->
              case string.contains(res.output, "CONFLICT") {
                True -> Ok(Conflict(child_run_id: 0))
                False -> Ok(GitError(message: res.output))
              }
          }
      }
    }
  }
}

pub fn dispatch_polish(
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
  parent: runs_db.Run,
) -> DispatchResult {
  dispatch_child(db, config, registry, parent, "polish")
}

pub fn dispatch_merge_conflict(
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
  parent: runs_db.Run,
) -> DispatchResult {
  dispatch_child(db, config, registry, parent, "merge-conflict")
}

fn dispatch_child(
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
  parent: runs_db.Run,
  kind: String,
) -> DispatchResult {
  case runs_db.count_active_children(db, parent.id) {
    Ok(n) if n > 0 -> AgentBusy
    Error(_) -> DispatchError(message: "could not count children")
    Ok(_) -> {
      let now = now_ms()
      let inserted = case kind {
        "polish" -> runs_db.insert_polish_run(db, parent, now)
        _ -> runs_db.insert_merge_conflict_run(db, parent, now)
      }
      case inserted {
        Error(_) -> DispatchError(message: "could not insert child")
        Ok(child) ->
          case projects.get(db, parent.project_id) {
            Error(_) -> DispatchError(message: "project missing")
            Ok(project) ->
              case start_run_actor(db, config, registry, child) {
                Error(reason) -> DispatchError(message: reason)
                Ok(#(actor_subj, bc)) -> {
                  run_worker.launch(
                    run_worker.LaunchInput(
                      run: child,
                      project: project,
                      config: config,
                      cols: 80,
                      rows: 24,
                      broadcaster: bc,
                    ),
                    actor_subj,
                  )
                  AgentDispatched(child_run_id: child.id)
                }
              }
          }
      }
    }
  }
}

fn start_run_actor(
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
  run: runs_db.Run,
) -> Result(#(Subject(RunMsg), Subject(BroadcastMsg)), String) {
  use bc <- result.try(
    broadcaster.start()
    |> result.map_error(fn(_) { "broadcaster start failed" }),
  )
  use actor_subj <- result.try(
    run_actor.start(run.id, db, config, bc, registry)
    |> result.map_error(fn(_) { "actor start failed" }),
  )
  process.send(registry, Register(run.id, actor_subj))
  Ok(#(actor_subj, bc))
}

fn rev_parse(repo_path: String, ref: String) -> Result(String, GitError) {
  use s <- result_try(git.run(repo_path, ["rev-parse", ref]))
  Ok(string.trim(s))
}

fn result_try(r: Result(a, e), f: fn(a) -> Result(b, e)) -> Result(b, e) {
  case r {
    Ok(v) -> f(v)
    Error(e) -> Error(e)
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
