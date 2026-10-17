import { describe, expect, it } from 'vitest';
import {
  gutterTitle,
  isLowConfidence,
  rollUpToStatements,
  sampleLabel,
} from '../../src/view/source-lines';

const text = (src: string): string[] => src.split('\n');

describe('rollUpToStatements: time on a continuation line belongs to its statement', () => {
  it('moves a tick inside a multi-line call to the first line of the call', () => {
    // The owner's case: V8 put one sample on `signal: controller?.signal,` inside fsp.readFile(...).
    const lines = text(
      [
        'async function readAndVerifyFile() {', // 1
        '  const readFileEnterTime = hrtimeBigint();', // 2
        '  const text = await fsp.readFile(filePath, {', // 3
        '    encoding: "utf8",', // 4
        '    signal: controller?.signal,', // 5
        '  });', // 6
        '  const readFileExitTime = hrtimeBigint();', // 7
        '}', // 8
      ].join('\n'),
    );
    const out = rollUpToStatements(lines, [{ line: 5, selfUs: 1500 }], 1);
    expect(out).toEqual([{ line: 3, selfUs: 1500, from: [5] }]);
  });

  it('leaves a tick on a single-line statement where it is', () => {
    const lines = text(['function f() {', '  const a = g();', '  return a;', '}'].join('\n'));
    expect(rollUpToStatements(lines, [{ line: 2, selfUs: 900 }], 1)).toEqual([
      { line: 2, selfUs: 900, from: [] },
    ]);
  });

  it('handles a chained call with arguments on later lines', () => {
    const lines = text(
      [
        'function f() {',
        '  return foo',
        '    .bar(',
        '      x,',
        '      y)',
        '    .baz();',
        '}',
      ].join('\n'),
    );
    const out = rollUpToStatements(lines, [{ line: 4, selfUs: 400 }], 1);
    expect(out).toEqual([{ line: 3, selfUs: 400, from: [4] }]);
  });

  it('does not roll statements inside a callback body up to the call that holds the callback', () => {
    const lines = text(
      [
        'function f() {', // 1
        '  items.forEach((item) => {', // 2
        '    total += item.n;', // 3
        '  });', // 4
        '}', // 5
      ].join('\n'),
    );
    expect(rollUpToStatements(lines, [{ line: 3, selfUs: 700 }], 1)).toEqual([
      { line: 3, selfUs: 700, from: [] },
    ]);
  });

  it('does not roll statements inside an if or loop block up to its header', () => {
    const lines = text(
      [
        'function f() {',
        '  if (a) {',
        '    work();',
        '  }',
        '  for (;;) {',
        '    more();',
        '  }',
        '}',
      ].join('\n'),
    );
    const out = rollUpToStatements(
      lines,
      [
        { line: 3, selfUs: 100 },
        { line: 6, selfUs: 200 },
      ],
      1,
    );
    expect(out.map((o) => o.line)).toEqual([3, 6]);
  });

  it('adds up several ticks that belong to one statement and remembers where V8 put them', () => {
    const lines = text(['function f() {', '  call(a,', '    b,', '    c);', '}'].join('\n'));
    const out = rollUpToStatements(
      lines,
      [
        { line: 3, selfUs: 1000 },
        { line: 4, selfUs: 500 },
        { line: 2, selfUs: 250 },
      ],
      1,
    );
    expect(out).toEqual([{ line: 2, selfUs: 1750, from: [3, 4] }]);
  });

  it('ignores brackets inside strings, template literals and comments', () => {
    const lines = text(
      [
        'function f() {', // 1
        '  const s = "(";', // 2
        '  const t = `{`; // ) }', // 3
        '  work();', // 4
        '}', // 5
      ].join('\n'),
    );
    expect(rollUpToStatements(lines, [{ line: 4, selfUs: 300 }], 1)).toEqual([
      { line: 4, selfUs: 300, from: [] },
    ]);
  });

  it('never rolls a tick far away: broken bracket balance must not swallow the file', () => {
    const body = Array.from({ length: 60 }, (_, i) => `  x${i};`);
    const lines = text(['function f() {', '  call(', ...body, '}'].join('\n'));
    const out = rollUpToStatements(lines, [{ line: 50, selfUs: 100 }], 1);
    expect(out[0]?.line).toBeGreaterThanOrEqual(50 - 25);
  });

  it('returns ticks sorted by line', () => {
    const lines = text(['function f() {', '  a();', '  b(', '    c);', '}'].join('\n'));
    const out = rollUpToStatements(
      lines,
      [
        { line: 4, selfUs: 1 },
        { line: 2, selfUs: 1 },
      ],
      1,
    );
    expect(out.map((o) => o.line)).toEqual([2, 3]);
  });
});

describe('confidence of a line time', () => {
  const precision = 1600; // µs, one measured sample gap

  it('treats under two sampling intervals as low confidence', () => {
    expect(isLowConfidence(1500, precision)).toBe(true);
    expect(isLowConfidence(3100, precision)).toBe(true);
    expect(isLowConfidence(3200, precision)).toBe(false);
    expect(isLowConfidence(40_000, precision)).toBe(false);
  });

  it('is never low confidence without a known precision', () => {
    expect(isLowConfidence(10, 0)).toBe(false);
  });

  it('counts samples, at least one', () => {
    expect(sampleLabel(1500, precision)).toBe('1 sample');
    expect(sampleLabel(100, precision)).toBe('1 sample');
    expect(sampleLabel(3300, precision)).toBe('2 samples');
  });

  it('explains a faint bar and where V8 put rolled-up time', () => {
    const tip = gutterTitle(1500, precision, [1308]);
    expect(tip).toMatch(/1 sample/);
    expect(tip).toMatch(/approximate/);
    expect(tip).toContain('1308');
    expect(gutterTitle(50_000, precision, [])).toBe('');
    expect(gutterTitle(0, precision, [])).toBe('');
  });
});
