use alacritty_terminal::event::EventListener;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::Term;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use std::io::Write;

#[derive(Clone, Copy, PartialEq)]
struct AttrState {
    fg: Color,
    bg: Color,
    bold: bool,
    italic: bool,
    inverse: bool,
}

impl Default for AttrState {
    fn default() -> Self {
        Self {
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            bold: false,
            italic: false,
            inverse: false,
        }
    }
}

impl AttrState {
    fn from_cell(cell: &Cell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            bold: cell.flags.contains(Flags::BOLD),
            italic: cell.flags.contains(Flags::ITALIC),
            inverse: cell.flags.contains(Flags::INVERSE),
        }
    }

    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

pub(crate) fn serialize_grid<L: EventListener>(term: &Term<L>, cols: u16, rows: u16) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut cur = AttrState::default();
    let grid = term.grid();

    for row_idx in 0..rows as i32 {
        let line = Line(row_idx);
        // Find last column with non-default content for trailing-blank trimming.
        let mut last_content: usize = 0;
        for col_idx in 0..cols as usize {
            let cell = &grid[Point {
                line,
                column: Column(col_idx),
            }];
            if !is_default_cell(cell) {
                last_content = col_idx + 1;
            }
        }

        for col_idx in 0..last_content {
            let cell = &grid[Point {
                line,
                column: Column(col_idx),
            }];
            // Skip wide-char spacers.
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER)
                || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            let next = AttrState::from_cell(cell);
            if next != cur {
                emit_sgr(&mut buf, cur, next);
                cur = next;
            }
            let mut utf8 = [0u8; 4];
            let s = cell.c.encode_utf8(&mut utf8);
            buf.extend_from_slice(s.as_bytes());
        }
        buf.extend_from_slice(b"\r\n");
    }

    if !cur.is_default() {
        buf.extend_from_slice(b"\x1b[0m");
    }

    let cursor = grid.cursor.point;
    // cursor.line.0 is i32; clamp to 0 before adding 1.
    let row = (cursor.line.0.max(0) as u16) + 1;
    let col = (cursor.column.0 as u16) + 1;
    write!(&mut buf, "\x1b[{};{}H", row, col).unwrap();
    buf
}

fn is_default_cell(cell: &Cell) -> bool {
    cell.c == ' ' && AttrState::from_cell(cell).is_default()
}

fn emit_sgr(buf: &mut Vec<u8>, prev: AttrState, next: AttrState) {
    if next.is_default() {
        buf.extend_from_slice(b"\x1b[0m");
        return;
    }
    let needs_reset = (prev.bold && !next.bold)
        || (prev.italic && !next.italic)
        || (prev.inverse && !next.inverse);
    let mut effective_prev = prev;
    if needs_reset {
        buf.extend_from_slice(b"\x1b[0m");
        effective_prev = AttrState::default();
    }
    if next.bold && !effective_prev.bold {
        buf.extend_from_slice(b"\x1b[1m");
    }
    if next.italic && !effective_prev.italic {
        buf.extend_from_slice(b"\x1b[3m");
    }
    if next.inverse && !effective_prev.inverse {
        buf.extend_from_slice(b"\x1b[7m");
    }
    if next.fg != effective_prev.fg {
        emit_color_sgr(buf, next.fg, false);
    }
    if next.bg != effective_prev.bg {
        emit_color_sgr(buf, next.bg, true);
    }
}

fn emit_color_sgr(buf: &mut Vec<u8>, color: Color, is_bg: bool) {
    match color {
        Color::Named(NamedColor::Foreground) => buf.extend_from_slice(b"\x1b[39m"),
        Color::Named(NamedColor::Background) => buf.extend_from_slice(b"\x1b[49m"),
        Color::Named(name) => {
            let idx = name as u16;
            // Standard 8 colors: 0-7, Bright: 8-15
            // Special NamedColors (>= 256) — map to default reset
            if idx < 16 {
                let bright = idx >= 8;
                let base: u8 = match (is_bg, bright) {
                    (false, false) => 30,
                    (false, true) => 90,
                    (true, false) => 40,
                    (true, true) => 100,
                };
                write!(buf, "\x1b[{}m", base + (idx & 7) as u8).unwrap();
            } else {
                // Special named colors — emit default reset
                if is_bg {
                    buf.extend_from_slice(b"\x1b[49m");
                } else {
                    buf.extend_from_slice(b"\x1b[39m");
                }
            }
        }
        Color::Indexed(idx) => {
            let prefix: u8 = if is_bg { 48 } else { 38 };
            write!(buf, "\x1b[{};5;{}m", prefix, idx).unwrap();
        }
        Color::Spec(Rgb { r, g, b }) => {
            let prefix: u8 = if is_bg { 48 } else { 38 };
            write!(buf, "\x1b[{};2;{};{};{}m", prefix, r, g, b).unwrap();
        }
    }
}
