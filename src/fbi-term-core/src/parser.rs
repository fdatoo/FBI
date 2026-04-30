use crate::checkpoint::CheckpointStore;
use crate::modes::{ModeScanner, ModeState};
use crate::serialize;
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Color, Processor, Rgb};
use serde::Serialize;

pub struct Snapshot {
    pub ansi: Vec<u8>,
    pub cols: u16,
    pub rows: u16,
    pub byte_offset: u64,
}

pub struct ModePrefix {
    pub ansi: Vec<u8>,
}

#[derive(Serialize)]
pub struct GridDump {
    pub cols: u16,
    pub rows: u16,
    pub cursor: CursorDump,
    pub active_buffer: String,
    pub scroll_region: ScrollRegionDump,
    pub mode_flags: ModeFlagsDump,
    pub cells: Vec<Vec<Option<CellDump>>>,
}

#[derive(Serialize)]
pub struct CursorDump {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
}

#[derive(Serialize)]
pub struct ScrollRegionDump {
    pub top: u16,
    pub bottom: u16,
}

#[derive(Serialize)]
pub struct ModeFlagsDump {
    pub auto_wrap: bool,
    pub bracketed_paste: bool,
    pub focus_reporting: bool,
    pub in_band_resize: bool,
    pub mouse_mode: u16,
    pub mouse_ext: u16,
}

#[derive(Serialize)]
pub struct CellDump {
    pub ch: String,
    pub fg: i64,
    pub fg_mode: String,
    pub bg: i64,
    pub bg_mode: String,
    pub bold: bool,
    pub italic: bool,
    pub inverse: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub dim: bool,
    pub wide: bool,
}

fn color_to_dump(color: Color) -> (i64, &'static str) {
    match color {
        Color::Named(name) => {
            let idx = name as i64;
            match idx {
                0..=15 => (idx, "palette"),
                259..=265 => (idx - 259, "palette"), // DimBlack..DimWhite -> 0..6
                _ => (-1, "default"), // Foreground=256, Background=257, Cursor=258, BrightForeground=266, DimForeground=267
            }
        }
        Color::Indexed(i) => (i as i64, "palette"),
        Color::Spec(Rgb { r, g, b }) => {
            (((r as i64) << 16) | ((g as i64) << 8) | (b as i64), "rgb")
        }
    }
}

#[derive(Clone)]
struct NopListener;
impl EventListener for NopListener {
    fn send_event(&self, _event: Event) {}
}

pub struct Parser {
    term: Term<NopListener>,
    processor: Processor,
    mode_scanner: ModeScanner,
    checkpoints: CheckpointStore,
    bytes_fed: u64,
    cols: u16,
    rows: u16,
}

impl Parser {
    pub fn new(cols: u16, rows: u16) -> Self {
        let size = TermSize::new(cols as usize, rows as usize);
        let config = Config::default();
        let term = Term::new(config, &size, NopListener);
        Self {
            term,
            processor: Processor::new(),
            mode_scanner: ModeScanner::new(),
            checkpoints: CheckpointStore::new(),
            bytes_fed: 0,
            cols,
            rows,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let offset_before = self.bytes_fed;
        // vte 0.15: Processor::advance(&mut self, handler: &mut H, bytes: &[u8])
        // Term<T> implements vte::ansi::Handler, so we can pass &mut self.term directly
        self.processor.advance(&mut self.term, bytes);
        self.mode_scanner.feed(bytes);
        let modes_after = self.mode_scanner.modes();
        self.checkpoints.record(bytes, offset_before, &modes_after);
        self.bytes_fed += bytes.len() as u64;
    }

    pub fn snapshot(&self) -> Snapshot {
        let mode_prefix = self.mode_scanner.emit(self.rows);
        let grid_ansi = serialize::serialize_grid(&self.term, self.cols, self.rows);
        let mut ansi = Vec::with_capacity(mode_prefix.len() + grid_ansi.len());
        ansi.extend_from_slice(&mode_prefix);
        ansi.extend_from_slice(&grid_ansi);
        Snapshot {
            ansi,
            cols: self.cols,
            rows: self.rows,
            byte_offset: self.bytes_fed,
        }
    }

    pub fn snapshot_at(&self, offset: u64) -> ModePrefix {
        if offset > self.bytes_fed {
            return ModePrefix { ansi: Vec::new() };
        }
        let result = match self.checkpoints.locate(offset) {
            Some(r) => r,
            None => return ModePrefix { ansi: Vec::new() },
        };
        let mut scanner = ModeScanner::with_initial(result.cp_modes);
        scanner.feed(result.replay_bytes);
        ModePrefix {
            ansi: scanner.emit(self.rows),
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        let size = TermSize::new(cols as usize, rows as usize);
        self.term.resize(size);
        self.cols = cols;
        self.rows = rows;
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }
    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn modes(&self) -> ModeState {
        self.mode_scanner.modes()
    }

    pub fn grid_dump(&self) -> GridDump {
        let modes = self.mode_scanner.modes();
        let grid = self.term.grid();

        // Cursor
        let cursor_point = grid.cursor.point;
        let cursor_row = cursor_point.line.0.max(0) as u16;
        let cursor_col = cursor_point.column.0 as u16;

        // Active buffer
        let active_buffer = if modes.alt_screen {
            "alt".to_string()
        } else {
            "main".to_string()
        };

        // Scroll region
        let scroll_region = ScrollRegionDump {
            top: modes.stbm_top.map(|v| v.saturating_sub(1)).unwrap_or(0),
            bottom: modes
                .stbm_bottom
                .map(|v| v.saturating_sub(1))
                .unwrap_or(self.rows - 1),
        };

        // Mode flags
        let mode_flags = ModeFlagsDump {
            auto_wrap: modes.auto_wrap,
            bracketed_paste: modes.bracketed_paste,
            focus_reporting: modes.focus_reporting,
            in_band_resize: modes.in_band_resize,
            mouse_mode: modes.mouse_mode,
            mouse_ext: modes.mouse_ext,
        };

        // Cells
        let mut cells = Vec::with_capacity(self.rows as usize);
        for row_idx in 0..self.rows as i32 {
            let mut row = Vec::with_capacity(self.cols as usize);
            for col_idx in 0..self.cols as usize {
                let cell = &grid[Point {
                    line: Line(row_idx),
                    column: Column(col_idx),
                }];
                // Skip wide-char spacers — push null
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER)
                    || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    row.push(None);
                    continue;
                }
                let (fg, fg_mode) = color_to_dump(cell.fg);
                let (bg, bg_mode) = color_to_dump(cell.bg);
                row.push(Some(CellDump {
                    ch: cell.c.to_string(),
                    fg,
                    fg_mode: fg_mode.to_string(),
                    bg,
                    bg_mode: bg_mode.to_string(),
                    bold: cell.flags.contains(Flags::BOLD),
                    italic: cell.flags.contains(Flags::ITALIC),
                    inverse: cell.flags.contains(Flags::INVERSE),
                    underline: cell.flags.contains(Flags::UNDERLINE),
                    strikethrough: false, // not in alacritty_terminal 0.26
                    dim: cell.flags.contains(Flags::DIM),
                    wide: cell.flags.contains(Flags::WIDE_CHAR),
                }));
            }
            cells.push(row);
        }

        GridDump {
            cols: self.cols,
            rows: self.rows,
            cursor: CursorDump {
                row: cursor_row,
                col: cursor_col,
                visible: modes.cursor_visible,
            },
            active_buffer,
            scroll_region,
            mode_flags,
            cells,
        }
    }
}
