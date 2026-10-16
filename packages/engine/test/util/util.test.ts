import { describe, expect, it } from 'vitest';
import { base64ToBytes, decodeDataUri, utf8Decode, utf8Encode } from '../../src/util/encoding.js';
import {
  packageNameFromPath,
  relativeToRoot,
  resolveSourcePath,
  urlToPath,
} from '../../src/util/paths.js';
import { createStringTable } from '../../src/util/strings.js';

describe('string table', () => {
  it('interns once and keeps the empty string at 0', () => {
    const t = createStringTable();
    const a = t.intern('a');
    expect(t.intern('')).toBe(0);
    expect(t.intern('a')).toBe(a);
    expect(t.strings).toEqual(['', 'a']);
  });
});

describe('encoding', () => {
  it('decodes base64 data URIs with multibyte text', () => {
    const text = '{"v":"é€😀"}';
    const bytes = utf8Encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(decodeDataUri(`data:application/json;charset=utf-8;base64,${btoa(bin)}`)).toBe(text);
  });
  it('decodes url-encoded data URIs and ignores other schemes', () => {
    expect(decodeDataUri('data:application/json,%7B%22a%22%3A1%7D')).toBe('{"a":1}');
    expect(decodeDataUri('file:///x.map')).toBeUndefined();
  });
  it('round-trips utf8', () => {
    expect(utf8Decode(utf8Encode('héllo €😀'))).toBe('héllo €😀');
    expect(base64ToBytes('AQID')).toEqual(Uint8Array.of(1, 2, 3));
  });
});

describe('paths', () => {
  it('converts file URLs to forward-slash paths', () => {
    expect(urlToPath('file:///C:/Users/me/app.js')).toBe('C:/Users/me/app.js');
    expect(urlToPath('file:///project/a%20b.js')).toBe('/project/a b.js');
    expect(urlToPath('node:fs')).toBe('node:fs');
  });
  it('makes paths project relative, case-insensitively on drive letters', () => {
    expect(relativeToRoot('C:/Users/me/app/src/a.ts', 'c:\\Users\\me\\app')).toBe('src/a.ts');
    expect(relativeToRoot('/other/a.ts', '/project')).toBe('/other/a.ts');
  });
  it.each([
    ['/p/node_modules/ajv/lib/a.js', 'ajv'],
    ['/p/node_modules/@scope/pkg/dist/a.js', '@scope/pkg'],
    ['/p/node_modules/.pnpm/rxjs@7.8.2/node_modules/rxjs/dist/cjs/a.js', 'rxjs'],
    ['/p/src/a.js', ''],
  ])('finds the npm package of %s', (path, pkg) => {
    expect(packageNameFromPath(path)).toBe(pkg);
  });
  it('resolves source map sources against the script and webpack roots', () => {
    expect(resolveSourcePath('../src/a.ts', '', 'file:///p/dist/server.js')).toBe('/p/src/a.ts');
    expect(resolveSourcePath('./src/b.ts', '', 'file:///p/dist/x.js')).toBe('/p/dist/src/b.ts');
    expect(resolveSourcePath('webpack://app/./node_modules/ajv/x.js', '', 'file:///p/d.js')).toBe(
      'node_modules/ajv/x.js',
    );
  });
});
