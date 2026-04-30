.PHONY: build test install clean

DIST := dist
TARGETS := \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  x86_64-unknown-linux-gnu \
  aarch64-unknown-linux-gnu

WORKSPACE_TARGET := $(shell cargo metadata --no-deps --format-version 1 | python3 -c "import sys,json; print(json.load(sys.stdin)['target_directory'])")

build:
	@mkdir -p $(DIST)
	@for target in $(TARGETS); do \
	  echo "building $$target..."; \
	  cargo build --release --target $$target -p quantico; \
	  cp $(WORKSPACE_TARGET)/$$target/release/quantico $(DIST)/quantico-$$target; \
	done

test:
	cargo test -p quantico

install:
	cargo install --path . --force

clean:
	rm -rf $(DIST)
