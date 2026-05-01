import fbi/config.{type Config}
import fbi/docker
import fbi/run/types.{
  type BroadcastMsg, type RunMsg, type RunOutcome, AgentStatusChanged,
  BranchUpdated, BroadcastChunk, ContainerExited, RunOutcome, TitleUpdated,
}
import gleam/bit_array
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import simplifile
import wisp

/// Opens a bidirectional attach socket (stdin+stdout), spawns a reader process
/// that forwards output as BroadcastChunk and appends to the run's transcript
/// file, and spawns a process to wait for exit. Returns the attach socket so
/// the actor can write stdin.
pub fn start(
  config: Config,
  cid: String,
  run_id: Int,
  actor: Subject(RunMsg),
  broadcaster: Subject(BroadcastMsg),
) -> Result(docker.Socket, docker.DockerError) {
  use sock <- result.try(connect_and_attach(config, cid, run_id, broadcaster))
  wait_and_notify(config, cid, run_id, actor)
  Ok(sock)
}

fn connect_and_attach(
  config: Config,
  cid: String,
  run_id: Int,
  broadcaster: Subject(BroadcastMsg),
) -> Result(docker.Socket, docker.DockerError) {
  use sock <- result.try(docker.connect(config.docker_socket))
  case docker.start_bidirectional_attach(sock, cid) {
    Error(e) -> {
      docker.close(sock)
      Error(e)
    }
    Ok(initial_bytes) -> {
      let path = transcript_path(config, run_id)
      process.spawn_unlinked(fn() {
        // The file handle must be opened inside this process — Erlang's `raw`
        // file mode binds the handle to the opening process and rejects writes
        // from any other.
        let writer = case file_open(bit_array.from_string(path)) {
          Ok(handle) -> Some(handle)
          Error(reason) -> {
            wisp.log_warning(
              "transcript open failed " <> path <> ": " <> reason,
            )
            None
          }
        }
        let _ =
          docker.stream_raw_output(sock, initial_bytes, fn(chunk) {
            append_transcript(writer, chunk)
            process.send(broadcaster, BroadcastChunk(chunk))
          })
        close_transcript(writer)
      })
      Ok(sock)
    }
  }
}

fn transcript_path(config: Config, run_id: Int) -> String {
  config.runs_dir <> "/" <> int.to_string(run_id) <> "/transcript.log"
}

fn append_transcript(writer: Option(Dynamic), data: BitArray) -> Nil {
  case writer {
    None -> Nil
    Some(handle) -> {
      let _ = file_append(handle, data)
      Nil
    }
  }
}

fn close_transcript(writer: Option(Dynamic)) -> Nil {
  case writer {
    None -> Nil
    Some(handle) -> file_close(handle)
  }
}

@external(erlang, "fbi_file_writer", "open")
fn file_open(path: BitArray) -> Result(Dynamic, String)

@external(erlang, "fbi_file_writer", "append")
fn file_append(handle: Dynamic, data: BitArray) -> Result(Nil, String)

@external(erlang, "fbi_file_writer", "close")
fn file_close(handle: Dynamic) -> Nil

fn wait_and_notify(
  config: Config,
  cid: String,
  run_id: Int,
  actor: Subject(RunMsg),
) -> Nil {
  process.spawn_unlinked(fn() {
    let state_dir = config.runs_dir <> "/" <> int.to_string(run_id) <> "/state"
    let watcher_pid =
      process.spawn_unlinked(fn() {
        poll_status_loop("", "", "", state_dir, actor)
      })
    let exit_code = wait_for_exit(config, cid)
    process.kill(watcher_pid)
    let outcome = read_outcome(state_dir, exit_code)
    process.send(actor, ContainerExited(outcome))
    Nil
  })
  Nil
}

fn poll_status_loop(
  prev_status: String,
  prev_title: String,
  prev_branch: String,
  state_dir: String,
  actor: Subject(RunMsg),
) -> Nil {
  let next_status = case read_agent_status(state_dir) {
    Some(status) if status != prev_status -> {
      process.send(actor, AgentStatusChanged(status))
      status
    }
    Some(status) -> status
    None -> prev_status
  }
  let next_title = case read_state_file(state_dir <> "/title") {
    Some(title) if title != prev_title -> {
      process.send(actor, TitleUpdated(title))
      title
    }
    Some(title) -> title
    None -> prev_title
  }
  let next_branch = case read_state_file(state_dir <> "/branch-name") {
    Some(branch) if branch != prev_branch -> {
      process.send(actor, BranchUpdated(branch))
      branch
    }
    Some(branch) -> branch
    None -> prev_branch
  }
  process.sleep(500)
  poll_status_loop(next_status, next_title, next_branch, state_dir, actor)
}

/// Returns None if missing or empty — callers treat None as "no change."
pub fn read_agent_status(state_dir: String) -> Option(String) {
  read_state_file(state_dir <> "/agent-status")
}

fn read_state_file(path: String) -> Option(String) {
  case simplifile.read(path) {
    Ok(contents) ->
      case string.trim(contents) {
        "" -> None
        s -> Some(s)
      }
    Error(_) -> None
  }
}

fn wait_for_exit(config: Config, cid: String) -> Int {
  case docker.connect(config.docker_socket) {
    Ok(sock) -> {
      let code = case docker.wait_container(sock, cid) {
        Ok(c) -> c
        Error(e) -> {
          wisp.log_warning(
            "container_monitor: wait failed: " <> docker.describe_error(e),
          )
          -1
        }
      }
      docker.close(sock)
      code
    }
    Error(e) -> {
      wisp.log_warning(
        "container_monitor: docker connect: " <> docker.describe_error(e),
      )
      -1
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
        use title <- decode.optional_field("title", "", decode.string)
        decode.success(#(
          agent_exit,
          push_exit,
          head_sha,
          branch,
          session_id,
          title,
        ))
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
        Ok(#(agent_exit, push_exit, head_sha, branch, session_id, title)) ->
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
            title: case title {
              "" -> None
              t -> Some(t)
            },
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
