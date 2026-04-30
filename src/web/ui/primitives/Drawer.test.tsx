import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Drawer } from './Drawer.js';
import { Menu } from './Menu.js';

describe('Drawer', () => {
  it('collapses and expands on toggle', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <Drawer open={true} onToggle={onToggle} header={<span>Files</span>}><div>body</div></Drawer>,
    );
    expect(screen.getByText('body')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /collapse drawer/i }));
    expect(onToggle).toHaveBeenCalledWith(false);
    rerender(<Drawer open={false} onToggle={onToggle} header={<span>Files</span>}><div>body</div></Drawer>);
    expect(screen.queryByText('body')).not.toBeInTheDocument();
  });
});

describe('Menu', () => {
  it('opens on trigger and picks an item', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button>Open</button>}
        items={[
          { id: 'a', label: 'Cancel', onSelect: () => onSelect('a') },
          { id: 'b', label: 'Delete', onSelect: () => onSelect('b') },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /open/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /delete/i }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });
});
