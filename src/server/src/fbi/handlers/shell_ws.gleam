import fbi/ansi
import fbi/context.{type Context}
import fbi/db/runs as runs_db
import fbi/run/registry
import fbi/run/types
import gleam/bytes_tree
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/http/request
import gleam/http/response
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/result
import mist
import simplifile

pub type ConnState {
  ConnState(
    run_id: Int,
    /// Actor for live runs; None for terminal-mode (replay-only) connections.
    run_actor: Option(process.Subject(types.RunMsg)),
    terminal_subject: process.Subject(types.TerminalEvent),
    /// Replay payload for terminal runs: (run_state, transcript_size,
    /// fallback_message). Sent on first frame received (on_init can't send
    /// frames itself). The fallback is only emitted when the transcript is
    /// empty — so old runs that never wrote one still get a useful display.
    replay: Option(#(String, Int, Option(String))),
  )
}

type ClientMsg {
  Hello(cols: Int, rows: Int)
  ClientResize(cols: Int, rows: Int)
  Focus
  Blur
}

/// Upgrade HTTP request to WebSocket for terminal I/O.
/// - Live runs (actor in registry): full bidirectional shell.
/// - Terminal runs (in DB but no actor): one-shot snapshot delivery so the
///   client can replay history from the transcript file.
/// - Unknown runs: 404.
pub fn upgrade(
  req: request.Request(mist.Connection),
  ctx: Context,
  run_id_str: String,
) -> response.Response(mist.ResponseData) {
  case int.parse(run_id_str) {
    Error(_) ->
      response.new(400)
      |> response.set_body(mist.Bytes(bytes_tree.new()))
    Ok(run_id) ->
      case registry.lookup(ctx.run_registry, run_id) {
        Some(actor) ->
          mist.websocket(
            request: req,
            on_init: fn(_conn) { on_open_live(actor, run_id) },
            handler: handle_frame,
            on_close: on_close,
          )
        None ->
          case runs_db.get(ctx.db, run_id) {
            Error(_) ->
              response.new(404)
              |> response.set_body(mist.Bytes(bytes_tree.new()))
            Ok(run) -> {
              let path =
                ctx.config.runs_dir
                <> "/"
                <> int.to_string(run_id)
                <> "/transcript.log"
              let size =
                simplifile.file_info(path)
                |> result.map(fn(info) { info.size })
                |> result.unwrap(0)
              let fallback = case size, run.error {
                0, Some(err) -> Some(err)
                _, _ -> None
              }
              mist.websocket(
                request: req,
                on_init: fn(_conn) {
                  on_open_replay(run_id, run.state, size, fallback)
                },
                handler: handle_frame,
                on_close: on_close,
              )
            }
          }
      }
  }
}

fn on_open_live(
  actor: process.Subject(types.RunMsg),
  run_id: Int,
) -> #(ConnState, Option(process.Selector(types.TerminalEvent))) {
  let term_subject = process.new_subject()
  process.send(actor, types.Subscribe(client: term_subject))
  let selector =
    process.new_selector()
    |> process.select(term_subject)
  let state =
    ConnState(
      run_id: run_id,
      run_actor: Some(actor),
      terminal_subject: term_subject,
      replay: None,
    )
  #(state, Some(selector))
}

fn on_open_replay(
  run_id: Int,
  run_state: String,
  transcript_size: Int,
  fallback: Option(String),
) -> #(ConnState, Option(process.Selector(types.TerminalEvent))) {
  // Send ourselves a synthetic message so the handler runs and emits the
  // state + snapshot frames. mist's on_init can't send frames directly.
  let term_subject = process.new_subject()
  process.send(term_subject, types.TerminalChunk(<<>>))
  let selector =
    process.new_selector()
    |> process.select(term_subject)
  let state =
    ConnState(
      run_id: run_id,
      run_actor: None,
      terminal_subject: term_subject,
      replay: Some(#(run_state, transcript_size, fallback)),
    )
  #(state, Some(selector))
}

fn handle_frame(
  state: ConnState,
  msg: mist.WebsocketMessage(types.TerminalEvent),
  conn: mist.WebsocketConnection,
) -> mist.Next(ConnState, types.TerminalEvent) {
  // First custom message in replay mode triggers state + snapshot delivery,
  // then the connection sits idle until the client closes.
  case state.replay, msg {
    Some(#(run_state, size, fallback)), mist.Custom(_) -> {
      send_state(conn, run_state)
      send_snapshot(conn, size)
      case fallback {
        Some(err) -> send_fallback_chunk(conn, err)
        None -> Nil
      }
      mist.continue(ConnState(..state, replay: None))
    }
    _, _ -> handle_live_frame(state, msg, conn)
  }
}

fn send_fallback_chunk(conn: mist.WebsocketConnection, err: String) -> Nil {
  // Render the run's stored error in the terminal so old runs without a
  // transcript still display something useful.
  let body =
    ansi.styled("Run failed: " <> err, with: ansi.red)
    <> ansi.newline
    <> ansi.styled("(no terminal output captured for this run)", with: ansi.dim)
    <> ansi.newline
  let _ = mist.send_binary_frame(conn, <<body:utf8>>)
  Nil
}

