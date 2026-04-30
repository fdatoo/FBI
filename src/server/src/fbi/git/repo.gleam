import fbi/git.{type GitError}
import fbi/git/parse
import gleam/dict
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

pub type FileEntry {
  FileEntry(path: String, status: String, additions: Int, deletions: Int)
}

pub type BranchBase {
  BranchBase(base: String, ahead: Int, behind: Int)
}

pub type WipSnapshot {
  WipSnapshot(snapshot_sha: String, parent_sha: String, files: List(FileEntry))
}

const empty_tree_sha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const diff_byte_cap = 1_048_576

pub fn commits_on_branch(
  repo_path: String,
  branch: String,
  base: String,
) -> Result(List(parse.LogEntry), GitError) {
  use output <- result_map(
    git.run(repo_path, [
      "log",
      base <> ".." <> branch,
      "--pretty=format:%H%x00%s%x00%ct",
    ]),
  )
  parse.parse_log_porcelain(output)
}

pub fn commit_files(
  repo_path: String,
  sha: String,
) -> Result(List(FileEntry), GitError) {
  use ns_output <- result_try(
    git.run(repo_path, [
      "show",
      "--no-renames",
      "--pretty=",
      "--name-status",
      sha,
    ]),
  )
  use num_output <- result_try(
    git.run(repo_path, ["show", "--no-renames", "--pretty=", "--numstat", sha]),
  )
  let names = parse.parse_name_status(ns_output)
  let nums = parse.parse_numstat(num_output)
  Ok(merge_names_and_nums(names, nums))
}

pub fn file_diff(
  repo_path: String,
  sha: String,
  path: String,
) -> Result(#(List(parse.Hunk), Bool), GitError) {
  let parent_arg = case has_parent(repo_path, sha) {
    True -> sha <> "^"
    False -> empty_tree_sha
  }
  use output <- result_try(
    git.run(repo_path, ["diff", "--no-color", parent_arg, sha, "--", path]),
  )
  let truncated = string.byte_size(output) > diff_byte_cap
  let body = case truncated {
    True -> string.slice(output, 0, diff_byte_cap)
    False -> output
  }
  Ok(#(parse.parse_diff_hunks(body), truncated))
}

pub fn branch_base_ahead_behind(
  repo_path: String,
  branch: String,
  default: String,
) -> Result(BranchBase, GitError) {
  use ahead_str <- result_try(
    git.run(repo_path, ["rev-list", "--count", default <> ".." <> branch]),
  )
  use behind_str <- result_try(
    git.run(repo_path, ["rev-list", "--count", branch <> ".." <> default]),
  )
  Ok(BranchBase(
    base: default,
    ahead: parse_int_first_line(ahead_str),
    behind: parse_int_first_line(behind_str),
  ))
}

pub fn wip_files(repo_path: String) -> Result(Option(WipSnapshot), GitError) {
  case git.run(repo_path, ["rev-parse", "--verify", "refs/fbi/wip-snapshot"]) {
    Error(_) -> Ok(None)
    Ok(snapshot_str) -> {
      let snapshot_sha = string.trim(snapshot_str)
      use parent_str <- result_try(
        git.run(repo_path, ["rev-parse", snapshot_sha <> "^"]),
      )
      let parent_sha = string.trim(parent_str)
      use ns_output <- result_try(
        git.run(repo_path, [
          "diff",
          "--no-renames",
          "--name-status",
          parent_sha,
          snapshot_sha,
        ]),
      )
      use num_output <- result_try(
        git.run(repo_path, [
          "diff",
          "--no-renames",
          "--numstat",
          parent_sha,
          snapshot_sha,
        ]),
      )
      let files =
        merge_names_and_nums(
          parse.parse_name_status(ns_output),
          parse.parse_numstat(num_output),
        )
      case files {
        [] -> Ok(None)
        _ ->
          Ok(
            Some(WipSnapshot(
              snapshot_sha: snapshot_sha,
              parent_sha: parent_sha,
              files: files,
            )),
          )
      }
    }
  }
}

pub fn wip_file_diff(
  repo_path: String,
  path: String,
) -> Result(Option(#(List(parse.Hunk), Bool, String, String)), GitError) {
  case wip_files(repo_path) {
    Ok(None) -> Ok(None)
    Error(e) -> Error(e)
    Ok(Some(snap)) -> {
      use output <- result_try(
        git.run(repo_path, [
          "diff",
          "--no-color",
          snap.parent_sha,
          snap.snapshot_sha,
          "--",
          path,
        ]),
      )
      let truncated = string.byte_size(output) > diff_byte_cap
      let body = case truncated {
        True -> string.slice(output, 0, diff_byte_cap)
        False -> output
      }
      Ok(
        Some(#(
          parse.parse_diff_hunks(body),
          truncated,
          snap.snapshot_sha,
          snap.parent_sha,
        )),
      )
    }
  }
}

pub fn wip_patch(repo_path: String) -> Result(String, GitError) {
  case wip_files(repo_path) {
    Error(e) -> Error(e)
    Ok(None) -> Ok("")
    Ok(Some(snap)) ->
      git.run(repo_path, ["diff", snap.parent_sha, snap.snapshot_sha])
  }
}

fn merge_names_and_nums(
  names: List(parse.NameStatus),
  nums: List(parse.NumStat),
) -> List(FileEntry) {
  let num_map =
    list.fold(nums, dict.new(), fn(m, n) { dict.insert(m, n.path, n) })
  list.map(names, fn(ns) {
    case dict.get(num_map, ns.path) {
      Ok(n) ->
        FileEntry(
          path: ns.path,
          status: ns.status,
          additions: n.additions,
          deletions: n.deletions,
        )
      Error(_) ->
        FileEntry(path: ns.path, status: ns.status, additions: 0, deletions: 0)
    }
  })
}

fn has_parent(repo_path: String, sha: String) -> Bool {
  case git.run(repo_path, ["rev-parse", "--verify", sha <> "^"]) {
    Ok(_) -> True
    Error(_) -> False
  }
}

fn parse_int_first_line(s: String) -> Int {
  s
  |> string.trim
  |> int.parse
  |> fn(r) {
    case r {
      Ok(n) -> n
      Error(_) -> 0
    }
  }
}

fn result_map(r: Result(a, e), f: fn(a) -> b) -> Result(b, e) {
  case r {
    Ok(v) -> Ok(f(v))
    Error(e) -> Error(e)
  }
}

fn result_try(r: Result(a, e), f: fn(a) -> Result(b, e)) -> Result(b, e) {
  case r {
    Ok(v) -> f(v)
    Error(e) -> Error(e)
  }
}
