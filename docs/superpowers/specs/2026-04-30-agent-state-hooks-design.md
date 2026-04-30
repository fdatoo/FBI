# Agent State Hooks — Design Spec

**Date:** 2026-04-30
**Branch:** agent-container-hardening

## Problem

The FBI run state machine has a `waiting` DB state and a `mark_state` function, but nothing ever sets a run to `waiting` while the container is alive. The UI shows "running" from container start until container exit, with no signal for when Claude is between turns and waiting for user input. This makes resume-mode runs appear "running" even when Claude is idle.

## Goal

Drive the `running` ↔ `waiting` DB transitions from within the container using Claude Code hooks, with a server-side poller that reads file signals and updates state.

## Architecture Overview

```
Container (Claude Code)                  Host (FBI server)
─────────────────────────────────────    ────────────────────────────────
Stop hook (async)                   →    /fbi-state/agent-status = "waiting"
UserPromptSubmit hook (sync)        →    /fbi-state/agent-status = "running"
                                         ↑
                                    status_watcher polls every 500ms
                                         ↓
                                    AgentStatusChanged(status) → actor
                                         ↓
                                    mark_state + broadcast StateChanged
```

## Container Side

### File written by supervisor.sh

After `git clone` and before running `claude`, supervisor.sh creates `/workspace/.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "echo waiting > /fbi-state/agent-status 2>/dev/null || true",
        "async": true
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "echo running > /fbi-state/agent-status 2>/dev/null || true"
      }]
    }]
  }
}
```

**Why `settings.local.json`:** gitignored by default, never conflicts with a project's committed `.claude/settings.json`, loaded at the "local" settings level. The hooks are FBI infrastructure, not user preferences.

**Why async Stop:** avoids adding latency to each Claude turn. Writing a single word to a tmpfs file is fast enough that sync would also be fine, but async is a better default.

**Why sync UserPromptSubmit:** the DB should reflect "running" before Claude starts processing the message. Async would risk a gap where the UI shows "waiting" after the user has sent input.

**Error safety:** `2>/dev/null || true` ensures the hook can never crash Claude if `/fbi-state/` is unmounted or missing.

## Server Side

### types.gleam

Add one new message variant to `RunMsg`:

```gleam
AgentStatusChanged(status: String)
```

### container_monitor.gleam

`start/5` currently spawns two processes: one for output streaming, one (`wait_and_notify`) for exit detection. A third process is added: the **status watcher**.

`wait_and_notify` spawns the status watcher via `spawn_unlinked` (getting its `Pid`), blocks waiting for container exit, sends an exit signal to the watcher Pid, then notifies the actor of `ContainerExited`. The exit signal terminates the watcher cleanly since unlinked processes don't trap exits by default.

```
start
├── connect_and_attach  (output streaming, unchanged)
└── wait_and_notify
    ├── spawns status_watcher → records watcher_pid
    ├── blocks on docker.wait_container
    ├── process.send_exit(watcher_pid, Normal)
    └── sends ContainerExited to actor
```

**Status watcher loop:**

```
loop(prev_status, state_dir, actor):
  current = simplifile.read(state_dir <> "/agent-status")
    |> result.map(string.trim)
    |> result.unwrap("")
  if current != prev_status && current != "":
    send AgentStatusChanged(current) to actor
  sleep 500ms
  loop(current, ...)
```

Missing file (`Error(_)`) is treated as empty string = no change. Only sends a message when value changes, so the actor is not spammed. The loop runs until terminated by `process.send_exit` from `wait_and_notify`.

### actor.gleam

Handle `AgentStatusChanged` in the `Running` phase only (ignored in all other phases):

```gleam
Running(_, _, bc, _, _), AgentStatusChanged(status) -> {
  let _ = runs_db.mark_state(db, run_id, status, now_ms())
  process.send(bc, BroadcastEvent(StateChanged(status)))
  actor.continue(state)
}
```

`mark_state` result discarded — same pattern as `mark_running`. Broadcast fires regardless so UI stays correct even if DB write lags.

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Fresh run (piped stdin) | `Stop` fires once → "waiting", then `ContainerExited` → `mark_finished` overwrites to "succeeded"/"failed". Harmless race. |
| Resume run (interactive) | Stop → "waiting", UserPromptSubmit → "running", repeat. Normal exit path unchanged. |
| Watcher outliving container | Prevented: `wait_and_notify` sends exit signal to watcher Pid before returning, guaranteeing termination order. |
| `/fbi-state/` missing | Hook: `2>/dev/null \|\| true`. Watcher: `simplifile.read` returns `Error` → treated as no change. |
| DB write fails | Result discarded; broadcast still fires. UI correct, DB may lag. |
| Server reboot (reattach) | `reattach.gleam` already handles `"waiting"` in `reattach_active`. No changes needed. |

## Files Changed

| File | Change |
|---|---|
| `priv/static/supervisor.sh` | Write `/workspace/.claude/settings.local.json` before running claude |
| `src/fbi/run/types.gleam` | Add `AgentStatusChanged(status: String)` to `RunMsg` |
| `src/fbi/run/container_monitor.gleam` | Add status watcher process, refactor `wait_and_notify` |
| `src/fbi/run/actor.gleam` | Handle `AgentStatusChanged` in `Running` phase |