fn handle_live_frame(
  state: ConnState,
  msg: mist.WebsocketMessage(types.TerminalEvent),
  conn: mist.WebsocketConnection,
) -> mist.Next(ConnState, types.TerminalEvent) {
  case msg {
    mist.Text(json_str) ->
      case parse_client_msg(json_str) {
        Ok(Hello(cols, rows)) -> {
          send_to_actor(state, types.Resize(cols: cols, rows: rows))
          mist.continue(state)
        }
        Ok(ClientResize(cols, rows)) -> {
          send_to_actor(state, types.Resize(cols: cols, rows: rows))
          mist.continue(state)
        }
        Ok(Focus) -> mist.continue(state)
        Ok(Blur) -> mist.continue(state)
        Error(_) -> mist.continue(state)
      }
    mist.Binary(bytes) -> {
      send_to_actor(state, types.WriteStdin(bytes: bytes))
      mist.continue(state)
    }
    mist.Custom(types.TerminalChunk(data)) -> {
      let _ = mist.send_binary_frame(conn, data)
      mist.continue(state)
    }
    mist.Custom(types.StateChanged(s)) -> {
      send_state(conn, s)
      mist.continue(state)
    }
    mist.Custom(types.Snapshot(ansi, cols, rows, byte_offset)) -> {
      let body =
        json.object([
          #("type", json.string("snapshot")),
          #("ansi", json.string(ansi)),
          #("cols", json.int(cols)),
          #("rows", json.int(rows)),
          #("byte_offset", json.int(byte_offset)),
        ])
        |> json.to_string()
      let _ = mist.send_text_frame(conn, body)
      mist.continue(state)
    }
    mist.Custom(types.TitleChanged(title)) -> {
      let body =
        json.object([
          #("type", json.string("title")),
          #("title", json.string(title)),
          #("title_locked", json.int(0)),
        ])
        |> json.to_string()
      let _ = mist.send_text_frame(conn, body)
      mist.continue(state)
    }
    mist.Custom(types.BranchChanged(branch)) -> {
      let body =
        json.object([
          #("type", json.string("branch")),
          #("branch_name", json.string(branch)),
        ])
        |> json.to_string()
      let _ = mist.send_text_frame(conn, body)
      mist.continue(state)
    }
    mist.Custom(types.UsageSnap(model, input, output, cache_read, cache_create)) -> {
      let body =
        json.object([
          #("type", json.string("usage")),
          #(
            "snapshot",
            json.object([
              #("model", json.string(model)),
              #("input_tokens", json.int(input)),
              #("output_tokens", json.int(output)),
              #("cache_read_tokens", json.int(cache_read)),
              #("cache_create_tokens", json.int(cache_create)),
            ]),
          ),
        ])
        |> json.to_string()
      let _ = mist.send_text_frame(conn, body)
      mist.continue(state)
    }
    mist.Closed | mist.Shutdown -> {
      unsubscribe(state)
      mist.stop()
    }
  }
}

fn on_close(state: ConnState) -> Nil {
  unsubscribe(state)
}

fn send_to_actor(state: ConnState, msg: types.RunMsg) -> Nil {
  case state.run_actor {
    Some(actor) -> process.send(actor, msg)
    None -> Nil
  }
}

fn unsubscribe(state: ConnState) -> Nil {
  case state.run_actor {
    Some(actor) ->
      process.send(actor, types.Unsubscribe(client: state.terminal_subject))
    None -> Nil
  }
}

fn send_state(conn: mist.WebsocketConnection, s: String) -> Nil {
  let body =
    json.object([#("type", json.string("state")), #("state", json.string(s))])
    |> json.to_string()
  let _ = mist.send_text_frame(conn, body)
  Nil
}

fn send_snapshot(conn: mist.WebsocketConnection, byte_offset: Int) -> Nil {
  let body =
    json.object([
      #("type", json.string("snapshot")),
      #("ansi", json.string("")),
      #("cols", json.int(80)),
      #("rows", json.int(24)),
      #("byte_offset", json.int(byte_offset)),
    ])
    |> json.to_string()
  let _ = mist.send_text_frame(conn, body)
  Nil
}

fn parse_client_msg(s: String) -> Result(ClientMsg, Nil) {
  let type_decoder = decode.field("type", decode.string, decode.success)
  let type_result =
    json.parse(s, type_decoder)
    |> result_to_nil
  case type_result {
    Ok("hello") -> parse_dims(s) |> result.map(fn(d) { Hello(d.0, d.1) })
    Ok("resize") ->
      parse_dims(s) |> result.map(fn(d) { ClientResize(d.0, d.1) })
    Ok("focus") -> Ok(Focus)
    Ok("blur") -> Ok(Blur)
    _ -> Error(Nil)
  }
}

fn parse_dims(s: String) -> Result(#(Int, Int), Nil) {
  let decoder = {
    use cols <- decode.field("cols", decode.int)
    use rows <- decode.field("rows", decode.int)
    decode.success(#(cols, rows))
  }
  json.parse(s, decoder) |> result_to_nil
}

fn result_to_nil(r: Result(a, b)) -> Result(a, Nil) {
  case r {
    Ok(v) -> Ok(v)
    Error(_) -> Error(Nil)
  }
}
