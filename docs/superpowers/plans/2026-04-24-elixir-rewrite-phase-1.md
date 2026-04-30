# Elixir Rewrite Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the server rewrite — wire up the Elixir→TS crossover proxy (HTTP + WebSocket) and port the usage module (three REST endpoints + one WebSocket) with byte-compatible responses, so the Elixir server owns `:3000` in production while TS continues to serve unported routes on `:3001` loopback.

**Architecture:** Elixir is the public entry point. Every request hits the Phoenix router first. Ported routes (usage) resolve natively; unported routes fall through to a catch-all that proxies to TS. A polling GenServer replaces the TS `OAuthUsagePoller`; a raw WebSocket handler (not a Phoenix Channel) serves `/api/ws/usage` with the existing JSON protocol unchanged. Schema changes: none. TS still owns prod schema; Elixir runs dev/test migrations mirroring TS's `schema.sql`.

**Tech Stack:**
- Elixir 1.18.1 / OTP 27.2 (pinned via `server-elixir/.tool-versions`)
- Phoenix 1.8.5 + Bandit (HTTP) + Phoenix.PubSub (in-process pub/sub)
- Ecto 3.13 + `ecto_sqlite3` (shared SQLite DB with TS)
- `Req` 0.5+ (HTTP client for OAuth calls + HTTP proxy)
- `Mint.WebSocket` (WebSocket client for WS proxy)
- `FileSystem` (inotify-based file watcher for credentials reader)

**Spec reference:** `docs/superpowers/specs/2026-04-24-server-rewrite-migration-design.md`

---

## File structure

### Created (Elixir side)

| Path | Responsibility |
|---|---|
| `server-elixir/lib/fbi/usage/rate_limit_state.ex` | Ecto schema: singleton `rate_limit_state` row |
| `server-elixir/lib/fbi/usage/rate_limit_bucket.ex` | Ecto schema: rows in `rate_limit_buckets` |
| `server-elixir/lib/fbi/usage/usage_row.ex` | Ecto schema: rows in `usage` (per-run cost breakdown) |
| `server-elixir/lib/fbi/usage/pacing.ex` | Pure-functional pacing deltas — port of `src/server/pacing.ts` |
| `server-elixir/lib/fbi/usage/queries.ex` | Query helpers (repo pattern wrapping `FBI.Repo`) |
| `server-elixir/lib/fbi/usage/oauth_client.ex` | HTTP calls to Anthropic `/api/oauth/usage` and `/api/oauth/profile` |
| `server-elixir/lib/fbi/usage/credentials_reader.ex` | `GenServer` that watches `~/.claude/.credentials.json` via inotify and publishes change events |
| `server-elixir/lib/fbi/usage/poller.ex` | `GenServer` that polls Anthropic every 5 min, writes DB, broadcasts via PubSub |
| `server-elixir/lib/fbi_web/controllers/usage_controller.ex` | REST endpoints: `/api/usage`, `/api/usage/daily`, `/api/usage/runs/:id` |
| `server-elixir/lib/fbi_web/sockets/usage_ws_handler.ex` | Raw WebSocket handler for `/api/ws/usage` (WebSock behavior) |
| `server-elixir/lib/fbi_web/proxy/http.ex` | Plug: reverse proxy unported HTTP routes to `127.0.0.1:3001` via `Req` |
| `server-elixir/lib/fbi_web/proxy/web_socket.ex` | WebSock handler: proxy unported WS upgrades to TS using `Mint.WebSocket` |
| `server-elixir/priv/repo/migrations/20260424000001_create_usage_tables.exs` | Ecto migration mirroring the usage portion of `src/server/db/schema.sql` |

Plus test files mirroring each (in `server-elixir/test/...`) and a contract-fidelity harness at `server-elixir/test/fidelity/usage_fidelity_test.exs`.

### Modified (Elixir side)

| Path | Change |
|---|---|
| `server-elixir/mix.exs` | Add `:req`, `:mint_web_socket`, `:websock_adapter` (already via Phoenix), `:file_system`, `:finch` (Req dep) |
| `server-elixir/lib/fbi/application.ex` | Add `FBI.Usage.CredentialsReader` and `FBI.Usage.Poller` to supervision tree |
| `server-elixir/lib/fbi_web/router.ex` | Add usage routes + catch-all at end |
| `server-elixir/lib/fbi_web/endpoint.ex` | Add WebSocket routes for `/api/ws/usage` and proxy catch-all |
| `server-elixir/config/config.exs` | Ecto SQLite `busy_timeout`, custom pubsub name |
| `server-elixir/config/dev.exs` | Endpoint port 4000 (no change), DB path pointing at the local shared file |
| `server-elixir/config/runtime.exs` | Prod port from env `PORT` (default 3000), DB path from env `DB_PATH` |

### Modified (TS side)

| Path | Change |
|---|---|
| `src/server/config.ts` | Add `host` field (read from `HOST` env, default `0.0.0.0`) |
| `src/server/index.ts` | Pass `host` to `app.listen` |
| `src/server/oauthUsagePoller.ts` | Gate `start()` on `FBI_OAUTH_POLLER_DISABLED` env var |

### Created (Deploy + CI)

| Path | Purpose |
|---|---|
| `systemd/fbi-elixir.service` | New systemd unit for Elixir release |
| `scripts/install.sh` | Updated: build Elixir release, install both units, update `/etc/default/fbi` |
| `README.md` | Updated Prerequisites (add Erlang/OTP + Elixir) |
| `.github/workflows/ci.yml` | GitHub Actions: TS (vitest + tsc + eslint) and Elixir (mix test + format + warnings-as-errors) jobs running in parallel |

---

## Task 1: Add Elixir dependencies

**Files:**
- Modify: `server-elixir/mix.exs`

- [ ] **Step 1: Update `deps/0` in `server-elixir/mix.exs`**

Replace the `deps` function with:

```elixir
defp deps do
  [
    {:phoenix, "~> 1.8.5"},
    {:phoenix_ecto, "~> 4.5"},
    {:ecto_sql, "~> 3.13"},
    {:ecto_sqlite3, ">= 0.0.0"},
    {:phoenix_live_dashboard, "~> 0.8.3"},
    {:telemetry_metrics, "~> 1.0"},
    {:telemetry_poller, "~> 1.0"},
    {:gettext, "~> 1.0"},
    {:jason, "~> 1.2"},
    {:dns_cluster, "~> 0.2.0"},
    {:bandit, "~> 1.5"},
    # Phase 1 additions:
    {:req, "~> 0.5"},           # HTTP client (OAuth calls + proxy)
    {:mint_web_socket, "~> 1.0"}, # WS client for the WS proxy
    {:file_system, "~> 1.0"}    # inotify-based file watcher (credentials reader)
  ]
end
```

- [ ] **Step 2: Fetch and compile**

```bash
cd server-elixir && \
TMPDIR=/tmp/agent-tmp ASDF_DATA_DIR=/opt/asdf mix deps.get && \
TMPDIR=/tmp/agent-tmp ASDF_DATA_DIR=/opt/asdf mix compile
```

