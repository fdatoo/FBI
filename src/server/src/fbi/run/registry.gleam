import fbi/run/types.{type RunMsg}
import gleam/dict.{type Dict}
import gleam/erlang/process.{type Subject}
import gleam/option.{type Option, None}
import gleam/otp/actor
import gleam/result

pub type RegistryMsg {
  Register(run_id: Int, subject: Subject(RunMsg))
  Unregister(run_id: Int)
  Lookup(run_id: Int, reply: Subject(Option(Subject(RunMsg))))
}

type State {
  State(runs: Dict(Int, Subject(RunMsg)))
}

pub fn start() -> Result(Subject(RegistryMsg), actor.StartError) {
  actor.new_with_initialiser(100, fn(subject) {
    State(runs: dict.new())
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state, msg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: RegistryMsg) -> actor.Next(State, RegistryMsg) {
  case msg {
    Register(id, subject) ->
      actor.continue(State(runs: dict.insert(state.runs, id, subject)))
    Unregister(id) -> actor.continue(State(runs: dict.delete(state.runs, id)))
    Lookup(id, reply) -> {
      let result = dict.get(state.runs, id) |> option.from_result
      process.send(reply, result)
      actor.continue(state)
    }
  }
}

pub fn lookup(
  registry: Subject(RegistryMsg),
  id: Int,
) -> Option(Subject(RunMsg)) {
  let reply = process.new_subject()
  process.send(registry, Lookup(id, reply))
  case process.receive(reply, 1000) {
    Ok(opt) -> opt
    Error(_) -> None
  }
}
