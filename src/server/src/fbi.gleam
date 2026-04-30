import envoy
import fbi/config
import fbi/context.{Context}
import fbi/db/connection
import fbi/db/migrations
import fbi/git/mutex as history_mutex
import fbi/handlers/shell_ws
import fbi/handlers/states_ws
import fbi/handlers/usage_ws
import fbi/pubsub
import fbi/router
import fbi/run/gc_scheduler
import fbi/run/reattach
import fbi/run/registry as run_registry
import fbi/run/resume_scheduler
import gleam/erlang/process
import gleam/http/request as http_req
import gleam/int
import gleam/io
import gleam/result
import mist
import wisp
import wisp/wisp_mist

pub fn main() {
  wisp.configure_logger()
  let log_level = envoy.get("LOG_LEVEL") |> result.unwrap("info")
  wisp.set_logger_level(case log_level {
    "debug" -> wisp.DebugLevel
    "warning" -> wisp.WarningLevel
    "error" -> wisp.ErrorLevel
    _ -> wisp.InfoLevel
  })

  let cfg = case config.load() {
    Ok(c) -> c
    Error(reason) -> {
      io.println("ERROR: " <> reason)
      panic as "missing required configuration"
    }
  }

  wisp.log_info(
    "db="
    <> cfg.database_path
    <> " runs="
    <> cfg.runs_dir
    <> " docker="
    <> cfg.docker_socket,
  )

  let assert Ok(db) = connection.open(cfg.database_path)
  let assert Ok(_) = migrations.run(db)

  let assert Ok(registry) = run_registry.start()
  let assert Ok(pubsub_subject) = pubsub.start()
  let assert Ok(history_lock) = history_mutex.start()
  reattach.run_all(db, cfg, registry, pubsub_subject)
  let assert Ok(_gc_scheduler) = gc_scheduler.start(db, cfg)
  let assert Ok(_resume_scheduler) =
    resume_scheduler.start(db, cfg, registry, pubsub_subject)
  let ctx =
    Context(
      db: db,
      config: cfg,
      run_registry: registry,
      pubsub: pubsub_subject,
      history_mutex: history_lock,
    )

  let wisp_fn =
    wisp_mist.handler(fn(req) { router.handle(req, ctx) }, cfg.secret_key)
  let combined = fn(req: http_req.Request(mist.Connection)) {
    case http_req.path_segments(req) {
      ["api", "runs", id, "shell"] -> shell_ws.upgrade(req, ctx, id)
      ["api", "ws", "states"] -> states_ws.upgrade(req, ctx)
      ["api", "ws", "usage"] -> usage_ws.upgrade(req, ctx)
      _ -> wisp_fn(req)
    }
  }

  let assert Ok(_) =
    combined
    |> mist.new()
    |> mist.bind("0.0.0.0")
    |> mist.port(cfg.port)
    |> mist.start()

  wisp.log_info("listening on :" <> int.to_string(cfg.port))
  process.sleep_forever()
}
