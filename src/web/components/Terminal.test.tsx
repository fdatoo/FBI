import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const pauseListeners = new Set<(p: boolean) => void>();
const driverListeners = new Set<(d: boolean) => void>();
let lastController: { pause: () => void; resume: () => void; onScroll: (s: { atBottom: boolean; nearTop: boolean }) => void } | null = null;

const stubShell = {
  onBytes: () => () => {},
  onTypedEvent: () => () => {},
  onSnapshot: () => () => {},
  onOpen: () => () => {},
  send: vi.fn(),
  resize: vi.fn(),
  sendHello: vi.fn(),
  close: vi.fn(),
};

vi.mock('../lib/terminalController.js', () => {
  return {
    TerminalController: vi.fn().mockImplementation(() => {
      const inst = {
        pause: vi.fn(),
        resume: vi.fn().mockResolvedValue(undefined),
        setInteractive: vi.fn(),
        resize: vi.fn(),
        isReady: () => true,
        onReady: vi.fn(),
        onPauseChange: (cb: (p: boolean) => void) => {
          pauseListeners.add(cb);
          return () => pauseListeners.delete(cb);
        },
        onRebuildingChange: (_cb: (r: boolean) => void) => () => {},
        onDriverChange: (cb: (d: boolean) => void) => {
          cb(true); // initial: is driver
          driverListeners.add(cb);
          return () => driverListeners.delete(cb);
        },
        onScroll: vi.fn(),
        getShell: () => stubShell,
        dispose: vi.fn(),
      };
      lastController = inst;
      return inst;
    }),
  };
});

vi.mock('../features/runs/usageBus.js', () => ({}));

vi.mock('@xterm/xterm', () => {
  class FakeTerm {
    cols = 120; rows = 40;
    options: Record<string, unknown> = {};
    buffer = { active: { baseY: 100, viewportY: 100, length: 0, getLine: () => undefined } };
    open() {}
    loadAddon() {}
    onScroll(cb: () => void) {
      (FakeTerm as unknown as { __scrollCbs: Array<() => void> }).__scrollCbs = [cb];
      return { dispose() {} };
    }
    dispose() {}
    focus() {}
    write() {}
    reset() {}
    scrollToBottom() {}
  }
  return { Terminal: FakeTerm };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {},
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { Terminal } from './Terminal.js';

describe('Terminal', () => {
  beforeEach(() => {
    pauseListeners.clear();
    driverListeners.clear();
    lastController = null;
  });

  it('renders without crashing', () => {
    render(<Terminal runId={1} interactive={false} />);
    expect(screen.getByTestId('xterm')).toBeInTheDocument();
  });

  it('shows the pause banner when onPauseChange(true) fires', async () => {
    render(<Terminal runId={1} interactive={false} />);
    await waitFor(() => expect(pauseListeners.size).toBeGreaterThan(0));
    expect(screen.queryByText(/Stream paused/i)).toBeNull();
    act(() => { for (const cb of pauseListeners) cb(true); });
    expect(screen.getByText(/Stream paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume stream/i })).toBeInTheDocument();
  });

  it('clicking Resume stream calls controller.resume()', async () => {
    render(<Terminal runId={1} interactive={false} />);
    await waitFor(() => expect(pauseListeners.size).toBeGreaterThan(0));
    act(() => { for (const cb of pauseListeners) cb(true); });
    await userEvent.click(screen.getByRole('button', { name: /Resume stream/i }));
    expect(lastController?.resume).toHaveBeenCalled();
  });

  it('shows "Viewing only" banner when onDriverChange fires false', async () => {
    render(<Terminal runId={1} interactive={false} />);
    await waitFor(() => expect(driverListeners.size).toBeGreaterThan(0));
    expect(screen.queryByText(/Viewing only/i)).toBeNull();
    act(() => { for (const cb of driverListeners) cb(false); });
    expect(screen.getByText(/Viewing only/i)).toBeInTheDocument();
  });
});
