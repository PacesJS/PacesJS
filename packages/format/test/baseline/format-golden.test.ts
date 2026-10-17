// Characterization test for the safe-refactor run: pins the bytes written by writeSession and the exact
// manifest/session objects read back, with and without a `sources` list. Hashes live in
// format-golden.json; regenerate only with GOLDEN_WRITE=1 on unchanged code.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '@pacesjs/engine';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { captureToFiles, readManifest, readSession, writeSession } from '../../src/index.js';

const GOLDEN = new URL('./format-golden.json', import.meta.url);
const WRITE = process.env['GOLDEN_WRITE'] === '1';
const expected: Record<string, string> = existsSync(GOLDEN)
  ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>)
  : {};
const actual: Record<string, string> = {};

function plain(value: unknown): unknown {
  if (ArrayBuffer.isView(value))
    return { typed: Array.from(value as unknown as ArrayLike<number>) };
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}
const digest = (v: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(plain(v)))
    .digest('hex')
    .slice(0, 24);

function check(key: string, value: unknown): void {
  actual[key] = digest(value);
  if (!WRITE) expect(actual[key], key).toBe(expected[key]);
}

const fixture = (name: string): RawCapture =>
  JSON.parse(
    strFromU8(
      gunzipSync(
        readFileSync(
          new URL(`../../../engine/test/fixtures/${name}.capture.json.gz`, import.meta.url),
        ),
      ),
    ),
  ) as RawCapture;

/** The same zip with `sources` removed from the manifest, as an older writer produced it. */
function withoutSources(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(files['manifest.json'] ?? new Uint8Array())) as Record<
    string,
    unknown
  >;
  delete manifest['sources'];
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}

describe('format golden masters', () => {
  for (const name of ['worker-imbalance', 'eslint-cli', 'orders-server']) {
    it(`${name}: write and read`, () => {
      const capture = fixture(name);
      const sources = [
        { path: 'src\\a.js', content: strToU8('console.log(1);') },
        { path: 'src/b.js', content: strToU8('console.log(2);') },
      ];
      const plainBytes = writeSession(capture, { engineVersion: '1.2.3' });
      const rich = writeSession(capture, {
        engineVersion: '1.2.3',
        model: strToU8('model-bytes'),
        sources,
      });
      check(`${name}/files`, captureToFiles(capture, '1.2.3'));
      check(`${name}/plain-bytes`, plainBytes);
      check(`${name}/rich-bytes`, rich);
      check(`${name}/plain-manifest`, readManifest(plainBytes));
      check(`${name}/rich-manifest`, readManifest(rich));
      check(`${name}/plain-session`, readSession(plainBytes));
      check(`${name}/rich-session`, readSession(rich, { engineVersion: '1.2.3' }));
      check(`${name}/rich-session-nomodel`, readSession(rich, { engineVersion: '9.9.9' }));
      const old = withoutSources(rich);
      check(`${name}/old-manifest`, readManifest(old));
      check(`${name}/old-session`, readSession(old));
    });
  }

  it('writes or checks the hash file', () => {
    if (WRITE) {
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + '\n');
    } else {
      expect(Object.keys(actual)).toEqual(Object.keys(expected));
    }
  });
});
