import fbi/db/connection.{type DbError, SqlightError}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import simplifile
import sqlight

pub type Run {
  Run(
    id: Int,
    project_id: Int,
    prompt: String,
    branch_name: String,
    state: String,
    container_id: Option(String),
    log_path: String,
    exit_code: Option(Int),
    error: Option(String),
    head_commit: Option(String),
    started_at: Option(Int),
    finished_at: Option(Int),
    created_at: Int,
    state_entered_at: Int,
    model: Option(String),
    effort: Option(String),
    subagent_model: Option(String),
    resume_attempts: Int,
    next_resume_at: Option(Int),
    claude_session_id: Option(String),
    last_limit_reset_at: Option(Int),
    tokens_input: Int,
    tokens_output: Int,
    tokens_cache_read: Int,
    tokens_cache_create: Int,
    tokens_total: Int,
    usage_parse_errors: Int,
    title: Option(String),
    title_locked: Bool,
    parent_run_id: Option(Int),
    kind: String,
    kind_args_json: Option(String),
    mirror_status: Option(String),
    mock: Bool,
    mock_scenario: Option(String),
  )
}

pub type RunOutcome {
  RunOutcome(
    exit_code: Int,
    branch_pushed: Option(String),
    head_commit: Option(String),
    title: Option(String),
    error_message: Option(String),
    claude_session_id: Option(String),
  )
}

fn decoder() -> decode.Decoder(Run) {
  use id <- decode.field(0, decode.int)
  use project_id <- decode.field(1, decode.int)
  use prompt <- decode.field(2, decode.string)
  use branch_name <- decode.field(3, decode.string)
  use state <- decode.field(4, decode.string)
  use container_id <- decode.field(5, decode.optional(decode.string))
  use log_path <- decode.field(6, decode.string)
  use exit_code <- decode.field(7, decode.optional(decode.int))
  use error <- decode.field(8, decode.optional(decode.string))
  use head_commit <- decode.field(9, decode.optional(decode.string))
  use started_at <- decode.field(10, decode.optional(decode.int))
  use finished_at <- decode.field(11, decode.optional(decode.int))
  use created_at <- decode.field(12, decode.int)
  use state_entered_at <- decode.field(13, decode.int)
  use model <- decode.field(14, decode.optional(decode.string))
  use effort <- decode.field(15, decode.optional(decode.string))
  use subagent_model <- decode.field(16, decode.optional(decode.string))
  use resume_attempts <- decode.field(17, decode.int)
  use next_resume_at <- decode.field(18, decode.optional(decode.int))
  use claude_session_id <- decode.field(19, decode.optional(decode.string))
  use last_limit_reset_at <- decode.field(20, decode.optional(decode.int))
  use tokens_input <- decode.field(21, decode.int)
  use tokens_output <- decode.field(22, decode.int)
  use tokens_cache_read <- decode.field(23, decode.int)
  use tokens_cache_create <- decode.field(24, decode.int)
  use tokens_total <- decode.field(25, decode.int)
  use usage_parse_errors <- decode.field(26, decode.int)
  use title <- decode.field(27, decode.optional(decode.string))
  use title_locked_int <- decode.field(28, decode.int)
  use parent_run_id <- decode.field(29, decode.optional(decode.int))
  use kind <- decode.field(30, decode.string)
  use kind_args_json <- decode.field(31, decode.optional(decode.string))
  use mirror_status <- decode.field(32, decode.optional(decode.string))
  use mock_int <- decode.field(33, decode.int)
  use mock_scenario <- decode.field(34, decode.optional(decode.string))
  decode.success(Run(
    id:,
    project_id:,
    prompt:,
    branch_name:,
    state:,
    container_id:,
    log_path:,
    exit_code:,
    error:,
    head_commit:,
    started_at:,
    finished_at:,
    created_at:,
    state_entered_at:,
    model:,
    effort:,
    subagent_model:,
    resume_attempts:,
    next_resume_at:,
    claude_session_id:,
    last_limit_reset_at:,
    tokens_input:,
    tokens_output:,
    tokens_cache_read:,
    tokens_cache_create:,
    tokens_total:,
    usage_parse_errors:,
    title:,
    title_locked: title_locked_int != 0,
    parent_run_id:,
    kind:,
    kind_args_json:,
    mirror_status:,
    mock: mock_int != 0,
    mock_scenario:,
  ))
}

