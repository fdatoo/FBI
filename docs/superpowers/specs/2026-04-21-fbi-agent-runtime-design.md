# FBI — Agent Runtime (v1) Design

**Date:** 2026-04-21
**Project:** FBI
**Status:** Approved for implementation planning

## 1. Overview

FBI is a personal web tool that lets a single user kick off Claude Code agents
inside ephemeral, dependency-isolated containers, watch them work in real time
through an in-browser interactive terminal, and review what they did after the
fact. The agent runs with `claude --dangerously-skip-permissions`, so isolation
and credential scoping are first-class concerns.

This spec covers **v1 only**, which is the *containerized agent runtime* slice
of a larger eventual vision. The bigger picture (multi-agent dashboards,
templates, schedulers, etc.) will land in subsequent specs once this slice is
working.

### Goals

- Spin up a fresh container per agent run with the project's required
  dependencies installed.
- Run a Claude Code agent inside that container with skip-permissions enabled,
  fed a user-supplied prompt plus a project-level instruction prefix.
- Provide the agent with read access to a Claude OAuth credential and read/write
  access to the user's SSH agent so it can clone, work in, and push to private
  repositories.
- Stream the agent's terminal interactively in the browser (full bidirectional
  xterm.js terminal), and persist the full transcript so completed runs remain
  inspectable after the container is destroyed.
- Auto-push whatever the agent committed to a per-run branch so work is never
  lost.
- Survive page refreshes, network drops, and orchestrator restarts without
  losing in-flight work.

### Non-goals (v1)

- Multi-user / RBAC. Tailscale (or any chosen network boundary) is the trust
  boundary; the app itself ships no login.
- Multi-host or clustered runtimes. Single Docker daemon on the same machine.
- Auto-PR creation. v1 pushes a branch; opening PRs is a future iteration.
- Cost / token usage tracking.
- Run retry, resumption, or chaining.
- Built-in code diff viewer. The pushed branch on GitHub is the diff viewer.
- Mobile UI.
- Webhooks, scheduled triggers, or any external entry points. Manual UI starts
  only.
- Cross-project agent templates beyond each project's own `instructions` field.
- Pre-run "exec into the project's container without running Claude" mode.

## 2. Architecture

One Node service runs on a single remote server as a systemd unit. It exposes:

- a Fastify HTTP API,
- a WebSocket endpoint for interactive run terminals,
- the React SPA (built and served as static assets).

The same process owns the Docker orchestrator (via `dockerode`) and the SQLite
data layer (via `better-sqlite3`). No separate worker, no message broker, no
external database. Restarting the systemd unit restarts everything.

Each agent run executes in its own ephemeral Docker container, started by the
orchestrator and torn down when the run completes. The container's lifetime is
independent of any WebSocket connection — viewers can come and go without
affecting the run.

The browser reaches the server over a network boundary the operator controls
(Tailscale is the recommended default). Inside that boundary, the UI itself
requires no login.

```
┌──────────────┐       ┌────────────────────────────────────────────────┐
│  Browser     │       │  Remote server                                 │
│  React SPA   │  WS   │                                                │
│  + xterm.js  │◄─────►│  ┌──────────────────────┐                      │
│              │  HTTP │  │ fbi (systemd)        │                      │
└──────┬───────┘◄─────►│  │ Fastify + WS + SPA   │                      │
       │               │  │ Run orchestrator     │                      │
       │               │  └──────┬───────────────┘                      │
       │               │         │                                      │
       │ Tailscale     │  ┌──────▼─────┐  ┌───────────────────────┐     │
       │               │  │ SQLite     │  │ Run log files         │     │
       │               │  │ db.sqlite  │  │ runs/<id>.log         │     │
       │               │  └────────────┘  └───────────────────────┘     │
       │               │         │                                      │
       │               │         ▼                                      │
       │               │  ┌────────────────────────────────────┐        │
       │               │  │ Docker engine                      │        │
       │               │  │ ┌────────────────────────────────┐ │        │
       │               │  │ │ Ephemeral run container        │ │        │
       │               │  │ │  supervisor.sh wraps Claude    │ │        │
       │               │  │ │  + bind: SSH agent socket (RW) │ │        │
       │               │  │ │  + bind: ~/.claude/      (RO)  │ │        │
       │               │  │ │  + workspace volume (temp)     │ │        │
       │               │  │ └────────────────────────────────┘ │        │
       │               │  └────────────────────────────────────┘        │
       │               └────────────────────────────────────────────────┘
```

