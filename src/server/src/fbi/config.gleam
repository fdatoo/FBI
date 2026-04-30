import envoy
import gleam/bit_array
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import simplifile

pub type Config {
  Config(
    port: Int,
    secret_key: String,
    database_path: String,
    runs_dir: String,
    git_author_name: String,
    git_author_email: String,
    web_dist_dir: Option(String),
    docker_socket: String,
    docker_gid: Option(Int),
    ssh_auth_sock: Option(String),
    claude_dir: Option(String),
    secrets_key: BitArray,
    default_plugins: List(String),
    default_marketplaces: List(String),
    quantico_binary_path: Option(String),
  )
}

pub fn load() -> Result(Config, String) {
  use port <- result.try(env_int("PORT", 3000))
  use db_path <- result.try(env_required("DATABASE_PATH"))
  use runs_dir <- result.try(env_required("RUNS_DIR"))
  use author_name <- result.try(env_required("GIT_AUTHOR_NAME"))
  use author_email <- result.try(env_required("GIT_AUTHOR_EMAIL"))
  use key <- result.try(load_secrets_key())
  let web_dist_dir = env_optional("WEB_DIST_DIR")
  let docker_socket =
    envoy.get("DOCKER_SOCKET") |> result.unwrap("/var/run/docker.sock")
  let docker_gid = case env_optional("HOST_DOCKER_GID") {
    None -> None
    Some(s) -> int.parse(s) |> option.from_result
  }
  let ssh_auth_sock = env_optional("HOST_SSH_AUTH_SOCK")
  let claude_dir = env_optional("HOST_CLAUDE_DIR")
  let default_plugins =
    envoy.get("FBI_DEFAULT_PLUGINS")
    |> result.unwrap("")
    |> string.split("\n")
    |> list.filter(fn(s) { s != "" })
  let default_marketplaces =
    envoy.get("FBI_DEFAULT_MARKETPLACES")
    |> result.unwrap("")
    |> string.split("\n")
    |> list.filter(fn(s) { s != "" })
  let secret_key =
    envoy.get("SECRET_KEY_BASE") |> result.unwrap("dev-secret-key-base-32chars")
  let quantico_binary_path = env_optional("FBI_QUANTICO_BINARY_PATH")
  Ok(Config(
    port: port,
    secret_key: secret_key,
    database_path: db_path,
    runs_dir: runs_dir,
    git_author_name: author_name,
    git_author_email: author_email,
    web_dist_dir: web_dist_dir,
    docker_socket: docker_socket,
    docker_gid: docker_gid,
    ssh_auth_sock: ssh_auth_sock,
    claude_dir: claude_dir,
    secrets_key: key,
    default_plugins: default_plugins,
    default_marketplaces: default_marketplaces,
    quantico_binary_path: quantico_binary_path,
  ))
}

pub fn env_required(name: String) -> Result(String, String) {
  envoy.get(name) |> result.map_error(fn(_) { name <> " is required" })
}

pub fn env_int(name: String, default: Int) -> Result(Int, String) {
  case envoy.get(name) {
    Error(_) -> Ok(default)
    Ok(s) ->
      int.parse(s) |> result.map_error(fn(_) { name <> " must be an integer" })
  }
}

pub fn env_optional(name: String) -> Option(String) {
  envoy.get(name) |> option.from_result
}

fn load_secrets_key() -> Result(BitArray, String) {
  case envoy.get("SECRETS_KEY_FILE") {
    Error(_) -> Ok(<<0:size(256)>>)
    Ok(path) ->
      case simplifile.read_bits(path) {
        Ok(bits) ->
          case bit_array.byte_size(bits) == 32 {
            True -> Ok(bits)
            False -> Error("SECRETS_KEY_FILE must contain exactly 32 bytes")
          }
        Error(_) -> Error("Cannot read SECRETS_KEY_FILE: " <> path)
      }
  }
}
