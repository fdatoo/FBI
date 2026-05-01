import fbi/config.{type Config}
import fbi/db/projects.{type Project}
import fbi/db/runs.{type Run}
import fbi/docker
import fbi/docker/tar
import fbi/run/devcontainer_fetcher
import fbi/run/image_builder
import fbi/run/types.{
  type BroadcastMsg, type RunMsg, BroadcastChunk, WorkerFailed, WorkerReady,
}
import gleam/bit_array
import gleam/dict
import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/float
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import simplifile
import wisp

pub type LaunchInput {
  LaunchInput(
    run: Run,
    project: Project,
    config: Config,
    cols: Int,
    rows: Int,
    broadcaster: Subject(BroadcastMsg),
    global_prompt: String,
    secrets: List(#(String, String)),
  )
}

/// Spawns an async task that performs Docker setup and reports back to `parent`.
pub fn launch(input: LaunchInput, parent: Subject(RunMsg)) -> Nil {
  process.spawn_unlinked(fn() {
    case do_launch(input) {
      Ok(#(cid, branch)) ->
        process.send(
          parent,
          WorkerReady(
            container_id: cid,
            branch: branch,
            cols: input.cols,
            rows: input.rows,
          ),
        )
      Error(reason) -> process.send(parent, WorkerFailed(reason))
    }
  })
  Nil
}

fn do_launch(input: LaunchInput) -> Result(#(String, String), String) {
  case input.run.mock {
    True -> do_mock_launch(input)
    False -> do_real_launch(input)
  }
}

fn do_real_launch(input: LaunchInput) -> Result(#(String, String), String) {
  let run_id = int.to_string(input.run.id)
  let on_log = fn(chunk: String) {
    process.send(
      input.broadcaster,
      BroadcastChunk(bit_array.from_string(chunk)),
    )
  }
  wisp.log_debug("run " <> run_id <> ": fetching devcontainer files")
  let dc_files =
    devcontainer_fetcher.fetch(
      input.project.repo_url,
      input.config.ssh_auth_sock,
      on_log,
    )
  wisp.log_debug("run " <> run_id <> ": resolving image")
  use image_tag <- result.try(image_builder.resolve(
    input.run.project_id,
    dc_files,
    input.project.devcontainer_override_json,
    input.config,
    on_log,
  ))
  use _ <- result.try(setup_run_dir(input))
  let container_name = "fbi-run-" <> run_id
  // Remove any pre-existing container with this name. Cancel paths and
  // crash recovery don't always reach transition_to_finishing (which is
  // the only place that calls remove_container), so retrying the same
  // run id otherwise hits a "container name in use" error from Docker.
  // force=true also handles the case where it's still running.
  let _ =
    with_docker(input.config.docker_socket, fn(sock) {
      docker.remove_container(sock, container_name, True)
    })
  let spec = container_spec(input, image_tag)
  wisp.log_debug("run " <> run_id <> ": creating container image=" <> image_tag)
  use cid <- result.try(
    with_docker(input.config.docker_socket, fn(sock) {
      docker.create_container(sock, spec, container_name)
    })
    |> result.map_error(fn(e) { "create_container: " <> e }),
  )
  let files = build_preamble(input)
  wisp.log_debug("run " <> run_id <> ": uploading preamble to " <> cid)
  use _ <- result.try(
    with_docker(input.config.docker_socket, fn(sock) {
      docker.upload_archive(sock, cid, "/fbi/", tar.build(files))
    })
    |> result.map_error(fn(e) { "upload_archive: " <> e }),
  )
  wisp.log_debug("run " <> run_id <> ": starting container " <> cid)
  use _ <- result.try(
    with_docker(input.config.docker_socket, fn(sock) {
      docker.start_container(sock, cid)
    })
    |> result.map_error(fn(e) { "start_container: " <> e }),
  )
  wisp.log_info("run " <> run_id <> ": container ready cid=" <> cid)
  Ok(#(cid, input.run.branch_name))
}

fn do_mock_launch(input: LaunchInput) -> Result(#(String, String), String) {
  let run_id = int.to_string(input.run.id)
  let scenario = option.unwrap(input.run.mock_scenario, "default")
  use quantico_path <- result.try(case input.config.quantico_binary_path {
    Some(p) -> Ok(p)
    None -> Error("FBI_QUANTICO_BINARY_PATH not set; mock runs require it")
  })
  use _ <- result.try(setup_run_dir(input))
  let container_name = "fbi-run-" <> run_id
  let _ =
    with_docker(input.config.docker_socket, fn(sock) {
      docker.remove_container(sock, container_name, True)
    })
  let spec = mock_container_spec(input, quantico_path, scenario)
  wisp.log_debug(
    "run " <> run_id <> ": creating mock container scenario=" <> scenario,
  )
  use cid <- result.try(
    with_docker(input.config.docker_socket, fn(sock) {
      docker.create_container(sock, spec, container_name)
    })
    |> result.map_error(fn(e) { "create_container: " <> e }),
  )
  use _ <- result.try(
    with_docker(input.config.docker_socket, fn(sock) {
      docker.start_container(sock, cid)
    })
    |> result.map_error(fn(e) { "start_container: " <> e }),
  )
  wisp.log_info("run " <> run_id <> ": mock container ready cid=" <> cid)
  Ok(#(cid, input.run.branch_name))
}

fn mock_container_spec(
  input: LaunchInput,
  quantico_path: String,
  scenario: String,
) -> json.Json {
  let run_id = int.to_string(input.run.id)
  let run_dir = input.config.runs_dir <> "/" <> run_id
  // Touch /fbi-state/ready before running quantico so container_monitor
  // sees the container as started. exec replaces the shell so the
  // container's PID 1 is quantico and its exit code is the run exit code.
  let entrypoint =
    "mkdir -p /fbi-state"
    <> " && touch /fbi-state/ready"
    <> " && if [ -n \"$FBI_RESUME_SESSION_ID\" ]; then"
    <> " exec /usr/local/bin/quantico --scenario $MOCK_CLAUDE_SCENARIO --dangerously-skip-permissions --resume \"$FBI_RESUME_SESSION_ID\";"
    <> " else exec /usr/local/bin/quantico --scenario $MOCK_CLAUDE_SCENARIO --dangerously-skip-permissions; fi"
  let env =
    list.append(build_env(input), [
      "MOCK_CLAUDE_SCENARIO=" <> scenario,
      // Run scenarios at 10× speed so CI timeouts are never close.
      "MOCK_CLAUDE_SPEED_MULT=10.0",
    ])
  json.object([
    #("Image", json.string("ubuntu:24.04")),
    #("User", json.string("0")),
    #("Env", json.array(env, json.string)),
    #("Tty", json.bool(True)),
    #("OpenStdin", json.bool(True)),
    #("StdinOnce", json.bool(False)),
    #("Entrypoint", json.array(["bash", "-c", entrypoint], json.string)),
    #(
      "HostConfig",
      json.object([
        #("AutoRemove", json.bool(False)),
        #(
          "Binds",
          json.array(
            [
              quantico_path <> ":/usr/local/bin/quantico:ro",
              run_dir <> "/state:/fbi-state:rw",
            ],
            json.string,
          ),
        ),
      ]),
    ),
  ])
}

fn with_docker(
  socket_path: String,
  f: fn(docker.Socket) -> Result(a, docker.DockerError),
) -> Result(a, String) {
  case docker.connect(socket_path) {
    Error(e) -> Error("connect: " <> docker.describe_error(e))
    Ok(sock) -> {
      let result = f(sock)
      docker.close(sock)
      result |> result.map_error(describe_err)
    }
  }
}

fn container_spec(input: LaunchInput, image_tag: String) -> json.Json {
  let env = build_env(input)
  let binds = build_binds(input)
  // Start as root so the entrypoint can chown the bind-mounted ssh-agent
  // socket to `agent` before dropping privileges. Docker Desktop's magic
  // ssh forwarder mounts the socket as root:root 660; without the chown
  // the agent user can't reach the host's keys.
  let entrypoint =
    "if [ -e /ssh-agent ]; then chown agent:agent /ssh-agent 2>/dev/null || true; fi; "
    <> "exec runuser -u agent -- /usr/local/bin/supervisor.sh"
  json.object([
    #("Image", json.string(image_tag)),
    #("User", json.string("0")),
    #("Env", json.array(env, json.string)),
    #("Tty", json.bool(True)),
    #("OpenStdin", json.bool(True)),
    #("StdinOnce", json.bool(False)),
    #("Entrypoint", json.array(["bash", "-c", entrypoint], json.string)),
    #(
      "HostConfig",
      json.object([
        #("AutoRemove", json.bool(False)),
        #("Memory", json.int(memory_bytes(input))),
        #("NanoCpus", json.int(nano_cpus(input))),
        #("PidsLimit", json.int(option.unwrap(input.project.pids_limit, 1024))),
        #("Binds", json.array(binds, json.string)),
      ]),
    ),
  ])
}

fn build_env(input: LaunchInput) -> List(String) {
  let base = [
    "RUN_ID=" <> int.to_string(input.run.id),
    "REPO_URL=" <> input.project.repo_url,
    "DEFAULT_BRANCH=" <> input.project.default_branch,
    "GIT_AUTHOR_NAME="
      <> option.unwrap(
      input.project.git_author_name,
      input.config.git_author_name,
    ),
    "GIT_AUTHOR_EMAIL="
      <> option.unwrap(
      input.project.git_author_email,
      input.config.git_author_email,
    ),
    "FBI_BRANCH=" <> input.run.branch_name,
    "FBI_KIND=" <> input.run.kind,
    "IS_SANDBOX=1",
  ]
  let with_model = list.append(base, model_env(input.run))
  let with_resume = case resume_session_id(input.run) {
    None -> with_model
    Some(sid) -> list.append(with_model, ["FBI_RESUME_SESSION_ID=" <> sid])
  }
  let plugins =
    list.append(
      input.config.default_plugins,
      parse_json_strings(input.project.plugins_json),
    )
  let with_plugins = case plugins {
    [] -> with_resume
    _ ->
      list.append(with_resume, ["FBI_PLUGINS=" <> string.join(plugins, "\n")])
  }
  let marketplaces =
    list.append(
      input.config.default_marketplaces,
      parse_json_strings(input.project.marketplaces_json),
    )
  let with_marketplaces = case marketplaces {
    [] -> with_plugins
    _ ->
      list.append(with_plugins, [
        "FBI_MARKETPLACES=" <> string.join(marketplaces, "\n"),
      ])
  }
  let secret_env =
    list.map(input.secrets, fn(s) {
      let #(name, value) = s
      name <> "=" <> value
    })
  list.append(with_marketplaces, secret_env)
}

fn parse_json_strings(json_str: String) -> List(String) {
  case json.parse(json_str, decode.list(decode.string)) {
    Ok(items) -> items
    Error(_) -> []
  }
}

fn resume_session_id(run: Run) -> option.Option(String) {
  case run.kind, run.kind_args_json {
    "continue", Some(json_str) -> {
      let dec = {
        use sid <- decode.field("session_id", decode.string)
        decode.success(sid)
      }
      case json.parse(json_str, dec) {
        Ok(sid) -> Some(sid)
        Error(_) -> None
      }
    }
    _, _ -> None
  }
}

fn model_env(run: Run) -> List(String) {
  [
    option.map(run.model, fn(m) { "ANTHROPIC_MODEL=" <> m }),
    option.map(run.effort, fn(e) { "CLAUDE_CODE_EFFORT_LEVEL=" <> e }),
    option.map(run.subagent_model, fn(m) { "CLAUDE_CODE_SUBAGENT_MODEL=" <> m }),
  ]
  |> list.filter_map(fn(o) {
    case o {
      Some(s) -> Ok(s)
      None -> Error(Nil)
    }
  })
}

fn build_binds(input: LaunchInput) -> List(String) {
  let runs_dir = input.config.runs_dir
  let run_dir = runs_dir <> "/" <> int.to_string(input.run.id)
  let base = [
    run_dir <> "/scripts/supervisor.sh:/usr/local/bin/supervisor.sh:ro",
    run_dir
      <> "/scripts/finalizeBranch.sh:/usr/local/bin/fbi-finalize-branch.sh:ro",
    run_dir <> "/scripts/fbi-history-op.sh:/usr/local/bin/fbi-history-op.sh:ro",
    run_dir
      <> "/scripts/wip-snapshotter.sh:/usr/local/bin/fbi-wip-snapshotter.sh:ro",
    run_dir
      <> "/scripts/polish-prompt.txt:/usr/local/share/fbi/polish-prompt.txt:ro",
    run_dir <> "/wip:/safeguard:rw",
    run_dir <> "/state:/fbi-state:rw",
    run_dir <> "/mount:/home/agent/.claude/projects/:rw",
    "/var/run/docker.sock:/var/run/docker.sock",
  ]
  let with_ssh = case input.config.ssh_auth_sock {
    Some(sock) -> list.append(base, [sock <> ":/ssh-agent"])
    None -> base
  }
  case input.config.claude_dir {
    Some(dir) -> list.append(with_ssh, claude_config_binds(dir))
    None -> with_ssh
  }
}

/// Build the claude-config bind list, including only files that exist on
/// the host as regular files. Docker auto-creates a missing bind source
/// as an empty *directory*, which silently breaks claude — e.g., the
/// OAuth login prompt fires every run because claude can't read its
/// token from a directory, and theme/trust/permission acks reset every
/// time because .claude.json isn't there.
///
/// On Linux production hosts these will all exist after the user logs
/// claude-code in once on the host. On macOS dev hosts, .credentials.json
/// won't exist (claude uses the keychain there) so we skip it; the user
/// will see the login prompt until that's solved separately.
fn claude_config_binds(dir: String) -> List(String) {
  // dir is typically /home/<user>/.claude. The top-level user config
  // (theme, trusted projects, permission acks, session metadata) lives
  // at /home/<user>/.claude.json — sibling of dir.
  let parent = path_dirname(dir)
  let file_binds =
    [
      #(
        dir <> "/.credentials.json",
        "/home/agent/.claude/.credentials.json",
        "rw",
      ),
      #(parent <> "/.claude.json", "/home/agent/.claude.json", "rw"),
      #(dir <> "/settings.json", "/home/agent/.claude/settings.json", "rw"),
    ]
    |> list.filter_map(fn(t) {
      let #(host, container, mode) = t
      case is_regular_file(host) {
        True -> Ok(host <> ":" <> container <> ":" <> mode)
        False -> Error(Nil)
      }
    })
  // settings.json may reference enabledPlugins whose hooks live in the
  // plugin cache. Mount it read-only so hooks register without needing
  // a re-install on every run. FBI_PLUGINS installs of plugins that are
  // already cached will be no-ops; plugins not yet cached should be
  // pre-installed on the host first so they land here.
  let plugin_binds = case is_regular_directory(dir <> "/plugins") {
    True -> [dir <> "/plugins:/home/agent/.claude/plugins:ro"]
    False -> []
  }
  list.append(file_binds, plugin_binds)
}

