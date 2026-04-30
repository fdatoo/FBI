import gleam/http
import gleam/json
import gleam/list
import gleam/result
import gleam/string
import simplifile
import wisp.{type Request, type Response}

const scenarios_dir = "priv/quantico"

pub fn handle_scenarios(req: Request) -> Response {
  case req.method {
    http.Get -> serve_list()
    _ -> wisp.method_not_allowed([http.Get])
  }
}

fn serve_list() -> Response {
  let scenarios =
    simplifile.read_directory(scenarios_dir)
    |> result.unwrap([])
    |> list.filter(fn(name) { string.ends_with(name, ".json") })
    |> list.map(fn(name) { string.replace(name, ".json", "") })
    |> list.sort(string.compare)
  json.object([#("scenarios", json.array(scenarios, json.string))])
  |> json.to_string()
  |> wisp.json_response(200)
}
