import { describe, expect, it } from 'vitest';
import { functionEnd, gutterWidth, lineWindow, tokenize } from '../../src/view/source-lines';

const src = [
  'const cache = new Map();',
  '',
  'export function loadTemplate(name) {',
  "  const file = path.join(DIR, name + '.hbs');",
  '  if (cache.has(file)) {',
  '    return cache.get(file);',
  '  }',
  "  return fs.readFileSync(file, 'utf8');",
  '}',
  '',
  'export const DEV = true;',
];

describe('source lines', () => {
  it('finds the end of a function by matching braces, ignoring braces in strings', () => {
    expect(functionEnd(src, 3)).toBe(9);
    expect(functionEnd(["const a = '}';", 'function f() {', '}'], 2)).toBe(3);
  });

  it('shows two lines of context around the function', () => {
    expect(lineWindow(src, 3)).toEqual({ first: 1, last: 11 });
  });

  it('classifies keywords, strings and calls', () => {
    const t = tokenize("const raw = fs.readFileSync(file, 'utf8');");
    expect(t.filter((x) => x.kind !== 'plain').map((x) => [x.text, x.kind])).toEqual([
      ['const', 'keyword'],
      ['readFileSync', 'fn'],
      ["'utf8'", 'string'],
    ]);
  });

  it('draws a gutter bar of at least 3 px for any line with self time', () => {
    expect(gutterWidth(5.8, 5.8)).toBe(52);
    expect(gutterWidth(0.01, 5.8)).toBe(3);
    expect(gutterWidth(0, 5.8)).toBe(0);
  });
});
