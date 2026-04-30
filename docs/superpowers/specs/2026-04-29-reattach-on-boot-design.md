# Reattach on Boot + Transcript + Auto-Resume — Design

**Date:** 2026-04-29
**Status:** approved
**Branch:** fdatoo/gleam

## Problem

When the FBI server process restarts, in-memory state is lost: the run registry, the broadcasters, and the open Docker attach sockets are all gone. Docker containers continue running independently — but the Gleam server has no way to find them again. The frontend opens a WebSocket to `/api/runs/:id/shell`, gets a 404 because the registry is empty, and falls into a reconnect loop. Users can no longer view or interact with runs that were active before the restart.

A second, related problem: there is no transcript file on disk. Container output is streamed in-memory through the broadcaster only. When a new client connects (or reattaches), there's no way to replay history.

A third, related problem: when an agent hits a usage limit it transitions the run to `awaiting_resume` and writes `next_resume_at` to the DB. There is currently no scheduler that wakes those runs back up.

## Goals

1. Persist `container_id` to the database when a run enters the `running` state.
2. Write live container output to a per-run transcript file on disk.
3. Serve the transcript over HTTP with `Range` support so the frontend can replay history.
4. On startup, find every non-terminal run in the DB and reconnect to or clean up its container appropriately.
5. Run a scheduler that resurrects `awaiting_resume` runs when their `next_resume_at` time arrives — and reuse the same path on boot for runs whose time has already passed.

## Non-goals (this work)

These features exist in the original Elixir server and the frontend expects them, but they are deliberately deferred to a follow-up. They are documented in **Out of scope, to restore later** below so we can systematically work through them.

## Architecture

### container_id persistence

`runs.mark_state` currently only writes `state` and `state_entered_at`. We will replace its single call site (in `actor.transition_to_running`) with a new `runs.mark_running(db, run_id, container_id, now)` that writes all three fields atomically: `state='running'`, `container_id=?`, `state_entered_at=?`. This guarantees that any row whose state is `running` has a valid `container_id`.

### Transcript file

The transcript lives at `{runs_dir}/{run_id}/transcript.log`. The directory is created in `worker.setup_run_dir` (which already runs before container start). Inside `container_monitor.connect_and_attach`, the existing reader process gains a small per-call writer: every chunk from the Docker attach stream is appended to the transcript file using a single open file handle (Erlang `:file.open/2` with `[append, raw, binary]`).

The transcript writer is intentionally simple: append-only, no rotation, no fsync per chunk. Truncation to the last N MB is handled at read time, not write time, by serving only a suffix range.

### `/api/runs/:id/transcript` endpoint

A new handler `handlers/transcript.gleam` reads `{runs_dir}/{run_id}/transcript.log` and serves it. Supports:
- No `Range` header → returns the full file.
- `Range: bytes=START-END` → returns that slice with `206 Partial Content` and a `Content-Range` header.
- `Range: bytes=-N` (suffix range, last N bytes) → returns the suffix with 206.

Missing file → `404`. Range outside file size → `416 Range Not Satisfiable`.

### Snapshot with `byte_offset`

`types.Snapshot` gains a `byte_offset: Int` field. `shell_ws.gleam` includes it in the snapshot JSON. When a new subscriber sends `Subscribe`, the run actor reads the current size of the run's transcript file (via `simplifile.file_info`) and broadcasts a `Snapshot{ansi: "", cols, rows, byte_offset}` to that subscriber. The empty `ansi` is intentional: rather than building an in-memory terminal model (the `fbi_term` NIF), we let the client fetch the last 5 MB of the transcript via `Range` and replay it through xterm. This is what `loadBoundedHistory` already does — we just need to give it the right `byte_offset` to anchor the range.

### Boot reattach

A new module `run/reattach.gleam` runs in `fbi.gleam` after `migrations.run` and after the registry/pubsub actors are started, before the HTTP listener accepts connections. It queries every row whose state is in `('queued', 'running', 'waiting', 'awaiting_resume')` and routes each:

