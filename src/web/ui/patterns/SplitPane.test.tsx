import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SplitPane } from './SplitPane.js';

// ---- localStorage mock ----
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SplitPane', () => {
  it('renders left and right panels', () => {
    render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    expect(screen.getByText('L')).toBeInTheDocument();
    expect(screen.getByText('R')).toBeInTheDocument();
  });

  it('divider appears with role="separator"', () => {
    render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('pressing ArrowRight on focused divider widens the pane', () => {
    render(
      <SplitPane
        left={<div>L</div>}
        right={<div>R</div>}
        leftWidth="360px"
        minLeftWidth={240}
        maxLeftWidth={640}
      />,
    );
    const divider = screen.getByRole('separator');
    divider.focus();
    fireEvent.keyDown(divider, { key: 'ArrowRight' });

    const aside = document.querySelector('aside');
    expect(aside).not.toBeNull();
    const w = parseFloat(aside!.style.width);
    expect(w).toBe(376); // 360 + 16
  });

  it('pressing ArrowLeft on focused divider narrows the pane', () => {
    render(
      <SplitPane
        left={<div>L</div>}
        right={<div>R</div>}
        leftWidth="360px"
        minLeftWidth={240}
        maxLeftWidth={640}
      />,
    );
    const divider = screen.getByRole('separator');
    divider.focus();
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });

    const aside = document.querySelector('aside');
    expect(aside).not.toBeNull();
    const w = parseFloat(aside!.style.width);
    expect(w).toBe(344); // 360 - 16
  });

  it('clamps at maxLeftWidth', () => {
    render(
      <SplitPane
        left={<div>L</div>}
        right={<div>R</div>}
        leftWidth="640px"
        minLeftWidth={240}
        maxLeftWidth={640}
      />,
    );
    const divider = screen.getByRole('separator');
    divider.focus();
    fireEvent.keyDown(divider, { key: 'ArrowRight' }); // would be 656 without clamp

    const aside = document.querySelector('aside');
    expect(aside).not.toBeNull();
    const w = parseFloat(aside!.style.width);
    expect(w).toBe(640);
  });

  it('clamps at minLeftWidth', () => {
    render(
      <SplitPane
        left={<div>L</div>}
        right={<div>R</div>}
        leftWidth="240px"
        minLeftWidth={240}
        maxLeftWidth={640}
      />,
    );
    const divider = screen.getByRole('separator');
    divider.focus();
    fireEvent.keyDown(divider, { key: 'ArrowLeft' }); // would be 224 without clamp

    const aside = document.querySelector('aside');
    expect(aside).not.toBeNull();
    const w = parseFloat(aside!.style.width);
    expect(w).toBe(240);
  });

  it('persists to localStorage when storageKey is provided and ArrowRight is pressed', () => {
    render(
      <SplitPane
        left={<div>L</div>}
        right={<div>R</div>}
        leftWidth="360px"
        storageKey="test-pane"
      />,
    );
    const divider = screen.getByRole('separator');
    divider.focus();
    fireEvent.keyDown(divider, { key: 'ArrowRight' });

    expect(store['fbi-splitpane:test-pane']).toBe('376');
  });

  it('reads persisted width from localStorage on mount', () => {
    store['fbi-splitpane:test-pane2'] = '480';
    render(
      <SplitPane
        left={<div>L</div>}
        right={<div>R</div>}
        leftWidth="360px"
        storageKey="test-pane2"
      />,
    );
    const aside = document.querySelector('aside');
    expect(aside).not.toBeNull();
    const w = parseFloat(aside!.style.width);
    expect(w).toBe(480);
  });
});