## 3. Data model

SQLite, accessed via `better-sqlite3`. Three tables, plus runtime configuration
in environment variables (not the database).

```sql
projects
  id                         INTEGER PRIMARY KEY
  name                       TEXT NOT NULL UNIQUE
  repo_url                   TEXT NOT NULL                -- e.g., git@github.com:you/repo.git
  default_branch             TEXT NOT NULL DEFAULT 'main'
  devcontainer_override_json TEXT                         -- nullable; UI fallback config
  instructions               TEXT                         -- project-level system prompt
  git_author_name            TEXT                         -- nullable; overrides global default
  git_author_email           TEXT                         -- nullable; overrides global default
  created_at                 INTEGER NOT NULL
  updated_at                 INTEGER NOT NULL

project_secrets
  id          INTEGER PRIMARY KEY
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  name        TEXT NOT NULL                                -- env var name
  value_enc   BLOB NOT NULL                                -- AES-256-GCM ciphertext + nonce + tag
  created_at  INTEGER NOT NULL
  UNIQUE(project_id, name)

runs
  id            INTEGER PRIMARY KEY
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  prompt        TEXT NOT NULL
  branch_name   TEXT NOT NULL                              -- claude/run-<id>
  state         TEXT NOT NULL                              -- queued|running|succeeded|failed|cancelled
  container_id  TEXT                                       -- Docker id while running; null after teardown
  log_path      TEXT NOT NULL                              -- absolute path to host log file
  exit_code     INTEGER
  error         TEXT                                       -- short message if setup/push failed
  head_commit   TEXT                                       -- SHA of pushed branch HEAD
  started_at    INTEGER
  finished_at   INTEGER
  created_at    INTEGER NOT NULL
```

Notes:

- **Project-scoped secrets only.** No global secret store in v1.
- **Log content is plain files**, not blobs in SQLite — cheaper to stream and
  tail. The `log_path` column points to `<RUNS_DIR>/<run_id>.log`.
- **Concurrency:** multiple runs may execute in parallel (Docker isolates them).
  No queue cap in v1.

### Runtime configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WS listen port |
| `DB_PATH` | `/var/lib/agent-manager/db.sqlite` | SQLite file |
| `RUNS_DIR` | `/var/lib/agent-manager/runs` | Per-run log files |
| `HOST_SSH_AUTH_SOCK` | `$SSH_AUTH_SOCK` | Path to host ssh-agent socket to bind into containers |
| `HOST_CLAUDE_DIR` | `$HOME/.claude` | Path to host Claude OAuth dir to bind into containers (RO) |
| `SECRETS_KEY_FILE` | `/etc/agent-manager/secrets.key` | 32-byte AES key (mode 0600) |
| `GIT_AUTHOR_NAME` | *(required)* | Default git author name; per-project may override |
| `GIT_AUTHOR_EMAIL` | *(required)* | Default git author email; per-project may override |

## 4. Container lifecycle & runtime contract

### 4.1 Submitting a run

`POST /api/runs` with `{project_id, prompt}`:

1. Insert a `runs` row with `state='queued'`, `branch_name='claude/run-<id>'`,
   `log_path='<RUNS_DIR>/<id>.log'`.
2. Return `{run_id}` immediately. The UI navigates to `/runs/:id` and opens a
   WebSocket to the run's shell endpoint.
3. The orchestrator picks up the queued run asynchronously (in-process, no
   external queue).

### 4.2 Image resolution

For each run, compute a **config hash** from:

- the repo's `.devcontainer/devcontainer.json` (if any),
- the project's `devcontainer_override_json`,
- a fixed list of always-installed packages (git, openssh-client, gh, the Claude
  CLI itself, ca-certificates).

