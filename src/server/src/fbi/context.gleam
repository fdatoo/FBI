import fbi/config.{type Config}
import fbi/pubsub.{type PubsubMsg}
import fbi/run/registry.{type RegistryMsg}
import gleam/erlang/process.{type Subject}
import sqlight

pub type Context {
  Context(
    db: sqlight.Connection,
    config: Config,
    run_registry: Subject(RegistryMsg),
    pubsub: Subject(PubsubMsg),
  )
}
