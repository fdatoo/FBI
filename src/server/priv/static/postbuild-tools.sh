#!/usr/bin/env bash
# Build-time provisioner for the shared fbi/tools image. Installs gh
# and @anthropic-ai/claude-code at pinned versions into /opt/fbi-tools
# so the per-project final-layer image can COPY them in without
# polluting /usr/local with project-agnostic tooling.
#
# Required env (passed as Docker build args):
#   GH_VERSION              e.g. 2.92.0
#   CLAUDE_CODE_VERSION     e.g. 2.1.123
#
# Layout produced:
#   /opt/fbi-tools/bin/{claude,gh}
#   /opt/fbi-tools/lib/node_modules/@anthropic-ai/claude-code/...
#
# This script assumes a node:<major>-slim base image so npm + curl are
# already available.

set -euo pipefail

: "${GH_VERSION:?GH_VERSION required}"
: "${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION required}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl

mkdir -p /opt/fbi-tools/bin

# gh CLI: extract the binary from the official .deb so we don't leave
# the github-cli apt repo plumbing in the final image.
arch="$(dpkg --print-architecture)"
mkdir -p /tmp/gh
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.deb" \
  -o /tmp/gh/gh.deb
dpkg -x /tmp/gh/gh.deb /tmp/gh/extract
cp /tmp/gh/extract/usr/bin/gh /opt/fbi-tools/bin/gh
chmod 0755 /opt/fbi-tools/bin/gh
rm -rf /tmp/gh

# claude-code: npm-install into a private prefix so the binary lands at
# /opt/fbi-tools/bin/claude. Recent releases bundle a "native build"
# installer that drops the actual binary in $HOME/.local/bin instead;
# normalize that case too.
npm install -g --prefix=/opt/fbi-tools "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

if [ ! -x /opt/fbi-tools/bin/claude ] && [ -x /root/.local/bin/claude ]; then
  cp /root/.local/bin/claude /opt/fbi-tools/bin/claude
  chmod 0755 /opt/fbi-tools/bin/claude
fi

rm -rf /var/lib/apt/lists/*
