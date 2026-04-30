import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Start run</Button>);
    await userEvent.click(screen.getByRole('button', { name: /start run/i }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies the primary variant by default', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'primary');
  });

  it('applies secondary/ghost/danger variants', () => {
    const { rerender } = render(<Button variant="secondary">x</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'secondary');
    rerender(<Button variant="ghost">x</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'ghost');
    rerender(<Button variant="danger">x</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'danger');
  });

  it('disabled prevents click', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabled>Go</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('requires and exposes an aria-label', () => {
    render(<IconButton aria-label="Close">×</IconButton>);
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });
});
