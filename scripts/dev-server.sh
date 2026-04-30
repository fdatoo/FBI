#!/usr/bin/env bash
set -euo pipefail

for cmd in gleam make; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found"; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

: "${SECRETS_KEY_FILE:=/tmp/fbi.key}"
if [ ! -f "$SECRETS_KEY_FILE" ]; then
  echo "▸ generating secrets key at $SECRETS_KEY_FILE"
  head -c 32 /dev/urandom > "$SECRETS_KEY_FILE"
  chmod 600 "$SECRETS_KEY_FILE"
fi

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Dev}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-dev@example.com}"
export DATABASE_PATH="${DATABASE_PATH:-/tmp/fbi.db}"
export RUNS_DIR="${RUNS_DIR:-/tmp/fbi-runs}"
export SECRETS_KEY_FILE

# ── SSH agent forwarding into containers ─────────────────────────────────────
# Two cases the worker bind-mount has to handle:
#   1. Native Docker (Linux server, Colima, Rancher Desktop, etc.) — the host
#      $SSH_AUTH_SOCK is reachable from Docker, so we pass it through.
#   2. Docker Desktop — the host socket lives in a path the Linux VM can't
#      see; Docker Desktop forwards the host agent at
#      /run/host-services/ssh-auth.sock instead.
# Detect by asking docker itself, falling back to host SSH_AUTH_SOCK. If the
# user has set HOST_SSH_AUTH_SOCK explicitly to something that exists on disk,
# leave it alone — but ignore stale/templated values (e.g. paths containing
# "XXXXXX" placeholders, or paths that no longer exist).
_fbi_docker_desktop=""
if command -v docker >/dev/null 2>&1 \
   && docker info --format '{{.OperatingSystem}}' 2>/dev/null \
   | grep -qi "docker desktop"; then
  _fbi_docker_desktop=1
fi

# Compute the right value for our environment.
if [ -n "$_fbi_docker_desktop" ]; then
  _fbi_default_host_sock="/run/host-services/ssh-auth.sock"
else
  _fbi_default_host_sock="${SSH_AUTH_SOCK:-}"
fi

# Decide whether to keep an existing HOST_SSH_AUTH_SOCK or override.
# Override if it's empty, contains an "XXXXXX" placeholder, or points to a
# missing host path. The Docker Desktop magic path doesn't exist on the host
# filesystem, so accept that one without an existence check.
_fbi_keep_existing=0
if [ -n "${HOST_SSH_AUTH_SOCK:-}" ]; then
  case "$HOST_SSH_AUTH_SOCK" in
    *XXXXXX*) ;;
    /run/host-services/ssh-auth.sock) _fbi_keep_existing=1 ;;
    *) [ -e "$HOST_SSH_AUTH_SOCK" ] && _fbi_keep_existing=1 ;;
  esac
fi

if [ "$_fbi_keep_existing" != "1" ] && [ -n "$_fbi_default_host_sock" ]; then
  export HOST_SSH_AUTH_SOCK="$_fbi_default_host_sock"
fi
unset _fbi_docker_desktop _fbi_default_host_sock _fbi_keep_existing

if [ -n "${HOST_SSH_AUTH_SOCK:-}" ]; then
  # Warn (don't fail) if the agent has no keys — git clone will fall over
  # inside the container otherwise. Run `ssh-add` first to load yours.
  if ! ssh-add -l >/dev/null 2>&1; then
    echo "▸ warning: ssh-agent has no identities loaded"
    echo "  containers will fail to clone over SSH"
    echo "  fix: ssh-add ~/.ssh/id_ed25519   (or your usual key)"
  fi
fi

cd "$REPO_ROOT/src/server"
make nif
exec gleam run
