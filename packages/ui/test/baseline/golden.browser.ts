// Golden-hash helper for tests that run in the browser, where there is no file system. The hashes
// live in a JSON file imported by the test; GOLDEN_WRITE=1 re-records them through a server command.
// Regenerate only on unchanged code, never to make a refactor pass. See golden.ts.
import { commands } from 'vitest/browser';
import { expect } from 'vitest';
import { plain } from './golden-plain';

/** A fast 96-bit string hash (not cryptographic: a golden only has to notice a change). */
export function digest(value: unknown): string {
  const text = JSON.stringify(plain(value));
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let h3 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
    h3 = Math.imul(h3 ^ c, 2246822519);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2) + hex(h3);
}

// Asked of the server: a browser test cannot see the environment of the run.
const write = await commands.goldenWrite();

export function goldenFile(name: string, expected: Record<string, string>) {
  const actual: Record<string, string> = {};
  return {
    check(key: string, value: unknown): void {
      const got = digest(value);
      actual[key] = got;
      if (!write) expect(got, key).toBe(expected[key]);
    },
    async finish(): Promise<void> {
      if (write) {
        const sorted = Object.fromEntries(
          Object.entries(actual).sort(([a], [b]) => (a < b ? -1 : 1)),
        );
        await commands.writeGolden(name, JSON.stringify(sorted, null, 1) + String.fromCharCode(10));
      } else {
        expect(Object.keys(actual).length).toBe(Object.keys(expected).length);
      }
    },
  };
}
