import fbi/config.{type Config}
import fbi/db/projects.{type Project}
import fbi/docker
import fbi/run/image_builder
import gleam/int
import gleam/list
import gleam/option.{None}
import gleam/set
import gleam/string
import wisp

pub type GcResult {
  GcResult(deleted_count: Int, deleted_bytes: Int, errors: List(GcError))
}

pub type GcError {
  GcError(tag: String, message: String)
}

const retention_days = 30

/// Sweeps stale fbi/p* images. Uses the same hash as image_builder so that
/// currently-reachable images are never deleted.
pub fn sweep(
  projects: List(Project),
  postbuild: String,
  now_ms: Int,
  config: Config,
) -> GcResult {
  let reachable = build_reachable_set(projects, postbuild)
  let cutoff_sec = now_ms / 1000 - retention_days * 86_400
  case docker.connect(config.docker_socket) {
    Error(e) -> {
      wisp.log_error("image_gc: docker connect: " <> docker.describe_error(e))
      GcResult(deleted_count: 0, deleted_bytes: 0, errors: [])
    }
    Ok(sock) -> {
      let gc_result = do_sweep(sock, reachable, cutoff_sec)
      docker.close(sock)
      gc_result
    }
  }
}

fn build_reachable_set(
  projects: List(Project),
  postbuild: String,
) -> set.Set(String) {
  let project_tags =
    list.flat_map(projects, fn(p) {
      let hash =
        image_builder.compute_hash(
          None,
          p.devcontainer_override_json,
          postbuild,
        )
      let id = int.to_string(p.id)
      ["fbi/p" <> id <> ":" <> hash, "fbi/p" <> id <> "-base:" <> hash]
    })
  // The shared tools image is project-agnostic; protect the current one
  // so a sweep doesn't delete it out from under in-flight runs.
  [image_builder.tools_tag(), ..project_tags]
  |> set.from_list
}

fn do_sweep(
  sock: docker.Socket,
  reachable: set.Set(String),
  cutoff_sec: Int,
) -> GcResult {
  case docker.list_containers(sock, True), docker.list_images(sock) {
    Error(e), _ -> {
      wisp.log_warning(
        "image_gc: list_containers failed: " <> docker.describe_error(e),
      )
      GcResult(deleted_count: 0, deleted_bytes: 0, errors: [])
    }
    _, Error(e) -> {
      wisp.log_warning(
        "image_gc: list_images failed: " <> docker.describe_error(e),
      )
      GcResult(deleted_count: 0, deleted_bytes: 0, errors: [])
    }
    Ok(containers), Ok(images) -> {
      let used_ids = list.map(containers, fn(c) { c.image_id }) |> set.from_list
      let to_delete = find_deletable(images, used_ids, reachable, cutoff_sec)
      delete_images(sock, to_delete)
    }
  }
}

fn find_deletable(
  images: List(docker.ImageInfo),
  used_ids: set.Set(String),
  reachable: set.Set(String),
  cutoff_sec: Int,
) -> List(#(String, Int)) {
  list.flat_map(images, fn(img) {
    case set.contains(used_ids, img.id) {
      True -> []
      False -> {
        let fbi_tags =
          list.filter(img.repo_tags, fn(t) {
            string.starts_with(t, "fbi/p") || string.starts_with(t, "fbi/tools")
          })
        case fbi_tags {
          [] -> []
          _ ->
            case img.created > cutoff_sec {
              True -> []
              False ->
                case list.any(fbi_tags, fn(t) { set.contains(reachable, t) }) {
                  True -> []
                  False -> list.map(fbi_tags, fn(t) { #(t, img.size) })
                }
            }
        }
      }
    }
  })
}

fn delete_images(
  sock: docker.Socket,
  to_delete: List(#(String, Int)),
) -> GcResult {
  list.fold(to_delete, GcResult(0, 0, []), fn(acc, pair) {
    let #(tag, size) = pair
    case docker.remove_image(sock, tag) {
      Ok(Nil) ->
        GcResult(
          deleted_count: acc.deleted_count + 1,
          deleted_bytes: acc.deleted_bytes + size,
          errors: acc.errors,
        )
      Error(e) ->
        GcResult(..acc, errors: [
          GcError(tag: tag, message: docker.describe_error(e)),
          ..acc.errors
        ])
    }
  })
}
