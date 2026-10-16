import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { TaskKind } from '../../src/model.js';
import { timelineLane } from '../../src/query/timeline.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

describe('timeline lane on the orders server', () => {
  const m = loadModel('orders-server');
  const lane = timelineLane(m, 0, { buckets: 60 });

  it('reports CPU activity per bucket, busy while requests run', () => {
    expect(lane.cpu.length).toBe(60);
    const busyBuckets = Array.from(lane.cpu).filter((v) => v > 0.9).length;
    expect(busyBuckets).toBeGreaterThan(40);
    expect(Math.max(...lane.cpu)).toBeLessThanOrEqual(1);
  });

  it('reports the share of user code per bucket', () => {
    expect(Math.max(...lane.user)).toBeGreaterThan(0.8);
    expect(lane.user.every((v, i) => v <= (lane.cpu[i] ?? 0) + 1e-6)).toBe(true);
  });

  it('lists task blocks with labels and flags long request tasks', () => {
    const requests = lane.tasks.filter((t) => t.kind === TaskKind.Request);
    expect(requests.length).toBeGreaterThanOrEqual(14);
    expect(requests.every((t) => t.label === 'request · GET /orders')).toBe(true);
    expect(requests.filter((t) => t.long).length).toBe(14);
  });

  it('does not flag long startup tasks', () => {
    const main = lane.tasks.filter((t) => t.kind === TaskKind.Main);
    expect(main.some((t) => t.long)).toBe(false);
  });

  it('carries GC and loop delay markers in model time', () => {
    expect(lane.gc.length).toBeGreaterThan(5);
    expect(Math.max(...lane.loopDelay.map((x) => x.durationUs))).toBeGreaterThan(150_000);
  });

  it('restricts to a range', () => {
    const part = timelineLane(m, 0, { start: 1_000_000, end: 1_500_000, buckets: 10 });
    expect(part.cpu.length).toBe(10);
    expect(part.tasks.every((t) => t.end > 1_000_000 && t.start < 1_500_000)).toBe(true);
    expect(part.gc.every((x) => x.time >= 1_000_000 && x.time < 1_500_000)).toBe(true);
    expect(part.bucketUs).toBe(50_000);
  });

  it('throws for a missing track', () => {
    expect(() => timelineLane(m, 7)).toThrow(/No track at index 7/);
  });
});

describe('timeline lane edge cases', () => {
  it('keeps idle buckets nearly empty', () => {
    const model = analyze(synthCapture([{ stack: ['a'], samples: 10 }, { idle: 10 }]));
    const lane = timelineLane(model, 0, { buckets: 2, start: 0, end: 20_000 });
    expect(lane.cpu[0]).toBeGreaterThan(0.8);
    expect(lane.cpu[1]).toBeLessThan(0.2);
  });
});