If image `fbi/p<project_id>:<hash>` exists locally, reuse it. Otherwise build:

- **Devcontainer path:** if the repo has `.devcontainer/devcontainer.json`,
  shell out to `@devcontainers/cli build`.
- **Override path:** render a Dockerfile from a small template using the
  project's `devcontainer_override_json`, then build via Docker API.

In both cases an FBI post-build layer is applied on top of the result. The
post-build layer:

- installs always-needed packages (git, openssh-client, gh, ca-certificates,
  the Claude CLI),
- creates a non-root `agent` user with `HOME=/home/agent`,
- drops in `/home/agent/.ssh/known_hosts` populated with GitHub's published
  SSH host keys plus any additional hosts the operator configured.

Build logs stream into the same per-run log file so the user can see them
through the terminal viewer.

### 4.3 Starting the container

`dockerode` create+start, with:

- **Image:** the resolved one.
- **TTY:** `Tty: true, OpenStdin: true, StdinOnce: false` so the in-browser
  terminal works correctly (line editing, control sequences, OAuth login flows).
- **User:** `User: 'agent'` so `$HOME` resolves to `/home/agent`, where the
  Claude OAuth credential dir is bind-mounted.
- **Bind mounts:**
  - `$HOST_SSH_AUTH_SOCK → /ssh-agent` (RW)
  - `$HOST_CLAUDE_DIR → /home/agent/.claude` (RO)
  - the supervisor script → `/usr/local/bin/supervisor.sh` (RO)
  - tmpfs at `/run/fbi` for prompt + instructions files written by the
    orchestrator before start
- **Workspace:** anonymous volume mounted at `/workspace` (destroyed with
  container).
- **Env:** `RUN_ID`, `REPO_URL`, `DEFAULT_BRANCH`, `BRANCH_NAME`,
  `SSH_AUTH_SOCK=/ssh-agent`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, plus all
  decrypted `project_secrets`.
- **Entrypoint:** `supervisor.sh`.

The orchestrator opens a single `container.attach({stream, stdin, stdout,
stderr, hijack: true})` stream. Output bytes are tee'd to:

- the per-run log file (always), and
- a fan-out broadcaster that any connected WebSocket clients subscribe to.

DB update: `state='running'`, `container_id`, `started_at`.

### 4.4 Inside the container — `supervisor.sh`

A short script (~40 lines of bash) owned by FBI, mounted in by the orchestrator:

```bash
#!/usr/bin/env bash
set -uo pipefail

cd /workspace
git clone "$REPO_URL" .
git checkout -b "$BRANCH_NAME" "origin/$DEFAULT_BRANCH"
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Compose the final prompt: project instructions + run prompt
cat /run/fbi/instructions.txt /run/fbi/prompt.txt > /tmp/prompt.txt

claude --dangerously-skip-permissions -p "$(cat /tmp/prompt.txt)"
CLAUDE_EXIT=$?

# Capture anything Claude didn't commit, then push.
git add -A && git commit -m "wip: claude run $RUN_ID" || true
git push -u origin "$BRANCH_NAME"
PUSH_EXIT=$?

# Write structured result for the orchestrator to copy out.
HEAD_SHA="$(git rev-parse HEAD)"
printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" > /tmp/result.json

exit $CLAUDE_EXIT
```

The exact Claude CLI invocation flags will be confirmed during implementation;
the contract is "feed prompt, capture exit code, no interactive UI required by
default" — but interactive flow (e.g., OAuth `/login`) is permitted because the
container has a real TTY connected to the user's browser.

### 4.5 Awaiting completion

`container.wait()` resolves when the container exits. Then:

1. `container.getArchive('/tmp/result.json')` to extract the structured result.
2. Parse it to fill `exit_code`, `head_commit`. Set `state='succeeded'` if
   `exit_code == 0` (and push succeeded), else `'failed'` with `error` populated.
