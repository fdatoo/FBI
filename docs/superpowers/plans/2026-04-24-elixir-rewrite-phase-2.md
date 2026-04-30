# Elixir Rewrite Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port three TS-owned leaf routes to the Elixir server with byte-compatible responses: `GET /api/settings`, `PATCH /api/settings`, `GET /api/config/defaults`, `GET /api/cli/fbi-tunnel/:os/:arch`. Shrink the TS proxy surface by one module. `POST /api/settings/run-gc` remains proxied to TS because it depends on the orchestrator (Phase 7).

**Architecture:** Three native Plug controllers register in `FBIWeb.Router` *before* the catch-all. Settings read/write goes through an Ecto schema + singleton query module that mirrors the existing SQLite `settings` table (TS is still schema-owner per the migration spec). `/api/config/defaults` reads two env vars with the same split-and-trim semantics as TS. `/api/cli/fbi-tunnel/:os/:arch` streams a binary from disk using `Plug.Conn.send_file/3`, with the same allow-list, headers, and error codes as the TS handler. `POST /api/settings/run-gc` is *deliberately not* registered natively — the catch-all forwards it to TS until Phase 7.

**Tech Stack:**
- Elixir 1.18 / OTP 27 (already pinned by Phase 1 via `.tool-versions`)
- Phoenix 1.8 / Ecto 3.13 / `ecto_sqlite3` (all added in Phase 1)
- `Plug.Conn.send_file/3` for the binary download (built-in, no new deps)

**Spec reference:** `docs/superpowers/specs/2026-04-24-server-rewrite-migration-design.md` — Phase 2 row in the Phase list table.

---

## File structure

### Created (Elixir side)

| Path | Responsibility |
|---|---|
| `server-elixir/lib/fbi/settings/setting.ex` | Ecto schema for the singleton `settings` row (`id = 1`) |
| `server-elixir/lib/fbi/settings/queries.ex` | `get/0` (returns defaults on empty) and `update/1` (merge + write + bump `updated_at`) |
| `server-elixir/lib/fbi/config/defaults.ex` | Pure function: read `FBI_DEFAULT_MARKETPLACES` / `FBI_DEFAULT_PLUGINS` env vars, parse with same rules as TS `parseList` |
| `server-elixir/lib/fbi_web/controllers/settings_controller.ex` | `show/2` (GET) and `update/2` (PATCH with `auto_resume_max_attempts` range validation) |
| `server-elixir/lib/fbi_web/controllers/config_controller.ex` | `defaults/2` (GET) — returns `%{defaultMarketplaces:, defaultPlugins:}` |
| `server-elixir/lib/fbi_web/controllers/cli_controller.ex` | `fbi_tunnel/2` (GET) — allow-list `os`/`arch`, stream file, set headers, emit 400/503 on failure |
| `server-elixir/priv/repo/migrations/20260424000002_create_settings_table.exs` | Dev/test migration mirroring TS's `settings` table after all `ALTER`s from `src/server/db/index.ts` |
| `server-elixir/test/fbi/settings/queries_test.exs` | Unit tests for `Queries.get/0`, `Queries.update/1` |
| `server-elixir/test/fbi/config/defaults_test.exs` | Unit tests for env-var parsing (empty, comma, newline, trim, filter blank) |
| `server-elixir/test/fbi_web/controllers/settings_controller_test.exs` | Controller tests mirroring `src/server/api/settings.test.ts` |
| `server-elixir/test/fbi_web/controllers/config_controller_test.exs` | Controller tests for `/api/config/defaults` |
| `server-elixir/test/fbi_web/controllers/cli_controller_test.exs` | Controller tests mirroring `src/server/api/cli.test.ts` |
| `server-elixir/test/fidelity/settings_fidelity_test.exs` | Golden shape pin for `/api/settings` JSON |
| `server-elixir/test/fidelity/fixtures/settings_snapshot.json` | Canonical response fixture |

### Modified (Elixir side)

| Path | Change |
|---|---|
| `server-elixir/lib/fbi_web/router.ex` | Add four native routes in the existing `scope "/api", FBIWeb` block (before the catch-all). **Do not** add `POST /api/settings/run-gc` — it stays proxied. |
| `server-elixir/config/config.exs` | Add `config :fbi, :cli_dist_dir` default (compile-time fallback: `"dist/cli"`). Also expose `:fbi_cli_version` config key (default `nil`). |
| `server-elixir/config/runtime.exs` | In prod env, read `CLI_DIST_DIR` + `FBI_VERSION` env vars into the same keys. |

### Not modified (intentional)

