import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import type { ExecutionModel } from '../src/model.js';
import { DEFAULT_TRANSFORMS } from '../src/query/types.js';
import { applyTransforms } from '../src/query/view.js';
import { callGraph } from '../src/query/callgraph.js';
import { flameLayout } from '../src/query/flame.js';
import { functionRows, sandwich } from '../src/query/functions.js';
import { timelineLane } from '../src/query/timeline.js';
import { waterfallForRange } from '../src/query/waterfall.js';
import { deserializeModel, serializeModel } from '../src/serialize.js';
import { largeCapture } from './helpers/large.js';

// Generous bounds: the spec targets are 1.5 s for the passes and 50 ms per transform on a
// mid-range laptop. CI machines vary, so the assertions leave 2-4x headroom and the measured
// numbers are written to the test output for the record.
const timings: Record<string, number> = {};

function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  timings[label] = Math.round((performance.now() - t0) * 10) / 10;
  return out;
}

describe('performance on a 60 s x 1 ms synthetic profile', () => {
  let model: ExecutionModel;
  const capture = largeCapture();

  beforeAll(() => {
    model = time('analyze', () => analyze(capture));
  });

  it('has the expected scale', () => {
    expect(model.tracks[0]?.samples.length).toBe(capture.tracks[0]?.cpuProfile?.samples.length);
    expect(model.tracks[0]?.samples.length).toBeGreaterThanOrEqual(60_000);
    expect(model.tracks[0]?.callTree.length).toBeGreaterThan(2000);
  });

  it('analyzes in under 3 s (spec target 1.5 s)', () => {
    expect(timings.analyze).toBeLessThan(3000);
  });

  it('applies the default transform stack in under 150 ms (spec target 50 ms)', () => {
    time('transform-default', () => applyTransforms(model, 0, DEFAULT_TRANSFORMS));
    const runs = Array.from({ length: 5 }, () =>
      time('transform-default', () => applyTransforms(model, 0, DEFAULT_TRANSFORMS)),
    );
    expect(runs.length).toBe(5);
    expect(timings['transform-default']).toBeLessThan(150);
  });

  it('applies a single transform in under 100 ms', () => {
    const fn = model.tracks[0]?.callTree.fn[10] ?? 0;
    time('transform-merge', () => applyTransforms(model, 0, [{ kind: 'merge-function', fn }]));
    time('transform-invert', () => applyTransforms(model, 0, [{ kind: 'invert' }]));
    expect(timings['transform-merge']).toBeLessThan(100);
    expect(timings['transform-invert']).toBeLessThan(150);
  });

  it('serializes and reads back in under a second, under 5 MB', () => {
    const bytes = time('serialize', () => serializeModel(model));
    time('deserialize', () => deserializeModel(bytes));
    expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
    expect(timings.serialize).toBeLessThan(1000);
    expect(timings.deserialize).toBeLessThan(1000);
  });

  it('answers every view query on the default view in under 150 ms each', () => {
    const view = applyTransforms(model, 0, DEFAULT_TRANSFORMS);
    const top = functionRows(model, view)[0]?.fn ?? 0;
    time('query-flame', () => flameLayout(model, view));
    time('query-functions', () => functionRows(model, view));
    time('query-callgraph', () => callGraph(model, view));
    time('query-sandwich', () => sandwich(model, view, top));
    time('query-waterfall-10s', () => waterfallForRange(model, view, 0, 10_000_000));
    time('query-timeline', () => timelineLane(model, 0));
    for (const key of Object.keys(timings).filter((k) => k.startsWith('query-'))) {
      expect(timings[key]).toBeLessThan(150);
    }
  });

  it('stays inside generous bounds on the worst case: unrelated random stacks everywhere', () => {
    const stress = time('stress-analyze', () => analyze(largeCapture(60_000, false)));
    time('stress-transform-default', () => applyTransforms(stress, 0, DEFAULT_TRANSFORMS));
    expect(timings['stress-analyze']).toBeLessThan(3000);
    expect(timings['stress-transform-default']).toBeLessThan(250);
  });

  it('records the measured numbers', () => {
    const out = process.env.PACES_BENCH_OUT;
    if (out) writeFileSync(out, JSON.stringify(timings, null, 2));
    expect(Object.keys(timings)).toContain('analyze');
  });
});
