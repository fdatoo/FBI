import gleam/dict.{type Dict}
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import simplifile
import wisp

/// Sparse-clones the project repo to extract `.devcontainer/` files.
/// Returns Some(filename => contents) if devcontainer.json is present,
/// None if SSH auth sock is missing, repo URL is empty, clone fails,
/// or devcontainer.json does not exist.
pub fn fetch(
  repo_url: String,
  ssh_auth_sock: Option(String),
  on_log: fn(String) -> Nil,
) -> Option(Dict(String, String)) {
  case repo_url, ssh_auth_sock {
    "", _ -> None
    _, None -> None
    _, Some("") -> None
    url, Some(sock) -> do_fetch(url, sock, on_log)
  }
}

fn do_fetch(
  repo_url: String,
  ssh_auth_sock: String,
  on_log: fn(String) -> Nil,
) -> Option(Dict(String, String)) {
  let tmp_dir =
    "/tmp/fbi-dc-"
    <> int.to_string(now_ms())
    <> "-"
    <> int.to_string(unique_int())
  let env = [
    #("SSH_AUTH_SOCK", ssh_auth_sock),
    #("GIT_TERMINAL_PROMPT", "0"),
  ]
  let result = try_fetch(repo_url, tmp_dir, env, on_log)
  let _ = simplifile.delete(tmp_dir)
  result
}

fn try_fetch(
  repo_url: String,
  tmp_dir: String,
  env: List(#(String, String)),
  on_log: fn(String) -> Nil,
) -> Option(Dict(String, String)) {
  let git = find_executable("git")
  case
    run_cmd(
      git,
      [
        "clone", "--depth=1", "--filter=blob:none", "--sparse", "--no-tags",
        repo_url, tmp_dir,
      ],
      env,
    )
  {
    #(0, _) -> {
      case
        run_cmd(
          git,
          ["-C", tmp_dir, "sparse-checkout", "set", ".devcontainer"],
          env,
        )
      {
        #(0, _) -> {
          case run_cmd(git, ["-C", tmp_dir, "checkout"], env) {
            #(0, _) -> {
              let dc_dir = tmp_dir <> "/.devcontainer"
              case simplifile.is_file(dc_dir <> "/devcontainer.json") {
                Ok(True) -> {
                  on_log("[fbi] using repo .devcontainer/devcontainer.json\n")
                  read_dc_files(dc_dir)
                }
                _ -> {
                  wisp.log_debug(
                    "devcontainer_fetcher: no devcontainer.json in repo",
                  )
                  None
                }
              }
            }
            #(code, output) -> {
              let msg =
                "devcontainer_fetcher: git checkout failed (exit "
                <> int.to_string(code)
                <> "): "
                <> output
              wisp.log_warning(msg)
              on_log("[fbi] warning: " <> msg <> "\n")
              None
            }
          }
        }
        #(code, output) -> {
          let msg =
            "devcontainer_fetcher: sparse-checkout failed (exit "
            <> int.to_string(code)
            <> "): "
            <> output
          wisp.log_warning(msg)
          on_log("[fbi] warning: " <> msg <> "\n")
          None
        }
      }
    }
    #(code, output) -> {
      let msg =
        "devcontainer_fetcher: git clone failed (exit "
        <> int.to_string(code)
        <> "): "
        <> output
      wisp.log_warning(msg)
      on_log("[fbi] warning: " <> msg <> "\n")
      None
    }
  }
}

fn read_dc_files(dc_dir: String) -> Option(Dict(String, String)) {
  case simplifile.read_directory(dc_dir) {
    Error(_) -> None
    Ok(names) -> {
      let files =
        list.filter_map(names, fn(name) {
          let path = dc_dir <> "/" <> name
          case simplifile.is_file(path) {
            Ok(True) ->
              case simplifile.read(path) {
                Ok(content) -> Ok(#(name, content))
                Error(_) -> Error(Nil)
              }
            _ -> Error(Nil)
          }
        })
      Some(dict.from_list(files))
    }
  }
}

fn run_cmd(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
) -> #(Int, String) {
  fbi_cmd_run(cmd, args, env)
}

fn find_executable(name: String) -> String {
  fbi_cmd_find_executable(name)
}

@external(erlang, "fbi_cmd", "run")
fn fbi_cmd_run(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
) -> #(Int, String)

@external(erlang, "fbi_cmd", "find_executable")
fn fbi_cmd_find_executable(name: String) -> String

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int

@external(erlang, "erlang", "unique_integer")
fn unique_int() -> Int
