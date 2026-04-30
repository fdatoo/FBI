import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLastRunGlobal,
  setLastRunGlobal,
  getLastRunForProject,
  setLastRunForProject,
} from './lastRun.js';

beforeEach(() => {
  localStorage.clear();
});

describe('getLastRunGlobal', () => {
  it('returns null when nothing saved', () => {
    expect(getLastRunGlobal()).toBeNull();
  });

  it('round-trips a run id', () => {
    setLastRunGlobal(42);
    expect(getLastRunGlobal()).toBe(42);
  });

  it('clears when set to null', () => {
    setLastRunGlobal(7);
    setLastRunGlobal(null);
    expect(getLastRunGlobal()).toBeNull();
  });

  it('returns null for invalid stored value', () => {
    localStorage.setItem('fbi-last-run-id', 'not-a-number');
    expect(getLastRunGlobal()).toBeNull();
  });

  it('returns null for NaN stored value', () => {
    localStorage.setItem('fbi-last-run-id', 'Infinity');
    expect(getLastRunGlobal()).toBeNull();
  });
});

describe('getLastRunForProject', () => {
  it('returns null when nothing saved for that project', () => {
    expect(getLastRunForProject(1)).toBeNull();
  });

  it('round-trips a run id per project', () => {
    setLastRunForProject(1, 100);
    setLastRunForProject(2, 200);
    expect(getLastRunForProject(1)).toBe(100);
    expect(getLastRunForProject(2)).toBe(200);
  });

  it('clears per-project when set to null', () => {
    setLastRunForProject(5, 99);
    setLastRunForProject(5, null);
    expect(getLastRunForProject(5)).toBeNull();
  });

  it('returns null for invalid stored value', () => {
    localStorage.setItem('fbi-last-run-id:project:3', 'nan');
    expect(getLastRunForProject(3)).toBeNull();
  });

  it('does not affect global key', () => {
    setLastRunGlobal(1);
    setLastRunForProject(1, 2);
    expect(getLastRunGlobal()).toBe(1);
  });
});
