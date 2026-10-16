import { describe, expect, it } from 'vitest';
import { ingest } from '../../src/passes/ingest.js';
import { loadCapture, makeContext } from '../helpers/capture.js';

describe('ingest', () => {
  const capture = loadCapture('orders-server');
  const ctx = makeContext();
  const result = ingest(capture, ctx);
  const main = result.tracks[0];

  it('keeps one ingested track per captured track, main first', () => {
    expect(result.tracks.map((t) => t.info.kind)).toEqual(['process', 'worker', 'worker']);
  });

  it('builds a preorder tree rooted at (root) where subtrees are contiguous ranges', () => {
    const tree = main?.tree;
    expect(tree?.parent[0]).toBe(-1);
    expect(ctx.strings.strings[result.frames.name[tree?.frame[0] ?? 0] ?? 0]).toBe('(root)');
    const lengths = tree?.length ?? 0;
    expect(tree?.subtreeEnd[0]).toBe(lengths);
    expect(tree?.parent.every((p, i) => p < i)).toBe(true);
  });

  it('sums sample durations into self and total time', () => {
    const tree = main?.tree;
    const samples = main?.samples;
    const dur = samples?.dur.reduce((a, b) => a + b, 0) ?? 0;
    expect(tree?.total[0]).toBeCloseTo(dur, 3);
    expect(tree?.self.reduce((a, b) => a + b, 0)).toBeCloseTo(dur, 3);
  });

  it('measures the real sampling interval instead of trusting the configured one', () => {
    expect(capture.meta.intervalUs).toBe(1000);
    expect(result.precisionUs).toBeGreaterThan(1300);
    expect(result.precisionUs).toBeLessThan(2000);
  });

  it('converts sample times to microseconds from the start of the run', () => {
    const first = main?.samples.time[0] ?? -1;
    const last = main?.samples.time[(main?.samples.length ?? 1) - 1] ?? 0;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeLessThanOrEqual(result.durationUs);
  });

  it('converts runtime events to model time and labels requests', () => {
    const requests = main?.events.requests;
    expect(requests?.time.length).toBe(14);
    expect(ctx.strings.strings[requests?.label[0] ?? 0]).toBe('GET /orders');
    expect((requests?.duration[0] ?? 0) / 1000).toBeGreaterThan(100);
    expect(main?.events.gc.time.length).toBeGreaterThan(5);
  });

  it('keeps V8 position ticks for line-level self time', () => {
    const ticks = main?.ticks;
    expect(ticks?.line.length).toBeGreaterThan(10);
    expect(ticks?.ticks.reduce((a, b) => a + b, 0)).toBeGreaterThan(1000);
  });

  it('dedupes frames across tracks', () => {
    const total = result.tracks.reduce((n, t) => n + t.tree.length, 0);
    expect(result.frames.length).toBeLessThan(total);
  });
});