3. Set `finished_at`, clear `container_id`.
4. Send a final WS frame to subscribers indicating end-of-stream, then close
   the broadcaster.
5. `container.remove({force: true})` to delete the container and its anonymous
   workspace volume.

### 4.6 Cancellation

`DELETE /api/runs/:id` while running:

- `container.stop({t: 10})` — SIGTERM with a 10-second grace period, then
  SIGKILL.
- Set `state='cancelled'`. Do not attempt to copy out `/tmp/result.json` (the
  supervisor likely never wrote it).
- Close the WS broadcaster.

The user can also send Ctrl-C through the in-browser terminal directly — that
goes to Claude's process, not the supervisor, so behavior depends on what Claude
does. The DELETE endpoint is the authoritative cancel.

### 4.7 Orchestrator restart recovery

On startup, query for runs with `state='running'`:

1. For each, check whether `container_id` is still alive via Docker.
2. If alive, reattach. Two streams are involved:
   - `container.logs({follow: true, stdout: true, stderr: true, since:
     <last_byte_timestamp>})` to backfill any output produced while the
     orchestrator was down (Docker's own json-file log driver buffers it for
     us), then continue following live. Output is appended to the run's log
     file and re-broadcast.
   - `container.attach({stream: true, stdin: true, stdout: false, stderr:
     false, hijack: true})` to restore the stdin path so user keystrokes still
     reach the container.
   The run continues seamlessly; browser tabs reconnect their WS on their own.
3. If the container is gone (Docker host restarted, container manually removed,
   etc.), mark the run `state='failed'` with `error='orchestrator lost
   container'`.

This means deploys / crashes do not kill in-flight runs as long as the Docker
daemon stayed up.

## 5. Auth & secrets

### 5.1 Git auth (per-run)

The host runs an SSH agent (via `keychain`, `systemd --user`, or equivalent)
with the user's git identity loaded. The agent's socket path is read from
`$HOST_SSH_AUTH_SOCK` and bind-mounted into every container at `/ssh-agent`,
with `SSH_AUTH_SOCK=/ssh-agent` in the container env. Git inside the container
uses the host's keys to sign without ever seeing them.

Threat model accepted: during a run, Claude can `git push` to any repo the
host's loaded keys grant access to. This is acceptable for a single-user tool
where the operator can audit run logs after the fact. A scoped per-task
deploy-key flow is a documented future upgrade.

The auth-injection layer lives behind a small interface so alternative
providers (per-task deploy keys, fine-grained PATs) can slot in later.

### 5.2 Claude OAuth

The operator runs `claude /login` once on the host as the FBI service user;
this populates `~/.claude/`. That directory is bind-mounted **read-only** at
`/home/agent/.claude` inside every run container.

If creds are missing or expired in the bind-mounted dir, Claude's interactive
`/login` flow will trigger inside the container — the user completes OAuth in
their browser via the URL Claude prints, and the run continues. The TTY-backed
in-browser terminal makes this work without special plumbing.

There is no `ANTHROPIC_API_KEY` fallback. OAuth (subscription billing) is the
only auth path; an API key would bill differently and is out of scope.

### 5.3 Project secrets

Per-project secrets are arbitrary `name=value` pairs (env-var style) that get
injected into the run container's environment. Storage:

- Encrypted with AES-256-GCM using a 32-byte key loaded once at startup from
  `$SECRETS_KEY_FILE` (mode 0600, owned by the FBI service user).
- Each row stores `nonce || ciphertext || tag` as a single BLOB.
- API never returns plaintext values — only names are listed. To "see" a
  secret, the user re-enters it.

Decryption happens in-memory only at container-start time.

### 5.4 Network boundary

The recommended deployment puts the server inside a Tailscale tailnet and
binds the HTTP/WS listener to either the Tailscale interface or `0.0.0.0`
within that trust boundary. The application ships no login UI in v1.

## 6. API surface

