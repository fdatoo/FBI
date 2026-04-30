# Shim Output Styling

**Date:** 2026-04-24

## Goal

Replace plain `[fbi] ...` echo lines in `supervisor.sh` with ANSI-styled terminal output that makes each message type immediately recognizable by color and symbol.

## Visual Design

| Line type | Symbol | Color | Example |
|-----------|--------|-------|---------|
| Lifecycle / status | `○` | white (`\033[97m`) | `○ adding marketplace https://...` |
| Shell command | `$` | green prompt (`\033[32m`) + cyan cmd (`\033[36m`) + purple path (`\033[35m`) | `$ git clone git@github.com:fynn-labs/FBI.git .` |
| Command passthrough output | (none, indented) | dim (`\033[2m`) | `  Cloning into '.'...` |
| Warning | `⚠` | amber (`\033[33m`) | `⚠ plugin install failed: bad-pkg` |
| Fatal error | `✕` | red (`\033[31m`) | `✕ fatal: could not register safeguard remote` |

Thin blank lines separate logical phases (plugin setup → git clone → branch setup → agent launch).

## Implementation

All changes are in `src/server/orchestrator/supervisor.sh`. No frontend or backend changes are needed — xterm.js already renders ANSI codes natively.

### Helper functions (top of script)

```bash
_fbi_status()  { printf '\033[97m○\033[0m  %s\n' "$*"; }
_fbi_cmd()     { printf '\033[32m$\033[0m  \033[36m%s\033[0m\n' "$*"; }
_fbi_warn()    { printf '\033[33m⚠\033[0m  \033[33m%s\033[0m\n' "$*"; }
_fbi_fatal()   { printf '\033[31m✕\033[0m  \033[31m%s\033[0m\n' "$*"; }
```

### Replacement map

| Current | Replacement |
|---------|-------------|
| `echo "[fbi] adding marketplace: $mkt"` | `_fbi_status "adding marketplace $mkt"` |
| `echo "[fbi] warn: marketplace add failed: $mkt"` | `_fbi_warn "marketplace add failed: $mkt"` |
| `echo "[fbi] installing plugin: $plug"` | `_fbi_status "installing plugin $plug"` |
| `echo "[fbi] warn: plugin install failed: $plug"` | `_fbi_warn "plugin install failed: $plug"` |
| `echo "clone failed"` | `_fbi_fatal "clone failed"` |
| `echo "[fbi] fatal: could not register safeguard remote"` | `_fbi_fatal "could not register safeguard remote"` |
| `echo "[fbi] fatal: could not restore from safeguard/..."` | `_fbi_fatal "could not restore from safeguard/$PRIMARY_BRANCH"` |
| `echo "[fbi] fatal: could not switch to $PRIMARY_BRANCH"` | `_fbi_fatal "could not switch to $PRIMARY_BRANCH"` |
| `echo "[fbi] fatal: could not create branch $PRIMARY_BRANCH"` | `_fbi_fatal "could not create branch $PRIMARY_BRANCH"` |
| `echo "[fbi] warn: initial push of $PRIMARY_BRANCH to origin failed"` | `_fbi_warn "initial push of $PRIMARY_BRANCH to origin failed"` |
| `echo "[fbi] resuming claude session $FBI_RESUME_SESSION_ID"` | `_fbi_status "resuming session $FBI_RESUME_SESSION_ID"` |
| `echo "prompt.txt not found in /fbi"` | `_fbi_fatal "prompt.txt not found in /fbi"` |

Shell commands that run as part of setup (git clone, git checkout, etc.) emit a `_fbi_cmd` line immediately before they execute, so the user sees what's happening.

## Scope

- `src/server/orchestrator/supervisor.sh` — only file changed
- No changes to the frontend, backend, or any other scripts
- `fbi-finalize-branch.sh` is out of scope for this change

## Testing

Trigger a new run and observe the terminal output. Verify:
1. Status lines show `○` in white
2. Shell command lines show `$` in green + cyan command
3. Warnings show `⚠` in amber
4. Fatal errors show `✕` in red
5. No regression in functional behavior (clone, branch setup, agent launch still work)
