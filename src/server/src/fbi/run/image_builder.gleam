import fbi/config.{type Config}
import fbi/docker
import fbi/docker/tar
import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import simplifile
import wisp

/// Packages always installed in the post-layer (sorted for hash stability).
const always_packages = [
  "ca-certificates", "claude-cli", "gh", "git", "openssh-client",
]

/// Pinned tool versions. Bumping any of these invalidates the build cache
/// (the values are folded into compute_hash) and changes the Docker
/// build args passed to the post-layer.
const claude_code_version = "2.1.123"

const gh_version = "2.92.0"

const node_major = "20"

/// Resolves the Docker image tag for a project, building it if necessary.
/// Returns Ok(tag) on success or Error(reason) on failure.
/// Calls on_log with build progress chunks suitable for terminal streaming.
pub fn resolve(
  project_id: Int,
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  config: Config,
  on_log: fn(String) -> Nil,
) -> Result(String, String) {
  use postbuild <- result.try(read_postbuild())
  let hash = compute_hash(dc_files, override_json, postbuild)
  let id = int.to_string(project_id)
  let final_tag = "fbi/p" <> id <> ":" <> hash
  let base_tag = "fbi/p" <> id <> "-base:" <> hash
  case image_exists_fresh(config, final_tag) {
    True -> {
      wisp.log_debug("run: image " <> final_tag <> " already exists, reusing")
      Ok(final_tag)
    }
    False -> {
      use _ <- result.try(ensure_base(
        config,
        base_tag,
        dc_files,
        override_json,
        on_log,
      ))
      use tools_tag <- result.try(ensure_tools(config, on_log))
      use _ <- result.try(build_post_layer(
        config,
        base_tag,
        final_tag,
        tools_tag,
        postbuild,
        on_log,
      ))
      case image_exists_fresh(config, final_tag) {
        True -> Ok(final_tag)
        False ->
          Error(
            "post-layer build succeeded but " <> final_tag <> " is not present",
          )
      }
    }
  }
}

/// Tag of the shared tools image for the current pinned versions.
/// Exposed so image_gc can mark it reachable.
pub fn tools_tag() -> String {
  "fbi/tools:" <> tools_hash()
}

/// 16-char hex hash for the shared tools image. Inputs: pinned tool
/// versions and the contents of postbuild-tools.sh.
pub fn tools_hash() -> String {
  let script = case read_postbuild_tools() {
    Ok(s) -> s
    Error(_) -> ""
  }
  tools_hash_with(claude_code_version, gh_version, node_major, script)
}

pub fn tools_hash_with(
  cc_ver: String,
  gh_ver: String,
  node_maj: String,
  tools_script: String,
) -> String {
  let content =
    "cc:"
    <> cc_ver
    <> "\ngh:"
    <> gh_ver
    <> "\nnodemaj:"
    <> node_maj
    <> "\nscript:"
    <> tools_script
  let hash_bytes = sha256(bit_array.from_string(content))
  let hex = hex_encode_lower(hash_bytes)
  string.slice(hex, 0, 16)
}

fn image_exists_fresh(config: Config, tag: String) -> Bool {
  case docker.connect(config.docker_socket) {
    Error(_) -> False
    Ok(sock) -> {
      let result = image_exists(sock, tag)
      docker.close(sock)
      result
    }
  }
}

/// Computes a 16-char hex hash over the full build configuration.
/// This is the canonical hash used by both image_builder and image_gc —
/// the inputs and their order must never diverge between the two.
pub fn compute_hash(
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  postbuild: String,
) -> String {
  compute_hash_with_versions(
    dc_files,
    override_json,
    postbuild,
    claude_code_version,
    gh_version,
    node_major,
  )
}

