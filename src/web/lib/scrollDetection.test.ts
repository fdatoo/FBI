import { describe, it, expect } from 'vitest';
import { detectScroll, NEAR_TOP_LINES } from './scrollDetection.js';

// xterm.js semantics: viewportY=baseY is at the bottom (live view),
// viewportY=0 is at the top (oldest content).
function mkTerm(baseY: number, viewportY: number) {
  return {
    buffer: { active: { viewportY, baseY } },
  };
}

describe('detectScroll', () => {
  it('atBottom when viewportY === baseY (live view)', () => {
    expect(detectScroll(mkTerm(500, 500)).atBottom).toBe(true);
  });

  it('atBottom false when scrolled up (viewportY < baseY)', () => {
    expect(detectScroll(mkTerm(500, 499)).atBottom).toBe(false);
    expect(detectScroll(mkTerm(500, 0)).atBottom).toBe(false);
  });

  it('nearTop true when viewportY <= NEAR_TOP_LINES', () => {
    expect(detectScroll(mkTerm(500, NEAR_TOP_LINES)).nearTop).toBe(true);
    expect(detectScroll(mkTerm(500, NEAR_TOP_LINES - 1)).nearTop).toBe(true);
    expect(detectScroll(mkTerm(500, NEAR_TOP_LINES + 1)).nearTop).toBe(false);
  });

  it('nearTop false when viewportY > NEAR_TOP_LINES', () => {
    expect(detectScroll(mkTerm(500, 200)).nearTop).toBe(false);
  });

  it('viewportTopLine equals viewportY', () => {
    expect(detectScroll(mkTerm(500, 123)).viewportTopLine).toBe(123);
  });
});
