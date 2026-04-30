import { describe, it, expect, beforeEach } from 'vitest';
import { setApiBaseUrl, wsBase } from './api.js';

describe('api base URL', () => {
  beforeEach(() => setApiBaseUrl(''));

  it('wsBase defaults to location-derived URL when no base URL set', () => {
    setApiBaseUrl('');
    // happy-dom sets location.protocol to 'about:' which falls back to ws:
    const url = wsBase();
    expect(url).toMatch(/^wss?:\/\//);
  });

  it('wsBase converts http:// server URL to ws://', () => {
    setApiBaseUrl('http://fbi.tailnet:3000');
    expect(wsBase()).toBe('ws://fbi.tailnet:3000');
  });

  it('wsBase converts https:// server URL to wss://', () => {
    setApiBaseUrl('https://fbi.tailnet');
    expect(wsBase()).toBe('wss://fbi.tailnet');
  });

  it('setApiBaseUrl strips trailing slash', () => {
    setApiBaseUrl('http://fbi.tailnet:3000/');
    expect(wsBase()).toBe('ws://fbi.tailnet:3000');
  });
});
