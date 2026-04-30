import fbi/config.{type Config}
import fbi/db/runs as runs_db
import fbi/docker
import fbi/pubsub
import fbi/run/container_monitor
import fbi/run/registry.{type RegistryMsg, Unregister}
import fbi/run/types.{
  type BroadcastMsg, type Phase, type RunMsg, type RunOutcome,
  type TerminalEvent, AgentStatusChanged, BroadcastChunk, BroadcastEvent,
  BroadcastShutdown, BroadcastSubscribe, BroadcastUnsubscribe, Cancel,
  ContainerExited, Done, Failed, Finishing, Resize, Running, Shutdown, Snapshot,
  Starting, StateChanged, Subscribe, Unsubscribe, Waiting, WaitingTimeout,
  WorkerFailed, WorkerReady, WriteStdin,
}
import fbi/run/usage_tailer.{type TailerMsg}
import gleam/bit_array
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/result
import simplifile
import sqlight
import wisp

pub type State {
  State(
    run_id: Int,
    db: sqlight.Connection,
    config: Config,
    phase: Phase,
    listener_count: Int,
    actor_subject: Subject(RunMsg),
    stdin_sock: Option(docker.Socket),
    registry: Subject(RegistryMsg),
    pubsub: Subject(pubsub.PubsubMsg),
    tailer: Option(Subject(TailerMsg)),
  )
}

