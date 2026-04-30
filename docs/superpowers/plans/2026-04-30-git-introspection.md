# Git Introspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real git introspection — committed history, file diffs, uncommitted (WIP), and the five HistoryOps — into the Gleam server, against the existing per-run bare repo at `{runs_dir}/{run_id}/wip`. Add a tiny in-container WIP-snapshot daemon so uncommitted state survives container exit.

**Architecture:** Three new server modules (`fbi/git.gleam` shell wrapper, `fbi/git/parse.gleam` text→records, `fbi/git/repo.gleam` domain ops) plus a `fbi/git/history_ops.gleam` for mutating ops, a per-run mutex actor, and a new `handlers/history.gleam`. The existing stub handlers for `/changes`, `/wip*`, `/file-diff`, `/commits/:sha/files` get replaced with real impls. A new bash daemon in `priv/static/wip-snapshotter.sh` snapshots the working tree to `refs/fbi/wip-snapshot` every 5s and pushes to safeguard.

**Tech Stack:** Gleam, Erlang FFI (`fbi_cmd:run/3`), bash (snapshot daemon), git CLI (host shell-out + `docker exec` for live working tree).

**Spec:** `docs/superpowers/specs/2026-04-30-git-introspection-design.md`

---

## File Structure

**New files:**
- `src/server/src/fbi/git.gleam` — single shell-out funnel
- `src/server/src/fbi/git/parse.gleam` — pure text→record parsers
- `src/server/src/fbi/git/repo.gleam` — domain ops against the bare repo
- `src/server/src/fbi/git/history_ops.gleam` — HistoryOp dispatch
- `src/server/src/fbi/git/mutex.gleam` — per-run lock actor
- `src/server/src/fbi/handlers/history.gleam` — `/history` POST handler
- `src/server/priv/static/wip-snapshotter.sh` — in-container daemon
- `src/server/priv/static/polish-prompt.txt` — polish prompt template
- `src/server/test/fbi/git/parse_test.gleam`
- `src/server/test/fbi/git/repo_test.gleam`
- `src/server/test/fbi/git/history_ops_test.gleam`

**Modified files:**
- `src/server/src/fbi/handlers/changes.gleam` — replace stubs
- `src/server/src/fbi/handlers/wip.gleam` — replace stubs
- `src/server/src/fbi/router.gleam` — wire new history handler, drop old `handle_history` arm
- `src/server/src/fbi/docker.gleam` — add `exec_container`
- `src/server/src/fbi/db/runs.gleam` — add `insert_polish_run`, `insert_merge_conflict_run`, `count_active_children`
- `src/server/src/fbi/run/worker.gleam` — bind snapshotter + polish-prompt files
- `src/server/priv/static/supervisor.sh` — start snapshotter; recognize `polish` and `merge-conflict` kinds
- `src/server/src/fbi/context.gleam` — add `history_mutex` field
- `src/server/src/fbi.gleam` — start mutex actor

---

## Task 1 — `fbi/git.gleam` shell-out wrapper

**Files:**
- Create: `src/server/src/fbi/git.gleam`
- Test: extend later in repo_test.gleam (this module is too thin to unit-test alone)

- [ ] **Step 1: Write the module**

```gleam
// src/server/src/fbi/git.gleam
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
```

- [ ] **Step 2: Build and verify**

```bash
cd src/server && gleam build
```
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/server/src/fbi/git.gleam
git commit -m "feat(git): add git.run shell-out wrapper"
```

---

## Task 2 — `parse.gleam` skeleton + `parse_log_porcelain`

**Files:**
- Create: `src/server/src/fbi/git/parse.gleam`
- Create: `src/server/test/fbi/git/parse_test.gleam`

The log porcelain format we use is `--pretty=format:%H%x00%s%x00%ct` with NUL field separators and `\n` record separators.

- [ ] **Step 1: Write the failing test**

```gleam
// src/server/test/fbi/git/parse_test.gleam
import fbi/git/parse
import gleeunit/should

pub fn parse_log_porcelain_two_commits_test() {
  let input =
    "abc123\u{0000}first commit\u{0000}1700000001\nde4567\u{0000}second commit\u{0000}1700000002\n"
  let parsed = parse.parse_log_porcelain(input)
  parsed
  |> should.equal([
    parse.LogEntry(sha: "abc123", subject: "first commit", committed_at: 1_700_000_001),
    parse.LogEntry(sha: "de4567", subject: "second commit", committed_at: 1_700_000_002),
  ])
}

pub fn parse_log_porcelain_empty_test() {
  parse.parse_log_porcelain("") |> should.equal([])
}

