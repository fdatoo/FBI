#!/usr/bin/env bash
# FBI per-project post-build layer. Executed by image_builder.gleam's
# build_post_layer inside the per-project final image.
#
# Project-agnostic tooling (claude, gh, node) is COPY'd into the image
# from the shared fbi/tools image — see postbuild-tools.sh and
# image_builder.gleam. This script handles only project-side concerns:
#
#   1. Install required apt packages (git, openssh-client, sudo, ...).
#   2. Create the non-root "agent" user with HOME=/home/agent.
#   3. Drop GitHub host keys into /home/agent/.ssh/known_hosts.
#   4. Create /workspace, /fbi, and /home/agent/.claude.
#
# The script assumes apt-based systems (debian/ubuntu). For other bases,
# the orchestrator will log a warning and skip (see image_builder.gleam).

set -euo pipefail

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  # Remove any third-party apt sources from the base image (stale keys, etc.).
  # Preserve ubuntu.sources (Noble+ deb822 format) — deleting it leaves apt
  # with no repos at all, since /etc/apt/sources.list is empty on Ubuntu 24.04+.
  find /etc/apt/sources.list.d -mindepth 1 ! -name 'ubuntu.sources' -delete 2>/dev/null || true
  apt-get update
  apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl gnupg sudo
  rm -rf /var/lib/apt/lists/*
fi

# Create agent user.
if ! id agent >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash agent
fi

# Passwordless sudo for the agent user — lets claude run privileged
# commands inside the container without an interactive prompt.
echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent
chmod 0440 /etc/sudoers.d/agent

# Seed known_hosts with GitHub's published keys.
mkdir -p /home/agent/.ssh
cat > /home/agent/.ssh/known_hosts <<'HOSTS'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
HOSTS
chown -R agent:agent /home/agent/.ssh
chmod 700 /home/agent/.ssh
chmod 600 /home/agent/.ssh/known_hosts

# Create workspace directory owned by agent so git clone works.
mkdir -p /workspace
chown agent:agent /workspace

# Create prompt injection directory (filled via putArchive before container start).
mkdir -p /fbi
chown agent:agent /fbi

# Pre-create ~/.claude so it's owned by agent. Docker will bind-mount
# .credentials.json into it at runtime; plugin install needs the rest
# of the directory to be writable by agent.
mkdir -p /home/agent/.claude
chown agent:agent /home/agent/.claude
