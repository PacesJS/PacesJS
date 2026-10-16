import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardSourcePath } from '../src/source-guard.js';

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'paces-guard-')));
  root = join(base, 'project');
  outside = join(base, 'secret');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'src', 'a.ts'), 'export {}');
  writeFileSync(join(outside, 'key.txt'), 'secret');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('guardSourcePath', () => {
  it('allows a project-relative path', () => {
    expect(guardSourcePath(root, 'src/a.ts')).toEqual({ path: join(root, 'src', 'a.ts') });
  });

  it('allows an absolute path inside the root', () => {
    expect(guardSourcePath(root, join(root, 'src', 'a.ts'))).toEqual({
      path: join(root, 'src', 'a.ts'),
    });
  });

  it('allows a file URL inside the root', () => {
    const url = pathToFileURL(join(root, 'src', 'a.ts')).href;
    expect(guardSourcePath(root, url)).toEqual({ path: join(root, 'src', 'a.ts') });
  });

  it('reports an allowed but absent file as missing', () => {
    expect(guardSourcePath(root, 'src/nope.ts')).toBe('missing');
  });

  it.each(['../secret/key.txt', 'src/../../secret/key.txt', '..'])('refuses traversal %s', (p) => {
    expect(guardSourcePath(root, p)).toBeUndefined();
  });

  it('refuses an absolute path outside the root', () => {
    expect(guardSourcePath(root, join(outside, 'key.txt'))).toBeUndefined();
  });

  it('refuses a sibling directory that merely shares the root as a name prefix', () => {
    mkdirSync(join(base, 'project-evil'), { recursive: true });
    writeFileSync(join(base, 'project-evil', 'x.txt'), 'x');
    expect(guardSourcePath(root, join(base, 'project-evil', 'x.txt'))).toBeUndefined();
  });

  it('refuses a file URL outside the root', () => {
    expect(guardSourcePath(root, pathToFileURL(join(outside, 'key.txt')).href)).toBeUndefined();
  });

  it('refuses a NUL byte', () => {
    expect(guardSourcePath(root, 'src/a.ts\0.png')).toBeUndefined();
  });

  it('refuses a directory junction or symlink that points outside the root', () => {
    const link = join(root, 'link');
    symlinkSync(outside, link, 'junction');
    expect(guardSourcePath(root, 'link/key.txt')).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('refuses UNC, device and drive-relative paths', () => {
    expect(guardSourcePath(root, '\\\\server\\share\\x.ts')).toBeUndefined();
    expect(guardSourcePath(root, '\\\\?\\C:\\Windows\\win.ini')).toBeUndefined();
    expect(guardSourcePath(root, 'C:Windows\\win.ini')).toBeUndefined();
    expect(guardSourcePath(root, 'C:\\Windows\\win.ini')).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('compares the root case-insensitively on Windows', () => {
    expect(guardSourcePath(root, join(root, 'src', 'a.ts').toUpperCase())).toBeDefined();
  });
});
