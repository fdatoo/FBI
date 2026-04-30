use fbi_term_core::Parser;

#[test]
fn empty_grid_serializes_to_empty_rows_plus_cup() {
    let p = Parser::new(80, 5);
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    // Five empty rows = five "\r\n", then final CUP \e[1;1H.
    assert!(s.contains("\r\n\r\n\r\n\r\n\r\n"));
    assert!(s.ends_with("\x1b[1;1H"));
}

#[test]
fn plain_text_round_trips() {
    let mut p = Parser::new(80, 5);
    p.feed(b"hello");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("hello"));
    // Cursor should be at row 1, col 6 (1-indexed) after writing 5 chars.
    assert!(s.ends_with("\x1b[1;6H"));
}

#[test]
fn newline_advances_cursor_to_next_row() {
    let mut p = Parser::new(80, 5);
    p.feed(b"a\r\nb");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("a\r\n"));
    assert!(s.contains("b"));
    assert!(s.ends_with("\x1b[2;2H"));
}

#[test]
fn red_text_emits_sgr_31() {
    let mut p = Parser::new(80, 5);
    p.feed(b"\x1b[31mfoo\x1b[0m");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("\x1b[31m"));
    assert!(s.contains("foo"));
}

#[test]
fn truecolor_round_trips() {
    let mut p = Parser::new(80, 5);
    p.feed(b"\x1b[38;2;100;200;50mhi\x1b[0m");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("38;2;100;200;50"));
}

#[test]
fn bold_then_normal_resets_via_0() {
    let mut p = Parser::new(80, 5);
    p.feed(b"\x1b[1mB\x1b[0mn");
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    assert!(s.contains("\x1b[1m"));
    assert!(s.contains("B"));
    assert!(s.contains("\x1b[0m"));
}

#[test]
fn trailing_blanks_are_trimmed() {
    let mut p = Parser::new(80, 1);
    p.feed(b"hi"); // followed by 78 default blanks on the row
    let snap = p.snapshot();
    let s = String::from_utf8(snap.ansi).unwrap();
    // Only "hi\r\n" — not 78 spaces between hi and \r\n.
    // The snapshot includes a mode prefix, so locate "hi" and verify it is
    // immediately followed by "\r\n" (no trailing spaces).
    assert!(
        s.contains("hi\r\n"),
        "expected 'hi\\r\\n' in snapshot: {:?}",
        s
    );
    // Also verify there are no spaces between "hi" and the next line break.
    assert!(
        !s.contains("hi "),
        "trailing spaces found after 'hi' in: {:?}",
        s
    );
}