fn columns() -> String {
  "id, project_id, prompt, branch_name, state, container_id, log_path,
   exit_code, error, head_commit, started_at, finished_at,
   created_at, state_entered_at, model, effort, subagent_model,
   resume_attempts, next_resume_at, claude_session_id, last_limit_reset_at,
   tokens_input, tokens_output, tokens_cache_read, tokens_cache_create,
   tokens_total, usage_parse_errors, title, title_locked, parent_run_id,
   kind, kind_args_json, mirror_status, mock, mock_scenario"
}

const select_sql = "SELECT id, project_id, prompt, branch_name, state, container_id, log_path,
   exit_code, error, head_commit, started_at, finished_at,
   created_at, state_entered_at, model, effort, subagent_model,
   resume_attempts, next_resume_at, claude_session_id, last_limit_reset_at,
   tokens_input, tokens_output, tokens_cache_read, tokens_cache_create,
   tokens_total, usage_parse_errors, title, title_locked, parent_run_id,
   kind, kind_args_json, mirror_status, mock, mock_scenario
FROM runs"

pub fn list_non_terminal(db: sqlight.Connection) -> Result(List(Run), DbError) {
  connection.query_all(
    select_sql
      <> " WHERE state IN ('queued', 'running', 'waiting', 'awaiting_resume')",
    db,
    [],
    decoder(),
  )
}

pub fn list_due_resume(
  db: sqlight.Connection,
  now: Int,
) -> Result(List(Run), DbError) {
  connection.query_all(
    select_sql
      <> " WHERE state = 'awaiting_resume' AND next_resume_at IS NOT NULL AND next_resume_at <= ?",
    db,
    [sqlight.int(now)],
    decoder(),
  )
}

pub fn list(db: sqlight.Connection) -> Result(List(Run), DbError) {
  connection.query_all(
    select_sql <> " ORDER BY created_at DESC",
    db,
    [],
    decoder(),
  )
}

pub type ListFilter {
  ListFilter(
    state: Option(String),
    project_id: Option(Int),
    q: Option(String),
    limit: Option(Int),
    offset: Int,
  )
}

pub fn list_filtered(
  db: sqlight.Connection,
  filter: ListFilter,
) -> Result(List(Run), DbError) {
  let #(where, args) = build_where(filter)
  let limit_clause = case filter.limit {
    Some(n) ->
      " LIMIT "
      <> int.to_string(n)
      <> " OFFSET "
      <> int.to_string(filter.offset)
    None -> ""
  }
  connection.query_all(
    select_sql <> where <> " ORDER BY created_at DESC" <> limit_clause,
    db,
    args,
    decoder(),
  )
}

pub fn count_filtered(
  db: sqlight.Connection,
  filter: ListFilter,
) -> Result(Int, DbError) {
  let #(where, args) = build_where(filter)
  connection.query_one(
    "SELECT COUNT(*) FROM runs" <> where,
    db,
    args,
    decode.at([0], decode.int),
  )
}

fn build_where(filter: ListFilter) -> #(String, List(sqlight.Value)) {
  let clauses = []
  let args = []
  let #(clauses, args) = case filter.state {
    Some(s) -> #(["state = ?", ..clauses], [sqlight.text(s), ..args])
    None -> #(clauses, args)
  }
  let #(clauses, args) = case filter.project_id {
    Some(pid) -> #(["project_id = ?", ..clauses], [sqlight.int(pid), ..args])
    None -> #(clauses, args)
  }
  let #(clauses, args) = case filter.q {
    Some(q) if q != "" -> {
      let pattern = "%" <> q <> "%"
      #(
        [
          "(prompt LIKE ? OR branch_name LIKE ? OR CAST(id AS TEXT) = ?)",
          ..clauses
        ],
        [sqlight.text(pattern), sqlight.text(pattern), sqlight.text(q), ..args],
      )
    }
    _ -> #(clauses, args)
  }
  case clauses {
    [] -> #("", [])
    _ -> #(" WHERE " <> string.join(clauses, " AND "), args)
  }
}