fn is_regular_file(path: String) -> Bool {
  case simplifile.is_file(path) {
    Ok(b) -> b
    Error(_) -> False
  }
}

fn is_regular_directory(path: String) -> Bool {
  case simplifile.is_directory(path) {
    Ok(b) -> b
    Error(_) -> False
  }
}

@external(erlang, "filename", "dirname")
fn path_dirname(path: String) -> String

fn build_preamble(input: LaunchInput) -> dict.Dict(String, BitArray) {
  let preamble =
    "# FBI Session Setup\n\n"
    <> "Before starting the task, run these two setup steps:\n\n"
    <> "1. Write a concise title (max 60 chars) describing this task:\n"
    <> "   echo 'Brief task title' > /fbi-state/title\n\n"
    <> "2. If your current branch starts with \"claude/run-\", rename it to a\n"
    <> "   short descriptive kebab-case name reflecting the task:\n"
    <> "   git branch -m feat/your-task-description\n"
    <> "   (Skip if the branch already has a meaningful name.)\n\n"
    <> "After the setup steps, proceed with the task."
  dict.from_list([
    #("preamble.txt", bit_array.from_string(preamble)),
    #("global.txt", bit_array.from_string(input.global_prompt)),
    #("prompt.txt", bit_array.from_string(input.run.prompt)),
    #(
      "instructions.txt",
      bit_array.from_string(option.unwrap(input.project.instructions, "")),
    ),
  ])
}

