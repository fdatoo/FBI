# Gleam Server — Plan 3: WebSockets & Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three WebSocket endpoints (shell, states, usage) on top of the orchestration layer from Plan 2, update the devcontainer for Gleam, rewrite install/update scripts, and cut over by replacing `src/server/` with the Gleam project.

**Architecture:** WebSocket connections are Mist-managed processes; each holds a `Subject(TerminalEvent)` it receives from the per-run TerminalBroadcaster. Inbound JSON frames are typed `ClientMsg`; outbound are typed `ServerMsg`. After cutover, the Elixir tree at `src/server/` is removed in a single commit and the Gleam tree replaces it.

**Tech Stack:** Plan 1+2 stack + Mist's WebSocket API

**Prerequisite:** Plans 1 and 2 complete. Run create/stop work end-to-end against Docker.

---

## File Map (additions)

```
src/server-gleam/src/fbi/
  handlers/
    shell_ws.gleam              ← /api/runs/:id/shell — terminal I/O
    states_ws.gleam             ← /api/ws/states — global run state stream
    usage_ws.gleam              ← /api/ws/usage — global usage stream
  pubsub.gleam                  ← in-process pub/sub for global topics
test/fbi/handlers/
  shell_ws_test.gleam
```

```
.devcontainer/
  Dockerfile                    ← MODIFIED: Elixir → Gleam
  devcontainer.json             ← MODIFIED: VS Code extensions, port labels

scripts/
  install.sh                    ← MODIFIED: replace mix release with gleam export
  update.sh                     ← MODIFIED: same
  dev.sh                        ← MODIFIED: vite + gleam run

systemd/
  fbi.service                   ← MODIFIED: ExecStart points at run.sh
```

---

### Task 1: In-process pub/sub for global topics

The Elixir server uses Phoenix.PubSub for `global_states` and `usage` topics. In Gleam, we use a small actor that holds subscribers and broadcasts events.

**Files:**
- Create: `src/server-gleam/src/fbi/pubsub.gleam`

- [ ] **Step 1: Implement**

```gleam
// src/fbi/pubsub.gleam
import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/erlang/process.{type Subject}
import gleam/list
import gleam/otp/actor

pub type Topic = String

pub type PubsubMsg {
  Subscribe(topic: Topic, client: Subject(Dynamic))
  Unsubscribe(topic: Topic, client: Subject(Dynamic))
  Publish(topic: Topic, message: Dynamic)
}

type State {
  State(subs: Dict(Topic, List(Subject(Dynamic))))
}

pub fn start() -> Result(Subject(PubsubMsg), actor.StartError) {
  actor.start(State(subs: dict.new()), handle)
}

fn handle(msg: PubsubMsg, state: State) -> actor.Next(PubsubMsg, State) {
  case msg {
    Subscribe(topic, client) -> {
      let current = dict.get(state.subs, topic) |> result_or([])
      let updated = dict.insert(state.subs, topic, [client, ..current])
      actor.continue(State(subs: updated))
    }
    Unsubscribe(topic, client) -> {
      let current = dict.get(state.subs, topic) |> result_or([])
      let filtered = list.filter(current, fn(s) { s != client })
      actor.continue(State(subs: dict.insert(state.subs, topic, filtered)))
    }
    Publish(topic, message) -> {
      let subs = dict.get(state.subs, topic) |> result_or([])
      list.each(subs, fn(s) { process.send(s, message) })
      actor.continue(state)
    }
  }
}

fn result_or(r: Result(a, b), default: a) -> a {
  case r { Ok(v) -> v Error(_) -> default }
}
```

- [ ] **Step 2: Add to `Context` and start in `fbi.gleam`**

```gleam
// In src/fbi/context.gleam
pub type Context {
  Context(
    db: sqlight.Connection,
    config: Config,
    run_registry: Subject(RegistryMsg),
    pubsub: Subject(PubsubMsg),
  )
}
```

```gleam
// In src/fbi.gleam main()
let assert Ok(pubsub) = pubsub.start()
let ctx = Context(db: db, config: cfg, run_registry: registry, pubsub: pubsub)
```

- [ ] **Step 3: Commit**

```bash
git add src/server-gleam/src/fbi/pubsub.gleam src/server-gleam/src/fbi/context.gleam src/server-gleam/src/fbi.gleam
git commit -m "feat(gleam): in-process pub/sub for global states + usage topics"
```

---

### Task 2: Shell WebSocket handler

This is the most complex of the three because it bridges per-run terminal I/O.