pub type RecentPrompt {
  RecentPrompt(prompt: String, last_used_at: Int, run_id: Int)
}

pub fn recent_prompts(
  db: sqlight.Connection,
  project_id: Int,
  limit: Int,
) -> Result(List(RecentPrompt), DbError) {
  let rp_decoder = {
    use prompt <- decode.field(0, decode.string)
    use last_used_at <- decode.field(1, decode.int)
    use run_id <- decode.field(2, decode.int)
    decode.success(RecentPrompt(
      prompt: prompt,
      last_used_at: last_used_at,
      run_id: run_id,
    ))
  }
  connection.query_all(
    "SELECT prompt, MAX(created_at) AS last_used, MAX(id) AS run_id
     FROM runs
     WHERE project_id = ? AND prompt != '' AND kind != 'continue'
     GROUP BY prompt
     ORDER BY last_used DESC
     LIMIT ?",
    db,
    [sqlight.int(project_id), sqlight.int(limit)],
    rp_decoder,
  )
}

pub fn list_for_project(
  db: sqlight.Connection,
  project_id: Int,
) -> Result(List(Run), DbError) {
  connection.query_all(
    select_sql <> " WHERE project_id = ? ORDER BY created_at DESC",
    db,
    [sqlight.int(project_id)],
    decoder(),
  )
}

pub fn get(db: sqlight.Connection, id: Int) -> Result(Run, DbError) {
  connection.query_one(
    select_sql <> " WHERE id = ?",
    db,
    [sqlight.int(id)],
    decoder(),
  )
}

pub fn siblings(
  db: sqlight.Connection,
  run_id: Int,
) -> Result(List(Run), DbError) {
  connection.query_all(
    "SELECT "
      <> columns()
      <> " FROM runs WHERE parent_run_id = (SELECT parent_run_id FROM runs WHERE id = ?) ORDER BY created_at",
    db,
    [sqlight.int(run_id)],
    decoder(),
  )
}

pub fn patch_title(
  db: sqlight.Connection,
  id: Int,
  title: String,
  title_locked: Bool,
) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET title = ?, title_locked = ? WHERE id = ? RETURNING "
      <> columns(),
    db,
    [
      sqlight.text(title),
      sqlight.int(case title_locked {
        True -> 1
        False -> 0
      }),
      sqlight.int(id),
    ],
    decoder(),
  )
}

pub fn delete(db: sqlight.Connection, id: Int) -> Result(Nil, DbError) {
  sqlight.query(
    "DELETE FROM runs WHERE id = ?",
    on: db,
    with: [sqlight.int(id)],
    expecting: decode.at([0], decode.int),
  )
  |> result.map_error(SqlightError)
  |> result.map(fn(_) { Nil })
}

