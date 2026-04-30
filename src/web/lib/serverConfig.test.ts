import { describe, it, expect, vi } from 'vitest';

// Mock the tauri api — simulate non-Tauri environment (invoke not available)
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

describe('serverConfig (non-Tauri env)', () => {
  it('getServerUrl returns empty string when not in Tauri', async () => {
    const { getServerUrl } = await import('./serverConfig.js');
    expect(await getServerUrl()).toBe('');
  });

  it('setServerUrl is a no-op when not in Tauri', async () => {
    const { setServerUrl } = await import('./serverConfig.js');
    await expect(setServerUrl('http://foo:3000')).resolves.toBeUndefined();
  });
});
