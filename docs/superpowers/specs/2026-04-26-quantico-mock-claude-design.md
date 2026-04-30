# Quantico — mock Claude for FBI testing

**Date:** 2026-04-26
**Status:** approved (design)
**Author:** brainstorm session

## Problem

Manual and automated testing of FBI today must invoke the real `claude` CLI,
which costs OAuth tokens and quota every time. As a result:

- Terminal-pipeline behavior (xterm.js rendering, auto-scroll, ANSI handling,
  WebSocket framing) is verified by hand and regresses easily — see the recent
  three-bug terminal/git fix (`3e3598a`).
- The auto-resume code path (`LimitMonitor` + `resumeScheduler`) can only be
  exercised opportunistically, when a real run happens to hit the rate limit.
- Env-var / mount propagation through the orchestrator → supervisor → agent
  chain has no end-to-end verification.

We need a fake `claude` that behaves like the real one for the surfaces FBI
exercises, without calling any model.

## Solution overview

**Quantico** is a Rust binary that impersonates the `claude` CLI for the
subset of behaviors FBI relies on. When a run is flagged as a mock run, the
orchestrator bind-mounts Quantico over `/usr/local/bin/claude` inside the
container; `supervisor.sh` is unchanged and invokes Quantico transparently.

Quantico produces realistic stdout (with ANSI styling), writes session JSONL
files to the same paths real Claude uses, and can simulate failure modes —
including a usage-limit breach that triggers the existing detector + auto-
resume flow end-to-end.

A reusable TypeScript helper layer plus a Playwright test suite drives the
browser through key scenarios in CI.

## Architecture

### Where Quantico lives

- New workspace crate `cli/quantico/`, sibling to `cli/fbi-tunnel`.
- Added to the root `Cargo.toml` workspace members.
- Cross-compile pattern follows `cli/fbi-tunnel`'s `Makefile`. Build artifact:
  `cli/quantico/dist/quantico-<os>-<arch>`.
- Built as part of `npm run build` so installs and CI both produce it.
- Only `quantico-linux-<arch>` is required at runtime; other targets are
  optional (for running Quantico standalone on a dev machine).

### How Quantico gets into the container

When a run row has `mock=true`, both orchestrators (TS and Elixir):

1. Resolve the host path to the Quantico binary. Production servers look at
   `/usr/local/lib/fbi/quantico` (copied there by `install.sh` when
   `FBI_QUANTICO_ENABLED=1`); dev environments fall back to
   `<repo>/cli/quantico/dist/quantico-linux-<arch>`.
2. Fail-fast at run start with a clear message if the binary is missing — do
   **not** silently fall back to real Claude.
3. Add a read-only bind: `<host quantico>:/usr/local/bin/claude:ro`. This
   shadows the real `claude-cli` baked into the image.
4. Set container env: `MOCK_CLAUDE_SCENARIO=<run.mock_scenario or "default">`
   and `MOCK_CLAUDE_SPEED_MULT=<from server config; default 1.0>`.
5. Skip the host `~/.claude` OAuth bind. Quantico does not need OAuth and we
   do not want the mock seeing real credentials.
6. Tag the run's terminal banner with `[mock] scenario=<name>`.

`supervisor.sh` is unchanged — it keeps calling
`claude --dangerously-skip-permissions`; the bind makes that resolve to
Quantico.

### Capability flag

New env var `FBI_QUANTICO_ENABLED=1`, read by both servers at boot. When unset:

- The "Use mock Claude" UI is hidden.
- `POST /api/runs` rejects `mock: true` with HTTP 400.
- `runs.mock` is ignored by both orchestrators.

This single switch keeps Quantico fully invisible in production.

### What Quantico is *not*

- Not a general-purpose Claude mock. It impersonates only:
  `claude --dangerously-skip-permissions`,
  `claude --resume <id> --dangerously-skip-permissions`,
  `claude plugin marketplace add <x>`,
  `claude plugin install <x>`.
  Other invocations exit non-zero with a clear "unsupported" message.
