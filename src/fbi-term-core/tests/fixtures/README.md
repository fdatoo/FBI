# Fixtures

Deterministic byte-stream captures from `cli/quantico` scenarios. Each
`<name>.bin` is the concatenation of `emit` and `emit_ansi` payloads
from `cli/quantico/scenarios/<name>.yaml`, captured via:

```
cargo run -p quantico -- --capture-bytes \
  --scenario-file cli/quantico/scenarios/<name>.yaml \
  cli/fbi-term-core/tests/fixtures/<name>.bin
```

Fixtures are checked in. Regenerate them only when scenarios change.
