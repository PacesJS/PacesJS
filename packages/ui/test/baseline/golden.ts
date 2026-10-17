// Golden-hash helper for the safe-refactor baseline tests. Hashes live in a JSON file next to the test;
// regenerate only with GOLDEN_WRITE=1 on unchanged code, never to make a refactor pass.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';

function plain(value: unknown): unknown {
  if (value === undefined) return { undef: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { num: String(value) };
  if (ArrayBuffer.isView(value))
    return { typed: Array.from(value as unknown as ArrayLike<number>) };
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return { map: [...value.entries()].map(plain) };
  if (value instanceof Set) return { set: [...value].map(plain) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(plain(value)))
    .digest('hex')
    .slice(0, 24);
}

export function goldenFile(url: string) {
  const write = process.env['GOLDEN_WRITE'] === '1';
  const expected: Record<string, string> = existsSync(url)
    ? (JSON.parse(readFileSync(url, 'utf8')) as Record<string, string>)
    : {};
  const actual: Record<string, string> = {};
  return {
    check(key: string, value: unknown): void {
      const got = digest(value);
      actual[key] = got;
      if (!write) expect(got, key).toBe(expected[key]);
    },
    finish(): void {
      if (write) {
        const sorted = Object.fromEntries(
          Object.entries(actual).sort(([a], [b]) => (a < b ? -1 : 1)),
        );
        writeFileSync(url, JSON.stringify(sorted, null, 1) + '\n');
      } else {
        expect(Object.keys(actual).length).toBe(Object.keys(expected).length);
      }
    },
  };
}
