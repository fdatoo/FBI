import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JsonEditor } from './JsonEditor.js';

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange, theme }: { value: string; onChange?: (v: string) => void; theme?: { _isDark: boolean } }) => (
    <textarea
      data-testid="codemirror"
      data-theme={theme?._isDark ? 'dark' : 'light'}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

vi.mock('@uiw/codemirror-themes', () => ({
  createTheme: ({ theme }: { theme: string }) => ({ _isDark: theme === 'dark' }),
}));

vi.mock('@codemirror/lang-json', () => ({
  json: () => ({}),
}));

beforeEach(() => {
  // Theme system: dark is default (no class). Light mode adds '.light'.
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.remove('light');
});

describe('JsonEditor', () => {
  it('renders the label', () => {
    render(<JsonEditor label="My JSON Field" value="" onChange={() => {}} />);
    expect(screen.getByText('My JSON Field')).toBeInTheDocument();
  });

  it('shows no status indicator for empty value', () => {
    render(<JsonEditor label="JSON" value="" onChange={() => {}} />);
    expect(screen.queryByText(/valid json/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/✗/)).not.toBeInTheDocument();
  });

  it('shows valid indicator for valid JSON', () => {
    render(<JsonEditor label="JSON" value='{"image":"ubuntu:22.04"}' onChange={() => {}} />);
    expect(screen.getByText(/✓ valid json/i)).toBeInTheDocument();
  });

  it('shows error indicator for invalid JSON', () => {
    render(<JsonEditor label="JSON" value='{bad json' onChange={() => {}} />);
    expect(screen.getByText(/✗/)).toBeInTheDocument();
  });

  it('calls onChange when editor value changes', async () => {
    const onChange = vi.fn();
    render(<JsonEditor label="JSON" value="" onChange={onChange} />);
    await userEvent.type(screen.getByTestId('codemirror'), '{{');
    expect(onChange).toHaveBeenCalledWith('{');
  });

  it('renders in dark theme by default (no .light class on documentElement)', () => {
    render(<JsonEditor label="JSON" value='{}' onChange={() => {}} />);
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText(/✓ valid json/i)).toBeInTheDocument();
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-theme', 'dark');
  });

  it('switches to light theme via MutationObserver when .light class is added', async () => {
    render(<JsonEditor label="JSON" value="" onChange={() => {}} />);
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-theme', 'dark');
    await act(async () => {
      document.documentElement.classList.add('light');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-theme', 'light');
    await act(async () => {
      document.documentElement.classList.remove('light');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-theme', 'dark');
  });
});