pub fn insert_run(
  db: sqlight.Connection,
  project_id: Int,
  prompt: String,
  branch: option.Option(String),
  model: Option(String),
  effort: Option(String),
  subagent_model: Option(String),
  mock: Bool,
  mock_scenario: Option(String),
  now: Int,
) -> Result(Run, DbError) {
  let log_path = "/var/log/fbi/runs/" <> int.to_string(now) <> ".log"
  use run <- result.try(connection.query_one(
    "INSERT INTO runs (project_id, prompt, branch_name, state, log_path, created_at, state_entered_at, model, effort, subagent_model, mock, mock_scenario)
     VALUES (?, ?, '', 'queued', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING "
      <> columns(),
    db,
    [
      sqlight.int(project_id),
      sqlight.text(prompt),
      sqlight.text(log_path),
      sqlight.int(now),
      sqlight.int(now),
      nullable_opt(model),
      nullable_opt(effort),
      nullable_opt(subagent_model),
      sqlight.int(case mock {
        True -> 1
        False -> 0
      }),
      nullable_opt(mock_scenario),
    ],
    decoder(),
  ))
  let branch_name = case branch {
    option.Some(b) -> b
    option.None -> "claude/run-" <> int.to_string(run.id)
  }
  connection.query_one(
    "UPDATE runs SET branch_name = ? WHERE id = ? RETURNING " <> columns(),
    db,
    [sqlight.text(branch_name), sqlight.int(run.id)],
    decoder(),
  )
}

pub fn branch_in_use(
  db: sqlight.Connection,
  branch: String,
) -> Result(Bool, DbError) {
  connection.query_one(
    "SELECT COUNT(*) FROM runs WHERE branch_name = ? AND state IN ('queued', 'running', 'waiting', 'awaiting_resume')",
    db,
    [sqlight.text(branch)],
    decode.at([0], decode.int),
  )
  |> result.map(fn(n) { n > 0 })
}

pub fn insert_continue_run(
  db: sqlight.Connection,
  parent: Run,
  model: Option(String),
  effort: Option(String),
  subagent_model: Option(String),
  session_id: String,
  now: Int,
) -> Result(Run, DbError) {
  let args_json =
    json.object([#("session_id", json.string(session_id))])
    |> json.to_string()
  let effective_model = case model {
    option.None -> parent.model
    some -> some
  }
  let effective_effort = case effort {
    option.None -> parent.effort
    some -> some
  }
  let effective_subagent = case subagent_model {
    option.None -> parent.subagent_model
    some -> some
  }
  connection.query_one("INSERT INTO runs
       (project_id, prompt, branch_name, state, log_path, created_at,
        state_entered_at, model, effort, subagent_model,
        parent_run_id, kind, kind_args_json, mock, mock_scenario)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 'continue', ?, ?, ?)
     RETURNING " <> columns(), db, [
    sqlight.int(parent.project_id),
    sqlight.text(parent.prompt),
    sqlight.text(parent.branch_name),
    sqlight.text("/var/log/fbi/runs/" <> int.to_string(now) <> ".log"),
    sqlight.int(now),
    sqlight.int(now),
    nullable_opt(effective_model),
    nullable_opt(effective_effort),
    nullable_opt(effective_subagent),
    sqlight.int(parent.id),
    sqlight.text(args_json),
    sqlight.int(case parent.mock {
      True -> 1
      False -> 0
    }),
    nullable_opt(parent.mock_scenario),
  ], decoder())
}

pub fn increment_resume_attempts(
  db: sqlight.Connection,
  id: Int,
) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET resume_attempts = resume_attempts + 1 WHERE id = ? RETURNING "
      <> columns(),
    db,
    [sqlight.int(id)],
    decoder(),
  )
}

/// Set claude_session_id only if currently NULL. Used when the actor sees the
/// `/fbi-state/session-id` file dropped by quantico/supervisor.sh — needed for
/// runs that signal awaiting_resume mid-flight (e.g. limit-breach + sleep_forever)
/// before result.json gets written. Idempotent: a no-op if already set.
pub fn set_session_id_if_null(
  db: sqlight.Connection,
  id: Int,
  session_id: String,
) -> Result(Nil, DbError) {
  sqlight.query(
    "UPDATE runs SET claude_session_id = ? WHERE id = ? AND claude_session_id IS NULL",
    on: db,
    with: [sqlight.text(session_id), sqlight.int(id)],
    expecting: decode.at([0], decode.int),
  )
  |> result.map_error(SqlightError)
  |> result.map(fn(_) { Nil })
}

