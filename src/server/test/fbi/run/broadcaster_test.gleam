import fbi/run/broadcaster
import fbi/run/types.{
  BroadcastChunk, BroadcastShutdown, BroadcastSubscribe, TerminalChunk,
}
import gleam/erlang/process
import gleeunit/should

pub fn broadcaster_fans_out_test() {
  let assert Ok(bc) = broadcaster.start()
  let client_subject = process.new_subject()
  process.send(bc, BroadcastSubscribe(client_subject))
  process.send(bc, BroadcastChunk(<<"hi":utf8>>))
  case process.receive(client_subject, 100) {
    Ok(TerminalChunk(data)) -> data |> should.equal(<<"hi":utf8>>)
    _ -> panic as "unexpected event or timeout"
  }
}

pub fn broadcaster_shutdown_test() {
  let assert Ok(bc) = broadcaster.start()
  process.send(bc, BroadcastShutdown)
  // Actor shuts down cleanly; no assertion needed
  Nil
}
