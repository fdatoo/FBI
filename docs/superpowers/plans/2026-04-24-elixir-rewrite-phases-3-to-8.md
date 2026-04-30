# Elixir Rewrite Phases 3–6 + 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port everything non-orchestrator (Phases 3, 4, 5, 6, 8 from `docs/superpowers/specs/2026-04-24-server-rewrite-migration-design.md`) to the Elixir server in a single PR, with byte-compatible JSON responses. Shrinks the TS proxy surface to just orchestrator-dependent routes. Phase 7 (orchestrator + run creation + shell WS + states WS) and Phase 9 (deploy cutover) remain for a later session.

**Architecture:** Native Phoenix controllers register before the `FBIWeb.Router` catch-all. New Ecto schemas (`FBI.Projects.Project`, `FBI.Projects.Secret`, `FBI.Mcp.Server`, `FBI.Runs.Run`) mirror TS's SQLite tables via dev/test-only Ecto migrations. `FBI.Crypto` decrypts/encrypts secrets using AES-256-GCM with a byte layout matching TS (`nonce(12) || ct || tag(16)`); compat verified via a TS→Elixir round-trip fixture committed to the repo. GitHub status is fetched via `System.cmd("gh", ...)` and cached in a `FBI.Github.StatusCache` Agent with a 10-second TTL. File uploads write to the shared runs directory on disk using `Plug.Upload` with the same sanitization rules as TS. A new `FBI.Housekeeping.DraftUploadsGc` GenServer replaces the TS draft-uploads cleanup `setInterval`.

**Tech Stack:**
- Elixir 1.18 / OTP 27 / Phoenix 1.8 / Ecto 3.13 / `ecto_sqlite3` (all established in Phase 1)
- `Plug.Upload` for multipart (already in Phoenix endpoint via `Plug.Parsers`)
- `System.cmd/3` for `gh` + `git` shell-outs
- `Jason` for JSON en/decode (for storage columns + responses)
- `:crypto.crypto_one_time_aead/7` for AES-GCM (built into OTP)

**Spec reference:** `docs/superpowers/specs/2026-04-24-server-rewrite-migration-design.md`, Phase table rows 3, 4, 5, 6, 8.

**Reference code already shipped (for patterns):**
- Phase 1: `server-elixir/lib/fbi/usage/*.ex`, `test/fbi/usage/*.exs`, proxy at `lib/fbi_web/proxy/`.
- Phase 2: `server-elixir/lib/fbi/settings/*.ex`, `lib/fbi/config/*.ex`, `lib/fbi_web/controllers/{settings,config,cli}_controller.ex`.

---

## Scope carve-outs (routes that STAY proxied)

These routes depend on the orchestrator or WebSocket infrastructure from Phase 7 and are intentionally **NOT** ported in this plan. The catch-all in `FBIWeb.Router` continues to forward them to TS.

- `POST /api/projects/:id/runs` — run creation (orchestrator launch)
- `POST /api/runs/:id/resume-now`, `POST /api/runs/:id/continue` — orchestrator state transitions
- `POST /api/settings/run-gc` — depends on image builder / GC service
- `GET /api/runs/:id/listening-ports`, `GET /api/runs/:id/proxy/:port` — orchestrator runtime state
- `GET /api/runs/:id/shell` (WS) — PTY stream via `RunStreamRegistry`
- `GET /api/ws/states` — orchestrator state broadcast

Two routes ARE ported, but with a **reduced live-container path** since live container interactions go through the Phase-7 orchestrator:

- `GET /api/runs/:id/files` — ported. `live: false` always; never calls `orchestrator.getLastFiles/1`. Relies on `gh api ... compare` for file change list. During the crossover window, live runs won't show in-progress file edits via this route (they'll only show once committed), but finished runs work correctly.
- `GET /api/runs/:id/file-diff` — **stays proxied**. It requires `execInContainer` which is Phase 7.

Similarly:

- `DELETE /api/runs/:id` for active runs — on active runs (`running`, `awaiting_resume`, `starting`), Elixir calls `docker kill <container_id>` directly via the Docker socket, updates the row, and deletes the log. The UI's state WS (served by TS) picks up the transition naturally via DB polling. The brief latency is acceptable.
- `POST /api/runs/:id/github/merge` conflict path — when `gh` reports a conflict, Elixir returns `409 { merged: false, reason: 'conflict' }` **without** the stdin-injection that TS performs. TS's orchestrator-side stdin hook returns at Phase 7. The UI falls back to a manual-resolution flow during the crossover.

---

## File structure

### Created (Elixir side)

Domain modules (`lib/fbi/...`):

| Path | Responsibility |
|---|---|
| `lib/fbi/crypto.ex` | AES-256-GCM encrypt/decrypt; byte layout `nonce(12)||ct||tag(16)`; key loading |
| `lib/fbi/projects/project.ex` | Ecto schema: `projects` table |
| `lib/fbi/projects/queries.ex` | `list/0`, `get/1`, `create/1`, `update/2`, `delete/1`, `list_recent_prompts/2` (recent prompts join) |
| `lib/fbi/projects/secret.ex` | Ecto schema: `project_secrets` table (`value_enc BLOB`) |
| `lib/fbi/projects/secret_queries.ex` | `list/1`, `upsert/3` (encrypts), `delete/2` |
| `lib/fbi/mcp/server.ex` | Ecto schema: `mcp_servers` (shared global + project-scoped) |
| `lib/fbi/mcp/queries.ex` | `list_global/0`, `list_for_project/1`, `get_global/1`, `get_project/2`, `create/1`, `update/2`, `delete/1` |
| `lib/fbi/runs/run.ex` | Ecto schema: `runs` — 30 columns, mirrors TS exactly |
| `lib/fbi/runs/queries.ex` | `list/1` (with filters/paging), `get/1`, `siblings/1`, `list_for_project/1`, `update_title/2`, `delete/1` |
| `lib/fbi/runs/log_store.ex` | Read the run transcript file with size clamp |
| `lib/fbi/runs/run_kill.ex` | Active-run cancel (docker kill via Docker socket + DB update + log cleanup) |
| `lib/fbi/github/client.ex` | Shell out to `gh` for PR list / PR checks / compare / create PR / merge |
| `lib/fbi/github/status_cache.ex` | Agent: `{run_id → {value, expires_at}}` with 10s TTL |
| `lib/fbi/uploads/fs.ex` | `sanitize_filename/1`, `resolve_filename/2`, `directory_bytes/1`, `draft_token/0` |
| `lib/fbi/uploads/paths.ex` | `draft_dir/1`, `run_uploads_dir/1`, both rooted in configured dirs |
| `lib/fbi/housekeeping/draft_uploads_gc.ex` | GenServer sweeping aged draft dirs hourly |
| `lib/fbi/docker.ex` | Minimal Docker HTTP client over the unix socket (`/var/run/docker.sock`) — just `kill/1` |

Web controllers (`lib/fbi_web/controllers/...`):

| Path | Routes |
|---|---|
| `projects_controller.ex` | GET/POST `/api/projects`, GET/PATCH/DELETE `/api/projects/:id`, GET `/api/projects/:id/prompts/recent` |
| `secrets_controller.ex` | GET/PUT/DELETE `/api/projects/:id/secrets[/:name]` |
| `mcp_servers_controller.ex` | GET/POST `/api/mcp-servers`, PATCH/DELETE `/api/mcp-servers/:id`, GET/POST `/api/projects/:id/mcp-servers`, PATCH/DELETE `/api/projects/:id/mcp-servers/:sid` |
| `runs_controller.ex` | GET `/api/runs`, GET `/api/runs/:id`, PATCH `/api/runs/:id`, DELETE `/api/runs/:id`, GET `/api/runs/:id/siblings`, GET `/api/projects/:id/runs` |
| `transcript_controller.ex` | GET `/api/runs/:id/transcript` |
| `github_controller.ex` | GET `/api/runs/:id/github`, POST `/api/runs/:id/github/pr`, POST `/api/runs/:id/github/merge` |
| `files_controller.ex` | GET `/api/runs/:id/files` |
| `uploads_controller.ex` | GET `/api/runs/:id/uploads`, POST `/api/runs/:id/uploads`, DELETE `/api/runs/:id/uploads/:filename` |
| `draft_uploads_controller.ex` | POST `/api/draft-uploads`, DELETE `/api/draft-uploads/:token/:filename` |
| `health_controller.ex` | GET `/api/health` |

Migrations (`priv/repo/migrations/...`):

| Path | Mirrors |
|---|---|
| `20260424000003_create_projects_table.exs` | `src/server/db/schema.sql:1-17` + index.ts ALTERs for marketplaces/plugins/mem_mb/cpus/pids_limit |
| `20260424000004_create_project_secrets_table.exs` | `src/server/db/schema.sql:19-26` |
| `20260424000005_create_mcp_servers_table.exs` | `src/server/db/schema.sql:67-81` + global-name unique index |
| `20260424000006_create_runs_table.exs` | `src/server/db/schema.sql:28-46` + all index.ts ALTERs (13+ columns) |

Tests:

- `test/fbi/<domain>/*_test.exs` — query-module unit tests
- `test/fbi_web/controllers/*_test.exs` — controller tests using `FBIWeb.ConnCase`
- `test/fbi/crypto_test.exs` — AES-GCM round-trip, cross-language fixture
- `test/fixtures/crypto_ts_encrypted.hex` — known-plaintext ciphertext generated by TS
- `test/fixtures/crypto_key_32.hex` — 32-byte key used for the fixture
- `test/fidelity/projects_fidelity_test.exs`, `mcp_servers_fidelity_test.exs`, `runs_fidelity_test.exs`
- `test/fidelity/fixtures/*.json` — golden shape fixtures

### Modified (Elixir side)

| Path | Change |
|---|---|
| `config/config.exs` | Add `config :fbi, :runs_dir`, `:draft_uploads_dir`, `:secrets_key_path`, `:docker_socket_path` |
| `config/runtime.exs` | In `:prod` block, source above keys from env vars: `RUNS_DIR`, `DRAFT_UPLOADS_DIR`, `SECRETS_KEY_FILE`, `DOCKER_SOCKET` |
| `lib/fbi/application.ex` | Add `FBI.Github.StatusCache`, `FBI.Housekeeping.DraftUploadsGc` to supervision tree |
| `lib/fbi_web/router.ex` | Add new native routes for every controller above, before the catch-all |
| `lib/fbi_web/endpoint.ex` | Raise multipart upload limit to 100 MB (`:length` in `Plug.Parsers`) |
| `mix.exs` | No new deps required — `:crypto`, `Plug.Upload`, `System.cmd` all built in |

### Not modified (intentional)

- TS side: no changes. Both implementations coexist; rollback is one router line.
- Production SQLite schema: TS still owns it. Elixir migrations are dev/test only.

---

## Context notes for the implementer

**Pattern to copy when in doubt:** Phase 2's `server-elixir/lib/fbi_web/controllers/settings_controller.ex` and `lib/fbi/settings/queries.ex` show the accepted shape for:
- `@moduledoc` tone (teaching-grade)
- atomize-via-allow-list for PATCH params
- int↔bool storage translation
- `{:error, Ecto.Changeset.t()}` return from update functions

**Test pattern:** Phase 2's `test/fbi_web/controllers/settings_controller_test.exs` uses `use FBIWeb.ConnCase, async: false` with direct `get/patch/delete` helpers and `json_response/2`. For routes that mutate shared state, always `async: false`.

**Mix command prefix:** If `mix` is not on PATH in a session, prefix with `ASDF_DATA_DIR=/opt/asdf TMPDIR=/tmp/agent-tmp`. Try bare `mix` first.

**Byte-compat bar:** JSON keys, types, status codes, and header names match TS exactly. When in doubt, read the TS source in `src/server/api/*.ts` — the recon at the top of this plan cites specific `file:line` references for every route.

**Elixir boolean-vs-integer:** Storage is always integer (TS convention); API layer exposes booleans. `FBI.Settings.Queries` has the canonical `decode/1` pattern.

**JSON list columns:** TS uses `*_json` TEXT columns storing `JSON.stringify([...])`. Ecto schema declares `:string`; the queries module decodes with `Jason.decode!/1`.

---

## Task 1: Ecto migration — `projects` table

**Files:**
- Create: `server-elixir/priv/repo/migrations/20260424000003_create_projects_table.exs`

- [ ] **Step 1: Create the migration**

```elixir
defmodule FBI.Repo.Migrations.CreateProjectsTable do
  @moduledoc """
  Dev/test migration mirroring TS's `projects` table after all ALTERs in
  `src/server/db/index.ts`. TS is the authoritative schema-owner in prod
  until Phase 9 (cutover).
  """

  use Ecto.Migration

  def change do
    create table(:projects, primary_key: false) do
      add :id, :integer, primary_key: true
      add :name, :text, null: false
      add :repo_url, :text, null: false
      add :default_branch, :text, null: false, default: "main"
      add :devcontainer_override_json, :text
      add :instructions, :text
      add :git_author_name, :text
      add :git_author_email, :text
      add :marketplaces_json, :text, null: false, default: "[]"
      add :plugins_json, :text, null: false, default: "[]"
      add :mem_mb, :integer
      add :cpus, :float
      add :pids_limit, :integer
      add :created_at, :integer, null: false
      add :updated_at, :integer, null: false
    end

    create unique_index(:projects, [:name])
  end
end
```

- [ ] **Step 2: Migrate, verify, commit**

```bash
cd /workspace/server-elixir && mix ecto.migrate
git add server-elixir/priv/repo/migrations/20260424000003_create_projects_table.exs
git commit -m "feat(server-elixir): add projects table migration"
```

---

## Task 2: Ecto migration — `project_secrets` table

**Files:**
- Create: `server-elixir/priv/repo/migrations/20260424000004_create_project_secrets_table.exs`

- [ ] **Step 1: Create the migration**

```elixir
defmodule FBI.Repo.Migrations.CreateProjectSecretsTable do
  @moduledoc """
  Dev/test migration mirroring TS's `project_secrets`. `value_enc` is a BLOB
  containing `nonce(12) || ciphertext || tag(16)` produced by AES-256-GCM
  — see `FBI.Crypto` and the cross-language round-trip fixture.
  """

  use Ecto.Migration

  def change do
    create table(:project_secrets, primary_key: false) do
      add :id, :integer, primary_key: true
      add :project_id, references(:projects, on_delete: :delete_all, type: :integer), null: false
      add :name, :text, null: false
      add :value_enc, :binary, null: false
      add :created_at, :integer, null: false
    end

    create unique_index(:project_secrets, [:project_id, :name])
  end
end
```

- [ ] **Step 2: Migrate, commit**

```bash
cd /workspace/server-elixir && mix ecto.migrate
git add server-elixir/priv/repo/migrations/20260424000004_create_project_secrets_table.exs
git commit -m "feat(server-elixir): add project_secrets table migration"
```

---

## Task 3: Ecto migration — `mcp_servers` table

**Files:**
- Create: `server-elixir/priv/repo/migrations/20260424000005_create_mcp_servers_table.exs`

- [ ] **Step 1: Create the migration**

