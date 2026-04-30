import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChipInput } from './ChipInput.js';

describe('ChipInput', () => {
  it('renders label and existing values as chips', () => {
    render(<ChipInput label="Plugins" values={['foo', 'bar']} onChange={() => {}} />);
    expect(screen.getByText('Plugins')).toBeInTheDocument();
    expect(screen.getByText('foo')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
  });

  it('adds a value on Enter', async () => {
    const onChange = vi.fn();
    render(<ChipInput label="Plugins" values={[]} onChange={onChange} placeholder="add…" />);
    const input = screen.getByPlaceholderText('add…');
    await userEvent.type(input, 'new-plugin{Enter}');
    expect(onChange).toHaveBeenCalledWith(['new-plugin']);
  });

  it('does not add empty or duplicate values', async () => {
    const onChange = vi.fn();
    render(<ChipInput label="Plugins" values={['existing']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'existing{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, '   {Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a value when × is clicked', async () => {
    const onChange = vi.fn();
    render(<ChipInput label="Plugins" values={['foo', 'bar']} onChange={onChange} />);
    const removeButtons = screen.getAllByRole('button');
    await userEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith(['bar']);
  });

  it('removes last chip on Backspace when input is empty', async () => {
    const onChange = vi.fn();
    render(<ChipInput label="Plugins" values={['foo', 'bar']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await userEvent.click(input);
    await userEvent.keyboard('{Backspace}');
    expect(onChange).toHaveBeenCalledWith(['foo']);
  });
});
