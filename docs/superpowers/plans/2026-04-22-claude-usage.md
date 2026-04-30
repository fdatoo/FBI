# Claude usage capture implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-run Claude token usage and the Pro/Max 5-hour rate-limit state from the container's session JSONL, persist it in SQLite, and expose it via REST + WebSocket. UI is out of scope (parallel effort).

**Architecture:** Orchestrator bind-mounts a per-run host directory into the container's `~/.claude/projects/`, then runs a polling tailer that parses each new JSONL line into typed `UsageEvent` / `RateLimitEvent` values. Events drive (a) a DB writer that updates denormalized totals on `runs` and appends to `run_usage_events`, and (b) a typed broadcaster the WebSocket route subscribes to for live updates.

**Tech Stack:** TypeScript, better-sqlite3, Fastify + @fastify/websocket, dockerode, Vitest.

---

## File structure

**New files**

- `src/shared/usage.ts` — pure adapters: `parseUsageLine`, `parseRateLimitHeaders`.
- `src/shared/usage.test.ts` — adapter tests.
- `src/shared/__fixtures__/claude-jsonl/*.jsonl` — golden fixtures for the adapters.
- `src/server/db/usage.ts` — `UsageRepo`: insert/aggregate queries + rate-limit singleton.
- `src/server/db/usage.test.ts` — repo tests.
- `src/server/orchestrator/usageTailer.ts` — polling JSONL watcher.
- `src/server/orchestrator/usageTailer.test.ts` — tailer tests (no Docker).
- `src/server/orchestrator/usage.integration.test.ts` — Docker-gated end-to-end.
- `src/server/logs/typedBroadcaster.ts` — generic pub/sub for typed events.
- `src/server/logs/typedBroadcaster.test.ts` — tests.
- `src/server/api/usage.ts` — REST routes.
- `src/server/api/usage.test.ts` — route tests.

**Modified files**

- `src/shared/types.ts` — `Run` gains token columns; add `UsageSnapshot`, `RateLimitSnapshot`, `RateLimitState`, `DailyUsage`, `RunUsageBreakdownRow`, and WS message types.
- `src/server/db/schema.sql` — new columns on `runs`, new tables `run_usage_events` and `rate_limit_state`.
- `src/server/db/index.ts` — `migrate()` adds the same shape for upgrade databases.
- `src/server/logs/registry.ts` — add `getOrCreateEvents(runId)` for the typed broadcaster.
- `src/server/orchestrator/index.ts` — mount dir creation, bind mount, tailer lifecycle, DB + broadcaster wiring; same in `reattach()`.
- `src/server/api/ws.ts` — subscribe to typed events and send JSON text frames alongside the binary TTY stream.
- `src/server/api/ws.test.ts` — add case for typed frames.
- `src/server/index.ts` — register the new route; wire the events registry into ws deps.

---

## Task 1: Schema + migration

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts:24-71` (extend `migrate()`)
- Modify: `src/server/db/index.test.ts` (if it exercises migrate — otherwise covered by downstream repo tests)

- [ ] **Step 1: Extend `schema.sql` with new columns on `runs` and two new tables**

Append to `src/server/db/schema.sql`:

```sql
-- Claude usage capture (see docs/superpowers/specs/2026-04-22-claude-usage-design.md)
-- New columns on runs for denormalized token totals are added via migrate()
-- in index.ts so upgraded DBs stay consistent with fresh ones.

CREATE TABLE IF NOT EXISTS run_usage_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_create_tokens INTEGER NOT NULL,
  rl_requests_remaining INTEGER,
  rl_requests_limit INTEGER,
  rl_tokens_remaining INTEGER,
  rl_tokens_limit INTEGER,
  rl_reset_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_usage_events_run ON run_usage_events (run_id, ts);
CREATE INDEX IF NOT EXISTS idx_run_usage_events_ts  ON run_usage_events (ts);

CREATE TABLE IF NOT EXISTS rate_limit_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  requests_remaining INTEGER,
  requests_limit INTEGER,
  tokens_remaining INTEGER,
  tokens_limit INTEGER,
  reset_at INTEGER,
  observed_at INTEGER NOT NULL,
  observed_from_run_id INTEGER
);
```

- [ ] **Step 2: Extend `migrate()` in `src/server/db/index.ts`**

Insert inside `migrate()` (after the existing `settings` block, before the final `INSERT OR IGNORE INTO settings` call):

```ts
  const runCols = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>)
      .map((r) => r.name)
  );
  for (const c of [
    'tokens_input', 'tokens_output', 'tokens_cache_read',
    'tokens_cache_create', 'tokens_total', 'usage_parse_errors',
  ]) {
    if (!runCols.has(c)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    }
  }
```

- [ ] **Step 3: Run existing tests to confirm no regressions**

Run: `npx vitest run src/server/db/`
Expected: PASS (existing tests unaffected; new columns default to 0 via `SELECT *`).

- [ ] **Step 4: Commit**

```bash
git add src/server/db/schema.sql src/server/db/index.ts
git commit -m "feat(db): schema + migration for claude usage capture"
```

---

## Task 2: Shared types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add token fields to `Run` and declare new interfaces**

Replace the `Run` interface in `src/shared/types.ts` and append the new types at the bottom:

```ts
export interface Run {
  id: number;
  project_id: number;
  prompt: string;
  branch_name: string;
  state: RunState;
  container_id: string | null;
  log_path: string;
  exit_code: number | null;
  error: string | null;
  head_commit: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  // Usage totals (see docs/superpowers/specs/2026-04-22-claude-usage-design.md)
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
  tokens_total: number;
  usage_parse_errors: number;
}

