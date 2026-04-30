export const NEAR_TOP_LINES = 100;

export interface ScrollSample {
  atBottom: boolean;
  nearTop: boolean;
  viewportTopLine: number;
}

// xterm.js semantics: viewportY grows downward from the top of the scrollback
// buffer. baseY is the index of the last "page" top — when viewportY === baseY
// the user is at the live bottom. viewportY=0 means scrolled all the way to
// the oldest content.
export function detectScroll(term: {
  buffer: { active: { viewportY: number; baseY: number } };
}): ScrollSample {
  const buf = term.buffer.active;
  const atBottom = buf.viewportY === buf.baseY;
  const nearTop = buf.viewportY <= NEAR_TOP_LINES;
  return { atBottom, nearTop, viewportTopLine: buf.viewportY };
}
