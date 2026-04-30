import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Card } from './Card.js';
import { Section } from './Section.js';

describe('Card', () => {
  it('renders children inside a styled container', () => {
    render(<Card><p>inside</p></Card>);
    expect(screen.getByText('inside')).toBeInTheDocument();
  });

  it('flat variant skips the surface bg', () => {
    render(<Card variant="flat" data-testid="c"><span>x</span></Card>);
    expect(screen.getByTestId('c').className).not.toContain('bg-surface');
  });
});

describe('Section', () => {
  it('renders title and children', () => {
    render(<Section title="Runs"><div>content</div></Section>);
    expect(screen.getByText('Runs')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
