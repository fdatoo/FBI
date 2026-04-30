import gleam/list

pub type GitError {
  ExitNonZero(exit_code: Int, output: String)
  GitUnavailable
}

/// Shell out to `git -C repo_path <args...>`. Returns combined stdout+stderr
/// on exit 0, ExitNonZero with the same on any other exit, or GitUnavailable
/// if the git binary can't be found in PATH.
pub fn run(repo_path: String, args: List(String)) -> Result(String, GitError) {
  case resolved_git() {
    Error(_) -> Error(GitUnavailable)
    Ok(git_path) -> {
      let full_args = list.append(["-C", repo_path], args)
      let #(code, output) = fbi_cmd_run(git_path, full_args, [])
      case code {
        0 -> Ok(output)
        _ -> Error(ExitNonZero(code, output))
      }
    }
  }
}

pub fn describe_error(e: GitError) -> String {
  case e {
    ExitNonZero(code, output) ->
      "git exit " <> int_to_string(code) <> ": " <> output
    GitUnavailable -> "git not available on PATH"
  }
}

fn resolved_git() -> Result(String, Nil) {
  let resolved = fbi_cmd_find_executable("git")
  // fbi_cmd:find_executable returns the input unchanged when not found.
  case resolved {
    "git" -> Error(Nil)
    p -> Ok(p)
  }
}

@external(erlang, "fbi_cmd", "run")
fn fbi_cmd_run(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
) -> #(Int, String)

@external(erlang, "fbi_cmd", "find_executable")
fn fbi_cmd_find_executable(name: String) -> String

@external(erlang, "erlang", "integer_to_binary")
fn int_to_string(i: Int) -> String
