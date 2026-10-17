import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import { nodeElk } from '../helpers/node-elk';
import { fixtureModel } from '../helpers/real-model';

// What the drawer and the source dock say about a function covers every call of it. A callee's
// time inside that function can never be more than the function's own time.

for (const name of ['eslint-cli-wrapped', 'eslint-cli', 'orders-server']) {
  describe(`callee time against the function total on ${name}`, () => {
    const model = fixtureModel(name);
    const q = createQueries(model, null, nodeElk);
    const scope = {
      track: model.tracks[model.primaryTrack]?.id ?? '',
      transforms: [...DEFAULT_TRANSFORMS],
      range: null,
      hide: [] as number[],
    };
    const rows = q.functions(scope, '').rows.slice(0, 400);

    it('no callee chip or callee row is longer than its function', () => {
      const bad: string[] = [];
      for (const r of rows) {
        const d = q.details(scope, r.fn);
        const src = q.source(scope, r.fn);
        if (!d || !src) continue;
        const slack = d.totalUs * 1.001 + 1;
        for (const c of src.calleeTime) {
          if (c.totalUs > slack)
            bad.push(`${d.name}: callee ${c.name} ${c.totalUs} > ${d.totalUs}`);
        }
        for (const c of d.callees) {
          if (c.kind === 'callee' && c.frac * d.totalUs > slack)
            bad.push(`${d.name}: row ${c.name} ${c.frac}`);
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
  });
}

describe('the numbers of one call', () => {
  const model = fixtureModel('eslint-cli-wrapped');
  const q = createQueries(model, null, nodeElk);
  const scope = {
    track: model.tracks[model.primaryTrack]?.id ?? '',
    transforms: [...DEFAULT_TRANSFORMS],
    range: null,
    hide: [] as number[],
  };
  const calls = (q.waterfall(scope, -1, { sort: 'time', minDurUs: 0 })?.rows ?? [])
    .filter((r) => r.kind === 'call' && r.fn >= 0 && r.depth > 3)
    .slice(0, 300);

  it('are never more than the numbers of all calls of the function', () => {
    const bad: string[] = [];
    for (const r of calls) {
      const call = q.callAt(scope, r.path);
      const all = q.details(scope, r.fn);
      if (!call || !all) continue;
      if (call.totalUs > all.totalUs * 1.001 + 1) bad.push(`${r.name} total`);
      if (call.selfUs > all.selfUs * 1.001 + 1) bad.push(`${r.name} self`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('have callees that add up to no more than the call itself', () => {
    const bad: string[] = [];
    for (const r of calls) {
      const call = q.callAt(scope, r.path);
      if (!call) continue;
      const sum = call.callees.reduce((n, c) => n + c.totalUs, 0);
      if (sum > call.totalUs * 1.001 + 1) bad.push(`${r.name} ${sum} > ${call.totalUs}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('is found for a call row and not for a path that does not exist', () => {
    const r = calls[0];
    expect(r && q.callAt(scope, r.path)).not.toBeNull();
    expect(q.callAt(scope, [999_999])).toBeNull();
  });
});
