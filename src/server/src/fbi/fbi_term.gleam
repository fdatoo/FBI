import gleam/dynamic.{type Dynamic}

pub opaque type TerminalState {
  TerminalState(ref: Dynamic)
}

pub type Snapshot {
  Snapshot(ansi: String, cols: Int, rows: Int, byte_offset: Int)
}

pub type ModePrefix {
  ModePrefix(ansi: String)
}

pub fn new(cols: Int, rows: Int) -> TerminalState {
  TerminalState(nif_new_state(cols, rows))
}

pub fn feed(state: TerminalState, bytes: BitArray) -> TerminalState {
  let _ = nif_feed(state.ref, bytes)
  state
  // handle is mutated in place; return same state wrapper
}

pub fn feed_file(state: TerminalState, path: String) -> TerminalState {
  let _ = nif_feed_file(state.ref, path)
  state
  // same pattern
}

pub fn resize(state: TerminalState, cols: Int, rows: Int) -> TerminalState {
  let _ = nif_resize(state.ref, cols, rows)
  state
}

pub fn snapshot(state: TerminalState) -> Snapshot {
  let #(ansi, cols, rows, offset) = nif_snapshot(state.ref)
  Snapshot(ansi: ansi, cols: cols, rows: rows, byte_offset: offset)
}

pub fn snapshot_at(state: TerminalState, byte_offset: Int) -> ModePrefix {
  let ansi = nif_snapshot_at(state.ref, byte_offset)
  ModePrefix(ansi: ansi)
}

@external(erlang, "fbi_term_nif", "new_state")
fn nif_new_state(cols: Int, rows: Int) -> Dynamic

@external(erlang, "fbi_term_nif", "feed")
fn nif_feed(state: Dynamic, bytes: BitArray) -> Dynamic

@external(erlang, "fbi_term_nif", "feed_file")
fn nif_feed_file(state: Dynamic, path: String) -> Dynamic

@external(erlang, "fbi_term_nif", "resize")
fn nif_resize(state: Dynamic, cols: Int, rows: Int) -> Dynamic

@external(erlang, "fbi_term_nif", "snapshot")
fn nif_snapshot(state: Dynamic) -> #(String, Int, Int, Int)

@external(erlang, "fbi_term_nif", "snapshot_at")
fn nif_snapshot_at(state: Dynamic, offset: Int) -> String