fn memory_bytes(input: LaunchInput) -> Int {
  option.unwrap(input.project.mem_mb, 4096) * 1024 * 1024
}

fn nano_cpus(input: LaunchInput) -> Int {
  let cpus = option.unwrap(input.project.cpus, 2.0)
  float.round(cpus *. 1_000_000_000.0)
}

fn setup_run_dir(input: LaunchInput) -> Result(Nil, String) {
  let run_dir = input.config.runs_dir <> "/" <> int.to_string(input.run.id)
  let scripts_dir = run_dir <> "/scripts"
  // Wipe stale per-run state from any previous launch with this run id —
  // a cancelled/retried run otherwise inherits the previous container's
  // transcript output, fbi-state signals, and safeguard mirror. We
  // intentionally preserve mount/ (claude session data needed for resume).
  let _ = simplifile.delete(run_dir <> "/transcript.log")
  let _ = simplifile.delete(run_dir <> "/state")
  let _ = simplifile.delete(run_dir <> "/wip")
  let _ = simplifile.delete(scripts_dir)
  use _ <- result.try(
    simplifile.create_directory_all(scripts_dir)
    |> result.map_error(fn(e) {
      "mkdir scripts: " <> simplifile.describe_error(e)
    }),
  )
  use _ <- result.try(copy_script(
    fbi_priv_path("static/supervisor.sh"),
    scripts_dir <> "/supervisor.sh",
  ))
  use _ <- result.try(copy_script(
    fbi_priv_path("static/finalizeBranch.sh"),
    scripts_dir <> "/finalizeBranch.sh",
  ))
  use _ <- result.try(copy_script(
    fbi_priv_path("static/fbi-history-op.sh"),
    scripts_dir <> "/fbi-history-op.sh",
  ))
  use _ <- result.try(copy_script(
    fbi_priv_path("static/wip-snapshotter.sh"),
    scripts_dir <> "/wip-snapshotter.sh",
  ))
  let polish_src = fbi_priv_path("static/polish-prompt.txt")
  let polish_dst = scripts_dir <> "/polish-prompt.txt"
  let _ = simplifile.copy_file(polish_src, polish_dst)
  case input.run.kind, resume_session_id(input.run) {
    "continue", Some(sid) ->
      seed_mount_for_session(input.config.runs_dir, run_dir, sid)
    _, _ -> Ok(Nil)
  }
}

