import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TimestampRelative } from './TimestampRelative.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-22T12:00:00Z'));
});

describe('TimestampRelative', () => {
  it('formats "just now" for < 10s', () => {
    render(<TimestampRelative iso="2026-04-22T11:59:55Z" />);
    expect(screen.getByText(/now/i)).toBeInTheDocument();
  });

  it('formats minutes', () => {
    render(<TimestampRelative iso="2026-04-22T11:55:00Z" />);
    expect(screen.getByText(/5m/i)).toBeInTheDocument();
  });

  it('formats hours', () => {
    render(<TimestampRelative iso="2026-04-22T09:00:00Z" />);
    expect(screen.getByText(/3h/i)).toBeInTheDocument();
  });
});