```elixir
defmodule FBI.Repo.Migrations.CreateMcpServersTable do
  @moduledoc """
  Dev/test migration mirroring TS's `mcp_servers`. Global rows have
  `project_id IS NULL`; project-scoped rows have a non-null project_id.
  The partial unique index enforces global-name uniqueness separately
  from per-project uniqueness.
  """

  use Ecto.Migration

  def change do
    create table(:mcp_servers, primary_key: false) do
      add :id, :integer, primary_key: true
      add :project_id, references(:projects, on_delete: :delete_all, type: :integer)
      add :name, :text, null: false
      add :type, :text, null: false
      add :command, :text
      add :args_json, :text, null: false, default: "[]"
      add :url, :text
      add :env_json, :text, null: false, default: "{}"
      add :created_at, :integer, null: false
    end

    create constraint(:mcp_servers, "type_in_stdio_sse", check: "type IN ('stdio','sse')")
    create unique_index(:mcp_servers, [:project_id, :name])

    execute(
      "CREATE UNIQUE INDEX idx_mcp_servers_global_name ON mcp_servers(name) WHERE project_id IS NULL",
      "DROP INDEX IF EXISTS idx_mcp_servers_global_name"
    )
  end
end
```

- [ ] **Step 2: Migrate, commit**

```bash
cd /workspace/server-elixir && mix ecto.migrate
git add server-elixir/priv/repo/migrations/20260424000005_create_mcp_servers_table.exs
git commit -m "feat(server-elixir): add mcp_servers table migration"
```

---

## Task 4: Ecto migration — `runs` table

**Files:**
- Create: `server-elixir/priv/repo/migrations/20260424000006_create_runs_table.exs`

Every column listed in the recon's §10. Column order matches TS's schema.sql + index.ts ALTER order.

- [ ] **Step 1: Create the migration**

```elixir
defmodule FBI.Repo.Migrations.CreateRunsTable do
  @moduledoc """
  Dev/test migration mirroring TS's `runs` table after all ALTER TABLEs in
  `src/server/db/index.ts`. Column order and nullability match TS so golden
  fidelity tests stay byte-compatible with TS responses.
  """

  use Ecto.Migration

  def change do
    create table(:runs, primary_key: false) do
      add :id, :integer, primary_key: true
      add :project_id, references(:projects, on_delete: :delete_all, type: :integer), null: false
      add :prompt, :text, null: false
      add :branch_name, :text, null: false
      add :state, :text, null: false
      add :container_id, :text
      add :log_path, :text, null: false
      add :exit_code, :integer
      add :error, :text
      add :head_commit, :text
      add :started_at, :integer
      add :finished_at, :integer
      add :created_at, :integer, null: false
      add :state_entered_at, :integer, null: false, default: 0
      add :model, :text
      add :effort, :text
      add :subagent_model, :text
      add :resume_attempts, :integer, null: false, default: 0
      add :next_resume_at, :integer
      add :claude_session_id, :text
      add :last_limit_reset_at, :integer
      add :tokens_input, :integer, null: false, default: 0
      add :tokens_output, :integer, null: false, default: 0
      add :tokens_cache_read, :integer, null: false, default: 0
      add :tokens_cache_create, :integer, null: false, default: 0
      add :tokens_total, :integer, null: false, default: 0
      add :usage_parse_errors, :integer, null: false, default: 0
      add :title, :text
      add :title_locked, :integer, null: false, default: 0
      add :parent_run_id, references(:runs, on_delete: :nilify_all, type: :integer)
    end

    create index(:runs, [:project_id], name: :idx_runs_project)
    create index(:runs, [:state], name: :idx_runs_state)
    create index(:runs, [:parent_run_id], name: :idx_runs_parent)
  end
end
```

- [ ] **Step 2: Migrate, commit**

```bash
cd /workspace/server-elixir && mix ecto.migrate
git add server-elixir/priv/repo/migrations/20260424000006_create_runs_table.exs
git commit -m "feat(server-elixir): add runs table migration"
```

---

## Task 5: `FBI.Projects.Project` Ecto schema

**Files:**
- Create: `server-elixir/lib/fbi/projects/project.ex`

Follows the exact pattern of `FBI.Settings.Setting` (Phase 2). Mirrors the migration columns verbatim.

- [ ] **Step 1: Create the schema**

```elixir
defmodule FBI.Projects.Project do
  @moduledoc """
  Ecto schema for the `projects` table.

  One row per source-tree project registered with the server. The
  `*_json` TEXT columns store `Jason.encode!/1`-produced JSON strings; the
  `FBI.Projects.Queries` decode/1 function translates them to Elixir lists
  for the JSON response.

  Plain `Ecto.Schema` — no GenServer; all state lives in the DB.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :integer, autogenerate: false}

  schema "projects" do
    field :name, :string
    field :repo_url, :string
    field :default_branch, :string, default: "main"
    field :devcontainer_override_json, :string
    field :instructions, :string
    field :git_author_name, :string
    field :git_author_email, :string
    field :marketplaces_json, :string, default: "[]"
    field :plugins_json, :string, default: "[]"
    field :mem_mb, :integer
    field :cpus, :float
    field :pids_limit, :integer
    field :created_at, :integer
    field :updated_at, :integer
  end

  @type t :: %__MODULE__{}

  @cast_fields ~w(
    name repo_url default_branch devcontainer_override_json instructions
    git_author_name git_author_email marketplaces_json plugins_json
    mem_mb cpus pids_limit created_at updated_at
  )a

  @doc "Changeset for insert or update of a project row."
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(project, attrs) do
    project
    |> cast(attrs, [:id | @cast_fields])
    |> validate_required([:name, :repo_url, :default_branch, :created_at, :updated_at])
    |> unique_constraint(:name)
  end
end
```

- [ ] **Step 2: Compile-clean, commit**

```bash
cd /workspace/server-elixir && mix compile --warnings-as-errors
git add server-elixir/lib/fbi/projects/project.ex
git commit -m "feat(server-elixir): add FBI.Projects.Project Ecto schema"
```

---

## Task 6: `FBI.Projects.Queries` module

**Files:**
- Create: `server-elixir/lib/fbi/projects/queries.ex`
- Create: `server-elixir/test/fbi/projects/queries_test.exs`

- [ ] **Step 1: Write the failing test file**

```elixir
defmodule FBI.Projects.QueriesTest do
  use FBI.DataCase, async: false

  alias FBI.Projects.Queries

  defp make(attrs \\ %{}) do
    defaults = %{
      name: "proj-#{System.unique_integer([:positive])}",
      repo_url: "git@github.com:owner/repo.git"
    }

    Queries.create(Map.merge(defaults, attrs))
  end

  describe "create/1 + list/0" do
    test "creates a project and lists include it" do
      {:ok, p} = make()
      list = Queries.list()
      assert Enum.any?(list, fn x -> x.id == p.id and x.name == p.name end)
    end

    test "create defaults marketplaces/plugins to empty lists" do
      {:ok, p} = make()
      assert p.marketplaces == []
      assert p.plugins == []
    end

    test "create accepts marketplaces/plugins lists and roundtrips them" do
      {:ok, p} = make(%{marketplaces: ["m1"], plugins: ["p1", "p2"]})
      assert p.marketplaces == ["m1"]
      assert p.plugins == ["p1", "p2"]
    end

    test "list orders by updated_at DESC" do
      {:ok, a} = make()
      :timer.sleep(2)
      {:ok, b} = make()
      ids = Enum.map(Queries.list(), & &1.id)
      assert Enum.find_index(ids, &(&1 == b.id)) <
               Enum.find_index(ids, &(&1 == a.id))
    end
  end

  describe "get/1" do
    test "returns project by id" do
      {:ok, p} = make()
      assert {:ok, g} = Queries.get(p.id)
      assert g.id == p.id
    end

    test "returns :not_found when absent" do
      assert Queries.get(9_999_999) == :not_found
    end
  end

  describe "update/2" do
    test "merges patch and bumps updated_at" do
      {:ok, p} = make()
      :timer.sleep(2)
      {:ok, u} = Queries.update(p.id, %{instructions: "hi"})
      assert u.instructions == "hi"
      assert u.updated_at > p.updated_at
    end

    test "returns :not_found for absent project" do
      assert Queries.update(9_999_999, %{name: "x"}) == :not_found
    end
  end

  describe "delete/1" do
    test "deletes the project" do
      {:ok, p} = make()
      assert :ok = Queries.delete(p.id)
      assert Queries.get(p.id) == :not_found
    end

    test "is idempotent for missing projects" do
      assert :ok = Queries.delete(9_999_999)
    end
  end

  describe "list_recent_prompts/2" do
    test "returns distinct prompts ordered by recency, limit clamped to [1,50]" do
      {:ok, p} = make()
      ms = System.system_time(:millisecond)

      FBI.Repo.insert!(%FBI.Runs.Run{
        project_id: p.id,
        prompt: "a",
        branch_name: "b",
        state: "succeeded",
        log_path: "/tmp/a.log",
        created_at: ms - 2000
      })

      FBI.Repo.insert!(%FBI.Runs.Run{
        project_id: p.id,
        prompt: "b",
        branch_name: "b",
        state: "succeeded",
        log_path: "/tmp/b.log",
        created_at: ms - 1000
      })

      FBI.Repo.insert!(%FBI.Runs.Run{
        project_id: p.id,
        prompt: "a",
        branch_name: "b",
        state: "succeeded",
        log_path: "/tmp/a2.log",
        created_at: ms
      })

      [r1, r2] = Queries.list_recent_prompts(p.id, 10)
      # "a" is most recent because its latest created_at > "b"'s
      assert r1.prompt == "a"
      assert r2.prompt == "b"

      [only] = Queries.list_recent_prompts(p.id, 0)
      assert only.prompt == "a"
    end
  end
end
```

- [ ] **Step 2: Implement the queries module**

```elixir
defmodule FBI.Projects.Queries do
  @moduledoc """
  Read/write helpers for the `projects` table plus the recent-prompts join.

  Plain module (no process state). Conventions:
  - Boolean-valued DB cols don't exist on this table (all ints/strings/floats).
  - List-valued cols are stored as JSON TEXT and decoded via `Jason`.
  - `get/1` returns `{:ok, decoded} | :not_found`; `delete/1` is idempotent.
  """

  import Ecto.Query

  alias FBI.Repo
  alias FBI.Projects.Project
  alias FBI.Runs.Run

  @type decoded :: %{
          id: integer(),
          name: String.t(),
          repo_url: String.t(),
          default_branch: String.t(),
          devcontainer_override_json: String.t() | nil,
          instructions: String.t() | nil,
          git_author_name: String.t() | nil,
          git_author_email: String.t() | nil,
          marketplaces: [String.t()],
          plugins: [String.t()],
          mem_mb: integer() | nil,
          cpus: float() | nil,
          pids_limit: integer() | nil,
          created_at: integer(),
          updated_at: integer()
        }

  @spec list() :: [decoded()]
  def list do
    Project
    |> order_by(desc: :updated_at)
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec get(integer()) :: {:ok, decoded()} | :not_found
  def get(id) do
    case Repo.get(Project, id) do
      nil -> :not_found
      p -> {:ok, decode(p)}
    end
  end

  @spec create(map()) :: {:ok, decoded()} | {:error, Ecto.Changeset.t()}
  def create(attrs) do
    now = System.system_time(:millisecond)
    attrs = encode_list_cols(attrs)
    row_attrs = Map.merge(attrs, %{created_at: now, updated_at: now})

    %Project{}
    |> Project.changeset(row_attrs)
    |> Repo.insert()
    |> case do
      {:ok, p} -> {:ok, decode(p)}
      {:error, cs} -> {:error, cs}
    end
  end

  @spec update(integer(), map()) :: {:ok, decoded()} | {:error, Ecto.Changeset.t()} | :not_found
  def update(id, patch) do
    case Repo.get(Project, id) do
      nil ->
        :not_found

      p ->
        now = System.system_time(:millisecond)

        p
        |> Project.changeset(Map.merge(encode_list_cols(patch), %{updated_at: now}))
        |> Repo.update()
        |> case do
          {:ok, u} -> {:ok, decode(u)}
          {:error, cs} -> {:error, cs}
        end
    end
  end

  @spec delete(integer()) :: :ok
  def delete(id) do
    Repo.delete_all(from p in Project, where: p.id == ^id)
    :ok
  end

  @doc """
  Returns up to `limit` distinct prompts for the given project, ordered by
  most-recent `created_at` desc (ties broken by MAX(id) desc). Mirrors TS's
  `listRecentPrompts` in `src/server/db/runs.ts:99-119`.
  """
  @spec list_recent_prompts(integer(), integer()) :: [
          %{prompt: String.t(), last_used_at: integer(), run_id: integer()}
        ]
  def list_recent_prompts(project_id, limit) do
    clamped = max(1, min(50, limit))

    from(r in Run,
      where: r.project_id == ^project_id,
      group_by: r.prompt,
      select: %{
        prompt: r.prompt,
        last_used_at: max(r.created_at),
        run_id: max(r.id)
      },
      order_by: [desc: max(r.created_at), desc: max(r.id)],
      limit: ^clamped
    )
    |> Repo.all()
  end

  defp encode_list_cols(attrs) do
    attrs
    |> maybe_encode(:marketplaces, :marketplaces_json)
    |> maybe_encode(:plugins, :plugins_json)
    |> Map.drop([:marketplaces, :plugins])
  end

  defp maybe_encode(attrs, in_key, out_key) do
    case Map.fetch(attrs, in_key) do
      {:ok, list} when is_list(list) -> Map.put(attrs, out_key, Jason.encode!(list))
      _ -> attrs
    end
  end

  defp decode(%Project{} = p) do
    %{
      id: p.id,
      name: p.name,
      repo_url: p.repo_url,
      default_branch: p.default_branch,
      devcontainer_override_json: p.devcontainer_override_json,
      instructions: p.instructions,
      git_author_name: p.git_author_name,
      git_author_email: p.git_author_email,
      marketplaces: Jason.decode!(p.marketplaces_json || "[]"),
      plugins: Jason.decode!(p.plugins_json || "[]"),
      mem_mb: p.mem_mb,
      cpus: p.cpus,
      pids_limit: p.pids_limit,
      created_at: p.created_at,
      updated_at: p.updated_at
    }
  end
end
```

- [ ] **Step 3: Run tests, commit**

```bash
cd /workspace/server-elixir && mix test test/fbi/projects/queries_test.exs
git add server-elixir/lib/fbi/projects/queries.ex server-elixir/test/fbi/projects/queries_test.exs
git commit -m "feat(server-elixir): add FBI.Projects.Queries (CRUD + recent_prompts)"
```

---

## Task 7: `FBIWeb.ProjectsController` + routes + tests

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/projects_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/projects_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

TS reference: `src/server/api/projects.ts:13-76`. Contract points:
- `GET /api/projects` returns array; each project additionally carries an optional `last_run: {id, state, created_at} | null`. This means the query-layer-decoded project map must be augmented with `last_run` at the controller level via `FBI.Runs.Queries.latest_for_project/1` (which we add in Task 14).
- `GET /api/projects/:id` — returns Project WITHOUT `last_run`; matches TS.
- `POST /api/projects` — creates, returns 201 with project JSON.
- `PATCH /api/projects/:id` — returns updated project on 200, 404 when missing.
- `DELETE /api/projects/:id` — returns 204 always (even when missing; matches TS idempotency).
- `GET /api/projects/:id/prompts/recent` — accepts `?limit=` clamped to [1,50] (default 10).