**Files:**
- Create: `src/server-gleam/src/fbi/handlers/shell_ws.gleam`

**Protocol (from Plan 1 design Section 5 + research findings):**

| Direction | Frame | Payload |
|---|---|---|
| Client → Server | text JSON | `{"type":"hello","cols":N,"rows":M}` |
| Client → Server | text JSON | `{"type":"resize","cols":N,"rows":M}` |
| Client → Server | text JSON | `{"type":"focus"}` / `{"type":"blur"}` |
| Client → Server | binary | raw stdin bytes |
| Server → Client | text JSON | `{"type":"snapshot","ansi":"...","cols":N,"rows":M}` |
| Server → Client | text JSON | `{"type":"state","state":"running",...}` |
| Server → Client | binary | raw PTY output bytes |

- [ ] **Step 1: Implement**

```gleam
// src/fbi/handlers/shell_ws.gleam
import fbi/context.{type Context}
import fbi/run/registry
import fbi/run/types.{Resize, Subscribe, TerminalChunk, Unsubscribe, WriteStdin}
import gleam/bit_array
import gleam/dynamic
import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}
import mist
import wisp.{type Request, type Response}

type ConnState {
  ConnState(
    run_id: Int,
    run_actor: Subject(types.RunMsg),
    terminal_subject: Subject(types.TerminalEvent),
  )
}

type ClientMsg {
  Hello(cols: Int, rows: Int)
  ClientResize(cols: Int, rows: Int)
  Focus
  Blur
}

pub fn upgrade(req: Request, ctx: Context, run_id_str: String) -> Response {
  case int.parse(run_id_str) {
    Error(_) -> wisp.bad_request()
    Ok(run_id) ->
      case registry.lookup(ctx.run_registry, run_id) {
        None -> wisp.not_found()
        Some(actor) ->
          mist.websocket(
            request: wisp.get_inner_request(req),
            on_init: fn(_conn) { on_open(actor, run_id) },
            on_message: handle_frame,
            on_close: on_close,
          )
      }
  }
}

fn on_open(actor: Subject(types.RunMsg), run_id: Int) -> ConnState {
  let term_subject = process.new_subject()
  process.send(actor, Subscribe(term_subject))
  ConnState(run_id: run_id, run_actor: actor, terminal_subject: term_subject)
}

fn handle_frame(
  state: ConnState,
  conn: mist.WebsocketConnection,
  msg: mist.WebsocketMessage(types.TerminalEvent),
) -> mist.Next(ConnState, types.TerminalEvent) {
  case msg {
    mist.Text(json_str) -> {
      case parse_client_msg(json_str) {
        Ok(Hello(cols, rows)) | Ok(ClientResize(cols, rows)) -> {
          process.send(state.run_actor, Resize(cols, rows))
          mist.continue(state)
        }
        Ok(Focus) | Ok(Blur) -> mist.continue(state)
        Error(_) -> mist.continue(state)
      }
    }
    mist.Binary(bytes) -> {
      process.send(state.run_actor, WriteStdin(bytes))
      mist.continue(state)
    }
    // TerminalEvent forwarded from broadcaster
    mist.Custom(types.TerminalChunk(data)) -> {
      let _ = mist.send_binary_frame(conn, data)
      mist.continue(state)
    }
    mist.Custom(types.StateChanged(s)) -> {
      let body = json.object([
        #("type", json.string("state")),
        #("state", json.string(s)),
      ]) |> json.to_string()
      let _ = mist.send_text_frame(conn, body)
      mist.continue(state)
    }
    mist.Custom(types.Snapshot(ansi, cols, rows)) -> {
      let body = json.object([
        #("type", json.string("snapshot")),
        #("ansi", json.string(ansi)),
        #("cols", json.int(cols)),
        #("rows", json.int(rows)),
      ]) |> json.to_string()
      let _ = mist.send_text_frame(conn, body)
      mist.continue(state)
    }
    mist.Closed | mist.Shutdown -> {
      process.send(state.run_actor, Unsubscribe(state.terminal_subject))
      mist.stop()
    }
    _ -> mist.continue(state)
  }
}

fn on_close(state: ConnState) -> Nil {
  process.send(state.run_actor, Unsubscribe(state.terminal_subject))
  Nil
}

fn parse_client_msg(s: String) -> Result(ClientMsg, Nil) {
  let decoder = {
    use msg_type <- decode.field("type", decode.string)
    case msg_type {
      "hello" -> {
        use cols <- decode.field("cols", decode.int)
        use rows <- decode.field("rows", decode.int)
        decode.success(Hello(cols, rows))
      }
      "resize" -> {
        use cols <- decode.field("cols", decode.int)
        use rows <- decode.field("rows", decode.int)
        decode.success(ClientResize(cols, rows))
      }
      "focus" -> decode.success(Focus)
      "blur" -> decode.success(Blur)
      _ -> decode.failure(Hello(0, 0), "unknown type")
    }
  }
  case json.parse(s, decoder) {
    Ok(msg) -> Ok(msg)
    Error(_) -> Error(Nil)
  }
}
```