export interface UsageSnapshot {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

export interface RateLimitSnapshot {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;
}

export interface RateLimitState {
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: number | null;
  observed_at: number | null;
  observed_from_run_id: number | null;
  percent_used: number | null;
  reset_in_seconds: number | null;
  observed_seconds_ago: number | null;
}

export interface DailyUsage {
  date: string;
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

export type RunWsUsageMessage = { type: 'usage'; snapshot: UsageSnapshot };
export type RunWsRateLimitMessage = { type: 'rate_limit'; snapshot: RateLimitState };
```

- [ ] **Step 2: Run typecheck to catch any consumer breakage**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add usage + rate-limit shared types"
```

---

## Task 3: `parseUsageLine` adapter

**Files:**
- Create: `src/shared/usage.ts`
- Create: `src/shared/usage.test.ts`
- Create: `src/shared/__fixtures__/claude-jsonl/assistant-turn-with-usage.jsonl`
- Create: `src/shared/__fixtures__/claude-jsonl/assistant-turn-with-cache-only.jsonl`
- Create: `src/shared/__fixtures__/claude-jsonl/assistant-turn-haiku.jsonl`
- Create: `src/shared/__fixtures__/claude-jsonl/tool-use-turn.jsonl`
- Create: `src/shared/__fixtures__/claude-jsonl/malformed-missing-usage.jsonl`
- Create: `src/shared/__fixtures__/claude-jsonl/garbage-line.jsonl`

- [ ] **Step 1: Write fixtures (each file contains exactly one line — ending without a newline is fine)**

`assistant-turn-with-usage.jsonl`:

```json
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":1200,"output_tokens":300,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}}
```

`assistant-turn-with-cache-only.jsonl`:

```json
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":8000,"cache_creation_input_tokens":0}}}
```

`assistant-turn-haiku.jsonl`:

```json
{"type":"assistant","message":{"role":"assistant","model":"claude-haiku-4-5","usage":{"input_tokens":400,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

`tool-use-turn.jsonl`:

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
```

`malformed-missing-usage.jsonl`:

```json
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6"}}
```

`garbage-line.jsonl`:

```
not json at all
```

- [ ] **Step 2: Write failing tests**

`src/shared/usage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUsageLine } from './usage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return fs.readFileSync(path.join(HERE, '__fixtures__', 'claude-jsonl', name), 'utf8').replace(/\n$/, '');
}

describe('parseUsageLine', () => {
  it('parses a canonical assistant turn with all four token kinds', () => {
    const r = parseUsageLine(fixture('assistant-turn-with-usage.jsonl'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value).toEqual({
      model: 'claude-sonnet-4-6',
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_tokens: 5000,
      cache_create_tokens: 200,
    });
  });

  it('parses a cache-only assistant turn (zero output)', () => {
    const r = parseUsageLine(fixture('assistant-turn-with-cache-only.jsonl'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.output_tokens).toBe(0);
    expect(r.value.cache_read_tokens).toBe(8000);
  });

  it('parses a haiku subagent turn with the correct model string', () => {
    const r = parseUsageLine(fixture('assistant-turn-haiku.jsonl'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.model).toBe('claude-haiku-4-5');
  });

  it('returns skip for a non-assistant turn (tool_result)', () => {
    const r = parseUsageLine(fixture('tool-use-turn.jsonl'));
    expect(r.kind).toBe('skip');
  });

  it('returns error for an assistant turn missing usage', () => {
    const r = parseUsageLine(fixture('malformed-missing-usage.jsonl'));
    expect(r.kind).toBe('error');
  });

  it('returns error for a non-JSON line', () => {
    const r = parseUsageLine(fixture('garbage-line.jsonl'));
    expect(r.kind).toBe('error');
  });

  it('returns skip for an empty line', () => {
    expect(parseUsageLine('').kind).toBe('skip');
    expect(parseUsageLine('   ').kind).toBe('skip');
  });
});
```

- [ ] **Step 3: Run test and verify it fails**

Run: `npx vitest run src/shared/usage.test.ts`
Expected: FAIL with "Cannot find module './usage.js'".

- [ ] **Step 4: Implement `parseUsageLine`**

`src/shared/usage.ts`:

```ts
import type { UsageSnapshot, RateLimitSnapshot } from './types.js';

export type UsageLineResult =
  | { kind: 'ok'; value: UsageSnapshot }
  | { kind: 'skip' }
  | { kind: 'error'; reason: string };

export function parseUsageLine(raw: string): UsageLineResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'skip' };

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: 'error', reason: 'not JSON' };
  }

  if (!isRecord(obj)) return { kind: 'error', reason: 'not an object' };
  const message = obj.message;
  if (!isRecord(message)) return { kind: 'skip' };
  if (message.role !== 'assistant') return { kind: 'skip' };

  const model = typeof message.model === 'string' ? message.model : null;
  const usage = message.usage;
  if (!isRecord(usage)) return { kind: 'error', reason: 'assistant turn missing usage' };

  const n = (k: string): number => {
    const v = usage[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  if (!model) return { kind: 'error', reason: 'assistant turn missing model' };

  return {
    kind: 'ok',
    value: {
      model,
      input_tokens: n('input_tokens'),
      output_tokens: n('output_tokens'),
      cache_read_tokens: n('cache_read_input_tokens'),
      cache_create_tokens: n('cache_creation_input_tokens'),
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// parseRateLimitHeaders is defined in Task 4.
export type RateLimitLineResult =
  | { kind: 'ok'; value: RateLimitSnapshot }
  | { kind: 'skip' };
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run src/shared/usage.test.ts`
Expected: PASS (7/7).

- [ ] **Step 6: Commit**

```bash
git add src/shared/usage.ts src/shared/usage.test.ts src/shared/__fixtures__/
git commit -m "feat(shared): parseUsageLine adapter + fixtures"
```

---

## Task 4: `parseRateLimitHeaders` adapter

**Files:**
- Modify: `src/shared/usage.ts`
- Modify: `src/shared/usage.test.ts`
- Create: `src/shared/__fixtures__/claude-jsonl/assistant-turn-with-rate-limit.jsonl`

- [ ] **Step 1: Write the fixture**

`assistant-turn-with-rate-limit.jsonl` (note: rate-limit fields land alongside `message` at the top level of the line, reflecting where Claude Code logs response metadata):

```json
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":500,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"rateLimits":{"anthropic-ratelimit-unified-5h-requests-remaining":"87","anthropic-ratelimit-unified-5h-requests-limit":"200","anthropic-ratelimit-unified-5h-tokens-remaining":"850000","anthropic-ratelimit-unified-5h-tokens-limit":"1000000","anthropic-ratelimit-unified-5h-reset":"2026-04-22T18:00:00Z"}}
```

- [ ] **Step 2: Add failing tests for `parseRateLimitHeaders`**

Update the existing import in `src/shared/usage.test.ts` to also pull in `parseRateLimitHeaders`:

```ts
import { parseUsageLine, parseRateLimitHeaders } from './usage.js';
```

Then append the new test block:

```ts
describe('parseRateLimitHeaders', () => {
  it('parses the 5h unified fields into a snapshot', () => {
    const raw = JSON.parse(fixture('assistant-turn-with-rate-limit.jsonl'));
    const r = parseRateLimitHeaders(raw);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.requests_remaining).toBe(87);
    expect(r.value.requests_limit).toBe(200);
    expect(r.value.tokens_remaining).toBe(850000);
    expect(r.value.tokens_limit).toBe(1000000);
    expect(r.value.reset_at).toBe(Date.parse('2026-04-22T18:00:00Z'));
  });

  it('returns skip when no rateLimits are present', () => {
    const raw = JSON.parse(fixture('assistant-turn-with-usage.jsonl'));
    expect(parseRateLimitHeaders(raw).kind).toBe('skip');
  });

  it('handles partial fields (reset missing) by returning null for that field only', () => {
    const raw = {
      rateLimits: {
        'anthropic-ratelimit-unified-5h-requests-remaining': '50',
        'anthropic-ratelimit-unified-5h-requests-limit': '200',
      },
    };
    const r = parseRateLimitHeaders(raw);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.requests_remaining).toBe(50);
    expect(r.value.tokens_remaining).toBeNull();
    expect(r.value.reset_at).toBeNull();
  });
});
```

- [ ] **Step 3: Run test and verify it fails**

Run: `npx vitest run src/shared/usage.test.ts -t parseRateLimitHeaders`
Expected: FAIL (`parseRateLimitHeaders` is not exported).

- [ ] **Step 4: Implement `parseRateLimitHeaders`**

Append to `src/shared/usage.ts`:

```ts
export function parseRateLimitHeaders(obj: unknown): RateLimitLineResult {
  if (!isRecord(obj)) return { kind: 'skip' };
  const rl = obj.rateLimits;
  if (!isRecord(rl)) return { kind: 'skip' };

  const num = (k: string): number | null => {
    const v = rl[k];
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  };
  const resetAt = (): number | null => {
    const v = rl['anthropic-ratelimit-unified-5h-reset'];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return v * (v < 1e12 ? 1000 : 1);
    return null;
  };

  return {
    kind: 'ok',
    value: {
      requests_remaining: num('anthropic-ratelimit-unified-5h-requests-remaining'),
      requests_limit: num('anthropic-ratelimit-unified-5h-requests-limit'),
      tokens_remaining: num('anthropic-ratelimit-unified-5h-tokens-remaining'),
      tokens_limit: num('anthropic-ratelimit-unified-5h-tokens-limit'),
      reset_at: resetAt(),
    },
  };
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run src/shared/usage.test.ts`
Expected: PASS (10/10).

- [ ] **Step 6: Commit**

```bash
git add src/shared/usage.ts src/shared/usage.test.ts src/shared/__fixtures__/claude-jsonl/assistant-turn-with-rate-limit.jsonl
git commit -m "feat(shared): parseRateLimitHeaders adapter"
```

---

## Task 5: `UsageRepo.insertUsageEvent` + atomic run-totals update

**Files:**
- Create: `src/server/db/usage.ts`
- Create: `src/server/db/usage.test.ts`

- [ ] **Step 1: Write the failing test**

`src/server/db/usage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, type DB } from './index.js';
import { ProjectsRepo } from './projects.js';
import { RunsRepo } from './runs.js';
import { UsageRepo } from './usage.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-usage-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const usage = new UsageRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const run = runs.create({
    project_id: p.id, prompt: 'hi',
    log_path_tmpl: (id) => `/tmp/${id}.log`,
  });
  return { db, projects, runs, usage, runId: run.id };
}

describe('UsageRepo.insertUsageEvent', () => {
  it('inserts a row and updates run totals atomically', () => {
    const { runs, usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId,
      ts: 1000,
      snapshot: {
        model: 'claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 200,
        cache_create_tokens: 10,
      },
      rate_limit: null,
    });
    const after = runs.get(runId)!;
    expect(after.tokens_input).toBe(100);
    expect(after.tokens_output).toBe(50);
    expect(after.tokens_cache_read).toBe(200);
    expect(after.tokens_cache_create).toBe(10);
    expect(after.tokens_total).toBe(360);
    expect(after.usage_parse_errors).toBe(0);
  });

  it('accumulates across multiple events', () => {
    const { runs, usage, runId } = setup();
    for (let i = 0; i < 3; i++) {
      usage.insertUsageEvent({
        run_id: runId, ts: 1000 + i,
        snapshot: {
          model: 'claude-sonnet-4-6',
          input_tokens: 10, output_tokens: 5,
          cache_read_tokens: 0, cache_create_tokens: 0,
        },
        rate_limit: null,
      });
    }
    expect(runs.get(runId)!.tokens_total).toBe(3 * 15);
  });

  it('bumpParseErrors increments usage_parse_errors', () => {
    const { runs, usage, runId } = setup();
    usage.bumpParseErrors(runId);
    usage.bumpParseErrors(runId);
    expect(runs.get(runId)!.usage_parse_errors).toBe(2);
  });

  it('ON DELETE CASCADE removes events when run is deleted', () => {
    const { db, runs, usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId, ts: 1000,
      snapshot: {
        model: 'claude-sonnet-4-6',
        input_tokens: 1, output_tokens: 1,
        cache_read_tokens: 0, cache_create_tokens: 0,
      },
      rate_limit: null,
    });
    runs.delete(runId);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM run_usage_events').get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npx vitest run src/server/db/usage.test.ts`
Expected: FAIL with "Cannot find module './usage.js'".

- [ ] **Step 3: Implement `UsageRepo` with `insertUsageEvent` + `bumpParseErrors`**

`src/server/db/usage.ts`:

```ts
import type { DB } from './index.js';
import type { UsageSnapshot, RateLimitSnapshot } from '../../shared/types.js';

export interface InsertUsageEventInput {
  run_id: number;
  ts: number;
  snapshot: UsageSnapshot;
  rate_limit: RateLimitSnapshot | null;
}

export class UsageRepo {
  constructor(private db: DB) {}

  insertUsageEvent(input: InsertUsageEventInput): void {
    const s = input.snapshot;
    const rl = input.rate_limit;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO run_usage_events
             (run_id, ts, model, input_tokens, output_tokens,
              cache_read_tokens, cache_create_tokens,
              rl_requests_remaining, rl_requests_limit,
              rl_tokens_remaining, rl_tokens_limit, rl_reset_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.run_id, input.ts, s.model,
          s.input_tokens, s.output_tokens,
          s.cache_read_tokens, s.cache_create_tokens,
          rl?.requests_remaining ?? null,
          rl?.requests_limit ?? null,
          rl?.tokens_remaining ?? null,
          rl?.tokens_limit ?? null,
          rl?.reset_at ?? null
        );
      this.db
        .prepare(
          `UPDATE runs SET
             tokens_input        = tokens_input        + ?,
             tokens_output       = tokens_output       + ?,
             tokens_cache_read   = tokens_cache_read   + ?,
             tokens_cache_create = tokens_cache_create + ?,
             tokens_total        = tokens_total        + ?
           WHERE id = ?`
        )
        .run(
          s.input_tokens, s.output_tokens,
          s.cache_read_tokens, s.cache_create_tokens,
          s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_create_tokens,
          input.run_id
        );
    })();
  }

  bumpParseErrors(runId: number): void {
    this.db.prepare('UPDATE runs SET usage_parse_errors = usage_parse_errors + 1 WHERE id = ?').run(runId);
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/server/db/usage.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/server/db/usage.ts src/server/db/usage.test.ts
git commit -m "feat(db): UsageRepo.insertUsageEvent with atomic totals"
```

---

## Task 6: `UsageRepo` rate-limit singleton

**Files:**
- Modify: `src/server/db/usage.ts`
- Modify: `src/server/db/usage.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/server/db/usage.test.ts`:

```ts
describe('UsageRepo rate-limit singleton', () => {
  it('getRateLimitState returns fully-null shape when nothing observed', () => {
    const { usage } = setup();
    const s = usage.getRateLimitState(Date.now());
    expect(s.observed_at).toBeNull();
    expect(s.percent_used).toBeNull();
    expect(s.reset_in_seconds).toBeNull();
    expect(s.observed_seconds_ago).toBeNull();
  });

  it('upsertRateLimitState writes a row and the derived fields compute correctly', () => {
    const { usage, runId } = setup();
    const now = 10_000_000;
    usage.upsertRateLimitState({
      observed_at: now,
      observed_from_run_id: runId,
      snapshot: {
        requests_remaining: 50, requests_limit: 200,
        tokens_remaining: null, tokens_limit: null,
        reset_at: now + 3600_000,
      },
    });
    const s = usage.getRateLimitState(now + 1000);
    expect(s.requests_remaining).toBe(50);
    expect(s.percent_used).toBeCloseTo((200 - 50) / 200);
    expect(s.reset_in_seconds).toBe(3599);
    expect(s.observed_seconds_ago).toBe(1);
  });

  it('falls back to tokens_remaining/limit when requests fields are missing', () => {
    const { usage, runId } = setup();
    const now = 20_000_000;
    usage.upsertRateLimitState({
      observed_at: now, observed_from_run_id: runId,
      snapshot: {
        requests_remaining: null, requests_limit: null,
        tokens_remaining: 250_000, tokens_limit: 1_000_000,
        reset_at: null,
      },
    });
    const s = usage.getRateLimitState(now);
    expect(s.percent_used).toBeCloseTo(0.75);
    expect(s.reset_in_seconds).toBeNull();
  });

  it('drops an older snapshot (last-write-wins by observed_at)', () => {
    const { usage, runId } = setup();
    usage.upsertRateLimitState({
      observed_at: 2000, observed_from_run_id: runId,
      snapshot: {
        requests_remaining: 10, requests_limit: 100,
        tokens_remaining: null, tokens_limit: null, reset_at: null,
      },
    });
    usage.upsertRateLimitState({
      observed_at: 1000, observed_from_run_id: runId,
      snapshot: {
        requests_remaining: 99, requests_limit: 100,
        tokens_remaining: null, tokens_limit: null, reset_at: null,
      },
    });
    expect(usage.getRateLimitState(3000).requests_remaining).toBe(10);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npx vitest run src/server/db/usage.test.ts -t "rate-limit singleton"`
Expected: FAIL (methods not defined).

- [ ] **Step 3: Add `upsertRateLimitState` and `getRateLimitState` to `UsageRepo`**

Append inside the `UsageRepo` class in `src/server/db/usage.ts`:

```ts
  upsertRateLimitState(input: {
    observed_at: number;
    observed_from_run_id: number | null;
    snapshot: RateLimitSnapshot;
  }): void {
    const s = input.snapshot;
    // Guard: only apply if newer than any existing observation.
    this.db
      .prepare(
        `INSERT INTO rate_limit_state
           (id, requests_remaining, requests_limit,
            tokens_remaining, tokens_limit, reset_at,
            observed_at, observed_from_run_id)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           requests_remaining = excluded.requests_remaining,
           requests_limit     = excluded.requests_limit,
           tokens_remaining   = excluded.tokens_remaining,
           tokens_limit       = excluded.tokens_limit,
           reset_at           = excluded.reset_at,
           observed_at        = excluded.observed_at,
           observed_from_run_id = excluded.observed_from_run_id
         WHERE excluded.observed_at > rate_limit_state.observed_at`
      )
      .run(
        s.requests_remaining, s.requests_limit,
        s.tokens_remaining, s.tokens_limit, s.reset_at,
        input.observed_at, input.observed_from_run_id
      );
  }

  getRateLimitState(now: number): RateLimitState {
    const row = this.db
      .prepare('SELECT * FROM rate_limit_state WHERE id = 1')
      .get() as
      | {
          requests_remaining: number | null;
          requests_limit: number | null;
          tokens_remaining: number | null;
          tokens_limit: number | null;
          reset_at: number | null;
          observed_at: number | null;
          observed_from_run_id: number | null;
        }
      | undefined;

    if (!row) {
      return {
        requests_remaining: null, requests_limit: null,
        tokens_remaining: null, tokens_limit: null,
        reset_at: null, observed_at: null, observed_from_run_id: null,
        percent_used: null, reset_in_seconds: null, observed_seconds_ago: null,
      };
    }

    const percent_used = deriveUsed(row.requests_remaining, row.requests_limit)
      ?? deriveUsed(row.tokens_remaining, row.tokens_limit);
    const reset_in_seconds = row.reset_at != null
      ? Math.max(0, Math.floor((row.reset_at - now) / 1000))
      : null;
    const observed_seconds_ago = row.observed_at != null
      ? Math.max(0, Math.floor((now - row.observed_at) / 1000))
      : null;

    return {
      requests_remaining: row.requests_remaining,
      requests_limit: row.requests_limit,
      tokens_remaining: row.tokens_remaining,
      tokens_limit: row.tokens_limit,
      reset_at: row.reset_at,
      observed_at: row.observed_at,
      observed_from_run_id: row.observed_from_run_id,
      percent_used,
      reset_in_seconds,
      observed_seconds_ago,
    };
  }
```

And at module top (outside the class):

```ts
import type { RateLimitState } from '../../shared/types.js';

function deriveUsed(remaining: number | null, limit: number | null): number | null {
  if (remaining == null || limit == null || limit <= 0) return null;
  return Math.max(0, Math.min(1, (limit - remaining) / limit));
}
```

(Adjust the existing import line at the top of the file to include `RateLimitState`.)

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/server/db/usage.test.ts`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add src/server/db/usage.ts src/server/db/usage.test.ts
git commit -m "feat(db): rate-limit singleton with observed_at guard"
```

---

## Task 7: `UsageRepo` aggregations

**Files:**
- Modify: `src/server/db/usage.ts`
- Modify: `src/server/db/usage.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/server/db/usage.test.ts`:

```ts
describe('UsageRepo aggregations', () => {
  it('listDailyUsage groups by local date', () => {
    const { usage, runId } = setup();
    // Two events on day D, one on day D-1 (using fixed UTC midnights for determinism)
    const day1 = Date.UTC(2026, 3, 20, 12, 0, 0);  // noon
    const day2 = Date.UTC(2026, 3, 21, 12, 0, 0);
    for (const ts of [day1, day1 + 1000, day2]) {
      usage.insertUsageEvent({
        run_id: runId, ts,
        snapshot: {
          model: 'claude-sonnet-4-6',
          input_tokens: 10, output_tokens: 5,
          cache_read_tokens: 0, cache_create_tokens: 0,
        },
        rate_limit: null,
      });
    }
    const rows = usage.listDailyUsage({ days: 14, now: Date.UTC(2026, 3, 22, 0, 0, 0) });
    // Exactly two distinct days.
    const distinct = new Set(rows.map((r) => r.date));
    expect(distinct.size).toBe(2);
  });

  it('listDailyUsage clamps days to [1, 90]', () => {
    const { usage } = setup();
    expect(usage.listDailyUsage({ days: 0, now: Date.now() }).length).toBeGreaterThanOrEqual(0);
    expect(() => usage.listDailyUsage({ days: 1000, now: Date.now() })).not.toThrow();
  });

  it('getRunBreakdown groups by model', () => {
    const { usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId, ts: 1,
      snapshot: { model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 5,
        cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    usage.insertUsageEvent({
      run_id: runId, ts: 2,
      snapshot: { model: 'claude-sonnet-4-6', input_tokens: 20, output_tokens: 10,
        cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    usage.insertUsageEvent({
      run_id: runId, ts: 3,
      snapshot: { model: 'claude-haiku-4-5', input_tokens: 3, output_tokens: 1,
        cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    const rows = usage.getRunBreakdown(runId);
    const sonnet = rows.find((r) => r.model === 'claude-sonnet-4-6')!;
    const haiku = rows.find((r) => r.model === 'claude-haiku-4-5')!;
    expect(sonnet.input).toBe(30);
    expect(sonnet.output).toBe(15);
    expect(haiku.input).toBe(3);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npx vitest run src/server/db/usage.test.ts -t "UsageRepo aggregations"`
Expected: FAIL (methods not defined).

- [ ] **Step 3: Add `listDailyUsage` and `getRunBreakdown` to `UsageRepo`**

Append inside the `UsageRepo` class:

```ts
  listDailyUsage(input: { days: number; now: number }): DailyUsage[] {
    const days = Math.max(1, Math.min(90, input.days));
    const sinceMs = input.now - days * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT DATE(ts/1000, 'unixepoch', 'localtime') AS date,
                SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS tokens_total,
                SUM(input_tokens)        AS tokens_input,
                SUM(output_tokens)       AS tokens_output,
                SUM(cache_read_tokens)   AS tokens_cache_read,
                SUM(cache_create_tokens) AS tokens_cache_create,
                COUNT(DISTINCT run_id)   AS run_count
           FROM run_usage_events
          WHERE ts >= ?
          GROUP BY date
          ORDER BY date ASC`
      )
      .all(sinceMs) as Array<{
        date: string;
        tokens_total: number; tokens_input: number; tokens_output: number;
        tokens_cache_read: number; tokens_cache_create: number;
        run_count: number;
      }>;
    return rows;
  }

  getRunBreakdown(runId: number): RunUsageBreakdownRow[] {
    return this.db
      .prepare(
        `SELECT model,
                SUM(input_tokens)        AS input,
                SUM(output_tokens)       AS output,
                SUM(cache_read_tokens)   AS cache_read,
                SUM(cache_create_tokens) AS cache_create
           FROM run_usage_events
          WHERE run_id = ?
          GROUP BY model
          ORDER BY model ASC`
      )
      .all(runId) as RunUsageBreakdownRow[];
  }
