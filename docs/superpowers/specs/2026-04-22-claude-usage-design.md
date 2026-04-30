# Claude usage capture — design

**Status:** draft · 2026-04-22
**Scope:** data layer only — UI is deferred to a parallel in-flight effort.

## 1. Goals & non-goals

### Goals

- Always-available awareness of the Claude Pro/Max 5-hour rolling window (percent consumed, reset time) via a single server-side source of truth that any client can read.
- Per-run token detail with full breakdown (input / output / cache-read / cache-create, per model), captured from Claude Code's session JSONL.
- Aggregated daily totals for the last N days (default 14, max 90) to support a future trend view.
- Live updates while a run is executing, via the existing per-run WebSocket; as-of-last-run between runs.
- Soft-warning signal in the data model (≥90% consumed) that the new-run UI can surface; no hard blocking in the server.
- Stable typed contract so the parallel UI-rewrite effort can build against it without further coordination.

### Non-goals (deferred)

- Weekly cap / Claude Max weekly limit display — v2 if it becomes a pain point.
- Dollar-cost estimation — OAuth is flat-rate; $ numbers would be fictional.
- Configurable warn/block thresholds — single set of defaults; revisit if tripped.
- Hard blocking on starting runs near the ceiling — surface data only, never gate.
- Backfill for historical runs — their ephemeral JSONLs are already gone. Feature starts tracking from install forward.
- Any UI work: components, routes, tokens, Tailwind edits, `index.css` changes, `src/web/ui/` bootstrap, `/design` route, `StatusBar` primitive. All UI concerns belong to the parallel UI-rewrite effort.

## 2. Data source & capture

### Mount

Orchestrator adds one bind mount per run: host `/var/lib/fbi/runs/<run_id>/claude-projects/` → container `/home/agent/.claude/projects/`. Directory is created before the container starts and survives its death.

### Why this specifically

