import { describe, expect, it } from 'vitest';
import type { ExecutionModel } from '../../src/model.js';
import { deoptCounts, deoptSites } from '../../src/query/deopts.js';
import { loadModel } from '../helpers/fixtures.js';

const fnId = (m: ExecutionModel, name: string): number =>
  Array.from({ length: m.functions.length }, (_, f) => f).find(
    (f) => m.strings[m.functions.name[f] ?? 0] === name,
  ) ?? -1;

describe('deopt marks on the deopt-loop run', () => {
  const m = loadModel('deopt-loop');
  const price = fnId(m, 'price');
  const total = fnId(m, 'total');

  it('counts the deopts of price', () => {
    expect(deoptCounts(m, 0, [])[price]).toBe(10);
  });

  it('does not count on-stack-replacement churn: total keeps only its one real deopt', () => {
    expect(deoptCounts(m, 0, [])[total]).toBe(1);
    expect(deoptSites(m, 0, total)).toEqual([
      { reason: 'overflow', kind: 'eager', line: 12, count: 1 },
    ]);
  });

  it('lists where and why, most often first, with the original line', () => {
    const sites = deoptSites(m, 0, price);
    expect(sites[0]).toMatchObject({ reason: 'wrong map', kind: 'eager', line: 6, count: 10 });
    expect(sites).toHaveLength(1);
  });

  it('gives nothing to a view of a process that had no trace', () => {
    expect(deoptCounts(m, 99, [])[price]).toBe(0);
    expect(deoptSites(m, 99, price)).toEqual([]);
  });
});
