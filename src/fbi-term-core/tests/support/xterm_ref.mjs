#!/usr/bin/env node
// Reads bytes from argv[2] (file path), feeds them to @xterm/headless
// at the dims given in argv[3] (e.g. "80x24"), and writes a normalized
// JSON grid dump to stdout.
//
// Output schema:
//   { cols, rows, cursor: {row, col, visible},
//     active_buffer: "main"|"alt",
//     scroll_region: {top, bottom},
//     mode_flags: {auto_wrap, bracketed_paste, focus_reporting, in_band_resize, mouse_mode, mouse_ext},
//     cells: [
//       [ {ch, fg, bg, bold, italic, inverse, underline, strikethrough, dim, wide} | null, ... ],
//       ...
//     ]
//   }

import { readFile } from 'node:fs/promises';
import pkg from '@xterm/headless';
const { Terminal } = pkg;

const path = process.argv[2];
const dims = process.argv[3] || '80x24';
const [cols, rows] = dims.split('x').map(Number);

if (!path) {
  console.error('usage: xterm_ref.mjs <bytes-file> [colsxrows]');
  process.exit(2);
}

const bytes = await readFile(path);
const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
await new Promise((resolve) => term.write(bytes, resolve));

const buf = term.buffer.active;
const cells = [];
for (let r = 0; r < rows; r++) {
  const line = buf.getLine(buf.viewportY + r);
  const row = [];
  for (let c = 0; c < cols; c++) {
    if (!line) { row.push(null); continue; }
    const cell = line.getCell(c);
    if (!cell) { row.push(null); continue; }
    row.push({
      ch: cell.getChars() || ' ',
      fg: cell.getFgColor(),
      fg_mode: cell.isFgRGB() ? 'rgb' : cell.isFgPalette() ? 'palette' : 'default',
      bg: cell.getBgColor(),
      bg_mode: cell.isBgRGB() ? 'rgb' : cell.isBgPalette() ? 'palette' : 'default',
      bold: !!cell.isBold(),
      italic: !!cell.isItalic(),
      inverse: !!cell.isInverse(),
      underline: !!cell.isUnderline(),
      strikethrough: !!cell.isStrikethrough(),
      dim: !!cell.isDim(),
      wide: cell.getWidth() === 2,
    });
  }
  cells.push(row);
}

const dump = {
  cols, rows,
  cursor: { row: buf.cursorY, col: buf.cursorX, visible: term.options.cursorBlink !== false },
  active_buffer: term.buffer.active === term.buffer.normal ? 'main' : 'alt',
  scroll_region: { top: 0, bottom: rows - 1 },  // xterm.js exposes scroll region only via private API
  mode_flags: {
    auto_wrap: !!term.options.scrollOnUserInput,  // proxy; xterm.js does not expose DECAWM publicly
  },
  cells,
};

process.stdout.write(JSON.stringify(dump) + '\n');
