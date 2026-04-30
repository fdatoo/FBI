import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WipSection } from './WipSection.js';

describe('WipSection', () => {
  it('renders nothing when payload.ok is false', () => {
    const { container } = render(<WipSection runId={1} payload={{ ok: false, reason: 'no-wip' }} />);
    expect(container.firstChild).toBeNull();
  });
  it('renders a file list with the "Unsaved changes" header', () => {
    render(<WipSection runId={1} payload={{
      ok: true, snapshot_sha: 'abc', parent_sha: 'def',
      files: [{ path: 'a.txt', status: 'M', additions: 0, deletions: 0 }],
    }} />);
    expect(screen.getByText(/Unsaved changes/i)).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
  });
});
