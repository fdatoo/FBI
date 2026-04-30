import fbi/config.{type Config}
import fbi/run/actor as run_actor
import fbi/run/broadcaster
import fbi/run/registry.{type RegistryMsg, Register}
import fbi/run/types.{type BroadcastMsg, type RunMsg}
import gleam/erlang/process.{type Subject}
import gleam/result
import sqlight

pub fn start_run(
  registry: Subject(RegistryMsg),
  db: sqlight.Connection,
  config: Config,
  run_id: Int,
) -> Result(#(Subject(RunMsg), Subject(BroadcastMsg)), String) {
  use bc <- result.try(
    broadcaster.start()
    |> result.map_error(fn(_) { "failed to start broadcaster" }),
  )
  use actor_subject <- result.try(
    run_actor.start(run_id, db, config, bc, registry)
    |> result.map_error(fn(_) { "failed to start run actor" }),
  )
  process.send(registry, Register(run_id, actor_subject))
  Ok(#(actor_subject, bc))
}