- [ ] **Step 1: Write the failing controller test file**

```elixir
defmodule FBIWeb.ProjectsControllerTest do
  use FBIWeb.ConnCase, async: false

  alias FBI.Projects.Queries

  describe "POST /api/projects" do
    test "creates and returns 201 with project JSON", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> post(
          "/api/projects",
          Jason.encode!(%{
            name: "alpha",
            repo_url: "git@github.com:owner/alpha.git",
            marketplaces: ["a"],
            plugins: ["b"]
          })
        )

      assert conn.status == 201
      body = json_response(conn, 201)
      assert body["name"] == "alpha"
      assert body["repo_url"] == "git@github.com:owner/alpha.git"
      assert body["marketplaces"] == ["a"]
      assert body["plugins"] == ["b"]
      assert body["default_branch"] == "main"
      assert is_integer(body["created_at"])
      assert body["created_at"] == body["updated_at"]
    end
  end

  describe "GET /api/projects" do
    test "lists projects and includes optional last_run", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "g", repo_url: "x"})
      body = conn |> get("/api/projects") |> json_response(200)
      assert is_list(body)
      found = Enum.find(body, &(&1["id"] == p.id))
      refute found == nil
      # last_run key exists and is nil when there are no runs
      assert Map.has_key?(found, "last_run")
      assert found["last_run"] == nil
    end
  end

  describe "GET /api/projects/:id" do
    test "returns 404 for missing", %{conn: conn} do
      conn = get(conn, "/api/projects/9999999")
      assert conn.status == 404
      assert json_response(conn, 404) == %{"error" => "not found"}
    end

    test "returns project without last_run field", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "h", repo_url: "x"})
      body = conn |> get("/api/projects/#{p.id}") |> json_response(200)
      assert body["id"] == p.id
      refute Map.has_key?(body, "last_run")
    end
  end

  describe "PATCH /api/projects/:id" do
    test "updates fields and returns 200", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "i", repo_url: "x"})

      body =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/projects/#{p.id}", Jason.encode!(%{instructions: "hello"}))
        |> json_response(200)

      assert body["instructions"] == "hello"
    end

    test "404 for missing", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/projects/9999999", Jason.encode!(%{name: "x"}))

      assert conn.status == 404
    end
  end

  describe "DELETE /api/projects/:id" do
    test "returns 204 on success", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "j", repo_url: "x"})
      conn = delete(conn, "/api/projects/#{p.id}")
      assert conn.status == 204
    end

    test "returns 204 even for missing (idempotent, matches TS)", %{conn: conn} do
      conn = delete(conn, "/api/projects/9999999")
      assert conn.status == 204
    end
  end

  describe "GET /api/projects/:id/prompts/recent" do
    test "returns distinct prompts with last_used_at and run_id", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "k", repo_url: "x"})
      ms = System.system_time(:millisecond)

      FBI.Repo.insert!(%FBI.Runs.Run{
        project_id: p.id,
        prompt: "foo",
        branch_name: "b",
        state: "succeeded",
        log_path: "/tmp/a",
        created_at: ms
      })

      body = conn |> get("/api/projects/#{p.id}/prompts/recent") |> json_response(200)
      assert [%{"prompt" => "foo", "last_used_at" => _, "run_id" => _}] = body
    end

    test "clamps limit param to [1, 50]", %{conn: conn} do
      {:ok, p} = Queries.create(%{name: "l", repo_url: "x"})
      body = conn |> get("/api/projects/#{p.id}/prompts/recent?limit=0") |> json_response(200)
      assert is_list(body)
    end
  end
end
```

- [ ] **Step 2: Implement the controller**

```elixir
defmodule FBIWeb.ProjectsController do
  @moduledoc """
  CRUD for projects plus the "recent prompts" per-project query.

  Mirrors `src/server/api/projects.ts`. The list view augments each project
  with an optional `last_run` field (id + state + created_at) matching TS's
  shape; the detail view does *not* include `last_run`.
  """

  use FBIWeb, :controller

  alias FBI.Projects.Queries
  alias FBI.Runs.Queries, as: RunsQueries

  @allowed_patch_keys ~w(
    name repo_url default_branch devcontainer_override_json instructions
    git_author_name git_author_email marketplaces plugins mem_mb cpus pids_limit
  )

  def index(conn, _params) do
    list = Queries.list()
    augmented = Enum.map(list, fn p ->
      Map.put(p, :last_run, RunsQueries.latest_for_project(p.id))
    end)
    json(conn, augmented)
  end

  def create(conn, params) do
    attrs = atomize(params)

    case Queries.create(attrs) do
      {:ok, p} ->
        conn |> put_status(201) |> json(p)

      {:error, cs} ->
        conn |> put_status(400) |> json(%{error: invalid_body_reason(cs)})
    end
  end

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, p} <- Queries.get(id) do
      json(conn, p)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def update(conn, %{"id" => id_str} = params) do
    patch = atomize(Map.delete(params, "id"))

    with {:ok, id} <- parse_id(id_str),
         {:ok, p} <- Queries.update(id, patch) do
      json(conn, p)
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
      {:error, cs} -> conn |> put_status(400) |> json(%{error: invalid_body_reason(cs)})
      _ -> conn |> put_status(400) |> json(%{error: "invalid id"})
    end
  end

  def delete(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      {:ok, id} ->
        Queries.delete(id)
        send_resp(conn, 204, "")

      :error ->
        # TS returns 204 unconditionally — match that.
        send_resp(conn, 204, "")
    end
  end

  def recent_prompts(conn, %{"id" => id_str} = params) do
    limit =
      case params["limit"] do
        nil ->
          10

        s when is_binary(s) ->
          case Integer.parse(s) do
            {n, _} -> n
            :error -> 10
          end
      end

    case parse_id(id_str) do
      {:ok, id} ->
        json(conn, Queries.list_recent_prompts(id, limit))

      :error ->
        json(conn, [])
    end
  end

  defp parse_id(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  @known_string_keys Map.new(@allowed_patch_keys, fn k -> {k, String.to_atom(k)} end)

  defp atomize(params) when is_map(params) do
    Enum.reduce(@known_string_keys, %{}, fn {string_key, atom_key}, acc ->
      case Map.fetch(params, string_key) do
        {:ok, v} -> Map.put(acc, atom_key, v)
        :error -> acc
      end
    end)
  end

  defp invalid_body_reason(%Ecto.Changeset{errors: errors}) do
    case errors do
      [{field, {msg, _}} | _] -> "#{field} #{msg}"
      _ -> "invalid project"
    end
  end
end
```

- [ ] **Step 3: Register routes in router**

Edit `server-elixir/lib/fbi_web/router.ex`. Inside the first `scope "/api", FBIWeb do` block, after the existing Phase 1/2 routes and before `end`:

```elixir
    # Phase 3+4+5+6+8 routes.
    get "/projects", ProjectsController, :index
    post "/projects", ProjectsController, :create
    get "/projects/:id", ProjectsController, :show
    patch "/projects/:id", ProjectsController, :update
    delete "/projects/:id", ProjectsController, :delete
    get "/projects/:id/prompts/recent", ProjectsController, :recent_prompts
```

- [ ] **Step 4: Run tests, commit**

Tests will fail until Task 14 lands (`FBI.Runs.Queries.latest_for_project/1`). Commit anyway and circle back in Task 14.

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/projects_controller_test.exs --only no-run-queries 2>&1 | tail
git add \
  server-elixir/lib/fbi_web/controllers/projects_controller.ex \
  server-elixir/test/fbi_web/controllers/projects_controller_test.exs \
  server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port /api/projects CRUD + recent_prompts"
```

If the test file won't compile because `FBI.Runs.Queries` doesn't exist yet, add `@moduletag :skip_until_runs_queries` to the test and include it in `test/test_helper.exs` exclusions temporarily. Remove the tag in Task 14.

---

## Task 8: AES-GCM round-trip fixture + `FBI.Crypto`

**Files:**
- Create: `server-elixir/test/fixtures/crypto_key_32.hex`
- Create: `server-elixir/test/fixtures/crypto_ts_encrypted.hex`
- Create: `server-elixir/test/fixtures/crypto_plaintext.txt`
- Create: `server-elixir/lib/fbi/crypto.ex`
- Create: `server-elixir/test/fbi/crypto_test.exs`

### Generating the fixture from TS

Fixture generation is a one-time operation; you run a Node.js script that produces hex-encoded ciphertext using the exact `encrypt/2` from `src/server/crypto.ts`. Commit the output as test fixtures.

- [ ] **Step 1: Generate the fixture**

```bash
cd /workspace

# Generate a known 32-byte key (use the same bytes every time for reproducibility).
echo -n "0123456789abcdef0123456789abcdef" > /tmp/fbi-crypto-key.bin

# Plaintext we will encrypt in TS and decrypt in Elixir.
echo -n "hello from TS" > /tmp/fbi-crypto-plaintext.txt

# Use tsx to run a one-liner against the TS crypto module.
cat > /tmp/fbi-encrypt.mjs <<'EOF'
import fs from 'node:fs';
import { encrypt } from '/workspace/src/server/crypto.ts';
const key = fs.readFileSync('/tmp/fbi-crypto-key.bin');
const plain = fs.readFileSync('/tmp/fbi-crypto-plaintext.txt', 'utf8');
const blob = encrypt(key, plain);
fs.writeFileSync('/tmp/fbi-crypto-ct.hex', Buffer.from(blob).toString('hex'));
console.log('ok');
EOF

cd /workspace && npx tsx /tmp/fbi-encrypt.mjs

# Move into place.
mkdir -p server-elixir/test/fixtures
xxd -p /tmp/fbi-crypto-key.bin | tr -d '\n' > server-elixir/test/fixtures/crypto_key_32.hex
cp /tmp/fbi-crypto-ct.hex server-elixir/test/fixtures/crypto_ts_encrypted.hex
cp /tmp/fbi-crypto-plaintext.txt server-elixir/test/fixtures/crypto_plaintext.txt
```

If `npx tsx` isn't available in the environment, fall back to this self-contained script that reproduces the TS `encrypt` logic exactly (byte layout: `nonce(12) || cipher.update(plain) + cipher.final() || tag(16)`):

```bash
node -e '
const crypto = require("crypto");
const fs = require("fs");
const key = fs.readFileSync("/tmp/fbi-crypto-key.bin");
const plaintext = fs.readFileSync("/tmp/fbi-crypto-plaintext.txt", "utf8");
const nonce = Buffer.from("000102030405060708090a0b", "hex"); // deterministic for reproducibility
const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();
fs.writeFileSync("/tmp/fbi-crypto-ct.hex", Buffer.concat([nonce, ct, tag]).toString("hex"));
console.log("ok");
'
```

Note: using a deterministic nonce is fine for a fixture; production encryption in Elixir still generates a random nonce per call.

- [ ] **Step 2: Implement `FBI.Crypto`**

```elixir
defmodule FBI.Crypto do
  @moduledoc """
  AES-256-GCM encrypt/decrypt matching TS's `src/server/crypto.ts` byte layout.

  Layout of an encrypted blob: `nonce(12 bytes) || ciphertext || tag(16 bytes)`.
  This module produces and consumes blobs that round-trip bit-for-bit with TS,
  verified by a committed cross-language fixture in `test/fixtures/`.

  The key must be exactly 32 bytes (AES-256). In production it is read from
  the path in `:secrets_key_path` application env.
  """

  @nonce_len 12
  @tag_len 16

  @type key :: <<_::256>>

  @spec encrypt(key(), binary()) :: binary()
  def encrypt(key, plaintext) when byte_size(key) == 32 and is_binary(plaintext) do
    nonce = :crypto.strong_rand_bytes(@nonce_len)

    {ct, tag} =
      :crypto.crypto_one_time_aead(:aes_256_gcm, key, nonce, plaintext, "", @tag_len, true)

    nonce <> ct <> tag
  end

  @spec decrypt(key(), binary()) :: {:ok, binary()} | {:error, :invalid}
  def decrypt(key, blob)
      when byte_size(key) == 32 and is_binary(blob) and byte_size(blob) >= @nonce_len + @tag_len do
    <<nonce::binary-size(@nonce_len), rest::binary>> = blob
    ct_size = byte_size(rest) - @tag_len
    <<ct::binary-size(ct_size), tag::binary-size(@tag_len)>> = rest

    case :crypto.crypto_one_time_aead(:aes_256_gcm, key, nonce, ct, "", tag, false) do
      plaintext when is_binary(plaintext) -> {:ok, plaintext}
      :error -> {:error, :invalid}
    end
  end

  def decrypt(_key, _blob), do: {:error, :invalid}

  @spec load_key!(Path.t()) :: key()
  def load_key!(path) do
    key = File.read!(path)

    if byte_size(key) != 32 do
      raise "secrets key at #{inspect(path)} is #{byte_size(key)} bytes; expected 32"
    end

    key
  end
end
```

- [ ] **Step 3: Write tests against the fixture**

```elixir
defmodule FBI.CryptoTest do
  use ExUnit.Case, async: true

  alias FBI.Crypto

  @fixture_dir Path.expand("../fixtures", __DIR__)

  defp load_hex!(name) do
    @fixture_dir |> Path.join(name) |> File.read!() |> String.trim() |> Base.decode16!(case: :lower)
  end

  describe "cross-language fixture" do
    test "decrypts TS-produced ciphertext" do
      key = load_hex!("crypto_key_32.hex")
      blob = load_hex!("crypto_ts_encrypted.hex")
      plaintext = @fixture_dir |> Path.join("crypto_plaintext.txt") |> File.read!()

      assert {:ok, ^plaintext} = Crypto.decrypt(key, blob)
    end

    test "Elixir-encrypted output is decryptable by the same logic (round trip)" do
      key = load_hex!("crypto_key_32.hex")
      plaintext = "round-trip test payload"
      blob = Crypto.encrypt(key, plaintext)
      assert {:ok, ^plaintext} = Crypto.decrypt(key, blob)
    end
  end

  describe "decrypt/2 negative paths" do
    test "rejects truncated blobs" do
      key = :crypto.strong_rand_bytes(32)
      assert {:error, :invalid} = Crypto.decrypt(key, <<1, 2, 3>>)
    end

    test "rejects bad tag" do
      key = :crypto.strong_rand_bytes(32)
      plaintext = "hi"
      blob = Crypto.encrypt(key, plaintext)
      # Flip the last byte of the tag.
      <<head::binary-size(byte_size(blob) - 1), last>> = blob
      flipped = head <> <<Bitwise.bxor(last, 0x01)>>
      assert {:error, :invalid} = Crypto.decrypt(key, flipped)
    end
  end

  describe "load_key!/1" do
    test "raises when key length is wrong" do
      bad = Path.join(System.tmp_dir!(), "fbi-bad-key-#{System.unique_integer([:positive])}")
      File.write!(bad, <<0>>)
      on_exit(fn -> File.rm(bad) end)
      assert_raise RuntimeError, fn -> Crypto.load_key!(bad) end
    end
  end
end
```

- [ ] **Step 4: Run, commit**

```bash
cd /workspace/server-elixir && mix test test/fbi/crypto_test.exs
git add \
  server-elixir/lib/fbi/crypto.ex \
  server-elixir/test/fbi/crypto_test.exs \
  server-elixir/test/fixtures/crypto_key_32.hex \
  server-elixir/test/fixtures/crypto_ts_encrypted.hex \
  server-elixir/test/fixtures/crypto_plaintext.txt
