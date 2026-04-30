import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Menu } from './Menu.js';

describe('Menu', () => {
  it('renders grouped sections with labels and separators', () => {
    render(<Menu trigger={<button>open</button>} sections={[
      { label: 'A', items: [{ id: '1', label: 'one', onSelect: () => {} }] },
      { label: 'B', items: [{ id: '2', label: 'two', onSelect: () => {} }] },
    ]} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
  });

  it('renders a check mark for checked items', () => {
    render(<Menu trigger={<button>open</button>} items={[
      { id: '1', label: 'one', checked: true, onSelect: () => {} },
      { id: '2', label: 'two', onSelect: () => {} },
    ]} />);
    fireEvent.click(screen.getByText('open'));
    const one = screen.getByText('one').closest('button')!;
    const two = screen.getByText('two').closest('button')!;
    expect(one.querySelector('svg')).not.toBeNull();
    expect(two.querySelector('svg')).toBeNull();
  });

  it('supports flat items (legacy API)', () => {
    const onSelect = vi.fn();
    render(<Menu trigger={<button>open</button>} items={[
      { id: '1', label: 'click me', onSelect },
    ]} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('click me'));
    expect(onSelect).toHaveBeenCalled();
  });
});
