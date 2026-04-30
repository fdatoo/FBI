import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffBlock } from './DiffBlock.js';

describe('DiffBlock', () => {
  it('renders hunks with add/del/ctx lines', () => {
    render(<DiffBlock hunks={[{
      header: '@@ -1,3 +1,3 @@',
      lines: [
        { kind: 'ctx', text: 'a' },
        { kind: 'del', text: 'b' },
        { kind: 'add', text: 'c' },
      ],
    }]} />);
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeInTheDocument();
    const lines = screen.getAllByText((_, el) => el?.className.includes('bg-ok-subtle') ?? false);
    expect(lines.length).toBe(1);
    expect(lines[0].textContent).toContain('c');
  });

  it('shows a truncated banner when truncated=true', () => {
    render(<DiffBlock hunks={[]} truncated />);
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});