/// Same as compute_hash but with the pinned tool versions and tools-image
/// hash explicitly passed in. Exposed so tests can vary the inputs without
/// touching the constants.
pub fn compute_hash_with_versions(
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  postbuild: String,
  cc_ver: String,
  gh_ver: String,
  node_maj: String,
) -> String {
  // The tools image content also changes when the postbuild-tools.sh
  // script changes; those changes flow through tools_hash and out here.
  let tools_script = case read_postbuild_tools() {
    Ok(s) -> s
    Error(_) -> ""
  }
  let tools = tools_hash_with(cc_ver, gh_ver, node_maj, tools_script)
  let dc_part = case dc_files {
    None -> ""
    Some(files) ->
      dict.keys(files)
      |> list.sort(string.compare)
      |> list.map(fn(k) {
        k <> ":" <> result.unwrap(dict.get(files, k), "") <> "\n"
      })
      |> string.join("")
  }
  let always_str = string.join(always_packages, ",")
  let content =
    "dev:"
    <> dc_part
    <> "\nover:"
    <> option.unwrap(override_json, "")
    <> "\nalways:"
    <> always_str
    <> "\npostbuild:"
    <> postbuild
    <> "\ncc:"
    <> cc_ver
    <> "\ngh:"
    <> gh_ver
    <> "\nnodemaj:"
    <> node_maj
    <> "\ntools:"
    <> tools
  let hash_bytes = sha256(bit_array.from_string(content))
  let hex = hex_encode_lower(hash_bytes)
  string.slice(hex, 0, 16)
}

fn read_postbuild_tools() -> Result(String, String) {
  read_priv("static/postbuild-tools.sh")
}

/// Reads a file from the fbi app's priv directory, resolved via
/// code:priv_dir(fbi). Works regardless of the running server's CWD —
/// the previous CWD-relative simplifile.read failed when the gleam
/// release was started from a directory other than src/server.
fn read_priv(rel_path: String) -> Result(String, String) {
  case fbi_priv_read(rel_path) {
    Ok(bin) ->
      bit_array.to_string(bin)
      |> result.map_error(fn(_) { "non-utf8 bytes in priv/" <> rel_path })
    Error(reason) -> Error("read " <> rel_path <> ": " <> reason)
  }
}

/// Reads priv/static/postbuild.sh from the fbi app's priv dir. Public so
/// callers in other modules (image_gc, settings) can hash + GC against
/// the same content image_builder uses.
pub fn read_postbuild() -> Result(String, String) {
  read_priv("static/postbuild.sh")
}

fn image_exists(sock: docker.Socket, tag: String) -> Bool {
  case docker.list_images(sock) {
    Ok(images) ->
      list.any(images, fn(img) { list.contains(img.repo_tags, tag) })
    Error(e) -> {
      wisp.log_warning(
        "image_exists list_images failed: " <> docker.describe_error(e),
      )
      False
    }
  }
}

fn ensure_base(
  config: Config,
  base_tag: String,
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  case image_exists_fresh(config, base_tag) {
    True -> Ok(Nil)
    False ->
      case dc_files {
        Some(files) -> build_devcontainer(files, base_tag, config, on_log)
        None -> build_fallback(override_json, base_tag, config, on_log)
      }
  }
}

fn build_devcontainer(
  files: Dict(String, String),
  tag: String,
  _config: Config,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  let tmp_dir =
    "/tmp/fbi-dc-build-"
    <> int.to_string(now_ms())
    <> "-"
    <> int.to_string(unique_int())
  let dc_dir = tmp_dir <> "/.devcontainer"
  use _ <- result.try(
    simplifile.create_directory_all(dc_dir)
    |> result.map_error(fn(e) {
      "mkdir devcontainer: " <> simplifile.describe_error(e)
    }),
  )
  use _ <- result.try(write_dc_files(files, dc_dir))
  on_log("[fbi] building devcontainer image " <> tag <> "\n")
  let npx = find_executable("npx")
  // Stream npx output so devcontainer build failures are visible in the
  // terminal instead of being captured to a discarded buffer.
  let on_chunk = fn(bin: BitArray) -> Nil {
    case bit_array.to_string(bin) {
      Ok(s) -> on_log(s)
      Error(_) -> Nil
    }
  }
  let #(exit_code, _bytes) =
    fbi_cmd_run_streaming(
      npx,
      [
        "-y", "@devcontainers/cli@0.67.0", "build", "--workspace-folder",
        tmp_dir, "--image-name", tag,
      ],
      [],
      on_chunk,
    )
  let _ = simplifile.delete(tmp_dir)
  case exit_code {
    0 -> Ok(Nil)
    code ->
      Error("devcontainer build failed (exit " <> int.to_string(code) <> ")")
  }
}

fn write_dc_files(
  files: Dict(String, String),
  dc_dir: String,
) -> Result(Nil, String) {
  dict.to_list(files)
  |> list.try_each(fn(pair) {
    let #(name, content) = pair
    simplifile.write(dc_dir <> "/" <> name, content)
    |> result.map_error(fn(e) {
      "write " <> name <> ": " <> simplifile.describe_error(e)
    })
  })
}

