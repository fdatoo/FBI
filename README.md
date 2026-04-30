<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/banner-dark.png">
  <img src="media/banner-light.png" alt="FBI" width="460" />
</picture>

A personal web tool that runs `claude --dangerously-skip-permissions` inside ephemeral Docker containers, with an interactive in-browser terminal and per-run branch push.

## Prerequisites on the server

1. Docker Engine installed and running.
2. Tailscale (or other network boundary) set up — the app has no login.
3. A unix user `fbi` in the `docker` group.
4. SSH keys loaded into the `fbi` user's ssh-agent, persisted across reboots.
5. `claude /login` performed once as `fbi`.
6. Node 20+ and npm (used to build the web bundle during install/update).
7. Erlang/OTP 27 and Gleam installed (via asdf or your distro's packages).
8. Rust (1.77+) and `cargo` installed — required to compile the terminal NIF.

### Persistent ssh-agent recipe

One-time setup for a persistent user ssh-agent for the `fbi` user:

```bash
# As root:
loginctl enable-linger fbi

# As fbi:
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ssh-agent.service <<'EOF'
[Unit]
Description=User ssh-agent
[Service]
Type=simple
Environment=SSH_AUTH_SOCK=%t/ssh-agent.sock
ExecStart=/usr/bin/ssh-agent -D -a $SSH_AUTH_SOCK
[Install]
WantedBy=default.target
EOF
systemctl --user enable --now ssh-agent
# Then add your keys:
SSH_AUTH_SOCK=$XDG_RUNTIME_DIR/ssh-agent.sock ssh-add ~/.ssh/id_ed25519
```

In `/etc/default/fbi`, set:
```
HOST_SSH_AUTH_SOCK=/run/user/$(id -u fbi)/ssh-agent.sock
```

## Install

```bash
git clone <repo> /tmp/fbi-src
cd /tmp/fbi-src
sudo bash scripts/install.sh
sudo vim /etc/default/fbi    # set GIT_AUTHOR_NAME / EMAIL
sudo systemctl restart fbi
```

The install script builds the Gleam release and starts `fbi.service` on `:3000`.

Open the service URL over Tailscale (port 3000 by default).

## Design system

The UI is built on a reusable primitive library at `src/web/ui/`. See:
- `src/web/ui/CLAUDE.md` — rules for contributors (use tokens, not hex; use primitives, not raw Tailwind).
- `/design` (dev server `http://localhost:5173/design`) — live showcase of every primitive.

## Local development

```bash
# First time: install dependencies
npm install
cd src/server && gleam deps download && cd ../..

# Start both servers (Gleam on :3000, Vite on :5173)
bash scripts/dev.sh
```

`scripts/dev.sh` builds the Rust NIF, starts the Vite dev server in the background, and runs the Gleam server in the foreground. Environment defaults (`DATABASE_PATH`, `RUNS_DIR`, `SECRETS_KEY_FILE`) are set automatically for development. The web frontend proxies `/api` to `localhost:3000`.

## Testing

```bash
make test        # all unit tests: web + server + rust
make test-web    # vitest + TypeScript typecheck
make test-server # gleam test
make test-rust   # cargo test
make test-e2e    # Playwright end-to-end (requires a running server)
```

## Architecture

- **`src/server/`** — Gleam backend (Wisp/Mist). Handles HTTP/WebSocket API, Docker orchestration, git operations, terminal I/O, usage tracking, and MCP server management.
- **`src/web/`** — React/TypeScript frontend. Vite build, Tailwind CSS, xterm.js terminal renderer (WebGL addon).
- **`src/desktop/`** — Tauri desktop wrapper around the web frontend.
- **`src/fbi-tunnel/`** — Rust port-forwarding helper that runs inside agent containers.
- **`src/fbi-term-core/`** — Rust NIF (alacritty_terminal-backed) for terminal state parsing. Built via `make nif` in `src/server/`; requires `cargo` (Rust 1.77+).
- **`tests/quantico/`** — Rust mock-Claude binary used in E2E tests.