git commit -m "feat(server-elixir): add FBI.Crypto (AES-GCM) with TS cross-language fixture"
```

---

## Task 9: `FBI.Projects.Secret` + `SecretQueries`

**Files:**
- Create: `server-elixir/lib/fbi/projects/secret.ex`
- Create: `server-elixir/lib/fbi/projects/secret_queries.ex`
- Create: `server-elixir/test/fbi/projects/secret_queries_test.exs`

- [ ] **Step 1: Schema**

```elixir
defmodule FBI.Projects.Secret do
  @moduledoc "Ecto schema for `project_secrets`. `value_enc` is an AES-GCM blob."
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :integer, autogenerate: false}

  schema "project_secrets" do
    field :project_id, :integer
    field :name, :string
    field :value_enc, :binary
    field :created_at, :integer
  end

  @type t :: %__MODULE__{}

  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(secret, attrs) do
    secret
    |> cast(attrs, [:id, :project_id, :name, :value_enc, :created_at])
    |> validate_required([:project_id, :name, :value_enc, :created_at])
  end
end
```

- [ ] **Step 2: Queries**

```elixir
defmodule FBI.Projects.SecretQueries do
  @moduledoc """
  Read/write helpers for `project_secrets`. Encryption happens on `upsert/3`
  via `FBI.Crypto.encrypt/2` using the key in application env
  `:fbi, :secrets_key_path`. GET only returns names + created_at; values
  are never exposed over HTTP.
  """

  import Ecto.Query

  alias FBI.Crypto
  alias FBI.Projects.Secret
  alias FBI.Repo

  @spec list(integer()) :: [%{name: String.t(), created_at: integer()}]
  def list(project_id) do
    from(s in Secret,
      where: s.project_id == ^project_id,
      order_by: [asc: s.name],
      select: %{name: s.name, created_at: s.created_at}
    )
    |> Repo.all()
  end

  @spec upsert(integer(), String.t(), String.t()) :: :ok
  def upsert(project_id, name, value) do
    key = load_key()
    value_enc = Crypto.encrypt(key, value)
    now = System.system_time(:millisecond)

    %Secret{project_id: project_id, name: name, value_enc: value_enc, created_at: now}
    |> Secret.changeset(%{})
    |> Repo.insert(
      on_conflict: {:replace, [:value_enc, :created_at]},
      conflict_target: [:project_id, :name]
    )

    :ok
  end

  @spec delete(integer(), String.t()) :: :ok
  def delete(project_id, name) do
    Repo.delete_all(from s in Secret, where: s.project_id == ^project_id and s.name == ^name)
    :ok
  end

  defp load_key do
    case Application.get_env(:fbi, :secrets_key_path) do
      nil -> raise "secrets_key_path not configured"
      path -> Crypto.load_key!(path)
    end
  end
end
```

- [ ] **Step 3: Tests**

```elixir
defmodule FBI.Projects.SecretQueriesTest do
  use FBI.DataCase, async: false

  alias FBI.Projects.{Queries, SecretQueries}

  setup do
    key_path = Path.join(System.tmp_dir!(), "fbi-secret-test-#{System.unique_integer([:positive])}")
    File.write!(key_path, :crypto.strong_rand_bytes(32))
    prev = Application.get_env(:fbi, :secrets_key_path)
    Application.put_env(:fbi, :secrets_key_path, key_path)

    on_exit(fn ->
      Application.put_env(:fbi, :secrets_key_path, prev)
      File.rm(key_path)
    end)

    {:ok, p} = Queries.create(%{name: "p#{System.unique_integer([:positive])}", repo_url: "x"})
    %{project_id: p.id}
  end

  test "upsert and list round-trip names (values not exposed)", %{project_id: pid} do
    SecretQueries.upsert(pid, "FOO", "bar-value")
    assert [%{name: "FOO"}] = SecretQueries.list(pid)
  end

  test "upsert replaces value + created_at for existing name", %{project_id: pid} do
    SecretQueries.upsert(pid, "FOO", "first")
    [%{created_at: t1}] = SecretQueries.list(pid)
    :timer.sleep(2)
    SecretQueries.upsert(pid, "FOO", "second")
    [%{created_at: t2}] = SecretQueries.list(pid)
    assert t2 > t1
  end

  test "delete removes secret", %{project_id: pid} do
    SecretQueries.upsert(pid, "FOO", "bar")
    SecretQueries.delete(pid, "FOO")
    assert [] = SecretQueries.list(pid)
  end
end
```

- [ ] **Step 4: Run, commit**

```bash
cd /workspace/server-elixir && mix test test/fbi/projects/secret_queries_test.exs
git add \
  server-elixir/lib/fbi/projects/secret.ex \
  server-elixir/lib/fbi/projects/secret_queries.ex \
  server-elixir/test/fbi/projects/secret_queries_test.exs
git commit -m "feat(server-elixir): add project secrets schema + encrypted upsert"
```

---

## Task 10: `FBIWeb.SecretsController` + routes + tests

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/secrets_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/secrets_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

- [ ] **Step 1: Controller**

```elixir
defmodule FBIWeb.SecretsController do
  @moduledoc "Project-scoped secret names (list), value write (PUT, encrypted), and delete."
  use FBIWeb, :controller

  alias FBI.Projects.SecretQueries

  def index(conn, %{"id" => id_str}) do
    case Integer.parse(id_str) do
      {id, ""} -> json(conn, SecretQueries.list(id))
      _ -> json(conn, [])
    end
  end

  def put(conn, %{"id" => id_str, "name" => name} = params) do
    with {:ok, id} <- parse_id(id_str),
         value when is_binary(value) <- params["value"] do
      SecretQueries.upsert(id, name, value)
      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(400) |> json(%{error: "value required"})
    end
  end

  def delete(conn, %{"id" => id_str, "name" => name}) do
    case parse_id(id_str) do
      {:ok, id} ->
        SecretQueries.delete(id, name)
        send_resp(conn, 204, "")

      :error ->
        send_resp(conn, 204, "")
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
```

- [ ] **Step 2: Register routes**

Add to router in the same scope:

```elixir
    get "/projects/:id/secrets", SecretsController, :index
    put "/projects/:id/secrets/:name", SecretsController, :put
    delete "/projects/:id/secrets/:name", SecretsController, :delete
```

- [ ] **Step 3: Tests**

Mirror `src/server/api/secrets.test.ts`. Use the same `setup` pattern as Task 9 to configure a per-test key path.

- [ ] **Step 4: Run, commit**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/secrets_controller_test.exs
git add \
  server-elixir/lib/fbi_web/controllers/secrets_controller.ex \
  server-elixir/test/fbi_web/controllers/secrets_controller_test.exs \
  server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port /api/projects/:id/secrets routes"
```

---

## Task 11: `FBI.Mcp.Server` + `FBI.Mcp.Queries`

**Files:**
- Create: `server-elixir/lib/fbi/mcp/server.ex`
- Create: `server-elixir/lib/fbi/mcp/queries.ex`
- Create: `server-elixir/test/fbi/mcp/queries_test.exs`

- [ ] **Step 1: Schema**

```elixir
defmodule FBI.Mcp.Server do
  @moduledoc """
  Ecto schema for `mcp_servers`. A `nil` project_id indicates a global
  server; an integer indicates a project-scoped server. `args_json` and
  `env_json` are JSON TEXT columns decoded by `FBI.Mcp.Queries`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :integer, autogenerate: false}

  schema "mcp_servers" do
    field :project_id, :integer
    field :name, :string
    field :type, :string
    field :command, :string
    field :args_json, :string, default: "[]"
    field :url, :string
    field :env_json, :string, default: "{}"
    field :created_at, :integer
  end

  @type t :: %__MODULE__{}

  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(srv, attrs) do
    srv
    |> cast(attrs, [:id, :project_id, :name, :type, :command, :args_json, :url, :env_json, :created_at])
    |> validate_required([:name, :type, :created_at])
    |> validate_inclusion(:type, ["stdio", "sse"])
    |> unique_constraint([:project_id, :name])
  end
end
```

- [ ] **Step 2: Queries**

```elixir
defmodule FBI.Mcp.Queries do
  @moduledoc "CRUD for `mcp_servers`. Handles global vs. project-scoped scoping explicitly."

  import Ecto.Query

  alias FBI.Mcp.Server
  alias FBI.Repo

  @type decoded :: %{
          id: integer(),
          project_id: integer() | nil,
          name: String.t(),
          type: String.t(),
          command: String.t() | nil,
          args: [String.t()],
          url: String.t() | nil,
          env: %{optional(String.t()) => String.t()},
          created_at: integer()
        }

  @spec list_global() :: [decoded()]
  def list_global do
    from(s in Server, where: is_nil(s.project_id), order_by: [asc: s.name])
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec list_for_project(integer()) :: [decoded()]
  def list_for_project(project_id) do
    from(s in Server, where: s.project_id == ^project_id, order_by: [asc: s.name])
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec get_global(integer()) :: {:ok, decoded()} | :not_found
  def get_global(id) do
    case Repo.get(Server, id) do
      %Server{project_id: nil} = s -> {:ok, decode(s)}
      _ -> :not_found
    end
  end

  @spec get_project(integer(), integer()) :: {:ok, decoded()} | :not_found
  def get_project(project_id, id) do
    case Repo.get(Server, id) do
      %Server{project_id: ^project_id} = s -> {:ok, decode(s)}
      _ -> :not_found
    end
  end

  @spec create(map()) :: {:ok, decoded()} | {:error, Ecto.Changeset.t()}
  def create(attrs) do
    now = System.system_time(:millisecond)
    attrs = encode_collections(attrs)

    %Server{}
    |> Server.changeset(Map.put(attrs, :created_at, now))
    |> Repo.insert()
    |> case do
      {:ok, s} -> {:ok, decode(s)}
      err -> err
    end
  end

  @spec update(%Server{}, map()) :: {:ok, decoded()} | {:error, Ecto.Changeset.t()}
  def update(%Server{} = s, patch) do
    s
    |> Server.changeset(encode_collections(patch))
    |> Repo.update()
    |> case do
      {:ok, u} -> {:ok, decode(u)}
      err -> err
    end
  end

  @spec delete(integer()) :: :ok
  def delete(id) do
    Repo.delete_all(from s in Server, where: s.id == ^id)
    :ok
  end

  defp encode_collections(attrs) do
    attrs
    |> maybe_encode_list(:args, :args_json)
    |> maybe_encode_map(:env, :env_json)
    |> Map.drop([:args, :env])
  end

  defp maybe_encode_list(attrs, in_key, out_key) do
    case Map.fetch(attrs, in_key) do
      {:ok, l} when is_list(l) -> Map.put(attrs, out_key, Jason.encode!(l))
      _ -> attrs
    end
  end

  defp maybe_encode_map(attrs, in_key, out_key) do
    case Map.fetch(attrs, in_key) do
      {:ok, m} when is_map(m) -> Map.put(attrs, out_key, Jason.encode!(m))
      _ -> attrs
    end
  end

  defp decode(%Server{} = s) do
    %{
      id: s.id,
      project_id: s.project_id,
      name: s.name,
      type: s.type,
      command: s.command,
      args: Jason.decode!(s.args_json || "[]"),
      url: s.url,
      env: Jason.decode!(s.env_json || "{}"),
      created_at: s.created_at
    }
  end
end
```

- [ ] **Step 3: Queries tests**

Write tests exercising: list_global, list_for_project isolation, create with and without project_id, UNIQUE(project_id, name) enforcement via {:error, changeset}, delete, get_global rejects project-scoped, get_project rejects mismatched project.

- [ ] **Step 4: Run, commit**

```bash
cd /workspace/server-elixir && mix test test/fbi/mcp/queries_test.exs
git add server-elixir/lib/fbi/mcp/ server-elixir/test/fbi/mcp/
git commit -m "feat(server-elixir): add FBI.Mcp schema + Queries"
```

---

## Task 12: `FBIWeb.McpServersController` + routes + tests

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/mcp_servers_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/mcp_servers_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

TS reference: `src/server/api/mcpServers.ts:15-74`. Controller handles BOTH global (`/api/mcp-servers/*`) and project-scoped (`/api/projects/:id/mcp-servers/*`) routes via two sets of actions sharing helpers.

- [ ] **Step 1: Controller**

```elixir
defmodule FBIWeb.McpServersController do
  @moduledoc """
  CRUD for MCP servers (global and project-scoped).

  Routes:
  - `GET  /api/mcp-servers` — list global
  - `POST /api/mcp-servers` — create global
  - `PATCH  /api/mcp-servers/:id` — 404 if row is project-scoped
  - `DELETE /api/mcp-servers/:id` — 404 if row is project-scoped
  - `GET  /api/projects/:id/mcp-servers` — list project-scoped
  - `POST /api/projects/:id/mcp-servers` — create with project_id
  - `PATCH  /api/projects/:id/mcp-servers/:sid` — 404 if mismatched project
  - `DELETE /api/projects/:id/mcp-servers/:sid` — 404 if mismatched project
  """

  use FBIWeb, :controller

  alias FBI.Mcp.{Queries, Server}
  alias FBI.Repo

  # ---- Global ----

  def index_global(conn, _params), do: json(conn, Queries.list_global())

  def create_global(conn, params) do
    attrs = atomize(params) |> Map.put(:project_id, nil)

    case Queries.create(attrs) do
      {:ok, s} -> conn |> put_status(201) |> json(s)
      {:error, cs} -> conn |> put_status(400) |> json(%{error: cs_msg(cs)})
    end
  end

  def patch_global(conn, %{"id" => id_str} = params) do
    patch = atomize(Map.delete(params, "id"))

    with {:ok, id} <- parse_id(id_str),
         {:ok, s} <- fetch_global(id),
         {:ok, updated} <- Queries.update(s, patch) do
      json(conn, updated)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def delete_global(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, _s} <- fetch_global(id) do
      Queries.delete(id)
      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  # ---- Project-scoped ----

  def index_project(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      {:ok, id} -> json(conn, Queries.list_for_project(id))
      :error -> json(conn, [])
    end
  end

  def create_project(conn, %{"id" => id_str} = params) do
    with {:ok, project_id} <- parse_id(id_str) do
      attrs = atomize(params) |> Map.put(:project_id, project_id)

      case Queries.create(attrs) do
        {:ok, s} -> conn |> put_status(201) |> json(s)
        {:error, cs} -> conn |> put_status(400) |> json(%{error: cs_msg(cs)})
      end
    else
      _ -> conn |> put_status(400) |> json(%{error: "invalid project id"})
    end
  end

  def patch_project(conn, %{"id" => id_str, "sid" => sid_str} = params) do
    patch = atomize(params |> Map.delete("id") |> Map.delete("sid"))

    with {:ok, project_id} <- parse_id(id_str),
         {:ok, sid} <- parse_id(sid_str),
         {:ok, s} <- fetch_project(project_id, sid),
         {:ok, updated} <- Queries.update(s, patch) do
      json(conn, updated)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def delete_project(conn, %{"id" => id_str, "sid" => sid_str}) do
    with {:ok, project_id} <- parse_id(id_str),
         {:ok, sid} <- parse_id(sid_str),
         {:ok, _s} <- fetch_project(project_id, sid) do
      Queries.delete(sid)
      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  # ---- Helpers ----

  defp fetch_global(id) do
    case Repo.get(Server, id) do
      %Server{project_id: nil} = s -> {:ok, s}
      _ -> :not_found
    end
  end

  defp fetch_project(project_id, sid) do
    case Repo.get(Server, sid) do
      %Server{project_id: ^project_id} = s -> {:ok, s}
      _ -> :not_found
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  @allowed ~w(name type command args url env)
  @known_string_keys Map.new(@allowed, fn k -> {k, String.to_atom(k)} end)

  defp atomize(params) when is_map(params) do
    Enum.reduce(@known_string_keys, %{}, fn {k, a}, acc ->
      case Map.fetch(params, k) do
        {:ok, v} -> Map.put(acc, a, v)
        :error -> acc
      end
    end)
  end

  defp cs_msg(%Ecto.Changeset{errors: [{f, {m, _}} | _]}), do: "#{f} #{m}"
  defp cs_msg(_), do: "invalid input"
end
```