- [ ] **Step 2: Add route**

In `src/fbi/router.gleam`:
```gleam
["api", "runs", id, "shell"] -> shell_ws.upgrade(req, ctx, id)
```

- [ ] **Step 3: Commit**

```bash
git add src/server-gleam/src/fbi/handlers/shell_ws.gleam src/server-gleam/src/fbi/router.gleam
git commit -m "feat(gleam): shell WebSocket handler — JSON control + binary terminal I/O"
```

---

### Task 3: States + Usage WebSocket handlers

Both subscribe to a global pubsub topic and forward messages.

**Files:**
- Create: `src/server-gleam/src/fbi/handlers/states_ws.gleam`
- Create: `src/server-gleam/src/fbi/handlers/usage_ws.gleam`

- [ ] **Step 1: Implement states**

```gleam
// src/fbi/handlers/states_ws.gleam
import fbi/context.{type Context}
import fbi/pubsub.{Subscribe as PubsubSubscribe, Unsubscribe as PubsubUnsubscribe}
import gleam/dynamic.{type Dynamic}
import gleam/erlang/process.{type Subject}
import gleam/json
import mist
import wisp.{type Request, type Response}

type ConnState {
  ConnState(client: Subject(Dynamic))
}

pub fn upgrade(req: Request, ctx: Context) -> Response {
  mist.websocket(
    request: wisp.get_inner_request(req),
    on_init: fn(_conn) {
      let client = process.new_subject()
      process.send(ctx.pubsub, PubsubSubscribe("global_states", client))
      ConnState(client: client)
    },
    on_message: fn(state, conn, msg) {
      case msg {
        mist.Custom(payload) -> {
          // payload should already be a JSON-serialised string
          let body = dynamic.unsafe_coerce(payload)
          let _ = mist.send_text_frame(conn, body)
          mist.continue(state)
        }
        mist.Closed | mist.Shutdown -> {
          process.send(ctx.pubsub, PubsubUnsubscribe("global_states", state.client))
          mist.stop()
        }
        _ -> mist.continue(state)
      }
    },
    on_close: fn(state) {
      process.send(ctx.pubsub, PubsubUnsubscribe("global_states", state.client))
      Nil
    },
  )
}
```

- [ ] **Step 2: Implement usage** (identical structure, topic = `"usage"`)

```gleam
// src/fbi/handlers/usage_ws.gleam
// Same as states_ws.gleam but with topic "usage"
```

- [ ] **Step 3: Add routes**

```gleam
// In router.gleam:
["api", "ws", "states"] -> states_ws.upgrade(req, ctx)
["api", "ws", "usage"] -> usage_ws.upgrade(req, ctx)
```

- [ ] **Step 4: Wire RunActor to publish state changes**

In `src/fbi/run/actor.gleam` `transition_to_running`, etc. — add a call to `pubsub.publish` (need to thread pubsub through `State`).

- [ ] **Step 5: Commit**

```bash
git add src/server-gleam/src/fbi/handlers/states_ws.gleam src/server-gleam/src/fbi/handlers/usage_ws.gleam src/server-gleam/src/fbi/router.gleam src/server-gleam/src/fbi/run/actor.gleam
git commit -m "feat(gleam): states + usage WebSocket handlers; wire pubsub publish on state changes"
```

---

### Task 4: Devcontainer Dockerfile rewrite

**Files:**
- Modify: `.devcontainer/Dockerfile`

- [ ] **Step 1: Replace Elixir-related blocks** (per spec Section 8)