pub fn parse_log_porcelain_handles_nul_in_subject_test() {
  // Subjects can't contain NUL in practice, but malformed lines should be skipped.
  let input = "abc\u{0000}only-two-fields\nde4\u{0000}good\u{0000}1700000003\n"
  let parsed = parse.parse_log_porcelain(input)
  parsed
  |> should.equal([
    parse.LogEntry(sha: "de4", subject: "good", committed_at: 1_700_000_003),
  ])
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL — `parse` module does not exist.

- [ ] **Step 3: Create `parse.gleam` and implement**

```gleam
// src/server/src/fbi/git/parse.gleam
import gleam/int
import gleam/list
import gleam/result
import gleam/string

pub type LogEntry {
  LogEntry(sha: String, subject: String, committed_at: Int)
}

pub fn parse_log_porcelain(s: String) -> List(LogEntry) {
  string.split(s, "\n")
  |> list.filter_map(fn(line) {
    case line {
      "" -> Error(Nil)
      _ -> parse_log_line(line)
    }
  })
}

fn parse_log_line(line: String) -> Result(LogEntry, Nil) {
  case string.split(line, "\u{0000}") {
    [sha, subject, ts_str] -> {
      use ts <- result.try(int.parse(ts_str))
      Ok(LogEntry(sha: sha, subject: subject, committed_at: ts))
    }
    _ -> Error(Nil)
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd src/server && gleam test
```
Expected: all parse_log tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/parse.gleam src/server/test/fbi/git/parse_test.gleam
git commit -m "feat(git): add parse_log_porcelain"
```

---

## Task 3 — `parse_name_status` + `parse_numstat`

**Files:**
- Modify: `src/server/src/fbi/git/parse.gleam`
- Modify: `src/server/test/fbi/git/parse_test.gleam`

`git show --name-status --numstat <sha>` produces (after the commit header) two sections separated by blank lines: numstat lines `\d+\t\d+\t<path>` then name-status lines `[MADRU]\t<path>` (or `R100\told\tnew`). We'll parse each independently.

- [ ] **Step 1: Add failing tests**

Append to `parse_test.gleam`:

```gleam
pub fn parse_name_status_simple_test() {
  let input = "M\tsrc/foo.gleam\nA\tsrc/bar.gleam\nD\tsrc/baz.gleam\n"
  parse.parse_name_status(input)
  |> should.equal([
    parse.NameStatus(status: "M", path: "src/foo.gleam"),
    parse.NameStatus(status: "A", path: "src/bar.gleam"),
    parse.NameStatus(status: "D", path: "src/baz.gleam"),
  ])
}

pub fn parse_name_status_rename_test() {
  let input = "R100\told.txt\tnew.txt\n"
  parse.parse_name_status(input)
  |> should.equal([parse.NameStatus(status: "R", path: "new.txt")])
}

pub fn parse_numstat_simple_test() {
  let input = "10\t2\tsrc/a.gleam\n0\t5\tsrc/b.gleam\n"
  parse.parse_numstat(input)
  |> should.equal([
    parse.NumStat(additions: 10, deletions: 2, path: "src/a.gleam"),
    parse.NumStat(additions: 0, deletions: 5, path: "src/b.gleam"),
  ])
}

pub fn parse_numstat_binary_dashes_test() {
  // Binary files show "-" for both fields.
  let input = "-\t-\tlogo.png\n"
  parse.parse_numstat(input)
  |> should.equal([parse.NumStat(additions: 0, deletions: 0, path: "logo.png")])
}
```

- [ ] **Step 2: Verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `parse.gleam`:

```gleam
pub type NameStatus {
  NameStatus(status: String, path: String)
}

pub type NumStat {
  NumStat(additions: Int, deletions: Int, path: String)
}

pub fn parse_name_status(s: String) -> List(NameStatus) {
  string.split(s, "\n")
  |> list.filter_map(fn(line) {
    case line {
      "" -> Error(Nil)
      _ -> parse_name_status_line(line)
    }
  })
}

fn parse_name_status_line(line: String) -> Result(NameStatus, Nil) {
  case string.split(line, "\t") {
    [code, path] -> Ok(NameStatus(status: status_letter(code), path: path))
    [code, _old, new] -> Ok(NameStatus(status: status_letter(code), path: new))
    _ -> Error(Nil)
  }
}

fn status_letter(code: String) -> String {
  case string.first(code) {
    Ok(c) -> c
    Error(_) -> code
  }
}

pub fn parse_numstat(s: String) -> List(NumStat) {
  string.split(s, "\n")
  |> list.filter_map(fn(line) {
    case line {
      "" -> Error(Nil)
      _ -> parse_numstat_line(line)
    }
  })
}

fn parse_numstat_line(line: String) -> Result(NumStat, Nil) {
  case string.split(line, "\t") {
    [a, d, path] ->
      Ok(NumStat(
        additions: int.parse(a) |> result.unwrap(0),
        deletions: int.parse(d) |> result.unwrap(0),
        path: path,
      ))
    _ -> Error(Nil)
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd src/server && gleam test
```
Expected: all 4 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/parse.gleam src/server/test/fbi/git/parse_test.gleam
git commit -m "feat(git): add parse_name_status and parse_numstat"
```

---

## Task 4 — `parse_diff_hunks`

**Files:**
- Modify: `src/server/src/fbi/git/parse.gleam`
- Modify: `src/server/test/fbi/git/parse_test.gleam`

Unified-diff hunks: a header `@@ -L,N +L,N @@ <ctx>` followed by lines starting with ` ` (context), `+` (added), `-` (deleted). Lines starting with `\` (e.g. `\ No newline at end of file`) are ignored. Lines starting with `diff --git` / `---` / `+++` belong to the diff header above the hunks and are also ignored — we only care about the hunk content.

- [ ] **Step 1: Add failing test**

```gleam
pub fn parse_diff_hunks_one_hunk_test() {
  let input =
    "diff --git a/foo b/foo\n"
    <> "--- a/foo\n"
    <> "+++ b/foo\n"
    <> "@@ -1,3 +1,3 @@\n"
    <> " a\n"
    <> "-b\n"
    <> "+B\n"
    <> " c\n"
  let hunks = parse.parse_diff_hunks(input)
  hunks
  |> should.equal([
    parse.Hunk(header: "@@ -1,3 +1,3 @@", lines: [
      parse.Line(kind: "ctx", text: "a"),
      parse.Line(kind: "del", text: "b"),
      parse.Line(kind: "add", text: "B"),
      parse.Line(kind: "ctx", text: "c"),
    ]),
  ])
}

pub fn parse_diff_hunks_multiple_hunks_test() {
  let input =
    "@@ -1 +1 @@\n"
    <> "-a\n"
    <> "+b\n"
    <> "@@ -10 +10 @@ context tail\n"
    <> "-c\n"
    <> "+d\n"
  let hunks = parse.parse_diff_hunks(input)
  hunks
  |> list.length
  |> should.equal(2)
}

pub fn parse_diff_hunks_no_newline_marker_test() {
  let input =
    "@@ -1 +1 @@\n"
    <> "-a\n"
    <> "\\ No newline at end of file\n"
    <> "+b\n"
  let hunks = parse.parse_diff_hunks(input)
  let assert [hunk] = hunks
  hunk.lines
  |> should.equal([
    parse.Line(kind: "del", text: "a"),
    parse.Line(kind: "add", text: "b"),
  ])
}
```

Add `import gleam/list` (already present) and ensure `list` is in scope.

- [ ] **Step 2: Verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `parse.gleam`:

```gleam
pub type Line {
  Line(kind: String, text: String)
}

pub type Hunk {
  Hunk(header: String, lines: List(Line))
}

pub fn parse_diff_hunks(s: String) -> List(Hunk) {
  let lines = string.split(s, "\n")
  do_parse_hunks(lines, None, [], [])
  |> list.reverse
}

fn do_parse_hunks(
  remaining: List(String),
  current_header: option.Option(String),
  current_lines: List(Line),
  acc: List(Hunk),
) -> List(Hunk) {
  case remaining {
    [] ->
      case current_header {
        option.Some(h) -> [Hunk(header: h, lines: list.reverse(current_lines)), ..acc]
        option.None -> acc
      }
    [line, ..rest] ->
      case classify_line(line) {
        HunkHeader(h) -> {
          let acc2 = case current_header {
            option.Some(prev) -> [Hunk(header: prev, lines: list.reverse(current_lines)), ..acc]
            option.None -> acc
          }
          do_parse_hunks(rest, option.Some(h), [], acc2)
        }
        HunkLine(l) -> do_parse_hunks(rest, current_header, [l, ..current_lines], acc)
        Skip -> do_parse_hunks(rest, current_header, current_lines, acc)
      }
  }
}

type LineKind {
  HunkHeader(String)
  HunkLine(Line)
  Skip
}

fn classify_line(line: String) -> LineKind {
  case string.starts_with(line, "@@ ") {
    True -> HunkHeader(line)
    False ->
      case line {
        "" -> Skip
        _ ->
          case string.first(line) {
            Ok(" ") -> HunkLine(Line(kind: "ctx", text: drop_first(line)))
            Ok("+") -> {
              case string.starts_with(line, "+++ ") {
                True -> Skip
                False -> HunkLine(Line(kind: "add", text: drop_first(line)))
              }
            }
            Ok("-") -> {
              case string.starts_with(line, "--- ") {
                True -> Skip
                False -> HunkLine(Line(kind: "del", text: drop_first(line)))
              }
            }
            _ -> Skip
          }
      }
  }
}

fn drop_first(s: String) -> String {
  string.drop_start(s, 1)
}
```

Add `import gleam/option` to the imports if not already present.

- [ ] **Step 4: Verify tests pass**

```bash
cd src/server && gleam test
```
Expected: 3 new hunk tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/parse.gleam src/server/test/fbi/git/parse_test.gleam
git commit -m "feat(git): add parse_diff_hunks"
```

---

## Task 5 — `parse_status_porcelain_v2`

**Files:**
- Modify: `src/server/src/fbi/git/parse.gleam`
- Modify: `src/server/test/fbi/git/parse_test.gleam`

`git status --porcelain=v2 -z` is used by the `docker exec` path (sync/merge target detection, wip/discard verification). Format per record (NUL-terminated): `1 XY sub mH mI mW hH hI <path>` for ordinary entries, `2 XY ... <path>\u{0000}<orig>` for renames, `u XY ... <path>` for unmerged, `?<path>` for untracked. We only need path + status (XY) for v1.

- [ ] **Step 1: Add failing test**

```gleam
pub fn parse_status_porcelain_v2_basic_test() {
  let input =
    "1 .M N... 100644 100644 100644 abc def src/foo.gleam\u{0000}"
    <> "1 A. N... 000000 100644 100644 0000000 1234567 src/bar.gleam\u{0000}"
    <> "?untracked.txt\u{0000}"
  parse.parse_status_porcelain_v2(input)
  |> should.equal([
    parse.StatusEntry(status: "M", path: "src/foo.gleam"),
    parse.StatusEntry(status: "A", path: "src/bar.gleam"),
    parse.StatusEntry(status: "U", path: "untracked.txt"),
  ])
}

pub fn parse_status_porcelain_v2_rename_test() {
  let input =
    "2 R. N... 100644 100644 100644 abc def R100 new.txt\u{0000}old.txt\u{0000}"
  parse.parse_status_porcelain_v2(input)
  |> should.equal([parse.StatusEntry(status: "R", path: "new.txt")])
}
```

- [ ] **Step 2: Verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `parse.gleam`:

```gleam
pub type StatusEntry {
  StatusEntry(status: String, path: String)
}

pub fn parse_status_porcelain_v2(s: String) -> List(StatusEntry) {
  string.split(s, "\u{0000}")
  |> list.filter_map(parse_status_record)
}

fn parse_status_record(rec: String) -> Result(StatusEntry, Nil) {
  case rec {
    "" -> Error(Nil)
    _ ->
      case string.first(rec) {
        Ok("?") -> Ok(StatusEntry(status: "U", path: string.drop_start(rec, 1)))
        Ok("1") -> parse_v2_ordinary(rec)
        Ok("2") -> parse_v2_rename(rec)
        Ok("u") -> parse_v2_unmerged(rec)
        _ -> Error(Nil)
      }
  }
}

fn parse_v2_ordinary(rec: String) -> Result(StatusEntry, Nil) {
  // Format: "1 XY ... <path>"
  case string.split(rec, " ") {
    ["1", xy, ..rest] -> {
      let path = string.join(list.drop(rest, 6), " ")
      Ok(StatusEntry(status: status_xy(xy), path: path))
    }
    _ -> Error(Nil)
  }
}

fn parse_v2_rename(rec: String) -> Result(StatusEntry, Nil) {
  // Format: "2 XY ... <score> <path>" — the path is the new name.
  case string.split(rec, " ") {
    ["2", xy, ..rest] -> {
      let path = string.join(list.drop(rest, 7), " ")
      Ok(StatusEntry(status: status_xy(xy), path: path))
    }
    _ -> Error(Nil)
  }
}

fn parse_v2_unmerged(rec: String) -> Result(StatusEntry, Nil) {
  case string.split(rec, " ") {
    ["u", xy, ..rest] -> {
      let path = string.join(list.drop(rest, 7), " ")
      Ok(StatusEntry(status: status_xy(xy), path: path))
    }
    _ -> Error(Nil)
  }
}

/// XY is two characters: index status + worktree status. Take the first
/// non-`.` character as the effective status; default to the worktree slot.
fn status_xy(xy: String) -> String {
  case string.to_graphemes(xy) {
    [".", w, ..] -> w
    [i, _, ..] -> i
    _ -> "?"
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd src/server && gleam test
```
Expected: 2 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/parse.gleam src/server/test/fbi/git/parse_test.gleam
git commit -m "feat(git): add parse_status_porcelain_v2"
```

---

## Task 6 — `repo.gleam` skeleton + `commits_on_branch`

**Files:**
- Create: `src/server/src/fbi/git/repo.gleam`
- Create: `src/server/test/fbi/git/repo_test.gleam`

The repo tests use a real bare repo seeded inside a tmp directory.

- [ ] **Step 1: Add a seed helper + failing test**

```gleam
// src/server/test/fbi/git/repo_test.gleam
import fbi/git
import fbi/git/repo
import fbi/git/parse
import gleam/int
import gleam/list
import gleeunit/should
import simplifile

/// Create a tmp directory with a bare repo + a single seeded commit.
/// Returns the path to the bare repo and the sha of the seeded commit.
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
  let assert Ok(sha) = git.run(work, ["rev-parse", "HEAD"])
  let sha_trimmed = case list.first(string_split_lines(sha)) {
    Ok(s) -> s
    Error(_) -> sha
  }
  #(bare, sha_trimmed)
}

fn string_split_lines(s: String) -> List(String) {
  case s {
    "" -> []
    _ -> case list.first(simple_split(s, "\n")) {
      Ok(_) -> simple_split(s, "\n")
      Error(_) -> [s]
    }
  }
}

fn simple_split(s: String, sep: String) -> List(String) {
  // gleam_stdlib already provides string.split — alias for clarity here.
  string_split(s, sep)
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int

@external(erlang, "erlang", "unique_integer")
fn unique_int() -> Int

@external(erlang, "string", "split")
fn string_split(s: String, sep: String) -> List(String)

pub fn commits_on_branch_returns_seeded_commit_test() {
  let #(bare, sha) = seed_bare_repo()
  let assert Ok(commits) = repo.commits_on_branch(bare, "main", "main")
  // base==tip, so there should be no commits ahead.
  commits |> should.equal([])
  // Sanity: the sha exists in the bare repo.
  let assert Ok(_) = git.run(bare, ["cat-file", "-p", sha])
}
```

- [ ] **Step 2: Verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL — `repo` module does not exist.

- [ ] **Step 3: Create `repo.gleam`**

```gleam
// src/server/src/fbi/git/repo.gleam
import fbi/git.{type GitError}
import fbi/git/parse

pub fn commits_on_branch(
  repo_path: String,
  branch: String,
  base: String,
) -> Result(List(parse.LogEntry), GitError) {
  use output <- result_map(git.run(repo_path, [
    "log",
    base <> ".." <> branch,
    "--pretty=format:%H%x00%s%x00%ct",
  ]))
  parse.parse_log_porcelain(output)
}

fn result_map(
  r: Result(a, e),
  f: fn(a) -> b,
) -> Result(b, e) {
  case r {
    Ok(v) -> Ok(f(v))
    Error(e) -> Error(e)
  }
}
```

- [ ] **Step 4: Verify test passes**

```bash
cd src/server && gleam test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/repo.gleam src/server/test/fbi/git/repo_test.gleam
git commit -m "feat(git): add repo.commits_on_branch with bare-repo test fixture"
```

---

## Task 7 — `repo.commit_files`

**Files:**
- Modify: `src/server/src/fbi/git/repo.gleam`
- Modify: `src/server/test/fbi/git/repo_test.gleam`

Combines name-status + numstat into `FileEntry` records (additions/deletions per path).

- [ ] **Step 1: Add failing test**

```gleam
pub fn commit_files_returns_file_entries_test() {
  let #(bare, sha) = seed_bare_repo()
  let assert Ok(files) = repo.commit_files(bare, sha)
  // Initial commit added one file.
  files
  |> should.equal([
    repo.FileEntry(path: "a.txt", status: "A", additions: 1, deletions: 0),
  ])
}
```

- [ ] **Step 2: Verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `repo.gleam`:

```gleam
import gleam/dict
import gleam/list
import gleam/option.{type Option, None, Some}

pub type FileEntry {
  FileEntry(path: String, status: String, additions: Int, deletions: Int)
}

pub fn commit_files(
  repo_path: String,
  sha: String,
) -> Result(List(FileEntry), GitError) {
  // Use --pretty="" to suppress the commit message; combine name-status + numstat.
  use ns_output <- result_try(git.run(repo_path, [
    "show",
    "--no-renames",
    "--pretty=",
    "--name-status",
    sha,
  ]))
  use num_output <- result_try(git.run(repo_path, [
    "show",
    "--no-renames",
    "--pretty=",
    "--numstat",
    sha,
  ]))
  let names = parse.parse_name_status(ns_output)
  let nums = parse.parse_numstat(num_output)
  Ok(merge_names_and_nums(names, nums))
}

fn merge_names_and_nums(
  names: List(parse.NameStatus),
  nums: List(parse.NumStat),
) -> List(FileEntry) {
  let num_map =
    list.fold(nums, dict.new(), fn(m, n) { dict.insert(m, n.path, n) })
  list.map(names, fn(ns) {
    case dict.get(num_map, ns.path) {
      Ok(n) -> FileEntry(path: ns.path, status: ns.status, additions: n.additions, deletions: n.deletions)
      Error(_) -> FileEntry(path: ns.path, status: ns.status, additions: 0, deletions: 0)
    }
  })
}

fn result_try(r: Result(a, e), f: fn(a) -> Result(b, e)) -> Result(b, e) {
  case r {
    Ok(v) -> f(v)
    Error(e) -> Error(e)
  }
}
```

- [ ] **Step 4: Verify test passes**

```bash
cd src/server && gleam test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/repo.gleam src/server/test/fbi/git/repo_test.gleam
git commit -m "feat(git): add repo.commit_files"
```

---

## Task 8 — `repo.file_diff` for a committed sha

**Files:**
- Modify: `src/server/src/fbi/git/repo.gleam`
- Modify: `src/server/test/fbi/git/repo_test.gleam`

Returns `(hunks, truncated)` where `truncated` is True if the diff body exceeded 1MB before parsing.

- [ ] **Step 1: Add failing test**

```gleam
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
```

- [ ] **Step 2: Verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `repo.gleam`:

```gleam
import gleam/string

const empty_tree_sha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const diff_byte_cap = 1_048_576

pub fn file_diff(
  repo_path: String,
  sha: String,
  path: String,
) -> Result(#(List(parse.Hunk), Bool), GitError) {
  // Detect root commit: HEAD^ would error, so use empty-tree sentinel.
  let parent_arg = case has_parent(repo_path, sha) {
    True -> sha <> "^"
    False -> empty_tree_sha
  }
  use output <- result_try(git.run(repo_path, [
    "diff",
    "--no-color",
    parent_arg,
    sha,
    "--",
    path,
  ]))
  let truncated = string.byte_size(output) > diff_byte_cap
  let body = case truncated {
    True -> string.slice(output, 0, diff_byte_cap)
    False -> output
  }
  Ok(#(parse.parse_diff_hunks(body), truncated))
}

fn has_parent(repo_path: String, sha: String) -> Bool {
  case git.run(repo_path, ["rev-parse", "--verify", sha <> "^"]) {
    Ok(_) -> True
    Error(_) -> False
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd src/server && gleam test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/repo.gleam src/server/test/fbi/git/repo_test.gleam
git commit -m "feat(git): add repo.file_diff with empty-tree fallback for root commits"
```

---

## Task 9 — `repo.branch_base_ahead_behind`

**Files:**
- Modify: `src/server/src/fbi/git/repo.gleam`
- Modify: `src/server/test/fbi/git/repo_test.gleam`

- [ ] **Step 1: Add failing test**

```gleam
pub fn branch_base_ahead_behind_test() {
  let #(bare, _) = seed_bare_repo()
  // Add another commit on a feature branch via a fresh worktree.
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
  // Verify ahead=1, behind=0 against main.
  let assert Ok(result) = repo.branch_base_ahead_behind(bare, "feature", "main")
  result.base |> should.equal("main")
  result.ahead |> should.equal(1)
  result.behind |> should.equal(0)
}
```

- [ ] **Step 2: Verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `repo.gleam`:

```gleam
import gleam/int

pub type BranchBase {
  BranchBase(base: String, ahead: Int, behind: Int)
}

pub fn branch_base_ahead_behind(
  repo_path: String,
  branch: String,
  default: String,
) -> Result(BranchBase, GitError) {
  use ahead_str <- result_try(git.run(repo_path, [
    "rev-list",
    "--count",
    default <> ".." <> branch,
  ]))
  use behind_str <- result_try(git.run(repo_path, [
    "rev-list",
    "--count",
    branch <> ".." <> default,
  ]))
  Ok(BranchBase(
    base: default,
    ahead: parse_int_first_line(ahead_str),
    behind: parse_int_first_line(behind_str),
  ))
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
```

- [ ] **Step 4: Verify test passes**

```bash
cd src/server && gleam test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/repo.gleam src/server/test/fbi/git/repo_test.gleam
git commit -m "feat(git): add repo.branch_base_ahead_behind"
```

---

## Task 10 — `repo.wip_files` + `repo.wip_file_diff`

**Files:**
- Modify: `src/server/src/fbi/git/repo.gleam`
- Modify: `src/server/test/fbi/git/repo_test.gleam`

Reads `refs/fbi/wip-snapshot` and computes the diff against its parent.

- [ ] **Step 1: Add failing test**

```gleam
pub fn wip_files_no_snapshot_returns_none_test() {
  let #(bare, _) = seed_bare_repo()
  repo.wip_files(bare) |> should.equal(Ok(option.None))
}

pub fn wip_files_with_snapshot_returns_diff_test() {
  let #(bare, head_sha) = seed_bare_repo()
  // Create a synthetic snapshot commit whose tree differs from HEAD.
  // We do this by checking out a worktree, modifying a file, and using
  // commit-tree to produce a snapshot commit pointing at HEAD as parent.
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
```

- [ ] **Step 2: Verify failure**

```bash
cd src/server && gleam test
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `repo.gleam`:

```gleam
pub type WipSnapshot {
  WipSnapshot(snapshot_sha: String, parent_sha: String, files: List(FileEntry))
}

pub fn wip_files(repo_path: String) -> Result(Option(WipSnapshot), GitError) {
  case git.run(repo_path, ["rev-parse", "--verify", "refs/fbi/wip-snapshot"]) {
    Error(_) -> Ok(None)
    Ok(snapshot_str) -> {
      let snapshot_sha = string.trim(snapshot_str)
      use parent_str <- result_try(git.run(repo_path, [
        "rev-parse",
        snapshot_sha <> "^",
      ]))
      let parent_sha = string.trim(parent_str)
      use ns_output <- result_try(git.run(repo_path, [
        "diff",
        "--no-renames",
        "--name-status",
        parent_sha,
        snapshot_sha,
      ]))
      use num_output <- result_try(git.run(repo_path, [
        "diff",
        "--no-renames",
        "--numstat",
        parent_sha,
        snapshot_sha,
      ]))
      let files =
        merge_names_and_nums(
          parse.parse_name_status(ns_output),
          parse.parse_numstat(num_output),
        )
      case files {
        [] -> Ok(None)
        _ ->
          Ok(Some(WipSnapshot(
            snapshot_sha: snapshot_sha,
            parent_sha: parent_sha,
            files: files,
          )))
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
      use output <- result_try(git.run(repo_path, [
        "diff",
        "--no-color",
        snap.parent_sha,
        snap.snapshot_sha,
        "--",
        path,
      ]))
      let truncated = string.byte_size(output) > diff_byte_cap
      let body = case truncated {
        True -> string.slice(output, 0, diff_byte_cap)
        False -> output
      }
      Ok(Some(#(parse.parse_diff_hunks(body), truncated, snap.snapshot_sha, snap.parent_sha)))
    }
  }
}

pub fn wip_patch(repo_path: String) -> Result(String, GitError) {
  case wip_files(repo_path) {
    Error(e) -> Error(e)
    Ok(None) -> Ok("")
    Ok(Some(snap)) -> git.run(repo_path, ["diff", snap.parent_sha, snap.snapshot_sha])
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd src/server && gleam test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/repo.gleam src/server/test/fbi/git/repo_test.gleam
git commit -m "feat(git): add repo.wip_files / wip_file_diff / wip_patch"
```

---

## Task 11 — WIP snapshotter (in-container daemon)

**Files:**
- Create: `src/server/priv/static/wip-snapshotter.sh`
- Modify: `src/server/priv/static/supervisor.sh` (start daemon in background)
- Modify: `src/server/src/fbi/run/worker.gleam` (bind the script into the container)

- [ ] **Step 1: Write the daemon script**

```bash
#!/usr/bin/env bash
# /usr/local/bin/fbi-wip-snapshotter.sh — runs as agent inside FBI containers.
# Every 5s, snapshot the working tree as a synthetic git commit and push it
# to refs/fbi/wip-snapshot on the safeguard remote. Never touches HEAD,
# branch refs, or the agent's index.

set +e  # never exit; transient git errors during agent ops are normal

WORKTREE="${WORKTREE:-/workspace}"
INTERVAL="${WIP_SNAPSHOT_INTERVAL:-5}"

cd "$WORKTREE" 2>/dev/null || exit 0

while true; do
  sleep "$INTERVAL"
  # Skip if HEAD doesn't resolve yet (pre-first-commit).
  HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || continue
  TMP_INDEX=$(mktemp /tmp/fbi-wip-index.XXXXXX)
  cp .git/index "$TMP_INDEX" 2>/dev/null || continue
  GIT_INDEX_FILE="$TMP_INDEX" git add -A 2>/dev/null
  TREE=$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree 2>/dev/null)
  rm -f "$TMP_INDEX"
  [ -z "$TREE" ] && continue
  COMMIT=$(git commit-tree "$TREE" -p "$HEAD_SHA" -m "wip snapshot" 2>/dev/null)
  [ -z "$COMMIT" ] && continue
  git update-ref refs/fbi/wip-snapshot "$COMMIT" 2>/dev/null
  git push --quiet --force safeguard \
    "refs/fbi/wip-snapshot:refs/fbi/wip-snapshot" 2>/dev/null
done
```

Path: `src/server/priv/static/wip-snapshotter.sh`. Make sure it's `chmod +x`.

- [ ] **Step 2: Bind the script into the container**

In `src/server/src/fbi/run/worker.gleam`, find `fn build_binds` and add this line to `base`:

```gleam
run_dir <> "/scripts/wip-snapshotter.sh:/usr/local/bin/fbi-wip-snapshotter.sh:ro",
```

- [ ] **Step 3: Modify `setup_run_dir` to copy the script in**

Find `fn setup_run_dir` in `worker.gleam`. It already creates `run_dir/scripts/` and copies supervisor.sh + finalizeBranch.sh + fbi-history-op.sh. Add a copy for the snapshotter:

```gleam
let snapshotter_src = "priv/static/wip-snapshotter.sh"
let snapshotter_dst = scripts_dir <> "/wip-snapshotter.sh"
use _ <- result.try(
  simplifile.copy_file(snapshotter_src, snapshotter_dst)
  |> result.map_error(fn(e) {
    "copy wip-snapshotter.sh: " <> simplifile.describe_error(e)
  }),
)
let _ = simplifile.set_permissions_octal(snapshotter_dst, 0o755)
```

- [ ] **Step 4: Start the daemon from supervisor.sh**

Open `src/server/priv/static/supervisor.sh`. Right after the SSH_AUTH_SOCK export near the top (line ~44), add:

```bash
# WIP snapshotter — periodic snapshot of the working tree to safeguard.
if [ -x /usr/local/bin/fbi-wip-snapshotter.sh ]; then
    /usr/local/bin/fbi-wip-snapshotter.sh >/dev/null 2>&1 &
fi
```

- [ ] **Step 5: Build and run a smoke test**

```bash
cd src/server && gleam build
```

Then start a real run via the dev server, wait 10 seconds, and check:

```bash
cd /tmp/fbi-runs/<latest_id>/wip
git rev-parse refs/fbi/wip-snapshot 2>&1
```

Expected: a sha is returned. (Manual check, not automated — depends on a live container.)

- [ ] **Step 6: Commit**

```bash
git add src/server/priv/static/wip-snapshotter.sh \
        src/server/priv/static/supervisor.sh \
        src/server/src/fbi/run/worker.gleam
git commit -m "feat(run): wip-snapshotter daemon writes refs/fbi/wip-snapshot to safeguard"
```

---

## Task 12 — Real `/api/runs/:id/commits/:sha/files` handler

**Files:**
- Modify: `src/server/src/fbi/handlers/changes.gleam`

- [ ] **Step 1: Replace stub with real impl**

In `handlers/changes.gleam`, replace `handle_commit_files`:

```gleam
import fbi/db/runs as runs_db
import fbi/git/repo
import gleam/int

pub fn handle_commit_files(
  req: Request,
  ctx: Context,
  id_str: String,
  sha: String,
) -> Response {
  case req.method {
    http.Get ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> serve_commit_files(ctx, id, sha)
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_commit_files(ctx: Context, run_id: Int, sha: String) -> Response {
  let repo_path =
    ctx.config.runs_dir <> "/" <> int.to_string(run_id) <> "/wip"
  case runs_db.get(ctx.db, run_id) {
    Error(_) -> wisp.not_found()
    Ok(_) ->
      case repo.commit_files(repo_path, sha) {
        Error(_) -> wisp.not_found()
        Ok(files) ->
          json.object([#("files", json.array(files, encode_file))])
          |> json.to_string()
          |> wisp.json_response(200)
      }
  }
}

fn encode_file(f: repo.FileEntry) -> json.Json {
  json.object([
    #("path", json.string(f.path)),
    #("status", json.string(f.status)),
    #("additions", json.int(f.additions)),
    #("deletions", json.int(f.deletions)),
  ])
}
```

- [ ] **Step 2: Build**

```bash
cd src/server && gleam build
```
Expected: clean.

- [ ] **Step 3: Manual smoke test**

```bash
# create a run with a commit, then:
curl -s 'http://localhost:3000/api/runs/<id>/commits/<sha>/files'
```

Expected: JSON `{"files": [...]}` with at least one entry.

- [ ] **Step 4: Commit**

```bash
git add src/server/src/fbi/handlers/changes.gleam
git commit -m "feat(api): real GET /api/runs/:id/commits/:sha/files"
```

---

## Task 13 — Real `/api/runs/:id/file-diff` handler

**Files:**
- Modify: `src/server/src/fbi/handlers/changes.gleam`

The `ref` query param can be `worktree` or a commit sha.

- [ ] **Step 1: Replace stub**

In `handlers/changes.gleam`, replace `handle_file_diff`:

```gleam
import fbi/git/parse
import gleam/list

pub fn handle_file_diff(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> serve_file_diff(req, ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_file_diff(req: Request, ctx: Context, run_id: Int) -> Response {
  let qs = wisp.get_query(req)
  let path = list.key_find(qs, "path") |> result.unwrap("")
  let ref = list.key_find(qs, "ref") |> result.unwrap("worktree")
  let repo_path =
    ctx.config.runs_dir <> "/" <> int.to_string(run_id) <> "/wip"
  case path {
    "" -> wisp.bad_request("path is required")
    _ ->
      case ref {
        "worktree" -> serve_worktree_diff(repo_path, path)
        sha -> serve_commit_diff(repo_path, sha, path)
      }
  }
}

fn serve_worktree_diff(repo_path: String, path: String) -> Response {
  case repo.wip_file_diff(repo_path, path) {
    Error(_) -> wisp.internal_server_error()
    Ok(option.None) -> empty_diff_response("worktree", path)
    Ok(option.Some(#(hunks, truncated, _, _))) ->
      diff_response(hunks, truncated, "worktree", path)
  }
}

fn serve_commit_diff(repo_path: String, sha: String, path: String) -> Response {
  case repo.file_diff(repo_path, sha, path) {
    Error(_) -> wisp.not_found()
    Ok(#(hunks, truncated)) -> diff_response(hunks, truncated, sha, path)
  }
}

fn empty_diff_response(ref: String, path: String) -> Response {
  json.object([
    #("path", json.string(path)),
    #("ref", json.string(ref)),
    #("hunks", json.array([], encode_hunk)),
    #("truncated", json.bool(False)),
  ])
  |> json.to_string()
  |> wisp.json_response(200)
}

fn diff_response(
  hunks: List(parse.Hunk),
  truncated: Bool,
  ref: String,
  path: String,
) -> Response {
  json.object([
    #("path", json.string(path)),
    #("ref", json.string(ref)),
    #("hunks", json.array(hunks, encode_hunk)),
    #("truncated", json.bool(truncated)),
  ])
  |> json.to_string()
  |> wisp.json_response(200)
}

fn encode_hunk(h: parse.Hunk) -> json.Json {
  json.object([
    #("header", json.string(h.header)),
    #("lines", json.array(h.lines, fn(l) {
      json.object([
        #("kind", json.string(l.kind)),
        #("text", json.string(l.text)),
      ])
    })),
  ])
}
```

- [ ] **Step 2: Build**

```bash
cd src/server && gleam build
```
Expected: clean.

- [ ] **Step 3: Smoke test**

```bash
curl -s 'http://localhost:3000/api/runs/<id>/file-diff?path=README.md&ref=<sha>'
```

Expected: JSON with non-empty hunks for a real commit.

- [ ] **Step 4: Commit**

```bash
git add src/server/src/fbi/handlers/changes.gleam
git commit -m "feat(api): real GET /api/runs/:id/file-diff for worktree + sha refs"
```

---

## Task 14 — Real `/api/runs/:id/wip*` handlers

**Files:**
- Modify: `src/server/src/fbi/handlers/wip.gleam`

- [ ] **Step 1: Rewrite the file**

Replace `src/server/src/fbi/handlers/wip.gleam`:

```gleam
import fbi/context.{type Context}
import fbi/db/runs as runs_db
import fbi/git/parse
import fbi/git/repo
import gleam/http
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import wisp.{type Request, type Response}

pub fn handle_status(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      with_repo_path(ctx, id_str, fn(_run, repo_path) {
        case repo.wip_files(repo_path) {
          Error(_) -> wisp.internal_server_error()
          Ok(None) -> no_wip_response()
          Ok(Some(snap)) ->
            json.object([
              #("ok", json.bool(True)),
              #("snapshot_sha", json.string(snap.snapshot_sha)),
              #("parent_sha", json.string(snap.parent_sha)),
              #("files", json.array(snap.files, encode_file)),
            ])
            |> json.to_string()
            |> wisp.json_response(200)
        }
      })
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_file(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      with_repo_path(ctx, id_str, fn(_run, repo_path) {
        let qs = wisp.get_query(req)
        let path = list.key_find(qs, "path") |> result.unwrap("")
        case path {
          "" -> wisp.bad_request("path is required")
          _ ->
            case repo.wip_file_diff(repo_path, path) {
              Error(_) -> wisp.internal_server_error()
              Ok(None) -> empty_diff(path)
              Ok(Some(#(hunks, truncated, _, _))) ->
                json.object([
                  #("path", json.string(path)),
                  #("ref", json.string("worktree")),
                  #("hunks", json.array(hunks, encode_hunk)),
                  #("truncated", json.bool(truncated)),
                ])
                |> json.to_string()
                |> wisp.json_response(200)
            }
        }
      })
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_patch(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      with_repo_path(ctx, id_str, fn(_run, repo_path) {
        case repo.wip_patch(repo_path) {
          Error(_) -> wisp.internal_server_error()
          Ok(body) ->
            wisp.response(200)
            |> wisp.set_header("content-type", "text/x-patch; charset=utf-8")
            |> wisp.set_header(
              "content-disposition",
              "attachment; filename=\"run-" <> id_str <> "-wip.patch\"",
            )
            |> wisp.set_body(wisp.Text(body))
        }
      })
    _ -> wisp.method_not_allowed([http.Get])
  }
}

pub fn handle_discard(_req: Request, _ctx: Context, _id_str: String) -> Response {
  // Implemented in Task 17 (needs docker.exec_container).
  wisp.response(501)
}

fn with_repo_path(
  ctx: Context,
  id_str: String,
  next: fn(runs_db.Run, String) -> Response,
) -> Response {
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid run ID")
    Ok(id) ->
      case runs_db.get(ctx.db, id) {
        Error(_) -> wisp.not_found()
        Ok(run) -> {
          let path =
            ctx.config.runs_dir <> "/" <> int.to_string(id) <> "/wip"
          next(run, path)
        }
      }
  }
}

fn no_wip_response() -> Response {
  json.object([
    #("ok", json.bool(False)),
    #("reason", json.string("no-wip")),
  ])
  |> json.to_string()
  |> wisp.json_response(200)
}

fn empty_diff(path: String) -> Response {
  json.object([
    #("path", json.string(path)),
    #("ref", json.string("worktree")),
    #("hunks", json.array([], encode_hunk)),
    #("truncated", json.bool(False)),
  ])
  |> json.to_string()
  |> wisp.json_response(200)
}

fn encode_file(f: repo.FileEntry) -> json.Json {
  json.object([
    #("path", json.string(f.path)),
    #("status", json.string(f.status)),
    #("additions", json.int(f.additions)),
    #("deletions", json.int(f.deletions)),
  ])
}

fn encode_hunk(h: parse.Hunk) -> json.Json {
  json.object([
    #("header", json.string(h.header)),
    #("lines", json.array(h.lines, fn(l) {
      json.object([
        #("kind", json.string(l.kind)),
        #("text", json.string(l.text)),
      ])
    })),
  ])
}
```

- [ ] **Step 2: Build**

```bash
cd src/server && gleam build
```

- [ ] **Step 3: Smoke test**

```bash
curl -s 'http://localhost:3000/api/runs/<id>/wip'
curl -s 'http://localhost:3000/api/runs/<id>/wip/file?path=README.md'
curl -s 'http://localhost:3000/api/runs/<id>/wip/patch'
```

- [ ] **Step 4: Commit**

```bash
git add src/server/src/fbi/handlers/wip.gleam
git commit -m "feat(api): real GET /api/runs/:id/wip[/file|/patch]"
```

---

## Task 15 — Real `/api/runs/:id/changes` handler

**Files:**
- Modify: `src/server/src/fbi/handlers/changes.gleam`
- Modify: `src/server/src/fbi/db/runs.gleam` (add `children_of`)

- [ ] **Step 1: Add `children_of` to runs.gleam**

In `src/server/src/fbi/db/runs.gleam`:

```gleam
pub type ChildSummary {
  ChildSummary(id: Int, kind: String, state: String, created_at: Int)
}

pub fn children_of(db: sqlight.Connection, run_id: Int) -> Result(List(ChildSummary), DbError) {
  let dec = {
    use id <- decode.field(0, decode.int)
    use kind <- decode.field(1, decode.string)
    use state <- decode.field(2, decode.string)
    use created_at <- decode.field(3, decode.int)
    decode.success(ChildSummary(id, kind, state, created_at))
  }
  connection.query_all(
    "SELECT id, kind, state, created_at FROM runs WHERE parent_run_id = ? ORDER BY created_at",
    db, [sqlight.int(run_id)], dec,
  )
}
```

- [ ] **Step 2: Replace `handle_changes` in `handlers/changes.gleam`**

```gleam
pub fn handle_changes(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Get ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> serve_changes(ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_changes(ctx: Context, run_id: Int) -> Response {
  case runs_db.get(ctx.db, run_id) {
    Error(_) -> wisp.not_found()
    Ok(run) -> {
      let repo_path =
        ctx.config.runs_dir <> "/" <> int.to_string(run_id) <> "/wip"
      let default = "main"  // For v1 — TODO refine via project.default_branch
      let branch = run.branch_name
      let commits =
        repo.commits_on_branch(repo_path, branch, default)
        |> result.unwrap([])
      let commits_with_files =
        list.map(commits, fn(c) {
          let files = repo.commit_files(repo_path, c.sha) |> result.unwrap([])
          #(c, files)
        })
      let pushed_all = run.mirror_status == option.Some("ok")
      let base =
        repo.branch_base_ahead_behind(repo_path, branch, default)
        |> result.map(option.Some)
        |> result.unwrap(option.None)
      let uncommitted = case repo.wip_files(repo_path) {
        Ok(option.Some(snap)) -> snap.files
        _ -> []
      }
      let children =
        runs_db.children_of(ctx.db, run_id) |> result.unwrap([])
      json.object([
        #("branch_name", json.string(branch)),
        #("branch_base", encode_branch_base(base)),
        #("commits", json.array(commits_with_files, fn(pair) {
          let #(c, files) = pair
          encode_commit(c, files, pushed_all)
        })),
        #("uncommitted", json.array(uncommitted, encode_file)),
        #("integrations", json.object([])),
        #("dirty_submodules", json.array([], json.string)),
        #("children", json.array(children, encode_child)),
      ])
      |> json.to_string()
      |> wisp.json_response(200)
    }
  }
}

fn encode_branch_base(b: option.Option(repo.BranchBase)) -> json.Json {
  case b {
    option.None -> json.null()
    option.Some(bb) ->
      json.object([
        #("base", json.string(bb.base)),
        #("ahead", json.int(bb.ahead)),
        #("behind", json.int(bb.behind)),
      ])
  }
}

fn encode_commit(
  c: parse.LogEntry,
  files: List(repo.FileEntry),
  pushed: Bool,
) -> json.Json {
  json.object([
    #("sha", json.string(c.sha)),
    #("subject", json.string(c.subject)),
    #("committed_at", json.int(c.committed_at)),
    #("pushed", json.bool(pushed)),
    #("files", json.array(files, encode_file)),
    #("files_loaded", json.bool(True)),
    #("submodule_bumps", json.array([], json.string)),
  ])
}

fn encode_child(c: runs_db.ChildSummary) -> json.Json {
  json.object([
    #("id", json.int(c.id)),
    #("kind", json.string(c.kind)),
    #("state", json.string(c.state)),
    #("created_at", json.int(c.created_at)),
  ])
}
```

> **Note:** The `default = "main"` placeholder will be replaced by reading from `project.default_branch` in Task 16.

- [ ] **Step 3: Build and smoke test**

```bash
cd src/server && gleam build
curl -s 'http://localhost:3000/api/runs/<id>/changes' | jq .
```

Expected: JSON with branch_name, commits, branch_base, etc.

- [ ] **Step 4: Commit**

```bash
git add src/server/src/fbi/db/runs.gleam src/server/src/fbi/handlers/changes.gleam
git commit -m "feat(api): real GET /api/runs/:id/changes"
```

---

## Task 16 — Use project default branch + cache origin sha

**Files:**
- Modify: `src/server/src/fbi/handlers/changes.gleam`

Replace the `let default = "main"` shortcut with a real lookup against `projects.get`. Cache the resolved origin sha at `{run_dir}/state/origin-default-sha` to avoid network on every request.

- [ ] **Step 1: Add the helper + use it**

In `handlers/changes.gleam`:

```gleam
import fbi/db/projects

fn resolve_default_branch(
  ctx: Context,
  project_id: Int,
  repo_path: String,
) -> String {
  case projects.get(ctx.db, project_id) {
    Ok(p) -> p.default_branch
    Error(_) -> "main"
  }
}
```

In `serve_changes`, replace `let default = "main"` with:

```gleam
let default = resolve_default_branch(ctx, run.project_id, repo_path)
```

The origin-sha cache file isn't needed yet — `branch_base_ahead_behind` already returns Error if the default branch ref isn't present in the bare repo, and we map that to `branch_base: null`. Keep simple for now.

- [ ] **Step 2: Build and smoke test**

```bash
cd src/server && gleam build
```

- [ ] **Step 3: Commit**

```bash
git add src/server/src/fbi/handlers/changes.gleam
git commit -m "feat(api): use project default_branch in /changes"
```

---

## Task 17 — `docker.exec_container` + `/wip/discard` real impl

**Files:**
- Modify: `src/server/src/fbi/docker.gleam`
- Modify: `src/server/src/fbi/handlers/wip.gleam`
- Modify: `src/server/src/fbi/router.gleam` (`handle_discard` is already wired)

The Docker exec API is two POSTs: `POST /containers/:id/exec` to create the exec instance, then `POST /exec/:id/start` to run it.

- [ ] **Step 1: Add `exec_container` to docker.gleam**

```gleam
pub type ExecResult {
  ExecResult(exit_code: Int, output: String)
}

pub fn exec_container(
  sock: Socket,
  container_id: String,
  cmd: List(String),
  user: String,
) -> Result(ExecResult, DockerError) {
  // 1. Create the exec instance.
  let create_body =
    json.object([
      #("AttachStdout", json.bool(True)),
      #("AttachStderr", json.bool(True)),
      #("Tty", json.bool(False)),
      #("User", json.string(user)),
      #("Cmd", json.array(cmd, json.string)),
    ])
  use #(status, resp) <- result.try(request(
    sock,
    "POST",
    "/containers/" <> container_id <> "/exec",
    bit_array.from_string(json.to_string(create_body)),
    "application/json",
  ))
  use exec_id <- result.try(case status {
    201 -> {
      use s <- result.try(to_string(resp))
      let dec = decode.field("Id", decode.string, decode.success)
      json.parse(s, dec) |> result.map_error(fn(_) { DecodeError("exec id") })
    }
    code -> Error(HttpError(code, result.unwrap(to_string(resp), "")))
  })
  // 2. Start the exec; capture combined stdout+stderr.
  use #(start_status, start_body) <- result.try(request(
    sock,
    "POST",
    "/exec/" <> exec_id <> "/start",
    bit_array.from_string(
      json.to_string(json.object([
        #("Detach", json.bool(False)),
        #("Tty", json.bool(False)),
      ])),
    ),
    "application/json",
  ))
  case start_status {
    200 -> Nil
    code -> Nil  // We still try to inspect — may have partial output.
  }
  let _ = code
  let output = result.unwrap(to_string(start_body), "")
  // 3. Inspect to read exit code.
  use #(_, ins_body) <- result.try(request(
    sock,
    "GET",
    "/exec/" <> exec_id <> "/json",
    <<>>,
    "application/json",
  ))
  use ins_str <- result.try(to_string(ins_body))
  let exit_dec = decode.field("ExitCode", decode.int, decode.success)
  case json.parse(ins_str, exit_dec) {
    Ok(code) -> Ok(ExecResult(exit_code: code, output: output))
    Error(_) -> Error(DecodeError("exec exit code"))
  }
}
```

- [ ] **Step 2: Replace `handle_discard` in `handlers/wip.gleam`**

```gleam
import fbi/docker
import fbi/run/registry as run_registry
import gleam/erlang/process
import gleam/option.{None as OptionNone, Some as OptionSome}

pub fn handle_discard(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Post ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> do_discard(ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Post])
  }
}

fn do_discard(ctx: Context, run_id: Int) -> Response {
  case runs_db.get(ctx.db, run_id) {
    Error(_) -> wisp.not_found()
    Ok(run) ->
      case run.container_id {
        OptionNone -> conflict_no_container()
        OptionSome(cid) ->
          case run_registry.lookup(ctx.run_registry, run_id) {
            OptionNone -> conflict_no_container()
            _ -> exec_discard(ctx, cid)
          }
      }
  }
}

fn exec_discard(ctx: Context, cid: String) -> Response {
  case docker.connect(ctx.config.docker_socket) {
    Error(e) -> {
      wisp.log_warning("wip discard connect: " <> docker.describe_error(e))
      wisp.internal_server_error()
    }
    Ok(sock) -> {
      let result =
        docker.exec_container(
          sock,
          cid,
          ["sh", "-c", "cd /workspace && git restore --staged --worktree . && git clean -fd"],
          "agent",
        )
      docker.close(sock)
      case result {
        Ok(_) -> wisp.response(204)
        Error(e) -> {
          wisp.log_warning("wip discard exec: " <> docker.describe_error(e))
          json.object([
            #("kind", json.string("git-error")),
            #("message", json.string(docker.describe_error(e))),
          ])
          |> json.to_string()
          |> wisp.json_response(500)
        }
      }
    }
  }
}

fn conflict_no_container() -> Response {
  json.object([
    #("error", json.string("container_not_running")),
  ])
  |> json.to_string()
  |> wisp.json_response(409)
}
```

- [ ] **Step 3: Build, smoke test**

```bash
cd src/server && gleam build
# create a run, modify a file inside the container, hit /wip → see dirty file
# then:
curl -s -X POST http://localhost:3000/api/runs/<id>/wip/discard
# wait 6 seconds for next snapshotter tick
curl -s http://localhost:3000/api/runs/<id>/wip
# expect: {"ok": false, "reason": "no-wip"}
```

- [ ] **Step 4: Commit**

```bash
git add src/server/src/fbi/docker.gleam src/server/src/fbi/handlers/wip.gleam
git commit -m "feat(api): real POST /api/runs/:id/wip/discard via docker exec"
```

---

## Task 18 — Per-run mutex actor

**Files:**
- Create: `src/server/src/fbi/git/mutex.gleam`
- Modify: `src/server/src/fbi/context.gleam` (add `history_mutex` field)
- Modify: `src/server/src/fbi.gleam` (start the actor)

A simple actor whose state is a Set(Int). `try_acquire(run_id)` adds; if already present, returns Busy. `release(run_id)` removes.

- [ ] **Step 1: Write the module**

```gleam
// src/server/src/fbi/git/mutex.gleam
import gleam/erlang/process.{type Subject}
import gleam/otp/actor
import gleam/result
import gleam/set.{type Set}

pub type Cmd {
  TryAcquire(run_id: Int, reply: Subject(Bool))
  Release(run_id: Int)
}

pub fn start() -> Result(Subject(Cmd), actor.StartError) {
  actor.new_with_initialiser(100, fn(subject) {
    set.new()
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state, msg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(s) { s.data })
}

fn handle(state: Set(Int), msg: Cmd) -> actor.Next(Set(Int), Cmd) {
  case msg {
    TryAcquire(id, reply) ->
      case set.contains(state, id) {
        True -> {
          process.send(reply, False)
          actor.continue(state)
        }
        False -> {
          process.send(reply, True)
          actor.continue(set.insert(state, id))
        }
      }
    Release(id) -> actor.continue(set.delete(state, id))
  }
}

pub fn try_acquire(mutex: Subject(Cmd), run_id: Int) -> Bool {
  let reply = process.new_subject()
  process.send(mutex, TryAcquire(run_id, reply))
  case process.receive(reply, 200) {
    Ok(b) -> b
    Error(_) -> False
  }
}

pub fn release(mutex: Subject(Cmd), run_id: Int) -> Nil {
  process.send(mutex, Release(run_id))
}
```

- [ ] **Step 2: Add field to `Context`**

In `src/server/src/fbi/context.gleam`, add `history_mutex: Subject(mutex.Cmd)` to the record. Update the `Context(...)` constructor in `fbi.gleam`.

- [ ] **Step 3: Start actor in fbi.gleam**

In `src/server/src/fbi.gleam`, after `let assert Ok(registry) = run_registry.start()`:

```gleam
import fbi/git/mutex as history_mutex

let assert Ok(history_lock) = history_mutex.start()
```

And in the `Context` constructor:

```gleam
let ctx = Context(
  ...,
  history_mutex: history_lock,
)
```

- [ ] **Step 4: Build**

```bash
cd src/server && gleam build && gleam test
```

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/git/mutex.gleam src/server/src/fbi/context.gleam src/server/src/fbi.gleam
git commit -m "feat(git): add per-run mutex actor"
```

---

## Task 19 — `history_ops.gleam` + pure-git ops (squash-local, mirror-rebase)

**Files:**
- Create: `src/server/src/fbi/git/history_ops.gleam`
- Create: `src/server/test/fbi/git/history_ops_test.gleam`

- [ ] **Step 1: Add failing test for squash-local**

```gleam
import fbi/git
import fbi/git/history_ops
import gleam/list
import gleeunit/should
import simplifile

// Reuse the seed_bare_repo helper; for simplicity copy it here or refactor
// later. Below assumes you've extracted seed_bare_repo to test/fbi/git/util.gleam.
// For this plan, inline the seeding inside each test file as needed.

pub fn squash_local_collapses_to_one_commit_test() {
  let #(bare, _) = seed_bare_repo_with_extra_commits()
  let assert Ok(_) = history_ops.squash_local(bare, "feature", "main", "squashed")
  let assert Ok(out) = git.run(bare, ["log", "main..feature", "--pretty=format:%s"])
  out
  |> string.split("\n")
  |> list.length
  |> should.equal(1)
}
```

Inline a `seed_bare_repo_with_extra_commits` that creates a bare repo with `main` and a `feature` branch that has 3 commits ahead.

- [ ] **Step 2: Implement squash_local + mirror_rebase**

```gleam
// src/server/src/fbi/git/history_ops.gleam
import fbi/git.{type GitError}
import gleam/result

pub type Outcome {
  Complete(sha: String)
  Conflict
  GitError(message: String)
  Invalid(message: String)
}

pub fn squash_local(
  repo_path: String,
  branch: String,
  base: String,
  subject: String,
) -> Result(Outcome, GitError) {
  use base_sha <- result.try(rev_parse(repo_path, base))
  // Hard reset the branch ref to base, then create a single commit using the
  // tree from the original branch tip. We work entirely with refs in the bare repo.
  use original_tip <- result.try(rev_parse(repo_path, branch))
  use tree <- result.try(rev_parse(repo_path, original_tip <> "^{tree}"))
  use new_commit <- result.try(
    git.run(repo_path, ["commit-tree", tree, "-p", base_sha, "-m", subject])
    |> result.map(string_trim),
  )
  use _ <- result.try(git.run(repo_path, ["update-ref", "refs/heads/" <> branch, new_commit]))
  Ok(Complete(sha: new_commit))
}

pub fn mirror_rebase(
  repo_path: String,
  branch: String,
  remote: String,
  remote_branch: String,
) -> Result(Outcome, GitError) {
  // Fetch the remote ref.
  use _ <- result.try(git.run(repo_path, ["fetch", remote, remote_branch]))
  let remote_ref = "FETCH_HEAD"
  use _ <- result.try(git.run(repo_path, ["update-ref", "refs/heads/" <> remote_branch, remote_ref]))
  // Cherry-pick the branch's commits onto remote. The bare-repo dance:
  //   git rev-list --reverse <remote>..<branch> | xargs -I{} git cherry-pick ...
  // is hard without a worktree. Simpler: use `git rebase` requires a worktree.
  // For mirror-rebase we instead fetch + fast-forward when possible; if not,
  // we return Conflict so a child run resolves it.
  case git.run(repo_path, ["merge-base", "--is-ancestor", remote_ref, "refs/heads/" <> branch]) {
    Ok(_) -> Ok(Complete(sha: ""))
    Error(_) ->
      // Branch isn't a fast-forward of remote → conflict.
      Ok(Conflict)
  }
}

fn rev_parse(repo_path: String, ref: String) -> Result(String, GitError) {
  use s <- result.try(git.run(repo_path, ["rev-parse", ref]))
  Ok(string_trim(s))
}

@external(erlang, "string", "trim")
fn string_trim(s: String) -> String
```

- [ ] **Step 3: Verify tests pass**

```bash
cd src/server && gleam test
```

- [ ] **Step 4: Commit**

```bash
git add src/server/src/fbi/git/history_ops.gleam src/server/test/fbi/git/history_ops_test.gleam
git commit -m "feat(git): squash-local and mirror-rebase pure-git ops"
```

---

## Task 20 — Container-side history ops (sync, merge)

**Files:**
- Modify: `src/server/src/fbi/git/history_ops.gleam`

These run inside the live container via `docker.exec_container`, against the worktree at `/workspace`.

- [ ] **Step 1: Add the functions**

```gleam
import fbi/docker
import fbi/config.{type Config}

pub fn sync_in_container(
  config: Config,
  cid: String,
) -> Result(Outcome, String) {
  exec_in_container(
    config,
    cid,
    "cd /workspace && git pull --no-rebase 2>&1",
  )
}

pub type MergeStrategy {
  NoFf
  FfOnly
  Squash
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
      let result =
        docker.exec_container(sock, cid, ["sh", "-c", shell_cmd], "agent")
      docker.close(sock)
      case result {
        Error(e) -> Error(docker.describe_error(e))
        Ok(r) ->
          case r.exit_code {
            0 -> Ok(Complete(sha: ""))
            // Merge conflicts → exit 1 with "CONFLICT" in output.
            _ ->
              case string.contains(r.output, "CONFLICT") {
                True -> Ok(Conflict)
                False -> Ok(GitError(message: r.output))
              }
          }
      }
    }
  }
}
```

- [ ] **Step 2: Build**

```bash
cd src/server && gleam build
```

- [ ] **Step 3: Commit**

```bash
git add src/server/src/fbi/git/history_ops.gleam
git commit -m "feat(git): sync_in_container + merge_in_container via docker exec"
```

---

## Task 21 — Agent-spawning ops + DB helpers

**Files:**
- Modify: `src/server/src/fbi/db/runs.gleam` (add `insert_polish_run`, `insert_merge_conflict_run`, `count_active_children`)
- Modify: `src/server/src/fbi/git/history_ops.gleam` (add `dispatch_polish`, `dispatch_merge_conflict`)
- Create: `src/server/priv/static/polish-prompt.txt`
- Modify: `src/server/priv/static/supervisor.sh` (recognize `kind`)
- Modify: `src/server/src/fbi/run/worker.gleam` (bind polish-prompt.txt)

- [ ] **Step 1: Add DB helpers**

In `src/server/src/fbi/db/runs.gleam`:

```gleam
pub fn insert_polish_run(
  db: sqlight.Connection,
  parent: Run,
  now: Int,
) -> Result(Run, DbError) {
  insert_child_run(db, parent, "polish", read_polish_prompt(), now)
}

pub fn insert_merge_conflict_run(
  db: sqlight.Connection,
  parent: Run,
  now: Int,
) -> Result(Run, DbError) {
  insert_child_run(db, parent, "merge-conflict", merge_conflict_prompt(), now)
}

fn insert_child_run(
  db: sqlight.Connection,
  parent: Run,
  kind: String,
  prompt: String,
  now: Int,
) -> Result(Run, DbError) {
  let log_path = "/var/log/fbi/runs/" <> int.to_string(now) <> ".log"
  connection.query_one(
    "INSERT INTO runs
       (project_id, prompt, branch_name, state, log_path, created_at,
        state_entered_at, parent_run_id, kind)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
     RETURNING " <> columns(),
    db,
    [
      sqlight.int(parent.project_id),
      sqlight.text(prompt),
      sqlight.text(parent.branch_name),
      sqlight.text(log_path),
      sqlight.int(now),
      sqlight.int(now),
      sqlight.int(parent.id),
      sqlight.text(kind),
    ],
    decoder(),
  )
}

pub fn count_active_children(
  db: sqlight.Connection,
  parent_id: Int,
) -> Result(Int, DbError) {
  connection.query_one(
    "SELECT COUNT(*) FROM runs
     WHERE parent_run_id = ?
       AND state IN ('queued', 'running', 'waiting', 'awaiting_resume')",
    db,
    [sqlight.int(parent_id)],
    decode.at([0], decode.int),
  )
}

fn read_polish_prompt() -> String {
  case simplifile.read("priv/static/polish-prompt.txt") {
    Ok(s) -> s
    Error(_) -> "Polish the most recent commits on this branch."
  }
}

fn merge_conflict_prompt() -> String {
  "Resolve the merge conflicts in /workspace, then commit the resolution. The conflicts were left in place by an automated merge or rebase."
}
```

Add `import simplifile` if not already.

- [ ] **Step 2: Add the prompt template**

Create `src/server/priv/static/polish-prompt.txt`:

```
Review the most recent commits on this branch and polish them: improve commit
messages, split or squash where it improves clarity, and ensure each commit
stands alone. Do not change behavior — refactor only the history.
```

- [ ] **Step 3: Add `dispatch_polish` and `dispatch_merge_conflict` to history_ops.gleam**

```gleam
import fbi/db/runs as runs_db
import fbi/run/registry.{type RegistryMsg, Register}
import fbi/run/broadcaster
import fbi/run/actor as run_actor
import fbi/run/worker as run_worker
import fbi/db/projects
import gleam/erlang/process.{type Subject}
import sqlight

pub type DispatchResult {
  AgentDispatched(child_run_id: Int)
  AgentBusy
  DispatchError(message: String)
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
              case start_supervisor(db, config, registry, child) {
                Error(reason) -> DispatchError(message: reason)
                Ok(#(actor_subj, bc)) -> {
                  run_worker.launch(
                    run_worker.LaunchInput(
                      run: child, project: project, config: config,
                      cols: 80, rows: 24, broadcaster: bc,
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

fn start_supervisor(
  db: sqlight.Connection,
  config: Config,
  registry: Subject(RegistryMsg),
  run: runs_db.Run,
) -> Result(#(Subject(_), Subject(_)), String) {
  use bc <- result.try(
    broadcaster.start() |> result.map_error(fn(_) { "broadcaster start failed" }),
  )
  use actor_subj <- result.try(
    run_actor.start(run.id, db, config, bc, registry)
    |> result.map_error(fn(_) { "actor start failed" }),
  )
  process.send(registry, Register(run.id, actor_subj))
  Ok(#(actor_subj, bc))
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
```

- [ ] **Step 4: Bind polish-prompt.txt + recognize kind in supervisor.sh**

In `worker.gleam` `setup_run_dir`, copy the prompt:

```gleam
let polish_src = "priv/static/polish-prompt.txt"
let polish_dst = scripts_dir <> "/polish-prompt.txt"
let _ = simplifile.copy_file(polish_src, polish_dst)
```

And add a bind in `build_binds` so the prompt is reachable from the container if the agent needs it:

```gleam
run_dir <> "/scripts/polish-prompt.txt:/usr/local/share/fbi/polish-prompt.txt:ro",
```

In `supervisor.sh`, near where the prompt is read into the agent's prompt.txt, add:

```bash
case "${FBI_KIND:-work}" in
  polish)
    if [ -f /usr/local/share/fbi/polish-prompt.txt ]; then
      cat /usr/local/share/fbi/polish-prompt.txt > /fbi/prompt.txt
    fi
    ;;
  merge-conflict)
    cat <<'EOF' > /fbi/prompt.txt
Resolve the merge conflicts in /workspace, then commit the resolution.
EOF
    ;;
esac
```

In `worker.build_env`, add the `FBI_KIND` env var:

```gleam
"FBI_KIND=" <> input.run.kind,
```

- [ ] **Step 5: Build, test**

```bash
cd src/server && gleam build && gleam test
```

- [ ] **Step 6: Commit**

```bash
git add src/server/src/fbi/db/runs.gleam \
        src/server/src/fbi/git/history_ops.gleam \
        src/server/priv/static/polish-prompt.txt \
        src/server/priv/static/supervisor.sh \
        src/server/src/fbi/run/worker.gleam
git commit -m "feat(git): dispatch polish + merge-conflict child runs"
```

---

## Task 22 — `handlers/history.gleam` + router wiring

**Files:**
- Create: `src/server/src/fbi/handlers/history.gleam`
- Modify: `src/server/src/fbi/router.gleam` (use new handler instead of `changes_handler.handle_history`)
- Modify: `src/server/src/fbi/handlers/changes.gleam` (drop the `handle_history` stub since the new handler replaces it)

- [ ] **Step 1: Create the handler**

```gleam
// src/server/src/fbi/handlers/history.gleam
import fbi/context.{type Context}
import fbi/db/runs as runs_db
import fbi/git/history_ops
import fbi/git/mutex as history_mutex
import fbi/run/registry as run_registry
import gleam/dynamic/decode
import gleam/http
import gleam/int
import gleam/json
import gleam/option.{None, Some}
import wisp.{type Request, type Response}

pub fn handle(req: Request, ctx: Context, id_str: String) -> Response {
  case req.method {
    http.Post ->
      case int.parse(id_str) {
        Error(_) -> wisp.bad_request("Invalid run ID")
        Ok(id) -> dispatch(req, ctx, id)
      }
    _ -> wisp.method_not_allowed([http.Post])
  }
}

fn dispatch(req: Request, ctx: Context, run_id: Int) -> Response {
  use body <- wisp.require_json(req)
  let op_decoder = decode.field("op", decode.string, decode.success)
  case decode.run(body, op_decoder) {
    Error(_) -> result_response(history_ops.Invalid(message: "missing op"))
    Ok(op) -> {
      case history_mutex.try_acquire(ctx.history_mutex, run_id) {
        False -> result_response(history_ops.Invalid(message: "agent-busy"))
        True -> {
          let result = run_op(ctx, run_id, op, body)
          history_mutex.release(ctx.history_mutex, run_id)
          result_response(result)
        }
      }
    }
  }
}

fn run_op(
  ctx: Context,
  run_id: Int,
  op: String,
  body: dynamic.Dynamic,
) -> history_ops.Outcome {
  case runs_db.get(ctx.db, run_id) {
    Error(_) -> history_ops.Invalid(message: "run not found")
    Ok(run) -> {
      let repo_path =
        ctx.config.runs_dir <> "/" <> int.to_string(run_id) <> "/wip"
      case op {
        "squash-local" -> {
          let dec = decode.field("subject", decode.string, decode.success)
          case decode.run(body, dec) {
            Ok(subject) ->
              case
                history_ops.squash_local(repo_path, run.branch_name, "main", subject)
              {
                Ok(o) -> o
                Error(e) -> history_ops.GitError(message: describe(e))
              }
            Error(_) -> history_ops.Invalid(message: "subject required")
          }
        }
        "mirror-rebase" ->
          case
            history_ops.mirror_rebase(repo_path, run.branch_name, "origin", "main")
          {
            Ok(o) -> dispatch_if_conflict(ctx, run, o)
            Error(e) -> history_ops.GitError(message: describe(e))
          }
        "sync" ->
          case run.container_id {
            None -> history_ops.GitError(message: "container not running")
            Some(cid) ->
              case history_ops.sync_in_container(ctx.config, cid) {
                Ok(o) -> dispatch_if_conflict(ctx, run, o)
                Error(e) -> history_ops.GitError(message: e)
              }
          }
        "merge" -> {
          let strat_dec = decode.optional_field("strategy", "no-ff", decode.string)
          let strat = decode.run(body, strat_dec) |> result.unwrap("no-ff")
          let strategy = case strat {
            "ff-only" -> history_ops.FfOnly
            "squash" -> history_ops.Squash
            _ -> history_ops.NoFf
          }
          case run.container_id {
            None -> history_ops.GitError(message: "container not running")
            Some(cid) ->
              case history_ops.merge_in_container(ctx.config, cid, "main", strategy) {
                Ok(o) -> dispatch_if_conflict(ctx, run, o)
                Error(e) -> history_ops.GitError(message: e)
              }
          }
        }
        "polish" ->
          case
            history_ops.dispatch_polish(ctx.db, ctx.config, ctx.run_registry, run)
          {
            history_ops.AgentDispatched(child_id) -> history_ops.Conflict
            // Misnamed — return AgentDispatched outcome variant via different mapping below.
            history_ops.AgentBusy -> history_ops.Invalid(message: "agent-busy")
            history_ops.DispatchError(m) -> history_ops.GitError(message: m)
          }
        "push-submodule" -> history_ops.Invalid(message: "submodules not supported in this build")
        _ -> history_ops.Invalid(message: "unknown op: " <> op)
      }
    }
  }
}

fn dispatch_if_conflict(
  ctx: Context,
  run: runs_db.Run,
  outcome: history_ops.Outcome,
) -> history_ops.Outcome {
  case outcome {
    history_ops.Conflict ->
      case
        history_ops.dispatch_merge_conflict(ctx.db, ctx.config, ctx.run_registry, run)
      {
        history_ops.AgentDispatched(_) -> history_ops.Conflict
        history_ops.AgentBusy -> history_ops.Invalid(message: "agent-busy")
        history_ops.DispatchError(m) -> history_ops.GitError(message: m)
      }
    o -> o
  }
}

fn result_response(o: history_ops.Outcome) -> Response {
  let body = case o {
    history_ops.Complete(sha) ->
      json.object([#("kind", json.string("complete")), #("sha", json.string(sha))])
    history_ops.Conflict ->
      // child_run_id is set by dispatch_if_conflict via a side channel —
      // for v1 we encode without the id; the child shows up via /siblings.
      json.object([#("kind", json.string("conflict"))])
    history_ops.Invalid(m) ->
      json.object([#("kind", json.string("invalid")), #("message", json.string(m))])
    history_ops.GitError(m) ->
      json.object([#("kind", json.string("git-error")), #("message", json.string(m))])
  }
  body |> json.to_string() |> wisp.json_response(200)
}

fn describe(e: fbi.git.GitError) -> String {
  // import fbi/git for describe_error
  fbi.git.describe_error(e)
}
```

> **Note:** the polish dispatch path is structurally awkward in the snippet above (re-uses Conflict variant for AgentDispatched). Extend the Outcome type with `Agent(child_run_id: Int)` and update `result_response` accordingly:

```gleam
pub type Outcome {
  Complete(sha: String)
  Agent(child_run_id: Int)
  Conflict(child_run_id: Int)
  GitError(message: String)
  Invalid(message: String)
}
```

Adjust dispatch sites to set the right child id in `Agent` / `Conflict`, and `result_response` to encode it:

```gleam
history_ops.Agent(id) ->
  json.object([#("kind", json.string("agent")), #("child_run_id", json.int(id))])
history_ops.Conflict(id) ->
  json.object([#("kind", json.string("conflict")), #("child_run_id", json.int(id))])
```

- [ ] **Step 2: Wire router**

In `src/server/src/fbi/router.gleam`:

```gleam
import fbi/handlers/history as history_handler
```

Replace the `["api", "runs", id, "history"]` arm to call `history_handler.handle(req, ctx, id)` and remove the corresponding stub from `changes.gleam`.

- [ ] **Step 3: Build, test**

```bash
cd src/server && gleam build && gleam test
```

- [ ] **Step 4: Smoke test**

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"op":"polish"}' http://localhost:3000/api/runs/<id>/history
# expect: {"kind":"agent","child_run_id":N}
```

- [ ] **Step 5: Commit**

```bash
git add src/server/src/fbi/handlers/history.gleam \
        src/server/src/fbi/handlers/changes.gleam \
        src/server/src/fbi/router.gleam \
        src/server/src/fbi/git/history_ops.gleam
git commit -m "feat(api): real POST /api/runs/:id/history dispatching all five ops"
```

---

## Task 23 — End-to-end Playwright verification

**Files:**
- (no source changes; manual verification)

- [ ] **Step 1: Confirm tests pass**

```bash
cd src/server && gleam test
```

- [ ] **Step 2: Restart dev server + client**

```bash
lsof -ti:3000 | xargs -r kill -9 ; sleep 2
cd /Users/fdatoo/Desktop/FBI && ./scripts/dev-server.sh > /tmp/fbi-dev-server.log 2>&1 &
until lsof -ti:3000 >/dev/null 2>&1 ; do sleep 2 ; done
sleep 3
# client should already be up; if not:
cd /Users/fdatoo/Desktop/FBI && ./scripts/dev-client.sh > /tmp/fbi-dev-client.log 2>&1 &
```

- [ ] **Step 3: Run full UX flow via Playwright**

Use playwright-cli to:
1. Open `http://localhost:5173`, navigate to a project
2. Create a new run with a real prompt
3. Wait for the run to make commits (~30s)
4. Click into the run; verify Changes panel shows commits with file lists
5. Have the agent edit a file (or do it via `docker exec`); within 5s verify WIP appears in the WIP panel
6. Click a commit; verify file diff renders
7. From the More menu, trigger Polish; verify a child run appears in /siblings and starts running

Each verification step should produce zero 4xx/5xx responses in the playwright network log.

- [ ] **Step 4: Final commit + push**

```bash
git push
```

---

## Self-Review

**Spec coverage:**
- WIP snapshot mechanism → Task 11.
- Server-side git module structure (git.gleam / parse.gleam / repo.gleam) → Tasks 1–10.
- /changes assembly → Tasks 6–9, 15, 16.
- WIP endpoints (status/file/patch/discard) → Tasks 10, 14, 17.
- /file-diff and /commits/:sha/files → Tasks 12, 13.
- HistoryOp dispatch (squash-local, mirror-rebase, sync, merge, polish) → Tasks 19–22.
- Per-run mutex → Task 18.
- Error handling and edge cases → covered in handler implementations (404 if bare repo missing, null branch_base on missing default, GitUnavailable mapped to 503/git-unavailable, container-not-running 409 for /wip/discard).
- Deferrals (submodules, github integrations, caching, pushed precision) → enforced in handler code by returning empty arrays / `{}` / mirror-status mapping.
- Verification → Task 23.

No gaps.

**Placeholder scan:**
- Task 16 has a `let default = "main"` in Task 15 that was *intentionally* left and replaced in Task 16 — flagged by the note at the end of Task 15. Not a real placeholder; the work is sequenced.
- Task 22 has a refactor note about extending `Outcome` with `Agent(child_run_id)`. The plan tells the engineer exactly what to do (the second code block under Step 1). Not a placeholder.

**Type consistency:**
- `LogEntry`, `NameStatus`, `NumStat`, `Hunk`, `Line`, `StatusEntry` defined once each in `parse.gleam`, used consistently in repo.gleam and handlers.
- `FileEntry`, `BranchBase`, `WipSnapshot` defined once in `repo.gleam`.
- `GitError` (`ExitNonZero`, `GitUnavailable`) defined once in `git.gleam`.
- `Outcome` type evolves between Task 19 (initial 4 variants) and Task 22 (extended to 5 with `Agent`/`Conflict` carrying child_run_id). Task 22 explicitly calls this out as an extension.
- DB helper names: `insert_polish_run`, `insert_merge_conflict_run`, `count_active_children`, `children_of`, `ChildSummary` consistent across tasks 15, 21.
- `mutex.try_acquire` / `release` consistent between Task 18 and Task 22.
- Handler function names match router arms.

No inconsistencies found.