All endpoints under `/api`. JSON in/out unless noted. WebSocket endpoints use
the same origin.

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get one project |
| PATCH | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project (cascades runs + secrets) |
| GET | `/api/projects/:id/secrets` | List secret **names only** |
| PUT | `/api/projects/:id/secrets/:name` | Upsert secret value |
| DELETE | `/api/projects/:id/secrets/:name` | Remove secret |
| GET | `/api/projects/:id/runs` | List runs for project (paginated) |
| POST | `/api/projects/:id/runs` | Create + start a run; returns `{run_id}` |
| GET | `/api/runs` | List all runs (paginated, filter by `state`) |
| GET | `/api/runs/:id` | Run metadata |
| DELETE | `/api/runs/:id` | If running, cancel; else delete row + log file |
| GET | `/api/runs/:id/transcript` | Full raw transcript as `text/plain` |
| WS | `/api/runs/:id/shell` | Interactive terminal (see below) |

### WebSocket protocol — `/api/runs/:id/shell`

On connect:

1. Server looks up the run.
2. If the run is `succeeded`, `failed`, or `cancelled`: server streams the
   recorded transcript file and closes. Client renders into a non-interactive
   xterm.
3. If the run is `running`: server replays the existing log file from byte 0,
   then attaches the WS to the live broadcaster. Bidirectional from this point.
4. If the run is `queued`: server holds the connection; once the run starts,
   behavior matches case 3.

Frame format: simple binary frames carrying raw terminal bytes in both
directions, plus a small JSON control channel for resize events:

```json
{"type":"resize","cols":120,"rows":40}
```

Multiple WS clients per run are supported. All clients receive the same output
broadcast; any client may write to a multiplexed stdin (last-writer-wins on
simultaneous keystrokes — normal shared-terminal behavior).

## 7. UI structure

React + Vite SPA, built and served by the same Fastify process. React Router
for routing. State management is local component state plus a small
`fetch`-based API wrapper and an `EventSource`/`WebSocket` wrapper. Tailwind
for styling.

Pages:

| Route | Purpose |
|---|---|
| `/` | Projects list. Cards with name, repo, last run state/time, "New Run" |
| `/projects/new` | Create project form |
| `/projects/:id` | Project detail: config + secrets + run history + "New Run" |
| `/projects/:id/edit` | Edit project (devcontainer override, instructions, git author) |
| `/projects/:id/runs/new` | Start a run: prompt textarea + Start button |
| `/runs` | Global runs list (filterable) |
| `/runs/:id` | Run detail: state badge, prompt, terminal viewer, branch link, Cancel |

The terminal on `/runs/:id` uses `xterm.js` with `xterm-addon-fit` and
`xterm-addon-web-links`. Resize events from the browser propagate through the
WS to `container.resize()`. For completed runs, the same component replays the
recorded transcript with no input enabled.

Explicitly NOT in v1: editing a run after submission, live-editing a running
container's environment, in-app diff viewer, usage stats, keyboard shortcuts
beyond browser defaults.

## 8. Project layout

```
fbi/
  package.json
  tsconfig.json
  src/
    server/
      index.ts                # boot, Fastify init, route registration
      config.ts               # env var parsing
      crypto.ts               # AES-256-GCM helpers for secrets
      db/
        schema.sql
        index.ts              # better-sqlite3 init + migrations
        projects.ts
        runs.ts
        secrets.ts
      orchestrator/
        index.ts              # create/start/await/cancel runs; restart recovery
        image.ts              # devcontainer or template build, cached by config hash
        supervisor.sh         # mounted into every container
        Dockerfile.tmpl       # fallback when no devcontainer.json
        gitAuth.ts            # interface + ssh-agent-forwarding implementation
      logs/
        store.ts              # write-to-file, append on reattach, tail-from-file
        broadcaster.ts        # in-process fan-out for WS subscribers
        ws.ts                 # WebSocket handler
      api/
        projects.ts
        runs.ts
        secrets.ts
    web/
      index.html
      main.tsx
      App.tsx
      router.tsx
      pages/
        Projects.tsx
        ProjectDetail.tsx
        NewProject.tsx
        EditProject.tsx
        NewRun.tsx
        Runs.tsx
        RunDetail.tsx
      components/
        Terminal.tsx
        StateBadge.tsx
        SecretsEditor.tsx
        # …
      lib/
        api.ts
        ws.ts
    shared/
      types.ts                # types shared between server and web
  scripts/
    install.sh                # bootstrap on a fresh server
  systemd/
    fbi.service
  README.md
```

