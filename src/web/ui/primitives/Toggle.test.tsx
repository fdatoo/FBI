import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Toggle } from './Toggle.js';
import { Checkbox } from './Checkbox.js';

describe('Toggle', () => {
  it('fires onChange', async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} aria-label="notifs" />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('reflects checked state via aria-checked', () => {
    render(<Toggle checked onChange={() => {}} aria-label="x" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Checkbox', () => {
  it('fires onChange', async () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} aria-label="agree" />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