- **TS side:** no changes. Both implementations coexist during Phase 2 (the spec's rollback invariant). The catch-all in Elixir naturally stops serving these paths because native routes match first; TS still handles them if hit directly on `:3001`, which is fine.
- **Schema ownership:** TS still owns `src/server/db/schema.sql`. The new Elixir migration exists only to set up dev/test databases so `mix test` can run against a real table. Production SQLite is created/migrated by TS's `migrate()`.

---

## Context notes for the engineer

**Why this phase exists:** The spec lists Phase 2 as "Low complexity" — three leaf endpoints with no orchestrator entanglement. Its real job is to rehearse the Phase 1 controller/test patterns on a second module so the team builds fluency before Phase 7 (the orchestrator).

**Pattern to follow (all three controllers):**
1. Controller file at `lib/fbi_web/controllers/<name>_controller.ex` with a full `@moduledoc`, per-action `@doc`, and `@spec`-style behaviour documented in module text.
2. Register routes in the existing `scope "/api", FBIWeb do ... end` block in `router.ex`, before the catch-all.
3. Tests use `FBIWeb.ConnCase, async: true`.
4. See `lib/fbi_web/controllers/usage_controller.ex` and `test/fbi_web/controllers/usage_controller_test.exs` for the exact shape.

**Teaching-grade docs:** Per the spec's cross-phase "Code quality / teaching standard" section, every new module gets a `@moduledoc` explaining its role and why it is a plain module (not a `GenServer`, not a `Supervisor`) — "chosen because no process state is held; pure read-through to `FBI.Repo`." Every public function gets a `@doc` and `@spec`.

**Byte-compat is the bar.** JSON keys, types, status codes, and header names must match the TS implementation exactly. Compare against:
- `src/server/api/settings.ts:9-31` (routes)
- `src/server/db/settings.ts:21-104` (field list + defaults + merge behavior)
- `src/server/api/config.ts:10-16`
- `src/server/config.ts:62-65, 101-106` (parseList + legacyDefaultLists)
- `src/server/api/cli.ts:13-31`

---

## Task 1: Ecto migration for the `settings` table (dev/test only)

**Files:**
- Create: `server-elixir/priv/repo/migrations/20260424000002_create_settings_table.exs`

The migration mirrors `src/server/db/schema.sql:51-61` *plus* every `ALTER TABLE settings` in `src/server/db/index.ts:60-94, 180-185`. Production SQLite is still created by TS's `migrate()`; this migration exists so `mix test` sees the same column set.

- [ ] **Step 1: Create the migration file**

Create `server-elixir/priv/repo/migrations/20260424000002_create_settings_table.exs`:

```elixir
defmodule FBI.Repo.Migrations.CreateSettingsTable do
  @moduledoc """
  Dev/test migration mirroring TS's `settings` table after all ALTER TABLE
  statements from `src/server/db/index.ts`.  TS remains the schema author in
  production; this migration exists only so `mix test` runs against the same
  column set.  At Phase 9 cutover, TS's schema.sql moves into `priv/repo/` and
  this file becomes the single source of truth.
  """

  use Ecto.Migration

  def change do
    create table(:settings, primary_key: false) do
      add :id, :integer,
        primary_key: true,
        check: %{name: "settings_id_singleton", expr: "id = 1"}

      add :global_prompt, :text, null: false, default: ""
      add :notifications_enabled, :integer, null: false, default: 1
      add :concurrency_warn_at, :integer, null: false, default: 3
      add :image_gc_enabled, :integer, null: false, default: 0
      add :last_gc_at, :integer
      add :last_gc_count, :integer
      add :last_gc_bytes, :integer
      add :global_marketplaces_json, :text, null: false, default: "[]"
      add :global_plugins_json, :text, null: false, default: "[]"
      add :auto_resume_enabled, :integer, null: false, default: 1
      add :auto_resume_max_attempts, :integer, null: false, default: 5
      add :usage_notifications_enabled, :integer, null: false, default: 0
      add :tokens_total_recomputed_at, :integer
      add :updated_at, :integer, null: false
    end
  end
end
```

- [ ] **Step 2: Run the migration and confirm it applies cleanly**

```bash
cd /workspace/server-elixir && mix ecto.migrate
```

Expected: prints `[info] == Running FBI.Repo.Migrations.CreateSettingsTable.change/0 forward` and exits 0.

- [ ] **Step 3: Verify the schema**

```bash
cd /workspace/server-elixir && \
  mix run -e 'IO.inspect(Ecto.Adapters.SQL.query!(FBI.Repo, "PRAGMA table_info(settings)").rows)'
```

Expected: a list with 15 rows whose second element (column name) covers every field in the migration above.

- [ ] **Step 4: Commit**

```bash
git add server-elixir/priv/repo/migrations/20260424000002_create_settings_table.exs
git commit -m "feat(server-elixir): add settings table migration for Phase 2"
```

---

## Task 2: Ecto schema for `settings`

**Files:**
- Create: `server-elixir/lib/fbi/settings/setting.ex`

Follow the pattern from `lib/fbi/usage/rate_limit_state.ex` (singleton with `id = 1` invariant).

- [ ] **Step 1: Create the schema**

Create `server-elixir/lib/fbi/settings/setting.ex`:

```elixir
defmodule FBI.Settings.Setting do
  @moduledoc """
  Ecto schema for the `settings` table.

  Holds a **single row** (`id = 1`) representing the server's global user
  preferences.  The singleton invariant is enforced both by the SQLite CHECK
  constraint and by `validate_inclusion/3` below so application code cannot
  accidentally insert a second row.

  This is a plain `Ecto.Schema` — no GenServer/Supervisor is needed because
  the settings row holds no in-memory state beyond its database row.  Reads
  and writes go directly through `FBI.Repo`.

  Boolean fields are stored as `:integer` (0/1) because the TS server (which
  still owns the schema) uses SQLite `INTEGER` columns for booleans.  The
  `FBI.Settings.Queries` module handles int-to-bool translation so the
  external JSON contract stays boolean-typed.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :integer, autogenerate: false}

  schema "settings" do
    field :global_prompt, :string, default: ""
    field :notifications_enabled, :integer, default: 1
    field :concurrency_warn_at, :integer, default: 3
    field :image_gc_enabled, :integer, default: 0
    field :last_gc_at, :integer
    field :last_gc_count, :integer
    field :last_gc_bytes, :integer
    field :global_marketplaces_json, :string, default: "[]"
    field :global_plugins_json, :string, default: "[]"
    field :auto_resume_enabled, :integer, default: 1
    field :auto_resume_max_attempts, :integer, default: 5
    field :usage_notifications_enabled, :integer, default: 0
    field :tokens_total_recomputed_at, :integer
    field :updated_at, :integer
  end

  @type t :: %__MODULE__{
          id: integer() | nil,
          global_prompt: String.t(),
          notifications_enabled: integer(),
          concurrency_warn_at: integer(),
          image_gc_enabled: integer(),
          last_gc_at: integer() | nil,
          last_gc_count: integer() | nil,
          last_gc_bytes: integer() | nil,
          global_marketplaces_json: String.t(),
          global_plugins_json: String.t(),
          auto_resume_enabled: integer(),
          auto_resume_max_attempts: integer(),
          usage_notifications_enabled: integer(),
          tokens_total_recomputed_at: integer() | nil,
          updated_at: integer() | nil
        }

  @all_fields [
    :id,
    :global_prompt,
    :notifications_enabled,
    :concurrency_warn_at,
    :image_gc_enabled,
    :last_gc_at,
    :last_gc_count,
    :last_gc_bytes,
    :global_marketplaces_json,
    :global_plugins_json,
    :auto_resume_enabled,
    :auto_resume_max_attempts,
    :usage_notifications_enabled,
    :tokens_total_recomputed_at,
    :updated_at
  ]

  @doc """
  Changeset for upserting the singleton settings row.

  Every column is cast (there are no secrets or server-only fields to hide);
  `id` is required and pinned to `1`; booleans-as-integers are clamped to
  `{0, 1}`; `auto_resume_max_attempts` must be `1..20` — the same range the
  TS `PATCH /api/settings` handler enforces in `src/server/api/settings.ts`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(setting, attrs) do
    setting
    |> cast(attrs, @all_fields)
    |> validate_required([:id, :updated_at])
    |> validate_inclusion(:id, [1])
    |> validate_inclusion(:notifications_enabled, [0, 1])
    |> validate_inclusion(:image_gc_enabled, [0, 1])
    |> validate_inclusion(:auto_resume_enabled, [0, 1])
    |> validate_inclusion(:usage_notifications_enabled, [0, 1])
    |> validate_number(:auto_resume_max_attempts,
      greater_than_or_equal_to: 1,
      less_than_or_equal_to: 20
    )
  end
end
```

- [ ] **Step 2: Compile**

```bash
cd /workspace/server-elixir && mix compile --warnings-as-errors
```

Expected: clean compile, zero warnings.

- [ ] **Step 3: Commit**

```bash
git add server-elixir/lib/fbi/settings/setting.ex
git commit -m "feat(server-elixir): add FBI.Settings.Setting Ecto schema"
```

---

## Task 3: `FBI.Settings.Queries` — get/update helpers

**Files:**
- Create: `server-elixir/lib/fbi/settings/queries.ex`
- Create: `server-elixir/test/fbi/settings/queries_test.exs`

TDD order: write failing tests first, then implement.

- [ ] **Step 1: Write the failing test file**

Create `server-elixir/test/fbi/settings/queries_test.exs`:

```elixir
defmodule FBI.Settings.QueriesTest do
  @moduledoc """
  Tests `FBI.Settings.Queries`.  The queries module owns the singleton-row
  invariant (id = 1), the int↔bool translation, and the JSON-encoded list
  fields — all three are behaviors the TS `SettingsRepo` keeps internal, so
  we have to verify them explicitly on the Elixir side.
  """

  # async: false because the singleton row lives at id=1 and tests that run
  # concurrently would step on each other's updates even with the SQL sandbox
  # (the sandbox isolates transactions, not logical row identity, and the
  # sandbox does not actually prevent two tests from writing id=1 in the same
  # wall-clock window on different sandbox transactions).
  use FBI.DataCase, async: false

  alias FBI.Settings.Queries

  describe "get/0" do
    test "returns defaults when the table is empty" do
      settings = Queries.get()

      assert settings.global_prompt == ""
      assert settings.notifications_enabled == true
      assert settings.concurrency_warn_at == 3
      assert settings.image_gc_enabled == false
      assert settings.last_gc_at == nil
      assert settings.last_gc_count == nil
      assert settings.last_gc_bytes == nil
      assert settings.global_marketplaces == []
      assert settings.global_plugins == []
      assert settings.auto_resume_enabled == true
      assert settings.auto_resume_max_attempts == 5
      assert settings.usage_notifications_enabled == false
      assert is_integer(settings.updated_at)
    end

    test "decodes JSON list columns into string lists" do
      Queries.update(%{
        global_marketplaces: ["foo", "bar"],
        global_plugins: ["baz"]
      })

      settings = Queries.get()
      assert settings.global_marketplaces == ["foo", "bar"]
      assert settings.global_plugins == ["baz"]
    end

    test "maps integer booleans to Elixir booleans" do
      Queries.update(%{notifications_enabled: false, auto_resume_enabled: false})

      settings = Queries.get()
      assert settings.notifications_enabled == false
      assert settings.auto_resume_enabled == false
    end
  end

  describe "update/1" do
    test "updates provided fields and leaves others unchanged" do
      before = Queries.get()

      after_patch = Queries.update(%{global_prompt: "new-prompt"})

      assert after_patch.global_prompt == "new-prompt"
      assert after_patch.concurrency_warn_at == before.concurrency_warn_at
      assert after_patch.updated_at >= before.updated_at
    end

    test "accepts boolean inputs for integer-stored columns" do
      result = Queries.update(%{usage_notifications_enabled: true})

      assert result.usage_notifications_enabled == true
      assert Queries.get().usage_notifications_enabled == true
    end

    test "bumps updated_at monotonically" do
      a = Queries.update(%{global_prompt: "a"})
      # Ensure at least 1 ms elapses so the monotonic-ish comparison holds.
      _ = :timer.sleep(2)
      b = Queries.update(%{global_prompt: "b"})

      assert b.updated_at > a.updated_at
    end

    test "rejects auto_resume_max_attempts out of range" do
      assert {:error, changeset} = Queries.update(%{auto_resume_max_attempts: 0})
      assert "must be greater than or equal to 1" in errors_on(changeset).auto_resume_max_attempts

      assert {:error, changeset} = Queries.update(%{auto_resume_max_attempts: 21})
      assert "must be less than or equal to 20" in errors_on(changeset).auto_resume_max_attempts
    end
  end
end
```

- [ ] **Step 2: Run — expect compile-failure**

```bash
cd /workspace/server-elixir && mix test test/fbi/settings/queries_test.exs
```

Expected: compile error `module FBI.Settings.Queries is not available`.

- [ ] **Step 3: Implement `FBI.Settings.Queries`**

Create `server-elixir/lib/fbi/settings/queries.ex`:

```elixir
defmodule FBI.Settings.Queries do
  @moduledoc """
  Read/write helpers for the singleton `settings` row.

  This is a plain module (no GenServer): all state lives in the database and
  every call roundtrips through `FBI.Repo`.  Chosen over a stateful process
  because the TS server still writes this row (e.g. during `POST /api/settings/run-gc`),
  so any in-memory cache would go stale.  The repo is the single source of truth.

  Two behaviors worth naming:

  - **Seed-on-read.**  `get/0` inserts the default row if it does not exist,
    mirroring the TS `SettingsRepo.get/0` contract.  Callers never see a
    missing-row error.
  - **Int ↔ bool translation.**  Booleans are stored as SQLite integers because
    TS wrote the schema; the public API exposes true booleans to match the
    existing JSON contract.
  """

  alias FBI.Repo
  alias FBI.Settings.Setting

  @typedoc """
  The decoded settings map returned by `get/0` and `update/1`.  Keys are
  atoms (Phoenix serializes them to snake_case JSON strings).  Boolean
  fields are true booleans; list fields are decoded from the JSON columns.
  """
  @type decoded :: %{
          global_prompt: String.t(),
          notifications_enabled: boolean(),
          concurrency_warn_at: integer(),
          image_gc_enabled: boolean(),
          last_gc_at: integer() | nil,
          last_gc_count: integer() | nil,
          last_gc_bytes: integer() | nil,
          global_marketplaces: [String.t()],
          global_plugins: [String.t()],
          auto_resume_enabled: boolean(),
          auto_resume_max_attempts: integer(),
          usage_notifications_enabled: boolean(),
          updated_at: integer()
        }

  @typedoc """
  The accepted patch map for `update/1`.  Every key is optional; booleans are
  accepted for int-stored columns; list fields are encoded to JSON before
  write.
  """
  @type patch :: %{optional(atom()) => any()}

  @doc """
  Returns the singleton settings row, seeding defaults if the table is empty.

  Never raises for missing rows — the TS contract promises a readable row
  from first access, and the React UI relies on that.
  """
  @spec get() :: decoded()
  def get do
    case Repo.get(Setting, 1) do
      nil ->
        now = System.system_time(:millisecond)

        %Setting{id: 1, updated_at: now}
        |> Setting.changeset(%{})
        |> Repo.insert!(on_conflict: :nothing, conflict_target: :id)

        # Re-read so we pick up column defaults applied by the DB.
        # `on_conflict: :nothing` is safe under concurrent seeding: at most one
        # inserter wins, the others no-op and fall through to the read below.
        Repo.get!(Setting, 1) |> decode()

      setting ->
        decode(setting)
    end
  end

  @doc """
  Merges `patch` into the singleton row and returns the decoded result.

  Returns `{:error, changeset}` when validation fails (currently only
  `auto_resume_max_attempts` outside `1..20`) — the controller turns this
  into a 400 response with the same error message as the TS handler.

  Unlike the TS `update/1`, which read-modify-writes and returns the merged
  map unconditionally, this version routes through a changeset so validation
  runs on the final state.  The end-to-end contract (valid patches → 200 +
  updated row; invalid → 400) is identical.
  """
  @spec update(patch()) :: decoded() | {:error, Ecto.Changeset.t()}
  def update(patch) do
    existing = Repo.get(Setting, 1) || %Setting{id: 1}
    attrs = build_attrs(patch, existing)

    changeset = Setting.changeset(existing, attrs)

    # `Setting.changeset/2` returns a changeset whose `:valid?` flag is the
    # single decision point.  Using `with` here would add indirection for
    # nothing; a plain `if` matches how Phase 1 phrased similar logic.
    if changeset.valid? do
      case Repo.insert_or_update(changeset) do
        {:ok, _setting} -> Repo.get!(Setting, 1) |> decode()
        {:error, cs} -> {:error, cs}
      end
    else
      {:error, changeset}
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Merge the caller's patch into the existing row, translating booleans to
  # integers and lists to JSON strings.  Any key the caller did not touch keeps
  # its existing value so the TS partial-update contract is preserved.
  defp build_attrs(patch, existing) do
    now = System.system_time(:millisecond)

    %{
      id: 1,
      global_prompt: Map.get(patch, :global_prompt, existing.global_prompt),
      notifications_enabled:
        bool_to_int(Map.get(patch, :notifications_enabled), existing.notifications_enabled),
      concurrency_warn_at:
        Map.get(patch, :concurrency_warn_at, existing.concurrency_warn_at),
      image_gc_enabled:
        bool_to_int(Map.get(patch, :image_gc_enabled), existing.image_gc_enabled),
      global_marketplaces_json:
        list_to_json(Map.get(patch, :global_marketplaces), existing.global_marketplaces_json),
      global_plugins_json:
        list_to_json(Map.get(patch, :global_plugins), existing.global_plugins_json),
      auto_resume_enabled:
        bool_to_int(Map.get(patch, :auto_resume_enabled), existing.auto_resume_enabled),
      auto_resume_max_attempts:
        Map.get(patch, :auto_resume_max_attempts, existing.auto_resume_max_attempts),
      usage_notifications_enabled:
        bool_to_int(
          Map.get(patch, :usage_notifications_enabled),
          existing.usage_notifications_enabled
        ),
      updated_at: now
    }
  end

  defp bool_to_int(nil, existing), do: existing
  defp bool_to_int(true, _existing), do: 1
  defp bool_to_int(false, _existing), do: 0
  defp bool_to_int(v, _existing) when v in [0, 1], do: v

  defp list_to_json(nil, existing_json), do: existing_json

  defp list_to_json(list, _existing_json) when is_list(list) do
    Jason.encode!(list)
  end

  defp decode(%Setting{} = s) do
    %{
      global_prompt: s.global_prompt,
      notifications_enabled: s.notifications_enabled == 1,
      concurrency_warn_at: s.concurrency_warn_at,
      image_gc_enabled: s.image_gc_enabled == 1,
      last_gc_at: s.last_gc_at,
      last_gc_count: s.last_gc_count,
      last_gc_bytes: s.last_gc_bytes,
      global_marketplaces: Jason.decode!(s.global_marketplaces_json || "[]"),
      global_plugins: Jason.decode!(s.global_plugins_json || "[]"),
      auto_resume_enabled: s.auto_resume_enabled == 1,
      auto_resume_max_attempts: s.auto_resume_max_attempts,
      usage_notifications_enabled: s.usage_notifications_enabled == 1,
      updated_at: s.updated_at
    }
  end
end
```

- [ ] **Step 4: Run the tests — expect PASS**

```bash
cd /workspace/server-elixir && mix test test/fbi/settings/queries_test.exs
```

Expected: all tests pass, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi/settings/queries.ex server-elixir/test/fbi/settings/queries_test.exs
git commit -m "feat(server-elixir): add FBI.Settings.Queries (get/update singleton row)"
```

---

## Task 4: `FBI.Config.Defaults` — env-var list parsing

**Files:**
- Create: `server-elixir/lib/fbi/config/defaults.ex`
- Create: `server-elixir/test/fbi/config/defaults_test.exs`

Port of `src/server/config.ts:62-65, 101-106` — reads two env vars, splits on `,` or `\n`, trims, filters blanks.

- [ ] **Step 1: Write the failing test**

Create `server-elixir/test/fbi/config/defaults_test.exs`:

```elixir
defmodule FBI.Config.DefaultsTest do
  @moduledoc """
  Mirrors the behaviour of TS's `parseList` + `legacyDefaultLists` from
  `src/server/config.ts`.  The `list/0` contract is: read two env vars
  (`FBI_DEFAULT_MARKETPLACES`, `FBI_DEFAULT_PLUGINS`), split on `,` or
  newline, trim each element, drop empties.
  """

  use ExUnit.Case, async: false

  alias FBI.Config.Defaults

  # Helper: set env vars, run the assertion, always clean up.
  defp with_env(kvs, fun) do
    original =
      Enum.map(kvs, fn {k, _} -> {k, System.get_env(k)} end)

    Enum.each(kvs, fn {k, v} ->
      if v == nil, do: System.delete_env(k), else: System.put_env(k, v)
    end)

    try do
      fun.()
    after
      Enum.each(original, fn
        {k, nil} -> System.delete_env(k)
        {k, v} -> System.put_env(k, v)
      end)
    end
  end

  describe "list/0" do
    test "returns empty lists when env vars are unset" do
      with_env([{"FBI_DEFAULT_MARKETPLACES", nil}, {"FBI_DEFAULT_PLUGINS", nil}], fn ->
        assert Defaults.list() == %{marketplaces: [], plugins: []}
      end)
    end

    test "splits on commas and trims whitespace" do
      with_env([{"FBI_DEFAULT_MARKETPLACES", "foo, bar ,baz"}, {"FBI_DEFAULT_PLUGINS", nil}], fn ->
        assert Defaults.list().marketplaces == ["foo", "bar", "baz"]
      end)
    end

    test "splits on newlines" do
      with_env([{"FBI_DEFAULT_MARKETPLACES", "foo\nbar\nbaz"}, {"FBI_DEFAULT_PLUGINS", nil}], fn ->
        assert Defaults.list().marketplaces == ["foo", "bar", "baz"]
      end)
    end

    test "drops empty entries and whitespace-only entries" do
      with_env([{"FBI_DEFAULT_MARKETPLACES", "foo,,  ,bar"}, {"FBI_DEFAULT_PLUGINS", nil}], fn ->
        assert Defaults.list().marketplaces == ["foo", "bar"]
      end)
    end

    test "handles mixed commas and newlines" do
      with_env(
        [{"FBI_DEFAULT_MARKETPLACES", "a,b\nc ,  d"}, {"FBI_DEFAULT_PLUGINS", "x\ny"}],
        fn ->
          assert Defaults.list() == %{
                   marketplaces: ["a", "b", "c", "d"],
                   plugins: ["x", "y"]
                 }
        end
      )
    end
  end
end
```

- [ ] **Step 2: Run — expect compile error**

```bash
cd /workspace/server-elixir && mix test test/fbi/config/defaults_test.exs
```

Expected: `module FBI.Config.Defaults is not available`.

- [ ] **Step 3: Implement the module**

Create `server-elixir/lib/fbi/config/defaults.ex`:

```elixir
defmodule FBI.Config.Defaults do
  @moduledoc """
  Server-side defaults for marketplaces and plugins, sourced from environment
  variables.  Mirrors `legacyDefaultLists/0` in `src/server/config.ts`.

  This is a plain module (no process state) — the data is derived fresh each
  call from env vars so that operators can re-export and restart without a
  cache to invalidate.  The cost is negligible (two `System.get_env` reads).

  Why it exists: the React frontend hits `GET /api/config/defaults` to show
  the user what upstream marketplaces/plugins are bundled with the server.
  The same lists are also used by TS's startup migration, which is why the
  TS side calls it "legacy" — the Elixir port does not need to mark it so
  because Elixir does not yet own startup migrations.
  """

  @type list_result :: %{marketplaces: [String.t()], plugins: [String.t()]}

  @doc """
  Reads both env vars and returns a map with parsed lists.
  """
  @spec list() :: list_result()
  def list do
    %{
      marketplaces: parse(System.get_env("FBI_DEFAULT_MARKETPLACES")),
      plugins: parse(System.get_env("FBI_DEFAULT_PLUGINS"))
    }
  end

  # Parses an env-var value the same way TS's `parseList/1` does:
  # split on comma OR newline, trim each element, drop empties.
  # Keeping the empty-string case explicit avoids a regex split on `""`
  # that would return `[""]` and require a filter.
  defp parse(nil), do: []
  defp parse(""), do: []

  defp parse(value) when is_binary(value) do
    value
    |> String.split(~r/[,\n]/)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end
end
```

- [ ] **Step 4: Run the tests — expect PASS**

```bash
cd /workspace/server-elixir && mix test test/fbi/config/defaults_test.exs
```

Expected: all tests pass, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add server-elixir/lib/fbi/config/defaults.ex server-elixir/test/fbi/config/defaults_test.exs
git commit -m "feat(server-elixir): add FBI.Config.Defaults env-var parser"
```

---

## Task 5: `FBIWeb.SettingsController` + route + tests

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/settings_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/settings_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

- [ ] **Step 1: Write the failing controller tests**

Create `server-elixir/test/fbi_web/controllers/settings_controller_test.exs`:

```elixir
defmodule FBIWeb.SettingsControllerTest do
  @moduledoc """
  Mirrors the vitest cases in `src/server/api/settings.test.ts` so the byte
  contract (keys, types, status codes) matches what the React UI already
  uses against TS.
  """

  # async: false — the singleton settings row is shared state.
  use FBIWeb.ConnCase, async: false

  describe "GET /api/settings" do
    test "returns defaults including auto_resume fields", %{conn: conn} do
      conn = get(conn, "/api/settings")
      assert conn.status == 200

      body = json_response(conn, 200)
      assert is_boolean(body["auto_resume_enabled"])
      assert is_integer(body["auto_resume_max_attempts"])
      assert is_boolean(body["notifications_enabled"])
      assert is_boolean(body["image_gc_enabled"])
      assert is_boolean(body["usage_notifications_enabled"])
      assert body["global_marketplaces"] == []
      assert body["global_plugins"] == []
    end

    test "response includes every documented key", %{conn: conn} do
      body = conn |> get("/api/settings") |> json_response(200)

      expected_keys = ~w(
        global_prompt notifications_enabled concurrency_warn_at
        image_gc_enabled last_gc_at last_gc_count last_gc_bytes
        global_marketplaces global_plugins
        auto_resume_enabled auto_resume_max_attempts
        usage_notifications_enabled updated_at
      )

      assert Enum.sort(Map.keys(body)) == Enum.sort(expected_keys)
    end
  end

  describe "PATCH /api/settings" do
    test "rejects out-of-range auto_resume_max_attempts (0)", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{auto_resume_max_attempts: 0}))

      assert conn.status == 400

      assert json_response(conn, 400) == %{
               "error" => "auto_resume_max_attempts must be an integer between 1 and 20"
             }
    end

    test "rejects out-of-range auto_resume_max_attempts (21)", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{auto_resume_max_attempts: 21}))

      assert conn.status == 400
    end

    test "updates auto_resume_enabled and auto_resume_max_attempts", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/api/settings",
          Jason.encode!(%{auto_resume_enabled: true, auto_resume_max_attempts: 7})
        )

      assert conn.status == 200
      body = json_response(conn, 200)
      assert body["auto_resume_enabled"] == true
      assert body["auto_resume_max_attempts"] == 7
    end

    test "PATCH then GET round-trips usage_notifications_enabled", %{conn: conn} do
      patch_conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{usage_notifications_enabled: true}))

      assert patch_conn.status == 200
      assert json_response(patch_conn, 200)["usage_notifications_enabled"] == true

      get_conn = get(build_conn(), "/api/settings")
      assert json_response(get_conn, 200)["usage_notifications_enabled"] == true
    end

    test "updates global_marketplaces and global_plugins as list fields", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/api/settings",
          Jason.encode!(%{
            global_marketplaces: ["foo", "bar"],
            global_plugins: ["baz"]
          })
        )

      assert conn.status == 200
      body = json_response(conn, 200)
      assert body["global_marketplaces"] == ["foo", "bar"]
      assert body["global_plugins"] == ["baz"]
    end

    test "updated_at is monotonically non-decreasing across PATCHes", %{conn: conn} do
      a =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{global_prompt: "a"}))
        |> json_response(200)

      :timer.sleep(2)

      b =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> patch("/api/settings", Jason.encode!(%{global_prompt: "b"}))
        |> json_response(200)

      assert b["updated_at"] > a["updated_at"]
    end
  end
end
```

- [ ] **Step 2: Run — expect compile failure (controller + route don't exist)**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/settings_controller_test.exs
```

Expected: Phoenix route-not-found / module-not-available errors.

- [ ] **Step 3: Implement the controller**

Create `server-elixir/lib/fbi_web/controllers/settings_controller.ex`:

```elixir
defmodule FBIWeb.SettingsController do
  @moduledoc """
  REST endpoints for the singleton settings row.

  Routes served here:

  - `GET /api/settings` — returns the decoded row (booleans as booleans,
    list columns as JSON arrays, timestamp as integer ms).
  - `PATCH /api/settings` — partial update; rejects `auto_resume_max_attempts`
    outside `1..20` with a 400 whose error message matches the TS handler
    byte-for-byte so clients with cached error strings keep working.

  `POST /api/settings/run-gc` is intentionally **not** served here — it
  depends on the orchestrator (Phase 7) and continues to be proxied to TS
  via the catch-all in `FBIWeb.Router`.

  This is a plain Phoenix controller — no process state, no supervision
  concerns.  All behaviour delegates to `FBI.Settings.Queries`.
  """

  use FBIWeb, :controller

  alias FBI.Settings.Queries

  @doc "GET /api/settings — returns the decoded singleton row."
  def show(conn, _params) do
    json(conn, Queries.get())
  end

  @doc """
  PATCH /api/settings — applies a partial update.

  Accepts the same keys as the TS handler: `global_prompt`,
  `notifications_enabled`, `concurrency_warn_at`, `image_gc_enabled`,
  `global_marketplaces`, `global_plugins`, `auto_resume_enabled`,
  `auto_resume_max_attempts`, `usage_notifications_enabled`.
  """
  def update(conn, params) do
    # `params` arrives with string keys (Phoenix JSON parser); the queries
    # module works on atom keys.  `atomize/1` restricts conversion to a
    # known allow-list so we never call `String.to_atom/1` on user input.
    patch = atomize(params)

    case Queries.update(patch) do
      {:error, %Ecto.Changeset{errors: errors}} ->
        # The TS handler returns exactly this string for the only validation
        # case; reproduce it verbatim so clients with hard-coded error
        # matchers keep working.  Any future validations should branch here
        # to preserve the single-error-at-a-time contract.
        cond do
          Keyword.has_key?(errors, :auto_resume_max_attempts) ->
            conn
            |> put_status(400)
            |> json(%{error: "auto_resume_max_attempts must be an integer between 1 and 20"})

          true ->
            conn
            |> put_status(400)
            |> json(%{error: "invalid settings patch"})
        end

      decoded when is_map(decoded) ->
        json(conn, decoded)
    end
  end

  # Translate string-keyed params into atom-keyed patches.  Only the known
  # field set is translated; anything else is silently dropped — same as the
  # TS handler, which ignores unknown fields (its body type is the sole gate).
  @known_string_keys %{
    "global_prompt" => :global_prompt,
    "notifications_enabled" => :notifications_enabled,
    "concurrency_warn_at" => :concurrency_warn_at,
    "image_gc_enabled" => :image_gc_enabled,
    "global_marketplaces" => :global_marketplaces,
    "global_plugins" => :global_plugins,
    "auto_resume_enabled" => :auto_resume_enabled,
    "auto_resume_max_attempts" => :auto_resume_max_attempts,
    "usage_notifications_enabled" => :usage_notifications_enabled
  }

  defp atomize(params) when is_map(params) do
    Enum.reduce(@known_string_keys, %{}, fn {string_key, atom_key}, acc ->
      case Map.fetch(params, string_key) do
        {:ok, v} -> Map.put(acc, atom_key, v)
        :error -> acc
      end
    end)
  end
end
```

- [ ] **Step 4: Register routes in the router**

Modify `server-elixir/lib/fbi_web/router.ex` — add three lines to the existing `scope "/api", FBIWeb` block (under the usage routes, before `end`). Open the file and update:

```elixir
  scope "/api", FBIWeb do
    pipe_through :api

    get "/usage", UsageController, :show
    get "/usage/daily", UsageController, :daily
    get "/usage/runs/:id", UsageController, :run_breakdown

    # Phase 2: settings + config + CLI download.
    # `POST /api/settings/run-gc` is *not* registered here — it stays proxied
    # to TS via the catch-all because it depends on the orchestrator (Phase 7).
    get "/settings", SettingsController, :show
    patch "/settings", SettingsController, :update
  end
```

(Config and CLI routes are added in later tasks; keep the block minimal here.)

- [ ] **Step 5: Run the settings controller tests — expect PASS**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/settings_controller_test.exs
```

Expected: all tests pass.

- [ ] **Step 6: Verify `POST /api/settings/run-gc` still proxies**

Manual sanity check (no test code). With only the native GET+PATCH registered, the catch-all should still match POST. Grep confirms no native POST exists:

```bash
grep -n "settings" /workspace/server-elixir/lib/fbi_web/router.ex
```

Expected: three lines — GET, PATCH, and a comment mentioning `run-gc`. No POST.

- [ ] **Step 7: Commit**

```bash
git add \
  server-elixir/lib/fbi_web/controllers/settings_controller.ex \
  server-elixir/test/fbi_web/controllers/settings_controller_test.exs \
  server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port GET/PATCH /api/settings to Elixir (Phase 2)"
```

---

## Task 6: `FBIWeb.ConfigController` + route + tests

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/config_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/config_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`

- [ ] **Step 1: Write the failing controller test**

Create `server-elixir/test/fbi_web/controllers/config_controller_test.exs`:

```elixir
defmodule FBIWeb.ConfigControllerTest do
  @moduledoc """
  Contract for `GET /api/config/defaults`: returns exactly two keys,
  `defaultMarketplaces` and `defaultPlugins`, each an array of strings
  derived from `FBI_DEFAULT_MARKETPLACES` / `FBI_DEFAULT_PLUGINS` env vars.
  Mirrors the shape in `src/server/api/config.ts`.
  """

  use FBIWeb.ConnCase, async: false

  setup do
    mp = System.get_env("FBI_DEFAULT_MARKETPLACES")
    pl = System.get_env("FBI_DEFAULT_PLUGINS")
    System.delete_env("FBI_DEFAULT_MARKETPLACES")
    System.delete_env("FBI_DEFAULT_PLUGINS")

    on_exit(fn ->
      if mp, do: System.put_env("FBI_DEFAULT_MARKETPLACES", mp),
        else: System.delete_env("FBI_DEFAULT_MARKETPLACES")

      if pl, do: System.put_env("FBI_DEFAULT_PLUGINS", pl),
        else: System.delete_env("FBI_DEFAULT_PLUGINS")
    end)

    :ok
  end

  test "returns empty lists when env vars are unset", %{conn: conn} do
    conn = get(conn, "/api/config/defaults")
    assert conn.status == 200
    assert json_response(conn, 200) == %{"defaultMarketplaces" => [], "defaultPlugins" => []}
  end

  test "returns parsed lists from env vars", %{conn: conn} do
    System.put_env("FBI_DEFAULT_MARKETPLACES", "foo,bar")
    System.put_env("FBI_DEFAULT_PLUGINS", "baz")

    body = conn |> get("/api/config/defaults") |> json_response(200)
    assert body == %{"defaultMarketplaces" => ["foo", "bar"], "defaultPlugins" => ["baz"]}
  end

  test "uses camelCase keys to match the TS contract", %{conn: conn} do
    body = conn |> get("/api/config/defaults") |> json_response(200)
    assert Enum.sort(Map.keys(body)) == ["defaultMarketplaces", "defaultPlugins"]
  end
end
```

- [ ] **Step 2: Run — expect route-not-found**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/config_controller_test.exs
```

Expected: `Phoenix.Router.NoRouteError` (or compile error if the controller module is missing).

- [ ] **Step 3: Implement the controller**

Create `server-elixir/lib/fbi_web/controllers/config_controller.ex`:

```elixir
defmodule FBIWeb.ConfigController do
  @moduledoc """
  Exposes read-only server defaults to the UI.

  Currently serves one route:

  - `GET /api/config/defaults` — returns the default marketplaces and plugins
    derived from environment variables.

  Plain controller; no process or cache is needed because the values are
  read on demand from `FBI.Config.Defaults`.  Kept in its own module
  (rather than bolted onto `SettingsController`) to mirror the TS file
  layout and to keep the blast radius of future additions narrow.
  """

  use FBIWeb, :controller

  alias FBI.Config.Defaults

  @doc """
  GET /api/config/defaults — returns `%{defaultMarketplaces:, defaultPlugins:}`.

  The camelCase key names match the TS contract verbatim; the React UI
  depends on them.
  """
  def defaults(conn, _params) do
    lists = Defaults.list()

    json(conn, %{
      defaultMarketplaces: lists.marketplaces,
      defaultPlugins: lists.plugins
    })
  end
end
```

- [ ] **Step 4: Register the route**

Modify `server-elixir/lib/fbi_web/router.ex`. Inside the existing `scope "/api", FBIWeb` block, add one line after the settings routes:

```elixir
    get "/config/defaults", ConfigController, :defaults
```

Final block so far:

```elixir
  scope "/api", FBIWeb do
    pipe_through :api

    get "/usage", UsageController, :show
    get "/usage/daily", UsageController, :daily
    get "/usage/runs/:id", UsageController, :run_breakdown

    # Phase 2: settings + config + CLI download.
    # `POST /api/settings/run-gc` is *not* registered here — it stays proxied
    # to TS via the catch-all because it depends on the orchestrator (Phase 7).
    get "/settings", SettingsController, :show
    patch "/settings", SettingsController, :update
    get "/config/defaults", ConfigController, :defaults
  end
```

- [ ] **Step 5: Run — expect PASS**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/config_controller_test.exs
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add \
  server-elixir/lib/fbi_web/controllers/config_controller.ex \
  server-elixir/test/fbi_web/controllers/config_controller_test.exs \
  server-elixir/lib/fbi_web/router.ex
git commit -m "feat(server-elixir): port GET /api/config/defaults to Elixir (Phase 2)"
```

---

## Task 7: `FBIWeb.CliController` — stream `fbi-tunnel` binary

**Files:**
- Create: `server-elixir/lib/fbi_web/controllers/cli_controller.ex`
- Create: `server-elixir/test/fbi_web/controllers/cli_controller_test.exs`
- Modify: `server-elixir/lib/fbi_web/router.ex`
- Modify: `server-elixir/config/config.exs`
- Modify: `server-elixir/config/runtime.exs`

Configuration is added first because the controller reads app env.

- [ ] **Step 1: Add config defaults**

Edit `server-elixir/config/config.exs`. Add two lines next to the existing `config :fbi, namespace:` block, near line 10:

```elixir
# CLI-binary serving config (Phase 2).  `cli_dist_dir` defaults to "dist/cli"
# for local dev; prod reads `CLI_DIST_DIR` in runtime.exs.  `fbi_cli_version`
# is surfaced via the `X-FBI-CLI-Version` response header when set.
config :fbi, cli_dist_dir: "dist/cli"
config :fbi, fbi_cli_version: nil
```

Edit `server-elixir/config/runtime.exs`. In the `if config_env() == :prod do` block (keep existing content), add:

```elixir
  config :fbi, cli_dist_dir: System.get_env("CLI_DIST_DIR", "dist/cli")
  config :fbi, fbi_cli_version: System.get_env("FBI_VERSION")
```

Place these lines *inside* the `if config_env() == :prod do ... end` block, alongside the existing `DATABASE_PATH` / `proxy_target` setup.

- [ ] **Step 2: Write the failing controller test**

Create `server-elixir/test/fbi_web/controllers/cli_controller_test.exs`:

```elixir
defmodule FBIWeb.CliControllerTest do
  @moduledoc """
  Mirrors `src/server/api/cli.test.ts`.  Contract: allow-list `os` ∈
  {darwin, linux} and `arch` ∈ {amd64, arm64}; stream
  `{cli_dist_dir}/fbi-tunnel-{os}-{arch}` with the right headers; 400 on
  bad os/arch; 503 when the file is missing; include
  `X-FBI-CLI-Version` header only when the app-env value is non-nil.
  """

  use FBIWeb.ConnCase, async: false

  setup do
    # Use a unique tempdir per test so parallel test runs (if they happen in
    # the future) do not trip over each other.  We still run async:false
    # above because app-env mutation is process-global.
    dir = Path.join(System.tmp_dir!(), "fbi-cli-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)

    prev_dir = Application.get_env(:fbi, :cli_dist_dir)
    prev_ver = Application.get_env(:fbi, :fbi_cli_version)
    Application.put_env(:fbi, :cli_dist_dir, dir)

    on_exit(fn ->
      Application.put_env(:fbi, :cli_dist_dir, prev_dir)
      Application.put_env(:fbi, :fbi_cli_version, prev_ver)
      File.rm_rf!(dir)
    end)

    %{dir: dir}
  end

  test "streams the binary with the right headers", %{conn: conn, dir: dir} do
    File.write!(Path.join(dir, "fbi-tunnel-darwin-arm64"), "BINARY_CONTENTS")
    Application.put_env(:fbi, :fbi_cli_version, "abc1234")

    conn = get(conn, "/api/cli/fbi-tunnel/darwin/arm64")
    assert conn.status == 200
    assert get_resp_header(conn, "content-type") == ["application/octet-stream"]

    assert get_resp_header(conn, "content-disposition") == [
             ~s(attachment; filename="fbi-tunnel-darwin-arm64")
           ]

    assert get_resp_header(conn, "cache-control") == ["public, max-age=3600"]
    assert get_resp_header(conn, "x-fbi-cli-version") == ["abc1234"]
    assert conn.resp_body == "BINARY_CONTENTS"
  end

  test "omits X-FBI-CLI-Version when version is unset", %{conn: conn, dir: dir} do
    File.write!(Path.join(dir, "fbi-tunnel-linux-amd64"), "X")
    Application.put_env(:fbi, :fbi_cli_version, nil)

    conn = get(conn, "/api/cli/fbi-tunnel/linux/amd64")
    assert conn.status == 200
    assert get_resp_header(conn, "x-fbi-cli-version") == []
  end

  test "returns 400 for an unsupported os", %{conn: conn} do
    conn = get(conn, "/api/cli/fbi-tunnel/windows/amd64")
    assert conn.status == 400
    assert json_response(conn, 400) == %{"error" => "unsupported os/arch"}
  end

  test "returns 400 for an unsupported arch", %{conn: conn} do
    conn = get(conn, "/api/cli/fbi-tunnel/linux/riscv")
    assert conn.status == 400
    assert json_response(conn, 400) == %{"error" => "unsupported os/arch"}
  end

  test "returns 503 when the binary file is missing", %{conn: conn} do
    conn = get(conn, "/api/cli/fbi-tunnel/darwin/arm64")
    assert conn.status == 503

    assert json_response(conn, 503) == %{
             "error" => "fbi-tunnel binary not built; rerun npm run build"
           }
  end

  test "rejects path-traversal attempts via the os allow-list", %{conn: conn} do
    # Phoenix path parsing may or may not reach the handler with this URL;
    # either 400 (handler rejects) or 404 (router rejects) is acceptable.
    # The invariant is that no 200 is ever returned for such URLs.
    conn = get(conn, "/api/cli/fbi-tunnel/..%2Fetc/amd64")
    assert conn.status in [400, 404]
  end
end
```

- [ ] **Step 3: Run — expect compile/route failure**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/cli_controller_test.exs
```

Expected: module-not-available.

- [ ] **Step 4: Implement the controller**

Create `server-elixir/lib/fbi_web/controllers/cli_controller.ex`:

```elixir
defmodule FBIWeb.CliController do
  @moduledoc """
  Serves cross-compiled `fbi-tunnel` binaries to end-user laptops.

  Single route:

  - `GET /api/cli/fbi-tunnel/:os/:arch` — returns the binary as an octet
    stream.  Allowed pairs: `{darwin, linux} × {amd64, arm64}`.

  The binary is streamed from disk with `Plug.Conn.send_file/3` to avoid
  buffering large files into memory.  `send_file` uses the BEAM sendfile(2)
  path on Linux, so the data goes kernel-socket→kernel-socket without
  entering userspace.

  Configuration:

    * `:cli_dist_dir` — directory on disk holding the per-os/arch binaries.
      Defaults to `"dist/cli"`.  Overridable via `CLI_DIST_DIR` in prod.
    * `:fbi_cli_version` — string surfaced via the `X-FBI-CLI-Version`
      header when set.  `nil` (the default) omits the header.
  """

  use FBIWeb, :controller

  # Allow-lists are compile-time constants so the set membership check is a
  # simple `in` expression rather than a runtime Set lookup.
  @allowed_os ~w(darwin linux)
  @allowed_arch ~w(amd64 arm64)

  @doc """
  GET /api/cli/fbi-tunnel/:os/:arch — validate, then stream the binary.
  """
  def fbi_tunnel(conn, %{"os" => os_param, "arch" => arch_param}) do
    cond do
      os_param not in @allowed_os or arch_param not in @allowed_arch ->
        conn |> put_status(400) |> json(%{error: "unsupported os/arch"})

      true ->
        filename = "fbi-tunnel-#{os_param}-#{arch_param}"
        dir = Application.fetch_env!(:fbi, :cli_dist_dir)
        file_path = Path.join(dir, filename)

        case File.stat(file_path) do
          {:ok, _stat} ->
            conn
            |> put_resp_content_type("application/octet-stream")
            |> put_resp_header("content-disposition", ~s(attachment; filename="#{filename}"))
            |> put_resp_header("cache-control", "public, max-age=3600")
            |> maybe_put_version_header()
            |> send_file(200, file_path)

          {:error, _reason} ->
            # 503, not 404: the binary is expected to exist in a correctly-built
            # deployment; its absence is a *server* misconfiguration (not yet
            # built / wrong path), not a *request* problem.  Matches TS.
            conn
            |> put_status(503)
            |> json(%{error: "fbi-tunnel binary not built; rerun npm run build"})
        end
    end
  end

  # Append the CLI-version header only when configured; otherwise the UI
  # treats "no header" as "unknown version", which matches the TS behaviour.
  defp maybe_put_version_header(conn) do
    case Application.get_env(:fbi, :fbi_cli_version) do
      nil -> conn
      "" -> conn
      version when is_binary(version) -> put_resp_header(conn, "x-fbi-cli-version", version)
    end
  end
end
```

- [ ] **Step 5: Register the route**

Modify `server-elixir/lib/fbi_web/router.ex`. Add one line inside the `scope "/api", FBIWeb` block after the `config/defaults` line:

```elixir
    get "/cli/fbi-tunnel/:os/:arch", CliController, :fbi_tunnel
```

- [ ] **Step 6: Run the CLI tests — expect PASS**

```bash
cd /workspace/server-elixir && mix test test/fbi_web/controllers/cli_controller_test.exs
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  server-elixir/lib/fbi_web/controllers/cli_controller.ex \
  server-elixir/test/fbi_web/controllers/cli_controller_test.exs \
  server-elixir/lib/fbi_web/router.ex \
  server-elixir/config/config.exs \
  server-elixir/config/runtime.exs
git commit -m "feat(server-elixir): port GET /api/cli/fbi-tunnel/:os/:arch to Elixir (Phase 2)"
```

---

## Task 8: Contract-fidelity test for `/api/settings`

**Files:**
- Create: `server-elixir/test/fidelity/settings_fidelity_test.exs`
- Create: `server-elixir/test/fidelity/fixtures/settings_snapshot.json`

Same approach as `usage_fidelity_test.exs`: pin the shape of the JSON body against a committed fixture.

- [ ] **Step 1: Capture the canonical fixture from the TS server**

Bootstrap the fixture by starting TS locally and calling GET. One-shot command:

```bash
cd /workspace && HOST=127.0.0.1 PORT=3099 FBI_DB_PATH=/tmp/fidelity-settings.db npm run dev:server &
SERVER_PID=$!
sleep 3
curl -sS http://127.0.0.1:3099/api/settings | jq . > /tmp/settings_snapshot.json
kill $SERVER_PID
```

If `npm run dev:server` is not the exact script name, substitute whatever launches the TS server locally (check `package.json` scripts). A single successful GET is enough — the shape is what matters, not the values.

Inspect `/tmp/settings_snapshot.json` to confirm it has every expected key. Then:

```bash
mkdir -p /workspace/server-elixir/test/fidelity/fixtures
cp /tmp/settings_snapshot.json /workspace/server-elixir/test/fidelity/fixtures/settings_snapshot.json
```

If bootstrap is impractical in the execution environment, **write the fixture by hand** using the defaults from `src/server/db/settings.ts:24-48`:

```json
{
  "global_prompt": "",
  "notifications_enabled": true,
  "concurrency_warn_at": 3,
  "image_gc_enabled": false,
  "last_gc_at": null,
  "last_gc_count": null,
  "last_gc_bytes": null,
  "global_marketplaces": [],
  "global_plugins": [],
  "auto_resume_enabled": true,
  "auto_resume_max_attempts": 5,
  "usage_notifications_enabled": false,
  "updated_at": 0
}
```

Save that exact JSON to `server-elixir/test/fidelity/fixtures/settings_snapshot.json`.

- [ ] **Step 2: Write the fidelity test**

Create `server-elixir/test/fidelity/settings_fidelity_test.exs`:

```elixir
defmodule FBI.Fidelity.SettingsFidelityTest do
  @moduledoc """
  Pins the JSON shape of `/api/settings` to a canonical fixture so accidental
  drift in keys, types, or nesting fails CI before it reaches the frontend.

  Compares shape and key names only; `updated_at` legitimately varies per
  run.  Deleted at Phase 9 cutover alongside the rest of the fidelity harness.
  """

  use FBIWeb.ConnCase, async: false

  @fixture_path Path.expand("fixtures/settings_snapshot.json", __DIR__)

  test "GET /api/settings shape matches the canonical fixture", %{conn: conn} do
    golden = @fixture_path |> File.read!() |> Jason.decode!()

    actual = conn |> get("/api/settings") |> json_response(200)

    assert_same_shape!(actual, golden)
  end

  # Recursive shape-equality check — copied from usage_fidelity_test.exs.
  # Intentionally duplicated rather than extracted to a support module
  # because the fidelity harness disappears at cutover and depending on
  # a shared helper would create a cleanup tangle.
  defp assert_same_shape!(actual, golden) when is_map(actual) and is_map(golden) do
    a_keys = actual |> Map.keys() |> Enum.sort()
    g_keys = golden |> Map.keys() |> Enum.sort()

    assert a_keys == g_keys,
           "Top-level key mismatch:\n  expected: #{inspect(g_keys)}\n  got:      #{inspect(a_keys)}"

    Enum.each(g_keys, fn k ->
      assert_same_shape!(Map.get(actual, k), Map.get(golden, k))
    end)
  end

  defp assert_same_shape!(actual, golden) when is_list(actual) and is_list(golden) do
    cond do
      actual == [] and golden == [] -> :ok
      golden == [] -> :ok
      actual == [] -> flunk("expected non-empty list (matching fixture shape)")
      true -> assert_same_shape!(hd(actual), hd(golden))
    end
  end

  defp assert_same_shape!(actual, golden) do
    assert shape_type(actual) == shape_type(golden),
           "Type mismatch:\n  expected: #{shape_type(golden)}\n  got:      #{shape_type(actual)}"
  end

  defp shape_type(nil), do: :nil_t
  defp shape_type(v) when is_boolean(v), do: :boolean
  defp shape_type(v) when is_number(v), do: :number
  defp shape_type(v) when is_binary(v), do: :string
  defp shape_type(v) when is_list(v), do: :list
  defp shape_type(v) when is_map(v), do: :map
end
```

- [ ] **Step 3: Run — expect PASS**

```bash
cd /workspace/server-elixir && mix test test/fidelity/settings_fidelity_test.exs
```

Expected: single test passes.

- [ ] **Step 4: Commit**

```bash
git add \
  server-elixir/test/fidelity/settings_fidelity_test.exs \
  server-elixir/test/fidelity/fixtures/settings_snapshot.json
git commit -m "test(server-elixir): add contract-fidelity test for /api/settings"
```

---

## Task 9: Full regression + release smoke

**Files:** none created; verification only.

- [ ] **Step 1: Run the full Elixir test suite**

```bash
cd /workspace/server-elixir && mix test
```

Expected: all tests pass (Phase 1 tests + all new Phase 2 tests), zero warnings.

- [ ] **Step 2: Warnings-as-errors compile**

```bash
cd /workspace/server-elixir && mix compile --warnings-as-errors && mix format --check-formatted
```

Expected: clean exit. If formatter complains, run `mix format` and commit separately:

```bash
cd /workspace/server-elixir && mix format
git add -u server-elixir
git commit -m "style(server-elixir): mix format"
```

- [ ] **Step 3: Run the TS vitest suite to confirm no regression**

```bash
cd /workspace && npm test
```

Expected: all TS tests pass (the TS side is untouched this phase, so the vitest suite should be unchanged).

- [ ] **Step 4: Smoke-test the release build**

```bash
cd /workspace/server-elixir && MIX_ENV=prod mix release --overwrite
```

Expected: build succeeds, artifact at `_build/prod/rel/fbi`.

- [ ] **Step 5: Boot the release locally and hit each new route**

In one terminal:

```bash
cd /workspace/server-elixir && \
  DATABASE_PATH=/tmp/phase2-release-test.db \
  SECRET_KEY_BASE="$(openssl rand -hex 32)" \
  PORT=4101 \
  PHX_SERVER=true \
  PROXY_TARGET=http://127.0.0.1:9999 \
  CLI_DIST_DIR=/tmp/phase2-release-test-cli \
  _build/prod/rel/fbi/bin/fbi start
```

In another:

```bash
# Seed a fake binary so /api/cli works end-to-end.
mkdir -p /tmp/phase2-release-test-cli
echo FAKE > /tmp/phase2-release-test-cli/fbi-tunnel-linux-amd64

curl -sS http://127.0.0.1:4101/api/settings | jq .
curl -sS -X PATCH -H 'Content-Type: application/json' \
  -d '{"global_prompt":"hi"}' \
  http://127.0.0.1:4101/api/settings | jq .
curl -sS http://127.0.0.1:4101/api/config/defaults | jq .
curl -sSI http://127.0.0.1:4101/api/cli/fbi-tunnel/linux/amd64

# Confirm the still-proxied run-gc POST attempts to reach the TS proxy
# target.  Because PROXY_TARGET points to an unreachable host, a 502/connect
# error is the expected outcome — we only care that the request is routed
# to the proxy, not that it succeeds.
curl -sS -X POST http://127.0.0.1:4101/api/settings/run-gc -o /dev/null -w "%{http_code}\n"
```

Expected:
- GET `/api/settings` → JSON body with all 13 keys.
- PATCH `/api/settings` → echoed body with `global_prompt: "hi"`.
- GET `/api/config/defaults` → `{"defaultMarketplaces":[],"defaultPlugins":[]}`.
- HEAD `/api/cli/fbi-tunnel/linux/amd64` → 200 with `Content-Disposition`, `Content-Type: application/octet-stream`, `Cache-Control`.
- POST `/api/settings/run-gc` → 502/5xx (proxy failure is fine — we only need the route to reach the catch-all).

Stop the release:

```bash
kill %1 2>/dev/null || true
# or: killall fbi beam.smp
```

- [ ] **Step 6: Commit any last-mile fixes**

If Steps 1–5 surfaced anything, fix and commit per conventional-commits style. If nothing surfaced, no commit needed.

---

## Self-review

**Spec coverage check (Phase 2 row in the Phase list table):**

| Spec requirement | Task |
|---|---|
| `GET /api/settings` | 3 (queries) + 5 (controller) |
| `PATCH /api/settings` | 3 (queries) + 5 (controller, with `auto_resume_max_attempts` 1..20 range) |
| `GET /api/config/defaults` | 4 (defaults module) + 6 (controller) |
| `GET /api/cli/fbi-tunnel/:os/:arch` | 7 (controller, allow-list, headers, 400/503) |
| `POST /api/settings/run-gc` stays proxied | 5 Step 6 (verification that no native POST is registered) + 9 Step 5 (curl check) |
| Dev/test migration mirroring TS settings schema | 1 |
| Ecto schema for settings singleton | 2 |
| Contract fidelity test pin | 8 |
| Teaching-grade `@moduledoc`/`@doc` on every new module | Every create-module task includes the full docs in the file body |
| Byte-compat: JSON keys/types/status codes match TS | 5 (key + type + error-message assertions), 6 (camelCase keys assertion), 7 (header + status-code assertions), 8 (fidelity golden) |
| Rollback: both TS and Elixir implementations coexist | Implicit — we add nothing on the TS side this phase |

**Placeholder scan:** no `TBD`, `TODO`, "add appropriate error handling", or references to types/functions not defined in any task. Every code block is complete.

**Type / name consistency:**

- `FBI.Settings.Queries.get/0` — used by Task 5 controller; defined in Task 3.
- `FBI.Settings.Queries.update/1` — used by Task 5 controller; defined in Task 3. Returns `decoded()` or `{:error, Ecto.Changeset.t()}`.
- `FBI.Settings.Setting.changeset/2` — used inside `Queries.update/1`; defined in Task 2.
- `FBI.Config.Defaults.list/0` — used by Task 6 controller; defined in Task 4. Returns `%{marketplaces:, plugins:}`.
- Config keys `:cli_dist_dir` / `:fbi_cli_version` — set in Task 7 Step 1 (config.exs + runtime.exs); read in Task 7 Step 4 controller via `Application.fetch_env!/2` and `Application.get_env/2`.

**Open questions** (deferred to execution, not blocking):

1. Whether `POST /api/settings/run-gc` should be rejected with a friendlier error when the TS proxy target is unreachable. Not in scope — that behaviour is owned by the proxy layer from Phase 1 and is identical for every still-proxied route.
2. Whether `tokens_total_recomputed_at` should be exposed in the JSON response. TS does not expose it; we follow TS. If the UI starts using it, it can be added in a follow-up.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-24-elixir-rewrite-phase-2.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