- [ ] **Step 2: Register routes**

```elixir
    # Global MCP
    get "/mcp-servers", McpServersController, :index_global
    post "/mcp-servers", McpServersController, :create_global
    patch "/mcp-servers/:id", McpServersController, :patch_global
    delete "/mcp-servers/:id", McpServersController, :delete_global

    # Project-scoped MCP
    get "/projects/:id/mcp-servers", McpServersController, :index_project
    post "/projects/:id/mcp-servers", McpServersController, :create_project
    patch "/projects/:id/mcp-servers/:sid", McpServersController, :patch_project
    delete "/projects/:id/mcp-servers/:sid", McpServersController, :delete_project
```

- [ ] **Step 3: Tests**

Port all cases from `src/server/api/mcpServers.test.ts`. Especially:
- PATCH global `/api/mcp-servers/:id` returns 404 when the server is project-scoped
- PATCH `/api/projects/:id/mcp-servers/:sid` returns 404 for cross-project mismatch

- [ ] **Step 4: Run, commit**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/mcp_servers_controller_test.exs
git add server-elixir/lib/fbi_web/controllers/mcp_servers_controller.ex \
        server-elixir/test/fbi_web/controllers/mcp_servers_controller_test.exs \
        server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port MCP server CRUD (global + project-scoped)"
```

---

## Task 13: `FBI.Runs.Run` Ecto schema

**Files:**
- Create: `server-elixir/lib/fbi/runs/run.ex`

- [ ] **Step 1: Schema**

```elixir
defmodule FBI.Runs.Run do
  @moduledoc """
  Ecto schema for the `runs` table. Mirrors the column order + types + defaults
  of TS's schema + ALTERs. `title_locked` is 0/1 to match TS SQLite convention.
  """
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :integer, autogenerate: false}

  schema "runs" do
    field :project_id, :integer
    field :prompt, :string
    field :branch_name, :string
    field :state, :string
    field :container_id, :string
    field :log_path, :string
    field :exit_code, :integer
    field :error, :string
    field :head_commit, :string
    field :started_at, :integer
    field :finished_at, :integer
    field :created_at, :integer
    field :state_entered_at, :integer, default: 0
    field :model, :string
    field :effort, :string
    field :subagent_model, :string
    field :resume_attempts, :integer, default: 0
    field :next_resume_at, :integer
    field :claude_session_id, :string
    field :last_limit_reset_at, :integer
    field :tokens_input, :integer, default: 0
    field :tokens_output, :integer, default: 0
    field :tokens_cache_read, :integer, default: 0
    field :tokens_cache_create, :integer, default: 0
    field :tokens_total, :integer, default: 0
    field :usage_parse_errors, :integer, default: 0
    field :title, :string
    field :title_locked, :integer, default: 0
    field :parent_run_id, :integer
  end

  @type t :: %__MODULE__{}

  @all_fields ~w(
    project_id prompt branch_name state container_id log_path exit_code error
    head_commit started_at finished_at created_at state_entered_at
    model effort subagent_model
    resume_attempts next_resume_at claude_session_id last_limit_reset_at
    tokens_input tokens_output tokens_cache_read tokens_cache_create tokens_total
    usage_parse_errors title title_locked parent_run_id
  )a

  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(run, attrs) do
    run
    |> cast(attrs, [:id | @all_fields])
    |> validate_required([:project_id, :prompt, :branch_name, :state, :log_path, :created_at])
    |> validate_inclusion(:title_locked, [0, 1])
  end
end
```

- [ ] **Step 2: Commit**

```bash
cd /workspace/server-elixir && mix compile --warnings-as-errors
git add server-elixir/lib/fbi/runs/run.ex
git commit -m "feat(server-elixir): add FBI.Runs.Run Ecto schema"
```

---

## Task 14: `FBI.Runs.Queries`

**Files:**
- Create: `server-elixir/lib/fbi/runs/queries.ex`
- Create: `server-elixir/test/fbi/runs/queries_test.exs`

Implements: `list/1` (with filter/search/page), `get/1`, `list_for_project/1`, `siblings/1`, `latest_for_project/1` (used by ProjectsController.index), `update_title/2`, `delete/1`.

- [ ] **Step 1: Queries module**

```elixir
defmodule FBI.Runs.Queries do
  @moduledoc """
  Read/write helpers for the `runs` table. Search uses `LOWER(prompt) LIKE '%q%'`
  mirroring TS. List results can be returned unpaginated (array) OR paginated
  (%{items, total}) when the caller specifies any paging param.
  """

  import Ecto.Query

  alias FBI.Repo
  alias FBI.Runs.Run

  @type decoded :: map()

  @spec list(map()) :: [decoded()] | %{items: [decoded()], total: integer()}
  def list(params) do
    base = from(r in Run, order_by: [desc: r.id])

    base =
      base
      |> maybe_filter_state(params[:state])
      |> maybe_filter_project(params[:project_id])
      |> maybe_filter_q(params[:q])

    paged? = params[:limit] != nil or params[:offset] != nil

    if paged? do
      limit = clamp(params[:limit] || 50, 1, 200)
      offset = max(0, params[:offset] || 0)

      items = base |> limit(^limit) |> offset(^offset) |> Repo.all() |> Enum.map(&decode/1)
      total = base |> select([r], count(r.id)) |> Repo.one()

      %{items: items, total: total}
    else
      base |> Repo.all() |> Enum.map(&decode/1)
    end
  end

  @spec get(integer()) :: {:ok, decoded()} | :not_found
  def get(id) do
    case Repo.get(Run, id) do
      nil -> :not_found
      r -> {:ok, decode(r)}
    end
  end

  @spec list_for_project(integer()) :: [decoded()]
  def list_for_project(project_id) do
    from(r in Run,
      where: r.project_id == ^project_id,
      order_by: [desc: r.created_at],
      limit: 50
    )
    |> Repo.all()
    |> Enum.map(&decode/1)
  end

  @spec siblings(integer()) :: {:ok, [decoded()]} | :not_found
  def siblings(id) do
    case Repo.get(Run, id) do
      nil ->
        :not_found

      %Run{project_id: pid, prompt: prompt} ->
        rows =
          from(r in Run,
            where: r.project_id == ^pid and r.prompt == ^prompt and r.id != ^id,
            order_by: [desc: r.id],
            limit: 10
          )
          |> Repo.all()
          |> Enum.map(&decode/1)

        {:ok, rows}
    end
  end

  @doc "Compact summary used in the /api/projects index."
  @spec latest_for_project(integer()) ::
          %{id: integer(), state: String.t(), created_at: integer()} | nil
  def latest_for_project(project_id) do
    from(r in Run,
      where: r.project_id == ^project_id,
      order_by: [desc: r.id],
      limit: 1,
      select: %{id: r.id, state: r.state, created_at: r.created_at}
    )
    |> Repo.one()
  end

  @spec update_title(integer(), String.t()) :: {:ok, decoded()} | :not_found
  def update_title(id, title) do
    case Repo.get(Run, id) do
      nil ->
        :not_found

      r ->
        r
        |> Run.changeset(%{title: title, title_locked: 0})
        |> Repo.update!()

        {:ok, r |> Repo.reload() |> decode()}
    end
  end

  @spec delete(integer()) :: :ok
  def delete(id) do
    Repo.delete_all(from r in Run, where: r.id == ^id)
    :ok
  end

  defp maybe_filter_state(q, nil), do: q
  defp maybe_filter_state(q, s) when is_binary(s), do: from(r in q, where: r.state == ^s)

  defp maybe_filter_project(q, nil), do: q
  defp maybe_filter_project(q, pid) when is_integer(pid), do: from(r in q, where: r.project_id == ^pid)

  defp maybe_filter_q(q, nil), do: q
  defp maybe_filter_q(q, ""), do: q

  defp maybe_filter_q(q, text) when is_binary(text) do
    pattern = "%" <> String.downcase(text) <> "%"
    from(r in q, where: like(fragment("LOWER(?)", r.prompt), ^pattern))
  end

  defp clamp(n, lo, hi) when is_integer(n), do: n |> max(lo) |> min(hi)

  @doc "Build the plain JSON-ready map for a run. All keys mirror TS exactly."
  @spec decode(Run.t()) :: map()
  def decode(%Run{} = r) do
    Map.take(r, [
      :id, :project_id, :prompt, :branch_name, :state, :container_id, :log_path,
      :exit_code, :error, :head_commit, :started_at, :finished_at, :created_at,
      :state_entered_at, :model, :effort, :subagent_model,
      :resume_attempts, :next_resume_at, :claude_session_id, :last_limit_reset_at,
      :tokens_input, :tokens_output, :tokens_cache_read, :tokens_cache_create, :tokens_total,
      :usage_parse_errors, :title, :title_locked, :parent_run_id
    ])
  end
end
```

- [ ] **Step 2: Tests**

Cover: create-via-Repo.insert!, list with/without paging, state filter, project_id filter, q search (case-insensitive), get/1 not_found, siblings (same prompt excludes self, limit 10), latest_for_project, update_title (returns 200 and sets title_locked=0), delete is idempotent.

- [ ] **Step 3: Run, commit**

```bash
cd /workspace/server-elixir && mix test test/fbi/runs/queries_test.exs
git add server-elixir/lib/fbi/runs/ server-elixir/test/fbi/runs/
git commit -m "feat(server-elixir): add FBI.Runs.Queries (list/get/siblings/paged)"
```

**Important:** after this task the tests from Task 7 (ProjectsControllerTest) that exercise `last_run` should now pass. Re-run `mix test test/fbi_web/controllers/projects_controller_test.exs` and confirm.

---

## Task 15: `FBIWeb.RunsController` (show, list, project_runs, siblings, PATCH, DELETE)

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/runs_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`
- Create: `server-elixir/lib/fbi/docker.ex` (for DELETE active-run path)

- [ ] **Step 1: Minimal Docker kill client**

```elixir
defmodule FBI.Docker do
  @moduledoc """
  Minimal Docker Engine API client over a unix socket. Only the operations
  needed by the active-run DELETE path are implemented: `kill/1`.
  """

  require Logger

  @spec kill(String.t()) :: :ok | {:error, term()}
  def kill(container_id) when is_binary(container_id) and container_id != "" do
    socket = Application.get_env(:fbi, :docker_socket_path, "/var/run/docker.sock")
    path = "/containers/#{container_id}/kill"

    with {:ok, conn} <- :gen_tcp.connect({:local, socket}, 0, [:binary, active: false, packet: :http_bin]) do
      req = "POST #{path} HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n"
      :ok = :gen_tcp.send(conn, req)
      :gen_tcp.close(conn)
      :ok
    else
      {:error, reason} ->
        Logger.warning("docker kill failed: #{inspect(reason)}")
        {:error, reason}
    end
  end

  def kill(_), do: :ok
end
```

Note: the `:gen_tcp.connect/3` with `{:local, path}` works on Linux via the unix-socket extension; keeps this tiny. If the socket is unreachable, `kill/1` returns `{:error, _}` — we log and continue; DB update still happens.

- [ ] **Step 2: Controller**

```elixir
defmodule FBIWeb.RunsController do
  @moduledoc """
  Runs read + non-orchestrator mutations. PATCH updates title; DELETE removes
  the row and, for active runs, issues a Docker kill via the socket client.
  """

  use FBIWeb, :controller

  alias FBI.Runs.Queries

  def index(conn, params) do
    parsed = %{
      state: params["state"],
      project_id: parse_int(params["project_id"]),
      q: params["q"],
      limit: parse_int(params["limit"]),
      offset: parse_int(params["offset"])
    }

    json(conn, Queries.list(parsed))
  end

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      json(conn, run)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def index_for_project(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      {:ok, pid} -> json(conn, Queries.list_for_project(pid))
      _ -> json(conn, [])
    end
  end

  def siblings(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, list} <- Queries.siblings(id) do
      json(conn, list)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def patch_title(conn, %{"id" => id_str} = params) do
    title =
      case params["title"] do
        t when is_binary(t) -> String.trim(t)
        _ -> nil
      end

    with {:ok, id} <- parse_id(id_str),
         true <- is_binary(title) and byte_size(title) > 0 and byte_size(title) <= 120,
         {:ok, run} <- Queries.update_title(id, title) do
      json(conn, run)
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
      _ -> conn |> put_status(400) |> json(%{error: "invalid title"})
    end
  end

  def delete(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      if run.state in ["running", "awaiting_resume", "starting"] do
        if run.container_id, do: FBI.Docker.kill(run.container_id)
      end

      Queries.delete(id)

      if run.log_path, do: File.rm(run.log_path)

      send_resp(conn, 204, "")
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  defp parse_int(nil), do: nil

  defp parse_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, _} -> n
      :error -> nil
    end
  end
end
```

- [ ] **Step 3: Register routes**

```elixir
    get "/runs", RunsController, :index
    get "/runs/:id", RunsController, :show
    patch "/runs/:id", RunsController, :patch_title
    delete "/runs/:id", RunsController, :delete
    get "/runs/:id/siblings", RunsController, :siblings
    get "/projects/:id/runs", RunsController, :index_for_project
```

- [ ] **Step 4: Tests, commit**

Port cases from `src/server/api/runs.test.ts` for GET /runs (filters, pagination), GET /runs/:id (404), GET /siblings, PATCH (invalid title, 404), DELETE (queued: row gone; running: still returns 204 and calls Docker.kill which is a no-op in test).

Use `Application.put_env(:fbi, :docker_socket_path, "/nonexistent")` in setup so Docker.kill fails softly (returns {:error, _}) without affecting the test.

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs
git add server-elixir/lib/fbi/docker.ex \
        server-elixir/lib/fbi_web/controllers/runs_controller.ex \
        server-elixir/test/fbi_web/controllers/runs_controller_test.exs \
        server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port runs read + PATCH/DELETE routes"
```

---

## Task 16: Transcript controller

**Files:**
- Create: `server-elixir/lib/fbi/runs/log_store.ex`
- Create: `server-elixir/lib/fbi_web/controllers/transcript_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/transcript_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

- [ ] **Step 1: LogStore**

```elixir
defmodule FBI.Runs.LogStore do
  @moduledoc "Reads run transcript files. Empty binary when missing, per TS contract."

  @spec read_all(Path.t()) :: binary()
  def read_all(path) do
    case File.read(path) do
      {:ok, data} -> data
      {:error, _} -> <<>>
    end
  end
end
```

