import { describe, it, expect } from 'vitest';
import { detectPlatform } from './detectPlatform.js';

describe('detectPlatform', () => {
  it('detects macOS arm64 from UAData platform+architecture', () => {
    expect(detectPlatform({ platform: 'macOS', architecture: 'arm' })).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  it('detects macOS amd64 from UAData platform+architecture', () => {
    expect(detectPlatform({ platform: 'macOS', architecture: 'x86' })).toEqual({ os: 'darwin', arch: 'amd64' });
  });

  it('detects Linux amd64 from UAData', () => {
    expect(detectPlatform({ platform: 'Linux', architecture: 'x86' })).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it('detects Linux arm64 from UAData', () => {
    expect(detectPlatform({ platform: 'Linux', architecture: 'arm' })).toEqual({ os: 'linux', arch: 'arm64' });
  });

  it('falls back to darwin/arm64 for an empty UAData platform', () => {
    expect(detectPlatform({ platform: '', architecture: '' })).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  it('parses macOS arm64 from a modern Safari UA string', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15';
    // Safari still reports "Intel Mac OS X" on Apple Silicon; treat bare macOS UA as arm64 per fallback.
    expect(detectPlatform(ua)).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  it('parses Linux x86_64 from a UA string', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';
    expect(detectPlatform(ua)).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it('parses Linux aarch64 from a UA string', () => {
    const ua = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36';
    expect(detectPlatform(ua)).toEqual({ os: 'linux', arch: 'arm64' });
  });

  it('falls back to darwin/arm64 when given an undefined input', () => {
    expect(detectPlatform(undefined)).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  it('falls back to darwin/arm64 for an unknown UA string', () => {
    expect(detectPlatform('Mozilla/5.0 (ZX Spectrum; Z80)')).toEqual({ os: 'darwin', arch: 'arm64' });
  });
});
