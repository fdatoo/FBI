import gleam/erlang/process.{type Subject}
import gleam/otp/actor
import gleam/result
import gleam/set.{type Set}

pub type Cmd {
  TryAcquire(run_id: Int, reply: Subject(Bool))
  Release(run_id: Int)
}

pub fn start() -> Result(Subject(Cmd), actor.StartError) {
  actor.new(set.new())
  |> actor.on_message(fn(state, msg) { handle(state, msg) })
  |> actor.start
  |> result.map(fn(s) { s.data })
}

fn handle(state: Set(Int), msg: Cmd) -> actor.Next(Set(Int), Cmd) {
  case msg {
    TryAcquire(id, reply) ->
      case set.contains(state, id) {
        True -> {
          process.send(reply, False)
          actor.continue(state)
        }
        False -> {
          process.send(reply, True)
          actor.continue(set.insert(state, id))
        }
      }
    Release(id) -> actor.continue(set.delete(state, id))
  }
}

pub fn try_acquire(mutex: Subject(Cmd), run_id: Int) -> Bool {
  let reply = process.new_subject()
  process.send(mutex, TryAcquire(run_id, reply))
  case process.receive(reply, 200) {
    Ok(b) -> b
    Error(_) -> False
  }
}

pub fn release(mutex: Subject(Cmd), run_id: Int) -> Nil {
  process.send(mutex, Release(run_id))
}
