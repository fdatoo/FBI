import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Input } from './Input.js';
import { Textarea } from './Textarea.js';

describe('Input', () => {
  it('forwards value and onChange', async () => {
    function Host() {
      const [v, setV] = useState('');
      return <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="name" />;
    }
    render(<Host />);
    const input = screen.getByPlaceholderText('name');
    await userEvent.type(input, 'abc');
    expect(input).toHaveValue('abc');
  });

  it('forwards ref', () => {
    const ref: { current: HTMLInputElement | null } = { current: null };
    render(<Input ref={ref} placeholder="x" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});

describe('Textarea', () => {
  it('renders and types', async () => {
    function Host() {
      const [v, setV] = useState('');
      return <Textarea value={v} onChange={(e) => setV(e.target.value)} placeholder="ta" />;
    }
    render(<Host />);
    const ta = screen.getByPlaceholderText('ta');
    await userEvent.type(ta, 'hi');
    expect(ta).toHaveValue('hi');
  });
});