Claude Code writes per-session JSONL files to `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`. Each line is a turn; assistant-message lines carry `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `model`) and, when the underlying API call emitted them, the `anthropic-ratelimit-unified-5h-*` fields. Parsing this file gives us both per-run tokens and the latest window state as of that turn — one source, no extra API calls.

### Parser: `usageTailer`

New module under `src/server/orchestrator/`. Lifecycle tied to the run.

1. When the container starts, create a tailer rooted at `/var/lib/fbi/runs/<id>/claude-projects/`. Use a filesystem watcher (Node's `fs.watch` or an equivalent library — library choice is an implementation decision) to notice when the first `.jsonl` appears (the subdirectory is created lazily by Claude on first turn), then switch to line-delimited reads on that file.
2. On each new line: if it's an assistant turn, extract usage fields; if it carries rate-limit metadata, extract that too. Emit a typed `UsageEvent` through an internal `EventEmitter` owned by the run.
3. At run end (after `supervisor.sh` exits, before the run's on-disk state is archived), do a final full-file pass to guarantee we have the last line even if the live tail missed a flush.

### Event consumers

- **WebSocket** (existing `/api/ws/runs/:id`): terminal frames and new `usage` / `rate_limit` frames share the socket. The client already has a typed message reader; adding variants is additive.
- **DB writer**: updates the `runs` row's denormalized totals and inserts into `run_usage_events` on each event. Also upserts `rate_limit_state` when the event carries a snapshot.

### Adapters

Shapes of `message.usage` and the rate-limit fields are Anthropic API shapes, not FBI's. Define adapters in `src/shared/usage.ts`:

```ts
export function parseUsageLine(raw: string): UsageLineResult | null;
export function parseRateLimitHeaders(obj: unknown): RateLimitSnapshot | null;
```

Both are pure functions — no FS, no DB, no EventEmitter — and carry the entire Anthropic-shape coupling so the rest of the code only sees FBI types.

### Cleanup

`/var/lib/fbi/runs/<id>/claude-projects/` is retained alongside the existing run log directory and subject to the same GC. No separate lifecycle.

## 3. Data model

Single migration; three changes.

### Add columns to `runs`

| Column | Type | Default | Purpose |
|---|---|---|---|
| `tokens_input` | INTEGER | 0 | Σ `input_tokens` |
| `tokens_output` | INTEGER | 0 | Σ `output_tokens` |
| `tokens_cache_read` | INTEGER | 0 | Σ `cache_read_input_tokens` |
| `tokens_cache_create` | INTEGER | 0 | Σ `cache_creation_input_tokens` |
| `tokens_total` | INTEGER | 0 | Denormalized sum for list/filter speed |
| `usage_parse_errors` | INTEGER | 0 | Count of unparseable lines; 0 = clean |

Denormalizing `tokens_total` is worth it because list views sort/filter on it and we don't want `SUM(...)` on every page load.

### New table `run_usage_events`

```sql
CREATE TABLE run_usage_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,                  -- ms epoch, host clock, when parsed
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_create_tokens INTEGER NOT NULL,
  -- nullable: not every turn carries rate-limit headers
  rl_requests_remaining INTEGER,
  rl_requests_limit INTEGER,
  rl_tokens_remaining INTEGER,
  rl_tokens_limit INTEGER,
  rl_reset_at INTEGER                   -- ms epoch of 5h window reset
);
CREATE INDEX run_usage_events_run ON run_usage_events (run_id, ts);
CREATE INDEX run_usage_events_ts ON run_usage_events (ts);
```

### New singleton `rate_limit_state`

```sql
CREATE TABLE rate_limit_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  requests_remaining INTEGER,
  requests_limit INTEGER,
  tokens_remaining INTEGER,
  tokens_limit INTEGER,
  reset_at INTEGER,
  observed_at INTEGER NOT NULL,         -- last time any snapshot landed
  observed_from_run_id INTEGER
);
```

One row, last-write-wins guarded by `observed_at >`. This is what "what's my window right now?" reads between runs.

### Why three tables, not one

- `runs` columns — hot path; list/filter speed.
- `run_usage_events` — source of truth; enables per-model breakdown and per-day rollups without losing information.
- `rate_limit_state` — a different question with a different lifecycle than any specific run; separated so the status read is a trivial single-row lookup.

### Query shapes supported

- Rate-limit read: `SELECT * FROM rate_limit_state WHERE id = 1`.
- Runs list tokens: already denormalized on `runs`.
- Daily chart: `SELECT DATE(ts/1000, 'unixepoch', 'localtime') AS d, SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) FROM run_usage_events WHERE ts > ? GROUP BY d`.
- Run breakdown: `SELECT model, SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_create_tokens) FROM run_usage_events WHERE run_id = ? GROUP BY model`.

## 4. API surface

### Types (in `src/shared/types.ts`)

```ts
export interface RateLimitState {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;              // ms epoch; null = never observed
  observed_at: number | null;
  observed_from_run_id: number | null;
  // derived server-side so clients don't redo math
  percent_used: number | null;          // 0..1; computed from requests_remaining/requests_limit if both present, else from tokens_remaining/tokens_limit, else null
  reset_in_seconds: number | null;      // null if reset_at is null
  observed_seconds_ago: number | null;  // null if observed_at is null
}

export interface DailyUsage {
  date: string;                         // 'YYYY-MM-DD', server-local tz
  tokens_total: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
  run_count: number;
}