- [ ] **Step 2: Controller**

```elixir
defmodule FBIWeb.TranscriptController do
  @moduledoc "GET /api/runs/:id/transcript — serves the entire log file as text/plain."
  use FBIWeb, :controller

  alias FBI.Runs.{LogStore, Queries}

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Queries.get(id) do
      body = LogStore.read_all(run.log_path)

      conn
      |> put_resp_header("content-type", "text/plain; charset=utf-8")
      |> send_resp(200, body)
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
```

- [ ] **Step 3: Register route**

```elixir
    get "/runs/:id/transcript", TranscriptController, :show
```

- [ ] **Step 4: Tests, commit**

Tests: write a run row referencing a tempfile containing `"hello\n"`; GET returns 200 with exact body + content-type; missing file returns 200 with empty body; absent run returns 404.

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/transcript_controller_test.exs
git add server-elixir/lib/fbi/runs/log_store.ex \
        server-elixir/lib/fbi_web/controllers/transcript_controller.ex \
        server-elixir/test/fbi_web/controllers/transcript_controller_test.exs \
        server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port GET /api/runs/:id/transcript"
```

---

## Task 17: GitHub client + status cache

**Files:**
- Create: `server-elixir/lib/fbi/github/client.ex`
- Create: `server-elixir/lib/fbi/github/status_cache.ex`
- Create: `server-elixir/test/fbi/github/client_test.exs` (only the pure helpers; gh shell-out is mocked at the boundary)
- Modify: `server-elixir/lib/fbi/application.ex` (start StatusCache)

- [ ] **Step 1: Client**

```elixir
defmodule FBI.Github.Client do
  @moduledoc """
  Thin wrapper around the `gh` CLI. Used to fetch PR / checks / compare / commits
  for a given repo + branch. The client shells out via `System.cmd/3`; tests
  stub the `cmd` function through a config-overridable adapter.
  """

  @type repo :: String.t()
  @type branch :: String.t()
  @type pr :: %{number: integer(), url: String.t(), state: String.t(), title: String.t()}

  @spec pr_for_branch(repo(), branch()) :: {:ok, pr() | nil} | {:error, term()}
  def pr_for_branch(repo, branch) do
    case run(["pr", "list", "--repo", repo, "--head", branch, "--state", "all",
              "--json", "number,url,state,title", "--limit", "1"]) do
      {:ok, stdout} ->
        case Jason.decode(stdout) do
          {:ok, [pr | _]} -> {:ok, atomize_pr(pr)}
          {:ok, _} -> {:ok, nil}
          err -> err
        end

      err ->
        err
    end
  end

  @spec pr_checks(repo(), branch()) :: {:ok, [map()]} | {:error, term()}
  def pr_checks(repo, branch) do
    case run(["pr", "checks", branch, "--repo", repo, "--json", "name,status,conclusion"]) do
      {:ok, stdout} -> Jason.decode(stdout)
      err -> err
    end
  end

  @spec commits_on_branch(repo(), branch()) :: {:ok, [map()]} | {:error, term()}
  def commits_on_branch(repo, branch) do
    case run(["api", "/repos/#{repo}/commits?sha=#{branch}&per_page=20"]) do
      {:ok, stdout} ->
        case Jason.decode(stdout) do
          {:ok, items} when is_list(items) ->
            {:ok,
             Enum.map(items, fn i ->
               %{
                 sha: i["sha"],
                 subject: i |> get_in(["commit", "message"]) |> first_line(),
                 committed_at: i |> get_in(["commit", "committer", "date"]) |> iso8601_to_unix(),
                 pushed: true
               }
             end)}

          _ ->
            {:ok, []}
        end

      err ->
        err
    end
  end

  @spec compare_files(repo(), String.t(), String.t()) :: {:ok, [map()]} | {:error, term()}
  def compare_files(repo, base, head) do
    case run([
           "api",
           "repos/#{repo}/compare/#{base}...#{head}",
           "--jq",
           ~s(.files | map({filename, additions, deletions, status}))
         ]) do
      {:ok, stdout} -> Jason.decode(stdout)
      err -> err
    end
  end

  @spec create_pr(repo(), %{head: String.t(), base: String.t(), title: String.t(), body: String.t()}) ::
          {:ok, pr()} | {:error, term()}
  def create_pr(repo, %{head: head, base: base, title: title, body: body}) do
    case run(["pr", "create", "--repo", repo, "--head", head, "--base", base, "--title", title, "--body", body]) do
      {:ok, _} -> pr_for_branch(repo, head) |> then(fn {:ok, v} -> {:ok, v} end)
      err -> err
    end
  end

  @spec merge_branch(repo(), String.t(), String.t(), String.t()) ::
          {:ok, %{merged: true, sha: String.t()}}
          | {:ok, %{merged: false, reason: :already_merged | :conflict}}
          | {:error, :gh_error}
  def merge_branch(repo, head, base, commit_msg) do
    case run([
           "api", "-X", "POST", "/repos/#{repo}/merges",
           "-f", "base=#{base}",
           "-f", "head=#{head}",
           "-f", "commit_message=#{commit_msg}"
         ]) do
      {:ok, ""} ->
        {:ok, %{merged: false, reason: :already_merged}}

      {:ok, stdout} ->
        case Jason.decode(stdout) do
          {:ok, %{"sha" => sha}} -> {:ok, %{merged: true, sha: sha}}
          _ -> {:error, :gh_error}
        end

      {:error, {_code, stderr}} ->
        if stderr =~ "conflict" or stderr =~ "409" do
          {:ok, %{merged: false, reason: :conflict}}
        else
          {:error, :gh_error}
        end
    end
  end

  @spec available?() :: boolean()
  def available? do
    case System.find_executable("gh") do
      nil -> false
      _ -> true
    end
  end

  defp run(args) do
    adapter = Application.get_env(:fbi, :gh_cmd_adapter, &default_cmd/1)
    adapter.(args)
  end

  defp default_cmd(args) do
    case System.cmd("gh", args, stderr_to_stdout: false) do
      {stdout, 0} -> {:ok, String.trim_trailing(stdout)}
      {stderr, code} -> {:error, {code, stderr}}
    end
  end

  defp atomize_pr(%{"number" => n, "url" => u, "state" => s, "title" => t}),
    do: %{number: n, url: u, state: s, title: t}

  defp first_line(nil), do: ""
  defp first_line(s), do: s |> String.split("\n", parts: 2) |> List.first()

  defp iso8601_to_unix(nil), do: 0

  defp iso8601_to_unix(s) when is_binary(s) do
    case DateTime.from_iso8601(s) do
      {:ok, dt, _} -> DateTime.to_unix(dt)
      _ -> 0
    end
  end
end
```

- [ ] **Step 2: StatusCache (Agent-backed)**

```elixir
defmodule FBI.Github.StatusCache do
  @moduledoc """
  Per-run-id cache of the GitHub status payload with a 10-second TTL.

  This is an `Agent`: a tiny state-holding process whose API is just get/put.
  Matches the TS in-memory Map cache in `src/server/api/runs.ts`.
  """

  use Agent

  @ttl_ms 10_000

  @spec start_link(keyword()) :: {:ok, pid()}
  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @spec get(integer()) :: {:hit, map()} | :miss
  def get(run_id) do
    now = System.monotonic_time(:millisecond)

    Agent.get(__MODULE__, fn state ->
      case Map.get(state, run_id) do
        %{value: v, expires_at: exp} when exp > now -> {:hit, v}
        _ -> :miss
      end
    end)
  end

  @spec put(integer(), map()) :: :ok
  def put(run_id, value) do
    now = System.monotonic_time(:millisecond)
    Agent.update(__MODULE__, &Map.put(&1, run_id, %{value: value, expires_at: now + @ttl_ms}))
  end

  @spec invalidate(integer()) :: :ok
  def invalidate(run_id) do
    Agent.update(__MODULE__, &Map.delete(&1, run_id))
  end
