RUST_PROJECT := ../fbi-term-core
RUST_WORKSPACE := ../..
NIF_SO := priv/native/fbi_term_core.so
# macOS cdylib → .dylib; Linux → .so
LIB_EXT := $(if $(filter Darwin,$(shell uname -s)),dylib,so)

.PHONY: build clean nif

nif: $(NIF_SO)

$(NIF_SO):
	@mkdir -p priv/native
	cd $(RUST_WORKSPACE) && CARGO_HOME=/tmp/cargo-home cargo build --release -p fbi_term_core
	cp $(RUST_WORKSPACE)/target/release/libfbi_term_core.$(LIB_EXT) $(NIF_SO)

build: nif
	gleam build

clean:
	rm -rf build/ priv/native/

release: build
	gleam export erlang-shipment
	@echo "Shipped to build/erlang-shipment/"
