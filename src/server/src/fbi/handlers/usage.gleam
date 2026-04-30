import fbi/context.{type Context}
import fbi/db/connection
import fbi/db/usage as usage_db
import gleam/dynamic/decode
import gleam/http
import gleam/int
import gleam/json
import gleam/list
import gleam/result
import sqlight
import wisp.{type Request, type Response}

/// Returns the current UsageState from the DB.
pub fn handle_state(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get ->
      usage_db.get_usage_state_json(ctx.db, now_ms())
      |> wisp.json_response(200)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

/// Daily usage from `runs.tokens_*`. Returns one row per day for the last
/// N days. Empty token totals are normal until the token-collection
/// pipeline is implemented.
pub fn handle_daily(req: Request, ctx: Context) -> Response {
  case req.method {
    http.Get -> serve_daily(req, ctx)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_daily(req: Request, ctx: Context) -> Response {
  let days =
    wisp.get_query(req)
    |> list.key_find("days")
    |> result.try(int.parse)
    |> result.unwrap(14)
  let days = case days < 1 || days > 90 {
    True -> 14
    False -> days
  }
  let day_decoder = {
    use date <- decode.field(0, decode.string)
    use tokens_total <- decode.field(1, decode.int)
    use tokens_input <- decode.field(2, decode.int)
    use tokens_output <- decode.field(3, decode.int)
    use tokens_cache_read <- decode.field(4, decode.int)
    use tokens_cache_create <- decode.field(5, decode.int)
    use run_count <- decode.field(6, decode.int)
    decode.success(#(
      date,
      tokens_total,
      tokens_input,
      tokens_output,
      tokens_cache_read,
      tokens_cache_create,
      run_count,
    ))
  }
  let sql =
    "SELECT
       date(created_at / 1000, 'unixepoch') AS day,
       COALESCE(SUM(tokens_total), 0),
       COALESCE(SUM(tokens_input), 0),
       COALESCE(SUM(tokens_output), 0),
       COALESCE(SUM(tokens_cache_read), 0),
       COALESCE(SUM(tokens_cache_create), 0),
       COUNT(*) AS run_count
     FROM runs
     WHERE created_at >= ?
     GROUP BY day
     ORDER BY day DESC"
  let now_ms = now_ms()
  let cutoff = now_ms - days * 86_400_000
  case connection.query_all(sql, ctx.db, [sqlight.int(cutoff)], day_decoder) {
    Error(e) -> {
      wisp.log_error("usage daily: " <> connection.describe_error(e))
      wisp.internal_server_error()
    }
    Ok(rows) ->
      json.array(rows, fn(row) {
        let #(date, total, input, output, cr, cc, count) = row
        json.object([
          #("date", json.string(date)),
          #("tokens_total", json.int(total)),
          #("tokens_input", json.int(input)),
          #("tokens_output", json.int(output)),
          #("tokens_cache_read", json.int(cr)),
          #("tokens_cache_create", json.int(cc)),
          #("run_count", json.int(count)),
        ])
      })
      |> json.to_string()
      |> wisp.json_response(200)
  }
}

/// Per-run breakdown by model. Until we collect per-model token counts,
/// this returns at most one row aggregating the run's totals under its
/// declared model (or "unknown").
pub fn handle_run_breakdown(
  req: Request,
  ctx: Context,
  id_str: String,
) -> Response {
  case req.method {
    http.Get -> serve_run_breakdown(ctx, id_str)
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_run_breakdown(ctx: Context, id_str: String) -> Response {
  case int.parse(id_str) {
    Error(_) -> wisp.bad_request("Invalid run ID")
    Ok(id) -> {
      let row_decoder = {
        use model <- decode.field(0, decode.string)
        use input <- decode.field(1, decode.int)
        use output <- decode.field(2, decode.int)
        use cr <- decode.field(3, decode.int)
        use cc <- decode.field(4, decode.int)
        decode.success(#(model, input, output, cr, cc))
      }
      case
        connection.query_all(
          "SELECT COALESCE(model, 'unknown'), tokens_input, tokens_output, tokens_cache_read, tokens_cache_create
           FROM runs WHERE id = ?",
          ctx.db,
          [sqlight.int(id)],
          row_decoder,
        )
      {
        Error(e) -> {
          wisp.log_error("usage run: " <> connection.describe_error(e))
          wisp.internal_server_error()
        }
        Ok(rows) ->
          json.array(rows, fn(row) {
            let #(model, input, output, cr, cc) = row
            json.object([
              #("model", json.string(model)),
              #("input", json.int(input)),
              #("output", json.int(output)),
              #("cache_read", json.int(cr)),
              #("cache_create", json.int(cc)),
            ])
          })
          |> json.to_string()
          |> wisp.json_response(200)
      }
    }
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
