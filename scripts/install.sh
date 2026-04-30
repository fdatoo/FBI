#!/usr/bin/env bash
set -euo pipefail

# Run as yourself — sudo is used only for system-level operations.
#
# Prerequisites:
#   - gleam, erl, make, cargo in PATH
#   - Docker Engine running; user 'fbi' in the 'docker' group
#   - 'claude /login' run once as the fbi user
#   - ssh-agent configured for the fbi user on boot

for cmd in rsync node npm gleam erl make cargo; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found"; exit 1; }
done
id fbi >/dev/null 2>&1 || { echo "ERROR: user 'fbi' does not exist"; exit 1; }

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR=/opt/fbi
REV="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"

# ── Runtime directories ──────────────────────────────────────────────────────
sudo install -d -m 750 -o fbi -g fbi \
  /var/lib/agent-manager \
  /var/lib/agent-manager/runs \
  /etc/agent-manager

if [ ! -f /etc/agent-manager/secrets.key ]; then
  sudo bash -c 'head -c 32 /dev/urandom > /etc/agent-manager/secrets.key'
  sudo chown fbi:fbi /etc/agent-manager/secrets.key
  sudo chmod 600 /etc/agent-manager/secrets.key
fi

# ── Build ────────────────────────────────────────────────────────────────────
echo "==> Building web bundle"
npm --prefix "$SOURCE_DIR" ci
VITE_VERSION="$REV" npm --prefix "$SOURCE_DIR" run build:web

echo "==> Building Gleam release"
(cd "$SOURCE_DIR/src/server" && gleam deps download && make build && gleam export erlang-shipment)

# ── Deploy ───────────────────────────────────────────────────────────────────
sudo systemctl stop fbi.service 2>/dev/null || true

# /opt/fbi owned by current user so future update.sh runs need no sudo
sudo install -d -m 750 -o "$(whoami)" -g fbi "$RELEASE_DIR" "$RELEASE_DIR/web"
rsync -rlp --delete "$SOURCE_DIR/src/server/build/erlang-shipment/" "$RELEASE_DIR/" --exclude=/web
rsync -rlp --delete "$SOURCE_DIR/dist/web/" "$RELEASE_DIR/web/"

# ── Environment file ─────────────────────────────────────────────────────────
if [ ! -f /etc/default/fbi ]; then
  sudo tee /etc/default/fbi > /dev/null <<'ENV'
PORT=3000
DATABASE_PATH=/var/lib/agent-manager/db.sqlite
RUNS_DIR=/var/lib/agent-manager/runs
WEB_DIST_DIR=/opt/fbi/web
SECRETS_KEY_FILE=/etc/agent-manager/secrets.key
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
# Optional:
# HOST_SSH_AUTH_SOCK=/run/user/1000/ssh-agent.sock
# HOST_CLAUDE_DIR=/home/fbi/.claude
# DOCKER_SOCKET=/var/run/docker.sock
# HOST_DOCKER_GID=995
FBI_DEFAULT_PLUGINS=superpowers@claude-plugins-official
ENV
  sudo chmod 640 /etc/default/fbi
  sudo chown root:fbi /etc/default/fbi
fi

# ── Systemd ──────────────────────────────────────────────────────────────────
sudo install -m 644 "$SOURCE_DIR/systemd/fbi.service" /etc/systemd/system/fbi.service
sudo systemctl daemon-reload
sudo systemctl enable --now fbi.service
sudo systemctl restart fbi.service

echo "FBI installed and running."
echo "  Edit /etc/default/fbi with real GIT_AUTHOR_NAME/EMAIL"
echo "  systemctl status fbi"
