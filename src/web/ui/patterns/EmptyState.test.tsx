import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EmptyState } from './EmptyState.js';
import { LoadingState } from './LoadingState.js';
import { ErrorState } from './ErrorState.js';

describe('EmptyState', () => {
  it('shows title and action', () => {
    render(<EmptyState title="No projects yet" description="Create one" action={<button>Create</button>} />);
    expect(screen.getByText(/no projects/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument();
  });
});

describe('LoadingState', () => {
  it('renders a status message', () => {
    render(<LoadingState label="Loading" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('renders the message', () => {
    render(<ErrorState message="boom" />);
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
