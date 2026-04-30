import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}

pub type UsageEvent {
  UsageEvent(
    model: String,
    input_tokens: Int,
    output_tokens: Int,
    cache_read_tokens: Int,
    cache_create_tokens: Int,
  )
}

pub type RateLimitFields {
  RateLimitFields(
    requests_remaining: Option(Int),
    requests_limit: Option(Int),
    tokens_remaining: Option(Int),
    tokens_limit: Option(Int),
    reset_at: Option(Int),
  )
}

pub type ParseResult {
  UsageLine(usage: UsageEvent, rate_limits: Option(RateLimitFields))
  SkipLine
  ErrorLine(reason: String)
}

// ── Intermediate types ────────────────────────────────────────────────────────

type MessageData {
  MessageData(
    role: Option(String),
    model: Option(String),
    input_tokens: Option(Int),
    output_tokens: Option(Int),
    cache_read: Option(Int),
    cache_create: Option(Int),
  )
}

type RawLine {
  RawLine(
    line_type: String,
    message: Option(MessageData),
    rate_limits: Option(RateLimitFields),
  )
}

// ── Decoder helpers ───────────────────────────────────────────────────────────

fn int_or_string_decoder() -> decode.Decoder(Option(Int)) {
  decode.one_of(decode.map(decode.int, Some), [
    decode.then(decode.string, fn(s) {
      case int.parse(s) {
        Ok(n) -> decode.success(Some(n))
        Error(_) -> decode.success(None)
      }
    }),
  ])
}

// Decoder for the rateLimits object (applied to the value at key "rateLimits").
fn rl_inner_decoder() -> decode.Decoder(RateLimitFields) {
  use req_rem <- decode.optional_field(
    "anthropic-ratelimit-unified-5h-requests-remaining",
    None,
    int_or_string_decoder(),
  )
  use req_lim <- decode.optional_field(
    "anthropic-ratelimit-unified-5h-requests-limit",
    None,
    int_or_string_decoder(),
  )
  use tok_rem <- decode.optional_field(
    "anthropic-ratelimit-unified-5h-tokens-remaining",
    None,
    int_or_string_decoder(),
  )
  use tok_lim <- decode.optional_field(
    "anthropic-ratelimit-unified-5h-tokens-limit",
    None,
    int_or_string_decoder(),
  )
  use reset_str <- decode.optional_field(
    "anthropic-ratelimit-unified-5h-reset",
    None,
    decode.optional(decode.string),
  )
  decode.success(RateLimitFields(
    requests_remaining: req_rem,
    requests_limit: req_lim,
    tokens_remaining: tok_rem,
    tokens_limit: tok_lim,
    reset_at: option.then(reset_str, parse_iso8601_ms),
  ))
}

// Decoder for the "message" sub-object.
fn message_decoder() -> decode.Decoder(MessageData) {
  use role <- decode.optional_field(
    "role",
    None,
    decode.optional(decode.string),
  )
  use model <- decode.optional_field(
    "model",
    None,
    decode.optional(decode.string),
  )
  use input_tokens <- decode.optional_field(
    "usage",
    None,
    decode.optional(decode.field(
      "input_tokens",
      decode.int,
      decode.success,
    )),
  )
  use output_tokens <- decode.optional_field(
    "usage",
    None,
    decode.optional(decode.field(
      "output_tokens",
      decode.int,
      decode.success,
    )),
  )
  use cache_read <- decode.optional_field(
    "usage",
    None,
    decode.optional(decode.field(
      "cache_read_input_tokens",
      decode.int,
      decode.success,
    )),
  )
  use cache_create <- decode.optional_field(
    "usage",
    None,
    decode.optional(decode.field(
      "cache_creation_input_tokens",
      decode.int,
      decode.success,
    )),
  )
  decode.success(MessageData(
    role: role,
    model: model,
    input_tokens: input_tokens,
    output_tokens: output_tokens,
    cache_read: cache_read,
    cache_create: cache_create,
  ))
}

// Top-level line decoder.
fn line_decoder() -> decode.Decoder(RawLine) {
  use line_type <- decode.field("type", decode.string)
  use message <- decode.optional_field(
    "message",
    None,
    decode.optional(message_decoder()),
  )
  use rate_limits <- decode.optional_field(
    "rateLimits",
    None,
    decode.optional(rl_inner_decoder()),
  )
  decode.success(RawLine(
    line_type: line_type,
    message: message,
    rate_limits: rate_limits,
  ))
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn parse_line(raw: String) -> ParseResult {
  let trimmed = string_trim(raw)
  case trimmed {
    "" -> SkipLine
    _ -> {
      case json.parse(trimmed, line_decoder()) {
        Error(_) -> ErrorLine("not valid JSON or unexpected shape")
        Ok(line) -> interpret(line)
      }
    }
  }
}

fn interpret(line: RawLine) -> ParseResult {
  case line.line_type {
    "assistant" -> interpret_assistant(line)
    _ -> SkipLine
  }
}

fn interpret_assistant(line: RawLine) -> ParseResult {
  case line.message {
    None -> ErrorLine("assistant turn missing message")
    Some(msg) -> interpret_message(msg, line.rate_limits)
  }
}

fn interpret_message(
  msg: MessageData,
  rl: Option(RateLimitFields),
) -> ParseResult {
  case msg.role {
    Some(r) if r != "assistant" -> SkipLine
    _ ->
      case msg.model {
        None -> ErrorLine("assistant turn missing model")
        Some(model) -> build_usage_line(model, msg, rl)
      }
  }
}

fn build_usage_line(
  model: String,
  msg: MessageData,
  rl: Option(RateLimitFields),
) -> ParseResult {
  let has_usage =
    option.is_some(msg.input_tokens)
    || option.is_some(msg.output_tokens)
    || option.is_some(msg.cache_read)
    || option.is_some(msg.cache_create)
  case has_usage {
    False -> ErrorLine("assistant turn missing usage")
    True ->
      UsageLine(
        usage: UsageEvent(
          model: model,
          input_tokens: option.unwrap(msg.input_tokens, 0),
          output_tokens: option.unwrap(msg.output_tokens, 0),
          cache_read_tokens: option.unwrap(msg.cache_read, 0),
          cache_create_tokens: option.unwrap(msg.cache_create, 0),
        ),
        rate_limits: rl,
      )
  }
}

// ── ISO 8601 → Unix ms ────────────────────────────────────────────────────────

fn parse_iso8601_ms(iso: String) -> Option(Int) {
  case erlang_parse_iso8601(iso) {
    Ok(ms) -> Some(ms)
    Error(_) -> None
  }
}

@external(erlang, "fbi_time", "parse_iso8601_ms")
fn erlang_parse_iso8601(iso: String) -> Result(Int, String)

@external(erlang, "string", "trim")
fn string_trim(s: String) -> String
