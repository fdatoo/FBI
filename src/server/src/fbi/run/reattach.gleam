import fbi/config.{type Config}
import fbi/db/connection
import fbi/db/projects
import fbi/db/runs.{type Run, type RunOutcome, RunOutcome}
import fbi/docker
import fbi/run/actor as run_actor
import fbi/run/broadcaster
import fbi/run/registry.{type RegistryMsg, Register}
import fbi/run/types.{type BroadcastMsg, type RunMsg}
import fbi/run/worker as run_worker
import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import simplifile
import sqlight
import wisp

/// Run reattach for every non-terminal run. Called in fbi.gleam at boot,
/// after the registry is started but before HTTP starts accepting connections.
pub fn run_all(
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
) -> Nil {
  case runs.list_non_terminal(db) {
    Error(e) ->
      wisp.log_warning(
        "reattach: list_non_terminal failed: " <> connection.describe_error(e),
      )
    Ok(rs) -> {
      wisp.log_info(
        "reattach: " <> int.to_string(list.length(rs)) <> " non-terminal run(s)",
      )
      list.each(rs, fn(run) { reattach_one(run, db, config, registry) })
    }
  }
}

fn reattach_one(
  run: Run,
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
) -> Nil {
  case run.state {
    "queued" -> {
      wisp.log_info(
        "reattach: deleting orphaned queued run " <> int.to_string(run.id),
      )
      let _ = runs.delete(db, run.id)
      Nil
    }
    "running" | "waiting" -> reattach_active(run, db, config, registry)
    "awaiting_resume" -> reattach_awaiting(run, db, config, registry)
    _ -> Nil
  }
}

fn reattach_active(
  run: Run,
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
) -> Nil {
  case run.container_id {
    None -> {
      wisp.log_warning(
        "reattach: run "
        <> int.to_string(run.id)
        <> " is "
        <> run.state
        <> " but has no container_id; marking failed",
      )
      let _ = runs.mark_failed(db, run.id, "no container id on boot", now_ms())
      Nil
    }
    Some(cid) -> {
      case inspect(config, cid) {
        Error(reason) -> {
          wisp.log_warning(
            "reattach: inspect container "
            <> cid
            <> " for run "
            <> int.to_string(run.id)
            <> " failed: "
            <> reason
            <> "; marking failed",
          )
          let _ =
            runs.mark_failed(db, run.id, "inspect failed: " <> reason, now_ms())
          Nil
        }
        Ok(docker.ContainerNotFound) -> {
          wisp.log_warning(
            "reattach: container "
            <> cid
            <> " for run "
            <> int.to_string(run.id)
            <> " missing",
          )
          let _ =
            runs.mark_failed(db, run.id, "container disappeared", now_ms())
          Nil
        }
        Ok(docker.ContainerExited(code)) -> finish_exited(run, db, config, code)
        Ok(docker.ContainerRunning) ->
          attach_live(run, cid, db, config, registry)
      }
    }
  }
}

fn attach_live(
  run: Run,
  cid: String,
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
) -> Nil {
  wisp.log_info(
    "reattach: run "
    <> int.to_string(run.id)
    <> " cid="
    <> cid
    <> " reattaching",
  )
  case broadcaster.start() {
    Error(_) -> {
      wisp.log_warning(
        "reattach: failed to start broadcaster for run "
        <> int.to_string(run.id),
      )
      Nil
    }
    Ok(bc) ->
      case
        run_actor.start_attached(
          run.id,
          cid,
          run.branch_name,
          db,
          config,
          bc,
          registry,
        )
      {
        Error(_) -> {
          wisp.log_warning(
            "reattach: failed to start actor for run " <> int.to_string(run.id),
          )
          Nil
        }
        Ok(actor_subject) -> {
          process.send(registry, Register(run.id, actor_subject))
          // Make sure DB state is "running" with the right cid (idempotent if
          // it was already running; corrects a stale "waiting" transition).
          let _ = runs.mark_running(db, run.id, cid, now_ms())
          Nil
        }
      }
  }
}

fn finish_exited(
  run: Run,
  db: sqlight.Connection,
  config: Config,
  exit_code: Int,
) -> Nil {
  let state_dir = config.runs_dir <> "/" <> int.to_string(run.id) <> "/state"
  let outcome = read_outcome(state_dir, exit_code)
  wisp.log_info(
    "reattach: run "
    <> int.to_string(run.id)
    <> " container exited code="
    <> int.to_string(outcome.exit_code)
    <> "; marking finished",
  )
  let _ = runs.mark_finished(db, run.id, outcome, now_ms())
  Nil
}

fn reattach_awaiting(
  run: Run,
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
) -> Nil {
  let now = now_ms()
  case run.next_resume_at {
    Some(t) if t <= now -> resurrect(run, db, config, registry)
    _ -> {
      wisp.log_debug(
        "reattach: run "
        <> int.to_string(run.id)
        <> " awaiting_resume; scheduler will handle",
      )
      Nil
    }
  }
}

