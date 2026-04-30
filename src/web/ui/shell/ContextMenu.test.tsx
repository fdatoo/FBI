import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from './ContextMenu.js';
import { contextMenuRegistry } from './contextMenuRegistry.js';

describe('ContextMenu', () => {
  beforeEach(() => {
    contextMenuRegistry._reset();
    vi.clearAllMocks();
  });

  it('does not render when no items', () => {
    render(<ContextMenu />);
    fireEvent.contextMenu(document.body);
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });

  it('renders items for a registered context-id', () => {
    contextMenuRegistry.register('run-row', () => [
      { id: 'copy-id', label: 'Copy run ID', onSelect: vi.fn() },
    ]);
    const div = document.createElement('div');
    div.dataset.contextId = 'run-row';
    div.dataset.contextRunId = '5';
    document.body.appendChild(div);

    render(<ContextMenu />);
    fireEvent.contextMenu(div);
    expect(screen.getByText('Copy run ID')).toBeInTheDocument();

    document.body.removeChild(div);
  });

  it('calls onSelect and closes on item click', () => {
    const onSelect = vi.fn();
    contextMenuRegistry.register('run-row', () => [
      { id: 'copy-id', label: 'Copy run ID', onSelect },
    ]);
    const div = document.createElement('div');
    div.dataset.contextId = 'run-row';
    document.body.appendChild(div);

    render(<ContextMenu />);
    fireEvent.contextMenu(div);
    fireEvent.click(screen.getByText('Copy run ID'));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByText('Copy run ID')).toBeNull();

    document.body.removeChild(div);
  });
});
