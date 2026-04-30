import fbi/config.{type Config}
import fbi/db/projects
import fbi/db/settings
import fbi/run/image_builder
import fbi/run/image_gc
import gleam/erlang/process
import gleam/int
import gleam/list
import gleam/otp/actor
import gleam/result
import sqlight
import wisp

const interval_ms = 3_600_000

pub type GcMsg {
  Tick
}

type State {
  State(db: sqlight.Connection, config: Config, self: process.Subject(GcMsg))
}

pub fn start(
  db: sqlight.Connection,
  config: Config,
) -> Result(process.Subject(GcMsg), actor.StartError) {
  actor.new_with_initialiser(500, fn(subject) {
    process.send_after(subject, interval_ms, Tick)
    State(db: db, config: config, self: subject)
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: GcMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: GcMsg) -> actor.Next(State, GcMsg) {
  case msg {
    Tick -> {
      run_if_enabled(state)
      process.send_after(state.self, interval_ms, Tick)
      actor.continue(state)
    }
  }
}

fn run_if_enabled(state: State) -> Nil {
  case settings.get(state.db) {
    Error(_) -> Nil
    Ok(s) ->
      case s.image_gc_enabled {
        False -> Nil
        True ->
          case image_builder.read_postbuild() {
            Error(_) -> Nil
            Ok(postbuild) ->
              case projects.list(state.db) {
                Error(_) -> Nil
                Ok(all_projects) -> {
                  let now = now_ms()
                  let gc_result =
                    image_gc.sweep(all_projects, postbuild, now, state.config)
                  wisp.log_info(
                    "image_gc: deleted="
                    <> int.to_string(gc_result.deleted_count)
                    <> " bytes="
                    <> int.to_string(gc_result.deleted_bytes)
                    <> " errors="
                    <> int.to_string(list.length(gc_result.errors)),
                  )
                  list.each(gc_result.errors, fn(e) {
                    wisp.log_warning(
                      "image_gc: failed to delete "
                      <> e.tag
                      <> ": "
                      <> e.message,
                    )
                  })
                  let _ =
                    settings.update_gc_result(
                      state.db,
                      gc_result.deleted_count,
                      gc_result.deleted_bytes,
                      now,
                    )
                  Nil
                }
              }
          }
      }
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
