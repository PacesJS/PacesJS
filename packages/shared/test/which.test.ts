import { describe, expect, it } from 'vitest';
import { which } from '../src/which.js';

describe('which', () => {
  it('finds an executable on PATH on POSIX', () => {
    const found = which('node', { PATH: '/a:/b' }, 'linux', (p) => p === '/b/node');
    expect(found).toBe('/b/node');
  });

  it('honors PATHEXT on Windows and reads the Path key case-insensitively', () => {
    const found = which(
      'code',
      { Path: 'C:\\x', PATHEXT: '.EXE;.CMD' },
      'win32',
      (p) => p === 'C:\\x\\code.CMD',
    );
    expect(found).toBe('C:\\x\\code.CMD');
  });

  it('returns undefined when nothing matches', () => {
    expect(which('nope', { PATH: '/a' }, 'linux', () => false)).toBe(undefined);
  });
});