// Locate the run whose mount/ contains <session_id>.jsonl and copy that
// mount tree here so `claude --resume <session_id>` finds its history.
//
// We scan ALL sibling run directories rather than just the direct parent
// because a chain of continue runs (A→B→B′→...) may have been created
// before this seeding logic existed — those intermediate mounts are empty
// even though the original JSONL is still present in the root run's mount/.
fn seed_mount_for_session(
  runs_dir: String,
  run_dir: String,
  session_id: String,
) -> Result(Nil, String) {
  let own_mount = run_dir <> "/mount"
  use _ <- result.try(
    simplifile.create_directory_all(own_mount)
    |> result.map_error(fn(e) {
      "mkdir mount: " <> simplifile.describe_error(e)
    }),
  )
  case find_session_mount(runs_dir, session_id) {
    None -> {
      wisp.log_warning(
        "resume: no mount found containing session " <> session_id,
      )
      Ok(Nil)
    }
    Some(src_mount) -> copy_mount_tree(src_mount, own_mount)
  }
}

// Walk runs_dir/<N>/{mount,claude-projects} looking for
// -workspace/<session_id>.jsonl. Checks both names because the legacy
// Elixir server used "claude-projects/" while the current server uses "mount/".
fn find_session_mount(
  runs_dir: String,
  session_id: String,
) -> option.Option(String) {
  case simplifile.read_directory(runs_dir) {
    Error(_) -> option.None
    Ok(run_ids) ->
      list.find_map(run_ids, fn(rid) {
        let run_dir = runs_dir <> "/" <> rid
        list.find_map(["mount", "claude-projects"], fn(dir_name) {
          let candidate = run_dir <> "/" <> dir_name
          let jsonl = candidate <> "/-workspace/" <> session_id <> ".jsonl"
          case simplifile.is_file(jsonl) {
            Ok(True) -> Ok(candidate)
            _ -> Error(Nil)
          }
        })
      })
      |> option.from_result
  }
}