- **`queued`**: the worker hadn't started; no container exists. Delete the row.
- **`running` or `waiting`** (the actor's `Waiting` phase corresponds to a transient DB state — but `mark_finished` collapses it to `succeeded`/`failed` immediately, so in practice we only see `running`):
  - If `container_id` is `None`: data inconsistency — `mark_failed("no container id on boot")`.
  - Else inspect the container via Docker:
    - **Running**: spin up a fresh broadcaster + actor in the `Running` phase (skipping the worker), call `container_monitor.start` which performs the bidirectional attach (stdin + output), and register the actor in the run registry. The new attach picks up output starting from "now"; historical bytes are already in the transcript file, served via the transcript endpoint.
    - **Exited**: read `result.json` from the run's state dir if present, call `mark_finished` with the parsed outcome. If `result.json` is missing, `mark_failed("container exited without result")`.
    - **Missing**: `mark_failed("container disappeared")`.
- **`awaiting_resume`**:
  - If `next_resume_at <= now`: resurrect immediately by inserting a continue-child run (carrying the saved `claude_session_id`) and starting the supervisor. Mark the parent run as `succeeded` so the chain is correctly terminated.
  - Else: leave it in place — the auto-resume scheduler will handle it.

### Auto-resume scheduler

A new actor `run/resume_scheduler.gleam`, mirroring `gc_scheduler.gleam`. Every minute it queries `runs WHERE state='awaiting_resume' AND next_resume_at <= now` and runs the same resurrect path used by boot reattach.

## Verification

- Unit tests cover: `mark_running`, transcript Range serving, dechunk parsing, snapshot byte_offset, reattach decision tree (with mocked Docker results).
- Manual via dev-server + dev-client + Playwright: create a run, kill the server, restart, verify the WebSocket reconnects to the still-running container and that history loads from the transcript endpoint.

## Out of scope, to restore later

These are missing/broken in the Gleam port relative to the original Elixir server and what the frontend expects. None affect the reattach work.

**Update (2026-04-29):** All endpoints below now exist in some form — most as graceful stubs that return empty results so the frontend doesn't 404. The list below tracks which need *real* implementations.

### Real implementations still needed

**Token-counting pipeline (real)**
- The `tokens_*` columns on `runs` are wired through to `/api/usage/daily` and `/api/usage/runs/:id`, but nothing populates them. Need to parse Claude's emitted usage events from the container output stream (or session JSONL) and increment columns.
- `WS /api/ws/usage` is wired but publishes nothing — needs to emit on token events.
- Real `UsageState` (plan, buckets, pacing) needs the credentials/quota lookup that drives the existing `last_error: "missing_credentials"` placeholder.

**Git introspection (real)**
- `GET /api/runs/:id/changes` returns empty {commits, uncommitted}. Real impl: shell out to `git log` + `git status` against `{runs_dir}/{run_id}/wip`.
- `GET /api/runs/:id/file-diff?path=&ref=` returns empty hunks. Real impl: `git diff` parsing.
- `GET /api/runs/:id/commits/:sha/files` and the submodule variant return empty file lists. Real impl: `git show --name-status`.
- `POST /api/runs/:id/history` returns `kind: git-unavailable`. Real impl: dispatch each `HistoryOp` (`merge`, `sync`, `squash-local`, `polish`, `push-submodule`, `mirror-rebase`).

**WIP management (real)**
- `GET /api/runs/:id/wip` returns `{ok: false, reason: 'no-wip'}`. Real impl: read dirty file list from the WIP repo.
- `GET /api/runs/:id/wip/file?path=` returns empty hunks. Real impl: per-file diff.
- `POST /api/runs/:id/wip/discard` returns 204 without doing anything. Real impl: `git restore`.
- `GET /api/runs/:id/wip/patch` returns empty body. Real impl: `git diff` as a `.patch` download.

**File uploads (real)**
- `POST /api/draft-uploads` and `POST /api/runs/:id/uploads` return 501. Real impl needs multipart parsing + on-disk storage under `runs_dir`.
- The DELETE counterparts return 204 stubs.

**Listening ports (real)**
- `GET /api/runs/:id/listening-ports` returns `{ports: []}`. Real impl: `docker exec ss -tnlp` (or `/proc/net/tcp`) and parsing.

**GitHub PR (real)**
- `POST /api/runs/:id/github/pr` returns 501. Real impl: shell out to `gh pr create` with the run's branch.

**Snapshot via terminal model**
This work uses an empty-ANSI snapshot anchored to a `byte_offset` and lets the client replay from the transcript. A richer snapshot using the `fbi_term` NIF to produce a current-screen ANSI render would let clients skip the bulk replay. Not blocking.

### Already done (reference)

- `GET /api/runs?state=&project_id=&q=&limit=&offset=` — full filter + pagination + search ✅
- `GET /api/runs/:id/transcript` with Range support ✅
- `POST /api/runs/:id/resume-now` — actually resurrects (no longer 501) ✅
- `GET /api/projects/:id/prompts/recent` — real impl ✅
- `GET /api/config/defaults` — real impl ✅
- `GET /api/quantico/scenarios` — real impl ✅
- `GET /api/usage`, `/api/usage/daily`, `/api/usage/runs/:id` — endpoints serve from existing token columns; collection still TODO
