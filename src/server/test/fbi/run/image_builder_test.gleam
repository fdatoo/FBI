import fbi/run/image_builder
import gleam/dict
import gleam/option.{None, Some}
import gleam/string
import gleeunit/should

pub fn compute_hash_deterministic_test() {
  let h1 = image_builder.compute_hash(None, None, "#!/bin/bash\necho hi\n")
  let h2 = image_builder.compute_hash(None, None, "#!/bin/bash\necho hi\n")
  h1 |> should.equal(h2)
}

pub fn compute_hash_length_test() {
  let h = image_builder.compute_hash(None, None, "postbuild")
  string.length(h) |> should.equal(16)
}

pub fn compute_hash_differs_on_postbuild_test() {
  let h1 = image_builder.compute_hash(None, None, "v1")
  let h2 = image_builder.compute_hash(None, None, "v2")
  h1 |> should.not_equal(h2)
}

pub fn compute_hash_differs_on_override_test() {
  let h1 = image_builder.compute_hash(None, None, "pb")
  let h2 =
    image_builder.compute_hash(None, Some("{\"base\":\"ubuntu:22.04\"}"), "pb")
  h1 |> should.not_equal(h2)
}

pub fn compute_hash_differs_on_dc_files_test() {
  let files = dict.from_list([#("devcontainer.json", "{\"image\":\"ubuntu\"}")])
  let h1 = image_builder.compute_hash(None, None, "pb")
  let h2 = image_builder.compute_hash(Some(files), None, "pb")
  h1 |> should.not_equal(h2)
}

pub fn compute_hash_dc_files_order_stable_test() {
  let files1 = dict.from_list([#("a.json", "aaa"), #("b.json", "bbb")])
  let files2 = dict.from_list([#("b.json", "bbb"), #("a.json", "aaa")])
  let h1 = image_builder.compute_hash(Some(files1), None, "pb")
  let h2 = image_builder.compute_hash(Some(files2), None, "pb")
  h1 |> should.equal(h2)
}

pub fn compute_hash_differs_on_claude_version_test() {
  let h1 =
    image_builder.compute_hash_with_versions(
      None,
      None,
      "pb",
      "1.0.0",
      "2.92.0",
      "20",
    )
  let h2 =
    image_builder.compute_hash_with_versions(
      None,
      None,
      "pb",
      "1.0.1",
      "2.92.0",
      "20",
    )
  h1 |> should.not_equal(h2)
}

pub fn compute_hash_differs_on_gh_version_test() {
  let h1 =
    image_builder.compute_hash_with_versions(
      None,
      None,
      "pb",
      "1.0.0",
      "2.92.0",
      "20",
    )
  let h2 =
    image_builder.compute_hash_with_versions(
      None,
      None,
      "pb",
      "1.0.0",
      "2.93.0",
      "20",
    )
  h1 |> should.not_equal(h2)
}

pub fn compute_hash_differs_on_node_major_test() {
  let h1 =
    image_builder.compute_hash_with_versions(
      None,
      None,
      "pb",
      "1.0.0",
      "2.92.0",
      "20",
    )
  let h2 =
    image_builder.compute_hash_with_versions(
      None,
      None,
      "pb",
      "1.0.0",
      "2.92.0",
      "22",
    )
  h1 |> should.not_equal(h2)
}

// ── tools_hash ─────────────────────────────────────────────────────────────

pub fn tools_hash_length_test() {
  let h = image_builder.tools_hash_with("1.0.0", "2.0.0", "20", "script")
  string.length(h) |> should.equal(16)
}

pub fn tools_hash_deterministic_test() {
  let h1 = image_builder.tools_hash_with("1.0.0", "2.0.0", "20", "script")
  let h2 = image_builder.tools_hash_with("1.0.0", "2.0.0", "20", "script")
  h1 |> should.equal(h2)
}

pub fn tools_hash_differs_on_claude_version_test() {
  let h1 = image_builder.tools_hash_with("1.0.0", "2.0.0", "20", "script")
  let h2 = image_builder.tools_hash_with("1.0.1", "2.0.0", "20", "script")
  h1 |> should.not_equal(h2)
}

pub fn tools_hash_differs_on_gh_version_test() {
  let h1 = image_builder.tools_hash_with("1.0.0", "2.0.0", "20", "script")
  let h2 = image_builder.tools_hash_with("1.0.0", "2.1.0", "20", "script")
  h1 |> should.not_equal(h2)
}

pub fn tools_hash_differs_on_node_major_test() {
  let h1 = image_builder.tools_hash_with("1.0.0", "2.0.0", "20", "script")
  let h2 = image_builder.tools_hash_with("1.0.0", "2.0.0", "22", "script")
  h1 |> should.not_equal(h2)
}

pub fn tools_hash_differs_on_script_content_test() {
  let h1 = image_builder.tools_hash_with("1.0.0", "2.0.0", "20", "v1")
  let h2 = image_builder.tools_hash_with("1.0.0", "2.0.0", "20", "v2")
  h1 |> should.not_equal(h2)
}

pub fn tools_tag_format_test() {
  // Real tools_tag() reads from disk; just sanity check the format.
  let tag = image_builder.tools_tag()
  string.starts_with(tag, "fbi/tools:") |> should.be_true
}
