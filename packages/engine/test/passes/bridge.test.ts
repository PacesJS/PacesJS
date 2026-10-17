import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { Origin } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { loadCapture } from '../helpers/capture.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

const GC = '(garbage collector)';
const PROGRAM = '(program)';
const argv = ['node', '/project/src/app.js'];

const nameOf = (m: ExecutionModel, fn: number) => m.strings[m.functions.name[fn] ?? 0];
/** `parent > child` pairs of the track's own call tree. */
const edges = (m: ExecutionModel, track = 0): string[] => {
  const t = m.tracks[track]?.callTree;
  const out: string[] = [];
  for (let n = 1; (t?.length ?? 0) > n; n++) {
    out.push(`${nameOf(m, t?.fn[t.parent[n] ?? 0] ?? 0)} > ${nameOf(m, t?.fn[n] ?? 0)}`);
  }
  return out;
};
const selfOfOrigin = (m: ExecutionModel, origin: number): number => {
  const t = m.tracks[0]?.callTree;
  let sum = 0;
  for (let n = 1; (t?.length ?? 0) > n; n++) {
    if (m.functions.origin[t?.fn[n] ?? 0] === origin) sum += t?.self[n] ?? 0;
  }
  return sum;
};

describe('bridging (program) and garbage collector samples', () => {
  const across = (frame: string): Step[] => [
    { stack: ['a', 'b'], samples: 3 },
    { stack: [frame], samples: 1 },
    { stack: ['a', 'b'], samples: 3 },
  ];

  it.each([GC, PROGRAM])('nests %s under the call it interrupted', (frame) => {
    const m = analyze(synthCapture(across(frame), { argv }));
    expect(edges(m)).toContain(`b > ${frame}`);
    expect(edges(m)).not.toContain(`(root) > ${frame}`);
  });

  it('keeps the interrupted call as one span with the pause as its child', () => {
    const m = analyze(synthCapture(across(PROGRAM), { argv }));
    const t = m.tracks[0];
    const names = Array.from(t?.spans.fn ?? [], (f) => nameOf(m, f));
    expect(names).toEqual(['a', 'b', PROGRAM]);
  });

  it('keeps the time: only the parent of those samples changes', () => {
    const on = analyze(synthCapture(across(PROGRAM), { argv }));
    const off = analyze(synthCapture(across(PROGRAM), { argv }), { bridgeRuntimeSamples: false });
    expect(on.tracks[0]?.callTree.total[0]).toBe(off.tracks[0]?.callTree.total[0]);
    expect(selfOfOrigin(on, Origin.Native)).toBe(selfOfOrigin(off, Origin.Native));
    expect(on.tracks[0]?.busyUs).toBe(off.tracks[0]?.busyUs);
    expect(on.tracks[0]?.samples.length).toBe(off.tracks[0]?.samples.length);
  });

  it('can be turned off', () => {
    const m = analyze(synthCapture(across(GC), { argv }), { bridgeRuntimeSamples: false });
    expect(edges(m)).toContain(`(root) > ${GC}`);
  });

  it('puts the pause under the deepest frame the stacks before and after share', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['a', 'b', 'c'], samples: 2 },
          { stack: [GC], samples: 1 },
          { stack: ['a', 'b', 'd'], samples: 2 },
        ],
        { argv },
      ),
    );
    expect(edges(m)).toContain(`b > ${GC}`);
  });

  it('bridges a run of different pauses together', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['a'], samples: 2 },
          { stack: [PROGRAM], samples: 1 },
          { stack: [GC], samples: 1 },
          { stack: ['a'], samples: 2 },
        ],
        { argv },
      ),
    );
    expect(edges(m)).toEqual(expect.arrayContaining([`a > ${PROGRAM}`, `a > ${GC}`]));
  });

  it('leaves the pause at the root when the stacks share nothing', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['a'], samples: 2 },
          { stack: [GC], samples: 1 },
          { stack: ['x'], samples: 2 },
        ],
        { argv },
      ),
    );
    expect(edges(m)).toContain(`(root) > ${GC}`);
  });

  it('leaves it at the root next to idle, a boundary', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['a'], samples: 2 },
          { stack: [GC], samples: 1 },
          { idle: 3 },
          { stack: ['a'], samples: 2 },
        ],
        { argv },
      ),
    );
    expect(edges(m)).toContain(`(root) > ${GC}`);
  });

  it('leaves a pause at the start or the end of the profile alone', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: [GC], samples: 1 },
          { stack: ['a'], samples: 2 },
          { stack: [PROGRAM], samples: 1 },
        ],
        {
          argv,
        },
      ),
    );
    expect(edges(m)).toEqual(expect.arrayContaining([`(root) > ${GC}`, `(root) > ${PROGRAM}`]));
  });

  it('keeps the pause classified as native or gc so filters still work', () => {
    const m = analyze(synthCapture(across(GC), { argv }));
    const gc = Array.from({ length: m.functions.length }, (_, f) => f).find(
      (f) => nameOf(m, f) === GC,
    );
    expect(m.functions.origin[gc ?? 0]).toBe(Origin.Gc);
  });
});

describe('bridging on real captures', () => {
  const m = loadModel('eslint-cli');
  const view = applyTransforms(m, m.primaryTrack, DEFAULT_TRANSFORMS);
  const count = (name: string) => {
    let n = 0;
    for (let i = 1; i < view.tree.length; i++) {
      if (describeFunction(m, view.tree.fn[i] ?? 0, view.syntheticPackages).name === name) n++;
    }
    return n;
  };

  it('has one call of the entry module and one main under the entry root', () => {
    expect(count('require ▸ eslint/bin/eslint.js')).toBe(1);
    expect(count('main')).toBe(1);
  });

  it('keeps the entry module as one continuous span', () => {
    const t = m.tracks[m.primaryTrack];
    const spans = Array.from(t?.spans.fn ?? []).filter(
      (f) => nameOf(m, f) === 'require ▸ eslint/bin/eslint.js',
    );
    expect(spans).toHaveLength(1);
  });

  it('keeps the time of pauses: Gc and Native self time are the same as without bridging', () => {
    const off = analyze(loadCapture('eslint-cli'), { bridgeRuntimeSamples: false });
    const sum = (x: ExecutionModel, origin: number) => {
      const t = x.tracks[x.primaryTrack]?.callTree;
      let total = 0;
      for (let n = 1; (t?.length ?? 0) > n; n++) {
        if (x.functions.origin[t?.fn[n] ?? 0] === origin) total += t?.self[n] ?? 0;
      }
      return total;
    };
    expect(sum(m, Origin.Gc)).toBeGreaterThan(0);
    expect(sum(m, Origin.Gc)).toBeCloseTo(sum(off, Origin.Gc), 3);
    expect(sum(m, Origin.Native)).toBeCloseTo(sum(off, Origin.Native), 3);
    expect(m.tracks[m.primaryTrack]?.busyUs).toBeCloseTo(
      off.tracks[off.primaryTrack]?.busyUs ?? 0,
      3,
    );
  });

  it('still shows the design board scenario on the orders server', () => {
    const orders = loadModel('orders-server');
    expect(orders.findings.map((f) => f.kind)).toContain('sync-io');
  });
});