end
```

- [ ] **Step 3: Wire into Application**

Edit `server-elixir/lib/fbi/application.ex`. Add `FBI.Github.StatusCache` to the supervision tree after `Phoenix.PubSub`:

```elixir
{Phoenix.PubSub, name: FBI.PubSub},
FBI.Github.StatusCache,
```

- [ ] **Step 4: Commit**

```bash
cd /workspace/server-elixir && mix compile --warnings-as-errors && mix test
git add server-elixir/lib/fbi/github/ server-elixir/test/fbi/github/ server-elixir/lib/fbi/application.ex
git commit -m "feat(server-elixir): add gh CLI client + 10s status cache"
```

---

## Task 18: `FBIWeb.GithubController` — GET status, POST pr, POST merge

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/github_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/github_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

- [ ] **Step 1: Controller**

```elixir
defmodule FBIWeb.GithubController do
  @moduledoc """
  GitHub integration for a run: read PR/CI status (cached 10s), create a PR,
  and merge the branch.

  Conflict path: when `gh` reports a merge conflict, Elixir returns
  `409 { merged: false, reason: "conflict" }`. The auto-resolution prompt
  injection that TS performs depends on the orchestrator (Phase 7); it is
  NOT performed here during the crossover.
  """

  use FBIWeb, :controller

  alias FBI.Github.{Client, StatusCache}
  alias FBI.Projects.Queries, as: Projects
  alias FBI.Runs.Queries, as: Runs

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id) do
      case StatusCache.get(id) do
        {:hit, v} ->
          json(conn, v)

        :miss ->
          payload = compute_payload(run)
          StatusCache.put(id, payload)
          json(conn, payload)
      end
    else
      _ -> conn |> put_status(404) |> json(%{error: "not found"})
    end
  end

  def create_pr(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         true <- is_binary(run.branch_name) and byte_size(run.branch_name) > 0 or {:error, :no_branch},
         {:ok, project} <- Projects.get(run.project_id),
         {:ok, repo} <- parse_github_repo(project.repo_url),
         true <- Client.available?() or {:error, :gh_unavailable} do
      case Client.pr_for_branch(repo, run.branch_name) do
        {:ok, pr} when is_map(pr) ->
          conn |> put_status(409) |> json(%{error: "PR already exists", pr: pr})

        _ ->
          title = run.prompt |> String.split("\n", parts: 2) |> List.first() |> String.slice(0, 72)
          body = run.prompt <> "\n\n---\n🤖 Generated with FBI run ##{id}"

          case Client.create_pr(repo, %{
                 head: run.branch_name,
                 base: project.default_branch,
                 title: title,
                 body: body
               }) do
            {:ok, pr} ->
              StatusCache.invalidate(id)
              json(conn, pr)

            {:error, _} ->
              conn |> put_status(500) |> json(%{error: "gh create failed"})
          end
      end
    else
      {:error, :no_branch} ->
        conn |> put_status(400) |> json(%{error: "run has no branch to open a PR from"})

      {:error, :gh_unavailable} ->
        conn |> put_status(503) |> json(%{error: "gh-not-available"})

      _ ->
        conn |> put_status(400) |> json(%{error: "not a github project"})
    end
  end

  def merge(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         {:ok, project} <- Projects.get(run.project_id),
         {:ok, repo} <- parse_github_repo(project.repo_url),
         true <- is_binary(run.branch_name) and byte_size(run.branch_name) > 0 or {:error, :no_branch},
         true <- Client.available?() or {:error, :gh_unavailable} do
      commit_msg = "Merge branch '#{run.branch_name}' (FBI run ##{id})"

      case Client.merge_branch(repo, run.branch_name, project.default_branch, commit_msg) do
        {:ok, %{merged: true} = payload} ->
          StatusCache.invalidate(id)
          json(conn, payload)

        {:ok, %{merged: false, reason: :already_merged}} ->
          StatusCache.invalidate(id)
          json(conn, %{merged: false, reason: "already-merged"})

        {:ok, %{merged: false, reason: :conflict}} ->
          conn |> put_status(409) |> json(%{merged: false, reason: "conflict"})

        {:error, _} ->
          conn |> put_status(500) |> json(%{merged: false, reason: "gh-error"})
      end
    else
      {:error, :no_branch} ->
        conn |> put_status(400) |> json(%{merged: false, reason: "no-branch"})

      {:error, :gh_unavailable} ->
        conn |> put_status(503) |> json(%{merged: false, reason: "gh-not-available"})

      _ ->
        conn |> put_status(400) |> json(%{merged: false, reason: "not-github"})
    end
  end

  defp compute_payload(run) do
    with {:ok, project} <- Projects.get(run.project_id),
         {:ok, repo} <- parse_github_repo(project.repo_url),
         true <- Client.available?() do
      pr = (Client.pr_for_branch(repo, run.branch_name) |> elem(1))
      checks = case Client.pr_checks(repo, run.branch_name) do
        {:ok, list} -> summarize_checks(list)
        _ -> nil
      end
      commits = case Client.commits_on_branch(repo, run.branch_name) do
        {:ok, list} -> list
        _ -> []
      end

      %{pr: pr, checks: checks, commits: commits, github_available: true}
    else
      _ -> %{pr: nil, checks: nil, commits: [], github_available: false}
    end
  end

  defp summarize_checks([]), do: nil

  defp summarize_checks(list) do
    items = Enum.map(list, fn c ->
      %{
        name: c["name"] || "",
        status: (if c["status"] == "COMPLETED" or c["status"] == "completed", do: "completed", else: "pending"),
        conclusion: conclusion(c["conclusion"]),
        duration_ms: nil
      }
    end)

    passed = Enum.count(items, &(&1.conclusion == "success"))
    failed = Enum.count(items, &(&1.conclusion == "failure"))
    total = length(items)

    state =
      cond do
        Enum.any?(items, &(&1.status == "pending")) -> "pending"
        failed > 0 -> "failure"
        passed > 0 -> "success"
        true -> "pending"
      end

    %{state: state, passed: passed, failed: failed, total: total, items: items}
  end

  defp conclusion(nil), do: nil

  defp conclusion(s) when is_binary(s) do
    case String.downcase(s) do
      "success" -> "success"
      "failure" -> "failure"
      "neutral" -> "neutral"
      "skipped" -> "skipped"
      "cancelled" -> "cancelled"
      _ -> nil
    end
  end

  defp parse_github_repo(url) when is_binary(url) do
    patterns = [
      ~r{git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$},
      ~r{https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$}
    ]

    Enum.find_value(patterns, :error, fn re ->
      case Regex.run(re, url) do
        [_, owner, name] -> {:ok, "#{owner}/#{name}"}
        _ -> false
      end
    end)
  end

  defp parse_github_repo(_), do: :error

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
```

- [ ] **Step 2: Register routes**

```elixir
    get "/runs/:id/github", GithubController, :show
    post "/runs/:id/github/pr", GithubController, :create_pr
    post "/runs/:id/github/merge", GithubController, :merge
```

- [ ] **Step 3: Tests**

Stub `gh_cmd_adapter` via `Application.put_env(:fbi, :gh_cmd_adapter, fn args -> ... end)` so tests don't need `gh` installed. Cover:
- show: 404 for missing run; gh unavailable returns `github_available: false`; cache hit skips the adapter
- create_pr: 400 without branch_name; 400 for non-github project; 409 when PR exists; 200 with PR JSON on success
- merge: 400 reasons; 409 on conflict; 200 on merged; 200 with `reason: "already-merged"` on empty stdout

- [ ] **Step 4: Commit**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/github_controller_test.exs
git add server-elixir/lib/fbi_web/controllers/github_controller.ex \
        server-elixir/test/fbi_web/controllers/github_controller_test.exs \
        server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port GitHub read/PR/merge routes"
```

---

## Task 19: Files controller (GET /api/runs/:id/files)

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/files_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/files_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

Simplified port (no live-container path; always reports `live: false`).

- [ ] **Step 1: Controller**

```elixir
defmodule FBIWeb.FilesController do
  @moduledoc """
  GET /api/runs/:id/files — returns the file-change list via `gh api compare`.

  Differs from TS: the "live container" path (`orchestrator.getLastFiles`) is
  skipped during the crossover. `live` is always `false`. Finished runs and
  runs whose branch is pushed return correct data.
  """

  use FBIWeb, :controller

  alias FBI.Github.Client
  alias FBI.Projects.Queries, as: Projects
  alias FBI.Runs.Queries, as: Runs

  def show(conn, %{"id" => id_str}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         {:ok, project} <- Projects.get(run.project_id),
         {:ok, repo} <- parse_github_repo(project.repo_url),
         true <- Client.available?() do
      case Client.compare_files(repo, project.default_branch, run.branch_name) do
        {:ok, files} when is_list(files) ->
          head_files =
            Enum.map(files, fn f ->
              %{
                filename: f["filename"],
                additions: f["additions"] || 0,
                deletions: f["deletions"] || 0,
                status: map_status(f["status"])
              }
            end)

          json(conn, %{
            dirty: [],
            head: nil,
            headFiles: head_files,
            branchBase: %{
              base: project.default_branch,
              ahead: (if length(head_files) > 0, do: 1, else: 0),
              behind: 0
            },
            live: false
          })

        _ ->
          json(conn, empty_payload(project.default_branch))
      end
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not found"})
      _ -> json(conn, %{dirty: [], head: nil, headFiles: [], branchBase: nil, live: false})
    end
  end

  defp empty_payload(base) do
    %{dirty: [], head: nil, headFiles: [], branchBase: %{base: base, ahead: 0, behind: 0}, live: false}
  end

  defp map_status("added"), do: "A"
  defp map_status("removed"), do: "D"
  defp map_status("renamed"), do: "R"
  defp map_status(_), do: "M"

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end

  defp parse_github_repo(url) do
    case FBIWeb.GithubController.__info__(:functions) |> Keyword.get(:parse_github_repo) do
      nil -> :error
      _ -> apply(FBIWeb.GithubController, :parse_github_repo, [url])
    end
  rescue
    _ -> :error
  end
end
```

Note: the `parse_github_repo` helper in GithubController is private. For cleanliness, extract it into a new module `FBI.Github.Repo` with `parse/1`, and have both controllers call it. Do this as part of Step 1.

- [ ] **Step 2: Register route**

```elixir
    get "/runs/:id/files", FilesController, :show
```

- [ ] **Step 3: Tests, commit**

Tests stub the gh adapter and confirm `map_status` converts as expected; 404 for missing runs.

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/files_controller_test.exs
git add server-elixir/lib/fbi/github/repo.ex \
        server-elixir/lib/fbi_web/controllers/files_controller.ex \
        server-elixir/test/fbi_web/controllers/files_controller_test.exs \
        server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port GET /api/runs/:id/files (gh compare fallback)"
```

---

## Task 20: Upload filesystem helpers

**Files:**
- Create: `server-elixir/lib/fbi/uploads/fs.ex`
- Create: `server-elixir/lib/fbi/uploads/paths.ex`
- Create: `server-elixir/test/fbi/uploads/fs_test.exs`

- [ ] **Step 1: FS module**

```elixir
defmodule FBI.Uploads.FS do
  @moduledoc """
  Filename-safety helpers for upload routes.

  Rules match TS `src/server/api/uploads.ts`:
    - No `/`, `\\`, or NULL bytes
    - Not `.`, `..`, or starts with `..`
    - Max 255 bytes (UTF-8)
    - Deduplicate conflicts with ` (1)`, ` (2)`, ... up to 9999
  """

  @max_bytes 255

  @spec sanitize_filename(any()) :: {:ok, String.t()} | {:error, :invalid}
  def sanitize_filename(s) when is_binary(s) do
    trimmed = String.trim(s)

    cond do
      trimmed == "" -> {:error, :invalid}
      trimmed == "." -> {:error, :invalid}
      trimmed == ".." -> {:error, :invalid}
      String.starts_with?(trimmed, "..") -> {:error, :invalid}
      Regex.match?(~r<[/\\\x00]>, trimmed) -> {:error, :invalid}
      byte_size(trimmed) > @max_bytes -> {:error, :invalid}
      true -> {:ok, trimmed}
    end
  end

  def sanitize_filename(_), do: {:error, :invalid}

  @spec resolve_filename(Path.t(), String.t()) :: {:ok, String.t()} | {:error, :collision_overflow}
  def resolve_filename(dir, filename) do
    path = Path.join(dir, filename)

    if File.exists?(path) do
      {stem, ext} = split_ext(filename)
      try_variants(dir, stem, ext, 1)
    else
      {:ok, filename}
    end
  end

  defp try_variants(_dir, _stem, _ext, n) when n > 9999, do: {:error, :collision_overflow}

  defp try_variants(dir, stem, ext, n) do
    candidate = "#{stem} (#{n})#{ext}"

    if File.exists?(Path.join(dir, candidate)) do
      try_variants(dir, stem, ext, n + 1)
    else
      {:ok, candidate}
    end
  end

  defp split_ext(filename) do
    ext = Path.extname(filename)
    stem = Path.basename(filename, ext)
    {stem, ext}
  end

  @spec directory_bytes(Path.t()) :: non_neg_integer()
  def directory_bytes(dir) do
    case File.ls(dir) do
      {:ok, entries} ->
        entries
        |> Enum.reduce(0, fn name, acc ->
          case File.stat(Path.join(dir, name)) do
            {:ok, %File.Stat{type: :regular, size: sz}} -> acc + sz
            _ -> acc
          end
        end)

      {:error, _} ->
        0
    end
  end

  @spec draft_token() :: String.t()
  def draft_token do
    :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower)
  end

  @spec valid_draft_token?(String.t()) :: boolean()
  def valid_draft_token?(s) when is_binary(s), do: Regex.match?(~r/^[0-9a-f]{32}$/, s)
  def valid_draft_token?(_), do: false
end
```

- [ ] **Step 2: Paths module**

```elixir
defmodule FBI.Uploads.Paths do
  @moduledoc "Path construction for draft and run uploads, using app-env roots."

  def draft_dir(token) when is_binary(token) do
    Path.join(Application.fetch_env!(:fbi, :draft_uploads_dir), token)
  end

  def run_uploads_dir(run_id) when is_integer(run_id) do
    Application.fetch_env!(:fbi, :runs_dir)
    |> Path.join(Integer.to_string(run_id))
    |> Path.join("uploads")
  end
end
```

- [ ] **Step 3: Tests, commit**

Test all sanitization cases, resolve_filename with 0/1/many collisions, directory_bytes with mixed files/dirs, draft_token format, valid_draft_token?.

```bash
cd /workspace/server-elixir && mix test test/fbi/uploads/fs_test.exs
git add server-elixir/lib/fbi/uploads/ server-elixir/test/fbi/uploads/
git commit -m "feat(server-elixir): add upload filesystem helpers"
```

---

## Task 21: `FBIWeb.UploadsController` — GET/POST/DELETE `/api/runs/:id/uploads`

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/uploads_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/uploads_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`
- Modify: `server-elixir/lib/fbi_web/endpoint.ex` (raise Plug.Parsers length to 100 MB)

- [ ] **Step 1: Endpoint config**

In `server-elixir/lib/fbi_web/endpoint.ex`, in the `Plug.Parsers` call, set `length: 100 * 1024 * 1024`:

```elixir
  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    length: 100 * 1024 * 1024,
    json_decoder: Phoenix.json_library(),
    body_reader: {FBIWeb.RawBodyReader, :read_body, []}
```

- [ ] **Step 2: Controller**

```elixir
defmodule FBIWeb.UploadsController do
  @moduledoc """
  Run uploads: list, add, delete.

  State rules (from TS):
  - Add/delete: run must be in state `running` or `waiting` → 409 otherwise with
    `{ error: "wrong_state" }`.
  - Quota: 1 GB cumulative per run.
  - Filename: validated + deduplicated via `FBI.Uploads.FS`.
  """

  use FBIWeb, :controller

  alias FBI.Runs.Queries, as: Runs
  alias FBI.Uploads.{FS, Paths}

  @quota_bytes 1024 * 1024 * 1024

  def index(conn, %{"id" => id_str}) do
    case parse_id(id_str) do
      :error ->
        conn |> put_status(404) |> json(%{error: "not_found"})

      {:ok, id} ->
        case Runs.get(id) do
          :not_found ->
            conn |> put_status(404) |> json(%{error: "not_found"})

          {:ok, _run} ->
            dir = Paths.run_uploads_dir(id)
            files = list_files(dir)
            json(conn, %{files: files})
        end
    end
  end

  def create(conn, %{"id" => id_str} = params) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         true <- run.state in ["running", "waiting"] or {:error, :wrong_state},
         %Plug.Upload{path: src, filename: raw_name} <- Map.get(params, "file"),
         {:ok, sanitized} <- FS.sanitize_filename(raw_name),
         dir <- ensure_dir(Paths.run_uploads_dir(id)),
         :ok <- check_quota(dir),
         {:ok, resolved} <- FS.resolve_filename(dir, sanitized),
         :ok <- copy_file(src, Path.join(dir, resolved)) do
      size = File.stat!(Path.join(dir, resolved)).size
      now = System.system_time(:millisecond)

      append_notice(run.log_path, resolved, size)

      json(conn, %{filename: resolved, size: size, uploaded_at: now})
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not_found"})
      {:error, :wrong_state} -> conn |> put_status(409) |> json(%{error: "wrong_state"})
      {:error, :invalid} -> conn |> put_status(400) |> json(%{error: "invalid_filename"})
      {:error, :quota_exceeded} -> conn |> put_status(413) |> json(%{error: "run_quota_exceeded"})
      {:error, :collision_overflow} -> conn |> put_status(500) |> json(%{error: "collision_overflow"})
      _ -> conn |> put_status(500) |> json(%{error: "io_error"})
    end
  end

  def delete(conn, %{"id" => id_str, "filename" => raw_name}) do
    with {:ok, id} <- parse_id(id_str),
         {:ok, run} <- Runs.get(id),
         true <- run.state in ["running", "waiting"] or {:error, :wrong_state},
         {:ok, sanitized} <- FS.sanitize_filename(raw_name),
         path <- Path.join(Paths.run_uploads_dir(id), sanitized),
         true <- File.exists?(path) or {:error, :not_found},
         :ok <- File.rm(path) do
      send_resp(conn, 204, "")
    else
      :not_found -> conn |> put_status(404) |> json(%{error: "not_found"})
      {:error, :wrong_state} -> conn |> put_status(409) |> json(%{error: "wrong_state"})
      {:error, :invalid} -> conn |> put_status(400) |> json(%{error: "invalid_filename"})
      {:error, :not_found} -> conn |> put_status(404) |> json(%{error: "not_found"})
      _ -> conn |> put_status(500) |> json(%{error: "io_error"})
    end
  end

  defp list_files(dir) do
    case File.ls(dir) do
      {:ok, entries} ->
        entries
        |> Enum.reject(&String.ends_with?(&1, ".part"))
        |> Enum.map(fn name ->
          path = Path.join(dir, name)

          case File.stat(path) do
            {:ok, %File.Stat{type: :regular, size: sz, mtime: mt}} ->
              %{filename: name, size: sz, uploaded_at: erl_to_ms(mt)}

            _ ->
              nil
          end
        end)
        |> Enum.reject(&is_nil/1)

      _ ->
        []
    end
  end

  defp ensure_dir(dir) do
    File.mkdir_p!(dir)
    dir
  end

  defp check_quota(dir) do
    if FBI.Uploads.FS.directory_bytes(dir) >= @quota_bytes do
      {:error, :quota_exceeded}
    else
      :ok
    end
  end

  defp copy_file(src, dest) do
    case File.cp(src, dest) do
      :ok -> :ok
      err -> err
    end
  end

  defp append_notice(log_path, filename, size) when is_binary(log_path) do
    File.write(log_path, "[fbi] user uploaded #{filename} (#{human_size(size)})\n", [:append])
  end

  defp append_notice(_, _, _), do: :ok

  defp human_size(n) when n >= 1024 * 1024, do: "#{Float.round(n / 1024 / 1024, 2)} MB"
  defp human_size(n) when n >= 1024, do: "#{Float.round(n / 1024, 2)} KB"
  defp human_size(n), do: "#{n} B"

  defp erl_to_ms({{y, m, d}, {h, mi, s}}) do
    {:ok, dt} = NaiveDateTime.new(y, m, d, h, mi, s)
    dt |> DateTime.from_naive!("Etc/UTC") |> DateTime.to_unix(:millisecond)
  end

  defp parse_id(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> :error
    end
  end
end
```

- [ ] **Step 3: Routes, tests, commit**

Routes:

```elixir
    get "/runs/:id/uploads", UploadsController, :index
    post "/runs/:id/uploads", UploadsController, :create
    delete "/runs/:id/uploads/:filename", UploadsController, :delete
```

Tests: use `%Plug.Upload{path: temp_path, filename: "foo.txt"}` directly in the controller test setup, set `:runs_dir` app env to a tempdir, exercise every branch.

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/uploads_controller_test.exs
git add server-elixir/lib/fbi_web/controllers/uploads_controller.ex \
        server-elixir/test/fbi_web/controllers/uploads_controller_test.exs \
        server-elixir/lib/fbi_web/router.ex \
        server-elixir/lib/fbi_web/endpoint.ex
git commit -m "feat(server-elixir): port /api/runs/:id/uploads routes"
```

---

## Task 22: `FBIWeb.DraftUploadsController`

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/draft_uploads_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/draft_uploads_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

Very similar to Task 21 but without a run_id and with optional client-supplied `draft_token` query param.

- [ ] **Step 1: Controller**

```elixir
defmodule FBIWeb.DraftUploadsController do
  @moduledoc """
  Draft upload endpoints used before a run is created. Files live in
  `{draft_uploads_dir}/{token}/` and are promoted to `{runs_dir}/{id}/uploads/`
  by the orchestrator when a run is created with `draft_token`.

  The hourly GC in `FBI.Housekeeping.DraftUploadsGc` deletes aged tokens.
  """

  use FBIWeb, :controller

  alias FBI.Uploads.{FS, Paths}

  @quota_bytes 1024 * 1024 * 1024

  def create(conn, params) do
    token =
      case conn.query_params["draft_token"] do
        nil -> FS.draft_token()
        t -> if FS.valid_draft_token?(t), do: t, else: :invalid
      end

    with :not_invalid <- (if token == :invalid, do: :invalid, else: :not_invalid),
         %Plug.Upload{path: src, filename: raw_name} <- Map.get(params, "file"),
         {:ok, sanitized} <- FS.sanitize_filename(raw_name),
         dir <- ensure_dir(Paths.draft_dir(token)),
         :ok <- check_quota(dir),
         {:ok, resolved} <- FS.resolve_filename(dir, sanitized),
         :ok <- File.cp(src, Path.join(dir, resolved)) do
      size = File.stat!(Path.join(dir, resolved)).size
      now = System.system_time(:millisecond)
      json(conn, %{draft_token: token, filename: resolved, size: size, uploaded_at: now})
    else
      :invalid -> conn |> put_status(400) |> json(%{error: "invalid_token"})
      {:error, :invalid} -> conn |> put_status(400) |> json(%{error: "invalid_filename"})
      {:error, :quota_exceeded} -> conn |> put_status(413) |> json(%{error: "run_quota_exceeded"})
      {:error, :collision_overflow} -> conn |> put_status(500) |> json(%{error: "collision_overflow"})
      _ -> conn |> put_status(500) |> json(%{error: "io_error"})
    end
  end

  def delete(conn, %{"token" => token, "filename" => raw_name}) do
    with true <- FS.valid_draft_token?(token) or {:error, :invalid_token},
         {:ok, sanitized} <- FS.sanitize_filename(raw_name),
         path <- Path.join(Paths.draft_dir(token), sanitized),
         true <- File.exists?(path) or {:error, :not_found},
         :ok <- File.rm(path) do
      send_resp(conn, 204, "")
    else
      {:error, :invalid_token} -> conn |> put_status(400) |> json(%{error: "invalid_token"})
      {:error, :invalid} -> conn |> put_status(400) |> json(%{error: "invalid_filename"})
      {:error, :not_found} -> conn |> put_status(404) |> json(%{error: "not_found"})
      _ -> conn |> put_status(500) |> json(%{error: "io_error"})
    end
  end

  defp ensure_dir(dir) do
    File.mkdir_p!(dir)
    dir
  end

  defp check_quota(dir) do
    if FBI.Uploads.FS.directory_bytes(dir) >= @quota_bytes do
      {:error, :quota_exceeded}
    else
      :ok
    end
  end
end
```

- [ ] **Step 2: Routes, tests, commit**

```elixir
    post "/draft-uploads", DraftUploadsController, :create
    delete "/draft-uploads/:token/:filename", DraftUploadsController, :delete
```

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/draft_uploads_controller_test.exs
git add server-elixir/lib/fbi_web/controllers/draft_uploads_controller.ex \
        server-elixir/test/fbi_web/controllers/draft_uploads_controller_test.exs \
        server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port /api/draft-uploads routes"
```

---

## Task 23: `FBI.Housekeeping.DraftUploadsGc` GenServer

**Files:**
- Create: `server-elixir/lib/fbi/housekeeping/draft_uploads_gc.ex`
- Create: `server-elixir/test/fbi/housekeeping/draft_uploads_gc_test.exs`
- Modify: `server-elixir/lib/fbi/application.ex`

- [ ] **Step 1: GenServer**

```elixir
defmodule FBI.Housekeeping.DraftUploadsGc do
  @moduledoc """
  Sweeps aged draft-upload directories hourly. Age threshold: 24 hours.
  On first start, also cleans orphan `.part` files in run uploads subtrees.

  GenServer: runs the sweep on an interval, holds only a `:refs` tuple.
  """

  use GenServer
  require Logger

  @default_interval_ms 60 * 60 * 1000
  @ttl_ms 24 * 60 * 60 * 1000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    draft_dir = Application.get_env(:fbi, :draft_uploads_dir)
    runs_dir = Application.get_env(:fbi, :runs_dir)

    if draft_dir do
      sweep_draft_uploads(draft_dir)
      if runs_dir, do: sweep_part_files(runs_dir)
    end

    ref = if draft_dir, do: schedule_next(interval), else: nil
    {:ok, %{ref: ref, interval: interval, draft_dir: draft_dir, runs_dir: runs_dir}}
  end

  @impl true
  def handle_info(:sweep, state) do
    if state.draft_dir, do: sweep_draft_uploads(state.draft_dir)
    {:noreply, %{state | ref: schedule_next(state.interval)}}
  end

  defp schedule_next(ms), do: Process.send_after(self(), :sweep, ms)

  @doc false
  def sweep_draft_uploads(draft_dir) do
    now = System.system_time(:millisecond)

    case File.ls(draft_dir) do
      {:ok, entries} ->
        Enum.each(entries, fn name ->
          path = Path.join(draft_dir, name)

          case File.stat(path, time: :posix) do
            {:ok, %File.Stat{type: :directory, mtime: mt}} ->
              mtime_ms = mt * 1000

              if now - mtime_ms >= @ttl_ms do
                File.rm_rf(path)
              end

            _ ->
              :ok
          end
        end)

      {:error, _} ->
        :ok
    end
  end

  @doc false
  def sweep_part_files(runs_dir) do
    case File.ls(runs_dir) do
      {:ok, entries} ->
        Enum.each(entries, fn name ->
          uploads = Path.join([runs_dir, name, "uploads"])

          case File.ls(uploads) do
            {:ok, files} ->
              Enum.each(files, fn f ->
                if String.ends_with?(f, ".part"), do: File.rm(Path.join(uploads, f))
              end)

            _ ->
              :ok
          end
        end)

      _ ->
        :ok
    end
  end
end
```

- [ ] **Step 2: Wire into Application tree**

Add to `lib/fbi/application.ex` after `FBI.Github.StatusCache`:

```elixir
FBI.Housekeeping.DraftUploadsGc,
```

- [ ] **Step 3: Tests**

Test the pure helpers (`sweep_draft_uploads/1`, `sweep_part_files/1`) against tempdirs with a mix of aged/young dirs and .part files.

- [ ] **Step 4: Commit**

```bash
cd /workspace/server-elixir && mix test test/fbi/housekeeping/draft_uploads_gc_test.exs
git add server-elixir/lib/fbi/housekeeping/ server-elixir/test/fbi/housekeeping/ \
        server-elixir/lib/fbi/application.ex
git commit -m "feat(server-elixir): add draft uploads GC GenServer"
```

---

## Task 24: Health controller

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/health_controller.ex`
- Modify: `server-elixir/lib/fbi_web/router.ex`
- Create: `server-elixir/test/fbi_web/controllers/health_controller_test.exs`

Trivial — just returns `{ok: true}`. Intentionally not part of the catch-all per spec's "any remaining routes" clause.

- [ ] **Step 1: Controller + route + test (combined)**

```elixir
defmodule FBIWeb.HealthController do
  @moduledoc "GET /api/health — fixed `{\"ok\": true}` response."
  use FBIWeb, :controller

  def show(conn, _params), do: json(conn, %{ok: true})
end
```

Route:

```elixir
    get "/health", HealthController, :show
```

Test:

```elixir
defmodule FBIWeb.HealthControllerTest do
  use FBIWeb.ConnCase, async: true

  test "GET /api/health returns {ok: true}", %{conn: conn} do
    assert conn |> get("/api/health") |> json_response(200) == %{"ok" => true}
  end
end
```

- [ ] **Step 2: Commit**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/health_controller_test.exs
git add server-elixir/lib/fbi_web/controllers/health_controller.ex \
        server-elixir/test/fbi_web/controllers/health_controller_test.exs \
        server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port GET /api/health"
```

---

## Task 25: Runtime config for uploads + secrets + docker

**Files:**
- Modify: `server-elixir/config/config.exs`
- Modify: `server-elixir/config/runtime.exs`

- [ ] **Step 1: `config.exs`**

Append near the other `config :fbi, ...` lines:

```elixir
# Filesystem + secrets + docker for Phases 3–8.  Overridden per-environment
# in runtime.exs.  Defaults suit local dev / mix test.
config :fbi, runs_dir: Path.join(System.tmp_dir!(), "fbi-runs")
config :fbi, draft_uploads_dir: Path.join(System.tmp_dir!(), "fbi-draft-uploads")
config :fbi, secrets_key_path: Path.join(System.tmp_dir!(), "fbi-secrets.key")
config :fbi, docker_socket_path: "/var/run/docker.sock"
```

- [ ] **Step 2: `runtime.exs`**

Inside the `if config_env() == :prod do` block, append:

```elixir
  config :fbi, runs_dir: System.get_env("RUNS_DIR", "/var/lib/agent-manager/runs")
  config :fbi, draft_uploads_dir: System.get_env("DRAFT_UPLOADS_DIR", "/var/lib/agent-manager/draft-uploads")
  config :fbi, secrets_key_path: System.get_env("SECRETS_KEY_FILE", "/etc/agent-manager/secrets.key")
  config :fbi, docker_socket_path: System.get_env("DOCKER_SOCKET", "/var/run/docker.sock")
```

- [ ] **Step 3: Commit**

```bash
git add server-elixir/config/config.exs server-elixir/config/runtime.exs
git commit -m "config(server-elixir): add runs/draft/secrets/docker runtime config keys"
```

---

## Task 26: Contract fidelity pins

**Files:**
- Create: `server-elixir/test/fidelity/projects_fidelity_test.exs`
- Create: `server-elixir/test/fidelity/fixtures/project_snapshot.json`
- Create: `server-elixir/test/fidelity/fixtures/projects_list_snapshot.json`
- Create: `server-elixir/test/fidelity/runs_fidelity_test.exs`
- Create: `server-elixir/test/fidelity/fixtures/run_snapshot.json`
- Create: `server-elixir/test/fidelity/mcp_fidelity_test.exs`
- Create: `server-elixir/test/fidelity/fixtures/mcp_server_snapshot.json`

Follow the exact structure of Phase 2's `settings_fidelity_test.exs`. Each fidelity test seeds one row, hits the relevant endpoint, and asserts `assert_same_shape!/2` against a committed fixture.

Provide these fixtures (matching the field list of each decode function exactly):

`project_snapshot.json`:
```json
{
  "id": 1,
  "name": "",
  "repo_url": "",
  "default_branch": "",
  "devcontainer_override_json": null,
  "instructions": null,
  "git_author_name": null,
  "git_author_email": null,
  "marketplaces": [],
  "plugins": [],
  "mem_mb": null,
  "cpus": null,
  "pids_limit": null,
  "created_at": 0,
  "updated_at": 0
}
```

`run_snapshot.json` — every column from the Runs schema, with zero/null/empty primitives.

`mcp_server_snapshot.json`:
```json
{
  "id": 1,
  "project_id": null,
  "name": "",
  "type": "stdio",
  "command": null,
  "args": [],
  "url": null,
  "env": {},
  "created_at": 0
}
```

- [ ] **Step 1: Create fixtures + tests, commit**

```bash
cd /workspace/server-elixir && mix test test/fidelity/
git add server-elixir/test/fidelity/
git commit -m "test(server-elixir): add fidelity pins for projects/runs/mcp"
```

---

## Task 27: Full regression + release smoke + Playwright smoke

- [ ] **Step 1: Full Elixir suite**

```bash
cd /workspace/server-elixir && mix test
```

- [ ] **Step 2: Warnings + format**

```bash
cd /workspace/server-elixir && mix compile --warnings-as-errors && mix format --check-formatted
```

If format complains, run `mix format` and make a single `style(server-elixir): mix format` commit.

- [ ] **Step 3: TS vitest (regression)**

```bash
cd /workspace && npm test 2>&1 | tail -30
```

Docker-gated failures are acceptable (same pre-existing set as Phase 2).

- [ ] **Step 4: Release smoke**

```bash
cd /workspace/server-elixir && MIX_ENV=prod mix release --overwrite
```

Start the release with env vars pointing at tempdirs for `RUNS_DIR`, `DRAFT_UPLOADS_DIR`, `SECRETS_KEY_FILE` (generate a 32-byte keyfile), and `PROXY_TARGET=http://127.0.0.1:9999` (unreachable; proxy-only routes will get 502 which is expected).

Hit every new route via curl; confirm the expected status code:

```bash
curl -sSI http://127.0.0.1:4101/api/health              # 200
curl -sS  http://127.0.0.1:4101/api/projects            # 200 []
curl -sS  http://127.0.0.1:4101/api/mcp-servers         # 200 []
curl -sS  http://127.0.0.1:4101/api/runs                # 200 []
curl -sSI http://127.0.0.1:4101/api/runs/1              # 404
curl -sS  -X POST -H 'Content-Type: application/json' \
  -d '{"name":"smoke","repo_url":"git@github.com:a/b.git"}' \
  http://127.0.0.1:4101/api/projects                    # 201
curl -sS  http://127.0.0.1:4101/api/projects/1/runs     # 200 []
curl -sS  http://127.0.0.1:4101/api/projects/1/prompts/recent  # 200 []
curl -sS  http://127.0.0.1:4101/api/projects/1/mcp-servers     # 200 []
```

- [ ] **Step 5: Playwright UI smoke**

With the release running on :4101 and a local TS server on :3001 providing orchestrator-dependent routes (optional — if unavailable, visit the pages that don't need run creation):

Using the Playwright MCP server's `mcp__playwright__browser_navigate` and `mcp__playwright__browser_snapshot`, navigate to `http://localhost:4101` and confirm the `/settings` and `/projects` pages load without errors in the browser console.

If TS is unavailable, at least verify that static HTML loads and no JS errors relating to ported routes appear in the Network tab.

- [ ] **Step 6: Final commit (only if a format commit was needed; otherwise no-op)**

---

## Self-review

**Spec coverage** (against the Phase 3/4/5/6/8 rows of the spec):

| Spec requirement | Task |
|---|---|
| MCP CRUD global | 11, 12 |
| MCP CRUD project-scoped | 11, 12 |
| Projects CRUD | 5, 6, 7 |
| Secrets PUT/DELETE/GET | 9, 10 |
| Recent prompts | 6, 7, 14 |
| Runs read (list/get/project/siblings) | 13, 14, 15 |
| Transcript | 16 |
| Files (read, reduced-live-fallback) | 17, 19 |
| File-diff | **deferred** to Phase 7 (proxied) |
| GitHub read | 17, 18 |
| Draft uploads + run uploads | 20, 21, 22 |
| Draft uploads GC loop | 23 |
| PATCH /api/runs/:id (title) | 15 |
| DELETE /api/runs/:id | 15 (Docker kill for active runs) |
| POST /api/runs/:id/github/pr | 18 |
| POST /api/runs/:id/github/merge | 18 (no conflict-prompt injection) |
| AES-GCM secrets compat with fixture | 8 |
| Contract fidelity pins | 26 |
| /api/health | 24 |

**Intentional deviations (callouts for the PR description):**
- `GET /api/runs/:id/file-diff` stays proxied to TS.
- `POST /api/runs/:id/github/merge` returns 409 on conflict without the orchestrator stdin-injection.
- `GET /api/runs/:id/files` reports `live: false` always; no live-container path during the crossover.

**Placeholder scan:** no TBD / TODO / "figure out later" in any task body.

**Type consistency:**
- `FBI.Projects.Queries.list_recent_prompts/2` return shape is used in Task 7 controller.
- `FBI.Runs.Queries.latest_for_project/1` return shape is used in Task 7 controller.
- `FBI.Github.Client.pr_for_branch/2` return shape is used in Task 18 controller.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-24-elixir-rewrite-phases-3-to-8.md`. Execution will follow `superpowers:subagent-driven-development` with per-task two-stage review.**
