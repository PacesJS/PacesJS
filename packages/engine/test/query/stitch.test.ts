import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { callGraph } from '../../src/query/callgraph.js';
import { flameLayout } from '../../src/query/flame.js';
import { functionRows } from '../../src/query/functions.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import type { TransformedView } from '../../src/query/types.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

const rt = (name: string) => ({ name, url: 'node:internal/process/task_queues' });
const argv = ['node', '/project/src/app.js'];

const asyncChain: Step[] = [
  { stack: ['main', 'run', 'readAndVerify'], samples: 3 },
  { stack: ['main', 'run'], samples: 1 },
  { idle: 6 },
  { stack: [rt('processTicksAndRejections'), 'readAndVerify', 'verify'], samples: 4 },
  { stack: [rt('processTicksAndRejections'), 'run', 'reporter'], samples: 2 },
  { idle: 3 },
];

const outline = (m: ExecutionModel, v: TransformedView): string[] => {
  const out: string[] = [];
  for (let n = 0; n < v.tree.length; n++) {
    const name = describeFunction(m, v.tree.fn[n] ?? 0, v.syntheticPackages).name;
    out.push(`${'  '.repeat(v.tree.depth[n] ?? 0)}${name}`);
  }
  return out;
};

describe('stitch-continuations on an async chain', () => {
  const m = analyze(synthCapture(asyncChain, { argv }));
  const stitched = applyTransforms(m, 0, [{ kind: 'stitch-continuations' }, { kind: 'drop-idle' }]);

  it('shows one logical tree under a root named after the entry script', () => {
    expect(outline(m, stitched)).toEqual([
      '(root)',
      '  src/app.js',
      '    main',
      '      run',
      '        readAndVerify',
      '          verify',
      '        reporter',
    ]);
  });

  it('keeps every sample and all self and total time', () => {
    const plain = applyTransforms(m, 0, []);
    const all = applyTransforms(m, 0, [{ kind: 'stitch-continuations' }]);
    expect(all.samples.length).toBe(plain.samples.length);
    expect(all.totalUs).toBeCloseTo(plain.totalUs, 3);
  });

  it('moves the continuation time onto the logical path', () => {
    const at = (name: string) => {
      for (let n = 0; n < stitched.tree.length; n++) {
        if (describeFunction(m, stitched.tree.fn[n] ?? 0).name === name) return n;
      }
      return -1;
    };
    expect(stitched.tree.self[at('verify')]).toBeCloseTo(4000, -2);
    expect(stitched.tree.self[at('reporter')]).toBeCloseTo(2000, -2);
    expect(stitched.tree.total[at('run')]).toBeCloseTo(10000, -2);
    expect(stitched.tree.total[at('src/app.js')]).toBeCloseTo(stitched.totalUs, 3);
  });

  it('without the transform the continuation is a separate root', () => {
    const plain = applyTransforms(m, 0, []);
    const names = outline(m, plain);
    expect(names).toContain('  processTicksAndRejections');
    expect(names).toContain('  main');
  });

  it('is part of the default stack, first, and removable', () => {
    expect(DEFAULT_TRANSFORMS[0]).toEqual({ kind: 'stitch-continuations' });
    const view = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
    expect(outline(m, view)).toEqual(outline(m, stitched));
    const without = applyTransforms(
      m,
      0,
      DEFAULT_TRANSFORMS.filter((t) => t.kind !== 'stitch-continuations'),
    );
    expect(outline(m, without)).not.toContain('        reporter');
  });

  it('does nothing when it is not the first transform, because the tree is no longer the track', () => {
    const view = applyTransforms(m, 0, [{ kind: 'drop-idle' }, { kind: 'stitch-continuations' }]);
    expect(outline(m, view)).toEqual(outline(m, applyTransforms(m, 0, [{ kind: 'drop-idle' }])));
  });

  it('is what the flame graph, call graph and functions table read', () => {
    const view = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
    const name = (fn: number) => describeFunction(m, fn).name;
    const flame = flameLayout(m, view);
    expect(Array.from(flame.fn, name)).toContain('reporter');
    expect(flame.maxDepth).toBeGreaterThanOrEqual(4);
    expect(
      callGraph(m, view, { coverage: 1 }).edges.map((e) => `${name(e.from)}>${name(e.to)}`),
    ).toContain('run>reporter');
    expect(functionRows(m, view).find((r) => r.name === 'run')?.total).toBeCloseTo(10000, -2);
  });
});

describe('stitch-continuations edge cases', () => {
  it('chains: every later resumption lands under the original parent', () => {
    const steps: Step[] = [
      { stack: ['main', 'run', 'readAndVerify'], samples: 2 },
      { idle: 5 },
      { stack: [rt('processTicksAndRejections'), 'readAndVerify', 'verify'], samples: 2 },
      { idle: 5 },
      { stack: [rt('processTicksAndRejections'), 'readAndVerify', 'verify2'], samples: 2 },
    ];
    const m = analyze(synthCapture(steps, { argv }));
    expect(
      outline(m, applyTransforms(m, 0, [{ kind: 'stitch-continuations' }, { kind: 'drop-idle' }])),
    ).toEqual([
      '(root)',
      '  src/app.js',
      '    main',
      '      run',
      '        readAndVerify',
      '          verify',
      '          verify2',
    ]);
  });

  it('unstitched tasks hang under the entry root with their own stacks', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main'], samples: 2 },
          { idle: 5 },
          { stack: [rt('processTicksAndRejections'), 'fresh'], samples: 2 },
        ],
        { argv },
      ),
    );
    expect(
      outline(m, applyTransforms(m, 0, [{ kind: 'stitch-continuations' }, { kind: 'drop-idle' }])),
    ).toEqual([
      '(root)',
      '  src/app.js',
      '    main',
      '    processTicksAndRejections',
      '      fresh',
    ]);
  });

  it('survives an empty profile', () => {
    const m = analyze(synthCapture([], { argv }));
    expect(
      applyTransforms(m, 0, [{ kind: 'stitch-continuations' }, { kind: 'drop-idle' }]).tree.length,
    ).toBe(1);
  });
});
