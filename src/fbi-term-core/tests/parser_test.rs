use fbi_term_core::Parser;

#[test]
fn new_parser_has_correct_dims() {
    let p = Parser::new(80, 24);
    assert_eq!(p.cols(), 80);
    assert_eq!(p.rows(), 24);
}

#[test]
fn snapshot_includes_dims_and_zero_offset_after_init() {
    let p = Parser::new(80, 24);
    let snap = p.snapshot();
    assert_eq!(snap.cols, 80);
    assert_eq!(snap.rows, 24);
    assert_eq!(snap.byte_offset, 0);
}

#[test]
fn feed_advances_byte_offset() {
    let mut p = Parser::new(80, 24);
    p.feed(b"hello world");
    assert_eq!(p.snapshot().byte_offset, 11);
}

#[test]
fn resize_changes_dims() {
    let mut p = Parser::new(80, 24);
    p.resize(100, 30);
    assert_eq!(p.cols(), 100);
    assert_eq!(p.rows(), 30);
}

#[test]
fn snapshot_at_offset_beyond_fed_returns_empty() {
    let p = Parser::new(80, 24);
    let prefix = p.snapshot_at(100);
    assert_eq!(prefix.ansi, Vec::<u8>::new());
}

#[test]
fn snapshot_at_zero_returns_default_modes() {
    let p = Parser::new(80, 24);
    let prefix = p.snapshot_at(0);
    let s = String::from_utf8(prefix.ansi).unwrap();
    // Default modes: main screen + clear, scroll region reset, auto-wrap on, cursor visible.
    assert!(s.starts_with("\x1b[?1049l\x1b[H\x1b[2J"));
    assert!(s.contains("?7h"));
    assert!(s.contains("?25h"));
}

#[test]
fn snapshot_at_after_alt_screen_replay_includes_alt_set() {
    let mut p = Parser::new(80, 24);
    p.feed(b"\x1b[?1049h");
    let prefix = p.snapshot_at(p.snapshot().byte_offset);
    let s = String::from_utf8(prefix.ansi).unwrap();
    assert!(s.starts_with("\x1b[?1049h"));
}
