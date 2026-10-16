import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { TaskKind } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const fnId = (m: ExecutionModel, name: string, file?: string): number =>
  Array.from({ length: m.functions.length }, (_, f) => f).find(
    (f) =>
      m.strings[m.functions.name[f] ?? 0] === name &&
      (file === undefined || (m.strings[m.functions.file[f] ?? 0] ?? '').includes(file)),
  ) ?? -1;

const trackIndexOfFn = (m: ExecutionModel, track: number, fn: number): number =>
  Array.from(m.tracks[track]?.fnIds ?? []).indexOf(fn);

describe('aggregation on the orders server', () => {
  const m = loadModel('orders-server');
  const main = m.tracks[0];
  const lineTotal = fnId(m, 'lineTotal');

  it('attributes self time to the planted hot function', () => {
    const i = trackIndexOfFn(m, 0, lineTotal);
    expect((main?.agg.fnSelf[i] ?? 0) / 1000).toBeGreaterThan(1800);
    const maxSelf = Math.max(...Array.from(main?.agg.fnSelf ?? []));
    expect(main?.agg.fnSelf[i]).toBe(maxSelf);
  });

  it('keeps self time summing to the track total', () => {
    const sum = Array.from(main?.agg.fnSelf ?? []).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(main?.callTree.total[0] ?? 0, 3);
  });

  it('reports total time of callers including their callees', () => {
    const i = trackIndexOfFn(m, 0, fnId(m, 'getOrders'));
    expect((main?.agg.fnTotal[i] ?? 0) / 1000).toBeGreaterThan(2000);
  });

  it('records caller to callee edges with weight and estimated call counts', () => {
    const e = main?.agg.edges;
    const caller = fnId(m, 'buildInvoiceRows');
    const row = Array.from({ length: e?.length ?? 0 }, (_, k) => k).find(
      (k) => e?.caller[k] === caller && e?.callee[k] === lineTotal,
    );
    expect(row).toBeDefined();
    expect((e?.weight[row ?? 0] ?? 0) / 1000).toBeGreaterThan(1800);
    expect(e?.count[row ?? 0]).toBeGreaterThanOrEqual(14);
  });

  it('puts nearly all line self time of lineTotal on one original line', () => {
    const lines = main?.lines;
    const a = lines?.offset[lineTotal] ?? 0;
    const b = lines?.offset[lineTotal + 1] ?? 0;
    const byLine = new Map<number, number>();
    for (let i = a; i < b; i++) byLine.set(lines?.line[i] ?? 0, lines?.self[i] ?? 0);
    const hot = Math.max(...byLine.values());
    expect(hot / [...byLine.values()].reduce((x, y) => x + y, 0)).toBeGreaterThan(0.7);
    expect([...byLine.entries()].find(([, v]) => v === hot)?.[0]).toBe(9);
  });

  it('sums time per package, counting nested frames once', () => {
    const names = Array.from(m.packages.name, (p) => m.strings[p]);
    expect(names).toContain('ajv');
    const ajv = names.indexOf('ajv');
    expect(m.packages.total[ajv]).toBeGreaterThan(0);
    expect(m.packages.total[ajv]).toBeLessThan(main?.busyUs ?? 0);
  });

  it('sums busy time per task kind', () => {
    expect(m.taskKinds.count[TaskKind.Request]).toBeGreaterThanOrEqual(14);
    expect((m.taskKinds.busy[TaskKind.Request] ?? 0) / 1000).toBeGreaterThan(2500);
  });
});

describe('aggregation edge cases', () => {
  it('counts a recursive function total once', () => {
    const m = analyze(synthCapture([{ stack: ['f', 'f', 'f', 'g'], samples: 4 }]));
    const i = trackIndexOfFn(m, 0, fnId(m, 'f'));
    expect(m.tracks[0]?.agg.fnTotal[i]).toBe(4000);
    expect(m.tracks[0]?.agg.fnSelf[i]).toBe(0);
  });

  it('splits a node self time over its tick lines by tick count', () => {
    const m = analyze(
      synthCapture([
        {
          stack: [{ name: 'f', line: 9 }],
          samples: 4,
          ticks: [
            { line: 11, ticks: 3 },
            { line: 12, ticks: 1 },
          ],
        },
      ]),
    );
    const f = fnId(m, 'f');
    const lines = m.tracks[0]?.lines;
    expect(Array.from(lines?.line ?? [])).toEqual([11, 12]);
    expect(Array.from(lines?.self ?? [])).toEqual([3000, 1000]);
    expect(lines?.offset[f]).toBe(0);
  });
});