The split between `server/`, `web/`, and `shared/` is enforced by `tsconfig`
project references so neither side accidentally imports from the other beyond
`shared/`.

## 9. Operator setup & deployment

One-time setup on the remote server:

1. Docker engine installed and running.
2. Tailscale (or chosen network boundary) configured; server reachable from the
   operator's devices on a private interface.
3. Node 20+.
4. A unix user (e.g., `fbi`) in the `docker` group.
5. SSH keys loaded into the `fbi` user's ssh-agent, persisted across reboots
   (recipe in README — recommended: `keychain` invoked from the systemd unit's
   `ExecStartPre`, or a dedicated `systemd --user` ssh-agent unit).
6. `claude /login` performed once as the `fbi` user on the server (creates
   `~/.claude/`).
7. `/etc/agent-manager/secrets.key` — 32 random bytes, mode 0600, owned by
   `fbi`. Backed up to operator's password manager.
8. `/var/lib/agent-manager/{,runs}/` — owned by `fbi`.

Install:

```bash
git clone … && cd fbi
npm ci && npm run build               # builds server + web into dist/
sudo cp systemd/fbi.service /etc/systemd/system/
sudo systemctl enable --now fbi.service
```

The systemd unit:

- runs `node dist/server/index.js` as the `fbi` user,
- sources environment from `/etc/default/fbi`,
- restarts on failure,
- logs to journald.

## 10. Known unknowns / risks

These are explicitly called out so they get verified during implementation
rather than assumed.

1. **Devcontainer features compatibility.** `@devcontainers/cli build` is
   expected to handle features (postgres, node, etc.). Needs a smoke test
   against a representative repo with at least one feature. Risk: low —
   features are widely used; mitigation if broken is to render a Dockerfile
   from the override config instead.
2. **Image cache invalidation correctness.** The config hash drives reuse vs
   rebuild. Initial design hashes config + the repo's `devcontainer.json`
   content. Needs verification it's not too aggressive (rebuilding constantly
   on no-op changes) or too loose (reusing stale images after dependency
   updates). Plan: log the hash on every build/reuse so issues are visible
   from the run log.
3. **Claude CLI flags.** Exact non-interactive invocation flags depend on the
   Claude CLI's current surface. The supervisor's invocation will be confirmed
   during implementation; the contract is "feed prompt, capture exit code,
   interactive prompts allowed because TTY is real".
4. **Branch already exists.** If the repo already has a branch named
   `claude/run-<id>` (extremely unlikely given monotonic IDs but possible if
   the DB is restored from a backup), the supervisor's `git push -u` will fail.
   Mitigation: the branch name format includes the autoincrementing run id;
   collisions imply a serious operational error worth surfacing as `failed`
   with a clear `error` message rather than silently working around.
5. **SSH host key verification on first clone.** The container is fresh every
   time, so `git clone` would prompt for host key verification. The FBI
   post-build image layer drops in `/home/agent/.ssh/known_hosts` populated
   with GitHub's published host keys (and any additional hosts the operator
   configures via the override config). No `StrictHostKeyChecking=no`.

## 11. Future work (out of scope for v1)

Listed so the v1 design leaves room for them, not because they're being built.

- Auto-PR creation (`gh pr create` after the push, configurable per project).
- Per-task ephemeral deploy keys instead of SSH agent forwarding.
- Pluggable runtime backends (multi-host, k8s, remote Docker).
- Pluggable image build backends.
- Pre-run "exec into the project's container without running Claude" mode.
- Resource limits per container (cpu, mem, pids).
- Image GC (LRU on cached images).
- Run retry / resume.
- PR / commit / branch linkage in the UI (rendered status of the pushed
  branch).
- Cost / token tracking.
- Multi-user with per-user identity and run isolation.
