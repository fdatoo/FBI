import fbi/config.{type Config}
import fbi/db/connection
import fbi/db/runs
import fbi/run/reattach
import fbi/run/registry.{type RegistryMsg}
import gleam/erlang/process
import gleam/int
import gleam/list
import gleam/otp/actor
import gleam/result
import sqlight
import wisp

/// Polls every minute for awaiting_resume runs whose next_resume_at has
/// passed and resurrects them via the same path used by boot reattach.
const interval_ms = 60_000

pub type ResumeMsg {
  Tick
}

type State {
  State(
    db: sqlight.Connection,
    config: Config,
    registry: process.Subject(RegistryMsg),
    self: process.Subject(ResumeMsg),
  )
}

pub fn start(
  db: sqlight.Connection,
  config: Config,
  registry: process.Subject(RegistryMsg),
) -> Result(process.Subject(ResumeMsg), actor.StartError) {
  actor.new_with_initialiser(500, fn(subject) {
    process.send_after(subject, interval_ms, Tick)
    State(db: db, config: config, registry: registry, self: subject)
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: ResumeMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: ResumeMsg) -> actor.Next(State, ResumeMsg) {
  case msg {
    Tick -> {
      tick(state)
      process.send_after(state.self, interval_ms, Tick)
      actor.continue(state)
    }
  }
}

fn tick(state: State) -> Nil {
  let now = now_ms()
  case runs.list_due_resume(state.db, now) {
    Error(e) ->
      wisp.log_warning(
        "resume_scheduler: list failed: " <> connection.describe_error(e),
      )
    Ok([]) -> Nil
    Ok(due) -> {
      wisp.log_info(
        "resume_scheduler: resurrecting "
        <> int.to_string(list.length(due))
        <> " run(s)",
      )
      list.each(due, fn(run) {
        reattach.resurrect(run, state.db, state.config, state.registry)
      })
    }
  }
}

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int