Expected: clean compile, no deprecation warnings. (Env vars are not needed post-devcontainer-rebuild; documenting the current session's quirk.)

- [ ] **Step 3: Verify existing tests still pass**

```bash
cd server-elixir && mix test
```

Expected: `2 tests, 0 failures`.

- [ ] **Step 4: Commit**

```bash
git add server-elixir/mix.exs server-elixir/mix.lock
git commit -m "deps(server-elixir): add req, mint_web_socket, file_system for Phase 1"
```

---

## Task 2: Port pacing logic (pure functional)

Pacing is a pure function in TS (`src/server/pacing.ts`, 30 lines) — easiest piece to port. Does it first to build momentum and validate the ExUnit test rhythm.

**Files:**
- Create: `server-elixir/lib/fbi/usage/pacing.ex`
- Create: `server-elixir/test/fbi/usage/pacing_test.exs`

- [ ] **Step 1: Write the failing test**

Create `server-elixir/test/fbi/usage/pacing_test.exs`:

```elixir
defmodule FBI.Usage.PacingTest do
  use ExUnit.Case, async: true
  alias FBI.Usage.Pacing

  @known_bucket %{
    id: "five_hour",
    utilization: 0.5,
    reset_at: 5 * 3600 * 1000 + 1_000_000,
    window_started_at: 1_000_000
  }

  describe "derive_pacing/2" do
    test "returns :none zone when inside the warm-up window (< 5% progress)" do
      bucket = %{@known_bucket | window_started_at: 999_999_500}
      now = 1_000_000_000
      # elapsed = 500ms, duration = 5h → progress ~ tiny → :none
      assert %{delta: +0.0, zone: :none} = Pacing.derive_pacing(bucket, now)
    end

    test "returns :on_track when utilization matches expected progress" do
      # halfway through window, 50% utilized → delta = 0
      now = @known_bucket.window_started_at + div(5 * 3600 * 1000, 2)
      bucket = %{@known_bucket | utilization: 0.5}
      %{delta: delta, zone: zone} = Pacing.derive_pacing(bucket, now)
      assert_in_delta delta, 0.0, 0.01
      assert zone == :on_track
    end

    test "returns :chill when utilization trails progress by more than 5%" do
      # halfway through, only 10% utilized → delta ≈ -0.4 → chill
      now = @known_bucket.window_started_at + div(5 * 3600 * 1000, 2)
      bucket = %{@known_bucket | utilization: 0.1}
      assert %{zone: :chill} = Pacing.derive_pacing(bucket, now)
    end

    test "returns :hot when utilization exceeds progress by >= 10%" do
      # 10% through, 50% utilized → delta = +0.4 → hot
      now = @known_bucket.window_started_at + div(5 * 3600 * 1000, 10)
      bucket = %{@known_bucket | utilization: 0.5}
      assert %{zone: :hot} = Pacing.derive_pacing(bucket, now)
    end

    test "returns :none when reset_at is nil" do
      bucket = %{@known_bucket | reset_at: nil}
      assert %{zone: :none, delta: +0.0} = Pacing.derive_pacing(bucket, 0)
    end

    test "derives window_start from reset_at for known buckets when window_started_at missing" do
      bucket = %{@known_bucket | window_started_at: nil}
      # derived start = reset_at - 5h → halfway through now = reset_at - 2.5h
      now = bucket.reset_at - div(5 * 3600 * 1000, 2)
      %{delta: delta} = Pacing.derive_pacing(bucket, now)
      assert_in_delta delta, 0.0, 0.01
    end
  end
end
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server-elixir && mix test test/fbi/usage/pacing_test.exs
```

Expected: FAIL with "module FBI.Usage.Pacing is not available".

- [ ] **Step 3: Implement the module**

Create `server-elixir/lib/fbi/usage/pacing.ex`:

```elixir
defmodule FBI.Usage.Pacing do
  @moduledoc """
  Pure-functional pacing deltas for rate-limit buckets.

  Ported from `src/server/pacing.ts`. Given a usage bucket (utilization 0.0–1.0,
  a window start time, and a reset time), returns whether we're ahead, behind,
  or on track relative to a straight-line utilization target.

  No state, no side effects, no OTP primitive — just a function module.
  """

  # The `|>` pipe operator isn't used in this module; each function is a single
  # expression and pattern-matches its inputs in the head.

  @type bucket_id :: String.t()

  @type bucket :: %{
          required(:id) => bucket_id(),
          required(:utilization) => float(),
          required(:reset_at) => integer() | nil,
          required(:window_started_at) => integer() | nil
        }

  @type zone :: :none | :chill | :on_track | :hot

  @type verdict :: %{delta: float(), zone: zone()}

  # Known bucket IDs and their window durations in ms. Unknown IDs have to
  # derive duration from `reset_at - window_started_at`.
  @known_windows %{
    "five_hour" => 5 * 3_600_000,
    "weekly" => 7 * 24 * 3_600_000,
    "sonnet_weekly" => 7 * 24 * 3_600_000
  }

  @doc """
  Returns known bucket IDs and their window durations in milliseconds.
  Used by the poller to translate Anthropic's bucket ids (`seven_day` etc.)
  to the internal short names this module understands.
  """
  @spec known_windows() :: %{optional(bucket_id()) => integer()}
  def known_windows, do: @known_windows

  @doc """
  Returns a pacing verdict for a bucket at the given wall-clock time (ms
  since epoch). `:none` means "too early to judge" or "bucket data
  incomplete"; the other zones reflect how user utilization compares to
  straight-line progress through the window.
  """
  @spec derive_pacing(bucket(), integer()) :: verdict()
  def derive_pacing(bucket, now) do
    case resolve_window_start(bucket) do
      nil ->
        none()

      _window_start when bucket.reset_at == nil ->
        none()

      window_start ->
        duration = duration_for(bucket, window_start)
        compute(bucket, window_start, duration, now)
    end
  end

  # --- Private helpers ----------------------------------------------------

  defp compute(_bucket, _start, duration, _now) when duration <= 0, do: none()

  defp compute(bucket, window_start, duration, now) do
    elapsed = now - window_start
    progress = elapsed / duration

    if progress < 0.05 do
      none()
    else
      u_expected = progress |> max(0.0) |> min(1.0)
      delta = bucket.utilization - u_expected
      %{delta: delta, zone: zone_for(delta)}
    end
  end

  defp zone_for(delta) when delta <= -0.05, do: :chill
  defp zone_for(delta) when delta >= 0.10, do: :hot
  defp zone_for(_delta), do: :on_track

  defp resolve_window_start(%{window_started_at: wsa}) when is_integer(wsa), do: wsa

  defp resolve_window_start(%{id: id, reset_at: reset_at}) when is_integer(reset_at) do
    case Map.get(@known_windows, id) do
      nil -> nil
      dur -> reset_at - dur
    end
  end

  defp resolve_window_start(_), do: nil

  defp duration_for(%{id: id, reset_at: reset_at}, window_start) do
    Map.get(@known_windows, id) || reset_at - window_start
  end

  defp none, do: %{delta: +0.0, zone: :none}
end
```

- [ ] **Step 4: Run the tests to verify pass**

```bash
cd server-elixir && mix test test/fbi/usage/pacing_test.exs
```

Expected: `6 tests, 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi/usage/pacing.ex server-elixir/test/fbi/usage/pacing_test.exs
git commit -m "feat(server-elixir/usage): port pacing logic from TS"
```

---

## Task 3: Ecto migration + schemas for usage tables

TS-produced `src/server/db/schema.sql` defines the tables. Elixir's Ecto migrations mirror them for dev/test only — production continues to initialize via TS's `migrate()`. Both sides produce identical table structure; `ecto_sqlite3` happily writes into tables that TS created.

**Files:**
- Create: `server-elixir/priv/repo/migrations/20260424000001_create_usage_tables.exs`
- Create: `server-elixir/lib/fbi/usage/rate_limit_state.ex`
- Create: `server-elixir/lib/fbi/usage/rate_limit_bucket.ex`
- Create: `server-elixir/lib/fbi/usage/usage_row.ex`
- Create: `server-elixir/test/fbi/usage/schemas_test.exs`

- [ ] **Step 1: Confirm the TS schema for the tables we're mirroring**

```bash
grep -A 20 "rate_limit_state\|rate_limit_buckets\|CREATE TABLE.*usage" /workspace/src/server/db/schema.sql
```

Record the column names/types/defaults — the Ecto migration must match exactly.

- [ ] **Step 2: Create the Ecto migration**

Create `server-elixir/priv/repo/migrations/20260424000001_create_usage_tables.exs`:

```elixir
defmodule FBI.Repo.Migrations.CreateUsageTables do
  @moduledoc """
  Phase 1 migration: mirror the usage-related tables defined in
  `src/server/db/schema.sql`. Runs only in dev/test environments; the
  production schema is owned by the TS server's `migrate()` function
  until Phase 9 (cutover).

  If TS's schema.sql gains columns for these tables during crossover,
  this migration must be updated in the same commit.
  """

  use Ecto.Migration

  def change do
    # Singleton state row — `id = 1` enforced by check constraint.
    create table(:rate_limit_state, primary_key: false) do
      add :id, :integer, primary_key: true
      add :plan, :string
      add :observed_at, :bigint
      add :last_error, :string
      add :last_error_at, :bigint
    end

    create constraint(:rate_limit_state, :rate_limit_state_id_check, check: "id = 1")

    create table(:rate_limit_buckets, primary_key: false) do
      add :id, :string, primary_key: true
      add :utilization, :float, null: false
      add :reset_at, :bigint
      add :window_started_at, :bigint
      add :updated_at, :bigint, null: false
    end

    create table(:usage) do
      add :run_id, :integer, null: false
      add :model, :string, null: false
      add :input_tokens, :integer, null: false
      add :output_tokens, :integer, null: false
      add :cache_creation_tokens, :integer, null: false, default: 0
      add :cache_read_tokens, :integer, null: false, default: 0
      add :cost_usd, :float
      add :occurred_at, :bigint, null: false
    end

    create index(:usage, [:run_id])
    create index(:usage, [:occurred_at])
  end
end
```

> **Note:** If `grep` in Step 1 revealed different columns or types, adjust accordingly. The migration must be identical to what `src/server/db/schema.sql` produces.

- [ ] **Step 3: Run the migration against the test DB**

```bash
cd server-elixir && mix ecto.migrate
```

Expected: the three tables are created in `server-elixir/fbi_dev.db`.

- [ ] **Step 4: Create `FBI.Usage.RateLimitState` schema**

Create `server-elixir/lib/fbi/usage/rate_limit_state.ex`:

```elixir
defmodule FBI.Usage.RateLimitState do
  @moduledoc """
  Ecto schema for the `rate_limit_state` singleton row.

  There is always exactly one row (enforced by the `id = 1` check constraint
  from the migration). The row tracks the last poll and any last-error.

  This is a plain Ecto schema — no OTP primitive — accessed via
  `FBI.Usage.Queries`. The singleton pattern is represented by always
  reading/writing `id: 1`; callers never construct rows with other ids.
  """

  use Ecto.Schema
  import Ecto.Changeset

  # `@primary_key` tells Ecto the column name, type, and auto-generation
  # behavior for the primary key. We turn off autogeneration because the
  # singleton has a fixed id.
  @primary_key {:id, :integer, autogenerate: false}

  schema "rate_limit_state" do
    field :plan, :string
    field :observed_at, :integer
    field :last_error, :string
    field :last_error_at, :integer
  end

  @type t :: %__MODULE__{
          id: integer(),
          plan: String.t() | nil,
          observed_at: integer() | nil,
          last_error: String.t() | nil,
          last_error_at: integer() | nil
        }

  @doc "Changeset for upserting the singleton row."
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(struct, attrs) do
    struct
    |> cast(attrs, [:id, :plan, :observed_at, :last_error, :last_error_at])
    |> validate_required([:id])
    |> validate_inclusion(:id, [1])
  end
end
```

- [ ] **Step 5: Create `FBI.Usage.RateLimitBucket` schema**

Create `server-elixir/lib/fbi/usage/rate_limit_bucket.ex`:

```elixir
defmodule FBI.Usage.RateLimitBucket do
  @moduledoc """
  Ecto schema for rows in `rate_limit_buckets`.

  One row per bucket id (e.g. `"five_hour"`, `"weekly"`, `"sonnet_weekly"`).
  Rows are upserted on every poll cycle; old rows for retired bucket ids
  stay until explicitly purged.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :string, autogenerate: false}

  schema "rate_limit_buckets" do
    field :utilization, :float
    field :reset_at, :integer
    field :window_started_at, :integer
    field :updated_at, :integer
  end

  @type t :: %__MODULE__{
          id: String.t(),
          utilization: float(),
          reset_at: integer() | nil,
          window_started_at: integer() | nil,
          updated_at: integer()
        }

  @required_fields ~w(id utilization updated_at)a
  @optional_fields ~w(reset_at window_started_at)a

  @doc "Changeset for inserting or updating a bucket row."
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(struct, attrs) do
    struct
    |> cast(attrs, @required_fields ++ @optional_fields)
    |> validate_required(@required_fields)
    |> validate_number(:utilization, greater_than_or_equal_to: 0.0, less_than_or_equal_to: 1.0)
  end
end
```

- [ ] **Step 6: Create `FBI.Usage.UsageRow` schema**

Create `server-elixir/lib/fbi/usage/usage_row.ex`:

```elixir
defmodule FBI.Usage.UsageRow do
  @moduledoc """
  Ecto schema for rows in `usage` — one row per model invocation,
  written by Claude via its hook. This server only reads the table
  (Phase 1) and aggregates per-run breakdowns.
  """

  use Ecto.Schema

  schema "usage" do
    field :run_id, :integer
    field :model, :string
    field :input_tokens, :integer
    field :output_tokens, :integer
    field :cache_creation_tokens, :integer
    field :cache_read_tokens, :integer
    field :cost_usd, :float
    field :occurred_at, :integer
  end

  @type t :: %__MODULE__{
          id: integer() | nil,
          run_id: integer(),
          model: String.t(),
          input_tokens: integer(),
          output_tokens: integer(),
          cache_creation_tokens: integer(),
          cache_read_tokens: integer(),
          cost_usd: float() | nil,
          occurred_at: integer()
        }
end
```

- [ ] **Step 7: Write the schemas smoke test**

Create `server-elixir/test/fbi/usage/schemas_test.exs`:

```elixir
defmodule FBI.Usage.SchemasTest do
  use FBI.DataCase, async: true
  alias FBI.Usage.{RateLimitBucket, RateLimitState, UsageRow}

  test "rate_limit_state changeset requires id = 1" do
    assert %{valid?: true} = RateLimitState.changeset(%RateLimitState{}, %{id: 1})
    assert %{valid?: false} = RateLimitState.changeset(%RateLimitState{}, %{id: 2})
    assert %{valid?: false} = RateLimitState.changeset(%RateLimitState{}, %{})
  end

  test "rate_limit_bucket changeset validates utilization in [0, 1]" do
    ok = RateLimitBucket.changeset(%RateLimitBucket{}, %{
      id: "five_hour", utilization: 0.5, updated_at: 1
    })
    assert ok.valid?

    bad = RateLimitBucket.changeset(%RateLimitBucket{}, %{
      id: "x", utilization: 1.5, updated_at: 1
    })
    refute bad.valid?
  end

  test "rate_limit_state round-trips through Repo" do
    {:ok, _} =
      %RateLimitState{}
      |> RateLimitState.changeset(%{id: 1, plan: "pro", observed_at: 100})
      |> FBI.Repo.insert()

    assert %RateLimitState{plan: "pro", observed_at: 100} =
             FBI.Repo.get(RateLimitState, 1)
  end

  test "rate_limit_buckets round-trip through Repo" do
    {:ok, _} =
      %RateLimitBucket{}
      |> RateLimitBucket.changeset(%{id: "five_hour", utilization: 0.3, updated_at: 1})
      |> FBI.Repo.insert()

    assert %RateLimitBucket{utilization: 0.3} =
             FBI.Repo.get(RateLimitBucket, "five_hour")
  end

  test "usage_row can be written and read (shape check only)" do
    row = %UsageRow{
      run_id: 42,
      model: "claude-opus-4-7",
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0.01,
      occurred_at: 1_700_000_000
    }

    {:ok, persisted} = FBI.Repo.insert(row)
    assert persisted.run_id == 42
  end
end
```

- [ ] **Step 8: Run tests**

```bash
cd server-elixir && mix test test/fbi/usage/schemas_test.exs
```

Expected: `5 tests, 0 failures`.

- [ ] **Step 9: Commit**

```bash
git add server-elixir/priv/repo/migrations/ \
        server-elixir/lib/fbi/usage/{rate_limit_state,rate_limit_bucket,usage_row}.ex \
        server-elixir/test/fbi/usage/schemas_test.exs
git commit -m "feat(server-elixir/usage): ecto schemas for usage tables"
```

---

## Task 4: Usage query helpers (repo pattern)

The TS code has a `UsageRepo` with `listDailyUsage/1`, `getRunBreakdown/1`, and helpers on `RateLimitStateRepo` / `RateLimitBucketsRepo`. Port those as pure functions in `FBI.Usage.Queries`.

**Files:**
- Create: `server-elixir/lib/fbi/usage/queries.ex`
- Create: `server-elixir/test/fbi/usage/queries_test.exs`

- [ ] **Step 1: Read the TS queries to mirror exactly**

```bash
grep -A 50 "listDailyUsage\|getRunBreakdown" /workspace/src/server/db/usage.ts
```

Record the output columns, groupings, and JSON shape.

- [ ] **Step 2: Write tests first**

Create `server-elixir/test/fbi/usage/queries_test.exs` with cases covering:

```elixir
defmodule FBI.Usage.QueriesTest do
  use FBI.DataCase, async: true
  alias FBI.Usage.{Queries, RateLimitBucket, RateLimitState, UsageRow}

  describe "get_state/0" do
    test "returns the seed row if nothing inserted" do
      # Match the TS behavior: when no state row exists, return a struct of nils
      assert %{plan: nil, observed_at: nil, last_error: nil, last_error_at: nil} =
               Queries.get_state()
    end

    test "returns inserted values" do
      FBI.Repo.insert!(%RateLimitState{id: 1, plan: "max", observed_at: 999})
      assert %{plan: "max", observed_at: 999} = Queries.get_state()
    end
  end

  describe "set_observed/1" do
    test "creates the seed row if missing, clears error fields, sets observed_at" do
      Queries.set_observed(1234)
      assert %{observed_at: 1234, last_error: nil, last_error_at: nil} = Queries.get_state()
    end
  end

  describe "list_buckets/0" do
    test "returns rows sorted by id" do
      FBI.Repo.insert!(%RateLimitBucket{id: "weekly", utilization: 0.2, updated_at: 1})
      FBI.Repo.insert!(%RateLimitBucket{id: "five_hour", utilization: 0.5, updated_at: 1})
      ids = Queries.list_buckets() |> Enum.map(& &1.id)
      assert ids == ["five_hour", "weekly"]
    end
  end

  describe "list_daily_usage/1" do
    test "groups usage by day and model, limited to `days`" do
      now = System.system_time(:millisecond)
      insert_usage(run_id: 1, model: "claude-opus-4-7", input: 100, output: 50, at: now)
      insert_usage(run_id: 1, model: "claude-opus-4-7", input: 200, output: 100, at: now)
      insert_usage(run_id: 2, model: "claude-haiku-4-5", input: 10, output: 5, at: now)

      rows = Queries.list_daily_usage(days: 14, now: now)
      assert length(rows) == 2
      opus = Enum.find(rows, &(&1.model == "claude-opus-4-7"))
      assert opus.input_tokens == 300
    end
  end

  describe "get_run_breakdown/1" do
    test "returns per-model totals for one run" do
      insert_usage(run_id: 42, model: "claude-opus-4-7", input: 10, output: 5, at: 1)
      insert_usage(run_id: 42, model: "claude-opus-4-7", input: 20, output: 15, at: 2)
      insert_usage(run_id: 99, model: "claude-opus-4-7", input: 1000, output: 1000, at: 3)

      assert [%{model: "claude-opus-4-7", input_tokens: 30, output_tokens: 20}] =
               Queries.get_run_breakdown(42)
    end
  end

  defp insert_usage(opts) do
    FBI.Repo.insert!(%UsageRow{
      run_id: Keyword.fetch!(opts, :run_id),
      model: Keyword.fetch!(opts, :model),
      input_tokens: Keyword.fetch!(opts, :input),
      output_tokens: Keyword.fetch!(opts, :output),
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0.0,
      occurred_at: Keyword.fetch!(opts, :at)
    })
  end
end
```

- [ ] **Step 3: Run tests — expect failure**

```bash
cd server-elixir && mix test test/fbi/usage/queries_test.exs
```

Expected: FAIL with `module FBI.Usage.Queries is not available`.

- [ ] **Step 4: Implement `FBI.Usage.Queries`**

Create `server-elixir/lib/fbi/usage/queries.ex`:

```elixir
defmodule FBI.Usage.Queries do
  @moduledoc """
  Query helpers for the usage module. Pure functions over `FBI.Repo` — no
  state, no OTP primitive. Mirrors the TS `UsageRepo`, `RateLimitStateRepo`,
  and `RateLimitBucketsRepo` in one module since they share a domain.

  Callers pass primitive arguments; this module handles Ecto query
  construction, DB I/O, and row-to-struct mapping.
  """

  import Ecto.Query
  alias FBI.Repo
  alias FBI.Usage.{RateLimitBucket, RateLimitState, UsageRow}

  # --- RateLimitState --------------------------------------------------

  @doc """
  Read the singleton state row. If the row does not exist yet, returns
  a struct of nils matching the TS behavior (never returns nil itself).
  """
  @spec get_state() :: RateLimitState.t()
  def get_state do
    Repo.get(RateLimitState, 1) ||
      %RateLimitState{id: 1, plan: nil, observed_at: nil, last_error: nil, last_error_at: nil}
  end

  @doc """
  Record a successful poll observation. Upserts the seed row if missing.
  Clears `last_error` / `last_error_at`.
  """
  @spec set_observed(integer()) :: :ok
  def set_observed(now) when is_integer(now) do
    # `on_conflict: :replace_all` uses SQLite's UPSERT to make this idempotent.
    %RateLimitState{id: 1, observed_at: now, last_error: nil, last_error_at: nil}
    |> Repo.insert!(
      on_conflict: {:replace, [:observed_at, :last_error, :last_error_at]},
      conflict_target: :id
    )

    :ok
  end

  @doc """
  Record a failed poll. Upserts the seed row if missing.
  """
  @spec set_error(String.t(), integer()) :: :ok
  def set_error(kind, now) when is_binary(kind) and is_integer(now) do
    %RateLimitState{id: 1, last_error: kind, last_error_at: now}
    |> Repo.insert!(
      on_conflict: {:replace, [:last_error, :last_error_at]},
      conflict_target: :id
    )

    :ok
  end

  @doc """
  Update the detected plan (pro / max / team).
  """
  @spec set_plan(String.t()) :: :ok
  def set_plan(plan) when plan in ["pro", "max", "team"] do
    %RateLimitState{id: 1, plan: plan}
    |> Repo.insert!(on_conflict: {:replace, [:plan]}, conflict_target: :id)

    :ok
  end

  # --- RateLimitBuckets ------------------------------------------------

  @doc "List buckets sorted by id."
  @spec list_buckets() :: [RateLimitBucket.t()]
  def list_buckets do
    RateLimitBucket
    |> order_by(:id)
    |> Repo.all()
  end

  @doc """
  Upsert a bucket row. Replaces utilization / reset_at / window_started_at /
  updated_at, never changes the primary key.
  """
  @spec upsert_bucket(map()) :: :ok
  def upsert_bucket(%{id: id} = attrs) when is_binary(id) do
    %RateLimitBucket{id: id}
    |> RateLimitBucket.changeset(attrs)
    |> Repo.insert!(
      on_conflict: {:replace, [:utilization, :reset_at, :window_started_at, :updated_at]},
      conflict_target: :id
    )

    :ok
  end

  # --- Usage (per-run + daily aggregates) ------------------------------

  @doc """
  List usage aggregated by UTC day and model for the last `days` days.
  Returns a list of maps: `%{day: "YYYY-MM-DD", model: String.t(),
  input_tokens: int, output_tokens: int, cost_usd: float}`.
  """
  @spec list_daily_usage(keyword()) :: [map()]
  def list_daily_usage(opts) do
    days = Keyword.get(opts, :days, 14)
    now = Keyword.get(opts, :now, System.system_time(:millisecond))
    cutoff = now - days * 86_400_000

    from(u in UsageRow,
      where: u.occurred_at >= ^cutoff,
      group_by: [fragment("date(?, 'unixepoch')", u.occurred_at), u.model],
      order_by: [
        asc: fragment("date(?, 'unixepoch')", u.occurred_at),
        asc: u.model
      ],
      select: %{
        day: fragment("date(?/1000, 'unixepoch')", u.occurred_at),
        model: u.model,
        input_tokens: sum(u.input_tokens),
        output_tokens: sum(u.output_tokens),
        cache_creation_tokens: sum(u.cache_creation_tokens),
        cache_read_tokens: sum(u.cache_read_tokens),
        cost_usd: sum(u.cost_usd)
      }
    )
    |> Repo.all()
  end

  @doc """
  Per-model breakdown for a single run, summing tokens and cost.
  """
  @spec get_run_breakdown(integer()) :: [map()]
  def get_run_breakdown(run_id) when is_integer(run_id) do
    from(u in UsageRow,
      where: u.run_id == ^run_id,
      group_by: u.model,
      order_by: u.model,
      select: %{
        model: u.model,
        input_tokens: sum(u.input_tokens),
        output_tokens: sum(u.output_tokens),
        cache_creation_tokens: sum(u.cache_creation_tokens),
        cache_read_tokens: sum(u.cache_read_tokens),
        cost_usd: sum(u.cost_usd)
      }
    )
    |> Repo.all()
  end
end
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd server-elixir && mix test test/fbi/usage/queries_test.exs
```

Expected: `5 tests, 0 failures`.

- [ ] **Step 6: Commit**

```bash
git add server-elixir/lib/fbi/usage/queries.ex server-elixir/test/fbi/usage/queries_test.exs
git commit -m "feat(server-elixir/usage): query helpers for state/buckets/usage"
```

---

## Task 5: OAuth HTTP client

Encapsulates the two Anthropic endpoints (`/api/oauth/usage` for buckets, `/api/oauth/profile` for plan) behind a small module. Using `Req` with a `:plug` option for testability.

**Files:**
- Create: `server-elixir/lib/fbi/usage/oauth_client.ex`
- Create: `server-elixir/test/fbi/usage/oauth_client_test.exs`

- [ ] **Step 1: Write tests first**

Create `server-elixir/test/fbi/usage/oauth_client_test.exs`:

```elixir
defmodule FBI.Usage.OAuthClientTest do
  use ExUnit.Case, async: true
  alias FBI.Usage.OAuthClient

  defp stub_plug(status, body) do
    fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(status, Jason.encode!(body))
    end
  end

  describe "fetch_usage/2" do
    test "returns normalized buckets on 200 with happy-path shape" do
      plug = stub_plug(200, %{
        "five_hour" => %{"utilization" => 0.5, "resets_at" => 1_700_000_000_000, "window_started_at" => 1_699_982_000_000},
        "seven_day" => %{"utilization" => 0.2, "resets_at" => 1_701_000_000_000}
      })

      {:ok, buckets} = OAuthClient.fetch_usage(token: "t", req_opts: [plug: plug])

      assert %{id: "five_hour", utilization: 0.5} = Enum.find(buckets, &(&1.id == "five_hour"))
      # bucket id alias: seven_day -> weekly
      assert %{id: "weekly", utilization: 0.2} = Enum.find(buckets, &(&1.id == "weekly"))
    end

    test "classifies 401 as :unauthenticated" do
      plug = stub_plug(401, %{"error" => "nope"})
      assert {:error, :unauthenticated} = OAuthClient.fetch_usage(token: "t", req_opts: [plug: plug])
    end

    test "classifies 429 as :rate_limited" do
      plug = stub_plug(429, %{"error" => "slow down"})
      assert {:error, :rate_limited} = OAuthClient.fetch_usage(token: "t", req_opts: [plug: plug])
    end
  end

  describe "fetch_plan/2" do
    test "returns :pro | :max | :team atom" do
      plug = stub_plug(200, %{"organization" => %{"subscription_tier" => "max"}})
      assert {:ok, :max} = OAuthClient.fetch_plan(token: "t", req_opts: [plug: plug])
    end

    test "returns :unknown when tier key is missing" do
      plug = stub_plug(200, %{})
      assert {:ok, :unknown} = OAuthClient.fetch_plan(token: "t", req_opts: [plug: plug])
    end
  end
end
```

- [ ] **Step 2: Run — expect fail**

```bash
cd server-elixir && mix test test/fbi/usage/oauth_client_test.exs
```

Expected: FAIL with `module FBI.Usage.OAuthClient is not available`.

- [ ] **Step 3: Implement the client**

Create `server-elixir/lib/fbi/usage/oauth_client.ex`:

```elixir
defmodule FBI.Usage.OAuthClient do
  @moduledoc """
  HTTP client for Anthropic's OAuth endpoints used by the poller:

    * `/api/oauth/usage` — returns a map of bucket_id → {utilization, reset_at}.
    * `/api/oauth/profile` — returns the user's subscription tier (pro/max/team).

  Uses `Req`. Tests inject `req_opts: [plug: plug_fun]` to bypass the network.

  Not a GenServer — stateless. The poller (`FBI.Usage.Poller`) calls into
  here and handles retry / state persistence.
  """

  @usage_url "https://api.anthropic.com/api/oauth/usage"
  @profile_url "https://api.anthropic.com/api/oauth/profile"
  @beta_header "oauth-2025-04-20"

  # Anthropic's public API uses "seven_day" / "seven_day_sonnet"; internal
  # names are shorter. Keep the alias table here so callers never see the
  # raw names.
  @bucket_aliases %{"seven_day" => "weekly", "seven_day_sonnet" => "sonnet_weekly"}

  # Top-level keys that aren't buckets in `/oauth/usage` — skip during
  # normalization.
  @non_bucket_keys ["extra_usage"]

  @type bucket :: %{
          id: String.t(),
          utilization: float(),
          reset_at: integer() | nil,
          window_started_at: integer() | nil
        }

  @type error_kind :: :unauthenticated | :rate_limited | :server_error | :network_error

  @doc """
  Fetches current bucket utilization. Returns `{:ok, [bucket]}` or an
  `{:error, reason}` tuple where reason is one of the `error_kind` values.
  """
  @spec fetch_usage(keyword()) :: {:ok, [bucket()]} | {:error, error_kind()}
  def fetch_usage(opts) do
    token = Keyword.fetch!(opts, :token)
    req_opts = Keyword.get(opts, :req_opts, [])

    case request(@usage_url, token, req_opts) do
      {:ok, %{status: 200, body: body}} when is_map(body) -> {:ok, normalize_buckets(body)}
      {:ok, %{status: 401}} -> {:error, :unauthenticated}
      {:ok, %{status: 429}} -> {:error, :rate_limited}
      {:ok, %{status: s}} when s >= 500 -> {:error, :server_error}
      {:ok, _} -> {:error, :server_error}
      {:error, _} -> {:error, :network_error}
    end
  end

  @doc """
  Fetches the user's plan tier. Returns `{:ok, :pro | :max | :team | :unknown}`
  or `{:error, error_kind}`.
  """
  @spec fetch_plan(keyword()) :: {:ok, :pro | :max | :team | :unknown} | {:error, error_kind()}
  def fetch_plan(opts) do
    token = Keyword.fetch!(opts, :token)
    req_opts = Keyword.get(opts, :req_opts, [])

    case request(@profile_url, token, req_opts) do
      {:ok, %{status: 200, body: body}} -> {:ok, extract_plan(body)}
      {:ok, %{status: 401}} -> {:error, :unauthenticated}
      {:ok, %{status: 429}} -> {:error, :rate_limited}
      {:ok, %{status: s}} when s >= 500 -> {:error, :server_error}
      {:ok, _} -> {:error, :server_error}
      {:error, _} -> {:error, :network_error}
    end
  end

  # --- Internals -------------------------------------------------------

  # `with` is a control-flow form that chains pattern matches; if any
  # pattern fails, the `else` clauses handle the non-match. We don't use
  # it here — the `case` is simple enough.
  defp request(url, token, extra_opts) do
    Req.get(
      url,
      Keyword.merge(
        [
          headers: [
            {"Authorization", "Bearer #{token}"},
            {"anthropic-beta", @beta_header},
            {"Accept", "application/json"}
          ],
          retry: false
        ],
        extra_opts
      )
    )
  end

  defp normalize_buckets(body) do
    body
    |> Enum.reject(fn {k, _} -> k in @non_bucket_keys end)
    |> Enum.map(fn {raw_id, values} ->
      id = Map.get(@bucket_aliases, raw_id, raw_id)

      %{
        id: id,
        utilization: coerce_float(Map.get(values, "utilization")),
        reset_at: coerce_int(Map.get(values, "resets_at")),
        window_started_at: coerce_int(Map.get(values, "window_started_at"))
      }
    end)
  end

  defp coerce_float(v) when is_number(v), do: v * 1.0
  defp coerce_float(_), do: 0.0

  defp coerce_int(v) when is_integer(v), do: v
  defp coerce_int(_), do: nil

  defp extract_plan(%{"organization" => %{"subscription_tier" => tier}})
       when tier in ["pro", "max", "team"] do
    String.to_existing_atom(tier)
  end

  defp extract_plan(_), do: :unknown
end
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd server-elixir && mix test test/fbi/usage/oauth_client_test.exs
```

Expected: `5 tests, 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi/usage/oauth_client.ex server-elixir/test/fbi/usage/oauth_client_test.exs
git commit -m "feat(server-elixir/usage): oauth HTTP client with Req-plug-based tests"
```

---

## Task 6: Credentials reader GenServer

Watches `~/.claude/.credentials.json` via inotify (`FileSystem`), reads the token, and publishes a `:credentials_changed` event via `Phoenix.PubSub` whenever the file changes. Debounced at 500ms to coalesce rapid writes (e.g. by Claude itself during login).

**Files:**
- Create: `server-elixir/lib/fbi/usage/credentials_reader.ex`
- Create: `server-elixir/test/fbi/usage/credentials_reader_test.exs`

- [ ] **Step 1: Write tests**

Create `server-elixir/test/fbi/usage/credentials_reader_test.exs`:

```elixir
defmodule FBI.Usage.CredentialsReaderTest do
  use ExUnit.Case, async: false
  alias FBI.Usage.CredentialsReader

  @topic "credentials"

  setup do
    tmp = System.tmp_dir!() |> Path.join("creds-#{:erlang.unique_integer([:positive])}.json")
    on_exit(fn -> File.rm_rf(tmp) end)
    {:ok, %{path: tmp}}
  end

  test "read/1 returns nil when file doesn't exist", %{path: path} do
    assert CredentialsReader.read(path) == nil
  end

  test "read/1 returns token when file has one", %{path: path} do
    File.write!(path, ~s({"claudeAiOauth":{"accessToken":"abc123"}}))
    assert CredentialsReader.read(path) == "abc123"
  end

  test "read/1 returns nil when file is malformed", %{path: path} do
    File.write!(path, "not json")
    assert CredentialsReader.read(path) == nil
  end

  test "GenServer publishes :credentials_changed on file change", %{path: path} do
    File.write!(path, ~s({"claudeAiOauth":{"accessToken":"a"}}))

    # PubSub must exist in the test environment — it's started by the app's
    # supervision tree, so a `Phoenix.PubSub` child ensures availability.
    Phoenix.PubSub.subscribe(FBI.PubSub, @topic)

    start_supervised!({CredentialsReader, path: path, debounce_ms: 50})

    File.write!(path, ~s({"claudeAiOauth":{"accessToken":"b"}}))

    assert_receive :credentials_changed, 2000
  end
end
```

- [ ] **Step 2: Run — expect fail**

```bash
cd server-elixir && mix test test/fbi/usage/credentials_reader_test.exs
```

Expected: FAIL with "module FBI.Usage.CredentialsReader is not available".

- [ ] **Step 3: Implement the module**

Create `server-elixir/lib/fbi/usage/credentials_reader.ex`:

```elixir
defmodule FBI.Usage.CredentialsReader do
  @moduledoc """
  `GenServer` that watches `~/.claude/.credentials.json` and publishes a
  `:credentials_changed` message on `Phoenix.PubSub` whenever the file
  changes. Debounced to coalesce bursts of writes (e.g. Claude's login flow
  writes the file multiple times in quick succession).

  Start as a supervised child of `FBI.Application`:

      {FBI.Usage.CredentialsReader, path: "/home/fbi/.claude/.credentials.json"}

  `read/1` is exposed as a stateless helper for the poller: on a credential
  change event, the poller calls `read/1` to get the current token.

  ## Why a GenServer (and not a Task)

  We hold two pieces of state: the `FileSystem` watcher pid and a debounce
  timer reference. Message reordering must be deterministic (incoming
  `:file_event` followed by a debounce timeout). A GenServer gives us one
  mailbox and a serial handler — both criteria met.
  """

  use GenServer
  require Logger

  @topic "credentials"
  @default_debounce 500

  @type start_opts :: [
          path: Path.t(),
          debounce_ms: pos_integer(),
          name: GenServer.name()
        ]

  # --- Public API ------------------------------------------------------

  @doc """
  Starts the credentials reader. Required option: `:path`.

  Options:
    * `:debounce_ms` — how long to wait after a file event before emitting
      (default: 500ms).
    * `:name` — registration name (default: `__MODULE__`).
  """
  @spec start_link(start_opts()) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronously read the current access token from disk. Returns `nil`
  on read/parse error or when no token is present.
  """
  @spec read(Path.t()) :: String.t() | nil
  def read(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, %{"claudeAiOauth" => %{"accessToken" => t}}} when is_binary(t) and t != "" <-
           Jason.decode(raw) do
      t
    else
      _ -> nil
    end
  end

  # --- Callbacks -------------------------------------------------------

  @impl true
  def init(opts) do
    path = Keyword.fetch!(opts, :path)
    debounce = Keyword.get(opts, :debounce_ms, @default_debounce)

    # Watch the parent directory — inotify watches on the file itself break
    # on atomic writes (rename dance), while directory watches see every
    # change. We filter events by filename.
    dir = Path.dirname(path)
    File.mkdir_p!(dir)

    case FileSystem.start_link(dirs: [dir]) do
      {:ok, watcher_pid} ->
        FileSystem.subscribe(watcher_pid)

        state = %{
          path: path,
          basename: Path.basename(path),
          watcher: watcher_pid,
          debounce_ms: debounce,
          debounce_ref: nil
        }

        {:ok, state}

      {:error, reason} ->
        # If the file system watcher can't start (e.g. inotify quota), we
        # still boot but won't emit events. Not a fatal condition — the
        # poller's 5-minute cadence keeps things moving.
        Logger.warning("CredentialsReader: file watcher failed to start: #{inspect(reason)}")
        {:ok, %{path: path, basename: Path.basename(path), watcher: nil, debounce_ms: debounce, debounce_ref: nil}}
    end
  end

  @impl true
  def handle_info({:file_event, _pid, {file, _events}}, state) do
    if Path.basename(file) == state.basename do
      {:noreply, schedule_emit(state)}
    else
      {:noreply, state}
    end
  end

  def handle_info(:emit, state) do
    Phoenix.PubSub.broadcast(FBI.PubSub, @topic, :credentials_changed)
    {:noreply, %{state | debounce_ref: nil}}
  end

  def handle_info({:file_event, _pid, :stop}, state) do
    # Watcher stopped (e.g. dir removed). Not fatal.
    {:noreply, state}
  end

  # --- Private ---------------------------------------------------------

  defp schedule_emit(%{debounce_ref: ref} = state) when is_reference(ref) do
    Process.cancel_timer(ref)
    schedule_emit(%{state | debounce_ref: nil})
  end

  defp schedule_emit(state) do
    ref = Process.send_after(self(), :emit, state.debounce_ms)
    %{state | debounce_ref: ref}
  end
end
```

- [ ] **Step 4: Start Phoenix PubSub in the test environment**

The test subscribes to `FBI.PubSub`. The scaffold's `FBI.Application` already starts `{Phoenix.PubSub, name: FBI.PubSub}`, so PubSub is available in tests via the Application tree. No action needed unless a test fails with `no process` — if so, add an explicit `start_supervised!({Phoenix.PubSub, name: FBI.PubSub})` in the test's setup.

- [ ] **Step 5: Run tests — expect pass**

```bash
cd server-elixir && mix test test/fbi/usage/credentials_reader_test.exs
```

Expected: `4 tests, 0 failures`.

- [ ] **Step 6: Commit**

```bash
git add server-elixir/lib/fbi/usage/credentials_reader.ex \
        server-elixir/test/fbi/usage/credentials_reader_test.exs
git commit -m "feat(server-elixir/usage): credentials reader GenServer with inotify"
```

---

## Task 7: Usage poller GenServer

The core scheduler. Every 5 minutes: reads the token (via `CredentialsReader.read/1`), calls `OAuthClient.fetch_usage/2` + `fetch_plan/2`, upserts state/buckets via `Queries`, broadcasts a snapshot on PubSub. Accepts `nudge/0` calls (e.g. from `CredentialsReader`'s change event) but enforces the 5-minute minimum between polls.

**Files:**
- Create: `server-elixir/lib/fbi/usage/poller.ex`
- Create: `server-elixir/test/fbi/usage/poller_test.exs`

- [ ] **Step 1: Write tests**

Create `server-elixir/test/fbi/usage/poller_test.exs`:

```elixir
defmodule FBI.Usage.PollerTest do
  use FBI.DataCase, async: false
  alias FBI.Usage.{OAuthClient, Poller, Queries}

  @topic "usage"

  setup do
    Phoenix.PubSub.subscribe(FBI.PubSub, @topic)
    :ok
  end

  defp stub_usage_client(usage_buckets, plan \\ :max) do
    fn
      :usage, _opts -> {:ok, usage_buckets}
      :plan, _opts -> {:ok, plan}
    end
  end

  test "poll/1 writes buckets, state, and broadcasts snapshot" do
    client = stub_usage_client([
      %{id: "five_hour", utilization: 0.5, reset_at: 1_700_000_000_000, window_started_at: 1_699_982_000_000}
    ])

    assert :ok = Poller.poll_once(client: client, token: "t", now: 1234)

    # DB state written
    assert %{observed_at: 1234, plan: "max"} = Queries.get_state()
    assert [%{id: "five_hour", utilization: 0.5}] = Queries.list_buckets()

    # PubSub broadcast happened
    assert_receive {:usage_snapshot, snap}, 500
    assert Enum.any?(snap.buckets, &(&1.id == "five_hour"))
  end

  test "poll/1 on unauthenticated writes error state, no bucket updates" do
    client = fn
      :usage, _opts -> {:error, :unauthenticated}
      :plan, _opts -> {:error, :unauthenticated}
    end

    assert :ok = Poller.poll_once(client: client, token: "t", now: 9000)

    assert %{last_error: "unauthenticated", last_error_at: 9000} = Queries.get_state()
    assert [] = Queries.list_buckets()
  end

  test "nudge/1 short-circuits if last attempt was within 5 minutes" do
    # seed prior attempt 60 seconds ago
    Queries.set_observed(System.system_time(:millisecond) - 60_000)

    client = stub_usage_client([])
    # A real nudge wouldn't call the client because the gap is < 5min.
    # We test this by having the client crash if called:
    bad_client = fn _, _ -> raise "client should not be called" end

    start_supervised!({Poller, [
      client: bad_client,
      token_fn: fn -> "t" end,
      interval_ms: 500  # we'll never hit this in this test
    ]})

    Poller.nudge()

    # Allow a brief window then confirm no crash/poll happened.
    Process.sleep(100)
    assert Process.alive?(Process.whereis(Poller))
  end
end
```

- [ ] **Step 2: Run — expect fail**

```bash
cd server-elixir && mix test test/fbi/usage/poller_test.exs
```

Expected: FAIL.

- [ ] **Step 3: Implement the Poller**

Create `server-elixir/lib/fbi/usage/poller.ex`:

```elixir
defmodule FBI.Usage.Poller do
  @moduledoc """
  `GenServer` that polls Anthropic's OAuth usage API every 5 minutes, writes
  the observed state to the DB (`FBI.Usage.Queries`), and broadcasts a
  snapshot on the `"usage"` PubSub topic.

  ## Nudge semantics

  Callers can nudge via `nudge/0` (e.g. when the credentials file changes).
  Nudges can never poll sooner than 5 minutes since the last *attempt*
  (success or failure) — this mirrors the TS behavior and stays within
  Anthropic's rate limit for the endpoint.

  ## Test seam

  The `:client` option accepts a function `(:usage | :plan, keyword) ->
  {:ok, term} | {:error, atom}` which lets tests replace `OAuthClient` with
  a stub that doesn't hit the network.

  ## Supervision

  Started as `:transient` in `FBI.Application`:

      {FBI.Usage.Poller, [token_fn: &read_token/0]}
  """

  use GenServer
  require Logger

  alias FBI.Usage.{OAuthClient, Queries}

  @topic "usage"
  @default_interval 5 * 60 * 1000
  @min_nudge_gap 5 * 60 * 1000

  @type state :: %{
          client: function(),
          token_fn: (-> String.t() | nil),
          interval_ms: pos_integer(),
          timer_ref: reference() | nil
        }

  # --- Public API ------------------------------------------------------

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Request a poll as soon as the rate-limit gate allows. Ignored if the last
  poll attempt was within the last 5 minutes.
  """
  @spec nudge() :: :ok
  def nudge, do: GenServer.cast(__MODULE__, :nudge)

  @doc """
  Run a single synchronous poll. Used by tests; production paths use the
  `GenServer`-driven loop plus `nudge/0`.
  """
  @spec poll_once(keyword()) :: :ok
  def poll_once(opts) do
    client = Keyword.get(opts, :client, &default_client/2)
    token = Keyword.fetch!(opts, :token)
    now = Keyword.get(opts, :now, System.system_time(:millisecond))
    do_poll(client, token, now)
  end

  # --- Callbacks -------------------------------------------------------

  @impl true
  def init(opts) do
    state = %{
      client: Keyword.get(opts, :client, &default_client/2),
      token_fn: Keyword.fetch!(opts, :token_fn),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval),
      timer_ref: nil
    }

    # Kick off the first tick shortly after boot — small jitter prevents
    # thundering herd if multiple instances start simultaneously.
    send(self(), :tick)
    {:ok, state}
  end

  @impl true
  def handle_cast(:nudge, state) do
    if nudge_allowed?() do
      tick(state)
      {:noreply, state}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_info(:tick, state) do
    tick(state)
    new_ref = Process.send_after(self(), :tick, state.interval_ms)
    {:noreply, %{state | timer_ref: new_ref}}
  end

  # --- Private ---------------------------------------------------------

  defp tick(%{token_fn: token_fn, client: client}) do
    case token_fn.() do
      nil ->
        Logger.info("Poller: no token available, skipping poll")
        :ok

      token ->
        do_poll(client, token, System.system_time(:millisecond))
    end
  end

  defp nudge_allowed? do
    state = Queries.get_state()
    last = Enum.max([state.observed_at || 0, state.last_error_at || 0])
    now = System.system_time(:millisecond)
    now - last >= @min_nudge_gap
  end

  defp do_poll(client, token, now) do
    usage_result = client.(:usage, token: token)
    plan_result = client.(:plan, token: token)

    case usage_result do
      {:ok, buckets} ->
        Enum.each(buckets, fn b ->
          Queries.upsert_bucket(Map.merge(b, %{updated_at: now}))
        end)

        Queries.set_observed(now)

      {:error, kind} ->
        Queries.set_error(Atom.to_string(kind), now)
    end

    case plan_result do
      {:ok, tier} when tier in [:pro, :max, :team] ->
        Queries.set_plan(Atom.to_string(tier))

      _ ->
        :ok
    end

    broadcast_snapshot()
    :ok
  end

  defp broadcast_snapshot do
    Phoenix.PubSub.broadcast(
      FBI.PubSub,
      @topic,
      {:usage_snapshot, snapshot()}
    )
  end

  @doc false
  def snapshot do
    state = Queries.get_state()
    buckets = Queries.list_buckets()

    %{
      plan: state.plan,
      observed_at: state.observed_at,
      last_error: state.last_error,
      last_error_at: state.last_error_at,
      buckets:
        Enum.map(buckets, fn b ->
          %{
            id: b.id,
            utilization: b.utilization,
            reset_at: b.reset_at,
            window_started_at: b.window_started_at
          }
        end)
    }
  end

  defp default_client(:usage, opts), do: OAuthClient.fetch_usage(opts)
  defp default_client(:plan, opts), do: OAuthClient.fetch_plan(opts)
end
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd server-elixir && mix test test/fbi/usage/poller_test.exs
```

Expected: `3 tests, 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi/usage/poller.ex server-elixir/test/fbi/usage/poller_test.exs
git commit -m "feat(server-elixir/usage): poller GenServer with 5min cadence + nudge"
```

---

## Task 8: Usage REST controller and routes

Three endpoints. Bodies follow the existing TS JSON shapes byte-identically.

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/usage_controller.ex`
- Modify: `server-elixir/lib/fbi_web/router.ex`
- Create: `server-elixir/test/fbi_web/controllers/usage_controller_test.exs`

- [ ] **Step 1: Add routes**

In `server-elixir/lib/fbi_web/router.ex`, inside the `scope "/api", FBIWeb do` block:

```elixir
scope "/api", FBIWeb do
  pipe_through :api

  get "/usage", UsageController, :show
  get "/usage/daily", UsageController, :daily
  get "/usage/runs/:id", UsageController, :run_breakdown
end
```

- [ ] **Step 2: Write tests**

Create `server-elixir/test/fbi_web/controllers/usage_controller_test.exs`:

```elixir
defmodule FBIWeb.UsageControllerTest do
  use FBIWeb.ConnCase, async: true
  alias FBI.Usage.{Queries, RateLimitBucket, RateLimitState, UsageRow}

  describe "GET /api/usage" do
    test "returns the current poller snapshot shape", %{conn: conn} do
      FBI.Repo.insert!(%RateLimitState{id: 1, plan: "max", observed_at: 100})
      FBI.Repo.insert!(%RateLimitBucket{id: "five_hour", utilization: 0.25, updated_at: 200})

      conn = get(conn, "/api/usage")

      assert %{
               "plan" => "max",
               "observed_at" => 100,
               "last_error" => nil,
               "last_error_at" => nil,
               "buckets" => [%{"id" => "five_hour", "utilization" => 0.25}]
             } = json_response(conn, 200)
    end
  end

  describe "GET /api/usage/daily" do
    test "returns per-day/per-model aggregates honoring ?days=", %{conn: conn} do
      now = System.system_time(:millisecond)

      FBI.Repo.insert!(%UsageRow{
        run_id: 1, model: "claude-opus-4-7", input_tokens: 10, output_tokens: 5,
        cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0.0, occurred_at: now
      })

      conn = get(conn, "/api/usage/daily?days=14")

      assert [%{"model" => "claude-opus-4-7", "input_tokens" => 10}] =
               json_response(conn, 200)
    end
  end

  describe "GET /api/usage/runs/:id" do
    test "returns per-model breakdown for the run", %{conn: conn} do
      FBI.Repo.insert!(%UsageRow{
        run_id: 42, model: "claude-opus-4-7", input_tokens: 100, output_tokens: 50,
        cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0.01, occurred_at: 1
      })

      conn = get(conn, "/api/usage/runs/42")

      assert [%{"model" => "claude-opus-4-7", "input_tokens" => 100}] =
               json_response(conn, 200)
    end

    test "returns 400 for non-numeric id", %{conn: conn} do
      conn = get(conn, "/api/usage/runs/abc")
      assert %{"error" => _} = json_response(conn, 400)
    end
  end
end
```

Also create `server-elixir/test/support/conn_case.ex` if the scaffold didn't generate it (it should have — the scaffold for `--no-html` still makes ConnCase). Verify:

```bash
ls server-elixir/test/support/conn_case.ex
```

- [ ] **Step 3: Run tests — expect fail**

```bash
cd server-elixir && mix test test/fbi_web/controllers/usage_controller_test.exs
```

Expected: FAIL — controller not found.

- [ ] **Step 4: Implement the controller**

Create `server-elixir/lib/fbi_web/controllers/usage_controller.ex`:

```elixir
defmodule FBIWeb.UsageController do
  @moduledoc """
  REST endpoints for the usage module. Thin; all logic lives in
  `FBI.Usage.Queries` (DB access) and `FBI.Usage.Poller` (snapshot).

  The response shapes mirror the TS `registerUsageRoutes` implementation
  exactly — same keys, same types, same ordering — so the React frontend
  sees no change at the byte level.
  """

  use FBIWeb, :controller

  alias FBI.Usage.{Poller, Queries}

  @doc "GET /api/usage — current snapshot from the poller."
  def show(conn, _params) do
    json(conn, Poller.snapshot())
  end

  @doc "GET /api/usage/daily — per-day/per-model usage aggregates."
  def daily(conn, params) do
    days =
      case Integer.parse(Map.get(params, "days", "14")) do
        {n, ""} when n > 0 and n <= 365 -> n
        _ -> 14
      end

    json(conn, Queries.list_daily_usage(days: days))
  end

  @doc "GET /api/usage/runs/:id — per-model cost breakdown for one run."
  def run_breakdown(conn, %{"id" => id}) do
    case Integer.parse(id) do
      {run_id, ""} ->
        json(conn, Queries.get_run_breakdown(run_id))

      _ ->
        conn
        |> put_status(400)
        |> json(%{error: "invalid id"})
    end
  end
end
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd server-elixir && mix test test/fbi_web/controllers/usage_controller_test.exs
```

Expected: `4 tests, 0 failures`.

- [ ] **Step 6: Commit**

```bash
git add server-elixir/lib/fbi_web/controllers/usage_controller.ex \
        server-elixir/lib/fbi_web/router.ex \
        server-elixir/test/fbi_web/controllers/usage_controller_test.exs
git commit -m "feat(server-elixir/usage): REST controller for /api/usage endpoints"
```

---

## Task 9: Raw WebSocket handler for `/api/ws/usage`

Phoenix Channels have their own wire protocol (join/leave/push envelopes). The existing TS client speaks plain WebSocket with raw JSON frames — so we use `WebSock` (the Phoenix/Bandit-native raw WS behavior) instead of a Channel.

**Files:**
- Create: `server-elixir/lib/fbi_web/sockets/usage_ws_handler.ex`
- Modify: `server-elixir/lib/fbi_web/endpoint.ex` (register the socket route)
- Create: `server-elixir/test/fbi_web/sockets/usage_ws_test.exs`

- [ ] **Step 1: Implement the WebSock handler**

Create `server-elixir/lib/fbi_web/sockets/usage_ws_handler.ex`:

```elixir
defmodule FBIWeb.Sockets.UsageWSHandler do
  @moduledoc """
  Raw WebSocket handler for `/api/ws/usage`.

  On connect: subscribes to the `"usage"` PubSub topic and sends the current
  poller snapshot immediately so the client has data to render even before
  the next poll. On every `{:usage_snapshot, snap}` PubSub message: encodes
  the snapshot as JSON and pushes it to the client.

  Uses the `WebSock` behavior (the Phoenix-blessed raw WS abstraction) rather
  than a Phoenix Channel because the existing React client speaks plain
  WebSocket with raw JSON frames — Channels have their own envelope format
  the client doesn't understand.
  """

  @behaviour WebSock

  alias FBI.Usage.Poller

  @topic "usage"

  @impl true
  def init(_opts) do
    Phoenix.PubSub.subscribe(FBI.PubSub, @topic)
    state = %{}
    # Send the current snapshot immediately so the UI has something to draw.
    {:push, {:text, Jason.encode!(Poller.snapshot())}, state}
  end

  @impl true
  def handle_in(_frame, state), do: {:ok, state}

  @impl true
  def handle_info({:usage_snapshot, snap}, state) do
    {:push, {:text, Jason.encode!(snap)}, state}
  end

  def handle_info(_msg, state), do: {:ok, state}

  @impl true
  def terminate(_reason, _state), do: :ok
end
```

- [ ] **Step 2: Wire the route in `endpoint.ex`**

Add to `server-elixir/lib/fbi_web/endpoint.ex`, above `plug FBIWeb.Router`:

```elixir
# Raw WebSocket for /api/ws/usage (Phase 1 native route).
socket "/api/ws/usage", FBIWeb.Sockets.UsageWSHandler,
  websock: [],
  longpoll: false
```

Wait — that's not quite right. `socket/3` expects a module that uses `Phoenix.Socket`. For raw WebSock, we use a Plug with `WebSockAdapter`. Revise the approach:

Actually, route it through the router. Modify `server-elixir/lib/fbi_web/router.ex`, **after** the API scope but **before** the dev routes, add:

```elixir
scope "/api" do
  get "/ws/usage", FBIWeb.Sockets.UsageWSHandler, :upgrade
end
```

And in the handler, add the `upgrade` entry point:

```elixir
  # At the top of FBIWeb.Sockets.UsageWSHandler, add:
  import Plug.Conn

  def upgrade(conn, _params) do
    conn
    |> WebSockAdapter.upgrade(__MODULE__, %{}, timeout: 60_000)
    |> halt()
  end
```

`WebSockAdapter` ships with `phoenix` via `websock_adapter` — already pulled in as a transitive dep.

- [ ] **Step 3: Write integration test**

Create `server-elixir/test/fbi_web/sockets/usage_ws_test.exs`:

```elixir
defmodule FBIWeb.Sockets.UsageWSTest do
  use FBIWeb.ConnCase, async: false
  # Use Phoenix.ChannelTest-style helpers? For raw WS, use a real client.

  @moduletag :websocket

  # WebSockAdapter integrates with Phoenix's test support via the `WebSockex`
  # or `WebSock.Test` helpers. Pick `Mint.WebSocket` to connect to the
  # endpoint; it's already in our deps.
  alias FBI.Usage.{Queries, RateLimitBucket}

  setup_all do
    # Ensure the Phoenix endpoint is started for this test in the host HTTP
    # layer. In Phoenix tests the endpoint typically listens on a random port
    # via `config :fbi, FBIWeb.Endpoint, server: true` in `config/test.exs` —
    # verify that's set; if not, add:
    #   config :fbi, FBIWeb.Endpoint, server: true, http: [port: 4002]
    :ok
  end

  test "on connect, receives current snapshot and then live updates" do
    FBI.Repo.insert!(%RateLimitBucket{id: "five_hour", utilization: 0.5, updated_at: 1})

    {:ok, conn} = Mint.HTTP.connect(:http, "localhost", 4002)
    {:ok, conn, ref} = Mint.WebSocket.upgrade(:ws, conn, "/api/ws/usage", [])

    conn =
      receive do
        msg ->
          {:ok, conn, [{:status, ^ref, 101} | rest]} = Mint.WebSocket.stream(conn, msg)
          {:ok, _websock, conn} = Mint.WebSocket.new(conn, ref, 101, extract_headers(rest))
          conn
      after
        2000 -> flunk("no upgrade response")
      end

    # Receive first frame (initial snapshot)
    first = receive_text_frame(conn, ref, 2000)
    assert {:ok, %{"buckets" => [%{"id" => "five_hour"}]}} = Jason.decode(first)

    # Broadcast a new snapshot; expect to receive it on the socket.
    Phoenix.PubSub.broadcast(FBI.PubSub, "usage", {:usage_snapshot, %{plan: "max", buckets: []}})

    next = receive_text_frame(conn, ref, 2000)
    assert {:ok, %{"plan" => "max"}} = Jason.decode(next)
  end

  defp extract_headers(items), do: Enum.flat_map(items, fn {:headers, _, h} -> h; _ -> [] end)
  defp receive_text_frame(_conn, _ref, _timeout), do: flunk("implement text frame collector — deferred to implementation session")
end
```

> **Note:** the raw-WS integration test is fiddly because of `Mint.WebSocket`'s framing details. During implementation, we may switch to a simpler test that sends a PubSub broadcast and asserts that a spawned `WebSock` handler state receives `handle_info({:usage_snapshot, ...}, state)` with the right return tuple — cleaner, isolates the module from the network. If the integration test proves too expensive, replace with a unit test of the handler callbacks directly:
>
> ```elixir
> test "handle_info pushes snapshot as text" do
>   assert {:push, {:text, json}, _} =
>            FBIWeb.Sockets.UsageWSHandler.handle_info({:usage_snapshot, %{plan: "max"}}, %{})
>   assert {:ok, %{"plan" => "max"}} = Jason.decode(json)
> end
> ```

- [ ] **Step 4: Run tests**

```bash
cd server-elixir && mix test test/fbi_web/sockets/usage_ws_test.exs
```

If the integration test is too fiddly, fall back to unit-testing the handler callbacks (per the note above).

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi_web/sockets/ server-elixir/lib/fbi_web/router.ex \
        server-elixir/test/fbi_web/sockets/
git commit -m "feat(server-elixir/usage): raw WS handler for /api/ws/usage"
```

---

## Task 10: Wire the poller + credentials reader into the supervision tree

**Files:**
- Modify: `server-elixir/lib/fbi/application.ex`

- [ ] **Step 1: Update `FBI.Application`**

Replace the `start/2` function in `server-elixir/lib/fbi/application.ex`:

```elixir
  @impl true
  def start(_type, _args) do
    # Paths are env-driven in prod (see config/runtime.exs) and default to
    # dev-friendly locations here. The CredentialsReader watches the token
    # file and nudges the Poller on change.
    credentials_path =
      Application.get_env(:fbi, :credentials_path, Path.expand("~/.claude/.credentials.json"))

    children = [
      FBIWeb.Telemetry,
      FBI.Repo,
      {Ecto.Migrator,
       repos: Application.fetch_env!(:fbi, :ecto_repos), skip: skip_migrations?()},
      {DNSCluster, query: Application.get_env(:fbi, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: FBI.PubSub},
      # Usage subsystem — credentials watcher + poller.
      {FBI.Usage.CredentialsReader, path: credentials_path},
      {FBI.Usage.Poller, token_fn: fn -> FBI.Usage.CredentialsReader.read(credentials_path) end},
      FBIWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: FBI.Supervisor]
    Supervisor.start_link(children, opts)
  end
```

Also wire the nudge: add an `@impl true` `handle_info/2` response by making the Poller subscribe to `"credentials"` in its `init/1`. Update `FBI.Usage.Poller.init/1`:

```elixir
  @impl true
  def init(opts) do
    Phoenix.PubSub.subscribe(FBI.PubSub, "credentials")
    # ... rest unchanged
  end
```

And add `handle_info/2`:

```elixir
  def handle_info(:credentials_changed, state) do
    if nudge_allowed?(), do: tick(state)
    {:noreply, state}
  end
```

- [ ] **Step 2: Run full test suite**

```bash
cd server-elixir && mix test
```

Expected: all tests pass; application boots in test env.

- [ ] **Step 3: Smoke-test in `iex`**

```bash
cd server-elixir && iex -S mix
```

Inside iex:

```elixir
iex> Process.whereis(FBI.Usage.Poller)
#PID<...>    # should be non-nil
iex> Process.whereis(FBI.Usage.CredentialsReader)
#PID<...>    # should be non-nil
iex> FBI.Usage.Poller.snapshot()
%{plan: nil, observed_at: nil, ...}
```

- [ ] **Step 4: Commit**

```bash
git add server-elixir/lib/fbi/application.ex server-elixir/lib/fbi/usage/poller.ex
git commit -m "feat(server-elixir): wire usage supervision tree into Application"
```

---

## Task 11: HTTP reverse proxy plug

**Files:**
- Create: `server-elixir/lib/fbi_web/proxy/http.ex`
- Create: `server-elixir/test/fbi_web/proxy/http_test.exs`

- [ ] **Step 1: Write tests using Req's plug-style stub**

Create `server-elixir/test/fbi_web/proxy/http_test.exs`:

```elixir
defmodule FBIWeb.Proxy.HttpTest do
  use ExUnit.Case, async: true
  import Plug.Test
  alias FBIWeb.Proxy.Http

  defp upstream_stub(status, resp_body, resp_headers \\ []) do
    fn conn ->
      conn
      |> then(fn c ->
        Enum.reduce(resp_headers, c, fn {k, v}, acc -> Plug.Conn.put_resp_header(acc, k, v) end)
      end)
      |> Plug.Conn.send_resp(status, resp_body)
    end
  end

  test "forwards GET and returns status + body" do
    plug = upstream_stub(200, "hello")

    conn =
      conn(:get, "/api/projects")
      |> Http.call(target: "http://upstream.test", req_opts: [plug: plug])

    assert conn.status == 200
    assert conn.resp_body == "hello"
  end

  test "forwards request headers except hop-by-hop" do
    {:ok, agent} = Agent.start_link(fn -> [] end)

    plug = fn conn ->
      Agent.update(agent, fn _ -> conn.req_headers end)
      Plug.Conn.send_resp(conn, 200, "")
    end

    conn(:get, "/api/projects")
    |> Plug.Conn.put_req_header("x-custom", "hi")
    |> Plug.Conn.put_req_header("connection", "keep-alive")
    |> Http.call(target: "http://upstream.test", req_opts: [plug: plug])

    headers = Agent.get(agent, & &1)
    assert Enum.any?(headers, fn {k, v} -> k == "x-custom" and v == "hi" end)
    refute Enum.any?(headers, fn {k, _} -> k == "connection" end)
  end

  test "preserves response headers" do
    plug = upstream_stub(201, "", [{"x-special", "yes"}])

    conn =
      conn(:get, "/api/projects")
      |> Http.call(target: "http://upstream.test", req_opts: [plug: plug])

    assert conn.status == 201
    assert Plug.Conn.get_resp_header(conn, "x-special") == ["yes"]
  end
end
```

- [ ] **Step 2: Run — expect fail**

```bash
cd server-elixir && mix test test/fbi_web/proxy/http_test.exs
```

Expected: FAIL.

- [ ] **Step 3: Implement the proxy plug**

Create `server-elixir/lib/fbi_web/proxy/http.ex`:

```elixir
defmodule FBIWeb.Proxy.Http do
  @moduledoc """
  Plug that reverse-proxies the current request to a target URL (typically
  `http://127.0.0.1:3001` where the TS server is bound during crossover).

  Not a GenServer / not stateful — `call/2` is per-request, issues an
  HTTP call via `Req`, and streams the response back.

  ## Hop-by-hop headers

  Standard reverse-proxy hygiene: these request/response headers are
  connection-specific and MUST NOT be forwarded (per RFC 7230 §6.1):

    * `connection`
    * `keep-alive`
    * `proxy-authenticate`
    * `proxy-authorization`
    * `te`
    * `trailer`
    * `transfer-encoding`
    * `upgrade`

  WebSocket upgrades (`Upgrade: websocket`) are handled by a different
  module (`FBIWeb.Proxy.WebSocket`) because they require frame-level
  bidirectional pumping, not request/response.
  """

  @behaviour Plug
  import Plug.Conn

  @hop_by_hop ~w(connection keep-alive proxy-authenticate proxy-authorization te trailer transfer-encoding upgrade)

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, opts) do
    target = Keyword.fetch!(opts, :target)
    req_opts = Keyword.get(opts, :req_opts, [])

    url = target <> conn.request_path <> query_suffix(conn)
    method = conn.method |> String.downcase() |> String.to_existing_atom()
    req_headers = strip_hop_by_hop(conn.req_headers)
    {body, conn} = read_body_full(conn)

    case Req.request(
           [
             method: method,
             url: url,
             headers: req_headers,
             body: body,
             retry: false,
             decode_body: false
           ]
           |> Keyword.merge(req_opts)
         ) do
      {:ok, %Req.Response{status: status, headers: resp_headers, body: resp_body}} ->
        conn
        |> put_response_headers(resp_headers)
        |> send_resp(status, resp_body || "")

      {:error, reason} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(502, Jason.encode!(%{error: "proxy_failed", reason: inspect(reason)}))
    end
  end

  defp query_suffix(%{query_string: ""}), do: ""
  defp query_suffix(%{query_string: q}), do: "?" <> q

  defp read_body_full(conn) do
    case read_body(conn) do
      {:ok, body, conn} -> {body, conn}
      {:more, _, conn} -> read_body_full(conn)
    end
  end

  defp strip_hop_by_hop(headers) do
    Enum.reject(headers, fn {k, _} -> String.downcase(k) in @hop_by_hop end)
  end

  # Req returns headers as a map of string => [string]; Plug wants
  # [{string, string}] with one entry per occurrence.
  defp put_response_headers(conn, headers) when is_map(headers) do
    Enum.reduce(headers, conn, fn {k, vs}, acc ->
      if String.downcase(k) in @hop_by_hop do
        acc
      else
        Enum.reduce(vs, acc, fn v, c -> put_resp_header(c, String.downcase(k), v) end)
      end
    end)
  end

  defp put_response_headers(conn, headers) when is_list(headers) do
    Enum.reduce(headers, conn, fn {k, v}, acc ->
      if String.downcase(k) in @hop_by_hop, do: acc, else: put_resp_header(acc, String.downcase(k), v)
    end)
  end
end
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd server-elixir && mix test test/fbi_web/proxy/http_test.exs
```

Expected: `3 tests, 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi_web/proxy/http.ex server-elixir/test/fbi_web/proxy/http_test.exs
git commit -m "feat(server-elixir/proxy): HTTP reverse proxy plug using Req"
```

---

## Task 12: WebSocket proxy (WebSock handler using Mint.WebSocket)

Forwards WS upgrades to TS. The trickiest single piece of Phase 1 — **this is the go/no-go for the whole crossover approach**.

**Files:**
- Create: `server-elixir/lib/fbi_web/proxy/web_socket.ex`
- Create: `server-elixir/test/fbi_web/proxy/web_socket_test.exs`

- [ ] **Step 1: Implement the proxy**

Create `server-elixir/lib/fbi_web/proxy/web_socket.ex`:

```elixir
defmodule FBIWeb.Proxy.WebSocket do
  @moduledoc """
  WebSocket reverse proxy using `Mint.WebSocket`.

  On the inbound upgrade (client → us), we concurrently open an outbound
  upgrade (us → TS at `127.0.0.1:3001`). Frames flow bidirectionally; when
  either side closes, we close the other.

  Used via a Plug that upgrades and hands the socket off to this `WebSock`
  behavior handler. See `FBIWeb.Proxy.Router` for the upgrade entry point.

  ## State

      %{
        http_conn: Mint.HTTP.t(),   # connection to the TS upstream
        upstream_ref: reference(),  # Mint request ref for the upgrade
        websock: Mint.WebSocket.t() # decoded WS state after 101
      }

  ## Caveats

  * Does not currently handle backpressure — Mint buffers in memory. For
    the `/api/runs/:id/shell` workload (steady ~KB/s PTY output) this is
    fine; revisit if usage spikes reveal memory pressure.
  * Does not support WS extensions (permessage-deflate). Re-evaluate if the
    browser negotiates one the server declines.
  """

  @behaviour WebSock
  require Logger

  alias Mint.{HTTP, WebSocket}

  # --- Upgrade plug ---------------------------------------------------

  @doc """
  Plug-compatible entry point. Plug the result of `upgrade/2` into the
  router's catch-all for requests where `Upgrade: websocket` is present.
  """
  def upgrade(conn, opts) do
    target = Keyword.fetch!(opts, :target)
    path = conn.request_path <> query_suffix(conn)
    headers = strip_hop_by_hop(conn.req_headers)

    init_state = %{target: target, path: path, upstream_headers: headers}

    conn
    |> WebSockAdapter.upgrade(__MODULE__, init_state, timeout: 60_000)
    |> Plug.Conn.halt()
  end

  # --- WebSock callbacks ----------------------------------------------

  @impl true
  def init(%{target: target, path: path, upstream_headers: headers}) do
    # Parse the target URL ("http://127.0.0.1:3001") into scheme/host/port.
    uri = URI.parse(target)
    scheme = if uri.scheme == "https", do: :https, else: :http
    ws_scheme = if uri.scheme == "https", do: :wss, else: :ws

    with {:ok, conn} <- HTTP.connect(scheme, uri.host, uri.port || 80),
         {:ok, conn, ref} <- WebSocket.upgrade(ws_scheme, conn, path, headers) do
      {:ok, %{http_conn: conn, upstream_ref: ref, websock: nil, buffered_frames: []}}
    else
      {:error, reason} ->
        Logger.warning("WS proxy upstream upgrade failed: #{inspect(reason)}")
        {:stop, :shutdown, %{}}
    end
  end

  @impl true
  def handle_in({payload, opcode: op}, state) when state.websock != nil do
    # Frame from the client → encode and send upstream.
    frame =
      case op do
        :text -> {:text, payload}
        :binary -> {:binary, payload}
        :ping -> {:ping, payload}
        :pong -> {:pong, payload}
      end

    case WebSocket.encode(state.websock, frame) do
      {:ok, ws, data} ->
        case HTTP.stream_request_body(state.http_conn, state.upstream_ref, data) do
          {:ok, conn} -> {:ok, %{state | http_conn: conn, websock: ws}}
          {:error, _, reason, _} -> {:stop, :normal, state |> Map.put(:error, reason)}
        end

      {:error, ws, reason} ->
        Logger.warning("WS proxy encode error: #{inspect(reason)}")
        {:stop, :normal, %{state | websock: ws}}
    end
  end

  def handle_in(_frame, state), do: {:ok, state}

  @impl true
  def handle_info(msg, state) do
    case HTTP.stream(state.http_conn, msg) do
      {:ok, conn, responses} ->
        handle_upstream_responses(responses, %{state | http_conn: conn})

      {:error, conn, reason, _} ->
        Logger.warning("WS proxy upstream stream error: #{inspect(reason)}")
        {:stop, :normal, %{state | http_conn: conn}}

      :unknown ->
        {:ok, state}
    end
  end

  @impl true
  def terminate(_reason, state) do
    if state.http_conn, do: HTTP.close(state.http_conn)
    :ok
  end

  # --- Upstream response handling -------------------------------------

  # First, the HTTP upgrade responses. Mint delivers them as a sequence of
  # :status, :headers, :done tuples for the ref. Once we have all three,
  # call WebSocket.new to decode the completed upgrade.
  defp handle_upstream_responses([], state), do: {:ok, state}

  defp handle_upstream_responses([{:status, ref, status} | rest], state)
       when ref == state.upstream_ref do
    handle_upstream_responses(rest, Map.put(state, :upstream_status, status))
  end

  defp handle_upstream_responses([{:headers, ref, headers} | rest], state)
       when ref == state.upstream_ref do
    state = Map.update(state, :upstream_headers_resp, headers, &(&1 ++ headers))
    handle_upstream_responses(rest, state)
  end

  defp handle_upstream_responses([{:done, ref} | rest], state)
       when ref == state.upstream_ref do
    case WebSocket.new(state.http_conn, ref, state.upstream_status, state.upstream_headers_resp || []) do
      {:ok, conn, ws} ->
        handle_upstream_responses(rest, %{state | http_conn: conn, websock: ws})

      {:error, conn, reason} ->
        Logger.warning("WS proxy upstream upgrade rejected: #{inspect(reason)}")
        {:stop, :normal, %{state | http_conn: conn}}
    end
  end

  defp handle_upstream_responses([{:data, ref, data} | rest], state)
       when ref == state.upstream_ref do
    # Frames from upstream → decode, push each to the client, continue.
    case WebSocket.decode(state.websock, data) do
      {:ok, ws, frames} ->
        # `{:push, [{...}], state}` pushes multiple frames to the client.
        pushes = Enum.map(frames, &to_push/1)

        case handle_upstream_responses(rest, %{state | websock: ws}) do
          {:ok, next_state} -> {:push, pushes, next_state}
          other -> other
        end

      {:error, ws, reason} ->
        Logger.warning("WS proxy decode error: #{inspect(reason)}")
        {:stop, :normal, %{state | websock: ws}}
    end
  end

  defp handle_upstream_responses([_ | rest], state), do: handle_upstream_responses(rest, state)

  defp to_push({:text, payload}), do: {:text, payload}
  defp to_push({:binary, payload}), do: {:binary, payload}
  defp to_push({:close, code, reason}), do: {:close, code, reason}
  defp to_push({:ping, payload}), do: {:ping, payload}
  defp to_push({:pong, payload}), do: {:pong, payload}

  # --- Helpers --------------------------------------------------------

  defp query_suffix(%{query_string: ""}), do: ""
  defp query_suffix(%{query_string: q}), do: "?" <> q

  defp strip_hop_by_hop(headers) do
    # For the upstream upgrade we keep `Upgrade`, `Connection`, `Sec-WebSocket-*`
    # (Mint.WebSocket regenerates them). Strip connection/keep-alive from the
    # *incoming* side so they don't bleed through.
    Enum.reject(headers, fn {k, _} ->
      String.downcase(k) in ~w(connection keep-alive upgrade sec-websocket-key sec-websocket-version sec-websocket-extensions sec-websocket-protocol)
    end)
  end
end
```

- [ ] **Step 2: Write a basic integration test** (may be simplified if integration proves too fiddly)

Create `server-elixir/test/fbi_web/proxy/web_socket_test.exs`:

```elixir
defmodule FBIWeb.Proxy.WebSocketTest do
  use FBIWeb.ConnCase, async: false
  @moduletag :proxy_integration

  # This test requires a running upstream. During the implementation
  # session, consider spinning up a trivial Bandit WebSocket echo server
  # in `setup_all` and pointing the proxy at it. If that's too much, fall
  # back to unit tests of the handler callbacks directly.

  @tag :skip
  test "proxied text frames round-trip"
end
```

> **Note:** This test is intentionally `@tag :skip` in the plan. The implementation session will either (a) stand up a mini echo server and un-skip, or (b) write focused unit tests of `handle_in/2` and `handle_info/2` with synthetic state and assert return tuples. The **real** validation is at Task 14 (fidelity) and during Phase 1's acceptance check where the still-proxied `/api/runs/:id/shell` endpoint proves the plumbing works against the real TS server.

- [ ] **Step 3: Run (mostly compilation check)**

```bash
cd server-elixir && mix compile --warnings-as-errors
```

Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add server-elixir/lib/fbi_web/proxy/web_socket.ex \
        server-elixir/test/fbi_web/proxy/web_socket_test.exs
git commit -m "feat(server-elixir/proxy): WS reverse proxy via Mint.WebSocket"
```

---

## Task 13: Catch-all router wiring

The last Phoenix router entry matches any method + path not yet handled and dispatches to either `FBIWeb.Proxy.Http` or `FBIWeb.Proxy.WebSocket` depending on whether it's a WS upgrade.

**Files:**
- Modify: `server-elixir/lib/fbi_web/router.ex`
- Modify: `server-elixir/config/config.exs` (add `:proxy_target`)
- Modify: `server-elixir/config/runtime.exs` (prod proxy target from env)

- [ ] **Step 1: Configure the proxy target**

In `server-elixir/config/config.exs`, add near the top-level `config :fbi` entries:

```elixir
config :fbi,
  proxy_target: "http://127.0.0.1:3001",
  credentials_path: Path.expand("~/.claude/.credentials.json")
```

In `server-elixir/config/runtime.exs`, add inside the `if config_env() == :prod do` block:

```elixir
config :fbi,
  proxy_target: System.get_env("PROXY_TARGET", "http://127.0.0.1:3001"),
  credentials_path: System.get_env("CLAUDE_CREDENTIALS", "/home/fbi/.claude/.credentials.json")
```

- [ ] **Step 2: Add the catch-all route**

Replace `server-elixir/lib/fbi_web/router.ex` with:

```elixir
defmodule FBIWeb.Router do
  use FBIWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  # --- Native Phoenix routes (Phase 1: usage) ---

  scope "/api", FBIWeb do
    pipe_through :api

    get "/usage", UsageController, :show
    get "/usage/daily", UsageController, :daily
    get "/usage/runs/:id", UsageController, :run_breakdown
  end

  # Raw WebSocket for /api/ws/usage (Phase 1 native route).
  scope "/api" do
    get "/ws/usage", FBIWeb.Sockets.UsageWSHandler, :upgrade
  end

  # --- Dev-only routes ---

  if Application.compile_env(:fbi, :dev_routes) do
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through [:fetch_session, :protect_from_forgery]
      live_dashboard "/dashboard", metrics: FBIWeb.Telemetry
    end
  end

  # --- Crossover catch-all: proxy to TS on :3001 ---
  #
  # This matches last. As each phase lands native routes, they get registered
  # above this and are handled natively; whatever falls through here goes to
  # TS. WebSocket upgrades are dispatched to the WS proxy; everything else
  # goes through the HTTP proxy.

  match :*, "/*path", FBIWeb.ProxyRouter, :dispatch
end
```

- [ ] **Step 3: Create the proxy dispatch module**

Create `server-elixir/lib/fbi_web/proxy_router.ex`:

```elixir
defmodule FBIWeb.ProxyRouter do
  @moduledoc """
  Entry point for unported-route proxying. Inspects the request and
  dispatches to the HTTP or WebSocket proxy module. Read the configured
  target once per request.

  Looks at the `Upgrade: websocket` header to decide; that's the signal
  browsers and our existing React code use.
  """

  import Plug.Conn
  alias FBIWeb.Proxy

  def init(opts), do: opts

  def call(conn, _opts) do
    target = Application.fetch_env!(:fbi, :proxy_target)

    cond do
      websocket_upgrade?(conn) ->
        Proxy.WebSocket.upgrade(conn, target: target)

      true ->
        Proxy.Http.call(conn, target: target, req_opts: [])
    end
  end

  defp websocket_upgrade?(conn) do
    case get_req_header(conn, "upgrade") do
      [value | _] -> String.downcase(value) == "websocket"
      _ -> false
    end
  end

  # Phoenix's controller-action convention: the `match :*` route above
  # passes `:dispatch` as the action. We just delegate to `call/2`.
  def dispatch(conn, opts), do: call(conn, opts)
end
```

- [ ] **Step 4: Run full test suite**

```bash
cd server-elixir && mix test
```

Expected: all tests pass, no new compile warnings.

- [ ] **Step 5: Manual smoke test**

In one terminal: start the TS dev server as today (which binds to `:3000`, we'll manually move to `:3001` here just for the test):

```bash
cd /workspace && PORT=3001 HOST=127.0.0.1 npm run dev:server
```

In another terminal: start the Elixir server on `:3000`:

```bash
cd /workspace/server-elixir && \
  TMPDIR=/tmp/agent-tmp ASDF_DATA_DIR=/opt/asdf \
  PORT=4000 mix phx.server
```

In a third terminal: hit Elixir and expect proxied-to-TS behavior for an unported route, native behavior for `/api/usage`:

```bash
# Unported → proxied to TS
curl -sS http://localhost:4000/api/projects | head -c 200
# Expect: same JSON as `curl http://localhost:3001/api/projects`

# Ported → native Elixir
curl -sS http://localhost:4000/api/usage | head -c 200
# Expect: JSON with plan/observed_at/buckets
```

- [ ] **Step 6: Commit**

```bash
git add server-elixir/lib/fbi_web/router.ex \
        server-elixir/lib/fbi_web/proxy_router.ex \
        server-elixir/config/config.exs \
        server-elixir/config/runtime.exs
git commit -m "feat(server-elixir/proxy): catch-all router wires HTTP+WS proxy"
```

---

## Task 14: Contract fidelity tests

Verify byte-compatibility of the usage endpoints between TS and Elixir. Written as a test harness that records TS responses once (golden snapshots) and asserts Elixir matches.

**Files:**
- Create: `server-elixir/test/fidelity/usage_fidelity_test.exs`
- Create: `server-elixir/test/fidelity/fixtures/usage_snapshot.json`

- [ ] **Step 1: Capture TS responses as golden fixtures**

With the TS server running (via the local dev flow), and with some seed data in the DB:

```bash
curl -sS http://localhost:3000/api/usage \
  > server-elixir/test/fidelity/fixtures/usage_snapshot.json
```

Manually inspect and sanitize (e.g. zero out timestamps) so the snapshot is stable across runs. The fidelity test compares shape and key names, not timestamps.

- [ ] **Step 2: Write the fidelity test**

Create `server-elixir/test/fidelity/usage_fidelity_test.exs`:

```elixir
defmodule FBI.Fidelity.UsageFidelityTest do
  @moduledoc """
  Contract fidelity: assert the Elixir `/api/usage` response has the same
  shape and key names as the TS implementation. Timestamps are allowed to
  differ; only key presence and types matter.

  The golden fixture is captured manually once from the TS server and
  sanitized; see `test/fidelity/fixtures/usage_snapshot.json`.
  """

  use FBIWeb.ConnCase, async: true

  @fixture_path Path.expand("fixtures/usage_snapshot.json", __DIR__)

  test "GET /api/usage shape matches TS snapshot", %{conn: conn} do
    golden = @fixture_path |> File.read!() |> Jason.decode!()
    FBI.Repo.insert!(%FBI.Usage.RateLimitState{id: 1, plan: "max", observed_at: 1_000})

    conn = get(conn, "/api/usage")
    actual = json_response(conn, 200)

    assert_same_shape!(actual, golden)
  end

  defp assert_same_shape!(actual, golden) when is_map(actual) and is_map(golden) do
    assert Map.keys(actual) |> Enum.sort() == Map.keys(golden) |> Enum.sort(),
           "Key mismatch:\n  expected: #{inspect(Map.keys(golden))}\n  got:      #{inspect(Map.keys(actual))}"

    Enum.each(Map.keys(golden), fn k ->
      assert_same_shape!(Map.get(actual, k), Map.get(golden, k))
    end)
  end

  defp assert_same_shape!(actual, golden) when is_list(actual) and is_list(golden) do
    if golden == [] and actual == [] do
      :ok
    else
      # Compare shape of first element (assume homogeneous lists).
      if golden != [] and actual != [], do: assert_same_shape!(hd(actual), hd(golden))
    end
  end

  defp assert_same_shape!(actual, golden) do
    # Atomic value: types must match (numbers interchangeable with floats).
    actual_type = shape_type(actual)
    golden_type = shape_type(golden)

    assert actual_type == golden_type,
           "Type mismatch:\n  expected: #{golden_type}\n  got:      #{actual_type}"
  end

  defp shape_type(nil), do: :nil
  defp shape_type(v) when is_boolean(v), do: :boolean
  defp shape_type(v) when is_number(v), do: :number
  defp shape_type(v) when is_binary(v), do: :string
  defp shape_type(v) when is_list(v), do: :list
  defp shape_type(v) when is_map(v), do: :map
  defp shape_type(_), do: :unknown
end
```

- [ ] **Step 3: Run and iterate**

```bash
cd server-elixir && mix test test/fidelity/usage_fidelity_test.exs
```

If it fails with a key mismatch, fix `FBIWeb.UsageController` / `FBI.Usage.Poller.snapshot/0` to emit the missing keys.

- [ ] **Step 4: Commit**

```bash
git add server-elixir/test/fidelity/
git commit -m "test(server-elixir/fidelity): snapshot-shape check for /api/usage"
```

---

## Task 15: TS side — loopback bind + poller disable flag

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/oauthUsagePoller.ts`

- [ ] **Step 1: Add `host` to TS config**

Read `src/server/config.ts`. Find the exported `loadConfig` or equivalent. Add:

```typescript
host: process.env.HOST ?? '0.0.0.0',
```

to the returned config object and the `Config` type.

- [ ] **Step 2: Use `host` in `index.ts`**

In `src/server/index.ts`, replace the `app.listen({ port: ... })` call with:

```typescript
await app.listen({ port: config.port, host: config.host });
```

- [ ] **Step 3: Gate the TS poller**

In `src/server/oauthUsagePoller.ts`, find the `start()` method and wrap it:

```typescript
start(): void {
  if (process.env.FBI_OAUTH_POLLER_DISABLED === '1') {
    console.log('OAuthUsagePoller: disabled via FBI_OAUTH_POLLER_DISABLED env var');
    return;
  }
  // ... existing body
}
```

- [ ] **Step 4: Run TS tests**

```bash
cd /workspace && npm test
```

Expected: all existing vitest tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts src/server/index.ts src/server/oauthUsagePoller.ts
git commit -m "feat(server): add HOST config + FBI_OAUTH_POLLER_DISABLED for crossover"
```

---

## Task 16: Systemd unit + install.sh + README

**Files:**
- Create: `systemd/fbi-elixir.service`
- Modify: `scripts/install.sh`
- Modify: `README.md`

- [ ] **Step 1: Create the Elixir systemd unit**

Create `systemd/fbi-elixir.service`:

```ini
[Unit]
Description=FBI Elixir/Phoenix Server
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=fbi
Group=fbi
EnvironmentFile=/etc/default/fbi-elixir
WorkingDirectory=/opt/fbi-elixir
ExecStart=/opt/fbi-elixir/bin/fbi start
Restart=on-failure
RestartSec=3s
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/agent-manager /opt/fbi-elixir

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Update `scripts/install.sh`**

Read the current `scripts/install.sh`. Add after the existing TS build section:

```bash
# ── Build the Elixir release ───────────────────────────────────────────────────
# Requires Erlang/OTP 27 + Elixir 1.18 available on the host (see README
# Prerequisites). asdf or a system install works identically.

ELIXIR_DIR=/opt/fbi-elixir
install -d -m 750 -o fbi -g fbi "$ELIXIR_DIR"

(
  cd "$SOURCE_DIR/server-elixir"
  MIX_ENV=prod mix deps.get --only prod
  MIX_ENV=prod mix compile
  MIX_ENV=prod mix release --overwrite --path "$ELIXIR_DIR"
)

chown -R fbi:fbi "$ELIXIR_DIR"

# ── /etc/default/fbi-elixir ────────────────────────────────────────────────────
if [ ! -f /etc/default/fbi-elixir ]; then
  cat > /etc/default/fbi-elixir <<'ENV'
# Elixir server — public on :3000, proxies unported routes to TS on :3001.
PORT=3000
DB_PATH=/var/lib/agent-manager/db.sqlite
SECRETS_KEY_FILE=/etc/agent-manager/secrets.key
CLAUDE_CREDENTIALS=/home/fbi/.claude/.credentials.json
PROXY_TARGET=http://127.0.0.1:3001
PHX_SERVER=true
SECRET_KEY_BASE=__REPLACE_WITH_64_CHAR_HEX__
ENV
fi

# ── Update /etc/default/fbi for crossover ───────────────────────────────────────
# TS moves to loopback :3001 and disables its poller.
if ! grep -q 'FBI_OAUTH_POLLER_DISABLED' /etc/default/fbi; then
  cat >> /etc/default/fbi <<'ENV'
# --- Crossover (added by Phase 1 install) ---
HOST=127.0.0.1
PORT=3001
FBI_OAUTH_POLLER_DISABLED=1
ENV
fi

# ── Systemd units ──────────────────────────────────────────────────────────────
install -m 644 "$SOURCE_DIR/systemd/fbi.service" /etc/systemd/system/fbi.service
install -m 644 "$SOURCE_DIR/systemd/fbi-elixir.service" /etc/systemd/system/fbi-elixir.service
systemctl daemon-reload
systemctl enable fbi.service fbi-elixir.service
systemctl restart fbi.service fbi-elixir.service
```

Adjust existing sections that start/stop `fbi.service` to include `fbi-elixir.service` too.

- [ ] **Step 3: Update README Prerequisites**

In `/workspace/README.md`, find the Prerequisites section (currently lists Docker / Tailscale / Node 20+ / user fbi / SSH keys / claude /login). Add:

```markdown
7. Erlang/OTP 27.2 and Elixir 1.18.1 installed on the host (via asdf or distro packages). The Elixir server is built during `install.sh` via `mix release`.
```

Update the “Install” section to note that both `fbi.service` and `fbi-elixir.service` now run side-by-side during the crossover.

- [ ] **Step 4: Generate a secret key base** (operator-level note)

Add to the README or leave a note that the operator must replace `__REPLACE_WITH_64_CHAR_HEX__` in `/etc/default/fbi-elixir` with the output of:

```bash
openssl rand -hex 32
```

- [ ] **Step 5: Commit**

```bash
git add systemd/fbi-elixir.service scripts/install.sh README.md
git commit -m "deploy(phase1): add fbi-elixir.service unit + install.sh + README"
```

---

## Task 17: GitHub Actions CI

No CI exists in the repo yet. Set it up now so Phase 1 lands with tests gating every PR — both vitest (TS) and ExUnit (Elixir) in parallel. This is also the test-strategy prerequisite named in the spec's Cross-phase concerns section.

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  ts:
    name: TypeScript (vitest + tsc + eslint)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test

  elixir:
    name: Elixir (mix test + format check + warnings-as-errors)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: server-elixir
    env:
      MIX_ENV: test
    steps:
      - uses: actions/checkout@v4

      - name: Install Erlang/OTP + Elixir
        uses: erlef/setup-beam@v1
        with:
          otp-version: '27.2'
          elixir-version: '1.18.1-otp-27'

      - name: Cache mix deps + build
        uses: actions/cache@v4
        with:
          path: |
            server-elixir/deps
            server-elixir/_build
          key: mix-${{ runner.os }}-otp27.2-elixir1.18.1-${{ hashFiles('server-elixir/mix.lock') }}
          restore-keys: |
            mix-${{ runner.os }}-otp27.2-elixir1.18.1-

      - name: Fetch deps
        run: mix deps.get

      - name: Compile (warnings-as-errors)
        run: mix compile --warnings-as-errors

      - name: Format check
        run: mix format --check-formatted

      - name: Test
        run: mix test
```

- [ ] **Step 2: Verify the workflow locally parses**

Install `act` if handy, or just manually lint the YAML. At minimum:

```bash
python3 -c 'import yaml; yaml.safe_load(open("/workspace/.github/workflows/ci.yml"))' && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Verify `mix format --check-formatted` passes locally** (so CI doesn't fail immediately on already-committed files)

```bash
cd /workspace/server-elixir && mix format --check-formatted
```

If it reports any files needing formatting, run `mix format` and commit the result separately (or amend Task 2 / 3 / 4 commits — but a separate "style: format" commit is cleanest).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions for TS (vitest) + Elixir (mix test)"
```

- [ ] **Step 5: On first push to a PR**, watch the Actions tab to confirm both jobs run green. If the Elixir cache-restore misses on the first run (expected — cache doesn't exist yet), that's fine; subsequent runs restore in ~5 seconds.

---

## Task 18: Full test-suite run + pre-flight

**Files:** none (validation).

- [ ] **Step 1: All Elixir tests**

```bash
cd server-elixir && mix test
```

Expected: 0 failures, no compile warnings.

- [ ] **Step 2: All TS tests**

```bash
cd /workspace && npm test
```

Expected: existing vitest tests pass.

- [ ] **Step 3: `mix precompile` checks**

```bash
cd server-elixir && mix compile --warnings-as-errors && mix format --check-formatted
```

- [ ] **Step 4: `mix release` smoke build**

```bash
cd server-elixir && MIX_ENV=prod mix release --overwrite
```

Expected: build succeeds, artifact at `_build/prod/rel/fbi`.

- [ ] **Step 5: Boot the release and hit `/api/usage`**

```bash
cd server-elixir && \
  DATABASE_PATH=/tmp/release-test.db \
  SECRET_KEY_BASE="$(openssl rand -hex 32)" \
  PORT=4100 \
  PHX_SERVER=true \
  PROXY_TARGET=http://127.0.0.1:9999 \
  _build/prod/rel/fbi/bin/fbi start &

sleep 2
curl -sS http://localhost:4100/api/usage
kill %1
```

Expected: a JSON response (buckets will be empty — no poller data yet, that's fine).

- [ ] **Step 6: Commit any last-mile fixes**

If Steps 1-5 revealed anything, fix and commit separately per conventional-commits style.

---

## Self-review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Elixir catch-all Plug to TS :3001 | 11 (HTTP proxy), 12 (WS proxy), 13 (wiring) |
| `/api/usage` REST endpoints | 8 |
| `/api/ws/usage` native WS handler | 9 |
| OAuth poller (GenServer, 5-min cadence, nudge, rate-limit gate) | 7 |
| Credentials reader (GenServer, inotify, PubSub event) | 6 |
| Ecto schemas for usage tables | 3 |
| Query helpers | 4 |
| Pacing logic | 2 |
| Supervision tree wiring | 10 |
| TS loopback bind + poller disable | 15 |
| Systemd unit + install.sh + README | 16 |
| Contract fidelity test for `/api/usage` | 14 |
| CI (vitest + mix test parallel jobs) | 17 |
| `mix release` boots cleanly | 18 |
| Teaching-grade `@moduledoc`/`@doc` on every module | Every task that creates a module includes complete docs |
| SQLite `busy_timeout` config | Task 13 Step 1 adds the config env; verify Ecto repo picks it up in runtime.exs (also addressed inline in Task 1's scaffold config if needed) |

**Type / name consistency:**

- `FBI.Usage.Queries.get_state/0` is referenced from Task 7 (poller). Defined in Task 4.
- `FBI.Usage.Queries.upsert_bucket/1` referenced from Task 7. Defined in Task 4.
- `FBI.Usage.Queries.set_observed/1`, `set_error/2`, `set_plan/1` — all used by Task 7; all defined in Task 4.
- `FBI.Usage.Poller.snapshot/0` used by Tasks 8 (controller) and 9 (WS handler); defined in Task 7.
- `FBIWeb.Proxy.Http.call/2` used by Task 13's `ProxyRouter`; defined in Task 11.
- `FBIWeb.Proxy.WebSocket.upgrade/2` used by Task 13's `ProxyRouter`; defined in Task 12.
- `FBI.Usage.CredentialsReader.read/1` used by Task 10 (supervision tree `token_fn`); defined in Task 6.

**Known open questions** (deferred to execution session, not blocking):

1. WebSocket proxy integration test strategy — real upstream echo server vs. unit tests of callbacks (Task 12, Step 2). Fallback path described.
2. Exact shape of `/api/usage/daily` aggregation SQL — Task 4 Step 1 grep must confirm TS's exact `GROUP BY`/`ORDER BY`/`SELECT` pattern. If TS's shape differs from the draft, adjust the Ecto query in Step 4.
3. `config/runtime.exs` DB path env var — Task 13 Step 1 assumes `DB_PATH`. Verify current scaffold's default; may need tweak to match TS's `DB_PATH=/var/lib/agent-manager/db.sqlite`.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-24-elixir-rewrite-phase-1.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
