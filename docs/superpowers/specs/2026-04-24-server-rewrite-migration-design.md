# Server rewrite migration design

**Date:** 2026-04-24
**Status:** Approved — proceed to writing-plans for Phase 1
**Supersedes:** none
**Related:** the Phoenix scaffold at `server-elixir/` committed on main 2026-04-24

## Overview

The FBI server is ~14k LoC of TypeScript built on Fastify, better-sqlite3, and dockerode. This document specifies the migration to Elixir + Phoenix + OTP.

The rewrite's thesis: the server's hot core — supervised per-run actors, a state-machine lifecycle, six watchers per run, WebSocket fan-out, crash recovery — is hand-rolled in TypeScript but is exactly what OTP supervision trees, `GenServer`, `gen_statem`, and Phoenix Channels provide natively. The current 1,096-line `Orchestrator` class plus `ResumeScheduler`, `RunStreamRegistry`, and scattered watcher classes collapse substantially once the runtime supplies those primitives.

Migration runs as a strangler-fig pattern: the Elixir server owns the public port from day one and proxies unported routes to the TS server on loopback. Each phase ports a named module, shrinking the proxy surface by one module. Nine phases total; Phase 7 (the orchestrator) is ~60% of the total effort.

## Done criteria

Every route in the current TS API (≈53 HTTP + 3 WebSocket) is served by the Elixir server with **byte-compatible request/response shapes** — same URLs, same JSON keys, same HTTP codes, same headers. The React frontend receives zero coordinated changes during the port. Feature parity is verified by porting the existing vitest suite to ExUnit and by a per-route contract-fidelity test harness. After cutover, the TS server process is removed from the systemd install and Node is no longer a prerequisite.

## Non-goals

- **No schema redesign.** Existing SQLite DB at `/var/lib/agent-manager/db.sqlite` and the encrypted secrets key at `/etc/agent-manager/secrets.key` stay byte-identical through and past cutover.
- **No frontend changes during the port.** React at `src/web/` gets no coordinated changes. Any API polish happens post-cutover as separate work.
- **No Postgres.** SQLite via `ecto_sqlite3` is the long-term choice.
- **No LiveView.** Phoenix handles REST + WebSocket only; React handles the UI. LiveView's terminal UX is weaker than the current React + xterm.js + WebSocket setup, and adopting it would require rewriting the frontend — scope expansion we don't want.
- **No `fbi-tunnel` port.** The Go CLI at `cli/fbi-tunnel/` distributes as a cross-compiled static binary to end-user laptops, a constraint Go handles better than Elixir (no runtime dependency, ~10 MB binary, fast startup). Revisit post-cutover if Burrito matures.

## Crossover architecture

Two OS processes run side by side during migration:

```
                    ┌─────────────────────┐
   Tailscale LAN ──►│ Elixir (Phoenix)    │ :3000 (public)
                    │   fbi-elixir.service│
                    └─────────┬───────────┘
                              │
           ┌──────────────────┼────────────────────┐
           │                  │                    │
      Ported route      WS upgrade                 │
      (native Plug)   (native Channel)        Unported route
                                              (proxy to :3001)
                                                    │
                                                    ▼
                                         ┌─────────────────────┐
                                         │ TS (Fastify)        │
                                         │   fbi.service       │ :3001 (loopback)
                                         └─────────┬───────────┘
                                                   │
           Shared state: /var/lib/agent-manager/db.sqlite,
                         /etc/agent-manager/secrets.key,
                         /var/lib/agent-manager/runs/,
                         Docker socket
```