fn build_fallback(
  override_json: Option(String),
  tag: String,
  config: Config,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  let base_image = get_json_string(override_json, "base", "ubuntu:24.04")
  let apt_packages = get_json_string_list(override_json, "apt")
  let apt_str = string.join(apt_packages, " ")
  let dockerfile =
    "FROM "
    <> base_image
    <> "\nENV DEBIAN_FRONTEND=noninteractive\n"
    <> case apt_str {
      "" -> ""
      pkgs ->
        "RUN apt-get update && apt-get install -y --no-install-recommends "
        <> pkgs
        <> " && rm -rf /var/lib/apt/lists/*\n"
    }
  let archive =
    tar.build(
      dict.from_list([#("Dockerfile", bit_array.from_string(dockerfile))]),
    )
  on_log("[fbi] building base image " <> tag <> "\n")
  build_image_fresh(config, archive, tag, on_log)
  |> result.map_error(fn(e) { "build_fallback: " <> e })
}

fn ensure_tools(
  config: Config,
  on_log: fn(String) -> Nil,
) -> Result(String, String) {
  let tag = tools_tag()
  case image_exists_fresh(config, tag) {
    True -> Ok(tag)
    False -> {
      // Log first so a missing-file or buildx-not-installed failure shows
      // *which* step is in flight, instead of vanishing before any output.
      on_log("[fbi] building shared tools image " <> tag <> "\n")
      use script <- result.try(read_postbuild_tools())
      let dockerfile =
        "# syntax=docker/dockerfile:1.6\n"
        <> "FROM node:"
        <> node_major
        <> "-slim\n"
        <> "ARG CLAUDE_CODE_VERSION="
        <> claude_code_version
        <> "\nARG GH_VERSION="
        <> gh_version
        <> "\nENV CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION GH_VERSION=$GH_VERSION\n"
        <> "COPY postbuild-tools.sh /tmp/postbuild-tools.sh\n"
        <> "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n"
        <> "    --mount=type=cache,target=/root/.npm,sharing=locked \\\n"
        <> "    bash /tmp/postbuild-tools.sh && rm -f /tmp/postbuild-tools.sh\n"
      use _ <- result.try(buildx_build_with_files(
        tag,
        dict.from_list([
          #("Dockerfile", dockerfile),
          #("postbuild-tools.sh", script),
        ]),
        on_log,
      ))
      Ok(tag)
    }
  }
}

fn build_post_layer(
  config: Config,
  base_tag: String,
  final_tag: String,
  tools_tag: String,
  postbuild: String,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  let _ = config
  // The per-project image stages node from node:<major>-slim and
  // claude+gh from the shared fbi/tools image. postbuild.sh handles
  // only project-side concerns (apt deps, agent user, ssh known_hosts).
  let dockerfile =
    "# syntax=docker/dockerfile:1.6\n"
    <> "FROM node:"
    <> node_major
    <> "-slim AS node\n"
    <> "FROM "
    <> tools_tag
    <> " AS tools\n"
    <> "FROM "
    <> base_tag
    <> "\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\n"
    <> "COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules\n"
    <> "COPY --from=tools /opt/fbi-tools /opt/fbi-tools\n"
    <> "RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm "
    <> "&& ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx "
    <> "&& ln -sf /opt/fbi-tools/bin/claude /usr/local/bin/claude "
    <> "&& ln -sf /opt/fbi-tools/bin/gh /usr/local/bin/gh\n"
    <> "USER root\n"
    <> "COPY postbuild.sh /tmp/postbuild.sh\n"
    <> "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n"
    <> "    bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh\n"
    <> "USER agent\n"
    <> "WORKDIR /workspace\n"
    <> "HEALTHCHECK --interval=10s --timeout=2s --start-period=120s --retries=3 \\\n"
    <> "  CMD test -f /fbi-state/ready || exit 1\n"
  on_log("[fbi] applying post-build layer → " <> final_tag <> "\n")
  buildx_build_with_files(
    final_tag,
    dict.from_list([
      #("Dockerfile", dockerfile),
      #("postbuild.sh", postbuild),
    ]),
    on_log,
  )
  |> result.map_error(fn(e) { "build_post_layer: " <> e })
}

/// Builds an image via `docker buildx build`, writing the supplied build
/// context files to a tempdir first. Buildx is required for cache mounts
/// (`RUN --mount=type=cache`) and structured progress streaming.
fn buildx_build_with_files(
  tag: String,
  files: Dict(String, String),
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  case buildx_available() {
    False ->
      Error(
        "docker buildx not available; install Docker 23+ or run "
        <> "`docker buildx install` to enable cache-mount builds",
      )
    True -> {
      let context_dir =
        "/tmp/fbi-build-"
        <> int.to_string(now_ms())
        <> "-"
        <> int.to_string(unique_int())
      use _ <- result.try(write_build_context(files, context_dir))
      let docker = find_executable("docker")
      let args = [
        "buildx", "build", "--load", "--progress=plain", "-t", tag, context_dir,
      ]
      let on_chunk = fn(bin: BitArray) -> Nil {
        case bit_array.to_string(bin) {
          Ok(s) -> on_log(s)
          Error(_) -> Nil
        }
      }
      let #(code, _bytes) = fbi_cmd_run_streaming(docker, args, [], on_chunk)
      let _ = simplifile.delete(context_dir)
      case code {
        0 -> Ok(Nil)
        c -> Error("buildx build failed (exit " <> int.to_string(c) <> ")")
      }
    }
  }
}

fn buildx_available() -> Bool {
  let docker = find_executable("docker")
  case fbi_cmd_run(docker, ["buildx", "version"], []) {
    #(0, _) -> True
    _ -> False
  }
}

fn write_build_context(
  files: Dict(String, String),
  dir: String,
) -> Result(Nil, String) {
  use _ <- result.try(
    simplifile.create_directory_all(dir)
    |> result.map_error(fn(e) {
      "mkdir " <> dir <> ": " <> simplifile.describe_error(e)
    }),
  )
  dict.to_list(files)
  |> list.try_each(fn(pair) {
    let #(name, content) = pair
    simplifile.write(dir <> "/" <> name, content)
    |> result.map_error(fn(e) {
      "write " <> name <> ": " <> simplifile.describe_error(e)
    })
  })
}

fn build_image_fresh(
  config: Config,
  archive: BitArray,
  tag: String,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  use sock <- result.try(
    docker.connect(config.docker_socket)
    |> result.map_error(fn(e) { "docker connect: " <> docker.describe_error(e) }),
  )
  let result =
    docker.build_image(sock, archive, tag, on_log)
    |> result.map_error(docker.describe_error)
  docker.close(sock)
  result
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

fn get_json_string(
  json_opt: Option(String),
  key: String,
  default: String,
) -> String {
  case json_opt {
    None -> default
    Some(s) -> {
      let decoder = {
        use val <- decode.optional_field(key, default, decode.string)
        decode.success(val)
      }
      case json.parse(s, decoder) {
        Ok(v) -> v
        Error(_) -> default
      }
    }
  }
}

fn get_json_string_list(json_opt: Option(String), key: String) -> List(String) {
  case json_opt {
    None -> []
    Some(s) -> {
      let decoder = {
        use val <- decode.optional_field(key, [], decode.list(decode.string))
        decode.success(val)
      }
      case json.parse(s, decoder) {
        Ok(v) -> v
        Error(_) -> []
      }
    }
  }
}

// ── Externals ─────────────────────────────────────────────────────────────────

@external(erlang, "fbi_crypto", "sha256")
fn sha256(data: BitArray) -> BitArray

@external(erlang, "fbi_crypto", "hex_encode_lower")
fn hex_encode_lower(data: BitArray) -> String

@external(erlang, "fbi_cmd", "run")
fn fbi_cmd_run(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
) -> #(Int, String)

@external(erlang, "fbi_cmd", "run_streaming")
fn fbi_cmd_run_streaming(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
  on_chunk: fn(BitArray) -> Nil,
) -> #(Int, Int)

@external(erlang, "fbi_priv", "read")
fn fbi_priv_read(rel_path: String) -> Result(BitArray, String)

@external(erlang, "fbi_cmd", "find_executable")
fn find_executable(name: String) -> String

@external(erlang, "fbi_time", "now_ms")
fn now_ms() -> Int

@external(erlang, "erlang", "unique_integer")
fn unique_int() -> Int
