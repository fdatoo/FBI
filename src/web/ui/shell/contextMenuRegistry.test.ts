import { describe, it, expect, beforeEach } from 'vitest';
import { contextMenuRegistry } from './contextMenuRegistry.js';

describe('contextMenuRegistry', () => {
  beforeEach(() => { contextMenuRegistry._reset(); });

  it('returns empty array for unregistered context ID', () => {
    const el = document.createElement('div');
    expect(contextMenuRegistry.resolve('unknown', el)).toEqual([]);
  });

  it('returns items from a registered factory', () => {
    const el = document.createElement('div');
    el.dataset.contextRunId = '42';
    contextMenuRegistry.register('run-row', (_target) => [
      { id: 'copy-id', label: 'Copy run ID', onSelect: () => {} },
    ]);
    const items = contextMenuRegistry.resolve('run-row', el);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Copy run ID');
  });

  it('unregisters on cleanup', () => {
    const el = document.createElement('div');
    const off = contextMenuRegistry.register('run-row', () => [
      { id: 'x', label: 'X', onSelect: () => {} },
    ]);
    off();
    expect(contextMenuRegistry.resolve('run-row', el)).toEqual([]);
  });
});