/// Resurrect an awaiting_resume run: insert a continue child carrying the
/// session_id and start the supervisor. Public so the auto-resume scheduler
/// can call it too.
pub fn resurrect(
  run: Run,
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
) -> Nil {
  case run.claude_session_id {
    None -> {
      wisp.log_warning(
        "reattach: run "
        <> int.to_string(run.id)
        <> " awaiting_resume has no claude_session_id; cannot resurrect",
      )
      let _ = runs.mark_failed(db, run.id, "no session_id on resume", now_ms())
      Nil
    }
    Some(session_id) ->
      case projects.get(db, run.project_id) {
        Error(_) -> {
          wisp.log_warning(
            "reattach: project "
            <> int.to_string(run.project_id)
            <> " not found; cannot resurrect run "
            <> int.to_string(run.id),
          )
          let _ = runs.mark_failed(db, run.id, "project missing", now_ms())
          Nil
        }
        Ok(project) -> {
          let now = now_ms()
          case
            runs.insert_continue_run(
              db,
              run,
              run.model,
              run.effort,
              run.subagent_model,
              session_id,
              now,
            )
          {
            Error(e) -> {
              wisp.log_warning(
                "reattach: insert_continue_run for "
                <> int.to_string(run.id)
                <> " failed: "
                <> connection.describe_error(e),
              )
              Nil
            }
            Ok(child) -> {
              wisp.log_info(
                "reattach: resurrecting run "
                <> int.to_string(run.id)
                <> " as continue run "
                <> int.to_string(child.id),
              )
              // Mark the parent as succeeded so the chain terminates cleanly.
              let _ =
                runs.mark_finished(
                  db,
                  run.id,
                  RunOutcome(
                    exit_code: 0,
                    branch_pushed: None,
                    head_commit: None,
                    title: None,
                    error_message: None,
                    claude_session_id: run.claude_session_id,
                  ),
                  now,
                )
              // Start a supervisor + worker for the new child.
              case supervisor_start(db, config, registry, child.id) {
                Error(reason) ->
                  wisp.log_warning(
                    "reattach: supervisor_start for child "
                    <> int.to_string(child.id)
                    <> " failed: "
                    <> reason,
                  )
                Ok(#(actor_subject, bc)) -> {
                  run_worker.launch(
                    run_worker.LaunchInput(
                      run: child,
                      project: project,
                      config: config,
                      cols: 80,
                      rows: 24,
                      broadcaster: bc,
                    ),
                    actor_subject,
                  )
                  Nil
                }
              }
            }
          }
        }
      }
  }
}

fn supervisor_start(
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
  run_id: Int,
) -> Result(#(Subject(RunMsg), Subject(BroadcastMsg)), String) {
  use bc <- result.try(
    broadcaster.start()
    |> result.map_error(fn(_) { "failed to start broadcaster" }),
  )
  use actor_subject <- result.try(
    run_actor.start(run_id, db, config, bc, registry)
    |> result.map_error(fn(_) { "failed to start run actor" }),
  )
  process.send(registry, Register(run_id, actor_subject))
  Ok(#(actor_subject, bc))
}

fn inspect(
  config: Config,
  cid: String,
) -> Result(docker.ContainerStatus, String) {
  case docker.connect(config.docker_socket) {
    Error(e) -> Error("connect: " <> docker.describe_error(e))
    Ok(sock) -> {
      let result = case docker.inspect_container(sock, cid) {
        Ok(s) -> Ok(s)
        Error(e) -> Error(docker.describe_error(e))
      }
      docker.close(sock)
      result
    }
  }
}

fn read_outcome(state_dir: String, exit_code: Int) -> RunOutcome {
  case simplifile.read(state_dir <> "/result.json") {
    Error(_) ->
      RunOutcome(
        exit_code: exit_code,
        branch_pushed: None,
        head_commit: None,
        title: None,
        error_message: case exit_code {
          0 -> None
          code -> Some("exit " <> int.to_string(code))
        },
        claude_session_id: None,
      )
    Ok(json_str) -> {
      let decoder = {
        use agent_exit <- decode.optional_field(
          "exit_code",
          exit_code,
          decode.int,
        )
        use push_exit <- decode.optional_field("push_exit", 0, decode.int)
        use head_sha <- decode.optional_field("head_sha", "", decode.string)
        use branch <- decode.optional_field("branch", "", decode.string)
        use session_id <- decode.optional_field("session_id", "", decode.string)
        decode.success(#(agent_exit, push_exit, head_sha, branch, session_id))
      }
      case json.parse(json_str, decoder) {
        Error(_) ->
          RunOutcome(
            exit_code: exit_code,
            branch_pushed: None,
            head_commit: None,
            title: None,
            error_message: Some("could not parse result.json"),
            claude_session_id: None,
          )
        Ok(#(agent_exit, push_exit, head_sha, branch, session_id)) ->
          RunOutcome(
            exit_code: agent_exit,
            branch_pushed: case push_exit {
              0 ->
                case branch {
                  "" -> None
                  b -> Some(b)
                }
              _ -> None
            },
            head_commit: case head_sha {
              "" -> None
              sha -> Some(sha)
            },
            title: None,
            error_message: case agent_exit {
              0 -> None
              code -> Some("agent exit " <> int.to_string(code))
            },
            claude_session_id: case session_id {
              "" -> None
              sid -> Some(sid)
            },
          )
      }
    }
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
