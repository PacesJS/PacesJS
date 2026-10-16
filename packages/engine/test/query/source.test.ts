import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { ExecutionModel } from '../../src/model.js';
import { functionSource } from '../../src/query/source.js';
import { applyTransforms } from '../../src/query/view.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const fnId = (m: ExecutionModel, name: string): number =>
  Array.from({ length: m.functions.length }, (_, f) => f).find(
    (f) => m.strings[m.functions.name[f] ?? 0] === name,
  ) ?? -1;

describe('function source info on the orders server', () => {
  const m = loadModel('orders-server');
  const view = applyTransforms(m, 0, []);
  const info = functionSource(m, view, fnId(m, 'lineTotal'));

  it('puts the hot line of lineTotal at original line 9', () => {
    expect(info.file).toBe('zoo/orders-server/src/util/money.ts');
    expect(info.hottestLine).toBe(9);
    const hot = info.lines.find((l) => l.line === 9);
    expect(hot?.share).toBeGreaterThan(0.7);
    expect(info.lines.map((l) => l.line)).toEqual(
      [...info.lines.map((l) => l.line)].sort((a, b) => a - b),
    );
  });

  it('reports self and total time from the view', () => {
    expect(info.selfUs / 1000).toBeGreaterThan(1800);
    expect(info.totalUs).toBeGreaterThanOrEqual(info.selfUs);
    expect(info.totalUs - info.selfUs).toBeLessThan(10_000);
  });

  it('lists callees with time, largest first, without a call-site line', () => {
    const caller = functionSource(m, view, fnId(m, 'buildInvoiceRows'));
    expect(caller.callSites[0]?.callee).toBe(fnId(m, 'lineTotal'));
    expect(caller.callSites[0]?.line).toBe(0);
    expect(caller.callSites[0]?.calleeUs).toBeGreaterThan(1_800_000);
    expect(caller.callSites[1]?.callee).toBe(fnId(m, 'formatCurrency'));
  });

  it('gives a sparkline of when the function ran', () => {
    expect(info.sparkline.length).toBe(60);
    expect(Math.max(...info.sparkline)).toBeGreaterThan(0.5);
    expect(info.sparkline[0]).toBe(0);
  });

  it('returns empty lines for a collapsed package node', () => {
    const v = applyTransforms(m, 0, [{ kind: 'collapse-package', pkg: 'ajv' }]);
    const synth = functionSource(m, v, m.functions.length);
    expect(synth.name).toBe('ajv');
    expect(synth.lines).toEqual([]);
    expect(synth.totalUs).toBeGreaterThan(0);
  });
});

describe('function source edge cases', () => {
  it('counts recursive total once and flags nothing for plain files', () => {
    const m = analyze(synthCapture([{ stack: ['f', 'f', 'g'], samples: 4 }]));
    const info = functionSource(m, applyTransforms(m, 0, []), fnId(m, 'f'));
    expect(info.totalUs).toBe(4000);
    expect(info.selfUs).toBe(0);
    expect(info.mapMissing).toBe(false);
    expect(info.callSites.map((c) => c.callee)).toEqual([fnId(m, 'g')]);
  });
});
