import { describe, it, expect, beforeEach, vi } from 'vitest';
import { keymap } from './KeyMap.js';

beforeEach(() => { keymap._reset(); });

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}

describe('KeyMap', () => {
  it('registers and fires a single-key binding', () => {
    const fn = vi.fn();
    keymap.register({ chord: 'n', handler: fn });
    press('n');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not fire single-key bindings while typing in inputs', () => {
    const fn = vi.fn();
    keymap.register({ chord: 'n', handler: fn });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press('n');
    expect(fn).not.toHaveBeenCalled();
    input.remove();
  });

  it('fires modifier bindings even while typing', () => {
    const fn = vi.fn();
    keymap.register({ chord: 'mod+k', handler: fn });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press('k', { metaKey: true });
    expect(fn).toHaveBeenCalledOnce();
    input.remove();
  });

  it('resolves leader sequences within 1s', async () => {
    const fn = vi.fn();
    keymap.register({ chord: 'g p', handler: fn });
    press('g'); press('p');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('unregister removes the binding', () => {
    const fn = vi.fn();
    const off = keymap.register({ chord: 'n', handler: fn });
    off();
    press('n');
    expect(fn).not.toHaveBeenCalled();
  });

  it('respects when predicate', () => {
    const fn = vi.fn();
    let enabled = false;
    keymap.register({ chord: 'n', handler: fn, when: () => enabled });
    press('n');
    expect(fn).not.toHaveBeenCalled();
    enabled = true;
    press('n');
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('KeyMap — shift matching', () => {
  it('shift+tab does NOT fire on plain Tab', () => {
    const handler = vi.fn();
    keymap.register({ chord: 'shift+tab', handler });
    press('Tab', { shiftKey: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('shift+tab DOES fire on Shift+Tab', () => {
    const handler = vi.fn();
    keymap.register({ chord: 'shift+tab', handler });
    press('Tab', { shiftKey: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('plain tab binding does NOT fire on Shift+Tab', () => {
    const handler = vi.fn();
    keymap.register({ chord: 'tab', handler });
    press('Tab', { shiftKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('plain tab binding fires on plain Tab', () => {
    const handler = vi.fn();
    keymap.register({ chord: 'tab', handler });
    press('Tab', { shiftKey: false });
    expect(handler).toHaveBeenCalledOnce();
  });
});
