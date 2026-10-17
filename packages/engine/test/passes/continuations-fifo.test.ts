import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

const rt = (name: string) => ({ name, url: 'node:internal/process/task_queues' });
const argv = ['node', '/project/src/app.js'];
const spanName = (m: ExecutionModel, span: number) =>
  m.strings[m.functions.name[m.tracks[0]?.spans.fn[span] ?? 0] ?? 0];

/** Logical tree of the default view as indented names, without the root and the entry. */
const outline = (m: ExecutionModel): string[] => {
  const v = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
  const out: string[] = [];
  for (let n = 2; n < v.tree.length; n++) {
    out.push(
      `${'  '.repeat((v.tree.depth[n] ?? 0) - 2)}${describeFunction(m, v.tree.fn[n] ?? 0, v.syntheticPackages).name}`,
    );
  }
  return out;
};

describe('continuations resume the oldest unmatched call, in call order', () => {
  // Two invocations of `file` started in one burst under different callers, resumed later in order.
  const burst: Step[] = [
    { stack: ['main', 'runA', 'file'], samples: 2 },
    { stack: ['main', 'runB', 'file'], samples: 2 },
    { idle: 3 },
    { stack: [rt('processTicksAndRejections'), 'file', 'work'], samples: 3 },
    { idle: 3 },
    { stack: [rt('processTicksAndRejections'), 'file', 'work'], samples: 3 },
  ];

  it('pairs each continuation with its own earlier call, not all with the latest', () => {
    const m = analyze(synthCapture(burst, { argv }));
    const parents = Array.from(m.tracks[0]?.continuations.parentSpan ?? [], (s) => spanName(m, s));
    expect(parents).toEqual(['runA', 'runB']);
  });

  it('shows every invocation under its own caller', () => {
    const m = analyze(synthCapture(burst, { argv }));
    expect(outline(m)).toEqual([
      'main',
      '  runA',
      '    file',
      '      work',
      '  runB',
      '    file',
      '      work',
    ]);
  });

  it('attaches extra continuations next to the same caller instead of chaining them', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'run', 'file'], samples: 2 },
          { idle: 3 },
          { stack: [rt('processTicksAndRejections'), 'file', 'work'], samples: 3 },
          { idle: 3 },
          { stack: [rt('processTicksAndRejections'), 'file', 'work'], samples: 3 },
          { idle: 3 },
          { stack: [rt('processTicksAndRejections'), 'file', 'work'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(outline(m)).toEqual(['main', '  run', '    file', '      work']);
    const v = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
    const file = Array.from(v.tree.fn).findIndex(
      (f) => describeFunction(m, f, v.syntheticPackages).name === 'file',
    );
    expect(v.tree.total[file]).toBeGreaterThan(9000);
  });

  it('pairs the continuations of one async call exactly, through async hooks, in the same order', () => {
    const T0 = 1_800_000_000_000;
    const ev = (ms: number, phase: 'init' | 'before' | 'after', id: number) => ({
      type: 'async' as const,
      time: T0 + ms,
      phase,
      asyncId: id,
      triggerAsyncId: 1,
      asyncType: 'PROMISE',
    });
    const m = analyze(
      synthCapture(burst, {
        argv,
        events: [
          // Both resources are initialised inside the burst, in the same sample window.
          ev(2, 'init', 2),
          ev(4, 'init', 3),
          ev(8, 'before', 2),
          ev(10, 'after', 2),
          ev(12, 'before', 3),
          ev(14, 'after', 3),
        ],
      }),
    );
    const parents = Array.from(m.tracks[0]?.continuations.parentSpan ?? [], (s) => spanName(m, s));
    expect(parents).toEqual(['runA', 'runB']);
  });
});

describe('attaching where the previous task yielded never nests deep or wrong', () => {
  it('takes the shallowest frame of the same package, not a callback deep in the previous stack', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'driver', 'ruleCb'], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'nextFile'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(spanName(m, m.tracks[0]?.tasks.parentSpan[1] ?? 0)).toBe('main');
    expect(outline(m)).toEqual(['main', '  driver', '    ruleCb', '  nextFile']);
  });

  it('does not deepen the tree with every hop: a chain of adjacent tasks stays flat', () => {
    const steps: Step[] = [{ stack: ['main', 'a', 'b'], samples: 5 }];
    for (const name of ['x1', 'x2', 'x3', 'x4']) {
      steps.push({ idle: 1 }, { stack: [rt('processTicksAndRejections'), name, 'y'], samples: 3 });
    }
    const m = analyze(synthCapture(steps, { argv }));
    const v = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
    expect(Math.max(...Array.from(v.tree.depth))).toBe(4);
    expect(outline(m).filter((l) => l.startsWith('  x'))).toHaveLength(4);
  });

  it('attaches only under a frame of the same package as the resumed function', () => {
    const lib = { name: 'libFn', url: 'file:///project/node_modules/lib/index.js' };
    const m = analyze(
      synthCapture(
        [
          { stack: ['main'], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), lib], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(0);
  });

  it('still puts execute under main (the entry-like case)', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main'], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(outline(m)).toEqual(['main', '  execute']);
  });
});

describe('attaching under an async function, the only kind that can await', () => {
  it('prefers the deepest frame whose function is resumed later over shallower ones', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'execute', 'ruleCb'], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'step', 'w'], samples: 3 },
          { idle: 40 },
          { stack: [rt('processTicksAndRejections'), 'execute', 'z'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(spanName(m, m.tracks[0]?.tasks.parentSpan[1] ?? 0)).toBe('execute');
    expect(outline(m).slice(0, 4)).toEqual(['main', '  execute', '    ruleCb', '    step']);
  });

  it('never nests a task under a function it calls itself', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'job'], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'driver', 'job'], samples: 3 },
          { idle: 40 },
          { stack: [rt('processTicksAndRejections'), 'job', 'x'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(spanName(m, m.tracks[0]?.tasks.parentSpan[1] ?? 0)).toBe('main');
  });
});