```

And add the missing imports at the top of `src/server/db/usage.ts`:

```ts
import type { DailyUsage, RunUsageBreakdownRow } from '../../shared/types.js';
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/server/db/usage.test.ts`
Expected: PASS (11/11).

- [ ] **Step 5: Commit**

```bash
git add src/server/db/usage.ts src/server/db/usage.test.ts
git commit -m "feat(db): listDailyUsage + getRunBreakdown aggregations"
```

---

## Task 8: Typed broadcaster + registry method

**Files:**
- Create: `src/server/logs/typedBroadcaster.ts`
- Create: `src/server/logs/typedBroadcaster.test.ts`
- Modify: `src/server/logs/registry.ts`

- [ ] **Step 1: Write the failing test**

`src/server/logs/typedBroadcaster.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TypedBroadcaster } from './typedBroadcaster.js';

describe('TypedBroadcaster', () => {
  it('fans out typed messages to subscribers and respects unsubscribe + end', () => {
    const b = new TypedBroadcaster<{ n: number }>();
    const got: number[] = [];
    const unsub = b.subscribe((m) => got.push(m.n));
    b.publish({ n: 1 });
    b.publish({ n: 2 });
    unsub();
    b.publish({ n: 3 });
    expect(got).toEqual([1, 2]);
    const endMarker: string[] = [];
    b.subscribe(() => {}, () => endMarker.push('end'));
    b.end();
    b.publish({ n: 99 });
    expect(endMarker).toEqual(['end']);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npx vitest run src/server/logs/typedBroadcaster.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `TypedBroadcaster`**

`src/server/logs/typedBroadcaster.ts`:

```ts
type DataFn<T> = (msg: T) => void;
type EndFn = () => void;

interface Sub<T> { onData: DataFn<T>; onEnd: EndFn | undefined }

export class TypedBroadcaster<T> {
  private subs = new Set<Sub<T>>();
  private ended = false;

  subscribe(onData: DataFn<T>, onEnd?: EndFn): () => void {
    const sub: Sub<T> = { onData, onEnd };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publish(msg: T): void {
    if (this.ended) return;
    for (const s of this.subs) s.onData(msg);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const s of this.subs) s.onEnd?.();
  }

  isEnded(): boolean { return this.ended; }
}
```

- [ ] **Step 4: Extend `RunStreamRegistry` with typed-event support**

Replace the body of `src/server/logs/registry.ts`:

```ts
import { Broadcaster } from './broadcaster.js';
import { TypedBroadcaster } from './typedBroadcaster.js';
import type { RunWsUsageMessage, RunWsRateLimitMessage } from '../../shared/types.js';

export type RunEvent = RunWsUsageMessage | RunWsRateLimitMessage;

export class RunStreamRegistry {
  private bytes = new Map<number, Broadcaster>();
  private events = new Map<number, TypedBroadcaster<RunEvent>>();

  getOrCreate(runId: number): Broadcaster {
    let b = this.bytes.get(runId);
    if (!b) { b = new Broadcaster(); this.bytes.set(runId, b); }
    return b;
  }

  get(runId: number): Broadcaster | undefined {
    return this.bytes.get(runId);
  }

  getOrCreateEvents(runId: number): TypedBroadcaster<RunEvent> {
    let b = this.events.get(runId);
    if (!b) { b = new TypedBroadcaster<RunEvent>(); this.events.set(runId, b); }
    return b;
  }

  release(runId: number): void {
    this.bytes.delete(runId);
    this.events.delete(runId);
  }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run src/server/logs/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/logs/typedBroadcaster.ts src/server/logs/typedBroadcaster.test.ts src/server/logs/registry.ts
git commit -m "feat(logs): typed broadcaster + registry support for run events"
```

---

## Task 9: `UsageTailer` (polling watcher)

**Files:**
- Create: `src/server/orchestrator/usageTailer.ts`
- Create: `src/server/orchestrator/usageTailer.test.ts`

- [ ] **Step 1: Write the failing test**

`src/server/orchestrator/usageTailer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UsageTailer } from './usageTailer.js';
import type { UsageSnapshot, RateLimitSnapshot } from '../../shared/types.js';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-tailer-'));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('UsageTailer', () => {
  it('picks up lines written after start, handles late file creation', async () => {
    const dir = makeTmp();
    const usages: UsageSnapshot[] = [];
    const rls: RateLimitSnapshot[] = [];
    const errs: string[] = [];
    const tailer = new UsageTailer({
      dir,
      pollMs: 50,
      onUsage: (s) => usages.push(s),
      onRateLimit: (s) => rls.push(s),
      onError: (e) => errs.push(e),
    });
    tailer.start();

    // File doesn't exist yet — simulate Claude creating the slug dir then the file.
    await wait(120);
    const slug = path.join(dir, '-workspace');
    fs.mkdirSync(slug, { recursive: true });
    const file = path.join(slug, 'sess.jsonl');
    fs.writeFileSync(file, '');

    const line = (obj: object) => JSON.stringify(obj) + '\n';
    fs.appendFileSync(file, line({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));

    // Poll interval is 50ms; wait generously.
    await wait(200);
    expect(usages.length).toBe(1);
    expect(usages[0].input_tokens).toBe(10);
    expect(errs).toEqual([]);

    // Append a second line while running.
    fs.appendFileSync(file, line({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      rateLimits: {
        'anthropic-ratelimit-unified-5h-requests-remaining': '77',
        'anthropic-ratelimit-unified-5h-requests-limit': '200',
      },
    }));
    await wait(200);
    expect(usages.length).toBe(2);
    expect(rls.length).toBe(1);
    expect(rls[0].requests_remaining).toBe(77);

    await tailer.stop();
  });

  it('ignores a trailing partial line until completed', async () => {
    const dir = makeTmp();
    const usages: UsageSnapshot[] = [];
    const tailer = new UsageTailer({
      dir, pollMs: 50,
      onUsage: (s) => usages.push(s),
      onRateLimit: () => {},
      onError: () => {},
    });
    tailer.start();
    const slug = path.join(dir, '-workspace');
    fs.mkdirSync(slug, { recursive: true });
    const file = path.join(slug, 'sess.jsonl');
    // Write a partial line (no newline).
    fs.writeFileSync(file, '{"type":"assistant"'); 
    await wait(200);
    expect(usages.length).toBe(0);
    // Finish the line.
    fs.appendFileSync(file, ',"message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
    await wait(200);
    expect(usages.length).toBe(1);
    await tailer.stop();
  });

  it('stop() performs a final full-file pass to catch last lines', async () => {
    const dir = makeTmp();
    const usages: UsageSnapshot[] = [];
    const tailer = new UsageTailer({
      dir, pollMs: 10_000, // deliberately far longer than the test
      onUsage: (s) => usages.push(s),
      onRateLimit: () => {}, onError: () => {},
    });
    tailer.start();
    const slug = path.join(dir, '-workspace');
    fs.mkdirSync(slug, { recursive: true });
    const file = path.join(slug, 'sess.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 42, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n');
    // No wait — rely on final pass.
    await tailer.stop();
    expect(usages.length).toBe(1);
    expect(usages[0].input_tokens).toBe(42);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npx vitest run src/server/orchestrator/usageTailer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `UsageTailer`**

`src/server/orchestrator/usageTailer.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { parseUsageLine, parseRateLimitHeaders } from '../../shared/usage.js';
import type { UsageSnapshot, RateLimitSnapshot } from '../../shared/types.js';

export interface UsageTailerOptions {
  dir: string;          // host-side path bind-mounted into /home/agent/.claude/projects
  pollMs?: number;      // poll interval for scanning + reading
  onUsage: (s: UsageSnapshot) => void;
  onRateLimit: (s: RateLimitSnapshot) => void;
  onError: (reason: string) => void;
}

export class UsageTailer {
  private opts: Required<Omit<UsageTailerOptions, 'onUsage' | 'onRateLimit' | 'onError'>> & UsageTailerOptions;
  private offsets = new Map<string, number>();  // file path → bytes read
  private pending = new Map<string, string>();  // file path → partial trailing line
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: UsageTailerOptions) {
    this.opts = { pollMs: 500, ...opts };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      try { this.scanAndRead(); } catch (e) { this.opts.onError(String(e)); }
      this.timer = setTimeout(tick, this.opts.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // Final full pass.
    try { this.scanAndRead(); } catch (e) { this.opts.onError(String(e)); }
  }

  private scanAndRead(): void {
    const files = this.findJsonlFiles(this.opts.dir);
    for (const file of files) {
      this.readNewLines(file);
    }
  }

  private findJsonlFiles(root: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
      const full = path.join(root, e.name);
      if (e.isDirectory()) { out.push(...this.findJsonlFiles(full)); continue; }
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
  }

  private readNewLines(file: string): void {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return; }
    const lastOffset = this.offsets.get(file) ?? 0;
    if (stat.size <= lastOffset) return;

    const fd = fs.openSync(file, 'r');
    try {
      const len = stat.size - lastOffset;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, lastOffset);
      const chunk = (this.pending.get(file) ?? '') + buf.toString('utf8');
      const lastNl = chunk.lastIndexOf('\n');
      const complete = lastNl >= 0 ? chunk.slice(0, lastNl) : '';
      const partial = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;
      this.pending.set(file, partial);
      this.offsets.set(file, stat.size);

      if (complete.length > 0) {
        for (const line of complete.split('\n')) this.processLine(line);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const u = parseUsageLine(trimmed);
    if (u.kind === 'ok') this.opts.onUsage(u.value);
    else if (u.kind === 'error') this.opts.onError(u.reason);

    // Rate-limit parsing operates on the full JSON object; decode once more.
    try {
      const obj = JSON.parse(trimmed);
      const rl = parseRateLimitHeaders(obj);
      if (rl.kind === 'ok') this.opts.onRateLimit(rl.value);
    } catch { /* already reported via parseUsageLine */ }
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/server/orchestrator/usageTailer.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/usageTailer.ts src/server/orchestrator/usageTailer.test.ts
git commit -m "feat(orchestrator): UsageTailer polling watcher"
```

---

## Task 10: Orchestrator wiring

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 1: Add `UsageRepo` to `OrchestratorDeps`**

At the top of `src/server/orchestrator/index.ts`, add:

```ts
import type { UsageRepo } from '../db/usage.js';
import { UsageTailer } from './usageTailer.js';
```

Extend the `OrchestratorDeps` interface:

```ts
export interface OrchestratorDeps {
  docker: Docker;
  config: Config;
  projects: ProjectsRepo;
  runs: RunsRepo;
  secrets: SecretsRepo;
  settings: SettingsRepo;
  streams: RunStreamRegistry;
  usage: UsageRepo;
}
```

- [ ] **Step 2: Create the host-side claude-projects directory and add the bind mount**

Inside `Orchestrator.launch()`, before the `docker.createContainer` call, add:

```ts
      const claudeProjectsDir = path.join(this.deps.config.runsDir, String(runId), 'claude-projects');
      fs.mkdirSync(claudeProjectsDir, { recursive: true, mode: 0o777 });
```

Extend the `Binds` array inside `HostConfig`:

```ts
            `${claudeProjectsDir}:/home/agent/.claude/projects`,
```

(Add this line among the other `Binds`.)

- [ ] **Step 3: Start the tailer and wire callbacks; stop on exit**

Still inside `launch()`, after `this.active.set(runId, ...)` but before `const waitRes = await container.wait()`:

```ts
      const events = this.deps.streams.getOrCreateEvents(runId);
      const tailer = new UsageTailer({
        dir: claudeProjectsDir,
        pollMs: 500,
        onUsage: (snapshot) => {
          const ts = Date.now();
          this.deps.usage.insertUsageEvent({
            run_id: runId, ts, snapshot, rate_limit: null,
          });
          events.publish({ type: 'usage', snapshot });
        },
        onRateLimit: (snapshot) => {
          this.deps.usage.upsertRateLimitState({
            observed_at: Date.now(),
            observed_from_run_id: runId,
            snapshot,
          });
          const state = this.deps.usage.getRateLimitState(Date.now());
          events.publish({ type: 'rate_limit', snapshot: state });
        },
        onError: () => { this.deps.usage.bumpParseErrors(runId); },
      });
      tailer.start();
```

Then add tailer/event teardown to the **existing** outer `finally` block at the end of `launch()` (currently around line 242–247, which already contains `this.active.delete(runId); store.close(); broadcaster.end(); this.deps.streams.release(runId);`). The updated block should read:

```ts
    } finally {
      await tailer.stop();
      events.end();
      this.active.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
```

(`tailer` and `events` are declared earlier in this step, so they're in scope for the existing `finally`. Hoist them above the outer `try` if TypeScript flags them as possibly undefined; initializing to `null` with non-null assertion in the `finally` is also fine.)

- [ ] **Step 4: Do the same wiring in `reattach()`**

In `Orchestrator.reattach()`, apply the same pattern. After `this.active.set(runId, { container, attachStream });` and before `const waitRes = await container.wait();`, insert:

```ts
    const claudeProjectsDir = path.join(this.deps.config.runsDir, String(runId), 'claude-projects');
    fs.mkdirSync(claudeProjectsDir, { recursive: true, mode: 0o777 });
    const events = this.deps.streams.getOrCreateEvents(runId);
    const tailer = new UsageTailer({
      dir: claudeProjectsDir,
      pollMs: 500,
      onUsage: (snapshot) => {
        this.deps.usage.insertUsageEvent({
          run_id: runId, ts: Date.now(), snapshot, rate_limit: null,
        });
        events.publish({ type: 'usage', snapshot });
      },
      onRateLimit: (snapshot) => {
        this.deps.usage.upsertRateLimitState({
          observed_at: Date.now(),
          observed_from_run_id: runId,
          snapshot,
        });
        const state = this.deps.usage.getRateLimitState(Date.now());
        events.publish({ type: 'rate_limit', snapshot: state });
      },
      onError: () => { this.deps.usage.bumpParseErrors(runId); },
    });
    tailer.start();
```

Wrap the `await container.wait()` … `container.remove()` … `streams.release()` tail of `reattach()` in a `try/finally`:

```ts
    try {
      const waitRes = await container.wait();
      // ... existing post-wait code through container.remove(...) ...
    } finally {
      await tailer.stop();
      events.end();
      this.active.delete(runId);
      store.close();
      broadcaster.end();
      this.deps.streams.release(runId);
    }
```

(If the existing `reattach()` already calls `this.active.delete(runId); store.close(); broadcaster.end(); this.deps.streams.release(runId);` at the end, move those lines into the `finally` and leave the body of the `try` focused on the post-wait processing.)

- [ ] **Step 5: Run typecheck and existing orchestrator tests**

Run: `npm run typecheck && npx vitest run src/server/orchestrator/`
Expected: PASS. (Existing integration tests that require Docker will auto-skip; unit tests should still pass.)

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): mount claude-projects and wire UsageTailer"
```

---

## Task 11: WebSocket forwarding of typed events

**Files:**
- Modify: `src/server/api/ws.ts`
- Modify: `src/server/api/ws.test.ts`

- [ ] **Step 1: Write a failing test that asserts usage frames are received**

Append to `src/server/api/ws.test.ts`:

```ts
import type { RateLimitState } from '../../shared/types.js';

describe('WS typed frames', () => {
  it('forwards usage and rate_limit events as JSON text frames', async () => {
    // Reuse setup() but mark the run as running (not finished) so the ws stays open.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const streams = new RunStreamRegistry();
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, '');
    const run = runs.create({
      project_id: p.id, prompt: 'hi', log_path_tmpl: () => logPath,
    });
    runs.markStarted(run.id, 'c');

    const app = Fastify();
    await app.register(fastifyWebsocket);
    const orchestrator = {
      writeStdin: () => {}, resize: async () => {}, cancel: async () => {},
    };
    registerWsRoute(app, { runs, streams, orchestrator });
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/runs/${run.id}/shell`);
    const messages: string[] = [];
    ws.on('message', (d, isBinary) => {
      if (!isBinary) messages.push(d.toString());
    });
    await new Promise((r) => ws.on('open', r));

    // Publish an event after a short delay.
    setTimeout(() => {
      const ev = streams.getOrCreateEvents(run.id);
      ev.publish({
        type: 'usage',
        snapshot: { model: 'claude-sonnet-4-6', input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_create_tokens: 0 },
      });
      const state: RateLimitState = {
        requests_remaining: 77, requests_limit: 200,
        tokens_remaining: null, tokens_limit: null, reset_at: null,
        observed_at: Date.now(), observed_from_run_id: run.id,
        percent_used: 0.615, reset_in_seconds: null, observed_seconds_ago: 0,
      };
      ev.publish({ type: 'rate_limit', snapshot: state });
    }, 50);

    // Give it time to arrive.
    await new Promise((r) => setTimeout(r, 200));
    const decoded = messages.map((m) => JSON.parse(m) as { type: string });
    expect(decoded.some((m) => m.type === 'usage')).toBe(true);
    expect(decoded.some((m) => m.type === 'rate_limit')).toBe(true);

    ws.close();
    await app.close();
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npx vitest run src/server/api/ws.test.ts -t "typed frames"`
Expected: FAIL (no such frames received).

- [ ] **Step 3: Subscribe to typed events in the WS route and forward as JSON text**

In `src/server/api/ws.ts`, inside the `registerWsRoute` handler, **after** the early-return branch that handles already-finished runs, and alongside the existing bytes subscription (just after `const bc = deps.streams.getOrCreate(runId);` and its `bc.subscribe(...)` block but before `socket.on('close', ...)`), add:

```ts
    // Typed-event channel (usage + rate_limit) sent as JSON text frames,
    // multiplexed over the same socket as the binary TTY stream.
    const ev = deps.streams.getOrCreateEvents(runId);
    const unsubEvents = ev.subscribe((msg) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    });
```

Then update the existing close handler so both unsubscribes fire:

```ts
    socket.on('close', () => { unsub(); unsubEvents(); });
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/server/api/ws.test.ts`
Expected: PASS (both existing and new).

- [ ] **Step 5: Commit**

```bash
git add src/server/api/ws.ts src/server/api/ws.test.ts
git commit -m "feat(ws): forward typed usage + rate_limit frames"
```

---

## Task 12: REST routes for usage

**Files:**
- Create: `src/server/api/usage.ts`
- Create: `src/server/api/usage.test.ts`

- [ ] **Step 1: Write failing tests**

`src/server/api/usage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { UsageRepo } from '../db/usage.js';
import { registerUsageRoutes } from './usage.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-usage-api-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const projects = new ProjectsRepo(db);
  const runs = new RunsRepo(db);
  const usage = new UsageRepo(db);
  const p = projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const run = runs.create({
    project_id: p.id, prompt: 'hi',
    log_path_tmpl: (id) => `/tmp/${id}.log`,
  });
  const app = Fastify();
  registerUsageRoutes(app, { usage });
  return { app, runs, usage, runId: run.id };
}

describe('GET /api/usage/rate-limit', () => {
  it('returns a null-shape when nothing observed', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'GET', url: '/api/usage/rate-limit' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.observed_at).toBeNull();
    expect(body.percent_used).toBeNull();
  });

  it('returns derived fields when a snapshot exists', async () => {
    const { app, usage, runId } = setup();
    const now = Date.now();
    usage.upsertRateLimitState({
      observed_at: now, observed_from_run_id: runId,
      snapshot: {
        requests_remaining: 50, requests_limit: 200,
        tokens_remaining: null, tokens_limit: null,
        reset_at: now + 1800_000,
      },
    });
    const r = await app.inject({ method: 'GET', url: '/api/usage/rate-limit' });
    const body = r.json();
    expect(body.percent_used).toBeCloseTo(0.75, 2);
    expect(body.reset_in_seconds).toBeGreaterThan(0);
  });
});

describe('GET /api/usage/daily', () => {
  it('returns rows with valid shape; clamps days', async () => {
    const { app, usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId, ts: Date.now(),
      snapshot: { model: 'claude-sonnet-4-6', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    const r = await app.inject({ method: 'GET', url: '/api/usage/daily?days=14' });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);

    const clamped = await app.inject({ method: 'GET', url: '/api/usage/daily?days=1000' });
    expect(clamped.statusCode).toBe(200);
  });
});

describe('GET /api/usage/runs/:id', () => {
  it('returns [] for a run with no events', async () => {
    const { app, runId } = setup();
    const r = await app.inject({ method: 'GET', url: `/api/usage/runs/${runId}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('returns per-model breakdown', async () => {
    const { app, usage, runId } = setup();
    usage.insertUsageEvent({
      run_id: runId, ts: 1,
      snapshot: { model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_create_tokens: 0 },
      rate_limit: null,
    });
    const r = await app.inject({ method: 'GET', url: `/api/usage/runs/${runId}` });
    const body = r.json() as Array<{ model: string; input: number }>;
    expect(body.length).toBe(1);
    expect(body[0].model).toBe('claude-sonnet-4-6');
    expect(body[0].input).toBe(10);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npx vitest run src/server/api/usage.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the routes**

`src/server/api/usage.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { UsageRepo } from '../db/usage.js';

interface Deps {
  usage: UsageRepo;
}

export function registerUsageRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/usage/rate-limit', async () => {
    return deps.usage.getRateLimitState(Date.now());
  });

  app.get('/api/usage/daily', async (req) => {
    const q = req.query as { days?: string };
    const days = Number(q.days ?? 14);
    return deps.usage.listDailyUsage({
      days: Number.isFinite(days) ? days : 14,
      now: Date.now(),
    });
  });

  app.get('/api/usage/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = Number(id);
    if (!Number.isFinite(runId)) return reply.code(400).send({ error: 'invalid id' });
    return deps.usage.getRunBreakdown(runId);
  });
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/server/api/usage.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/server/api/usage.ts src/server/api/usage.test.ts
git commit -m "feat(api): /api/usage rate-limit + daily + run breakdown"
```

---

## Task 13: Server bootstrap

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Wire the new repo and route**

Edit `src/server/index.ts`:

Add import:

```ts
import { UsageRepo } from './db/usage.js';
import { registerUsageRoutes } from './api/usage.js';
```

After `const settings = new SettingsRepo(db);`, add:

```ts
  const usage = new UsageRepo(db);
```

Extend the orchestrator construction so `usage` is in `OrchestratorDeps`:

```ts
  const orchestrator = new Orchestrator({
    docker, config, projects, runs, secrets, settings, streams, usage,
  });
```

After `registerWsRoute(...)`, add:

```ts
  registerUsageRoutes(app, { usage });
```

- [ ] **Step 2: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS across the board (the Docker-gated integration test in Task 14 doesn't exist yet; other tests pass).

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(server): wire UsageRepo + usage routes"
```

---

## Task 14: Docker-gated integration test

**Files:**
- Create: `src/server/orchestrator/usage.integration.test.ts`

- [ ] **Step 1: Write the integration test with a Docker skip-guard**

`src/server/orchestrator/usage.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { UsageRepo } from '../db/usage.js';
import { UsageTailer } from './usageTailer.js';

async function dockerAvailable(): Promise<boolean> {
  try { await new Docker().ping(); return true; }
  catch { return false; }
}

describe('usage integration (Docker-gated)', () => {
  it('captures a JSONL written into the bind-mounted directory', async () => {
    if (!(await dockerAvailable())) return;  // auto-skip
    const docker = new Docker();

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-int-'));
    const claudeProjectsDir = path.join(hostDir, 'claude-projects');
    fs.mkdirSync(claudeProjectsDir, { recursive: true, mode: 0o777 });

    const db = openDb(path.join(hostDir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const usage = new UsageRepo(db);
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: p.id, prompt: 'hi',
      log_path_tmpl: (id) => path.join(hostDir, `${id}.log`),
    });

    // Tailer watches the host-side dir.
    const tailer = new UsageTailer({
      dir: claudeProjectsDir, pollMs: 200,
      onUsage: (snapshot) => usage.insertUsageEvent({
        run_id: run.id, ts: Date.now(), snapshot, rate_limit: null,
      }),
      onRateLimit: () => {}, onError: () => {},
    });
    tailer.start();

    // Container writes a JSONL line into /home/agent/.claude/projects/-workspace/sess.jsonl.
    const canned = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n';

    const container = await docker.createContainer({
      Image: 'alpine:3',
      Cmd: ['sh', '-c',
        `mkdir -p /home/agent/.claude/projects/-workspace && ` +
        `printf '%s' '${canned.replace(/'/g, "'\\''")}' > /home/agent/.claude/projects/-workspace/sess.jsonl`,
      ],
      HostConfig: {
        AutoRemove: false,
        Binds: [`${claudeProjectsDir}:/home/agent/.claude/projects`],
      },
    });
    await container.start();
    await container.wait();
    await container.remove({ force: true, v: true }).catch(() => {});

    // Let the tailer see it, then stop (final pass).
    await new Promise((r) => setTimeout(r, 400));
    await tailer.stop();

    const after = runs.get(run.id)!;
    expect(after.tokens_input).toBe(123);
    expect(after.tokens_output).toBe(45);
    expect(after.tokens_total).toBe(168);
  }, 30_000);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/server/orchestrator/usage.integration.test.ts`
Expected:
- If Docker is available locally: PASS (1/1).
- If Docker is unreachable: the test body early-returns (effectively skipped); test "passes" but is a no-op. Verify by logs.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/usage.integration.test.ts
git commit -m "test(orchestrator): Docker-gated usage capture integration"
```