pub fn start(
  run_id: Int,
  db: sqlight.Connection,
  config: Config,
  bc: Subject(BroadcastMsg),
  registry: Subject(RegistryMsg),
  pubsub_subject: Subject(pubsub.PubsubMsg),
) -> Result(Subject(RunMsg), actor.StartError) {
  actor.new_with_initialiser(500, fn(subject) {
    State(
      run_id: run_id,
      db: db,
      config: config,
      phase: Starting(bc),
      listener_count: 0,
      actor_subject: subject,
      stdin_sock: None,
      registry: registry,
      pubsub: pubsub_subject,
      tailer: None,
    )
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: RunMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

/// Starts an actor for a run that's already running in Docker — used by boot
/// reattach. Skips the Starting phase and the worker entirely; goes straight
/// into Running and calls container_monitor.start to reattach to stdin/stdout.
pub fn start_attached(
  run_id: Int,
  cid: String,
  branch: String,
  db: sqlight.Connection,
  config: Config,
  bc: Subject(BroadcastMsg),
  registry: Subject(RegistryMsg),
  pubsub_subject: Subject(pubsub.PubsubMsg),
) -> Result(Subject(RunMsg), actor.StartError) {
  actor.new_with_initialiser(500, fn(subject) {
    let stdin_sock = case
      container_monitor.start(config, cid, run_id, subject, bc)
    {
      Ok(sock) -> Some(sock)
      Error(e) -> {
        wisp.log_warning(
          "reattach: container_monitor.start for run "
          <> int.to_string(run_id)
          <> " cid="
          <> cid
          <> " failed: "
          <> docker.describe_error(e),
        )
        None
      }
    }
    // Start the tailer immediately for reattached runs
    let tailer = start_tailer(run_id, config, db, pubsub_subject, bc)
    State(
      run_id: run_id,
      db: db,
      config: config,
      phase: Running(cid, branch, bc, 80, 24),
      listener_count: 0,
      actor_subject: subject,
      stdin_sock: stdin_sock,
      registry: registry,
      pubsub: pubsub_subject,
      tailer: tailer,
    )
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: RunMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn start_tailer(
  run_id: Int,
  config: Config,
  db: sqlight.Connection,
  pubsub_subject: Subject(pubsub.PubsubMsg),
  bc: Subject(BroadcastMsg),
) -> Option(Subject(TailerMsg)) {
  case usage_tailer.start(run_id, config, db, pubsub_subject, bc) {
    Ok(subject) -> Some(subject)
    Error(e) -> {
      wisp.log_warning(
        "run "
        <> int.to_string(run_id)
        <> " usage tailer failed to start: "
        <> actor_start_error_to_string(e),
      )
      None
    }
  }
}

@external(erlang, "erlang", "term_to_binary")
fn actor_start_error_to_binary(e: actor.StartError) -> BitArray

fn actor_start_error_to_string(e: actor.StartError) -> String {
  let bits = actor_start_error_to_binary(e)
  case bit_array.to_string(bits) {
    Ok(s) -> s
    Error(_) -> "unknown error"
  }
}

fn handle(state: State, msg: RunMsg) -> actor.Next(State, RunMsg) {
  case state.phase, msg {
    // ── Starting ─────────────────────────────────────────────────────────────
    Starting(bc), WorkerReady(cid, branch, cols, rows) ->
      transition_to_running(state, cid, branch, bc, cols, rows)
    Starting(bc), WorkerFailed(reason) ->
      transition_to_failed(state, bc, reason)
    Starting(bc), Cancel ->
      transition_to_failed(state, bc, "cancelled before start")
    Starting(bc), Subscribe(client) -> {
      process.send(bc, BroadcastSubscribe(client))
      send_snapshot(state, client, 80, 24)
      actor.continue(State(..state, listener_count: state.listener_count + 1))
    }
    Starting(bc), Unsubscribe(client) -> {
      process.send(bc, BroadcastUnsubscribe(client))
      actor.continue(
        State(..state, listener_count: int.max(0, state.listener_count - 1)),
      )
    }

    // ── Running ──────────────────────────────────────────────────────────────
    Running(_, _, bc, cols, rows), Subscribe(client) -> {
      process.send(bc, BroadcastSubscribe(client))
      send_snapshot(state, client, cols, rows)
      actor.continue(State(..state, listener_count: state.listener_count + 1))
    }
    Running(_, _, bc, _, _), Unsubscribe(client) -> {
      process.send(bc, BroadcastUnsubscribe(client))
      actor.continue(
        State(..state, listener_count: int.max(0, state.listener_count - 1)),
      )
    }
    Running(_, _, _, _, _), WriteStdin(bytes) -> {
      case state.stdin_sock {
        None -> Nil
        Some(sock) -> {
          let _ = docker.send_bytes(sock, bytes)
          Nil
        }
      }
      actor.continue(state)
    }
    Running(cid, branch, bc, _, _), Resize(cols, rows) -> {
      case docker.connect(state.config.docker_socket) {
        Ok(sock) -> {
          let _ = docker.resize_container(sock, cid, cols, rows)
          docker.close(sock)
        }
        Error(e) ->
          wisp.log_warning(
            "run "
            <> int.to_string(state.run_id)
            <> " resize failed: "
            <> docker.describe_error(e),
          )
      }
      actor.continue(
        State(..state, phase: Running(cid, branch, bc, cols, rows)),
      )
    }
    Running(_, _, bc, _, _), AgentStatusChanged(status) -> {
      let _ = runs_db.mark_state(state.db, state.run_id, status, now_ms())
      process.send(bc, BroadcastEvent(StateChanged(status)))
      actor.continue(state)
    }
    Running(cid, _, bc, _, _), ContainerExited(outcome) ->
      transition_to_waiting(state, cid, bc, outcome)
    Running(cid, _, _, _, _), Cancel -> {
      case docker.connect(state.config.docker_socket) {
        Ok(sock) -> {
          let _ = docker.kill_container(sock, cid)
          docker.close(sock)
        }
        Error(e) ->
          wisp.log_warning(
            "run "
            <> int.to_string(state.run_id)
            <> " cancel connect failed: "
            <> docker.describe_error(e),
          )
      }
      actor.continue(state)
    }

    // ── Waiting ──────────────────────────────────────────────────────────────
    Waiting(_, bc), Subscribe(client) -> {
      process.send(bc, BroadcastSubscribe(client))
      send_snapshot(state, client, 80, 24)
      actor.continue(State(..state, listener_count: state.listener_count + 1))
    }
    Waiting(outcome, bc), Unsubscribe(client) -> {
      process.send(bc, BroadcastUnsubscribe(client))
      let new_count = state.listener_count - 1
      case new_count <= 0 {
        True -> transition_to_finishing(state, bc, outcome, "")
        False -> actor.continue(State(..state, listener_count: new_count))
      }
    }
    Waiting(outcome, bc), WaitingTimeout ->
      transition_to_finishing(state, bc, outcome, "")

    // ── Terminal phases ───────────────────────────────────────────────────────
    Done(_), _ -> actor.continue(state)
    Failed(_), _ -> actor.continue(state)
    Finishing(_), _ -> actor.continue(state)

    // ── Shutdown ─────────────────────────────────────────────────────────────
    _, Shutdown -> actor.stop()

    // ── Catch-all ────────────────────────────────────────────────────────────
    _, _ -> actor.continue(state)
  }
}

// ── Transitions ──────────────────────────────────────────────────────────────

fn transition_to_running(
  state: State,
  cid: String,
  branch: String,
  bc: Subject(BroadcastMsg),
  cols: Int,
  rows: Int,
) -> actor.Next(State, RunMsg) {
  wisp.log_info(
    "run "
    <> int.to_string(state.run_id)
    <> " running container="
    <> cid
    <> " branch="
    <> branch,
  )
  let _ = runs_db.mark_running(state.db, state.run_id, cid, now_ms())
  process.send(bc, BroadcastEvent(StateChanged("running")))
  let stdin_sock = case
    container_monitor.start(
      state.config,
      cid,
      state.run_id,
      state.actor_subject,
      bc,
    )
  {
    Ok(sock) -> Some(sock)
    Error(e) -> {
      wisp.log_warning(
        "run "
        <> int.to_string(state.run_id)
        <> " attach failed: "
        <> docker.describe_error(e),
      )
      None
    }
  }
  let tailer =
    start_tailer(state.run_id, state.config, state.db, state.pubsub, bc)
  actor.continue(
    State(
      ..state,
      phase: Running(cid, branch, bc, cols, rows),
      stdin_sock: stdin_sock,
      tailer: tailer,
    ),
  )
}

fn transition_to_waiting(
  state: State,
  cid: String,
  bc: Subject(BroadcastMsg),
  outcome: RunOutcome,
) -> actor.Next(State, RunMsg) {
  wisp.log_info(
    "run "
    <> int.to_string(state.run_id)
    <> " finished exit_code="
    <> int.to_string(outcome.exit_code),
  )
  let db_outcome =
    runs_db.RunOutcome(
      exit_code: outcome.exit_code,
      branch_pushed: outcome.branch_pushed,
      head_commit: outcome.head_commit,
      title: outcome.title,
      error_message: outcome.error_message,
      claude_session_id: outcome.claude_session_id,
    )
  let _ = runs_db.mark_finished(state.db, state.run_id, db_outcome, now_ms())
  let final_state = case outcome.exit_code {
    0 -> "succeeded"
    _ -> "failed"
  }
  process.send(bc, BroadcastEvent(StateChanged(final_state)))
  case state.listener_count {
    0 -> transition_to_finishing(state, bc, outcome, cid)
    _ -> {
      process.send_after(state.actor_subject, 300_000, WaitingTimeout)
      actor.continue(State(..state, phase: Waiting(outcome, bc)))
    }
  }
}

fn transition_to_finishing(
  state: State,
  bc: Subject(BroadcastMsg),
  outcome: RunOutcome,
  cid: String,
) -> actor.Next(State, RunMsg) {
  wisp.log_debug("run " <> int.to_string(state.run_id) <> " cleaning up")
  // Stop the tailer so it does a final sweep before the run dir is cleaned
  case state.tailer {
    None -> Nil
    Some(t) -> process.send(t, usage_tailer.Stop)
  }
  process.send(bc, BroadcastShutdown)
  process.send(state.registry, Unregister(state.run_id))
  case state.stdin_sock {
    None -> Nil
    Some(sock) -> docker.close(sock)
  }
  case cid {
    "" -> Nil
    id -> {
      case docker.connect(state.config.docker_socket) {
        Ok(sock) -> {
          let _ = docker.remove_container(sock, id, True)
          docker.close(sock)
        }
        Error(e) ->
          wisp.log_warning(
            "run "
            <> int.to_string(state.run_id)
            <> " remove container failed: "
            <> docker.describe_error(e),
          )
      }
    }
  }
  actor.continue(State(..state, phase: Done(outcome), stdin_sock: None))
}

fn transition_to_failed(
  state: State,
  bc: Subject(BroadcastMsg),
  reason: String,
) -> actor.Next(State, RunMsg) {
  wisp.log_error("run " <> int.to_string(state.run_id) <> " failed: " <> reason)
  let _ = runs_db.mark_failed(state.db, state.run_id, reason, now_ms())
  // Surface the failure reason in the run terminal so users see *why*
  // a run failed without having to dig through server logs or the DB.
  // Red ANSI prefix matches the styled output in supervisor.sh.
  let formatted = "\n\u{001b}[31m✕ " <> reason <> "\u{001b}[0m\n"
  process.send(bc, BroadcastChunk(bit_array.from_string(formatted)))
  process.send(bc, BroadcastEvent(StateChanged("failed")))
  process.send(state.registry, Unregister(state.run_id))
  actor.continue(State(..state, phase: Failed(reason)))
}

fn send_snapshot(
  state: State,
  client: Subject(TerminalEvent),
  cols: Int,
  rows: Int,
) -> Nil {
  let offset = transcript_size(state.config, state.run_id)
  process.send(
    client,
    Snapshot(ansi: "", cols: cols, rows: rows, byte_offset: offset),
  )
}

fn transcript_size(config: Config, run_id: Int) -> Int {
  let path =
    config.runs_dir <> "/" <> int.to_string(run_id) <> "/transcript.log"
  case simplifile.file_info(path) {
    Ok(info) -> info.size
    Error(_) -> 0
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
