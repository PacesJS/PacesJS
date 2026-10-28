import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('which with a path instead of a name', () => {
  it('accepts a path that exists as it is', () => {
    expect(which('/opt/bin/tool', {}, 'linux', (p) => p === '/opt/bin/tool')).toBe('/opt/bin/tool');
  });

  it('tries the PATHEXT-less path on Windows, and gives up when nothing exists', () => {
    expect(which(String.raw`C:\tools\a.exe`, {}, 'win32', () => false)).toBe(undefined);
    const rel = String.raw`.\bin\a.exe`;
    expect(which(rel, {}, 'win32', (p) => p === rel)).toBe(rel);
  });
});

describe('which on the real file system', () => {
  it('finds a file by its full path and not a directory or a missing path', () => {
    const here = fileURLToPath(import.meta.url);
    expect(which(here)).toBe(here);
    expect(which(dirname(here))).toBe(undefined);
    expect(which(join(dirname(here), 'no-such-file'))).toBe(undefined);
  });
});
