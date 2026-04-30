import fbi/run/types.{
  type BroadcastMsg, type TerminalEvent, BroadcastChunk, BroadcastEvent,
  BroadcastShutdown, BroadcastSubscribe, BroadcastUnsubscribe, TerminalChunk,
}
import gleam/erlang/process.{type Subject}
import gleam/list
import gleam/otp/actor
import gleam/result

type State {
  State(subscribers: List(Subject(TerminalEvent)))
}

pub fn start() -> Result(Subject(BroadcastMsg), actor.StartError) {
  actor.new_with_initialiser(100, fn(subject) {
    State(subscribers: [])
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: BroadcastMsg) {
    handle_message(msg, state)
  })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle_message(
  msg: BroadcastMsg,
  state: State,
) -> actor.Next(State, BroadcastMsg) {
  case msg {
    BroadcastSubscribe(client) ->
      actor.continue(State(subscribers: [client, ..state.subscribers]))
    BroadcastUnsubscribe(client) ->
      actor.continue(
        State(
          subscribers: list.filter(state.subscribers, fn(s) { s != client }),
        ),
      )
    BroadcastChunk(data) -> {
      list.each(state.subscribers, fn(s) {
        process.send(s, TerminalChunk(data))
      })
      actor.continue(state)
    }
    BroadcastEvent(event) -> {
      list.each(state.subscribers, fn(s) { process.send(s, event) })
      actor.continue(state)
    }
    BroadcastShutdown -> actor.stop()
  }
}