pub fn mark_state(
  db: sqlight.Connection,
  id: Int,
  state: String,
  now: Int,
) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET state = ?, state_entered_at = ? WHERE id = ? RETURNING "
      <> columns(),
    db,
    [sqlight.text(state), sqlight.int(now), sqlight.int(id)],
    decoder(),
  )
}

pub fn mark_running(
  db: sqlight.Connection,
  id: Int,
  container_id: String,
  now: Int,
) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET state = 'running', container_id = ?, state_entered_at = ?,
     started_at = COALESCE(started_at, ?) WHERE id = ? RETURNING " <> columns(),
    db,
    [
      sqlight.text(container_id),
      sqlight.int(now),
      sqlight.int(now),
      sqlight.int(id),
    ],
    decoder(),
  )
}

pub fn mark_finished(
  db: sqlight.Connection,
  id: Int,
  outcome: RunOutcome,
  now: Int,
) -> Result(Run, DbError) {
  let state = case outcome.exit_code {
    0 -> "succeeded"
    _ -> "failed"
  }
  connection.query_one(
    "UPDATE runs SET state = ?, exit_code = ?, branch_name = COALESCE(?, branch_name),
     head_commit = ?, finished_at = ?, error = ?,
     title = COALESCE(?, title),
     claude_session_id = COALESCE(?, claude_session_id)
     WHERE id = ? RETURNING "
      <> columns(),
    db,
    [
      sqlight.text(state),
      sqlight.int(outcome.exit_code),
      case outcome.branch_pushed {
        option.None -> sqlight.null()
        option.Some(b) -> sqlight.text(b)
      },
      case outcome.head_commit {
        option.None -> sqlight.null()
        option.Some(c) -> sqlight.text(c)
      },
      sqlight.int(now),
      case outcome.error_message {
        option.None -> sqlight.null()
        option.Some(e) -> sqlight.text(e)
      },
      case outcome.title {
        option.None -> sqlight.null()
        option.Some(t) -> sqlight.text(t)
      },
      case outcome.claude_session_id {
        option.None -> sqlight.null()
        option.Some(s) -> sqlight.text(s)
      },
      sqlight.int(id),
    ],
    decoder(),
  )
}

pub fn mark_failed(
  db: sqlight.Connection,
  id: Int,
  reason: String,
  now: Int,
) -> Result(Run, DbError) {
  connection.query_one(
    "UPDATE runs SET state = 'failed', error = ?, finished_at = ? WHERE id = ? RETURNING "
      <> columns(),
    db,
    [sqlight.text(reason), sqlight.int(now), sqlight.int(id)],
    decoder(),
  )
}

fn nullable_opt(opt: Option(String)) -> sqlight.Value {
  case opt {
    option.None -> sqlight.null()
    option.Some(v) -> sqlight.text(v)
  }
}

pub type ChildSummary {
  ChildSummary(id: Int, kind: String, state: String, created_at: Int)
}

pub fn children_of(
  db: sqlight.Connection,
  run_id: Int,
) -> Result(List(ChildSummary), DbError) {
  let dec = {
    use id <- decode.field(0, decode.int)
    use kind <- decode.field(1, decode.string)
    use state <- decode.field(2, decode.string)
    use created_at <- decode.field(3, decode.int)
    decode.success(ChildSummary(id, kind, state, created_at))
  }
  connection.query_all(
    "SELECT id, kind, state, created_at FROM runs WHERE parent_run_id = ? ORDER BY created_at",
    db,
    [sqlight.int(run_id)],
    dec,
  )
}

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
  connection.query_one("INSERT INTO runs
       (project_id, prompt, branch_name, state, log_path, created_at,
        state_entered_at, parent_run_id, kind)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
     RETURNING " <> columns(), db, [
    sqlight.int(parent.project_id),
    sqlight.text(prompt),
    sqlight.text(parent.branch_name),
    sqlight.text(log_path),
    sqlight.int(now),
    sqlight.int(now),
    sqlight.int(parent.id),
    sqlight.text(kind),
  ], decoder())
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