- Not in the production image. Bind-mounted only when explicitly enabled.

## Scenario model

Behavior is layered. Higher layers override lower ones. Resolution order
(highest wins):

1. `--scenario-file <path>` / `MOCK_CLAUDE_SCENARIO_FILE`
2. `@quantico:<name>@` token in the prompt on stdin
3. `--scenario <name>` / `MOCK_CLAUDE_SCENARIO`
4. Built-in `default`

### Built-in scenario library

Scenarios live as YAML files at `cli/quantico/scenarios/*.yaml`, embedded into
the binary at compile time via `include_str!`.

| name | what it does |
|---|---|
| `default` | steady prose with fake tool-call lines, ~30s, exit 0 |
| `chatty` | same shape, ~5 minutes of output for scrolling stress |
| `limit-breach` | 60s of prose, then emits `Claude usage limit reached\|<epoch+1h>`, then idle |
| `limit-breach-human` | same but uses the human variant: `Claude usage limit reached. Your limit will reset at 5pm.` |
| `crash-fast` | prints one line, exits 1 |
| `hang` | prints one line, ignores SIGTERM, sleeps forever |
| `garbled` | invalid UTF-8 + malformed escape sequences; tests xterm.js parsing |
| `slow-startup` | sleeps 30s before any output |
| `env-echo` | prints structured env / cwd / mounts / argv block, exits 0 |
| `resume-aware` | emits a marker line distinguishing `--resume` from fresh starts |
| `tool-heavy` | mostly fake tool-call transcript lines for visual QA |
| `plugin-fail` | `plugin install` exits non-zero (tests supervisor's warn path) |

### Scenario YAML format

```yaml
name: custom-thing
steps:
  - emit: "Reading the codebase...\n"
  - sleep_ms: 2000
  - emit_ansi: "\x1b[32m✓\x1b[0m done\n"
  - sleep_ms: 1000
  - write_jsonl: { type: "user", content: "..." }
  - emit_limit_breach: { reset_epoch: "+1h" }
  - sleep_forever: true
```

Step types in v1: `emit`, `emit_ansi`, `sleep_ms`, `write_jsonl`,
`emit_limit_breach`, `exit`, `sleep_forever`, `echo_env: [VAR1, VAR2]`. Future
scenarios add more types as needed.

### Speed multiplier

A global `MOCK_CLAUDE_SPEED_MULT` env var (default 1.0) scales every
`sleep_ms` and `chars_per_sec`. CI sets it to 10.0 for fast tests; humans
leave it at 1.0 when watching a run live.

## Behavior implementation notes

| ref | behavior | mechanism |
|---|---|---|
| (a) | steady output | embedded ~50KB lorem corpus, scheduler emits ~50-char chunks every 50ms (rate configurable per scenario) |
| (b) | ANSI styling | scenarios use SGR codes matching real Claude (bold cyan headers, dim grey timestamps, `\r` spinner); `garbled` emits malformed sequences |
| (c) | session JSONL writes | on startup, generate v4 UUID `session_id` (or reuse `--resume`), append minimal valid JSON entries to `$HOME/.claude/projects/<encoded-cwd>/<session_id>.jsonl` at ~1 entry per 3s |
| (d) | usage-limit breach | `emit_limit_breach` writes the literal limit line to stdout; subsequent steps stop appending JSONL; existing `LimitMonitor` fires after `idleMs` |
| (e) | `--resume <id>` | parse the flag; if JSONL missing, exit 1 with the real Claude error string; if present, append a marker line and run the chosen scenario |
| (f) | env / cwd / mount echo | `env-echo` scenario prints a structured `[quantico] env.X=...` block |
| (g) | crash modes | `crash-fast`, `hang` (with SIGTERM-ignoring handler), `slow-startup` |
| (h) | plugin install no-ops | `plugin marketplace add` and `plugin install` exit 0 with a one-line success message; `plugin-fail` scenario inverts this |
| (i) | fake tool calls | canned `Read(...)`, `Bash(...)`, `Edit(...)` blocks formatted to match real Claude transcripts; `tool-heavy` scenario does mostly this |

## Database & API

### Migration

One Ecto migration adds two columns to `runs`:

- `mock BOOLEAN NOT NULL DEFAULT 0`
- `mock_scenario TEXT` (nullable)

Mirrored in the TS Drizzle schema. Existing rows backfill to `0` / `NULL`.

### API

`POST /api/runs` body gains optional fields:

- `mock?: boolean` (default false)
- `mock_scenario?: string | null`

Validation:

- `mock_scenario` must be a name in Quantico's built-in library (or `null`).
- HTTP 400 if `mock=true` and `FBI_QUANTICO_ENABLED` is unset.

New endpoint `GET /api/quantico/scenarios` returns the list of valid scenario
names. Both servers proxy this to a static JSON file generated at build time
from `cli/quantico/scenarios/*.yaml` so the list cannot drift.

## UI

A new collapsed-by-default section in the run-create form, rendered only when
`GET /api/quantico/scenarios` returns 200:

```
▸ Mock mode (Quantico)
  ☐ Use mock Claude instead of the real one
  Scenario: [ default ▾ ]   ← populated from the API
  ⓘ Bypasses the LLM. For testing terminal/auto-resume/env behavior.
```

Lives alongside the existing model-params block in the run-create form. When
the box is unchecked, the request omits both fields; the server treats that
identically to a non-mock run today.

## Test layer

Three layers, in increasing distance from Quantico itself.

### Layer 1 — Quantico's own Rust tests

`cli/quantico/src/**` with `#[cfg(test)]`. Coverage:

- Scenario YAML parser: round-trip, malformed input, unknown step types.
- Step executor: each step type tested in isolation. `emit_limit_breach`
  produces the right bytes; `write_jsonl` writes a valid JSONL line at the
  expected path; `sleep_ms` honors `MOCK_CLAUDE_SPEED_MULT`.
- Argv parser: `--resume <id>`, `--dangerously-skip-permissions`,
  `plugin install <x>`.
- Prompt-token scanner.

Run via `cargo test -p quantico` on every PR.

### Layer 2 — Reusable TS helper module

`tests/e2e/quantico/helpers.ts`. Sketch of the API:

```ts
export async function createMockRun(
  page: Page,
  opts: { scenario: ScenarioName; prompt?: string; branch?: string; project?: string },
): Promise<RunHandle>;

export interface RunHandle {
  id: number;
  page: Page;
  waitForState(state: RunState, opts?: { timeoutMs?: number }): Promise<void>;
  waitForTerminalText(needle: string, opts?: { timeoutMs?: number }): Promise<void>;
  terminalText(): Promise<string>;
  expectScrolledToBottom(): Promise<void>;
  wsFrames(): readonly WsFrame[];
  destroy(): Promise<void>;
}

export const Scenarios = {
  default: "default",
  limitBreach: "limit-breach",
  hang: "hang",
  envEcho: "env-echo",
  // ... auto-generated from scenarios/*.yaml at build time
} as const;
```

The helper:

- Talks to a live FBI server started by the test harness on a free port, with
  `FBI_QUANTICO_ENABLED=1` and `MOCK_CLAUDE_SPEED_MULT=10`.
- Drives the run-create form via Playwright (not the API directly), so the
  form itself gets exercised.
- Installs a single WS frame capture hook at page load, so `wsFrames()` does
  not require per-test setup.

### Layer 3 — Playwright tests

`tests/e2e/quantico/*.spec.ts`. One spec file per scenario family:

| spec | assertion |
|---|---|
| `default.spec.ts` | run completes; terminal contains expected prose; auto-scroll stayed pinned; no WS frame loss vs. server-side log |
| `ansi.spec.ts` | scenario emits styled lines; xterm.js DOM has the right `xterm-fg-32` etc. classes |
| `auto-scroll.spec.ts` | mid-run, user scrolls up → "jump to bottom" pill appears; click pill → returns to bottom; new output stays pinned |
| `env-echo.spec.ts` | every env var the orchestrator promises shows up in the terminal with the right value |
| `limit-resume.spec.ts` | limit-breach → run enters waiting state → after the (sped-up) reset window, run auto-resumes with `--resume <id>` and continues |
| `crash.spec.ts` | `crash-fast` → run row marked failed with exit 1; `hang` → supervisor escalates and eventually kills the container |
| `resume-aware.spec.ts` | manual continue-run path: starting a new run with `--resume` sees the prior session JSONL and emits the resume marker |
| `garbled.spec.ts` | invalid UTF-8 / runaway escape sequences do not crash the renderer; the connection stays open |

### CI matrix

New GitHub Actions job `e2e-quantico` runs the Playwright suite. Requires
Docker (already required for orchestrator integration tests). Skipped on PRs
from forks. Speed multiplier of 10× keeps the full suite under a couple of
minutes.

To make `limit-resume.spec.ts` deterministic, `LimitMonitor`'s `idleMs` and
`warmupMs` are made configurable via env vars (`FBI_LIMIT_MONITOR_IDLE_MS`,
`FBI_LIMIT_MONITOR_WARMUP_MS`); production defaults stay untouched and the
test harness sets them low.

### Existing unit tests

The inline shell stub for `claude` in `supervisor.test.ts` and friends stays
unchanged — it is the right tool for those tests. Quantico is only invoked
from tests that want real Quantico behavior (e.g., a TS-side `LimitMonitor`
integration test that runs the binary against a fixture mount dir).

## Risks & mitigations

1. **Drift between Quantico and real Claude.** A "fidelity probe" job runs on
   a schedule (not per PR, since it costs tokens), invokes real `claude`,
   captures key strings (limit message wording, JSONL field names) and diffs
   against a checked-in snapshot. When it fails, someone updates Quantico.

2. **Bind-mount path coupling.** `install.sh` copies the binary to
   `/usr/local/lib/fbi/quantico` when `FBI_QUANTICO_ENABLED=1`; the
   orchestrators look there first, with the workspace-relative path as a
   dev-only fallback.

3. **Test flakes from real timing.** `LimitMonitor`'s `idleMs` and `warmupMs`
   are env-tunable so the test harness can set them low; production defaults
   are untouched.

4. **Bypassing the OAuth bind in mock mode could mask real bugs.**
   `env-echo.spec.ts` asserts the bind is skipped only when expected. The
   existing real-claude orchestrator integration tests remain the source of
   truth for OAuth bind behavior.

5. **`mock` and `mock_scenario` columns are dev-only data forever.** Mild
   schema-noise cost; cheaper than introducing a separate `dev_runs` table.

## Trade-offs accepted

- **Built-in scenario library compiled into the binary** (vs. always reading
  from disk): scenarios cannot be hot-edited in production; in exchange, they
  are versioned with the binary and there is no missing-file debugging. The
  YAML override path is still available for one-off cases.
- **Skipping image-bake**: every mock run pays one extra bind-mount; in
  exchange, Quantico iteration is rebuild-free and production images stay
  byte-identical to today.
- **No visual-snapshot tests in v1**: keeps the suite low-flake. Percy or
  Playwright pixel diffs can be added later if visual regressions become a
  real problem.

## Non-goals

- Mocking sub-agents, MCP servers, plugin code execution, or the actual
  file-edit semantics. Quantico mimics Claude's stdout/stdin/argv/file-write
  surface only; what it claims to "do" inside is purely text.
- Recording-and-replay of real sessions. Possible v2 if the YAML proves too
  tedious to write by hand.
- Replacing the existing inline shell stubs in `supervisor.test.ts` and
  friends. Those tests have a different shape and do not need a real binary.
- Tests for the desktop app's terminal — same xterm.js, but a different
  process model and out of scope for this round.
