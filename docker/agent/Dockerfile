# Standalone agent image build, used by `make build-image` for dev/diagnosis
# and CI image scanning. Self-contained: runs both postbuild-tools.sh and
# postbuild.sh in sequence to produce a single image with everything baked
# in. At runtime, image_builder.gleam splits these across an fbi/tools
# image and a per-project image consumed via COPY --from. Keep the inputs
# (postbuild scripts, pinned versions) in sync between this file and
# image_builder.gleam.
FROM node:20-slim AS node

FROM ubuntu:24.04
ARG CLAUDE_CODE_VERSION=2.1.123
ARG GH_VERSION=2.92.0
ENV CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION GH_VERSION=$GH_VERSION

# Stage node + npm from node:20-slim.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Run the tools-install script, then symlink the binaries onto PATH.
COPY postbuild-tools.sh /tmp/postbuild-tools.sh
RUN bash /tmp/postbuild-tools.sh && rm /tmp/postbuild-tools.sh \
 && ln -sf /opt/fbi-tools/bin/claude /usr/local/bin/claude \
 && ln -sf /opt/fbi-tools/bin/gh /usr/local/bin/gh

# Run the per-project postbuild (OS deps, agent user, ssh known_hosts).
COPY postbuild.sh /tmp/postbuild.sh
RUN bash /tmp/postbuild.sh && rm /tmp/postbuild.sh

USER agent
WORKDIR /workspace
HEALTHCHECK --interval=10s --timeout=2s --start-period=120s --retries=3 \
  CMD test -f /fbi-state/ready || exit 1