---

## Task 15: Full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Typecheck + unit suite**

Run: `npm run typecheck && npm test`
Expected: PASS across all suites. Integration test either runs (Docker available) or skips cleanly.

- [ ] **Step 2: Sanity-check the new endpoints on a local dev server**

Run: `npm run dev` (only if you have the required env — see `README.md`).
- `curl http://localhost:3000/api/usage/rate-limit` → JSON with all-null fields on a fresh install.
- `curl http://localhost:3000/api/usage/daily?days=14` → `[]`.
- `curl http://localhost:3000/api/runs` → items include `tokens_total: 0`.

Not a required gate if the dev env isn't set up — typecheck + tests are authoritative.

- [ ] **Step 3: No-commit step**

No new commits; this task is verification only.

---

## Self-review checklist (for the implementer)

**Spec coverage** — every spec section maps to tasks:

- §2 Data source & capture → Tasks 9, 10
- §3 Data model → Tasks 1, 5, 6, 7
- §4 API surface → Tasks 2 (types), 8 + 11 (WS), 12 (REST), 13 (wiring)
- §5 UI contract → enforced by types (Task 2) + endpoints (Task 12); no UI work
- §6 Error handling & edge cases → Tasks 3/4 (parser resilience), 5 (`bumpParseErrors`), 9 (partial lines, late files, final pass), 10 (no-JSONL-ever-written naturally leaves zeros)
- §7 Testing → Tasks 3, 4, 5, 6, 7, 8, 9, 11, 12, 14

**Placeholders:** none — every step ships full code.

**Type consistency:** `UsageSnapshot`, `RateLimitSnapshot`, `RateLimitState`, `DailyUsage`, `RunUsageBreakdownRow`, and `RunEvent` are defined once (Task 2 + Task 8) and referenced consistently across Tasks 3–14.
