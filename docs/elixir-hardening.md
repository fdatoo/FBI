# FBI — Elixir hardening recommendations

**Purpose:** Forward-looking list of Elixir/OTP/Phoenix features the
server doesn't yet use that would systematically improve robustness
and observability. This is what to *add* now that the server is
stable.

**Context:** post-Phase-7 stabilization surfaced several classes of
silent-failure bug in the Docker integration (build → tag race;
inotify-missing watcher cascade; `recv_until_close` 60s truncation;
broken cached postbuild layer; etc.). Each was caught and fixed, but
the underlying issue is that the orchestrator's success path leans on
"Docker said OK" rather than "the side effect is observable." Many of
the items below are about closing that gap structurally, not just on
the calls we know about today.

**Priority legend:**

- **P1** — closes a real existing gap, low cost, would have caught
  one or more bugs we already shipped fixes for
- **P2** — large dividend on observability or design clarity, medium
  cost
- **P3** — worth doing eventually, but defer until the immediate fires
  are out

---

## P1 · `:telemetry` events at every Docker boundary

**Status:** todo

Phoenix already pulls in `:telemetry`. Emit
`[:fbi, :docker, :request, :start | :stop | :exception]` events from
`FBI.Docker.rest/4` and `FBI.Docker.stream_start/4` with metadata
`%{operation: :start_container | :build_image | …, container_id: …,
status: integer, latency_ms: …}`.

Pair with the post-condition checks added in `1cd68cb`. Together you
get free operational visibility — latency histograms per Docker call,
error rates per endpoint, slow-build detection — without scattering
`Logger.warning` calls.

Composes with `TelemetryMetricsPrometheus` /
`TelemetryMetricsStatsD` if dashboards are ever wanted.

**Effort:** ~30 minutes. **Value:** permanent visibility win, never
have to retrofit later.

---

## P1 · `Logger.metadata(run_id: ..., container_id: ...)` per lifecycle

**Status:** todo

At the top of `FBI.Orchestrator.RunServer.run_lifecycle/4`, set
`Logger.metadata(run_id: run_id)` (and add `container_id: cid` once it
exists). Every log line emitted from that process — and any process
it spawns — gets tagged.

Means `journalctl … | grep run_id=4` actually finds everything
related to run 4 instead of having to read timestamps and request IDs
to correlate. Also surfaces in `bin/fbi rpc` queries against the
running node.

**Effort:** ~10 minutes. **Value:** every future debugging session
gets faster.

---

## P1 · `Task.Supervisor` for `read_stdout_loop`

**Status:** todo

Today's stdout reader is `spawn(fn -> read_stdout_loop(...) end)` in
`run_server.ex` — bare spawn, no supervisor, no SASL crash log. If
the function dies for a reason `recv_chunked` doesn't handle (a new
Docker behavior, a port disconnect we haven't seen, an `:einval`),
you find out by the WS going silent.

Replace with:

```elixir
{:ok, reader_pid} =
  Task.Supervisor.start_child(FBI.RunTaskSupervisor, fn ->
    read_stdout_loop(stdout_socket, run_id, on_bytes)
  end)
```

Add `FBI.RunTaskSupervisor` to the application's children list. Same
shape, but: crashes get a SASL report in the journal, restarts are
controllable via the supervisor's strategy, and `Task.Supervisor.children/1`
lists every active reader for live introspection.

**Effort:** ~5 minutes. **Value:** closes a real silent-failure gap.

---

## P2 · Per-run supervisor tree

**Status:** todo

The migration spec's thesis was *"supervised per-run actors, a
state-machine lifecycle, six watchers per run, WebSocket fan-out,
crash recovery — exactly what OTP supervision trees, GenServer,
gen_statem, and Phoenix Channels provide natively."* The current
implementation has the `RunServer` GenServer but the reader, attach
socket, and six watchers are linked-but-not-supervised children
managed via ad-hoc `Process.exit/2` and `stop_watchers/1`.

Promote each run to its own `Supervisor` module with explicit
children:

```
FBI.Orchestrator.RunSupervisor (DynamicSupervisor)
└── FBI.Orchestrator.PerRun.Supervisor (per run, :rest_for_one or :one_for_one)
    ├── FBI.Orchestrator.RunServer
    ├── FBI.Orchestrator.ReaderTask  (Task.Supervisor child)
    ├── FBI.Orchestrator.UsageTailer
    ├── FBI.Orchestrator.TitleWatcher
    ├── FBI.Orchestrator.SafeguardWatcher
    ├── FBI.Orchestrator.MirrorStatusPoller
    ├── FBI.Orchestrator.RuntimeStateWatcher
    └── FBI.Orchestrator.LimitMonitor
```

With `:one_for_one`: a watcher crash restarts only that watcher.

