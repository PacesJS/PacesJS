import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourceResolver, pathKey } from '../src/source-resolver.js';
import type { SourceResolver } from '../src/source-resolver.js';

let base: string;
let root: string;
let global: string;
let secret: string;
let resolver: SourceResolver;

const url = (p: string) => pathToFileURL(p).href;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'paces-resolver-')));
  root = join(base, 'project');
  global = join(base, 'global-npm', 'lib');
  secret = join(base, 'secret');
  for (const d of [join(root, 'src'), join(root, 'dist'), global, secret]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(global, 'tool.js'), 'module.exports = 1;\n');
  writeFileSync(join(global, 'not-loaded.js'), 'nope');
  writeFileSync(join(secret, 'key.txt'), 'secret');
  const map = JSON.stringify({
    version: 3,
    sources: ['../src/uri.ts', '../src/no-content.ts'],
    sourcesContent: ['export const uri = 1;\n', null],
  });
  resolver = createSourceResolver({
    projectRoot: root,
    scriptUrls: [url(join(global, 'tool.js')), url(join(root, 'dist', 'bundle.js')), 'node:fs', ''],
    sourceMaps: { [url(join(root, 'dist', 'bundle.js'))]: map },
    embedded: new Map([['src/copy.ts', new TextEncoder().encode('copied')]]),
    startedAt: Date.now() - 60_000,
  });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('pathKey', () => {
  it.each([
    ['C:/Users/x/a.js', 'c:/users/x/a.js'],
    ['C:\\Users\\x\\a.js', 'c:/users/x/a.js'],
    ['/C:/Users/x/a.js', 'c:/users/x/a.js'],
    ['file:///C:/Users/x/a%20b.js', 'c:/users/x/a b.js'],
    ['/Users/x/a.js', '/Users/x/a.js'],
    ['/a/b/../c.js', '/a/c.js'],
  ])('normalizes %s', (input, expected) => {
    expect(pathKey(input)).toBe(expected);
  });
});

describe('source resolver', () => {
  it('serves a file inside the project from disk', () => {
    expect(resolver.resolve('src/a.ts')).toMatchObject({
      status: 'ok',
      origin: 'disk',
      exists: true,
      text: 'export const a = 1;\n',
    });
  });

  it('serves a file outside the project that the profiled process loaded', () => {
    expect(resolver.resolve(join(global, 'tool.js'))).toMatchObject({ status: 'ok', exists: true });
  });

  it('accepts the loaded file as a file URL and with forward slashes', () => {
    expect(resolver.resolve(url(join(global, 'tool.js'))).exists).toBe(true);
    expect(resolver.resolve(join(global, 'tool.js').replaceAll('\\', '/')).exists).toBe(true);
  });

  it('ignores a cache-busting query on a loaded file name', () => {
    expect(resolver.resolve(`${join(global, 'tool.js')}?mtime=123`).exists).toBe(true);
  });

  it('refuses an outside file the process did not load, even next to a loaded one', () => {
    expect(resolver.resolve(join(global, 'not-loaded.js'))).toMatchObject({
      status: 'outside-root',
      exists: false,
      text: '',
    });
  });

  it('cannot be tricked with .. out of an allowlisted directory', () => {
    const sneaky = `${join(global, 'tool.js')}/../../../secret/key.txt`;
    expect(resolver.resolve(sneaky).text).toBe('');
    expect(resolver.resolve(join(global, '..', '..', 'secret', 'key.txt')).text).toBe('');
  });

  it('refuses traversal out of the project', () => {
    expect(resolver.resolve('../secret/key.txt').text).toBe('');
    expect(resolver.resolve('src/../../secret/key.txt').status).toBe('outside-root');
  });

  it('does not let a script URL that merely resembles a path unlock other files', () => {
    expect(resolver.resolve(join(base, 'global-npm')).exists).toBe(false);
    expect(resolver.resolve(`${join(global, 'tool.js')}x`).exists).toBe(false);
  });

  it('refuses a directory junction inside the project that leads outside', () => {
    symlinkSync(secret, join(root, 'link'), 'junction');
    expect(resolver.resolve('link/key.txt').text).toBe('');
  });

  it.runIf(process.platform === 'win32')('refuses UNC, device and drive-relative forms', () => {
    for (const p of [
      '\\\\server\\share\\x.js',
      '\\\\?\\C:\\Windows\\win.ini',
      'C:Windows\\win.ini',
    ]) {
      expect(resolver.resolve(p).text).toBe('');
    }
  });

  it('serves original code from the source map when it is not on disk', () => {
    expect(resolver.resolve('src/uri.ts')).toMatchObject({
      status: 'ok',
      origin: 'embedded',
      exists: true,
      text: 'export const uri = 1;\n',
      changedSinceProfile: false,
    });
  });

  it('finds embedded code by absolute path in either slash style', () => {
    const abs = join(root, 'src', 'uri.ts');
    expect(resolver.resolve(abs).origin).toBe('embedded');
    expect(resolver.resolve(abs.replaceAll('\\', '/')).origin).toBe('embedded');
  });

  it('says so when the map names the file but embeds no content', () => {
    const r = resolver.resolve('src/no-content.ts');
    expect(r).toMatchObject({ status: 'no-embedded-source', exists: false });
    expect(r.hint).toContain('--embed-sources');
  });

  it('serves a --embed-sources copy of a file that is gone', () => {
    expect(resolver.resolve('src/copy.ts')).toMatchObject({ origin: 'embedded', text: 'copied' });
  });

  it('prefers the disk file and flags it when it differs from the embedded original', () => {
    writeFileSync(join(root, 'src', 'uri.ts'), 'export const uri = 2;\n');
    expect(resolver.resolve('src/uri.ts')).toMatchObject({
      origin: 'disk',
      changedSinceProfile: true,
      text: 'export const uri = 2;\n',
    });
  });

  it('answers Node internals and empty names without touching the disk', () => {
    expect(resolver.resolve('node:internal/modules/cjs/loader').status).toBe('missing');
    expect(resolver.resolve('').status).toBe('missing');
  });

  it('returns a disk path for the editor only for readable allowed files', () => {
    expect(resolver.diskPath('src/a.ts')).toBe(join(root, 'src', 'a.ts'));
    expect(resolver.diskPath(join(global, 'tool.js'))).toBe(join(global, 'tool.js'));
    expect(resolver.diskPath(join(secret, 'key.txt'))).toBeUndefined();
  });
});
