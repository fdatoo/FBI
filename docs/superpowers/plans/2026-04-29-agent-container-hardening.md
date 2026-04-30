# Agent Container Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll up seven incremental hardening improvements to the FBI agent container build pipeline and runtime — pinned tool versions, multi-stage Node install, a shared tools image, BuildKit cache mounts, a healthcheck contract, shellcheck in CI, and Trivy image scanning.

**Architecture:** Today the per-project image is `[devcontainer or ubuntu fallback] → postbuild.sh layer (installs node, gh, claude-cli, creates agent user)`, built via the daemon `/build` HTTP endpoint and cached on a SHA256 hash of the inputs. We keep that two-layer shape but (a) pin the tools, (b) extract them into a shared `fbi/tools:<hash>` image consumed via `COPY --from=`, and (c) shell out to `docker buildx` for the per-project layer so we get cache mounts and structured log streaming.

**Tech Stack:** Gleam (image_builder, docker client), Erlang FFI (fbi_cmd, docker socket), Bash (postbuild / supervisor / history-op scripts), Docker Engine + Buildx, GitHub Actions CI.

**Out of scope:** Replacing the bash entrypoint with a Go/Rust binary; reworking the safeguard mirror protocol; per-project secret-manager integration. These were considered and deferred — the bash scripts are within the size where shellcheck is sufficient discipline, and the credentials mount is already `:ro` (the only fix needed there is a stale comment).

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `src/server/priv/static/postbuild.sh` | Per-project post-build (apt, agent user, ssh) | Modify — pin versions, drop NodeSource pipe-to-bash, drop tool installs that move to fbi/tools |
| `src/server/priv/static/postbuild-tools.sh` | Build-time install for fbi/tools image (node, gh, claude-cli) | **Create** |
| `src/server/priv/static/supervisor.sh` | Container entrypoint | Modify — write `/fbi-state/ready` before exec; fix stale comment |
| `src/server/src/fbi/run/image_builder.gleam` | Image build orchestration + cache hashing | Modify — pinned-version constants, tools-image build path, buildx subprocess, multi-stage Dockerfile templates |
| `src/server/src/fbi_cmd.erl` | Subprocess runner FFI | Modify — add `run_streaming/4` for line-callback output |
| `src/server/test/fbi/run/image_builder_test.gleam` | image_builder unit tests | Modify — add tests for tools-image hash + version pinning regression |
| `Makefile` | Top-level dev workflows | Modify — add `lint-shell` target wired into `lint` |
| `.github/workflows/ci.yml` | CI | Modify — add shellcheck step to `gleam` job; add new `image-scan` job |

Each phase below produces a working tree (tests pass, image builds locally) so phases can be shipped independently.

---

## Phase 1: Shellcheck in CI

Establish lint discipline before touching the bash scripts. Failing lints in later phases will then trip CI loudly.

### Task 1.1: Add `lint-shell` Make target

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Read current `lint` target structure**

Run: `grep -n "^lint" /Users/fdatoo/Desktop/FBI/Makefile`
Expected: lines for `lint:`, `lint-web:`, `lint-server:`, `lint-rust:`.

- [ ] **Step 2: Add `lint-shell` recipe**

Add a new target after `lint-rust`:

```makefile
lint-shell:
	shellcheck \
	    src/server/priv/static/supervisor.sh \
	    src/server/priv/static/postbuild.sh \
	    src/server/priv/static/finalizeBranch.sh \
	    src/server/priv/static/fbi-history-op.sh
```

And extend `lint`:

```makefile
lint: lint-web lint-server lint-rust lint-shell
```

Update `.PHONY` to include `lint-shell`.

- [ ] **Step 3: Update help text**

Add to the `help:` recipe block:

```makefile
	@echo "  make lint-shell      shellcheck on priv/static/*.sh"
```

- [ ] **Step 4: Run shellcheck locally and fix any pre-existing warnings**

Run: `make lint-shell`
Expected: zero warnings. If shellcheck flags anything pre-existing, fix it in this commit (e.g., `[ -n "${VAR:-}" ]` instead of `[ -n "$VAR" ]`).

