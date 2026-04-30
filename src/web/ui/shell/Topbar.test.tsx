import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Topbar } from './Topbar.js';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));

describe('Topbar (Tauri mode)', () => {
  it('renders the FBI logo and breadcrumb', () => {
    render(<Topbar breadcrumb="/runs/42" onOpenPalette={() => {}} />);
    expect(screen.getByText('▮ FBI')).toBeInTheDocument();
    expect(screen.getByText('/runs/42')).toBeInTheDocument();
  });
});
