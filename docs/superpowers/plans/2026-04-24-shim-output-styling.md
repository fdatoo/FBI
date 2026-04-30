# Shim Output Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plain `[fbi] ...` echo lines in `supervisor.sh` with ANSI-styled terminal output using colored symbols (`○`, `$`, `⚠`, `✕`) so each message type is immediately recognizable.

**Architecture:** Add four helper functions (`_fbi_status`, `_fbi_cmd`, `_fbi_warn`, `_fbi_fatal`) near the top of `supervisor.sh`, then replace every `echo "[fbi] ..."` call with the appropriate helper. Shell commands that run silently during setup each get a preceding `_fbi_cmd` call so users can see what's happening. No frontend or backend changes needed — xterm.js renders ANSI codes natively.

**Tech Stack:** Bash, ANSI escape codes, xterm.js (unchanged, already supports ANSI)

---

### Task 1: Add helper functions to supervisor.sh

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh` (after the `set -euo pipefail` line)

- [ ] **Step 1: Read the current top of the file**

Open `src/server/orchestrator/supervisor.sh` and confirm the `set -euo pipefail` line near the top (currently line 34).

- [ ] **Step 2: Insert helper functions after `set -euo pipefail`**

Add the following block immediately after the `set -euo pipefail` line:

```bash
# ── styled output helpers ─────────────────────────────────────────────────────
_fbi_status() { printf '\033[97m○\033[0m  %s\n'           "$*"; }
_fbi_cmd()    { printf '\033[32m$\033[0m  \033[36m%s\033[0m\n' "$*"; }
_fbi_warn()   { printf '\033[33m⚠\033[0m  \033[33m%s\033[0m\n' "$*"; }
_fbi_fatal()  { printf '\033[31m✕\033[0m  \033[31m%s\033[0m\n' "$*"; }
# ─────────────────────────────────────────────────────────────────────────────
```

- [ ] **Step 3: Verify it parses cleanly**

```bash
bash -n src/server/orchestrator/supervisor.sh
```

Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): add ANSI styled output helper functions"
```

---

### Task 2: Replace marketplace + plugin echo calls

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh` (marketplace/plugin block, ~lines 37–47)

- [ ] **Step 1: Replace the marketplace/plugin echoes**

Find and replace this block:

```bash
if [ -n "${FBI_MARKETPLACES:-}" ]; then
    while IFS= read -r mkt; do
        [ -z "$mkt" ] && continue
        echo "[fbi] adding marketplace: $mkt"
        claude plugin marketplace add "$mkt" || echo "[fbi] warn: marketplace add failed: $mkt"
    done <<< "$FBI_MARKETPLACES"
fi
if [ -n "${FBI_PLUGINS:-}" ]; then
    while IFS= read -r plug; do
        [ -z "$plug" ] && continue
        echo "[fbi] installing plugin: $plug"
        claude plugin install "$plug" || echo "[fbi] warn: plugin install failed: $plug"
    done <<< "$FBI_PLUGINS"
fi
```

With:

```bash
if [ -n "${FBI_MARKETPLACES:-}" ]; then
    while IFS= read -r mkt; do
        [ -z "$mkt" ] && continue
        _fbi_status "adding marketplace $mkt"
        claude plugin marketplace add "$mkt" || _fbi_warn "marketplace add failed: $mkt"
    done <<< "$FBI_MARKETPLACES"
fi
if [ -n "${FBI_PLUGINS:-}" ]; then
    while IFS= read -r plug; do
        [ -z "$plug" ] && continue
        _fbi_status "installing plugin $plug"
        claude plugin install "$plug" || _fbi_warn "plugin install failed: $plug"
    done <<< "$FBI_PLUGINS"
fi
```

- [ ] **Step 2: Syntax check**

```bash
bash -n src/server/orchestrator/supervisor.sh
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): style marketplace and plugin output"
```

---

### Task 3: Style the git clone command

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh` (git clone line, ~line 50)

- [ ] **Step 1: Announce clone before it runs**

Find:

```bash
git clone --recurse-submodules "$REPO_URL" . || { echo "clone failed"; exit 10; }
```

Replace with:

```bash
_fbi_cmd "git clone $REPO_URL ."
git clone --recurse-submodules "$REPO_URL" . || { _fbi_fatal "clone failed"; exit 10; }
```

- [ ] **Step 2: Syntax check**

```bash
bash -n src/server/orchestrator/supervisor.sh
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): style git clone output"
```

---

### Task 4: Style safeguard remote registration and fatal messages

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh` (safeguard remote block, ~lines 57–60)

- [ ] **Step 1: Replace safeguard remote echo**

Find:

```bash
git remote add safeguard /safeguard 2>/dev/null \
    || git remote set-url safeguard /safeguard \
    || { echo "[fbi] fatal: could not register safeguard remote"; exit 14; }
```

Replace with:

```bash
git remote add safeguard /safeguard 2>/dev/null \
    || git remote set-url safeguard /safeguard \
    || { _fbi_fatal "could not register safeguard remote"; exit 14; }
