import fbi/config.{type Config}
import fbi/db/connection
import fbi/db/usage as usage_db
import fbi/pubsub
import fbi/run/types.{type BroadcastMsg, BroadcastEvent, UsageSnap}
import fbi/usage_parser
import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/result
import gleam/string
import simplifile
import sqlight
import wisp

const poll_interval_ms = 2000

pub type TailerMsg {
  Tick
  Stop
}

type State {
  State(
    run_id: Int,
    mount_dir: String,
    db: sqlight.Connection,
    pubsub: Subject(pubsub.PubsubMsg),
    broadcaster: Subject(BroadcastMsg),
    offsets: Dict(String, Int),
    self: Subject(TailerMsg),
  )
}

pub fn start(
  run_id: Int,
  config: Config,
  db: sqlight.Connection,
  pubsub_subject: Subject(pubsub.PubsubMsg),
  broadcaster: Subject(BroadcastMsg),
) -> Result(Subject(TailerMsg), actor.StartError) {
  let mount_dir = config.runs_dir <> "/" <> int.to_string(run_id) <> "/mount"
  actor.new_with_initialiser(500, fn(subject) {
    process.send_after(subject, poll_interval_ms, Tick)
    State(
      run_id: run_id,
      mount_dir: mount_dir,
      db: db,
      pubsub: pubsub_subject,
      broadcaster: broadcaster,
      offsets: dict.new(),
      self: subject,
    )
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: TailerMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: TailerMsg) -> actor.Next(State, TailerMsg) {
  case msg {
    Tick -> {
      let new_offsets = sweep(state)
      process.send_after(state.self, poll_interval_ms, Tick)
      actor.continue(State(..state, offsets: new_offsets))
    }
    Stop -> {
      let _ = sweep(state)
      actor.stop()
    }
  }
}

// ── Filesystem sweep ─────────────────────────────────────────────────────────

fn sweep(state: State) -> Dict(String, Int) {
  let paths = collect_jsonl_files(state.mount_dir)
  list.fold(paths, state.offsets, fn(offsets, path) {
    let current_offset = dict.get(offsets, path) |> result.unwrap(0)
    let new_offset = process_file(state, path, current_offset)
    dict.insert(offsets, path, new_offset)
  })
}

fn collect_jsonl_files(dir: String) -> List(String) {
  case simplifile.read_directory(dir) {
    Error(_) -> []
    Ok(entries) ->
      list.flat_map(entries, fn(entry) {
        let path = dir <> "/" <> entry
        case simplifile.is_directory(path) {
          Ok(True) -> collect_jsonl_files(path)
          _ ->
            case string.ends_with(entry, ".jsonl") {
              True -> [path]
              False -> []
            }
        }
      })
  }
}

fn process_file(state: State, path: String, offset: Int) -> Int {
  case simplifile.read_bits(path) {
    Error(_) -> offset
    Ok(bits) -> {
      let total_bytes = bit_array.byte_size(bits)
      case total_bytes <= offset {
        True -> offset
        False -> {
          let new_bytes_count = total_bytes - offset
          case bit_array.slice(bits, offset, new_bytes_count) {
            Error(_) -> offset
            Ok(new_bits) ->
              case bit_array.to_string(new_bits) {
                Error(_) -> offset
                Ok(chunk) -> {
                  let all_parts = string.split(chunk, "\n")
                  // Consume only complete lines (everything before the last element,
                  // which may be an unterminated partial line).
                  let #(complete, _partial) = split_last(all_parts)
                  let consumed =
                    list.fold(complete, 0, fn(acc, l) {
                      // +1 for the \n that was stripped by string.split
                      acc + string.byte_size(l) + 1
                    })
                  list.each(complete, fn(line) { process_line(state, line) })
                  offset + consumed
                }
              }
          }
        }
      }
    }
  }
}

fn split_last(parts: List(String)) -> #(List(String), String) {
  case list.reverse(parts) {
    [] -> #([], "")
    [last, ..rest] -> #(list.reverse(rest), last)
  }
}

// ── Line processing ───────────────────────────────────────────────────────────

fn process_line(state: State, line: String) -> Nil {
  let now = now_ms()
  case usage_parser.parse_line(line) {
    usage_parser.SkipLine -> Nil
    usage_parser.ErrorLine(reason) -> {
      wisp.log_debug(
        "run "
        <> int.to_string(state.run_id)
        <> " usage parse error: "
        <> reason,
      )
      let _ = usage_db.bump_parse_errors(state.db, state.run_id)
      Nil
    }
    usage_parser.UsageLine(usage: event, rate_limits: rl) -> {
      case usage_db.insert_event(state.db, state.run_id, now, event, rl) {
        Error(e) ->
          wisp.log_warning(
            "run "
            <> int.to_string(state.run_id)
            <> " usage db error: "
            <> connection.describe_error(e),
          )
        Ok(_) -> Nil
      }

      // Live broadcast to this run's WebSocket subscribers
      process.send(
        state.broadcaster,
        BroadcastEvent(UsageSnap(
          model: event.model,
          input_tokens: event.input_tokens,
          output_tokens: event.output_tokens,
          cache_read_tokens: event.cache_read_tokens,
          cache_create_tokens: event.cache_create_tokens,
        )),
      )

      // Rate-limit bucket update
      case rl {
        None -> Nil
        Some(fields) -> process_rate_limits(state, fields, now)
      }
    }
  }
}

fn process_rate_limits(
  state: State,
  rl: usage_parser.RateLimitFields,
  now: Int,
) -> Nil {
  let _ = usage_db.upsert_rate_limit_state(state.db, None, now)

  let utilization =
    derive_utilization(rl.tokens_remaining, rl.tokens_limit)
    |> option.or(derive_utilization(rl.requests_remaining, rl.requests_limit))

  case utilization {
    None -> Nil
    Some(util) -> {
      // Derive window_started_at from reset_at - 5h
      let window_started = case rl.reset_at {
        None -> None
        Some(reset) -> Some(reset - five_hour_window_ms)
      }

      let bucket_result =
        usage_db.upsert_bucket(state.db, "five_hour", util, rl.reset_at, now)

      // Persist window_started_at on first observation
      case window_started {
        None -> Nil
        Some(ws) -> {
          let _ =
            sqlight.query(
              "UPDATE rate_limit_buckets SET window_started_at = ? WHERE bucket_id = 'five_hour' AND window_started_at IS NULL",
              on: state.db,
              with: [sqlight.int(ws)],
              expecting: decode.dynamic,
            )
          Nil
        }
      }

      let state_value = usage_db.get_usage_state_value(state.db, now_ms())
      let snapshot_msg =
        json.object([
          #("type", json.string("snapshot")),
          #("state", state_value),
        ])
        |> json.to_string()

      publish_usage(state.pubsub, snapshot_msg)

      case bucket_result {
        Ok(usage_db.ThresholdCrossed(bid, thresh, reset)) -> {
          let threshold_msg =
            json.object([
              #("type", json.string("threshold_crossed")),
              #("bucket_id", json.string(bid)),
              #("threshold", json.int(thresh)),
              #("reset_at", json.nullable(reset, json.int)),
            ])
            |> json.to_string()
          publish_usage(state.pubsub, threshold_msg)
        }
        _ -> Nil
      }
    }
  }
}

fn derive_utilization(
  remaining: Option(Int),
  limit: Option(Int),
) -> Option(Float) {
  case remaining, limit {
    Some(rem), Some(lim) if lim > 0 ->
      Some(1.0 -. int.to_float(rem) /. int.to_float(lim))
    _, _ -> None
  }
}

fn publish_usage(ps: Subject(pubsub.PubsubMsg), msg: String) -> Nil {
  process.send(ps, pubsub.Publish(topic: "usage", message: to_dynamic(msg)))
}

// ── FFI ───────────────────────────────────────────────────────────────────────

const five_hour_window_ms = 18_000_000

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int

/// Cast a String to Dynamic — safe because Gleam strings are Erlang binaries,
/// which decode correctly with decode.string on the subscriber side.
@external(erlang, "fbi_time", "to_dynamic")
fn to_dynamic(s: String) -> Dynamic
