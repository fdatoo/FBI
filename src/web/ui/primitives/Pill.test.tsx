import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Pill } from './Pill.js';
import { Kbd } from './Kbd.js';
import { StatusDot } from './StatusDot.js';
import { Tag } from './Tag.js';

describe('Pill', () => {
  it('renders each tone', () => {
    for (const tone of ['ok', 'run', 'attn', 'fail', 'warn', 'wait'] as const) {
      const { unmount } = render(<Pill tone={tone}>{tone}</Pill>);
      expect(screen.getByText(tone)).toHaveAttribute('data-tone', tone);
      unmount();
    }
  });

  it('pulses when tone=run', () => {
    render(<Pill tone="run">x</Pill>);
    expect(screen.getByText('x').className).toContain('animate-pulse');
  });

  it('renders an attn-toned pill', () => {
    render(<Pill tone="attn">waiting</Pill>);
    const el = screen.getByText('waiting');
    expect(el).toHaveAttribute('data-tone', 'attn');
    expect(el.className).toContain('text-attn');
  });
});

describe('Kbd', () => {
  it('renders the key character', () => {
    render(<Kbd>⌘</Kbd>);
    expect(screen.getByText('⌘').tagName).toBe('KBD');
  });
});

describe('StatusDot', () => {
  it('exposes the tone', () => {
    render(<StatusDot tone="ok" aria-label="succeeded" />);
    expect(screen.getByLabelText('succeeded')).toHaveAttribute('data-tone', 'ok');
  });

  it('exposes attn tone with pulse', () => {
    render(<StatusDot tone="attn" aria-label="waiting" />);
    const el = screen.getByLabelText('waiting');
    expect(el).toHaveAttribute('data-tone', 'attn');
    expect(el.className).toContain('animate-pulse');
  });
});

describe('Tag', () => {
  it('renders children', () => {
    render(<Tag>main</Tag>);
    expect(screen.getByText('main')).toBeInTheDocument();
  });
});
