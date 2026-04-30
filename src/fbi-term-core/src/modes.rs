use std::io::Write;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModeState {
    pub auto_wrap: bool,
    pub cursor_visible: bool,
    pub alt_screen: bool,
    pub focus_reporting: bool,
    pub bracketed_paste: bool,
    pub in_band_resize: bool,
    pub mouse_mode: u16,
    pub mouse_ext: u16,
    pub stbm_top: Option<u16>,
    pub stbm_bottom: Option<u16>,
}

impl Default for ModeState {
    fn default() -> Self {
        Self {
            auto_wrap: true,
            cursor_visible: true,
            alt_screen: false,
            focus_reporting: false,
            bracketed_paste: false,
            in_band_resize: false,
            mouse_mode: 0,
            mouse_ext: 0,
            stbm_top: None,
            stbm_bottom: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Normal,
    Esc,
    Csi,
}

pub struct ModeScanner {
    modes: ModeState,
    state: ScanState,
    csi_private: Option<u8>,
    csi_params: Vec<u8>,
}

impl ModeScanner {
    pub fn new() -> Self {
        Self {
            modes: ModeState::default(),
            state: ScanState::Normal,
            csi_private: None,
            csi_params: Vec::new(),
        }
    }

    pub fn with_initial(modes: ModeState) -> Self {
        Self {
            modes,
            state: ScanState::Normal,
            csi_private: None,
            csi_params: Vec::new(),
        }
    }

    pub fn feed(&mut self, data: &[u8]) {
        for &b in data {
            match self.state {
                ScanState::Normal => {
                    if b == 0x1b {
                        self.state = ScanState::Esc;
                    }
                }
                ScanState::Esc => {
                    if b == 0x5b {
                        self.state = ScanState::Csi;
                        self.csi_private = None;
                        self.csi_params.clear();
                    } else {
                        self.state = ScanState::Normal;
                    }
                }
                ScanState::Csi => {
                    let no_priv = self.csi_private.is_none();
                    let no_params = self.csi_params.is_empty();
                    if no_priv && no_params && (0x3c..=0x3f).contains(&b) {
                        self.csi_private = Some(b);
                    } else if b.is_ascii_digit() || b == b';' || b == b':' {
                        self.csi_params.push(b);
                    } else if (0x40..=0x7e).contains(&b) {
                        self.dispatch(b);
                        self.state = ScanState::Normal;
                    } else if (0x20..=0x2f).contains(&b) {
                        // intermediate — ignore
                    } else {
                        self.state = ScanState::Normal;
                    }
                }
            }
        }
    }

    pub fn modes(&self) -> ModeState {
        self.modes
    }

    fn dispatch(&mut self, final_byte: u8) {
        if self.csi_private == Some(b'?') && (final_byte == b'h' || final_byte == b'l') {
            let set = final_byte == b'h';
            let modes: Vec<u16> = self
                .csi_params
                .split(|&b| b == b';')
                .filter(|p| !p.is_empty())
                .filter_map(|p| std::str::from_utf8(p).ok())
                .filter_map(|s| s.parse::<u16>().ok())
                .collect();
            for n in modes {
                self.apply_dec_mode(n, set);
            }
        } else if self.csi_private.is_none() && final_byte == b'r' {
            let parts: Vec<&[u8]> = self.csi_params.split(|&b| b == b';').collect();
            let parse = |s: &[u8]| {
                std::str::from_utf8(s)
                    .ok()
                    .and_then(|s| s.parse::<u16>().ok())
            };
            let top = parts.first().and_then(|p| parse(p));
            let bot = parts.get(1).and_then(|p| parse(p));
            if top.is_some() && bot.is_some() {
                self.modes.stbm_top = top;
                self.modes.stbm_bottom = bot;
            } else {
                self.modes.stbm_top = None;
                self.modes.stbm_bottom = None;
            }
        }
    }

    fn apply_dec_mode(&mut self, n: u16, set: bool) {
        match n {
            7 => self.modes.auto_wrap = set,
            25 => self.modes.cursor_visible = set,
            47 | 1047 | 1049 => self.modes.alt_screen = set,
            1004 => self.modes.focus_reporting = set,
            2004 => self.modes.bracketed_paste = set,
            2031 => self.modes.in_band_resize = set,
            1000 | 1002 | 1003 => {
                if set {
                    self.modes.mouse_mode = n;
                } else if self.modes.mouse_mode == n {
                    self.modes.mouse_mode = 0;
                }
            }
            1006 | 1015 | 1016 => {
                if set {
                    self.modes.mouse_ext = n;
                } else if self.modes.mouse_ext == n {
                    self.modes.mouse_ext = 0;
                }
            }
            _ => {}
        }
    }

    /// Emit ANSI replaying the current mode state, given current row count.
    pub fn emit(&self, rows: u16) -> Vec<u8> {
        let mut buf = Vec::new();

        // Step 1: buffer.
        if self.modes.alt_screen {
            buf.extend_from_slice(b"\x1b[?1049h");
        } else {
            buf.extend_from_slice(b"\x1b[?1049l\x1b[H\x1b[2J");
        }

        // Step 2: scroll region.
        if let (Some(top), Some(bot)) = (self.modes.stbm_top, self.modes.stbm_bottom) {
            let top = top.max(1);
            let bot = bot.min(rows);
            let top_c = top.min(rows);
            let bot_c = bot.max(top_c);
            write!(&mut buf, "\x1b[{};{}r", top_c, bot_c).unwrap();
        } else {
            buf.extend_from_slice(b"\x1b[r");
        }

        // Step 3: auto-wrap and cursor visibility — always emitted.
        if self.modes.auto_wrap {
            buf.extend_from_slice(b"\x1b[?7h");
        } else {
            buf.extend_from_slice(b"\x1b[?7l");
        }
        if self.modes.cursor_visible {
            buf.extend_from_slice(b"\x1b[?25h");
        } else {
            buf.extend_from_slice(b"\x1b[?25l");
        }

        // Step 4: optional flags.
        if self.modes.bracketed_paste {
            buf.extend_from_slice(b"\x1b[?2004h");
        }
        if self.modes.focus_reporting {
            buf.extend_from_slice(b"\x1b[?1004h");
        }
        if self.modes.in_band_resize {
            buf.extend_from_slice(b"\x1b[?2031h");
        }

        // Step 5: mouse modes.
        if self.modes.mouse_mode != 0 {
            write!(&mut buf, "\x1b[?{}h", self.modes.mouse_mode).unwrap();
        }
        if self.modes.mouse_ext != 0 {
            write!(&mut buf, "\x1b[?{}h", self.modes.mouse_ext).unwrap();
        }

        buf
    }
}

impl Default for ModeScanner {
    fn default() -> Self {
        Self::new()
    }
}
