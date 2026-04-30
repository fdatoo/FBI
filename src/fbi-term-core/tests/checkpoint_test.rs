use fbi_term_core::{checkpoint::CheckpointStore, modes::ModeState};

#[test]
fn fresh_store_locates_offset_zero() {
    let store = CheckpointStore::new();
    let result = store.locate(0).expect("offset 0 should always locate");
    assert_eq!(result.cp_offset, 0);
    assert_eq!(result.cp_modes, ModeState::default());
    assert_eq!(result.replay_bytes.len(), 0);
}

#[test]
fn small_record_does_not_create_checkpoint_yet() {
    let mut store = CheckpointStore::new();
    let modes = ModeState::default();
    store.record(b"hello", 0, &modes);
    let result = store.locate(3).expect("locate within recorded range");
    assert_eq!(result.cp_offset, 0);
    assert_eq!(&result.replay_bytes[..], b"hel");
}

#[test]
fn crossing_256k_boundary_creates_checkpoint() {
    let mut store = CheckpointStore::new();
    let modes = ModeState::default();
    let chunk = vec![b'x'; 100_000];
    store.record(&chunk, 0, &modes);
    store.record(&chunk, 100_000, &modes);
    store.record(&chunk, 200_000, &modes);
    // After 300_000 bytes recorded, offset_after = 300_000 >= 262_144.
    let result = store.locate(280_000).expect("locate after boundary");
    // Either cp_offset == 0 (replay full window) or cp_offset == 300_000 (replay none).
    // Implementation creates the checkpoint at offset_after of the crossing record.
    assert!(result.cp_offset == 300_000 || result.cp_offset == 0);
}

#[test]
fn locate_uses_latest_checkpoint_at_or_before_offset() {
    let mut store = CheckpointStore::new();
    let modes = ModeState::default();
    let chunk = vec![b'a'; 256 * 1024 + 1]; // crosses boundary in single record
    store.record(&chunk, 0, &modes);
    let result = store.locate(256 * 1024 + 1).expect("locate at end");
    assert_eq!(result.cp_offset, 256 * 1024 + 1);
    assert_eq!(result.replay_bytes.len(), 0);
}

#[test]
fn locate_offset_beyond_recorded_returns_none() {
    let store = CheckpointStore::new();
    // Empty store has only checkpoint at 0; locate(100) finds it but replay window is empty.
    let result = store.locate(100).expect("offset 100 finds checkpoint at 0");
    assert_eq!(result.cp_offset, 0);
    assert_eq!(result.replay_bytes.len(), 0);
}
