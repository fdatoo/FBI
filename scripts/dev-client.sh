#!/usr/bin/env bash
set -euo pipefail

for cmd in node npm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found"; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d node_modules ]; then
  echo "▸ npm install"
  npm install
fi

exec npm run dev:web