With `:rest_for_one`: a reader crash takes everything downstream of
it down (since they all depend on bytes flowing).

Either is more legible than today's tangle of
`Process.exit(reader_pid, :kill)` and `stop_watchers/1`. This is the
unfinished half of the spec's payoff — the rewrite's "complexity
collapse under OTP" lives here.

**Effort:** ~half a day. **Value:** the spec's headline benefit,
realized.

---

## P2 · `Mox` behaviour mocks for `FBI.Docker` in tests

**Status:** todo

Define an `FBI.Docker.Behaviour` covering the public functions
(`create_container/1`, `start_container/1`, etc.). Switch the
implementation behind it. In tests, mock with `Mox`.

Today, the chunked decoder, build-output framing, and post-condition
logic in `FBI.Docker` have no unit tests because they all touch a
real Docker socket. A `Mox`-based test that replays a captured
`/build` byte stream catches regressions a `docker images` smoke
check can't, and exercises edge cases (truncated chunk, malformed
JSON event, premature close) without needing Docker at all.

**Effort:** ~1 day for the behaviour + initial test suite, ongoing
gain per test added.

**Value:** the streaming-endpoint code is where the bugs keep being.
Unit tests there pay back fast.

---

## P3 · `gen_statem` for the run lifecycle

**Status:** todo (defer)

The states `queued → starting → running → waiting → {succeeded,
failed, cancelled, awaiting_resume}` are currently encoded as a
`state` column on `runs` plus `Queries.mark_*` calls scattered
through `run_lifecycle/4`. A `gen_statem` would:

- Centralize the legal transitions in one place
- Give `:sys.get_state/1` live inspection of which state each run
  is in and how long it's been there
- Make adding new states (e.g., `:building_image` substate) safe by
  forcing all transition logic to be reviewed

Defer until the immediate fires are out — refactoring the lifecycle's
state model is invasive and the current implementation isn't actively
broken, just sloppy.

**Effort:** ~2 days. **Value:** clarity gain rather than bug-fix
gain. Worth it eventually.

---

## P3 · Structured logging policy

**Status:** todo

Once `Logger.metadata(run_id: ...)` is in place (P1), formalize a
metadata schema:

- `run_id` — every lifecycle log
- `container_id` — every Docker boundary log
- `operation` — every Docker boundary log (`:start_container`, `:build_image`, …)
- `phase` — `run_lifecycle` mode (`:launch | :resume | :continue | :reattach`)

Configure the Logger formatter to include these fields. Pairs with
the telemetry events to give Prometheus + Grafana a clean time series.

**Effort:** ~half a day. **Value:** compounds with #1 and #2.

---

## Deliberately not in scope

These were considered and ruled out:

- **`Phoenix.Channels` for the shell socket.** The current `WebSock`
  handler is fine; channels' presence/heartbeat/ack semantics are
  over-spec for "stream PTY bytes." Adopting channels would be a
  rewrite for negligible gain.

- **Circuit breaker (`:fuse`, `CircuitBreaker`) wrapping Docker.**
  Docker outages on the same host are vanishingly rare; the
  bookkeeping cost doesn't pay back.

- **Property-based tests of `FBI.Orchestrator.Tar.build/1`.** Tempting
  given the suspect byte-layout (devmajor/devminor 12 bytes vs.
  spec's 8). A single hand-written round-trip test that builds a tar
  with `Tar.build/1`, sends it to Docker `/build`, and asserts the
  output image has the expected files would catch the same class of
  bugs more reliably with less ceremony.

- **`Oban` for run lifecycle.** Run lifecycle is long-running,
  stateful, holds open sockets, can't be retried idempotently — the
  opposite of what Oban is designed for. Oban *is* a good fit for
  the periodic tasks (usage poller, draft-uploads GC, mirror status
  poller, image GC); migrating those is a separate, smaller decision.

- **`LiveView` anywhere user-visible.** The migration spec already
  ruled this out: terminal UX is much weaker under LiveView than
  the current React + xterm.js setup, and there's no path to LiveView
  for the terminal that doesn't require rewriting the frontend.

---

## Suggested order

1. **P1s as a bundle** — telemetry + Logger.metadata + Task.Supervisor
   together. ~1 hour total, all three compose, all three close gaps
   we've actually been hit by.
2. **Per-run supervisor tree (P2)** — half a day, realizes the
   migration spec's main thesis. Worth doing while the lifecycle code
   is fresh in everyone's head.
3. **Mox + Docker test suite (P2)** — gives the streaming-endpoint
   code (which keeps surprising us) a regression net.
4. **gen_statem + structured logging (P3)** — defer until the above
   shake out. Both are clarity wins, not bug-fix wins.

Items implemented from this list should be moved into commit messages
or, if they generate new patterns worth referencing, into
`src/server/AGENTS.md`.
