import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ServerPicker } from './ServerPicker.js';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock('../lib/serverConfig.js', () => ({
  setServerUrl: vi.fn().mockResolvedValue(undefined),
}));

describe('ServerPicker', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('renders input and buttons', () => {
    render(<ServerPicker onConnect={vi.fn()} />);
    expect(screen.getByPlaceholderText(/http:\/\//)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discover/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
  });

  it('shows discovered servers as clickable options', async () => {
    mockInvoke.mockResolvedValue([{ name: 'fbi-server', url: 'http://fbi-server:3000' }]);
    render(<ServerPicker onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /discover/i }));
    await waitFor(() => expect(screen.getByText('fbi-server')).toBeInTheDocument());
    expect(screen.getByText('http://fbi-server:3000')).toBeInTheDocument();
  });

  it('shows error message when discovery returns empty', async () => {
    mockInvoke.mockResolvedValue([]);
    render(<ServerPicker onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /discover/i }));
    await waitFor(() => expect(screen.getByText(/no fbi servers found/i)).toBeInTheDocument());
  });

  it('calls onConnect with the typed URL on Connect click', async () => {
    const onConnect = vi.fn();
    render(<ServerPicker onConnect={onConnect} />);
    const input = screen.getByPlaceholderText(/http:\/\//);
    fireEvent.change(input, { target: { value: 'http://myserver:3000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith('http://myserver:3000'));
  });

  it('clicking a discovered server populates the input', async () => {
    mockInvoke.mockResolvedValue([{ name: 'fbi-server', url: 'http://fbi-server:3000' }]);
    render(<ServerPicker onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /discover/i }));
    await waitFor(() => screen.getByText('fbi-server'));
    fireEvent.click(screen.getByText('fbi-server').closest('button')!);
    expect((screen.getByPlaceholderText(/http:\/\//) as HTMLInputElement).value)
      .toBe('http://fbi-server:3000');
  });
});
