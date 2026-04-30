import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { Sidebar } from './Sidebar.js';
import { sidebarRegistry } from './sidebarRegistry.js';

beforeEach(() => { sidebarRegistry._reset(); });

describe('Sidebar', () => {
  it('renders registered views grouped', () => {
    sidebarRegistry.register({ id: 'runs', group: 'views', label: 'All runs', route: '/runs' });
    sidebarRegistry.register({ id: 'settings', group: 'views', label: 'Settings', route: '/settings' });
    render(
      <MemoryRouter initialEntries={['/runs']}>
        <Sidebar projects={[{ id: 1, name: 'fbi/claude-ui', runs: 12, hasRunning: true, hasWaiting: false }]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('fbi/claude-ui')).toBeInTheDocument();
    expect(screen.getByText('All runs')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});
