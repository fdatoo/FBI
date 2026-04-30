import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatCard } from './StatCard.js';
import { ProgressBar } from './ProgressBar.js';

describe('StatCard', () => {
  it('renders label, value, delta', () => {
    render(<StatCard label="Active" value="1" delta="running" tone="accent" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });
});

describe('ProgressBar', () => {
  it('computes width as percentage', () => {
    render(<ProgressBar value={25} max={100} aria-label="tokens" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });
});
