import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandPalette } from './CommandPalette.js';
import { paletteRegistry } from './paletteRegistry.js';

beforeEach(() => { paletteRegistry._reset(); });

describe('CommandPalette', () => {
  it('renders static actions registered via the registry', async () => {
    const run = vi.fn();
    paletteRegistry.register({
      id: 'actions',
      label: 'Actions',
      items: async () => [{ id: 'theme', label: 'Toggle theme', onSelect: run }],
    });
    render(<CommandPalette open={true} onClose={() => {}} />);
    await userEvent.keyboard('the');
    expect(await screen.findByText('Toggle theme')).toBeInTheDocument();
  });

  it('selecting an item calls onSelect and closes', async () => {
    const onClose = vi.fn();
    const run = vi.fn();
    paletteRegistry.register({
      id: 'actions',
      label: 'Actions',
      items: async () => [{ id: 'a', label: 'Do a thing', onSelect: run }],
    });
    render(<CommandPalette open={true} onClose={onClose} />);
    await userEvent.click(await screen.findByText('Do a thing'));
    expect(run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