```dockerfile
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      build-essential autoconf m4 libncurses-dev libssl-dev libssh-dev \
      sqlite3 \
      inotify-tools \
 && rm -rf /var/lib/apt/lists/*

ARG ASDF_VERSION=v0.14.1
ARG ERLANG_VERSION=27.2
ARG GLEAM_VERSION=1.9.1
ARG ZIG_VERSION=0.15.2

ENV ASDF_DIR=/opt/asdf
ENV ASDF_DATA_DIR=/opt/asdf
ENV PATH="/opt/asdf/shims:/opt/asdf/bin:${PATH}"
ENV KERL_BUILD_DOCS=no
ENV KERL_INSTALL_MANPAGES=no
ENV KERL_INSTALL_HTMLDOCS=no
ENV KERL_CONFIGURE_OPTIONS="--disable-debug --without-javac --without-wx --without-observer --without-debugger --without-et --without-jinterface"

RUN git clone --depth 1 --branch ${ASDF_VERSION} https://github.com/asdf-vm/asdf.git $ASDF_DIR \
 && $ASDF_DIR/bin/asdf plugin add erlang \
 && $ASDF_DIR/bin/asdf plugin add gleam \
 && $ASDF_DIR/bin/asdf plugin add zig

RUN $ASDF_DIR/bin/asdf install erlang ${ERLANG_VERSION} \
 && $ASDF_DIR/bin/asdf global  erlang ${ERLANG_VERSION} \
 && rm -rf $ASDF_DIR/plugins/erlang/kerl-home/builds /root/.cache

RUN $ASDF_DIR/bin/asdf install gleam ${GLEAM_VERSION} \
 && $ASDF_DIR/bin/asdf global  gleam ${GLEAM_VERSION}

RUN $ASDF_DIR/bin/asdf install zig ${ZIG_VERSION} \
 && $ASDF_DIR/bin/asdf global  zig ${ZIG_VERSION}

RUN chmod -R a+rX /opt/asdf \
 && rm -rf /tmp/* /var/tmp/* /root/.cache

ENV ASDF_ERLANG_VERSION=${ERLANG_VERSION}
ENV ASDF_GLEAM_VERSION=${GLEAM_VERSION}
ENV ASDF_ZIG_VERSION=${ZIG_VERSION}

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
```

Diff vs. existing: removed `elixir` plugin/install, removed `MIX_HOME` and Mix archive setup, removed `/tmp/mix_pubsub` block, replaced ASDF env var.

- [ ] **Step 2: Modify `.devcontainer/devcontainer.json`**

```json
{
  "name": "FBI",
  "build": { "dockerfile": "Dockerfile" },
  "features": {
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {},
    "ghcr.io/devcontainers/features/rust:1": {}
  },
  "forwardPorts": [3000, 5173],
  "portsAttributes": {
    "3000": { "label": "FBI Server (Gleam)" },
    "5173": { "label": "FBI Web (Vite)" }
  },
  "postCreateCommand": "npm install && cd src/server && gleam deps download && cd ../.. && git config core.hooksPath .githooks",
  "remoteEnv": {
    "HOST_CLAUDE_DIR": "${localEnv:HOME}/.claude",
    "PUPPETEER_EXECUTABLE_PATH": "/usr/bin/chromium",
    "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD": "true",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium"
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode",
        "ms-vscode.vscode-typescript-next",
        "gleam.gleam",
        "rust-lang.rust-analyzer",
        "ziglang.vscode-zig"
      ],
      "settings": {
        "typescript.tsdk": "node_modules/typescript/lib"
      }
    }
  }
}
```

Note: `postCreateCommand` references `src/server` — that's the post-cutover path. Until Task 7 runs, use `src/server-gleam`.

- [ ] **Step 3: Build the devcontainer** (in CI or locally)

```bash
docker build -t fbi-devcontainer .devcontainer/
```

Expected: build succeeds; final image contains `gleam`, `erl`, `zig` on PATH.

- [ ] **Step 4: Commit**

```bash
git add .devcontainer/
git commit -m "feat(gleam): devcontainer — replace Elixir/Mix with Gleam"
```

---

### Task 5: Rewrite install.sh

**Files:**
- Modify: `scripts/install.sh`

- [ ] **Step 1: Replace the Elixir release block**

