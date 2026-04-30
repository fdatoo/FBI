import fbi/db/connection.{type DbError, SqlightError}
import fbi/usage_parser.{type RateLimitFields, type UsageEvent}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import sqlight

// ── Insert a usage event and atomically update run token totals ───────────────

pub fn insert_event(
  db: sqlight.Connection,
  run_id: Int,
  ts: Int,
  event: UsageEvent,
  rl: Option(RateLimitFields),
) -> Result(Nil, DbError) {
  let rl_req_rem = option.then(rl, fn(r) { r.requests_remaining })
  let rl_req_lim = option.then(rl, fn(r) { r.requests_limit })
  let rl_tok_rem = option.then(rl, fn(r) { r.tokens_remaining })
  let rl_tok_lim = option.then(rl, fn(r) { r.tokens_limit })
  let rl_reset = option.then(rl, fn(r) { r.reset_at })

  // Insert the raw event row
  use _ <- result.try(
    sqlight.query(
      "INSERT INTO run_usage_events
         (run_id, ts, model,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          rl_requests_remaining, rl_requests_limit,
          rl_tokens_remaining, rl_tokens_limit, rl_reset_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      on: db,
      with: [
        sqlight.int(run_id),
        sqlight.int(ts),
        sqlight.text(event.model),
        sqlight.int(event.input_tokens),
        sqlight.int(event.output_tokens),
        sqlight.int(event.cache_read_tokens),
        sqlight.int(event.cache_create_tokens),
        nullable_int(rl_req_rem),
        nullable_int(rl_req_lim),
        nullable_int(rl_tok_rem),
        nullable_int(rl_tok_lim),
        nullable_int(rl_reset),
      ],
      expecting: decode.dynamic,
    )
    |> result.map_error(SqlightError)
    |> result.map(fn(_) { Nil }),
  )

  // Atomically accumulate on the run row
  let total =
    event.input_tokens
    + event.output_tokens
    + event.cache_read_tokens
    + event.cache_create_tokens
  sqlight.query(
    "UPDATE runs SET
       tokens_input        = tokens_input        + ?,
       tokens_output       = tokens_output       + ?,
       tokens_cache_read   = tokens_cache_read   + ?,
       tokens_cache_create = tokens_cache_create + ?,
       tokens_total        = tokens_total        + ?
     WHERE id = ?",
    on: db,
    with: [
      sqlight.int(event.input_tokens),
      sqlight.int(event.output_tokens),
      sqlight.int(event.cache_read_tokens),
      sqlight.int(event.cache_create_tokens),
      sqlight.int(total),
      sqlight.int(run_id),
    ],
    expecting: decode.dynamic,
  )
  |> result.map_error(SqlightError)
  |> result.map(fn(_) { Nil })
}

pub fn bump_parse_errors(
  db: sqlight.Connection,
  run_id: Int,
) -> Result(Nil, DbError) {
  sqlight.query(
    "UPDATE runs SET usage_parse_errors = usage_parse_errors + 1 WHERE id = ?",
    on: db,
    with: [sqlight.int(run_id)],
    expecting: decode.dynamic,
  )
  |> result.map_error(SqlightError)
  |> result.map(fn(_) { Nil })
}

// ── Rate-limit state ──────────────────────────────────────────────────────────

pub type UpsertBucketResult {
  BucketUpdated
  ThresholdCrossed(bucket_id: String, threshold: Int, reset_at: Option(Int))
}

pub fn upsert_rate_limit_state(
  db: sqlight.Connection,
  plan: Option(String),
  observed_at: Int,
) -> Result(Nil, DbError) {
  sqlight.query(
    "INSERT INTO rate_limit_state (id, plan, observed_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       plan        = COALESCE(excluded.plan, rate_limit_state.plan),
       observed_at = excluded.observed_at",
    on: db,
    with: [nullable_str(plan), sqlight.int(observed_at)],
    expecting: decode.dynamic,
  )
  |> result.map_error(SqlightError)
  |> result.map(fn(_) { Nil })
}

pub fn upsert_bucket(
  db: sqlight.Connection,
  bucket_id: String,
  utilization: Float,
  reset_at: Option(Int),
  observed_at: Int,
) -> Result(UpsertBucketResult, DbError) {
  // Read current threshold marker before upsert
  let old_threshold_result =
    sqlight.query(
      "SELECT last_notified_threshold FROM rate_limit_buckets WHERE bucket_id = ?",
      on: db,
      with: [sqlight.text(bucket_id)],
      expecting: decode.at([0], decode.optional(decode.int)),
    )
    |> result.map_error(SqlightError)

  use _ <- result.try(
    sqlight.query(
      "INSERT INTO rate_limit_buckets
         (bucket_id, utilization, reset_at, observed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket_id) DO UPDATE SET
         utilization  = excluded.utilization,
         reset_at     = excluded.reset_at,
         observed_at  = excluded.observed_at",
      on: db,
      with: [
        sqlight.text(bucket_id),
        sqlight.float(utilization),
        nullable_int(reset_at),
        sqlight.int(observed_at),
      ],
      expecting: decode.dynamic,
    )
    |> result.map_error(SqlightError)
    |> result.map(fn(_) { Nil }),
  )

  let pct = float_to_pct(utilization)
  let old_threshold = case old_threshold_result {
    Ok([Some(t), ..]) -> t
    Ok([None, ..]) -> 0
    _ -> 0
  }

  // Check if we just crossed a new threshold (75 or 90)
  let new_threshold = case pct >= 90, pct >= 75 {
    True, _ -> 90
    False, True -> 75
    False, False -> 0
  }

  case new_threshold > old_threshold && new_threshold > 0 {
    False -> Ok(BucketUpdated)
    True -> {
      // Persist the notification marker
      let _ =
        sqlight.query(
          "UPDATE rate_limit_buckets SET last_notified_threshold = ? WHERE bucket_id = ?",
          on: db,
          with: [sqlight.int(new_threshold), sqlight.text(bucket_id)],
          expecting: decode.dynamic,
        )
      Ok(ThresholdCrossed(
        bucket_id: bucket_id,
        threshold: new_threshold,
        reset_at: reset_at,
      ))
    }
  }
}

// ── Full usage state (for GET /api/usage and WS snapshots) ───────────────────

pub type UsageStateRow {
  UsageStateRow(
    plan: Option(String),
    observed_at: Option(Int),
    last_error: Option(String),
    last_error_at: Option(Int),
  )
}

pub type BucketRow {
  BucketRow(
    id: String,
    utilization: Float,
    reset_at: Option(Int),
    window_started_at: Option(Int),
  )
}

/// Returns the full UsageState as a json.Json value (not yet serialised).
/// Callers can embed it in a larger envelope or call json.to_string().
pub fn get_usage_state_value(db: sqlight.Connection, now_ms: Int) -> json.Json {
  let state = load_state_row(db)
  let buckets = load_bucket_rows(db)
  encode_usage_state(state, buckets, now_ms)
}

/// Convenience: returns the state as a serialised JSON string.
pub fn get_usage_state_json(db: sqlight.Connection, now_ms: Int) -> String {
  get_usage_state_value(db, now_ms) |> json.to_string()
}

fn load_state_row(db: sqlight.Connection) -> UsageStateRow {
  let row_decoder = {
    use plan <- decode.field(0, decode.optional(decode.string))
    use observed_at <- decode.field(1, decode.optional(decode.int))
    use last_error <- decode.field(2, decode.optional(decode.string))
    use last_error_at <- decode.field(3, decode.optional(decode.int))
    decode.success(UsageStateRow(
      plan: plan,
      observed_at: observed_at,
      last_error: last_error,
      last_error_at: last_error_at,
    ))
  }
  case
    sqlight.query(
      "SELECT plan, observed_at, last_error, last_error_at FROM rate_limit_state WHERE id = 1",
      on: db,
      with: [],
      expecting: row_decoder,
    )
  {
    Ok([row, ..]) -> row
    _ ->
      UsageStateRow(
        plan: None,
        observed_at: None,
        last_error: Some("missing_credentials"),
        last_error_at: None,
      )
  }
}

fn load_bucket_rows(db: sqlight.Connection) -> List(BucketRow) {
  let row_decoder = {
    use id <- decode.field(0, decode.string)
    use util <- decode.field(1, decode.float)
    use reset_at <- decode.field(2, decode.optional(decode.int))
    use window_started_at <- decode.field(3, decode.optional(decode.int))
    decode.success(BucketRow(
      id: id,
      utilization: util,
      reset_at: reset_at,
      window_started_at: window_started_at,
    ))
  }
  case
    sqlight.query(
      "SELECT bucket_id, utilization, reset_at, window_started_at FROM rate_limit_buckets ORDER BY bucket_id",
      on: db,
      with: [],
      expecting: row_decoder,
    )
  {
    Ok(rows) -> rows
    Error(_) -> []
  }
}

fn encode_usage_state(
  state: UsageStateRow,
  buckets: List(BucketRow),
  now_ms: Int,
) -> json.Json {
  let pacing_entries =
    list.map(buckets, fn(b) { #(b.id, pacing_for_bucket(b, now_ms)) })

  json.object([
    #("plan", json.nullable(state.plan, json.string)),
    #("observed_at", json.nullable(state.observed_at, json.int)),
    #("last_error", json.nullable(state.last_error, json.string)),
    #("last_error_at", json.nullable(state.last_error_at, json.int)),
    #(
      "buckets",
      json.array(buckets, fn(b) {
        json.object([
          #("id", json.string(b.id)),
          #("utilization", json.float(b.utilization)),
          #("reset_at", json.nullable(b.reset_at, json.int)),
          #("window_started_at", json.nullable(b.window_started_at, json.int)),
        ])
      }),
    ),
    #(
      "pacing",
      json.object(
        list.map(pacing_entries, fn(entry) {
          let #(id, verdict) = entry
          #(id, encode_pacing(verdict))
        }),
      ),
    ),
  ])
}

// ── Pacing computation ────────────────────────────────────────────────────────

type PacingZone {
  Chill
  OnTrack
  Hot
  NoPacing
}

type PacingVerdict {
  PacingVerdict(delta: Float, zone: PacingZone)
}

fn pacing_for_bucket(b: BucketRow, now_ms: Int) -> PacingVerdict {
  case b.window_started_at, b.reset_at {
    Some(started), Some(reset) -> {
      let window_duration = reset - started
      case window_duration > 0 {
        False -> PacingVerdict(delta: 0.0, zone: NoPacing)
        True -> {
          let elapsed = now_ms - started
          let elapsed_frac =
            int.to_float(elapsed) /. int.to_float(window_duration)
          let elapsed_frac = float.max(0.0, float.min(1.0, elapsed_frac))
          let delta = b.utilization -. elapsed_frac
          let zone = case delta >=. 0.25 {
            True -> Hot
            False ->
              case delta <=. -0.2 {
                True -> Chill
                False -> OnTrack
              }
          }
          PacingVerdict(delta: delta, zone: zone)
        }
      }
    }
    _, _ -> PacingVerdict(delta: 0.0, zone: NoPacing)
  }
}

fn encode_pacing(v: PacingVerdict) -> json.Json {
  json.object([
    #("delta", json.float(v.delta)),
    #(
      "zone",
      json.string(case v.zone {
        Chill -> "chill"
        OnTrack -> "on_track"
        Hot -> "hot"
        NoPacing -> "none"
      }),
    ),
  ])
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn nullable_int(opt: Option(Int)) -> sqlight.Value {
  case opt {
    None -> sqlight.null()
    Some(n) -> sqlight.int(n)
  }
}

fn nullable_str(opt: Option(String)) -> sqlight.Value {
  case opt {
    None -> sqlight.null()
    Some(s) -> sqlight.text(s)
  }
}

fn float_to_pct(f: Float) -> Int {
  float.round(f *. 100.0)
}
