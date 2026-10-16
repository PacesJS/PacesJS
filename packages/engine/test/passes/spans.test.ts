import { describe, expect, it } from 'vitest';
import { toCallTree } from '../../src/passes/call-tree.js';
import { reconstructSpans } from '../../src/passes/spans.js';
import { loadCapture } from '../helpers/capture.js';
import { runPasses } from '../helpers/run-passes.js';
import { synthCapture } from '../helpers/synth.js';
import type { RawCapture } from '../../src/raw.js';

function spansOf(capture: RawCapture, trackIndex = 0) {
  const run = runPasses(capture);
  const track = run.ing.tracks[trackIndex];
  if (!track) throw new Error('no track');
  const tree = toCallTree(track.tree, run.sm.frameToFn);
  const spans = reconstructSpans({
    tree,
    samples: track.samples,
    origin: run.cls.origin,
    gapUs: run.ing.precisionUs * 3,
  });
  return { run, tree, spans, track };
}

describe('span reconstruction on synthetic edge cases', () => {
  it('starts a span at its first sample and ends it where the next sample begins', () => {
    const { spans, track } = spansOf(
      synthCapture([
        { stack: ['a', 'b'], samples: 3 },
        { stack: ['a'], samples: 2 },
      ]),
    );
    expect(spans.length).toBe(2);
    expect(spans.depth).toEqual(Uint16Array.of(0, 1));
    expect(spans.start[0]).toBe(track.samples.time[0]);
    expect(spans.end[0]).toBe((track.samples.time[4] ?? 0) + 1000);
    expect(spans.end[1]).toBe(track.samples.time[3]);
    expect(spans.parent).toEqual(Int32Array.of(-1, 0));
  });

  it('keeps a call in one span across a GC pause and nests the pause under it', () => {
    const { spans, run } = spansOf(
      synthCapture([
        { stack: ['a', 'b'], samples: 3 },
        { stack: ['(garbage collector)'], samples: 1 },
        { stack: ['a', 'b'], samples: 2 },
      ]),
    );
    const names = Array.from(spans.fn, (f) => run.functions[f]?.name);
    expect(names).toEqual(['a', 'b', '(garbage collector)']);
    expect(spans.depth).toEqual(Uint16Array.of(0, 1, 2));
    expect(spans.end[1]).toBeGreaterThan(spans.end[2] ?? 0);
  });

  it('does not nest a GC sample under idle time', () => {
    const { spans } = spansOf(
      synthCapture([
        { idle: 2 },
        { stack: ['(garbage collector)'], samples: 1 },
        { stack: ['a'], samples: 1 },
      ]),
    );
    expect(spans.depth).toEqual(Uint16Array.of(0, 0, 0));
  });

  it('splits a span when the same function is called again after other work', () => {
    const { spans } = spansOf(
      synthCapture([
        { stack: ['a'], samples: 1 },
        { stack: ['b'], samples: 1 },
        { stack: ['a'], samples: 1 },
      ]),
    );
    expect(spans.length).toBe(3);
  });
});

describe('span reconstruction on the orders server', () => {
  const { spans, tree, run } = spansOf(loadCapture('orders-server'));
  const nameOf = (i: number) => run.functions[spans.fn[i] ?? 0]?.name;

  it('sorts spans by start then depth with parents enclosing children', () => {
    for (let i = 1; i < spans.length; i++) {
      const before = (spans.start[i - 1] ?? 0) - (spans.start[i] ?? 0);
      expect(before <= 0).toBe(true);
    }
    const bad = Array.from({ length: spans.length }, (_, i) => i).filter((i) => {
      const p = spans.parent[i] ?? -1;
      return (
        p >= 0 &&
        ((spans.start[p] ?? 0) > (spans.start[i] ?? 0) || (spans.end[p] ?? 0) < (spans.end[i] ?? 0))
      );
    });
    expect(bad).toEqual([]);
  });

  it('reconstructs one getOrders call per request as a root-level span of about 180 ms', () => {
    const roots = Array.from({ length: spans.length }, (_, i) => i).filter(
      (i) => nameOf(i) === 'getOrders' && spans.depth[i] === 0,
    );
    expect(roots.length).toBe(14);
    const durations = roots.map((i) => ((spans.end[i] ?? 0) - (spans.start[i] ?? 0)) / 1000);
    expect(Math.min(...durations)).toBeGreaterThan(120);
    expect(Math.max(...durations)).toBeLessThan(260);
  });

  it('accounts for every sampled microsecond at depth zero', () => {
    let total = 0;
    for (let i = 0; i < spans.length; i++) {
      if (spans.depth[i] === 0) total += (spans.end[i] ?? 0) - (spans.start[i] ?? 0);
    }
    expect(total).toBeCloseTo(tree.total[0] ?? 0, -3);
  });
});
