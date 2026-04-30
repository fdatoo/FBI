import fbi/context.{type Context}
import fbi/pubsub
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/http/request
import gleam/http/response
import gleam/option.{Some}
import mist

type ConnState {
  ConnState(
    client: process.Subject(Dynamic),
    pubsub: process.Subject(pubsub.PubsubMsg),
  )
}

pub fn upgrade(
  req: request.Request(mist.Connection),
  ctx: Context,
) -> response.Response(mist.ResponseData) {
  mist.websocket(
    request: req,
    on_init: fn(_conn) -> #(ConnState, option.Option(process.Selector(Dynamic))) {
      let client: process.Subject(Dynamic) = process.new_subject()
      process.send(ctx.pubsub, pubsub.Subscribe(topic: "usage", client: client))
      let selector: process.Selector(Dynamic) =
        process.new_selector() |> process.select(client)
      #(ConnState(client: client, pubsub: ctx.pubsub), Some(selector))
    },
    handler: fn(
      state: ConnState,
      msg: mist.WebsocketMessage(Dynamic),
      conn: mist.WebsocketConnection,
    ) -> mist.Next(ConnState, Dynamic) {
      case msg {
        mist.Custom(payload) -> {
          // payload is Dynamic; attempt to decode as String
          case decode.run(payload, decode.string) {
            Ok(body) -> {
              let _ = mist.send_text_frame(conn, body)
              mist.continue(state)
            }
            Error(_) -> mist.continue(state)
          }
        }
        mist.Closed | mist.Shutdown -> {
          process.send(
            state.pubsub,
            pubsub.Unsubscribe(topic: "usage", client: state.client),
          )
          mist.stop()
        }
        _ -> mist.continue(state)
      }
    },
    on_close: fn(state: ConnState) -> Nil {
      process.send(
        state.pubsub,
        pubsub.Unsubscribe(topic: "usage", client: state.client),
      )
      Nil
    },
  )
}