- **Elixir binds `0.0.0.0:3000`** — the public port TS binds today.
- **TS moves to `127.0.0.1:3001`** — loopback-only, reachable only from Elixir. Its `fbi.service` systemd unit becomes an internal implementation detail during crossover.
- **A catch-all Plug** at the end of Elixir's router forwards unported routes to `http://127.0.0.1:3001` via `Req` (HTTP) and `Mint.WebSocket` (WebSocket upgrades). Roughly 100 lines total including frame-level WS passthrough.
- **Each ported phase** registers native Phoenix routes before the catch-all; the catch-all's effective surface shrinks automatically.
- **Shared SQLite DB** — WAL mode handles two concurrent writers at this load (peak <10 writes/sec combined, well below SQLite's WAL ceiling).
- **Shared secrets key** — AES-256-GCM is a standard. Elixir's `:crypto.crypto_one_time_aead(:aes_256_gcm, ...)` decrypts TS-encrypted blobs bit-identically. Zero compatibility code needed beyond a round-trip fixture test in Phase 4.
- **Shared runs dir + Docker socket** — both processes can spawn containers and read/write run state dirs. During crossover, only TS *creates* runs; Elixir reads them for list/get. Write responsibility transfers when Phase 7 ports the orchestrator.

**Deploy.** Two systemd units, `fbi-elixir.service` and `fbi.service`, both dependent on `docker.service`. At cutover (Phase 9), `fbi.service` and its Node runtime are removed from `install.sh`.

## Feature-freeze policy during the port

**Soft freeze on the orchestrator surface.** The soft freeze is narrow and specific: any change that would modify the orchestrator, run lifecycle, watchers, resume/continue state machine, image builder, or per-run WebSocket code lands *only* on the Elixir side (which may mean blocking a change until Phase 7 ships). These areas are where the rewrite's complexity collapse lives; porting changes twice creates drift risk for little benefit.

**No freeze on leaf routes and UI.** Settings polish, MCP management, project CRUD refinements, usage display improvements, any React UI work — all keep shipping on TS. The Elixir proxy picks up new TS routes automatically; when that module gets ported, the new routes port along with everything else.

The soft freeze justifies ordering Phase 7 (orchestrator) last: the freeze is more acceptable the shorter it is, and everything in Phases 2–6 can ship in parallel with continued TS feature work.

## Phase list

| # | Phase | Routes ported | End criterion | Complexity |
|---|---|---|---|---|
| **1** | **Crossover plumbing + usage** | `/api/usage*`, `/api/ws/usage` | Usage page loads from Elixir; WS updates flow through; TS listens on `:3001`; unported routes proxy transparently. | **High** (plumbing is the unknown) |
| **2** | Settings + config + CLI download | `GET/PATCH /api/settings`, `GET /api/config/defaults`, `GET /api/cli/fbi-tunnel/:os/:arch` | Settings page editable; `fbi-tunnel` binary downloads. `POST /api/settings/run-gc` stays proxied (needs orchestrator). | Low |
| **3** | MCP servers (global) | `/api/mcp-servers` CRUD | MCP admin page works standalone. | Low |
| **4** | Projects + secrets + project-scoped MCP | `/api/projects` CRUD, `/api/projects/:id/secrets` PUT/DELETE/GET, `/api/projects/:id/mcp-servers/*`, `/api/projects/:id/prompts/recent` | Project CRUD works; **secrets round-trip between TS-encrypted and Elixir-encrypted blobs** (AES-GCM compat verified with a test fixture from the TS side). | Medium |
| **5** | Runs — read-only | `GET /api/runs`, `/api/runs/:id`, `/…/file-diff`, `/…/files`, `/…/transcript`, `/…/siblings`, `/…/uploads`, `/…/github` (read), `/api/projects/:id/runs` | Run list/detail pages display correctly while **TS still creates runs** and Elixir reads them. | Medium |
| **6** | Draft uploads + non-orchestrator run mutations | `POST/DELETE /api/draft-uploads*`, `POST/DELETE /api/runs/:id/uploads*`, `PATCH /api/runs/:id`, `DELETE /api/runs/:id`, draft-uploads GC loop | File uploads work end-to-end; run metadata editable/deletable. | Low-medium |
| **7** | **Orchestrator + run creation + shell/proxy WS + state WS** | `POST /api/projects/:id/runs`, `POST /api/runs/:id/{continue,resume-now}`, `POST /api/settings/run-gc`, `GET /api/runs/:id/{shell,listening-ports,proxy/:port}`, `GET /api/ws/states` | Run created from UI executes entirely under Elixir's supervision tree; all 6 watchers run as linked GenServers under per-run supervisors; Phoenix Channels replace `RunStreamRegistry`. **Write responsibility for `runs` table transfers from TS to Elixir at this phase's cutover.** | **Very high** |
| **8** | GitHub mutations + tail | `POST /api/runs/:id/github/{merge,pr}`, any remaining routes | `gh` CLI wrapper port + cleanup. | Low |
| **9** | **Cutover** | — | TS proxy catch-all removed; `fbi.service` deleted from systemd; Node runtime no longer a Prerequisite; `src/server/` archived or removed; `src/shared/` audited for web-only remains. | Low |

### Effort shape

Phase 7 dominates. Rough distribution (eyeballed):

- Phases 1–6 + 8 + 9: together ~40% of the total port effort — mostly straightforward CRUD, Ecto schemas, and Channel scaffolding.
- Phase 7: ~60% of total effort on its own. Subtle behaviors live here: resume eligibility, rate-limit bucket state, per-run shell streaming, container exec helpers, the `supervisor.sh`/`finalizeBranch.sh` interface, reattach-on-restart.

Phase 1's explicit job is to de-risk the crossover plumbing *before* Phase 7 has anywhere to land. If Phase 1 works cleanly, Phases 2–6 are low-risk practice that builds fluency for Phase 7.

### Why this ordering (vs. alternatives)

- **Respects the soft freeze.** Orchestrator is last; everything before is leaf CRUD and read paths, which lets TS feature work continue unblocked on modules 2–6.
- **Progressive proxy shrink.** After each phase, the TS proxy surface shrinks by a named module. Rollback granularity is per-phase.
- **Each phase is shippable.** You could stop after Phase 5 and be in a stable crossover state indefinitely — everything still works, Elixir serves some routes, TS serves the rest.
- **Agent-friendly.** Each phase has bounded scope, a clear end check, minimal coupling to others. Suitable for subagent-driven implementation.

Alternatives considered and rejected:

- **Observable-surface first** (all reads before any writes): splits read and write paths unnaturally, forcing the same module to be touched twice with the TS state model in mind during each pass.
- **Orchestrator-first after proof-of-concept:** bets everything on the hardest phase. If Phase 7 stalls, nothing else is on Elixir to show progress.

## Phase 1 — full detail

### Scope

Phase 1 delivers two things: **the crossover plumbing that every later phase depends on**, and **the usage module port end-to-end** (including WebSocket). Nothing else.

### Components

#### Elixir side

- **`FBIWeb.Router`** — a catch-all `match :*` route at the tail that dispatches to `ProxyPlug`. Native routes register before it. Each ported phase adds routes before the catch-all.
- **`FBIWeb.ProxyPlug`** — HTTP reverse proxy to `http://127.0.0.1:3001` using `Req`. Preserves method, headers (minus hop-by-hop), body streaming, status, and response headers.
- **`FBIWeb.ProxySocket`** — WebSocket upgrade forwarder using `Mint.WebSocket`. Accepts the client upgrade, opens its own upgrade to TS, pumps frames bidirectionally. **Stress-tested via the still-proxied `/api/runs/:id/shell` endpoint**, which remains proxied until Phase 7 — real-world WS load on the proxy.
- **`FBIWeb.UsageController`** — the three REST endpoints (`GET /api/usage`, `GET /api/usage/daily?days=N`, `GET /api/usage/runs/:id`). Thin controllers; logic lives in the poller and repo.
- **`FBIWeb.UsageChannel`** — Phoenix Channel for `/api/ws/usage`. On join, `Phoenix.PubSub.subscribe(FBI.PubSub, "usage")`; rebroadcasts poller events to the client.
- **`FBI.Usage.Poller`** — `GenServer` supervised under the main application tree. 5-minute interval via `Process.send_after/3`, `nudge/0` API for credential-change triggers with the same rate-limit gate as TS (nudges never poll sooner than 5 minutes since last attempt). Calls Anthropic's OAuth usage and profile endpoints via `Req`. Writes to rate-limit tables; broadcasts to `"usage"` PubSub topic.
- **`FBI.Usage.CredentialsReader`** — `GenServer` that reads `~/.claude/.credentials.json` and emits change events via PubSub (uses `FileSystem` dep for inotify). Mirrors the TS `CredentialsReader` pattern.
- **Ecto schemas + repos:** `FBI.Usage` (per-run usage breakdown), `FBI.RateLimitState` (singleton), `FBI.RateLimitBucket` (many). Mirror existing SQL exactly. Read/write query helpers only; migrations stay with TS.

#### TS side

- Bind to `127.0.0.1:3001` via `HOST=127.0.0.1 PORT=3001` in `/etc/default/fbi`.
- **Disable the TS poller** via env var `FBI_OAUTH_POLLER_DISABLED=1`. Anthropic's usage API is rate-limited to one call per 5 minutes per token; two pollers trigger rate limiting. Single-writer enforcement transfers to the Elixir side.

#### Deploy / systemd

- New unit: `fbi-elixir.service` — depends on `docker.service`, `ExecStart=/opt/fbi-elixir/bin/fbi start`, user `fbi`.
- Modify `fbi.service` env to add the loopback bind and poller-disabled vars.
- `install.sh`: build the Elixir release (`MIX_ENV=prod mix release`), rsync to `/opt/fbi-elixir`, install both unit files. Keep the existing TS build path.
- README: update Prerequisites — Erlang/OTP 27 + Elixir 1.18 now required on the server.

### Work order

1. **Elixir proxy skeleton only.** No native routes; all traffic forwarded to TS at `:3001`. Boot locally with both processes running; verify React UI works identically through Elixir:3000 as before through TS:3000.
2. **Usage Ecto schemas + repos + tests.** Port relevant vitest units to ExUnit. Read-path only.
3. **Poller + CredentialsReader.** Port vitest unit tests. Standalone verification before wiring to Application.
4. **UsageController + UsageChannel + Application wiring.** Register routes before the catch-all; start the poller under `FBI.Application`.
5. **Deploy flip in dev.** Dev config: TS binds loopback, Elixir public. Exercise end-to-end.
6. **Production deploy.** New install script lays down both units; env var disables TS poller on next restart.

Steps 1–4 are code; 5–6 are operational. Steps 1 and 4 carry the Phase's real risk (WS proxy, poller state transfer).

### Contract fidelity

- Each ported route has a golden-response test: call TS implementation, snapshot the JSON body + status + content-type, assert Elixir returns bit-identical output on the same inputs.
- WebSocket fidelity: open `/api/ws/usage` on TS, capture the message stream, replay the same poller inputs on Elixir, assert same JSON messages in the same order. (Timestamps will differ; the assertions focus on shape and key names.)
- Generic catch-all smoke: with both servers running locally, hit every route from the route list via a small script and diff responses. Sanity check only; real tests are per-route.

### Rollback

- Single-lever rollback: swap `PORT` values in `/etc/default/fbi` and `/etc/default/fbi-elixir`, restart both. TS returns to `:3000`; Elixir idles or is stopped. Shared DB means no data rollback is needed.
- Both sides still contain their implementation of `/api/usage*` during Phase 1 (native implementations are additive), so rollback is zero-data-loss and zero-request-loss.

### Acceptance

- `mix test` passes (all ported unit tests + new proxy tests).
- `GET /api/usage` from the UI returns identical JSON to pre-Phase-1.
- `/api/ws/usage` connection receives identical message stream.
- `/api/runs/:id/shell` (proxied to TS) works: keystrokes forward, PTY bytes flow back. **The real WS proxy stress test.**
- TS process listens only on `127.0.0.1:3001` (verify via `ss -lntp`).
- Anthropic OAuth API receives exactly one poll per 5 minutes regardless of credential changes or run activity.

### Open questions for the implementation plan

- `Mint.WebSocket` vs `:gun` for the WS proxy. Both work; pick on stream back-pressure semantics. Lean: `Mint.WebSocket` (same company as Phoenix, actively maintained).
- Supervision strategy for the poller: `:transient` (no restart on `:shutdown`) vs `:permanent`. Lean: `:transient`.
- Release packaging: plain `mix release` tarball vs a more bundled artifact. Lean: plain release; systemd handles lifecycle.
- CI updates: `mix test` + `mix compile --warnings-as-errors` added alongside existing `npm test`.

## Cross-phase concerns

### Code quality / teaching standard

Every Elixir module is written on the assumption that **the reader is a strong engineer who does not yet know Elixir and is learning the language through this codebase**. This is stricter than typical Elixir application practice (where `@moduledoc false` and sparse `@doc`s are common); the extra discipline is specifically for the reading-to-learn case. Post-cutover, when Elixir feels natural, the bar can relax for new code.

Concrete expectations:

- **`@moduledoc` on every module** — what the module is (role in the system), what OTP primitive it uses (`GenServer`, `Supervisor`, `gen_statem`, `Channel`, plain module), and why that primitive was chosen. Example tone: *"`TitleWatcher` is a `GenServer` — one instance per active run. It polls a file every second and broadcasts title changes via PubSub. Chosen as a `GenServer` rather than a `Task` because it holds state (the `last` value) and responds to signals."*
- **`@doc` on every public function** — explain why the function exists and any non-obvious invariants. `@spec` types are mandatory.
- **Inline comments explain decisions, not what the code does.** First use of `with`, choice of `GenServer.call` vs `cast`, restart strategy selection — one-line comment on *why*.
- **First-use annotations** on language features per module. When a file uses `|>`, `with`, pattern matching in function heads, or `@impl true` for the first time, a brief explanation appears near the use.
- **Avoid point-free code.** Prefer `Enum.map(list, fn s -> String.upcase(s) end)` over `Enum.map(&String.upcase/1)` in this codebase, with a comment explaining when the capture form is preferable.
- **Names do most of the work.** `awaiting_resume?`, `schedule_next_poll/1`, `decrypt_secret/2` — name + `@spec` should tell you what the function does without reading the body.
- **OTP patterns named explicitly.** If a module uses a supervision tree, the `@moduledoc` draws the tree in ASCII. If a module is a `gen_statem`, the `@moduledoc` lists states and legal transitions.

### DB schema ownership during crossover

**TS owns the schema until Phase 7.** The existing `src/server/db/schema.sql` + the `migrate()` function in `src/server/db/index.ts` remain the single source of truth for table structure during Phases 1–6. Elixir's Ecto schemas mirror SQL tables as read/write query helpers but **do not run migrations**. Rationale:

- TS continues in production during crossover and must not encounter unknown columns.
- Ecto migrations are designed around Ecto being the sole author; two migration authors create lock and order-of-apply headaches.
- Phase 7 takes over run creation — the natural moment to inherit schema ownership.

At cutover (Phase 9), schema.sql moves into `priv/repo/schema.sql` and future changes go through Ecto migrations.

If a schema change is needed mid-crossover (unlikely under soft freeze), it is added to `src/server/db/schema.sql` and mirrored in the relevant Ecto schema in the same commit.

### Encrypted secrets compatibility

The TS format is `nonce(12 bytes) || ciphertext || tag(16 bytes)` with AES-256-GCM. Elixir's equivalent:

```elixir
# encrypt
nonce = :crypto.strong_rand_bytes(12)
{ct, tag} = :crypto.crypto_one_time_aead(:aes_256_gcm, key, nonce, plaintext, "", true)
output = nonce <> ct <> tag

# decrypt
<<nonce::binary-size(12), rest::binary>> = blob
ct_size = byte_size(rest) - 16
<<ct::binary-size(ct_size), tag::binary-size(16)>> = rest
{:ok, plaintext} = :crypto.crypto_one_time_aead(:aes_256_gcm, key, nonce, ct, "", tag, false)
```

**Verification lives in Phase 4.** The port includes a round-trip test fixture: a known plaintext encrypted by TS, stored as a hex blob in a test file, and Elixir decrypts it at test time. Same fixture in reverse (Elixir encrypts → TS decrypts). This catches any accidental incompatibility before real secrets are touched.

### Testing strategy

- **vitest stays on the TS side** and runs in CI until TS is deleted at Phase 9.
- **ExUnit is the Elixir side's test system.** Each port phase ports the corresponding vitest tests to ExUnit. Pure-logic tests (pacing, parsers, `composePrompt`) port nearly mechanically. DB/HTTP/Docker-touching tests get rewritten in the ExUnit idiom (`ExUnit.CaseTemplate`, `Mox` for external mocks).
- **Contract fidelity tests** live in `server-elixir/test/fidelity/` and are deleted at cutover.
- **CI runs both suites in parallel:** `npm test` and `(cd server-elixir && mix test)`. Either failure blocks merge.
- **No E2E test rewrite.** Any Playwright coverage runs against the running stack and doesn't care which language serves each route.

### Rollback discipline

Every phase's implementation plan ends with a "how to roll back" paragraph. For Phases 1–6 (read-heavy, additive): rollback is putting the native Elixir route behind a feature flag or removing its router entry — TS still has its implementation, data is shared, no losses. For Phase 7: orchestrator cutover is the first non-trivial rollback; the Phase 7 plan spells out a "both orchestrators exist but only one is active" mechanism for the first few days.

### Deploy evolution

`install.sh` gets updates only on phases that add or remove moving parts:

- Phase 1: add `fbi-elixir.service`, modify `fbi.service` env for loopback + poller-disabled.
- Phase 9: remove `fbi.service`, remove Node build, rename/cleanup.
- Intervening phases: no install changes (they only shrink the router).

README Prerequisites update in Phase 1 (add Erlang/OTP + Elixir) and again in Phase 9 (remove Node).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **WebSocket proxy edge cases** (binary frames, ping/pong, backpressure, odd clients) | Medium | Blocks Phase 1; cascades to every later phase that depends on proxied WS | Phase 1's acceptance gate runs the real `/api/runs/:id/shell` PTY stream through the proxy. If `Mint.WebSocket` hits problems, swap to `:gun` or a thin Cowboy handler before investing in native routes. |
| **Phase 7 larger than scoped** | High — this is where the rewrite's payoff lives, and where optimism always bites | Could stretch the timeline and strand earlier phases in "proxy forever" | Split Phase 7 into sub-phases during plan-writing: (7a) read-path + reattach to existing TS-created runs, (7b) write-path + new run creation, (7c) shell/proxy WS, (7d) image builder + GC. Each independently shippable within the crossover model. |
| **SQLite contention under two writers** | Low (≤10 writes/sec combined; WAL handles this) | Intermittent `SQLITE_BUSY` errors | WAL is already on. Phase 1 adds a `busy_timeout` to the Ecto SQLite config (5s) so contention retries instead of erroring. Monitor via Phoenix telemetry. |
| **Secrets encryption incompatibility** | Low (AEAD is fully specified; both sides standard) | Production secrets unreadable — serious | Fixture-based round-trip test in Phase 4, committed as a test asset. No real secrets touched until that test is green. |
| **Project stalls mid-crossover** | Medium (common on long rewrites) | Forever two-server state | Approach 1 chosen specifically to mitigate this: every phase leaves the system in a stable shippable state. Stopping anywhere after Phase 1 is fine indefinitely. |
| **LLM reliability gap on Elixir (~80% vs. ~95% for TS)** | High in absolute terms | Subtle OTP design mistakes slip into PRs | Teaching-grade code standard (above) is the primary mitigation — explicit `@moduledoc`s stating *why* a primitive was chosen force the decision to be legible in review. Secondary: `requesting-code-review` at each phase boundary with a prompt anchored on OTP idiomaticity. |
| **Dev/production divergence** (devcontainer uses asdf; prod uses `mix release`) | Medium | "Works in dev, breaks in prod" class of bugs | Phase 1's deploy step builds a `mix release` and boots it in a Docker container mimicking systemd. CI builds releases on every merge. |
| **Rate-limit double-polling during Phase 1 deploy window** | Low | Anthropic rate-limits the token; temporary UI usage gap | `FBI_OAUTH_POLLER_DISABLED=1` env var. Deploy order: (1) stop TS, (2) deploy both services with env var set, (3) start TS (poller disabled), (4) start Elixir (poller enabled). |

### Non-risks considered

- **Schema drift between TS and Elixir** — ruled out: TS is single schema owner until Phase 7.
- **Frontend contract breakage** — ruled out: byte-compatibility requirement + fidelity test harness.
- **Docker socket access** — both services run as user `fbi` in the `docker` group.
- **Secrets key rotation** — no rotation mechanism today, not adding one; both servers read the same file.

## What this spec produces

Approval of this design triggers invocation of the `superpowers:writing-plans` skill against **Phase 1 only**. Each subsequent phase gets its own plan written when that phase begins — the plans inherit decisions from this spec but specify their own file-level design, step ordering, and acceptance criteria.

## Decision trail

For traceability, the load-bearing decisions were made in this order during design:

1. **Crossover mechanism:** Elixir owns `:3000` and proxies unported routes to TS on `:3001` (vs. reverse-proxy, in-process routing without TS loopback, big-bang cutover).
2. **Feature freeze policy:** Soft freeze on orchestrator/watcher surface only; leaf routes keep shipping on TS.
3. **First port slice:** Usage module including WebSocket — the self-contained module that exercises HTTP + WS + scheduled tasks + DB all at once, front-loading the WS proxy risk.
4. **Phase ordering:** Bottom-up by dependency (Approach 1), orchestrator last.
5. **Code quality standard:** Teaching-grade documentation, strictly above typical Elixir practice, because the reader is learning the language through the code.
6. **`fbi-tunnel` stays in Go** — CLI-distribution constraints specific to end-user binaries make Go the correct tool, not inertia.
7. **No LiveView** — FBI's xterm-heavy UX is a poor fit; React stays.
