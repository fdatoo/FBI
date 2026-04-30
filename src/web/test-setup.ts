import '@testing-library/jest-dom/vitest';

// happy-dom aborts in-flight fetches on environment teardown and logs the
// resulting DOMException to stderr. Suppress it — it's not a test failure.
const _origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('AbortError')) return;
  _origError(...args);
};

// happy-dom v20 exposes a broken localStorage (methods are not functions).
// Replace it with a plain in-memory implementation.
const makeStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear:      () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key:        (i: number) => Object.keys(store)[i] ?? null,
  };
};

Object.defineProperty(globalThis, 'localStorage',  { value: makeStorage(), writable: true, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: makeStorage(), writable: true, configurable: true });
