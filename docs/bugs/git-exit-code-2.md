# "Git: exit code 2" on Sync/Merge Operations

## Symptom

Clicking "Sync with main" (or other git operations) on a finished/done run shows the error banner: **"Git: exit code 2"**.

Observed on run #9 (`fix/ci-failure` branch).

## Root Cause

The Elixir `run_in_transient_container` (used for runs not in `starting|running|waiting` state) has three bugs versus the TypeScript reference implementation:

### Bug 1: No clone step — `/workspace` doesn't exist

**File:** `src/server/lib/fbi/orchestrator/history_op.ex`, `run_in_transient_container/1` (~line 106)

The Elixir container spec runs the script directly:
```elixir
"Cmd" => ["/usr/local/bin/fbi-history-op.sh"],
```

The `alpine/git:latest` image has no `/workspace` directory. The very first real command in `fbi-history-op.sh` is:
```sh
cd /workspace || { printf '%s\n' '{"ok":false,...}'; exit 2; }
```

Since `/workspace` doesn't exist → `cd` fails → script exits with code 2.

The TypeScript equivalent (`runHistoryOpInTransientContainer`) correctly prepends a clone step:
```typescript
const cmd = ['/bin/sh', '-c', [
  'set -e',
  'cd /workspace',
  'git clone --quiet "$REPO_URL" . >/dev/null 2>&1',
  'git config user.name  "$GIT_AUTHOR_NAME"',
  'git config user.email "$GIT_AUTHOR_EMAIL"',
  '/usr/local/bin/fbi-history-op.sh',
].join('; ')];
```

### Bug 2: Stdout not captured

After waiting for the container to exit, the Elixir code calls `parse_result` with an empty string:
```elixir
{:ok, status_code} = FBI.Docker.wait_container(container_id)
parse_result("", status_code)    # ← stdout never read
```

`parse_result("", 2)` finds no JSON lines → returns `{:gh_error, "exit code 2"}`.

Even if the script somehow ran and printed a useful error like `{"ok":false,"reason":"gh-error","message":"fetch failed: ..."}`, that output is discarded. The TS implementation reads stdout from the container logs stream.

### Bug 3: Wrong safeguard mount path

The Elixir container binds the safeguard at `/wip.git`, but the shell script looks for it at `/safeguard`:
```elixir
"Binds" => [
  "#{script_path}:/usr/local/bin/fbi-history-op.sh:ro",
  "#{wip_path}:/wip.git:rw"          # ← wrong: script checks /safeguard
]
```

The script's safeguard logic:
```sh
if [ -d /safeguard ]; then
    git remote add safeguard /safeguard
    ...
fi
```

With `/safeguard` absent, the safeguard branch (Claude's committed work) is never fetched into the transient clone. For cases where `origin` doesn't yet have the branch (e.g., a run that never pushed), the merge/sync will fail on `checkout --detach origin/$FBI_BRANCH`.

The TS version mounts it at the path the script expects: `/safeguard`.

## Flow

1. User clicks "Sync with main" on a finished run
2. Elixir `history_controller.ex` calls `exec_history_op`
3. `run.state` is "done" (not in `active_states`) → `run_in_transient_container` is used
4. `alpine/git:latest` container starts, runs script directly
5. Script: `cd /workspace` fails → exits with code 2
6. `FBI.Docker.wait_container` returns `status_code = 2`
7. `parse_result("", 2)` → `{:gh_error, "exit code 2"}`
8. UI receives `{kind: "git-error", message: "exit code 2"}` → shows "Git: exit code 2"

## Fix (not yet implemented)

In `run_in_transient_container/1`:

1. **Change `Cmd` to include clone + config preamble** (matching the TS implementation):
   ```elixir
   "Cmd" => [
     "/bin/sh", "-c",
     Enum.join([
       "set -e",
       "cd /workspace",
       "git clone --quiet \"$REPO_URL\" . >/dev/null 2>&1",
       "git config user.name \"$GIT_AUTHOR_NAME\"",
       "git config user.email \"$GIT_AUTHOR_EMAIL\"",
       "/usr/local/bin/fbi-history-op.sh"
     ], "; ")
   ],
   ```
   Also add `"WorkingDir" => "/workspace"` to the container spec (or `mkdir -p /workspace` before the clone).

2. **Capture stdout** from the container (use `FBI.Docker.container_logs` or similar after `wait_container`, or stream them like the transient TS path does via `container.logs`).

3. **Fix the safeguard bind path** from `/wip.git` to `/safeguard`:
   ```elixir
   "#{wip_path}:/safeguard:rw"
   ```
