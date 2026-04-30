import fbi/db/settings.{type Settings}
import gleam/dynamic/decode
import gleam/json
import gleam/result

fn parse_string_list(raw: String) -> List(String) {
  json.parse(raw, decode.list(decode.string))
  |> result.unwrap([])
}

pub fn encode(s: Settings) -> json.Json {
  json.object([
    #("id", json.int(s.id)),
    #("global_prompt", json.string(s.global_prompt)),
    #("notifications_enabled", json.bool(s.notifications_enabled)),
    #("concurrency_warn_at", json.int(s.concurrency_warn_at)),
    #("image_gc_enabled", json.bool(s.image_gc_enabled)),
    #("last_gc_at", json.nullable(s.last_gc_at, json.int)),
    #("last_gc_count", json.nullable(s.last_gc_count, json.int)),
    #("last_gc_bytes", json.nullable(s.last_gc_bytes, json.int)),
    #(
      "global_marketplaces",
      json.array(parse_string_list(s.global_marketplaces_json), json.string),
    ),
    #(
      "global_plugins",
      json.array(parse_string_list(s.global_plugins_json), json.string),
    ),
    #("auto_resume_enabled", json.bool(s.auto_resume_enabled)),
    #("auto_resume_max_attempts", json.int(s.auto_resume_max_attempts)),
    #("usage_notifications_enabled", json.bool(s.usage_notifications_enabled)),
    #(
      "tokens_total_recomputed_at",
      json.nullable(s.tokens_total_recomputed_at, json.int),
    ),
    #("updated_at", json.int(s.updated_at)),
  ])
}
