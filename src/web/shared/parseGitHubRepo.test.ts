import { describe, it, expect } from 'vitest';
import { parseGitHubRepo } from './parseGitHubRepo.js';

describe('parseGitHubRepo', () => {
  it('parses SSH URL', () => {
    expect(parseGitHubRepo('git@github.com:me/foo.git')).toBe('me/foo');
    expect(parseGitHubRepo('git@github.com:me/foo')).toBe('me/foo');
  });
  it('parses HTTPS URL', () => {
    expect(parseGitHubRepo('https://github.com/me/foo.git')).toBe('me/foo');
    expect(parseGitHubRepo('https://github.com/me/foo')).toBe('me/foo');
  });
  it('returns null for non-github URLs', () => {
    expect(parseGitHubRepo('git@gitlab.com:me/foo.git')).toBeNull();
    expect(parseGitHubRepo('https://bitbucket.org/me/foo')).toBeNull();
    expect(parseGitHubRepo('')).toBeNull();
    expect(parseGitHubRepo('nonsense')).toBeNull();
  });
});
