import { describe, expect, it } from 'vitest';
import { formatMinified, looksMinified } from '../../src/view/format-minified';

const SRC = 'function f(a){var b=a+1;return b}function g(){h("x;{y}")}';

describe('looksMinified', () => {
  it('is true for a bundle of very long lines', () => {
    expect(looksMinified(['var a=1;'.repeat(400)])).toBe(true);
  });

  it('is false for ordinary source', () => {
    expect(looksMinified(['function a() {', '  return 1;', '}'])).toBe(false);
  });
});

describe('formatMinified', () => {
  it('lays a one-line bundle out over many lines', async () => {
    const f = await formatMinified(SRC);
    expect(f?.lines.length).toBeGreaterThan(5);
  });

  it('only changes whitespace', async () => {
    const f = await formatMinified(SRC);
    expect(f?.lines.join('').replace(/\s+/g, '')).toBe(SRC.replace(/\s+/g, ''));
  });

  it('gives up, rather than throw, on text the library cannot handle', async () => {
    await expect(formatMinified('}}}{{{(((')).resolves.not.toThrow();
  });
});

describe('the position map', () => {
  const at = (needle: string) => SRC.indexOf(needle);

  it('finds the formatted line that holds a position of the original text', async () => {
    const f = await formatMinified(SRC);
    for (const needle of ['var b', 'return b', 'function g', 'h("x']) {
      const line = f?.lineOf(1, at(needle)) ?? 0;
      expect(f?.lines[line - 1]).toContain(needle.trim().split(' ')[0]);
    }
  });

  it('counts lines and columns from the original text, one-based lines', async () => {
    const f = await formatMinified('a();\nb();c();');
    const line = f?.lineOf(2, 4) ?? 0;
    expect(f?.lines[line - 1]).toContain('c()');
  });

  it('puts a position past the end on the last line', async () => {
    const f = await formatMinified('a();b();');
    expect(f?.lineOf(9, 0)).toBe(f?.lines.length);
  });
});
