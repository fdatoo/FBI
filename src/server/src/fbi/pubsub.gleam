import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/erlang/process.{type Subject}
import gleam/list
import gleam/otp/actor
import gleam/result

pub type Topic =
  String

pub type PubsubMsg {
  Subscribe(topic: Topic, client: Subject(Dynamic))
  Unsubscribe(topic: Topic, client: Subject(Dynamic))
  Publish(topic: Topic, message: Dynamic)
}

type State {
  State(subs: Dict(Topic, List(Subject(Dynamic))))
}

pub fn start() -> Result(Subject(PubsubMsg), actor.StartError) {
  actor.new_with_initialiser(100, fn(subject) {
    State(subs: dict.new())
    |> actor.initialised
    |> actor.returning(subject)
    |> actor.selecting(process.new_selector() |> process.select(subject))
    |> Ok
  })
  |> actor.on_message(fn(state: State, msg: PubsubMsg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(started) { started.data })
}

fn handle(state: State, msg: PubsubMsg) -> actor.Next(State, PubsubMsg) {
  case msg {
    Subscribe(topic, client) -> {
      let current = dict.get(state.subs, topic) |> result.unwrap([])
      actor.continue(
        State(subs: dict.insert(state.subs, topic, [client, ..current])),
      )
    }
    Unsubscribe(topic, client) -> {
      let current = dict.get(state.subs, topic) |> result.unwrap([])
      let filtered = list.filter(current, fn(s) { s != client })
      actor.continue(State(subs: dict.insert(state.subs, topic, filtered)))
    }
    Publish(topic, message) -> {
      let subs = dict.get(state.subs, topic) |> result.unwrap([])
      list.each(subs, fn(s) { process.send(s, message) })
      actor.continue(state)
    }
  }
}
