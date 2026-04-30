#!/usr/bin/env bash
set -euo pipefail

for cmd in git node npm gleam make cargo; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found"; exit 1; }
done

RELEASE_DIR="${RELEASE_DIR:-/opt/fbi}"
SERVICE="${SERVICE:-fbi}"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

git -C "$SOURCE_DIR" pull
REV="$(git -C "$SOURCE_DIR" rev-parse --short HEAD)"

echo "==> Building web bundle"
npm --prefix "$SOURCE_DIR" ci
VITE_VERSION="$REV" npm --prefix "$SOURCE_DIR" run build:web

echo "==> Building Gleam release"
(cd "$SOURCE_DIR/src/server" && gleam deps download && make build && gleam export erlang-shipment)

echo "==> Deploying"
sudo systemctl stop "$SERVICE" 2>/dev/null || true
rsync -rlp --delete "$SOURCE_DIR/src/server/build/erlang-shipment/" "$RELEASE_DIR/" --exclude=/web
sudo rsync -rlp --delete "$SOURCE_DIR/dist/web/" "$RELEASE_DIR/web/"
sudo systemctl start "$SERVICE"

sleep 2
sudo journalctl -u "$SERVICE" -n 10 --no-pager --no-hostname
echo "FBI updated to $REV."
