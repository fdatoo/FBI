import fbi/config.{type Config}
import fbi/db/usage as usage_db
import fbi/pubsub
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/http/request
import gleam/httpc
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/result
import simplifile
import sqlight
import wisp

const usage_url = "https://api.anthropic.com/api/oauth/usage"

// Anthropic rate-limits this endpoint: stay well below once-per-5min.
const poll_interval_ms = 300_000

const five_hour_window_ms = 18_000_000

pub type PollerMsg {
  Tick
  Stop
}

type State {
  State(
    db: sqlight.Connection,
    pubsub: Subject(pubsub.PubsubMsg),
    claude_dir: Option(String),
    self: Subject(PollerMsg),
  )
}

pub fn start(
  config: Config,
  db: sqlight.Connection,
  pubsub_subject: Subject(pubsub.PubsubMsg),
) -> Result(Subject(PollerMsg), actor.StartError) {
  actor.new_with_initialiser(500, fn(subject) {
    process.send_after(subject, 0, Tick)
    State(
      db: db,
      pubsub: pubsub_subject,
      claude_dir: config.claude_dir,
      self: subject,
    )
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: PollerMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: PollerMsg) -> actor.Next(State, PollerMsg) {
  case msg {
    Tick -> {
      tick(state)
      process.send_after(state.self, poll_interval_ms, Tick)
      actor.continue(state)
    }
    Stop -> actor.stop()
  }
}

fn tick(state: State) -> Nil {
  case state.claude_dir {
    None -> {
      wisp.log_debug("usage poller: HOST_CLAUDE_DIR not set, skipping")
      Nil
    }
    Some(dir) ->
      case read_token(dir) {
        Error(reason) -> {
          wisp.log_debug("usage poller: credentials: " <> reason)
          let _ = usage_db.upsert_rate_limit_error(state.db, reason, now_ms())
          Nil
        }
        Ok(token) -> fetch_and_store(state, token)
      }
  }
}

fn fetch_and_store(state: State, token: String) -> Nil {
  case http_get(usage_url, token) {
    Error(reason) -> {
      wisp.log_warning("usage poller: fetch failed: " <> reason)
      Nil
    }
    Ok(body) ->
      case json.parse(body, usage_decoder()) {
        Error(_) -> {
          wisp.log_warning("usage poller: unexpected response shape")
          Nil
        }
        Ok(#(util_pct, resets_at_str)) -> {
          let now = now_ms()
          let util = util_pct /. 100.0
          let reset_at = option.then(resets_at_str, parse_reset_at)

          let _ = usage_db.upsert_rate_limit_state(state.db, None, now)
          let bucket_result =
            usage_db.upsert_bucket(state.db, "five_hour", util, reset_at, now)

          case reset_at {
            None -> Nil
            Some(r) ->
              usage_db.set_window_start(
                state.db,
                "five_hour",
                r - five_hour_window_ms,
              )
          }

          let state_json = usage_db.get_usage_state_value(state.db, now)
          let snapshot =
            json.object([
              #("type", json.string("snapshot")),
              #("state", state_json),
            ])
            |> json.to_string()
          process.send(
            state.pubsub,
            pubsub.Publish(topic: "usage", message: to_dynamic(snapshot)),
          )

          case bucket_result {
            Ok(usage_db.ThresholdCrossed(bid, thresh, r)) -> {
              let msg =
                json.object([
                  #("type", json.string("threshold_crossed")),
                  #("bucket_id", json.string(bid)),
                  #("threshold", json.int(thresh)),
                  #("reset_at", json.nullable(r, json.int)),
                ])
                |> json.to_string()
              process.send(
                state.pubsub,
                pubsub.Publish(topic: "usage", message: to_dynamic(msg)),
              )
            }
            _ -> Nil
          }

          Nil
        }
      }
  }
}

// ── Credential reading ────────────────────────────────────────────────────────

fn read_token(claude_dir: String) -> Result(String, String) {
  let path = claude_dir <> "/.credentials.json"
  use content <- result.try(
    simplifile.read(path)
    |> result.map_error(fn(_) { "cannot read credentials" }),
  )
  use #(token, expires_at) <- result.try(
    json.parse(content, credentials_decoder())
    |> result.map_error(fn(_) { "cannot parse credentials" }),
  )
  case now_ms() < expires_at {
    True -> Ok(token)
    False -> Error("oauth token expired")
  }
}

// ── Decoders ──────────────────────────────────────────────────────────────────

fn oauth_inner_decoder() -> decode.Decoder(#(String, Int)) {
  use token <- decode.field("accessToken", decode.string)
  use expires_at <- decode.field("expiresAt", decode.int)
  decode.success(#(token, expires_at))
}

fn credentials_decoder() -> decode.Decoder(#(String, Int)) {
  use pair <- decode.field("claudeAiOauth", oauth_inner_decoder())
  decode.success(pair)
}

fn five_hour_decoder() -> decode.Decoder(#(Float, Option(String))) {
  use util <- decode.field("utilization", float_or_int_decoder())
  use resets_at <- decode.optional_field(
    "resets_at",
    None,
    decode.optional(decode.string),
  )
  decode.success(#(util, resets_at))
}

fn usage_decoder() -> decode.Decoder(#(Float, Option(String))) {
  use data <- decode.field("five_hour", five_hour_decoder())
  decode.success(data)
}

fn float_or_int_decoder() -> decode.Decoder(Float) {
  decode.one_of(decode.float, [decode.map(decode.int, int.to_float)])
}

fn parse_reset_at(iso: String) -> Option(Int) {
  case erlang_parse_iso8601(iso) {
    Ok(ms) -> Some(ms)
    Error(_) -> None
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

fn http_get(url: String, token: String) -> Result(String, String) {
  use req <- result.try(
    request.to(url)
    |> result.map_error(fn(_) { "invalid url: " <> url }),
  )
  let req =
    req
    |> request.prepend_header("authorization", "Bearer " <> token)
    |> request.prepend_header("anthropic-beta", "oauth-2025-04-20")
    |> request.prepend_header("anthropic-version", "2023-06-01")
    |> request.prepend_header("user-agent", "fbi/1.0")
  use resp <- result.try(
    httpc.send(req)
    |> result.map_error(fn(_) { "request failed" }),
  )
  case resp.status >= 200 && resp.status < 300 {
    True -> Ok(resp.body)
    False -> Error("http_" <> int.to_string(resp.status))
  }
}

// ── FFI ───────────────────────────────────────────────────────────────────────

@external(erlang, "fbi_time", "parse_iso8601_ms")
fn erlang_parse_iso8601(iso: String) -> Result(Int, String)

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int

@external(erlang, "fbi_time", "to_dynamic")
fn to_dynamic(s: String) -> Dynamic