```bash
#!/usr/bin/env bash
set -euo pipefail

for cmd in rsync node npm gleam zig erl make; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found in PATH"; exit 1; }
done
id fbi >/dev/null 2>&1 || { echo "ERROR: user 'fbi' does not exist"; exit 1; }

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Runtime directories ──────────────────────────────────────────────────────
install -d -m 750 -o fbi -g fbi \
  /var/lib/agent-manager \
  /var/lib/agent-manager/runs \
  /etc/agent-manager

if [ ! -f /etc/agent-manager/secrets.key ]; then
  head -c 32 /dev/urandom > /etc/agent-manager/secrets.key
  chown fbi:fbi /etc/agent-manager/secrets.key
  chmod 600 /etc/agent-manager/secrets.key
fi

# ── Web bundle ───────────────────────────────────────────────────────────────
RELEASE_DIR=/opt/fbi
install -d -m 750 -o fbi -g fbi "$RELEASE_DIR" "$RELEASE_DIR/web"

REV="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"

echo "==> Building web bundle"
npm --prefix "$SOURCE_DIR" ci
VITE_VERSION="$REV" npm --prefix "$SOURCE_DIR" run build:web
rsync -a --delete "$SOURCE_DIR/dist/web/" "$RELEASE_DIR/web/"

# ── Gleam release ────────────────────────────────────────────────────────────
systemctl stop fbi.service 2>/dev/null || true

(
  cd "$SOURCE_DIR/src/server"
  gleam deps download
  make build
  gleam export erlang-shipment
)

# Ship the erlang-shipment to /opt/fbi
rsync -a --delete "$SOURCE_DIR/src/server/build/erlang-shipment/" "$RELEASE_DIR/"
chown -R fbi:fbi "$RELEASE_DIR"

# ── Environment file ─────────────────────────────────────────────────────────
if [ ! -f /etc/default/fbi ]; then
  cat > /etc/default/fbi <<'ENV'
PORT=3000
DATABASE_PATH=/var/lib/agent-manager/db.sqlite
RUNS_DIR=/var/lib/agent-manager/runs
WEB_DIST_DIR=/opt/fbi/web
SECRETS_KEY_FILE=/etc/agent-manager/secrets.key
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
# Optional:
# HOST_SSH_AUTH_SOCK=/run/user/1000/ssh-agent.sock
# HOST_CLAUDE_DIR=/home/fbi/.claude
# DOCKER_SOCKET=/var/run/docker.sock
# HOST_DOCKER_GID=995
FBI_DEFAULT_PLUGINS=superpowers@claude-plugins-official
ENV
  chmod 640 /etc/default/fbi
  chown root:fbi /etc/default/fbi
fi

# ── Systemd ──────────────────────────────────────────────────────────────────
install -m 644 "$SOURCE_DIR/systemd/fbi.service" /etc/systemd/system/fbi.service
systemctl daemon-reload
systemctl enable --now fbi.service
systemctl restart fbi.service

echo "FBI installed and running."
echo "  Edit /etc/default/fbi with real GIT_AUTHOR_NAME/EMAIL"
echo "  systemctl status fbi"
```

Diff vs. existing: drops `mix`, `elixir`, `MIX_ENV=prod mix release`, `SECRET_KEY_BASE`, `phx_new` references; adds `gleam`, `make build`, `gleam export erlang-shipment`.

- [ ] **Step 2: Modify `systemd/fbi.service`**

Change `ExecStart` from the Mix release binary to:

```ini
ExecStart=/opt/fbi/erts-*/bin/run.sh start
```

Or rely on `run.sh` from `gleam export erlang-shipment` output:

```ini
ExecStart=/opt/fbi/run.sh start
```

- [ ] **Step 3: Modify `scripts/update.sh`** with the same approach

```bash
#!/usr/bin/env bash
set -euo pipefail

for cmd in git node npm gleam make; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found"; exit 1; }
done

RELEASE_DIR="${RELEASE_DIR:-/opt/fbi}"
SERVICE="${SERVICE:-fbi}"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

git -C "$SOURCE_DIR" pull
REV="$(git -C "$SOURCE_DIR" rev-parse --short HEAD)"

# Web bundle
npm --prefix "$SOURCE_DIR" ci
VITE_VERSION="$REV" npm --prefix "$SOURCE_DIR" run build:web
sudo rsync -a --delete "$SOURCE_DIR/dist/web/" "$RELEASE_DIR/web/"
sudo chown -R fbi:fbi "$RELEASE_DIR/web"

sudo systemctl stop "$SERVICE" 2>/dev/null || true

# Gleam release
sudo bash -c "cd '$SOURCE_DIR/src/server' && \
    gleam deps download && \
    make build && \
    gleam export erlang-shipment"

sudo rsync -a --delete "$SOURCE_DIR/src/server/build/erlang-shipment/" "$RELEASE_DIR/"
sudo chown -R fbi:fbi "$RELEASE_DIR"

sudo systemctl start "$SERVICE"
sleep 2
sudo journalctl -u "$SERVICE" -n 10 --no-pager --no-hostname

echo "FBI updated to $REV."
```

