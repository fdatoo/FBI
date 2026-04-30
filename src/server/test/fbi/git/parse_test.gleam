import fbi/git/parse
import gleam/list
import gleeunit/should

pub fn parse_log_porcelain_two_commits_test() {
  let input =
    "abc123\u{0000}first commit\u{0000}1700000001\nde4567\u{0000}second commit\u{0000}1700000002\n"
  let parsed = parse.parse_log_porcelain(input)
  parsed
  |> should.equal([
    parse.LogEntry(
      sha: "abc123",
      subject: "first commit",
      committed_at: 1_700_000_001,
    ),
    parse.LogEntry(
      sha: "de4567",
      subject: "second commit",
      committed_at: 1_700_000_002,
    ),
  ])
}

pub fn parse_log_porcelain_empty_test() {
  parse.parse_log_porcelain("") |> should.equal([])
}

pub fn parse_log_porcelain_handles_nul_in_subject_test() {
  let input = "abc\u{0000}only-two-fields\nde4\u{0000}good\u{0000}1700000003\n"
  let parsed = parse.parse_log_porcelain(input)
  parsed
  |> should.equal([
    parse.LogEntry(sha: "de4", subject: "good", committed_at: 1_700_000_003),
  ])
}

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
  let input = "-\t-\tlogo.png\n"
  parse.parse_numstat(input)
  |> should.equal([parse.NumStat(additions: 0, deletions: 0, path: "logo.png")])
}

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
    "@@ -1 +1 @@\n" <> "-a\n" <> "\\ No newline at end of file\n" <> "+b\n"
  let hunks = parse.parse_diff_hunks(input)
  let assert [hunk] = hunks
  hunk.lines
  |> should.equal([
    parse.Line(kind: "del", text: "a"),
    parse.Line(kind: "add", text: "b"),
  ])
}

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
