use fbi_term_core::{ModeScanner, ModeState};

#[test]
fn default_emit_has_main_screen_clear_and_default_modes() {
    let scanner = ModeScanner::new();
    let bytes = scanner.emit(24);
    let s = std::str::from_utf8(&bytes).unwrap();
    // Step 1: main screen + clear (since alt_screen=false default).
    assert!(s.starts_with("\x1b[?1049l\x1b[H\x1b[2J"));
    // Step 2: scroll region reset.
    assert!(s.contains("\x1b[r"));
    // Step 3: auto-wrap on, cursor visible (defaults).
    assert!(s.contains("\x1b[?7h"));
    assert!(s.contains("\x1b[?25h"));
    // Step 5: no mouse / bracketed paste / focus / in-band-resize set by default.
    assert!(!s.contains("?2004h"));
    assert!(!s.contains("?1004h"));
    assert!(!s.contains("?1000h"));
}

#[test]
fn alt_screen_set_and_clear_via_1049() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?1049h");
    assert!(s.modes().alt_screen);
    s.feed(b"\x1b[?1049l");
    assert!(!s.modes().alt_screen);
}

#[test]
fn alt_screen_emit_uses_1049h_when_set() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?1049h");
    let out = s.emit(24);
    assert!(out.starts_with(b"\x1b[?1049h"));
}

#[test]
fn dectcem_set_and_clear_via_25() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?25l");
    assert!(!s.modes().cursor_visible);
    s.feed(b"\x1b[?25h");
    assert!(s.modes().cursor_visible);
}

#[test]
fn decstbm_sets_top_and_bottom() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[5;20r");
    assert_eq!(s.modes().stbm_top, Some(5));
    assert_eq!(s.modes().stbm_bottom, Some(20));
}

#[test]
fn decstbm_reset_with_no_params() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[5;20r");
    s.feed(b"\x1b[r");
    assert_eq!(s.modes().stbm_top, None);
    assert_eq!(s.modes().stbm_bottom, None);
}

#[test]
fn mouse_mode_replaced_on_set() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?1000h");
    assert_eq!(s.modes().mouse_mode, 1000);
    s.feed(b"\x1b[?1003h");
    assert_eq!(s.modes().mouse_mode, 1003);
}

#[test]
fn mouse_mode_clear_only_if_matches_current() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?1003h");
    s.feed(b"\x1b[?1000l"); // doesn't match — should not clear
    assert_eq!(s.modes().mouse_mode, 1003);
    s.feed(b"\x1b[?1003l"); // matches — clears
    assert_eq!(s.modes().mouse_mode, 0);
}

#[test]
fn bracketed_paste_emit_only_when_set() {
    let mut s = ModeScanner::new();
    let out_off = s.emit(24);
    assert!(!String::from_utf8_lossy(&out_off).contains("?2004h"));
    s.feed(b"\x1b[?2004h");
    let out_on = s.emit(24);
    assert!(String::from_utf8_lossy(&out_on).contains("?2004h"));
}

#[test]
fn auto_wrap_off_emits_7l() {
    let mut s = ModeScanner::new();
    s.feed(b"\x1b[?7l");
    let out = s.emit(24);
    assert!(String::from_utf8_lossy(&out).contains("?7l"));
}

#[test]
fn with_initial_replays_modes() {
    let initial = ModeState {
        alt_screen: true,
        ..ModeState::default()
    };
    let s = ModeScanner::with_initial(initial);
    let out = s.emit(24);
    assert!(out.starts_with(b"\x1b[?1049h"));
}