- [ ] **Step 4: Modify `scripts/dev.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
for cmd in node npm gleam make; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found"; exit 1; }
done

# Vite in background
npm run dev:web &
VITE_PID=$!
trap "kill $VITE_PID 2>/dev/null || true" EXIT

cd src/server
make nif
exec gleam run
```

- [ ] **Step 5: Commit**

```bash
git add scripts/ systemd/
git commit -m "feat(gleam): rewrite install/update/dev scripts for Gleam release pipeline"
```

---

### Task 6: Cutover — replace `src/server/` with the Gleam project

**Files:**
- Delete: `src/server/` (Elixir tree)
- Move: `src/server-gleam/` → `src/server/`

This is irreversible without git revert. Coordinate timing with operator.

- [ ] **Step 1: Verify the Gleam server passes all tests**

```bash
cd src/server-gleam
gleam test
make build
```

Expected: clean build, tests pass.

- [ ] **Step 2: Verify no residual references to the Elixir server**

```bash
grep -r "src/server/lib\|fbi_web\|FBI\." --include="*.{ts,tsx,sh,yml,json,md}" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=server-gleam .
```

Expected: only doc/spec mentions, no live config.

- [ ] **Step 3: Remove the Elixir tree**

```bash
git rm -r src/server
```

- [ ] **Step 4: Move Gleam project into place**

```bash
git mv src/server-gleam src/server
```

- [ ] **Step 5: Update any remaining file paths**

- `Makefile`'s `make_cwd` reference (now matches because `src/server/` and `cli/fbi-term-core/` are siblings under `src/`)
- `scripts/install.sh`, `scripts/update.sh`, `scripts/dev.sh` paths to `src/server`
- `.github/workflows/ci.yml` paths to `src/server`
- `README.md` path references

- [ ] **Step 6: Verify CI passes**

```bash
# Locally first
cd src/server && gleam test && cd ../..
npm test
npm run e2e
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: cut over from Elixir server to Gleam server

Replace src/server/ (Elixir/Phoenix) with the Gleam implementation.
The new tree at src/server/ is a pure Gleam project (gleam.toml + Makefile)
producing a self-contained erlang-shipment release."
```

---

### Task 7: Smoke test the full deployment

- [ ] **Step 1: Run the install script in a clean VM** (or staging)

```bash
sudo bash scripts/install.sh
```

Expected: service starts, `/api/health` returns 200.

- [ ] **Step 2: Create a project and a run via the API**

```bash
curl -X POST http://localhost:3000/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"smoke-test","repo_url":"https://github.com/some/repo"}'

curl -X POST http://localhost:3000/api/projects/1/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"echo hello"}'
```

Expected: 201 with run JSON, container starts, run state transitions to `running` then to `succeeded`/`failed`.

- [ ] **Step 3: Connect to the WebSocket** (browser-based React app)

Load the SPA at `http://localhost:3000/` and open the run in the UI. The shell tab should show terminal output via WebSocket.

- [ ] **Step 4: Tag the cutover commit**

```bash
git tag v2.0.0-gleam-cutover
git push --tags
```

---

## Self-Review

**Spec coverage:**
- ✅ Section 5 — three WebSocket handlers (Tasks 2-3)
- ✅ Section 8 — devcontainer changes (Task 4), build & deploy scripts (Task 5)
- ✅ Cutover (Task 6)

**Placeholder scan:**
- Task 4 Step 2's `postCreateCommand` references `src/server` (post-cutover path). Until Task 6 runs, the path is `src/server-gleam`. Implementer should land the devcontainer change after cutover, or use a temporary `src/server-gleam` reference and fix it in Task 6.
- Task 5's systemd `ExecStart` may need adjustment for the actual `gleam export erlang-shipment` directory layout — verify by running the export locally and inspecting the output structure.

**Type consistency:** `Context` extended with `pubsub` field in Task 1; all WebSocket handlers receive Context and use `ctx.pubsub` and `ctx.run_registry`. RunActor needs `pubsub` threaded into its `State` (mentioned in Task 3 Step 4).

---

## After all three plans

The Gleam server is the only server. The desktop app, web frontend, and CI all build against `src/server/` with no Elixir-related steps.

**Deferred from Plan 2** (separate plan after cutover stabilises):
- Stdout reader process feeding broadcaster
- Stdin attach socket
- Image builder (devcontainer.json → Docker image)
- Resume / continue / reattach lifecycle modes
- Watchers (UsageTailer, TitleWatcher, etc.)
- Multi-viewer focus tracking