// Copy a mount/ tree (one level of subdirectories) into dst/.
fn copy_mount_tree(src: String, dst: String) -> Result(Nil, String) {
  case simplifile.read_directory(src) {
    Error(_) -> Ok(Nil)
    Ok(entries) -> {
      list.each(entries, fn(name) {
        let s = src <> "/" <> name
        let d = dst <> "/" <> name
        case is_regular_directory(s) {
          True -> {
            let _ = simplifile.create_directory_all(d)
            case simplifile.read_directory(s) {
              Error(_) -> Nil
              Ok(files) ->
                list.each(files, fn(fname) {
                  let _ =
                    simplifile.copy_file(s <> "/" <> fname, d <> "/" <> fname)
                  Nil
                })
            }
          }
          False -> {
            let _ = simplifile.copy_file(s, d)
            Nil
          }
        }
      })
      Ok(Nil)
    }
  }
}

@external(erlang, "fbi_priv", "path")
fn fbi_priv_path(rel: String) -> String

fn copy_script(src: String, dst: String) -> Result(Nil, String) {
  use _ <- result.try(
    simplifile.copy_file(src, dst)
    |> result.map_error(fn(e) {
      "copy " <> src <> ": " <> simplifile.describe_error(e)
    }),
  )
  simplifile.set_permissions_octal(dst, 0o755)
  |> result.map_error(fn(e) {
    "chmod " <> dst <> ": " <> simplifile.describe_error(e)
  })
}

fn describe_err(e: docker.DockerError) -> String {
  case e {
    docker.ConnectError(s) -> "connect: " <> s
    docker.HttpError(code, msg) -> "http " <> int.to_string(code) <> ": " <> msg
    docker.DecodeError(s) -> "decode: " <> s
    docker.Timeout -> "timeout"
  }
}