If shellcheck is not installed: `brew install shellcheck`.

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add Makefile src/server/priv/static/*.sh
git commit -m "build: add shellcheck linting for priv/static/*.sh

Wire shellcheck into make lint via a new lint-shell target so future
edits to supervisor.sh, postbuild.sh, finalizeBranch.sh, and
fbi-history-op.sh get automated review."
```

### Task 1.2: Add shellcheck step to GitHub Actions

**Files:**
- Modify: `.github/workflows/ci.yml:34-62`

- [ ] **Step 1: Add shellcheck step to the `gleam` job**

Insert the following step in `.github/workflows/ci.yml` between "Format check" (line 58) and "Test" (line 61):

```yaml
      - name: Shellcheck
        run: |
          sudo apt-get update
          sudo apt-get install -y shellcheck
          shellcheck \
            priv/static/supervisor.sh \
            priv/static/postbuild.sh \
            priv/static/finalizeBranch.sh \
            priv/static/fbi-history-op.sh
```

The `gleam` job already sets `working-directory: src/server`, so the relative paths are correct.

- [ ] **Step 2: Verify locally that the same command sequence runs cleanly**

Run: `cd /Users/fdatoo/Desktop/FBI/src/server && shellcheck priv/static/supervisor.sh priv/static/postbuild.sh priv/static/finalizeBranch.sh priv/static/fbi-history-op.sh`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
cd /workspace
git add .github/workflows/ci.yml
git commit -m "ci: shellcheck priv/static/*.sh in the gleam job

Catches bash bugs in the agent container scripts before they ship."
```

---

## Phase 2: Pin tool versions

Today `npm install -g @anthropic-ai/claude-code` and `apt-get install gh` are unpinned, so a new release silently changes container behavior without the postbuild content changing — but since `compute_hash` already hashes the postbuild content verbatim, hardcoding the versions in the script also flows them into the cache key. Strategy: declare all pinned versions as Gleam constants in image_builder, then *substitute* them into the postbuild template at hash-and-build time. This makes version bumps a one-line change in typed code, gives the cache key automatic invalidation, and keeps a single source of truth.

### Task 2.1: Convert `postbuild.sh` to a parameterized template

**Files:**
- Modify: `src/server/priv/static/postbuild.sh:28-54`

- [ ] **Step 1: Replace unpinned tool installs with parameterized ones**

Replace the existing Node install block (lines 28–32) with:

```bash
  # Node.js — pinned via NodeSource. Version is interpolated by image_builder.
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  apt-get install -y --no-install-recommends nodejs=${NODE_DEB_VERSION}
```

Replace the gh install (line 42) with:

```bash
  apt-get install -y gh=${GH_VERSION}
```

Replace the claude-code install (line 53) with:

```bash
  npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
```

These environment variables come from build-args set by image_builder — `${NODE_MAJOR}`, `${NODE_DEB_VERSION}`, `${GH_VERSION}`, `${CLAUDE_CODE_VERSION}`.

- [ ] **Step 2: Add a guard at the top of the script**

Right after `set -euo pipefail` (line 16) add:

```bash
: "${NODE_MAJOR:?NODE_MAJOR required}"
: "${NODE_DEB_VERSION:?NODE_DEB_VERSION required}"
: "${GH_VERSION:?GH_VERSION required}"
: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION required}"
```

- [ ] **Step 3: Run shellcheck on the modified script**

Run: `cd /Users/fdatoo/Desktop/FBI/src/server && shellcheck priv/static/postbuild.sh`
Expected: exit 0.

### Task 2.2: Define version constants in `image_builder.gleam`

**Files:**
- Modify: `src/server/src/fbi/run/image_builder.gleam:17-20`
- Modify: `src/server/src/fbi/run/image_builder.gleam:77-105`

- [ ] **Step 1: Add version constants**

Add after `always_packages`:

```gleam
/// Pinned tool versions. Bumping any of these invalidates the build cache.
const claude_code_version = "1.0.78"
const gh_version = "2.62.0"
const node_major = "20"
const node_deb_version = "20.18.0-1nodesource1"
```

> *Implementer note: at execution time, replace these with the latest validated versions. Find the current claude-code via `npm view @anthropic-ai/claude-code version`, gh via `apt-cache madison gh` on Ubuntu 24.04, and the node deb via `apt-cache madison nodejs` after running the NodeSource setup script in a throwaway container.*

- [ ] **Step 2: Write a failing test that the hash includes the pinned versions**

Add to `src/server/test/fbi/run/image_builder_test.gleam`:

```gleam
pub fn compute_hash_changes_when_versions_change_test() {
  // Same postbuild content but pinned-version constants embedded in the
  // hashable string must differ → cache key must differ.
  let h1 = image_builder.compute_hash_with_versions(
    None, None, "pb", "1.0.0", "2.0.0", "20", "20.0.0",
  )
  let h2 = image_builder.compute_hash_with_versions(
    None, None, "pb", "1.0.1", "2.0.0", "20", "20.0.0",
  )
  h1 |> should.not_equal(h2)
}
```

Run: `cd src/server && gleam test`
Expected: FAIL — `compute_hash_with_versions` does not exist.

- [ ] **Step 3: Refactor `compute_hash` to take versions**

In `image_builder.gleam`, replace the existing `compute_hash` with a thin wrapper that uses the constants, and expose a `compute_hash_with_versions` that takes them explicitly (so tests can vary them):

```gleam
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
    node_deb_version,
  )
}

pub fn compute_hash_with_versions(
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  postbuild: String,
  cc_ver: String,
  gh_ver: String,
  node_maj: String,
  node_deb: String,
) -> String {
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
    "dev:" <> dc_part
    <> "\nover:" <> option.unwrap(override_json, "")
    <> "\nalways:" <> always_str
    <> "\npostbuild:" <> postbuild
    <> "\ncc:" <> cc_ver
    <> "\ngh:" <> gh_ver
    <> "\nnodemaj:" <> node_maj
    <> "\nnodedeb:" <> node_deb
  let hash_bytes = sha256(bit_array.from_string(content))
  let hex = hex_encode_lower(hash_bytes)
  string.slice(hex, 0, 16)
}
```

- [ ] **Step 4: Run the test**

Run: `cd src/server && gleam test`
Expected: PASS.

### Task 2.3: Pass versions through to the post-layer build

**Files:**
- Modify: `src/server/src/fbi/run/image_builder.gleam:221-242`

- [ ] **Step 1: Update the post-layer Dockerfile template to declare and consume the build args**

Replace the body of `build_post_layer` so the Dockerfile reads:

```gleam
let dockerfile =
  "FROM " <> base_tag <> "\n"
  <> "ARG CLAUDE_CODE_VERSION\n"
  <> "ARG GH_VERSION\n"
  <> "ARG NODE_MAJOR\n"
  <> "ARG NODE_DEB_VERSION\n"
  <> "ENV CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION GH_VERSION=$GH_VERSION NODE_MAJOR=$NODE_MAJOR NODE_DEB_VERSION=$NODE_DEB_VERSION\n"
  <> "USER root\n"
  <> "COPY postbuild.sh /tmp/postbuild.sh\n"
  <> "RUN bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh\n"
  <> "USER agent\n"
  <> "WORKDIR /workspace\n"
```

- [ ] **Step 2: The HTTP `/build` endpoint reads buildargs from the `buildargs` query param. Update `docker.build_image` signature to accept them.**

Read: `src/server/src/fbi/docker.gleam:379-404`

Add an optional `buildargs: Dict(String, String)` parameter to `build_image` and url-encode it as JSON into the `buildargs=` query param. Existing call sites pass `dict.new()`.

- [ ] **Step 3: Update `build_post_layer` to pass the args**

```gleam
let buildargs =
  dict.from_list([
    #("CLAUDE_CODE_VERSION", claude_code_version),
    #("GH_VERSION", gh_version),
    #("NODE_MAJOR", node_major),
    #("NODE_DEB_VERSION", node_deb_version),
  ])
docker.build_image(sock, archive, final_tag, buildargs, on_log)
```

- [ ] **Step 4: Run gleam tests + manual e2e build**

Run: `cd src/server && gleam test`
Expected: existing tests still pass.

Run a manual end-to-end build against a local Docker daemon:
```bash
cd /Users/fdatoo/Desktop/FBI && make build-image
docker run --rm fbi-image-default claude --version
docker run --rm fbi-image-default gh --version
docker run --rm fbi-image-default node --version
```
Expected: each command prints exactly the pinned version.

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add src/server/priv/static/postbuild.sh \
        src/server/src/fbi/run/image_builder.gleam \
        src/server/src/fbi/docker.gleam \
        src/server/test/fbi/run/image_builder_test.gleam
git commit -m "build: pin claude-code, gh, and nodejs versions

Versions are declared as constants in image_builder and threaded
through to postbuild.sh as Docker build args. The cache key now
covers them explicitly so a version bump invalidates the right
images and only those."
```

---

## Phase 3: Multi-stage Node install

Replace `curl … | bash` with `COPY --from=node:20-slim`. Multi-stage `COPY --from` is supported by the daemon's classic builder, so no buildx needed yet.

### Task 3.1: Switch the post-layer Dockerfile to multi-stage Node

**Files:**
- Modify: `src/server/src/fbi/run/image_builder.gleam` (post-layer Dockerfile template, set in Task 2.3)
- Modify: `src/server/priv/static/postbuild.sh:28-32`

- [ ] **Step 1: Update the Dockerfile template**

Modify the template inside `build_post_layer`:

```gleam
let dockerfile =
  "FROM node:" <> node_major <> "-slim AS node\n"
  <> "FROM " <> base_tag <> "\n"
  <> "ARG CLAUDE_CODE_VERSION\n"
  <> "ARG GH_VERSION\n"
  <> "ENV CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION GH_VERSION=$GH_VERSION\n"
  <> "COPY --from=node /usr/local/bin/node /usr/local/bin/node\n"
  <> "COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules\n"
  <> "RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm "
  <> "&& ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx\n"
  <> "USER root\n"
  <> "COPY postbuild.sh /tmp/postbuild.sh\n"
  <> "RUN bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh\n"
  <> "USER agent\n"
  <> "WORKDIR /workspace\n"
```

`NODE_MAJOR` and `NODE_DEB_VERSION` are no longer needed at runtime — drop them from buildargs and the postbuild script will no longer require them.

- [ ] **Step 2: Strip Node-installation logic from `postbuild.sh`**

In `priv/static/postbuild.sh`, remove the `apt-get install nodejs` line and the `curl … setup_${NODE_MAJOR}.x | bash -` line. Drop the `NODE_MAJOR` and `NODE_DEB_VERSION` `:?` guards. Keep all other apt installs (`git openssh-client ca-certificates curl gnupg sudo`).

- [ ] **Step 3: Verify locally**

Run: `make build-image && docker run --rm fbi-image-default node --version && docker run --rm fbi-image-default which curl`
Expected: prints `v20.x.x` and `/usr/bin/curl` (curl still installed via apt for the gh keyring step).

Also: `docker run --rm fbi-image-default cat /etc/apt/sources.list.d/*` should show NO `nodesource` entries.

- [ ] **Step 4: Commit**

```bash
cd /workspace
git add src/server/priv/static/postbuild.sh src/server/src/fbi/run/image_builder.gleam
git commit -m "build: install node via multi-stage COPY --from=node:20-slim

Drops the curl|bash NodeSource setup script in favor of pulling
node and npm out of the official node:20-slim image. Smaller
attack surface, deterministic version, no third-party apt repo."
```

---

## Phase 4: Shared `fbi/tools` image

Currently every per-project final layer reinstalls claude-code/gh into Docker layers tagged per-project. Move them into `fbi/tools:<tools_hash>` once and `COPY --from=fbi/tools` in each per-project image. Bumping a version causes one tools rebuild plus N cheap re-layers, instead of N expensive rebuilds.

### Task 4.1: Create the tools-image build script

**Files:**
- Create: `src/server/priv/static/postbuild-tools.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Build-time provisioner for the fbi/tools image. Installs gh and
# @anthropic-ai/claude-code at pinned versions into /opt/fbi-tools so
# the per-project final-layer image can COPY them in without polluting
# /usr/local.
#
# Required env (set as Docker build args):
#   GH_VERSION              e.g. 2.62.0
#   CLAUDE_CODE_VERSION     e.g. 1.0.78

set -euo pipefail

: "${GH_VERSION:?GH_VERSION required}"
: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION required}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg

# gh CLI: install into /opt/fbi-tools/bin via dpkg-deb extraction so we
# don't drag the apt repo into the final image.
mkdir -p /tmp/gh
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb" -o /tmp/gh/gh.deb
dpkg -x /tmp/gh/gh.deb /tmp/gh/extract
mkdir -p /opt/fbi-tools/bin /opt/fbi-tools/share/man
cp /tmp/gh/extract/usr/bin/gh /opt/fbi-tools/bin/gh
chmod 0755 /opt/fbi-tools/bin/gh
rm -rf /tmp/gh

# claude-code: npm-install into a private prefix, then symlink the entry
# point. Node itself is COPY'd from node:20-slim by the consumer Dockerfile,
# so we install it here too against the same base image.
npm install -g --prefix=/opt/fbi-tools "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Some claude-code releases drop the actual binary in $HOME/.local/bin via
# a "native build" installer rather than the npm prefix. If that happened,
# normalize it.
if [ ! -x /opt/fbi-tools/bin/claude ] && [ -x /root/.local/bin/claude ]; then
  cp /root/.local/bin/claude /opt/fbi-tools/bin/claude
  chmod 0755 /opt/fbi-tools/bin/claude
fi

rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Lint**

Run: `shellcheck src/server/priv/static/postbuild-tools.sh`
Expected: exit 0.

### Task 4.2: Add `ensure_tools` to `image_builder.gleam`

**Files:**
- Modify: `src/server/src/fbi/run/image_builder.gleam`

- [ ] **Step 1: Write a failing test for the tools-image hash**

Add to `image_builder_test.gleam`:

```gleam
pub fn tools_hash_changes_with_claude_version_test() {
  let h1 = image_builder.tools_hash_with("1.0.0", "2.62.0", "20", "tools-script")
  let h2 = image_builder.tools_hash_with("1.0.1", "2.62.0", "20", "tools-script")
  h1 |> should.not_equal(h2)
}

pub fn tools_hash_independent_of_project_test() {
  // tools_hash must NOT depend on dc_files / override_json — it's shared.
  let h_const = image_builder.tools_hash()
  string.length(h_const) |> should.equal(16)
}
```

Run: `cd src/server && gleam test`
Expected: FAIL — neither function exists.

- [ ] **Step 2: Implement `tools_hash` and `tools_hash_with`**

Add to `image_builder.gleam`:

```gleam
fn read_postbuild_tools() -> Result(String, String) {
  simplifile.read("priv/static/postbuild-tools.sh")
  |> result.map_error(fn(e) {
    "read postbuild-tools.sh: " <> simplifile.describe_error(e)
  })
}

pub fn tools_hash() -> String {
  let tools_script = case read_postbuild_tools() {
    Ok(s) -> s
    Error(_) -> ""
  }
  tools_hash_with(claude_code_version, gh_version, node_major, tools_script)
}

pub fn tools_hash_with(
  cc_ver: String,
  gh_ver: String,
  node_maj: String,
  tools_script: String,
) -> String {
  let content =
    "cc:" <> cc_ver
    <> "\ngh:" <> gh_ver
    <> "\nnodemaj:" <> node_maj
    <> "\nscript:" <> tools_script
  let hash_bytes = sha256(bit_array.from_string(content))
  let hex = hex_encode_lower(hash_bytes)
  string.slice(hex, 0, 16)
}
```

- [ ] **Step 3: Update `compute_hash_with_versions` to fold in the tools hash**

The per-project final cache must invalidate when the tools image changes:

```gleam
pub fn compute_hash_with_versions(
  dc_files: Option(Dict(String, String)),
  override_json: Option(String),
  postbuild: String,
  cc_ver: String,
  gh_ver: String,
  node_maj: String,
  node_deb: String,
) -> String {
  // ... existing dc_part / always_str ...
  let tools = tools_hash_with(cc_ver, gh_ver, node_maj, "")
  let content =
    "dev:" <> dc_part
    <> "\nover:" <> option.unwrap(override_json, "")
    <> "\nalways:" <> always_str
    <> "\npostbuild:" <> postbuild
    <> "\ntools:" <> tools
  // ... rest unchanged ...
}
```

> *Implementer note: passing `""` for tools_script here is intentional — at the per-project hash level we only care about the version triple, because the tools script content is fully captured by the standalone `tools_hash` and surfaces as the tools image tag. We don't want to re-read the file twice.*

Wait — that's not quite right. Re-read the script content:

```gleam
  let tools_script = case read_postbuild_tools() {
    Ok(s) -> s
    Error(_) -> ""
  }
  let tools = tools_hash_with(cc_ver, gh_ver, node_maj, tools_script)
```

- [ ] **Step 4: Run all hash tests**

Run: `cd src/server && gleam test`
Expected: PASS — including the new tools-hash tests and existing compute_hash tests.

### Task 4.3: Build the tools image when missing

**Files:**
- Modify: `src/server/src/fbi/run/image_builder.gleam`

- [ ] **Step 1: Add `ensure_tools` next to `ensure_base`**

```gleam
fn ensure_tools(
  sock: docker.Socket,
  on_log: fn(String) -> Nil,
) -> Result(String, String) {
  let tag = "fbi/tools:" <> tools_hash()
  case image_exists(sock, tag) {
    True -> Ok(tag)
    False -> {
      use script <- result.try(read_postbuild_tools())
      let dockerfile =
        "FROM node:" <> node_major <> "-slim\n"
        <> "ARG CLAUDE_CODE_VERSION\n"
        <> "ARG GH_VERSION\n"
        <> "ENV CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION GH_VERSION=$GH_VERSION\n"
        <> "COPY postbuild-tools.sh /tmp/postbuild-tools.sh\n"
        <> "RUN bash /tmp/postbuild-tools.sh && rm -f /tmp/postbuild-tools.sh\n"
      let archive =
        tar.build(
          dict.from_list([
            #("Dockerfile", bit_array.from_string(dockerfile)),
            #("postbuild-tools.sh", bit_array.from_string(script)),
          ]),
        )
      let buildargs = dict.from_list([
        #("CLAUDE_CODE_VERSION", claude_code_version),
        #("GH_VERSION", gh_version),
      ])
      on_log("[fbi] building shared tools image " <> tag <> "\n")
      use _ <- result.try(
        docker.build_image(sock, archive, tag, buildargs, on_log)
        |> result.map_error(fn(e) { "ensure_tools: " <> docker.describe_error(e) }),
      )
      Ok(tag)
    }
  }
}
```

- [ ] **Step 2: Wire `ensure_tools` into `resolve`**

In `resolve`, after `ensure_base` and before `build_post_layer`:

```gleam
use _ <- result.try(ensure_base(...))
use tools_tag <- result.try(ensure_tools(sock, on_log))
use _ <- result.try(build_post_layer(
  sock, base_tag, final_tag, tools_tag, postbuild, on_log,
))
```

- [ ] **Step 3: Update `build_post_layer` to consume `fbi/tools`**

Change the Dockerfile template (replacing the multi-stage `node:20-slim` reference from Phase 3, since tools now provides node + npm + claude + gh):

```gleam
fn build_post_layer(
  sock: docker.Socket,
  base_tag: String,
  final_tag: String,
  tools_tag: String,
  postbuild: String,
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  let dockerfile =
    "FROM " <> tools_tag <> " AS tools\n"
    <> "FROM " <> base_tag <> "\n"
    <> "COPY --from=tools /opt/fbi-tools /opt/fbi-tools\n"
    <> "COPY --from=tools /usr/local/bin/node /usr/local/bin/node\n"
    <> "COPY --from=tools /usr/local/lib/node_modules /usr/local/lib/node_modules\n"
    <> "RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm "
    <> "&& ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx "
    <> "&& ln -sf /opt/fbi-tools/bin/claude /usr/local/bin/claude "
    <> "&& ln -sf /opt/fbi-tools/bin/gh /usr/local/bin/gh\n"
    <> "USER root\n"
    <> "COPY postbuild.sh /tmp/postbuild.sh\n"
    <> "RUN bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh\n"
    <> "USER agent\n"
    <> "WORKDIR /workspace\n"
  // archive + docker.build_image as before, but buildargs no longer needs
  // CLAUDE_CODE_VERSION / GH_VERSION — those are baked into fbi/tools.
  ...
}
```

The per-project `postbuild.sh` no longer installs claude/gh/node — only the project-side concerns (apt git/openssh-client/sudo, agent user, ssh known_hosts, /workspace, /fbi).

- [ ] **Step 4: Strip claude/gh installs from `priv/static/postbuild.sh`**

Remove these blocks:
- Lines that install gh (the gh keyring + apt-get install gh)
- Lines that install claude-code via npm
- The "/root/.local/bin/claude → /usr/local/bin/claude" copy logic

Keep everything else (apt git/openssh-client/ca-certificates/curl/gnupg/sudo, agent user, sudoers, ssh known_hosts, /workspace, /fbi, /home/agent/.claude).

- [ ] **Step 5: Update `image_gc.gleam` to recognize the new tag namespace**

Read: `src/server/src/fbi/run/image_gc.gleam`

The GC currently sweeps stale `fbi/p<id>:<hash>` and `fbi/p<id>-base:<hash>` images. Add `fbi/tools:<hash>` to the recognized namespaces, but with a different retention policy: keep the latest tools image plus the most recent N (e.g. 3) for rollback. The exact rule depends on the GC's existing logic — read the file and adapt.

- [ ] **Step 6: Add a GC test for the tools tag**

Add to `src/server/test/fbi/run/image_gc_test.gleam` a test asserting that `fbi/tools:<hash>` images are recognized as fbi-managed and not deleted while in active use.

Run: `cd src/server && gleam test`
Expected: PASS.

- [ ] **Step 7: End-to-end verification**

```bash
cd /Users/fdatoo/Desktop/FBI
docker rmi $(docker images -q 'fbi/*') 2>/dev/null || true
make build-image
docker images | grep ^fbi/   # expect fbi/tools:<hash>, fbi/p1-base:<hash>, fbi/p1:<hash>
docker run --rm fbi-image-default claude --version
docker run --rm fbi-image-default gh --version
docker run --rm fbi-image-default node --version
```
Expected: all three commands print pinned versions; rebuilding the image without changing claude_code_version reuses fbi/tools.

- [ ] **Step 8: Commit**

```bash
cd /workspace
git add src/server/priv/static/postbuild.sh \
        src/server/priv/static/postbuild-tools.sh \
        src/server/src/fbi/run/image_builder.gleam \
        src/server/src/fbi/run/image_gc.gleam \
        src/server/test/fbi/run/image_builder_test.gleam \
        src/server/test/fbi/run/image_gc_test.gleam
git commit -m "build: extract claude/gh/node into shared fbi/tools image

Per-project images now COPY --from=fbi/tools rather than reinstalling
the toolchain in their own postbuild layer. Bumping a tool version
rebuilds fbi/tools once; per-project images get the new bits via a
cheap COPY layer. Cuts redundant npm/apt work proportional to the
number of projects."
```

---

## Phase 5: Healthcheck and readiness contract

Give the orchestrator and any external Docker tooling a single signal that the agent is ready to run. Also fix a stale comment in supervisor.sh.

### Task 5.1: Write `/fbi-state/ready` after setup

**Files:**
- Modify: `src/server/priv/static/supervisor.sh:182-203`
- Modify: `src/server/priv/static/supervisor.sh:20` (header comment)

- [ ] **Step 1: Insert ready-marker write before exec'ing claude**

In `supervisor.sh`, immediately before the `set +e` line at line 184, add:

```bash
# Signal "agent is about to start" to anyone watching /fbi-state.
# Distinct from /fbi-state/prompted (which the post-prompt write below
# uses) and /fbi-state/waiting (resume mode).
touch /fbi-state/ready
```

- [ ] **Step 2: Fix stale RW-OAuth comment**

The header at line 20 says:
```
#   /home/agent/.claude.json (host ~/.claude.json, RW — OAuth)
```

But `worker.gleam:211` mounts the credentials file `:ro`. Replace the line with:

```
#   /home/agent/.claude/.credentials.json (host credentials, RO — OAuth)
```

- [ ] **Step 3: Lint**

Run: `shellcheck src/server/priv/static/supervisor.sh`
Expected: exit 0.

### Task 5.2: Add HEALTHCHECK to the per-project Dockerfile

**Files:**
- Modify: `src/server/src/fbi/run/image_builder.gleam` (post-layer Dockerfile template)

- [ ] **Step 1: Add HEALTHCHECK directive**

In `build_post_layer`, append before `WORKDIR /workspace\n`:

```gleam
<> "HEALTHCHECK --interval=10s --timeout=2s --start-period=120s --retries=3 \\\n"
<> "  CMD test -f /fbi-state/ready || exit 1\n"
```

> *The 120s start period gives the supervisor time to clone the repo on slow networks before the healthcheck starts firing. Adjust if telemetry shows clones routinely take longer.*

- [ ] **Step 2: Verify with a live container**

```bash
make build-image
# launch a container the way worker.gleam does, or via the dev server
docker inspect --format '{{.State.Health.Status}}' <container-id>
# expect: starting → healthy after supervisor.sh writes /fbi-state/ready
```

- [ ] **Step 3: Commit**

```bash
cd /workspace
git add src/server/priv/static/supervisor.sh src/server/src/fbi/run/image_builder.gleam
git commit -m "run: add /fbi-state/ready marker and Docker HEALTHCHECK

supervisor.sh writes /fbi-state/ready right before exec'ing claude.
The Dockerfile HEALTHCHECK greps that file so generic Docker
tooling (docker ps, compose) sees the container as healthy. Also
fixes a stale supervisor.sh header comment that claimed the OAuth
credentials are mounted RW; worker.gleam mounts them :ro."
```

---

## Phase 6: BuildKit via `docker buildx`

Switch the per-project layer build (and the tools-image build) to `docker buildx build` so we can use `RUN --mount=type=cache,target=/var/cache/apt` and `--mount=type=cache,target=/root/.npm`. The daemon `/build` HTTP path stays as a fallback if buildx is missing.

### Task 6.1: Extend `fbi_cmd` to support streaming output

**Files:**
- Modify: `src/server/src/fbi_cmd.erl`

- [ ] **Step 1: Add `run_streaming/4`**

```erlang
-export([run/3, run_streaming/4, find_executable/1]).

%% run_streaming(Cmd, Args, Env, OnChunk) ->
%%     {ExitCode :: integer(), TotalBytes :: integer()}
%% Like run/3 but invokes OnChunk(Bin) for each output chunk as it arrives.
%% Used by docker.buildx_build to stream progress into the agent terminal.
run_streaming(Cmd, Args, Env, OnChunk) ->
    CmdStr = binary_to_list(Cmd),
    ArgsList = [binary_to_list(A) || A <- Args],
    EnvList = [{binary_to_list(K), binary_to_list(V)} || {K, V} <- Env],
    Port = open_port({spawn_executable, CmdStr},
                     [binary, exit_status, stderr_to_stdout,
                      {args, ArgsList}, {env, EnvList}]),
    stream(Port, OnChunk, 0).

stream(Port, OnChunk, Total) ->
    receive
        {Port, {data, Chunk}} ->
            OnChunk(Chunk),
            stream(Port, OnChunk, Total + byte_size(Chunk));
        {Port, {exit_status, Code}} ->
            {Code, Total}
    end.
```

- [ ] **Step 2: Add a Gleam external in `image_builder.gleam`**

```gleam
@external(erlang, "fbi_cmd", "run_streaming")
fn fbi_cmd_run_streaming(
  cmd: String,
  args: List(String),
  env: List(#(String, String)),
  on_chunk: fn(BitArray) -> Nil,
) -> #(Int, Int)
```

### Task 6.2: Add `buildx_build` helper and switch image_builder to it

**Files:**
- Modify: `src/server/src/fbi/docker.gleam` (or a new module `src/server/src/fbi/docker/buildx.gleam`)
- Modify: `src/server/src/fbi/run/image_builder.gleam`

- [ ] **Step 1: Add `buildx_available()` probe**

In `image_builder.gleam`:

```gleam
fn buildx_available() -> Bool {
  let docker = find_executable("docker")
  case fbi_cmd_run(docker, ["buildx", "version"], []) {
    #(0, _) -> True
    _ -> False
  }
}
```

- [ ] **Step 2: Add `buildx_build` that writes the build context to a tempdir and invokes `docker buildx build`**

```gleam
fn buildx_build(
  context_dir: String,
  tag: String,
  buildargs: Dict(String, String),
  on_log: fn(String) -> Nil,
) -> Result(Nil, String) {
  let docker = find_executable("docker")
  let arg_pairs =
    dict.to_list(buildargs)
    |> list.flat_map(fn(pair) {
      let #(k, v) = pair
      ["--build-arg", k <> "=" <> v]
    })
  let args =
    list.flatten([
      ["buildx", "build"],
      ["--load"],            // make image available to the local daemon
      ["--progress=plain"],  // unstructured stream-friendly output
      arg_pairs,
      ["-t", tag],
      [context_dir],
    ])
  let on_chunk = fn(bin: BitArray) -> Nil {
    case bit_array.to_string(bin) {
      Ok(s) -> on_log(s)
      Error(_) -> Nil
    }
  }
  case fbi_cmd_run_streaming(docker, args, [], on_chunk) {
    #(0, _) -> Ok(Nil)
    #(code, _) ->
      Error("buildx build failed (exit " <> int.to_string(code) <> ")")
  }
}
```

- [ ] **Step 3: Use `buildx_build` in `ensure_tools` and `build_post_layer`**

Where each currently calls `docker.build_image`, write the archive contents to a tempdir instead and call `buildx_build`. Fall back to the HTTP path if `buildx_available()` returns False:

```gleam
case buildx_available() {
  True -> {
    let tmp = "/tmp/fbi-build-" <> int.to_string(now_ms())
    use _ <- result.try(write_archive_to_dir(archive, tmp))
    let res = buildx_build(tmp, tag, buildargs, on_log)
    let _ = simplifile.delete(tmp)
    res
  }
  False -> {
    on_log("[fbi] buildx not available, falling back to /build HTTP\n")
    docker.build_image(sock, archive, tag, buildargs, on_log)
    |> result.map_error(fn(e) { docker.describe_error(e) })
  }
}
```

- [ ] **Step 4: Add cache mounts to the tools Dockerfile and per-project Dockerfile**

In `ensure_tools`, prepend `# syntax=docker/dockerfile:1.6` and rewrite the apt-get and npm install lines in `postbuild-tools.sh` to use cache mounts:

```dockerfile
# syntax=docker/dockerfile:1.6
FROM node:20-slim
ARG CLAUDE_CODE_VERSION
ARG GH_VERSION
ENV CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION GH_VERSION=$GH_VERSION
COPY postbuild-tools.sh /tmp/postbuild-tools.sh
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    --mount=type=cache,target=/root/.npm,sharing=locked \
    bash /tmp/postbuild-tools.sh && rm -f /tmp/postbuild-tools.sh
```

For the per-project Dockerfile, the apt run that installs git/openssh/sudo wants the same apt cache treatment.

`postbuild-tools.sh` and `postbuild.sh` need a one-line change: drop the `rm -rf /var/lib/apt/lists/*` since the cache mount handles it.

- [ ] **Step 5: Update CI to enable buildx**

In `.github/workflows/ci.yml`, the `gleam` job already runs on `ubuntu-latest`, which has buildx pre-installed. No change needed.

For local dev: shellcheck the script, ensure `docker buildx version` works on developer machines, document in README that buildx is required (or fallback path is fine).

- [ ] **Step 6: Verify cache mount benefit**

```bash
# Cold build
time make build-image
# Modify postbuild.sh trivially (e.g., change a comment) and rebuild
echo "# tickle" >> src/server/priv/static/postbuild.sh
time make build-image
# Expect: second run is meaningfully faster on the apt step thanks to
# the cache mount (no network re-download of debs).
git checkout src/server/priv/static/postbuild.sh
```

- [ ] **Step 7: Commit**

```bash
cd /workspace
git add src/server/src/fbi_cmd.erl \
        src/server/src/fbi/run/image_builder.gleam \
        src/server/src/fbi/docker.gleam \
        src/server/priv/static/postbuild-tools.sh \
        src/server/priv/static/postbuild.sh
git commit -m "build: use docker buildx with apt+npm cache mounts

The tools and per-project image builds now go through 'docker buildx
build' so RUN --mount=type=cache speeds up rebuilds. The HTTP /build
path is retained as a fallback when buildx is unavailable, so this
change is non-breaking on hosts without buildx."
```

---

## Phase 7: Trivy image scan in CI

### Task 7.1: Add an `image-scan` job to CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Append a new job**

After the `e2e-quantico` job, add:

```yaml
  image-scan:
    name: Trivy scan agent image
    runs-on: ubuntu-latest
    needs: gleam
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - uses: erlef/setup-beam@v1
        with:
          otp-version: '27.2'
          gleam-version: '1.9.1'
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2

      - name: Build NIF + Gleam
        working-directory: src/server
        run: |
          gleam deps download
          make nif
          gleam build

      - name: Build agent image
        run: make build-image

      - name: Find image tag
        id: tag
        run: |
          tag=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^fbi/p[0-9]+:' | head -1)
          echo "tag=$tag" >> $GITHUB_OUTPUT

      - name: Trivy scan
        uses: aquasecurity/trivy-action@0.24.0
        with:
          image-ref: ${{ steps.tag.outputs.tag }}
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'
          exit-code: '1'    # fail the job on CRITICAL/HIGH

      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: 'trivy-results.sarif'
```

- [ ] **Step 2: Tune the severity gate**

If the first run flips red on baseline CVEs we can't fix (e.g. Ubuntu base image issues unpatched upstream), change `exit-code: '1'` to `exit-code: '0'` and rely on the SARIF upload + GitHub Security tab for visibility instead of blocking PRs. Decide based on the first run's output.

- [ ] **Step 3: Commit**

```bash
cd /workspace
git add .github/workflows/ci.yml
git commit -m "ci: trivy scan agent image for CRITICAL/HIGH CVEs

Adds an image-scan job that builds the agent image and runs Trivy
against it, uploading SARIF to the GitHub Security tab. Severity
gate is initially HIGH+CRITICAL — relax to advisory-only if the
baseline noise is too high."
```

---

## Self-Review

Spec coverage check (against the seven improvements from the original analysis):

1. **Pin claude-code, gh, nodejs** — Phase 2 (postbuild templating + version constants + hash inclusion).
2. **Extract shared tools layer** — Phase 4 (fbi/tools image with COPY --from).
3. **Switch to BuildKit** — Phase 6 (docker buildx subprocess + cache mounts).
4. **HEALTHCHECK + readiness file** — Phase 5 (/fbi-state/ready + Docker HEALTHCHECK).
5. **Run shellcheck in CI** — Phase 1 (Makefile target + ci.yml step).
6. **Reconsider RW OAuth mount** — already RO in worker.gleam; only the stale comment fix in Phase 5.
7. **Audit curl-pipe-bash** — Phase 3 (multi-stage COPY --from=node:20).
8. **Trivy/grype scan** — Phase 7.

Phase ordering rationale:
- Phase 1 first so later phases get auto-linted.
- Phase 2 before 3/4 because both depend on the version constants.
- Phase 3 before 4 because the multi-stage Node pattern is a stepping stone to the shared tools image.
- Phase 4 before 6 because buildx cache mounts are most valuable on the tools image.
- Phase 5 is independent and can ship at any time.
- Phase 7 is last because it depends on the image actually being clean — running it earlier would just establish noisy baseline failures.

Type/symbol consistency: `compute_hash`, `compute_hash_with_versions`, `tools_hash`, `tools_hash_with`, `ensure_tools`, `buildx_build`, `buildx_available` — all referenced consistently across phases. `fbi_cmd:run_streaming/4` used identically in both the Erlang definition and Gleam external.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-29-agent-container-hardening.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
