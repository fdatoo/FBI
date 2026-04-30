.PHONY: help build build-image build-sidecar build-dist test test-web test-server test-rust test-e2e lint lint-web lint-server lint-rust lint-shell

# Requires GNU make (brew install make). BSD make (/usr/bin/make) silently
# ignores .ONESHELL, breaking multi-line recipes. Use gmake on macOS.

.ONESHELL:
SHELL       := /bin/bash
.SHELLFLAGS := -euo pipefail -c

# ── Default ──────────────────────────────────────────────────────────────────

help:
	@echo "Build:"
	@echo "  make build           Web bundle + Gleam release + CLI dist binaries"
	@echo "  make build-image     Build the FBI agent Docker image (fbi-image-default)"
	@echo "  make build-sidecar   fbi-tunnel for Tauri sidecar (src/desktop/binaries/)"
	@echo "  make build-dist      Cross-compile fbi-tunnel + quantico → dist/cli/"
	@echo ""
	@echo "Test:"
	@echo "  make test            All unit tests: web + server + rust"
	@echo "  make test-web        vitest + TypeScript typecheck"
	@echo "  make test-server     gleam test"
	@echo "  make test-rust       cargo test"
	@echo "  make test-e2e        Playwright end-to-end (requires running server)"
	@echo ""
	@echo "Lint:"
	@echo "  make lint            All linters: web + server + rust + shell"
	@echo "  make lint-web        eslint"
	@echo "  make lint-server     gleam format --check"
	@echo "  make lint-rust       cargo clippy"
	@echo "  make lint-shell      shellcheck on priv/static/*.sh"

# ── Build ─────────────────────────────────────────────────────────────────────

build: build-dist
	npm run build:web
	cd src/server
	gleam deps download
	$(MAKE) build
	gleam export erlang-shipment

build-image:
	docker build \
	  -t $${FBI_IMAGE_TAG:-fbi-image-default} \
	  -f docker/agent/Dockerfile \
	  src/server/priv/static/

build-sidecar:
	mkdir -p src/desktop/binaries
	TARGET=$$(rustc -vV | awk '/^host:/ { print $$2 }')
	cargo build --release -p fbi-tunnel
	cp target/release/fbi-tunnel src/desktop/binaries/fbi-tunnel-$$TARGET
	echo "Wrote src/desktop/binaries/fbi-tunnel-$$TARGET"

build-dist:
	OUT=$${DIST_CLI_OUT:-$$(pwd)/dist/cli}
	mkdir -p "$$OUT"
	WORKSPACE_TARGET=$$(cargo metadata --no-deps --format-version 1 | \
	  python3 -c "import sys,json; print(json.load(sys.stdin)['target_directory'])")

	_build() {
	  local triple="$$1" name="$$2" crate="$$3"
	  echo "→ $$crate / $$triple  →  dist/cli/$$crate-$$name"
	  rustup target add "$$triple" 2>/dev/null || true
	  cargo build --release --target "$$triple" -p "$$crate"
	  cp "$$WORKSPACE_TARGET/$$triple/release/$$crate" "$$OUT/$$crate-$$name"
	}

	HOST_OS=$$(uname -s)
	HOST_ARCH=$$(uname -m)

	case "$$HOST_OS/$$HOST_ARCH" in
	  Darwin/*)
	    _build aarch64-apple-darwin darwin-arm64 fbi-tunnel
	    _build aarch64-apple-darwin darwin-arm64 quantico
	    _build x86_64-apple-darwin  darwin-amd64 fbi-tunnel
	    _build x86_64-apple-darwin  darwin-amd64 quantico
	    ;;
	  Linux/x86_64)
	    _build x86_64-unknown-linux-gnu linux-amd64 fbi-tunnel
	    _build x86_64-unknown-linux-gnu linux-amd64 quantico
	    if command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
	      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
	        _build aarch64-unknown-linux-gnu linux-arm64 fbi-tunnel
	      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
	        _build aarch64-unknown-linux-gnu linux-arm64 quantico
	    else
	      echo "Skipping linux-arm64: install gcc-aarch64-linux-gnu for cross-compilation"
	    fi
	    ;;
	  Linux/aarch64)
	    _build aarch64-unknown-linux-gnu linux-arm64 fbi-tunnel
	    _build aarch64-unknown-linux-gnu linux-arm64 quantico
	    if command -v x86_64-linux-gnu-gcc >/dev/null 2>&1; then
	      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
	        _build x86_64-unknown-linux-gnu linux-amd64 fbi-tunnel
	      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
	        _build x86_64-unknown-linux-gnu linux-amd64 quantico
	    else
	      echo "Skipping linux-amd64: install gcc on an x86_64 host for cross-compilation"
	    fi
	    ;;
	  *)
	    echo "Unsupported host: $$HOST_OS/$$HOST_ARCH" >&2
	    exit 1
	    ;;
	esac

	echo ""
	echo "Built:"
	ls -lh "$$OUT/"

# ── Test ──────────────────────────────────────────────────────────────────────

test: test-web test-server test-rust

test-web:
	npm test
	npm run typecheck

test-server:
	cd src/server
	$(MAKE) nif
	gleam test

test-rust:
	cargo test

test-e2e:
	npm run e2e

# ── Lint ──────────────────────────────────────────────────────────────────────

lint: lint-web lint-server lint-rust lint-shell

lint-web:
	npm run lint

lint-server:
	cd src/server
	gleam format --check

lint-rust:
	cargo clippy

lint-shell:
	shellcheck \
	    src/server/priv/static/supervisor.sh \
	    src/server/priv/static/postbuild.sh \
	    src/server/priv/static/postbuild-tools.sh \
	    src/server/priv/static/finalizeBranch.sh \
	    src/server/priv/static/fbi-history-op.sh
