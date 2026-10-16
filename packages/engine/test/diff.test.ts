import { SourceMapGenerator } from 'source-map-js';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { diffModels, functionKey } from '../src/diff.js';
import { loadModel } from './helpers/fixtures.js';
import { synthCapture } from './helpers/synth.js';

function bundled(genLine: number, genCol: number, samples: number, other: number) {
  const url = 'file:///project/dist/bundle.js';
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  gen.addMapping({
    generated: { line: genLine + 1, column: genCol },
    original: { line: 12, column: 4 },
    source: '../src/real.ts',
    name: 'compute',
  });
  return analyze(
    synthCapture(
      [
        { stack: [{ name: 'a', url, line: genLine, col: genCol }], samples },
        { stack: ['filler'], samples: other },
      ],
      { sourceMaps: { [url]: gen.toString() } },
    ),
  );
}

describe('differential mode', () => {
  it('matches a function by original path, name and line, not by minified position', () => {
    const base = bundled(0, 9, 10, 10);
    const head = bundled(7, 120, 30, 10);
    const diff = diffModels(base, head);
    const compute = diff.functions.find((f) => f.name === 'compute');
    expect(compute?.key).toBe('src/real.ts|compute|12');
    expect(compute?.baseFn).toBeGreaterThanOrEqual(0);
    expect(compute?.headFn).toBeGreaterThanOrEqual(0);
    expect(compute?.baseSelfUs).toBe(10_000);
    expect(compute?.headSelfUs).toBe(30_000);
    expect(compute?.selfShareDelta).toBeCloseTo(0.75 - 0.5, 6);
  });

  it('marks head functions slower, faster, unchanged or new', () => {
    const base = analyze(
      synthCapture([
        { stack: ['slow'], samples: 10 },
        { stack: ['fast'], samples: 50 },
        { stack: ['same'], samples: 40 },
      ]),
    );
    const head = analyze(
      synthCapture([
        { stack: ['slow'], samples: 50 },
        { stack: ['fast'], samples: 10 },
        { stack: ['same'], samples: 40 },
        { stack: ['fresh'], samples: 20 },
      ]),
    );
    const diff = diffModels(base, head);
    const change = (name: string) => {
      const fn = diff.functions.find((f) => f.name === name)?.headFn ?? -1;
      return diff.headChange[fn];
    };
    expect(change('slow')).toBe(1);
    expect(change('fast')).toBe(-1);
    expect(change('fresh')).toBe(2);
    expect(diff.functions.find((f) => f.name === 'fresh')?.baseFn).toBe(-1);
    expect(diff.baseBusyUs).toBe(100_000);
    expect(diff.headBusyUs).toBe(120_000);
  });

  it('reports functions that disappeared with no head function id', () => {
    const base = analyze(synthCapture([{ stack: ['gone'], samples: 5 }]));
    const head = analyze(synthCapture([{ stack: ['kept'], samples: 5 }]));
    const gone = diffModels(base, head).functions.find((f) => f.name === 'gone');
    expect(gone?.headFn).toBe(-1);
    expect(gone?.selfShareDelta).toBeLessThan(0);
  });

  it('finds no change when a real session is compared with itself', () => {
    const m = loadModel('orders-server');
    const diff = diffModels(m, m);
    expect(diff.functions.every((f) => f.selfShareDelta === 0)).toBe(true);
    expect(diff.headChange.every((c) => c === 0)).toBe(true);
  });

  it('keys real functions by project-relative original path', () => {
    const m = loadModel('orders-server');
    const fn = Array.from({ length: m.functions.length }, (_, i) => i).find(
      (i) => m.strings[m.functions.name[i] ?? 0] === 'lineTotal',
    );
    expect(functionKey(m, fn ?? 0)).toBe('zoo/orders-server/src/util/money.ts|lineTotal|6');
  });

  it('orders the largest changes first, deterministically', () => {
    const a = diffModels(loadModel('sync-io'), loadModel('hot-regex'));
    const b = diffModels(loadModel('sync-io'), loadModel('hot-regex'));
    expect(a.functions.map((f) => f.key)).toEqual(b.functions.map((f) => f.key));
    const deltas = a.functions.map((f) => Math.abs(f.selfShareDelta));
    expect(deltas).toEqual([...deltas].sort((x, y) => y - x));
  });
});
