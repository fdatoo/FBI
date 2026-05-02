FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# System deps: Chromium (Playwright), Erlang build toolchain, SQLite CLI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      build-essential autoconf m4 libncurses-dev libssl-dev libssh-dev \
      sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# Pinned versions — bump these in one place when upgrading.
ARG ASDF_VERSION=v0.14.1
ARG ERLANG_VERSION=27.2
ARG GLEAM_VERSION=1.16.0

# asdf + Erlang + Gleam installed under /opt so any runtime user can use them.
# Both ASDF_DIR (asdf code) and ASDF_DATA_DIR (plugins/installs/shims) point at
# the same root so shim resolution is independent of $HOME.
#
# kerl flags skip wx/observer/jinterface (X11/GUI parts unusable headlessly)
# and skip docs — both shorten the Erlang compile and shrink the image.
ENV ASDF_DIR=/opt/asdf
ENV ASDF_DATA_DIR=/opt/asdf
ENV PATH="/opt/asdf/shims:/opt/asdf/bin:${PATH}"
ENV KERL_BUILD_DOCS=no
ENV KERL_INSTALL_MANPAGES=no
ENV KERL_INSTALL_HTMLDOCS=no
ENV KERL_CONFIGURE_OPTIONS="--disable-debug --without-javac --without-wx --without-observer --without-debugger --without-et --without-jinterface"

# Standalone rebar3 — placed before version-pinned installs so its layer stays
# cached when ERLANG/GLEAM/ZIG ARGs change.
RUN curl -fsSL https://s3.amazonaws.com/rebar3/rebar3 -o /usr/local/bin/rebar3 \
 && chmod +x /usr/local/bin/rebar3

# asdf itself + all plugin registrations in one layer.
RUN git clone --depth 1 --branch ${ASDF_VERSION} https://github.com/asdf-vm/asdf.git $ASDF_DIR \
 && $ASDF_DIR/bin/asdf plugin add erlang \
 && $ASDF_DIR/bin/asdf plugin add gleam

# Erlang/OTP — the slow step (~5-10 min first build, compiled from source).
# Isolated in its own layer so bumping Gleam/Zig versions doesn't force a recompile.
RUN $ASDF_DIR/bin/asdf install erlang ${ERLANG_VERSION} \
 && $ASDF_DIR/bin/asdf global  erlang ${ERLANG_VERSION} \
 && rm -rf $ASDF_DIR/plugins/erlang/kerl-home/builds /root/.cache

# Gleam — compiles to Erlang bytecode.
RUN $ASDF_DIR/bin/asdf install gleam ${GLEAM_VERSION} \
 && $ASDF_DIR/bin/asdf global  gleam ${GLEAM_VERSION}

# World-readable perms on shared dirs. Purge root-owned /tmp cruft.
RUN chmod -R a+rX /opt/asdf \
 && rm -rf /tmp/* /var/tmp/* /root/.cache

# Default version resolution. `asdf global` writes to $HOME/.tool-versions,
# which is user-specific; these env vars give asdf a default independent of
# $HOME so commands resolve for any runtime user.
ENV ASDF_ERLANG_VERSION=${ERLANG_VERSION}
ENV ASDF_GLEAM_VERSION=${GLEAM_VERSION}

# UTF-8 locale.
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Claude Code CLI for local development.
# Managed-settings file applies container-wide: this is a disposable devcontainer,
# so prompts add no safety. IS_SANDBOX=1 (set in devcontainer.json containerEnv)
# tells Claude Code the env is sandboxed; bypassPermissions skips prompts.
RUN npm install -g @anthropic-ai/claude-code \
 && mkdir -p /etc/claude-code \
 && printf '{\n  "permissions": { "defaultMode": "bypassPermissions" },\n  "theme": "dark"\n}\n' \
      > /etc/claude-code/managed-settings.json
