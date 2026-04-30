import { render } from '@testing-library/react';
import { describe, it, expect, beforeAll } from 'vitest';
import { axe } from 'vitest-axe';
import type { AxeResults } from 'axe-core';
import * as axeMatchers from 'vitest-axe/matchers';
import { MemoryRouter } from 'react-router-dom';
import { DesignPage } from '../../pages/Design.js';

// vitest-axe v0.1.0 declares augmentations on Vi.Assertion (vitest <1.0).
// In vitest v3 the interface lives on Chai.Assertion. Declare it here.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Chai {
    interface Assertion {
      toHaveNoViolations(): void;
    }
  }
}

beforeAll(() => {
  // vitest-axe/extend-expect is a no-op in this version; wire the matcher manually.
  expect.extend(axeMatchers);
});

describe('a11y', () => {
  it('/design has no axe violations', async () => {
    const { container } = render(<MemoryRouter><DesignPage /></MemoryRouter>);
    const results: AxeResults = await axe(container, {
      // Color-contrast is evaluated against computed colors, which are
      // unavailable in happy-dom (no CSS engine). Disable to avoid false
      // positives — contrast is handled at the token level in tokens.css.
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
