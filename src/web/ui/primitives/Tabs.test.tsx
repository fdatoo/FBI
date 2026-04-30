import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { Tabs } from './Tabs.js';

function Host() {
  const [v, setV] = useState('a');
  return (
    <Tabs
      value={v}
      onChange={setV}
      tabs={[
        { value: 'a', label: 'Terminal' },
        { value: 'b', label: 'Files', count: 3 },
        { value: 'c', label: 'GitHub' },
      ]}
    />
  );
}

describe('Tabs', () => {
  it('marks the active tab', () => {
    render(<Host />);
    expect(screen.getByRole('tab', { name: /terminal/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('clicking a tab changes selection', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('tab', { name: /github/i }));
    expect(screen.getByRole('tab', { name: /github/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders count when provided', () => {
    render(<Host />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
