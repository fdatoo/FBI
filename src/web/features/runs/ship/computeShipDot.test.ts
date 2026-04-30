import { describe, it, expect } from 'vitest';
import { computeShipDot } from './computeShipDot.js';
import type { ChangesPayload } from '@shared/types.js';

const base: ChangesPayload = {
  branch_name: 'feat/x',
  branch_base: { base: 'main', ahead: 0, behind: 0 },
  commits: [], uncommitted: [], dirty_submodules: [], children: [],
  integrations: {},
};

describe('computeShipDot', () => {
  it('no dot on a clean, up-to-date payload', () => {
    expect(computeShipDot(base)).toBe(null);
  });
  it('amber when behind > 0', () => {
    expect(computeShipDot({ ...base, branch_base: { base: 'main', ahead: 0, behind: 3 } })).toBe('amber');
  });
  it('accent when ahead > 0 and no PR', () => {
    expect(computeShipDot({ ...base, branch_base: { base: 'main', ahead: 2, behind: 0 } })).toBe('accent');
  });
  it('accent when ahead > 0 and PR open + CI passing', () => {
    expect(computeShipDot({
      ...base,
      branch_base: { base: 'main', ahead: 2, behind: 0 },
      integrations: { github: {
        pr: { number: 1, url: '#', state: 'OPEN', title: 't' },
        checks: { state: 'success', passed: 1, failed: 0, total: 1, items: [] },
      } },
    })).toBe('accent');
  });
  it('no dot when PR merged', () => {
    expect(computeShipDot({
      ...base,
      branch_base: { base: 'main', ahead: 2, behind: 0 },
      integrations: { github: {
        pr: { number: 1, url: '#', state: 'MERGED', title: 't' },
        checks: null,
      } },
    })).toBe(null);
  });
  it('amber trumps accent when both apply', () => {
    expect(computeShipDot({
      ...base,
      branch_base: { base: 'main', ahead: 2, behind: 3 },
    })).toBe('amber');
  });
  it('no dot when CI failing', () => {
    expect(computeShipDot({
      ...base,
      branch_base: { base: 'main', ahead: 2, behind: 0 },
      integrations: { github: {
        pr: { number: 1, url: '#', state: 'OPEN', title: 't' },
        checks: { state: 'failure', passed: 1, failed: 1, total: 2, items: [] },
      } },
    })).toBe(null);
  });
});