```

- [ ] **Step 2: Syntax check**

```bash
bash -n src/server/orchestrator/supervisor.sh
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): style safeguard remote fatal message"
```

---

### Task 5: Style branch checkout messages

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh` (branch checkout block, ~lines 63–90)

- [ ] **Step 1: Replace all branch-related echoes and add _fbi_cmd announcements**

Find the resume-mode checkout block:

```bash
if git fetch --quiet safeguard "$PRIMARY_BRANCH" 2>/dev/null; then
    if git rev-parse --verify --quiet "safeguard/$PRIMARY_BRANCH" >/dev/null 2>&1; then
        git checkout -B "$PRIMARY_BRANCH" "safeguard/$PRIMARY_BRANCH" \
            || { echo "[fbi] fatal: could not restore from safeguard/$PRIMARY_BRANCH"; exit 13; }
        CHECKED_OUT=1
    fi
fi
```

Replace with:

```bash
if git fetch --quiet safeguard "$PRIMARY_BRANCH" 2>/dev/null; then
    if git rev-parse --verify --quiet "safeguard/$PRIMARY_BRANCH" >/dev/null 2>&1; then
        _fbi_cmd "git checkout -B $PRIMARY_BRANCH safeguard/$PRIMARY_BRANCH"
        git checkout -B "$PRIMARY_BRANCH" "safeguard/$PRIMARY_BRANCH" \
            || { _fbi_fatal "could not restore from safeguard/$PRIMARY_BRANCH"; exit 13; }
        CHECKED_OUT=1
    fi
fi
```

Then find the fresh-mode checkout block:

```bash
if [ "$CHECKED_OUT" = "0" ]; then
    if [ "$HAS_ORIGIN" = "1" ] && git rev-parse --verify --quiet "origin/$PRIMARY_BRANCH" >/dev/null 2>&1; then
        git checkout -B "$PRIMARY_BRANCH" "origin/$PRIMARY_BRANCH" \
            || { echo "[fbi] fatal: could not switch to $PRIMARY_BRANCH"; exit 13; }
    else
        git checkout -b "$PRIMARY_BRANCH" \
            || { echo "[fbi] fatal: could not create branch $PRIMARY_BRANCH"; exit 13; }
        if [ "$HAS_ORIGIN" = "1" ]; then
            git push -u origin "$PRIMARY_BRANCH" \
                || echo "[fbi] warn: initial push of $PRIMARY_BRANCH to origin failed"
        fi
    fi
fi
```

Replace with:

```bash
if [ "$CHECKED_OUT" = "0" ]; then
    if [ "$HAS_ORIGIN" = "1" ] && git rev-parse --verify --quiet "origin/$PRIMARY_BRANCH" >/dev/null 2>&1; then
        _fbi_cmd "git checkout -B $PRIMARY_BRANCH origin/$PRIMARY_BRANCH"
        git checkout -B "$PRIMARY_BRANCH" "origin/$PRIMARY_BRANCH" \
            || { _fbi_fatal "could not switch to $PRIMARY_BRANCH"; exit 13; }
    else
        _fbi_cmd "git checkout -b $PRIMARY_BRANCH"
        git checkout -b "$PRIMARY_BRANCH" \
            || { _fbi_fatal "could not create branch $PRIMARY_BRANCH"; exit 13; }
        if [ "$HAS_ORIGIN" = "1" ]; then
            _fbi_cmd "git push -u origin $PRIMARY_BRANCH"
            git push -u origin "$PRIMARY_BRANCH" \
                || _fbi_warn "initial push of $PRIMARY_BRANCH to origin failed"
        fi
    fi
fi
```

- [ ] **Step 2: Syntax check**

```bash
bash -n src/server/orchestrator/supervisor.sh
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): style branch checkout output"
```

---

### Task 6: Style agent launch messages

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh` (agent launch block, ~lines 115–135)

- [ ] **Step 1: Replace resume echo and prompt-not-found echo**

Find:

```bash
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    echo "[fbi] resuming claude session $FBI_RESUME_SESSION_ID"
    touch /fbi-state/waiting
    claude --resume "$FBI_RESUME_SESSION_ID" --dangerously-skip-permissions
```

Replace with:

```bash
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    _fbi_status "resuming session $FBI_RESUME_SESSION_ID"
    touch /fbi-state/waiting
    claude --resume "$FBI_RESUME_SESSION_ID" --dangerously-skip-permissions
```

Then find:

```bash
[ -f /fbi/prompt.txt ] || { echo "prompt.txt not found in /fbi"; exit 12; }
```

Replace with:

```bash
[ -f /fbi/prompt.txt ] || { _fbi_fatal "prompt.txt not found in /fbi"; exit 12; }
```

- [ ] **Step 2: Syntax check**

```bash
bash -n src/server/orchestrator/supervisor.sh
```

Expected: no output.

- [ ] **Step 3: Final diff review**

```bash
git diff HEAD src/server/orchestrator/supervisor.sh
```

Confirm:
- No remaining `echo "[fbi]` lines
- No remaining bare `echo "clone failed"` or `echo "prompt.txt not found"` lines
- All `_fbi_*` calls match the helper signatures defined in Task 1

- [ ] **Step 4: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): style agent launch and error messages"
```
