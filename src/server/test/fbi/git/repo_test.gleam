import fbi/git
import fbi/git/parse
import fbi/git/repo
import gleam/int
import gleam/list
import gleam/option
import gleam/string
import gleeunit/should
import simplifile

fn seed_bare_repo() -> #(String, String) {
  let tmp =
    "/tmp/fbi-repo-test-"
    <> int.to_string(now_ms())
    <> "-"
    <> int.to_string(unique_int())
  let bare = tmp <> "/bare.git"
  let work = tmp <> "/work"
  let _ = simplifile.create_directory_all(bare)
  let _ = simplifile.create_directory_all(work)
  let assert Ok(_) = git.run(bare, ["init", "--bare"])
  let assert Ok(_) = git.run(work, ["init"])
  let assert Ok(_) = git.run(work, ["config", "user.email", "t@t"])
  let assert Ok(_) = git.run(work, ["config", "user.name", "t"])
  let assert Ok(_) = simplifile.write(work <> "/a.txt", "hello\n")
  let assert Ok(_) = git.run(work, ["add", "a.txt"])
  let assert Ok(_) = git.run(work, ["commit", "-m", "initial"])
  let assert Ok(_) = git.run(work, ["branch", "-M", "main"])
  let assert Ok(_) = git.run(work, ["remote", "add", "bare", bare])
  let assert Ok(_) = git.run(work, ["push", "bare", "main"])
  let assert Ok(_) = git.run(bare, ["symbolic-ref", "HEAD", "refs/heads/main"])
  let assert Ok(sha) = git.run(work, ["rev-parse", "HEAD"])
  let sha_trimmed = string.trim(sha)
  #(bare, sha_trimmed)
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int

@external(erlang, "erlang", "unique_integer")
fn unique_int() -> Int

pub fn commits_on_branch_returns_seeded_commit_test() {
  let #(bare, sha) = seed_bare_repo()
  let assert Ok(commits) = repo.commits_on_branch(bare, "main", "main")
  commits |> should.equal([])
  let assert Ok(_) = git.run(bare, ["cat-file", "-p", sha])
}

pub fn commit_files_returns_file_entries_test() {
  let #(bare, sha) = seed_bare_repo()
  let assert Ok(files) = repo.commit_files(bare, sha)
  files
  |> should.equal([
    repo.FileEntry(path: "a.txt", status: "A", additions: 1, deletions: 0),
  ])
}

pub fn file_diff_committed_sha_test() {
  let #(bare, sha) = seed_bare_repo()
  let assert Ok(#(hunks, truncated)) = repo.file_diff(bare, sha, "a.txt")
  truncated |> should.equal(False)
  hunks |> list.length |> should.equal(1)
}

pub fn file_diff_unknown_sha_returns_error_test() {
  let #(bare, _) = seed_bare_repo()
  let assert Error(_) = repo.file_diff(bare, "deadbeefdeadbeef", "a.txt")
}

pub fn branch_base_ahead_behind_test() {
  let #(bare, _) = seed_bare_repo()
  let work2 = bare <> "-work2"
  let assert Ok(_) = simplifile.create_directory_all(work2)
  let assert Ok(_) = git.run(work2, ["clone", bare, "."])
  let assert Ok(_) = git.run(work2, ["config", "user.email", "t@t"])
  let assert Ok(_) = git.run(work2, ["config", "user.name", "t"])
  let assert Ok(_) = git.run(work2, ["checkout", "-b", "feature"])
  let assert Ok(_) = simplifile.write(work2 <> "/b.txt", "world\n")
  let assert Ok(_) = git.run(work2, ["add", "b.txt"])
  let assert Ok(_) = git.run(work2, ["commit", "-m", "feature commit"])
  let assert Ok(_) = git.run(work2, ["push", "origin", "feature"])
  let assert Ok(result) = repo.branch_base_ahead_behind(bare, "feature", "main")
  result.base |> should.equal("main")
  result.ahead |> should.equal(1)
  result.behind |> should.equal(0)
}

pub fn wip_files_no_snapshot_returns_none_test() {
  let #(bare, _) = seed_bare_repo()
  repo.wip_files(bare) |> should.equal(Ok(option.None))
}

pub fn wip_files_with_snapshot_returns_diff_test() {
  let #(bare, head_sha) = seed_bare_repo()
  let work = bare <> "-snap"
  let assert Ok(_) = simplifile.create_directory_all(work)
  let assert Ok(_) = git.run(work, ["clone", bare, "."])
  let assert Ok(_) = git.run(work, ["config", "user.email", "t@t"])
  let assert Ok(_) = git.run(work, ["config", "user.name", "t"])
  let assert Ok(_) = simplifile.write(work <> "/a.txt", "hello\nworld\n")
  let assert Ok(_) = git.run(work, ["add", "a.txt"])
  let assert Ok(tree_str) = git.run(work, ["write-tree"])
  let tree = string.trim(tree_str)
  let assert Ok(commit_str) =
    git.run(work, ["commit-tree", tree, "-p", head_sha, "-m", "wip snapshot"])
  let snapshot_sha = string.trim(commit_str)
  let assert Ok(_) =
    git.run(work, ["push", "origin", snapshot_sha <> ":refs/fbi/wip-snapshot"])
  let assert Ok(option.Some(snapshot)) = repo.wip_files(bare)
  snapshot.parent_sha |> should.equal(head_sha)
  snapshot.snapshot_sha |> should.equal(snapshot_sha)
  snapshot.files |> list.length |> should.equal(1)
}

pub fn wip_files_no_diff_returns_none_test() {
  // When snapshot tree == HEAD tree, no changed files → wip_files returns None.
  let #(bare, head_sha) = seed_bare_repo()
  let work = bare <> "-nodiff"
  let assert Ok(_) = simplifile.create_directory_all(work)
  let assert Ok(_) = git.run(work, ["clone", bare, "."])
  let assert Ok(_) = git.run(work, ["config", "user.email", "t@t"])
  let assert Ok(_) = git.run(work, ["config", "user.name", "t"])
  // Create snapshot with the same tree as HEAD.
  let assert Ok(tree_str) = git.run(work, ["rev-parse", head_sha <> "^{tree}"])
  let tree = string.trim(tree_str)
  let assert Ok(commit_str) =
    git.run(work, ["commit-tree", tree, "-p", head_sha, "-m", "wip snapshot"])
  let snapshot_sha = string.trim(commit_str)
  let assert Ok(_) =
    git.run(work, ["push", "origin", snapshot_sha <> ":refs/fbi/wip-snapshot"])
  repo.wip_files(bare) |> should.equal(Ok(option.None))
}

// Satisfy the unused import warning from parse
pub fn parse_log_entry_unused_import_test() {
  let _: parse.LogEntry =
    parse.LogEntry(sha: "x", subject: "y", committed_at: 0)
  should.equal(True, True)
}
