import fbi/config.{type Config}
import fbi/db/usage as usage_db
import fbi/pubsub
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/http
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

const token_url = "https://platform.claude.com/v1/oauth/token"

const client_id = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

// Anthropic rate-limits this endpoint: stay well below once-per-5min.
const poll_interval_ms = 300_000

const five_hour_window_ms = 18_000_000

// Refresh the access token when it has less than 30 minutes left.
const refresh_threshold_ms = 1_800_000

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
    Some(dir) -> {
      maybe_refresh_token(dir)
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
}

// ── Token refresh ─────────────────────────────────────────────────────────────

fn maybe_refresh_token(claude_dir: String) -> Nil {
  let path = claude_dir <> "/.credentials.json"
  case simplifile.read(path) {
    Error(_) -> Nil
    Ok(content) ->
      case json.parse(content, full_credentials_decoder()) {
        Error(_) -> Nil
        Ok(creds) -> {
          let now = now_ms()
          case now + refresh_threshold_ms >= creds.expires_at {
            False -> Nil
            True -> {
              wisp.log_info(
                "usage poller: access token near expiry, refreshing",
              )
              case do_refresh(creds.refresh_token) {
                Error(reason) ->
                  wisp.log_warning(
                    "usage poller: token refresh failed: " <> reason,
                  )
                Ok(#(new_access, raw_refresh, expires_in)) -> {
                  let new_expires = now_ms() + expires_in * 1000
                  let new_refresh = case raw_refresh {
                    "" -> creds.refresh_token
                    r -> r
                  }
                  let updated =
                    FullCredentials(
                      ..creds,
                      access_token: new_access,
                      refresh_token: new_refresh,
                      expires_at: new_expires,
                    )
                  case write_credentials(path, updated) {
                    Error(reason) ->
                      wisp.log_warning(
                        "usage poller: could not write refreshed credentials: "
                        <> reason,
                      )
                    Ok(Nil) ->
                      wisp.log_info(
                        "usage poller: token refreshed successfully",
                      )
                  }
                }
              }
            }
          }
        }
      }
  }
}

fn do_refresh(refresh_token: String) -> Result(#(String, String, Int), String) {
  let body =
    json.object([
      #("grant_type", json.string("refresh_token")),
      #("refresh_token", json.string(refresh_token)),
      #("client_id", json.string(client_id)),
      #(
        "scope",
        json.string(
          "user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code",
        ),
      ),
    ])
    |> json.to_string()
  use req <- result.try(
    request.to(token_url)
    |> result.map_error(fn(_) { "invalid token url" }),
  )
  let req =
    req
    |> request.set_method(http.Post)
    |> request.set_body(body)
    |> request.prepend_header("content-type", "application/json")
    |> request.prepend_header("user-agent", "fbi/1.0")
  use resp <- result.try(
    httpc.send(req)
    |> result.map_error(fn(_) { "request failed" }),
  )
  case resp.status >= 200 && resp.status < 300 {
    False -> Error("http_" <> int.to_string(resp.status) <> ": " <> resp.body)
    True ->
      json.parse(resp.body, refresh_response_decoder())
      |> result.map_error(fn(_) { "could not parse refresh response" })
  }
}

fn write_credentials(
  path: String,
  creds: FullCredentials,
) -> Result(Nil, String) {
  let scopes_json = json.array(creds.scopes, json.string)
  let inner =
    json.object(
      [
        #("accessToken", json.string(creds.access_token)),
        #("refreshToken", json.string(creds.refresh_token)),
        #("expiresAt", json.int(creds.expires_at)),
        #("scopes", scopes_json),
      ]
      |> append_opt("subscriptionType", creds.subscription_type, json.string)
      |> append_opt("rateLimitTier", creds.rate_limit_tier, json.string),
    )
  let full = json.object([#("claudeAiOauth", inner)]) |> json.to_string()
  simplifile.write(path, full)
  |> result.map_error(fn(e) { simplifile.describe_error(e) })
}

fn append_opt(
  entries: List(#(String, json.Json)),
  key: String,
  opt: Option(String),
  enc: fn(String) -> json.Json,
) -> List(#(String, json.Json)) {
  case opt {
    None -> entries
    Some(v) -> [#(key, enc(v)), ..entries]
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

type FullCredentials {
  FullCredentials(
    access_token: String,
    refresh_token: String,
    expires_at: Int,
    scopes: List(String),
    subscription_type: Option(String),
    rate_limit_tier: Option(String),
  )
}

fn full_credentials_decoder() -> decode.Decoder(FullCredentials) {
  use inner <- decode.field("claudeAiOauth", {
    use access_token <- decode.field("accessToken", decode.string)
    use refresh_token <- decode.field("refreshToken", decode.string)
    use expires_at <- decode.field("expiresAt", decode.int)
    use scopes <- decode.optional_field(
      "scopes",
      [],
      decode.list(decode.string),
    )
    use subscription_type <- decode.optional_field(
      "subscriptionType",
      None,
      decode.optional(decode.string),
    )
    use rate_limit_tier <- decode.optional_field(
      "rateLimitTier",
      None,
      decode.optional(decode.string),
    )
    decode.success(FullCredentials(
      access_token: access_token,
      refresh_token: refresh_token,
      expires_at: expires_at,
      scopes: scopes,
      subscription_type: subscription_type,
      rate_limit_tier: rate_limit_tier,
    ))
  })
  decode.success(inner)
}

fn refresh_response_decoder() -> decode.Decoder(#(String, String, Int)) {
  use access_token <- decode.field("access_token", decode.string)
  use expires_in <- decode.field("expires_in", decode.int)
  use refresh_token <- decode.optional_field("refresh_token", "", decode.string)
  decode.success(#(access_token, refresh_token, expires_in))
}

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