export interface RunUsageBreakdownRow {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export interface UsageSnapshot {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

// WebSocket additions on /api/ws/runs/:id
export type RunWsUsageMessage = { type: 'usage'; snapshot: UsageSnapshot };
export type RunWsRateLimitMessage = { type: 'rate_limit'; snapshot: RateLimitState };
```

### REST endpoints (new)

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/usage/rate-limit` | `RateLimitState` (fields `null` when nothing has been observed yet — never 404) |
| `GET` | `/api/usage/daily?days=N` | `DailyUsage[]`; `N` clamped to `[1, 90]`, default 14 |
| `GET` | `/api/usage/runs/:id` | `RunUsageBreakdownRow[]` (empty array when no events — never 404) |

### REST endpoints (modified)

- `GET /api/runs` and its paged variant: add `tokens_total: number` to every `Run` response (additive, non-breaking; `0` when no usage recorded).

### WebSocket

Extend the existing `/api/ws/runs/:id` socket with `{type:'usage'}` and `{type:'rate_limit'}` variants; clients that don't know about them simply ignore unrecognized `type` values.

Fire-when: `usage` per assistant turn observed in the JSONL; `rate_limit` whenever an observed turn carries rate-limit fields (not every turn does).

### Why not a global rate-limit socket

A single cross-cutting `/api/ws/rate-limit` would let any tab receive live updates. Not worth it: meaningful changes only happen during a run, the per-run socket carries them then, and on window focus a client can refetch `/api/usage/rate-limit` (a trivial one-row query). Added surface area without added value.

## 5. UI contract (UI itself is out of scope)

The UI-rewrite agent owns everything visible. This design commits only to the data contract:

- The types in section 4 are stable.
- The endpoints in section 4 are stable.
- The WebSocket variants in section 4 are additive and stable.
- `GET /api/runs` items gain `tokens_total` (additive).

No component, route, CSS, Tailwind token, or primitive is created by this feature. When the UI agent is ready, it consumes the above; if this feature lands first, the server is functional with no visible artifact other than data in SQLite.

For no-data placeholder behavior on a brand-new install: `rate_limit_state` returns with all nullable fields as `null` and `observed_at = null`, which the UI can detect and render a "nothing observed yet" state.

## 6. Error handling & edge cases

- **No JSONL ever written.** Tailer's watcher fires no events; final full-file pass finds nothing. DB writer inserts no rows; `runs.tokens_*` stay at `0`; `usage_parse_errors = 0`. Run success/failure unaffected — usage capture is orthogonal.
- **JSONL shape changes.** Parser is narrow: unknown top-level fields are ignored; a line that claims `role:"assistant"` but lacks `message.usage` increments `usage_parse_errors` and is logged at `warn`. One bad line does not poison the rest. Run row's `usage_parse_errors > 0` is the signal the UI can surface as a caveat.
- **Container crashes before flush.** JSONL is line-buffered; whatever was written is intact. Final full-file pass picks up any lines the live tailer missed. A trailing partial line (no `\n`) is dropped.
- **Concurrent runs.** Each run has its own mount and its own tailer. `rate_limit_state` uses an `observed_at >` guard; last observation wins, which is correct because every run observes the same shared account-wide window.
- **Clock skew.** Container wall-clock is ignored for bucketing; `run_usage_events.ts` is set by the host when the tailer parses the line. Matches how the rest of FBI buckets (e.g. run `created_at`).
- **Missing rate-limit fields.** `rl_*` columns nullable; `rate_limit_state` only updates when the snapshot is non-null. Expected, not an error.
- **Tailer lag.** Irrelevant at single-digit turns/minute; the parser can keep up. If a pathological backlog ever accumulates, log a `warn` and keep going; the end-of-run full-file pass closes any gap.
- **Backfill.** None. Migration sets defaults on existing rows; historical JSONLs are gone.
- **Mount leaks.** Same GC as the run log directory. `ON DELETE CASCADE` handles the table side.
- **Parser purity.** `parseUsageLine` and `parseRateLimitHeaders` in `src/shared/usage.ts` are pure — easy to test with golden-file fixtures.

## 7. Testing

### Unit — adapters (`src/shared/usage.test.ts`)

Golden-file fixtures under `src/shared/__fixtures__/claude-jsonl/`:

- `assistant-turn-with-usage.jsonl` — canonical Sonnet turn, all four token kinds.
- `assistant-turn-with-cache-only.jsonl` — cache-read-heavy turn, `output_tokens = 0`.
- `assistant-turn-with-rate-limit.jsonl` — turn carrying `anthropic-ratelimit-unified-5h-*` fields.
- `assistant-turn-haiku.jsonl` — subagent turn with a different model string.
- `tool-use-turn.jsonl` — non-assistant line; usage parser returns `null`.
- `malformed-missing-usage.jsonl` — claims assistant but no `message.usage`; increments `parse_errors`, no throw.
- `garbage-line.jsonl` — not JSON; increments `parse_errors`, no throw.

Tests assert: `parseUsageLine` returns the expected `UsageSnapshot` / `null`; `parseRateLimitHeaders` returns the expected `RateLimitSnapshot` / `null`; malformed fixtures increment an error counter rather than throwing.

### Unit — DB (`src/server/db/usage.test.ts`)

- `insertUsageEvent` writes a row and updates `runs`' denormalized columns atomically (same transaction).
- `upsertRateLimitState` observes the `observed_at >` guard — older snapshot dropped, newer wins.
- `listDailyUsage({days})` bucketing across several mocked `ts` values matches hand-computed totals; `days = 0` and `days = 91` are clamped to `[1, 90]`.
- `getRunBreakdown(runId)` groups by model correctly.
- `ON DELETE CASCADE` removes `run_usage_events` when a `runs` row is deleted.

### Unit — tailer (`src/server/orchestrator/usageTailer.test.ts`)

Driven by a temp directory with hand-written JSONL — no Docker.

- Lines appended to an existing file emit events in order; final state in DB matches expected totals.
- Lines appended after `close()` are captured by the final full-file pass.
- Directory appearing after tailer start: tailer waits, then picks up the first file that lands.
- Partial trailing line (no `\n`) is held back and not parsed as an error.

### Unit — API (`src/server/api/usage.test.ts`)

- `GET /api/usage/rate-limit` with no rows → all nullable fields `null`, not 404, not 500.
- With a row → derived `percent_used`, `reset_in_seconds`, `observed_seconds_ago` against an injected clock fixture.
- `GET /api/usage/daily?days=14` shape; `days=0` and `days=1000` clamped to `[1, 90]`.
- `GET /api/usage/runs/:id` returns `[]` for runs with no events, not 404.
- `GET /api/runs` includes `tokens_total` on every item, even `0`.

### WebSocket (`src/server/api/ws.test.ts`, added cases)

Push synthetic events through the run's EventEmitter; assert the subscribed client receives correctly-shaped `{type:'usage'}` and `{type:'rate_limit'}` frames in order and existing `{type:'tty'}` frames remain unaffected.

### Integration — orchestrator (`src/server/orchestrator/usage.integration.test.ts`, Docker-gated)

Gated the same way the existing orchestrator integration tests are (auto-skip if Docker unreachable).

- Stubbed container that writes a canned JSONL into the mounted `claude-projects/` over a few seconds.
- Asserts: tailer emits `UsageEvent`s while the container runs; at container exit `runs.tokens_total` matches the sum of the fixture; `rate_limit_state` reflects the last snapshot; mount directory exists under `/var/lib/fbi/runs/<id>/claude-projects/` and contains the JSONL after the run.

### Non-tests (explicit)

- No real `claude` calls in CI — OAuth + network + nondeterminism. Fixtures or stubs only.
- No frontend/UI tests — UI is parallel-scope.
- No load testing — single-digit turns/minute at most.

## 8. Summary of file changes (inventory, no diffs)

- **New:** `src/shared/usage.ts` (adapters), `src/shared/__fixtures__/claude-jsonl/*.jsonl`, `src/server/orchestrator/usageTailer.ts`, `src/server/db/usage.ts` (DB helpers + migration), `src/server/api/usage.ts` (endpoints), test files mirroring each of the above.
- **Modified:** `src/shared/types.ts` (new interfaces), `src/server/orchestrator/index.ts` (create the mount dir, start/stop tailer, fire final pass), `src/server/db/index.ts` (run the migration), `src/server/db/runs.ts` (select `tokens_total`), `src/server/api/runs.ts` (include `tokens_total` in responses), `src/server/api/ws.ts` (subscribe to the run's usage events and forward as typed frames), `src/server/index.ts` (mount the new router).
- **Unchanged:** anything under `src/web/`. UI is the parallel agent's scope.
