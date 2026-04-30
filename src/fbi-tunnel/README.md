# fbi-tunnel

Local CLI that forwards TCP from your laptop into an FBI run's container.
See [the design spec](../../docs/superpowers/specs/2026-04-22-port-tunnel-design.md).

## Usage

    fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...

Examples:

    fbi-tunnel http://fbi.tailnet:3000 42
    fbi-tunnel http://fbi.tailnet:3000 42 -L 5173:5173 -L 9229:9229
    fbi-tunnel http://fbi.tailnet:3000 42 -L 8080:5173

## Build

    make build              # cross-compiles to dist/
    make install            # installs host binary to ~/.local/bin
    make test
