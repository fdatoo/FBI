import gleam/int
import gleam/list
import gleam/option
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

pub type Line {
  Line(kind: String, text: String)
}

pub type Hunk {
  Hunk(header: String, lines: List(Line))
}

pub fn parse_diff_hunks(s: String) -> List(Hunk) {
  let lines = string.split(s, "\n")
  do_parse_hunks(lines, option.None, [], [])
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
        option.Some(h) -> [
          Hunk(header: h, lines: list.reverse(current_lines)),
          ..acc
        ]
        option.None -> acc
      }
    [line, ..rest] ->
      case classify_line(line) {
        HunkHeader(h) -> {
          let acc2 = case current_header {
            option.Some(prev) -> [
              Hunk(header: prev, lines: list.reverse(current_lines)),
              ..acc
            ]
            option.None -> acc
          }
          do_parse_hunks(rest, option.Some(h), [], acc2)
        }
        HunkLine(l) ->
          do_parse_hunks(rest, current_header, [l, ..current_lines], acc)
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
        Ok("?") ->
          Ok(StatusEntry(status: "U", path: string.drop_start(rec, 1)))
        Ok("1") -> parse_v2_ordinary(rec)
        Ok("2") -> parse_v2_rename(rec)
        Ok("u") -> parse_v2_unmerged(rec)
        _ -> Error(Nil)
      }
  }
}

fn parse_v2_ordinary(rec: String) -> Result(StatusEntry, Nil) {
  case string.split(rec, " ") {
    ["1", xy, ..rest] -> {
      let path = string.join(list.drop(rest, 6), " ")
      Ok(StatusEntry(status: status_xy(xy), path: path))
    }
    _ -> Error(Nil)
  }
}

fn parse_v2_rename(rec: String) -> Result(StatusEntry, Nil) {
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
