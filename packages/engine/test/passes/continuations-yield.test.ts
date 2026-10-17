import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import type { RuntimeEvent } from '../../src/raw.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { waterfallForRun } from '../../src/query/waterfall.js';
import { FIXTURES, loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

const rt = (name: string) => ({ name, url: 'node:internal/process/task_queues' });
const argv = ['node', '/project/src/app.js'];
const spanName = (m: ExecutionModel, span: number) =>
  m.strings[m.functions.name[m.tracks[0]?.spans.fn[span] ?? 0] ?? 0];

/** Logical tree of the default view, as indented names without the entry root. */
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

describe('attaching a continuation where the previous task yielded', () => {
  it('attaches under the shallowest frame of the same package of the previous task, marked as kind 3', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'mid'], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv },
      ),
    );
    const t = m.tracks[0];
    expect(t?.tasks.stitch[1]).toBe(3);
    expect(spanName(m, t?.tasks.parentSpan[1] ?? 0)).toBe('main');
    expect(t?.tasks.resumeOf[1]).toBe(-1);
    expect(t?.tasks.waitUs[1]).toBeGreaterThan(0);
    expect(Array.from(t?.continuations.stitch ?? [])).toEqual([3]);
    expect(outline(m)).toEqual(['main', '  mid', '  execute']);
  });

  it('drops trailing module loading: the load is not what yielded', () => {
    const m = analyze(
      synthCapture(
        [
          {
            stack: [
              'main',
              { name: '', url: 'file:///project/src/mod.js', line: 0, col: 0 },
              'inner',
            ],
            samples: 5,
          },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(spanName(m, m.tracks[0]?.tasks.parentSpan[1] ?? 0)).toBe('main');
  });

  it('drops runtime and plumbing frames at the bottom of the previous stack', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'cb', rt('runMicrotasks')], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(spanName(m, m.tracks[0]?.tasks.parentSpan[1] ?? 0)).toBe('main');
  });

  it('stays a root when the only frames to attach under belong to another package', () => {
    const dep = (name: string) => ({ name, url: 'file:///project/node_modules/lib/index.js' });
    const m = analyze(
      synthCapture(
        [
          { stack: [dep('outer'), dep('inner')], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv: ['node', '/project/src/app.js'] },
      ),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(0);
  });

  it('stays a root when the previous task left nothing to attach to', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: [{ name: '', url: 'file:///project/src/mod.js', line: 0, col: 0 }], samples: 5 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(0);
    expect(m.tracks[0]?.tasks.parentSpan[1]).toBe(-1);
  });

  it('does not attach across a long idle gap without async data', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main'], samples: 5 },
          { idle: 20 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(0);
  });

  it('does not attach timer or I/O callbacks, which have no caller', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main'], samples: 5 },
          { idle: 1 },
          { stack: [{ name: 'listOnTimeout', url: 'node:internal/timers' }, 'tick'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(0);
  });

  it('does not use it when the function has an earlier call to resume', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'run', 'execute'], samples: 3 },
          { idle: 1 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv },
      ),
    );
    expect(m.tracks[0]?.tasks.stitch[1]).toBe(1);
  });

  describe('with async data', () => {
    const T0 = 1_800_000_000_000;
    const ev = (ms: number, phase: 'init' | 'before' | 'after', id: number): RuntimeEvent => ({
      type: 'async',
      time: T0 + ms,
      phase,
      asyncId: id,
      triggerAsyncId: 1,
      asyncType: 'PROMISE',
    });
    const steps: Step[] = [
      { stack: ['main', 'mid'], samples: 5 },
      { idle: 15 },
      { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
    ];

    it('attaches to the task the edge comes from, whatever the gap', () => {
      const m = analyze(
        synthCapture(steps, {
          argv,
          events: [ev(3, 'init', 2), ev(23, 'before', 2), ev(25, 'after', 2)],
        }),
      );
      expect(m.tracks[0]?.tasks.stitch[1]).toBe(3);
      expect(spanName(m, m.tracks[0]?.tasks.parentSpan[1] ?? 0)).toBe('main');
    });
  });

  it('shows the continuation under the caller in the whole-run waterfall, with the wait', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: ['main', 'mid'], samples: 5 },
          { idle: 2 },
          { stack: [rt('processTicksAndRejections'), 'execute'], samples: 3 },
        ],
        { argv },
      ),
    );
    const w = waterfallForRun(m, 0);
    const execute = w.rows.find((r) => r.fn >= 0 && describeFunction(m, r.fn).name === 'execute');
    expect(execute?.depth).toBe(2);
    expect(execute?.resumed).toBe(false);
    const parent = w.rows[execute?.parent ?? 0];
    expect(parent && describeFunction(m, parent.fn).name).toBe('main');
    expect(w.rows.some((r) => r.kind === 'wait' && /^awaiting/.test(r.label))).toBe(true);
  });
});

describe('stitching never makes things worse', () => {
  it.each([...FIXTURES])('%s has no cycles and only attaches to earlier calls', (name) => {
    const m = loadModel(name);
    m.tracks.forEach((t) => {
      const c = t.continuations;
      for (let r = 0; r < c.length; r++) {
        const span = c.span[r] ?? 0;
        const parent = c.parentSpan[r] ?? -1;
        if (parent < 0) continue;
        expect(t.spans.start[parent] ?? 0).toBeLessThanOrEqual(t.spans.start[span] ?? 0);
        expect(parent).not.toBe(span);
        // Follow the logical parents up: the chain must end.
        const seen = new Set<number>();
        let cur = parent;
        while (cur >= 0) {
          expect(seen.has(cur)).toBe(false);
          seen.add(cur);
          let up = t.spans.parent[cur] ?? -1;
          for (let k = 0; k < c.length; k++) {
            if (c.span[k] === cur) up = c.parentSpan[k] ?? -1;
          }
          cur = up;
        }
      }
    });
  });

  it.each(['eslint-cli', 'eslint-cli-wrapped'] as const)(
    '%s: few continuation rows are left at the top of the run',
    (name) => {
      const m = loadModel(name);
      const w = waterfallForRun(m, m.primaryTrack);
      const top = w.rows.filter((r) => r.kind === 'call' && r.depth === 1);
      expect(top.length).toBeLessThanOrEqual(12);
      const names = top.map((r) => describeFunction(m, r.fn).name);
      expect(names.filter((n) => n === 'execute')).toEqual([]);
      expect(names.filter((n) => n === 'loadConfigFile')).toEqual([]);
      expect(names.filter((n) => n === 'require ▸ eslint/bin/eslint.js')).toHaveLength(1);
      expect(
        w.rows.filter((r) => r.fn >= 0 && describeFunction(m, r.fn).name === 'main'),
      ).toHaveLength(1);
    },
  );
});
