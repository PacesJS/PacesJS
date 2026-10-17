import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import {
  INITIAL_DEPTH,
  NOISE_SHARE,
  foldRows,
  hotTargetPath,
  initialCollapsed,
} from '../../src/view/waterfall-fold';
import { visibleRows } from '../../src/view/waterfall-rows';
import type { WaterfallRow } from '../../src/data/types';
import { fixtureModel, ordersModel } from '../helpers/real-model';

const model = fixtureModel('eslint-cli');
const queries = createQueries(model);
const scope = {
  track: model.tracks[model.primaryTrack]?.id ?? '',
  transforms: [...DEFAULT_TRANSFORMS],
  range: null,
  hide: [] as number[],
};
const run = queries.waterfall(scope, -1, { sort: 'time', minDurUs: 0 });
const rows = run?.rows ?? [];
const options = { hideSmall: true, bootstrap: true, threshold: '3 ms', keep: new Set<number>() };
const folded = foldRows(rows, options);

describe('folding tiny rows', () => {
  it('turns the rows below precision and 0.1% into folds, so there are far fewer top-level rows', () => {
    expect(folded.hiddenSmall).toBeGreaterThan(100);
    const closed = initialCollapsed(folded.rows, run?.criticalRows ?? [], folded.folds);
    expect(visibleRows(folded.rows, closed).length).toBeLessThan(rows.length / 5);
  });

  it('keeps every engine row: a fold only moves rows under a synthetic parent', () => {
    const real = folded.rows.filter((r) => r.kind !== 'fold').map((r) => r.id);
    expect(real.sort((a, b) => a - b)).toEqual(rows.map((r) => r.id));
  });

  it('states how many rows a fold stands for and under what threshold', () => {
    const small = folded.rows.find((r) => r.fold === 'small');
    expect(small?.name).toMatch(/^\d+ rows? under 3 ms hidden$/);
    expect(small?.foldedCount).toBeGreaterThan(0);
  });

  it('puts all noise of one parent into a single fold', () => {
    const byParent = new Map<number, number>();
    for (const r of folded.rows)
      if (r.fold === 'small') byParent.set(r.parent, (byParent.get(r.parent) ?? 0) + 1);
    expect(Math.max(...byParent.values())).toBe(1);
  });

  it('never hides a row on the critical path or a row above the noise share', () => {
    const hidden = folded.rows.filter(
      (r) => r.kind === 'call' && folded.rows.find((p) => p.id === r.parent)?.fold === 'small',
    );
    expect(hidden.every((r) => r.belowPrecision && r.share < NOISE_SHARE && !r.critical)).toBe(
      true,
    );
  });

  it('shows every row when folding is off', () => {
    const off = foldRows(rows, { ...options, hideSmall: false, bootstrap: false });
    expect(off.rows).toHaveLength(rows.length);
    expect(off.folds).toEqual([]);
  });

  it('keeps a row visible on its own when asked (the selection)', () => {
    const noise = folded.rows.find(
      (r) => r.kind === 'call' && folded.rows.find((p) => p.id === r.parent)?.fold === 'small',
    );
    const kept = foldRows(rows, { ...options, keep: new Set([noise?.id ?? -9]) });
    const row = kept.rows.find((r) => r.id === noise?.id);
    expect(kept.rows.find((p) => p.id === row?.parent)?.fold).not.toBe('small');
  });
});

describe('node bootstrap', () => {
  it('folds the leading Node frames before the first user frame into one collapsed row', () => {
    const boot = folded.rows.find((r) => r.fold === 'bootstrap');
    expect(boot?.name).toBe('node bootstrap');
    expect(boot?.depth).toBe(1);
    expect(folded.folds).toContain(boot?.id);
    const first = visibleRows(folded.rows, new Set(folded.folds)).map((i) => folded.rows[i]?.name);
    expect(first.slice(0, 2)).toEqual([run?.rows[0]?.name, 'node bootstrap']);
  });

  it('keeps the bootstrap rows underneath, one level deeper, for when it is opened', () => {
    const boot = folded.rows.find((r) => r.fold === 'bootstrap');
    const members = folded.rows.filter((r) => r.parent === boot?.id);
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => m.depth === (boot?.depth ?? 0) + 1)).toBe(true);
  });
});

describe('first screen', () => {
  const closed = initialCollapsed(folded.rows, run?.criticalRows ?? [], folded.folds);
  const shown = visibleRows(folded.rows, closed).map((i) => folded.rows[i]);

  it('opens along the chain to the target hottest function, not a sea of requires', () => {
    const hot = hotTargetPath(folded.rows) ?? [];
    expect(hot.length).toBeGreaterThan(2);
    expect(
      hot.slice(0, INITIAL_DEPTH + 1).every((id) => !closed.has(id) || id === hot.at(-1)),
    ).toBe(true);
  });

  it('leaves the siblings of the chain visible but closed', () => {
    const hot = hotTargetPath(folded.rows) ?? [];
    const siblings = folded.rows.filter(
      (r) => r.parent === hot[1] && !hot.includes(r.id) && r.hasChildren,
    );
    expect(siblings.every((s) => closed.has(s.id))).toBe(true);
  });

  it('shows every row of the chain down to the depth limit on the first screen', () => {
    const hot = hotTargetPath(folded.rows) ?? [];
    const visibleIds = new Set(shown.map((r) => r?.id));
    const reachable = hot.filter(
      (id) => (folded.rows.find((r) => r.id === id)?.depth ?? 99) <= INITIAL_DEPTH + 1,
    );
    expect(reachable.length).toBeGreaterThan(2);
    expect(reachable.every((id) => visibleIds.has(id))).toBe(true);
  });

  it('never points the chain at a module loader or a dependency', () => {
    const hot = hotTargetPath(folded.rows) ?? [];
    const last = folded.rows.find((r) => r.id === hot.at(-1));
    expect(last?.origin).toBe(0);
    expect(last?.name.startsWith('require ▸')).toBe(false);
  });
});

describe('the opening chain follows CPU time, not the clock', () => {
  const row = (
    id: number,
    parent: number,
    depth: number,
    name: string,
    startMs: number,
    endMs: number,
    selfMs: number,
  ): WaterfallRow => ({
    id,
    kind: 'call',
    fn: id,
    path: [id],
    name,
    loc: '',
    origin: 0,
    start: startMs * 1000,
    end: endMs * 1000,
    depth,
    parent,
    hasChildren: false,
    critical: false,
    belowPrecision: false,
    share: 0,
    resumed: false,
    summaryTasks: [],
    selfUs: selfMs * 1000,
  });

  // `waits` spans 1300 ms on the clock but only runs 5 ms; `works` is the real work.
  const rows = [
    row(0, -1, 0, 'entry', 0, 1400, 1),
    row(1, 0, 1, 'waits', 0, 1300, 1),
    row(2, 1, 2, 'waitsChild', 0, 4, 4),
    row(3, 0, 1, 'works', 1300, 1400, 5),
    row(4, 3, 2, 'workHard', 1300, 1390, 90),
  ];

  it('opens the chain with the most CPU time, not the widest on the clock', () => {
    const names = (hotTargetPath(rows) ?? []).map((id) => rows.find((r) => r.id === id)?.name);
    expect(names).toEqual(['entry', 'works', 'workHard']);
  });
});

describe('findings stay reachable on the first screen', () => {
  const orders = ordersModel();
  const oq = createQueries(orders);
  const oscope = {
    track: orders.tracks[orders.primaryTrack]?.id ?? '',
    transforms: [...DEFAULT_TRANSFORMS],
    range: null,
    hide: [] as number[],
  };
  const longest = oq.tasks(oscope).find((t) => t.longest)?.index ?? 0;
  const task = oq.waterfall(oscope, longest, { sort: 'time', minDurUs: -1 });
  const orows = foldRows(task?.rows ?? [], options);
  const evidence = new Set(orders.findings.flatMap((f) => f.evidence));
  const visible = (set: ReadonlySet<number>): (string | undefined)[] =>
    visibleRows(
      orows.rows,
      initialCollapsed(orows.rows, task?.criticalRows ?? [], orows.folds, set),
    ).map((i) => orows.rows[i]?.name);

  it('opens the way to the sync read the finding names, inside a closed template loader', () => {
    expect(visible(new Set())).not.toContain('readFileSync');
    expect(visible(evidence)).toContain('readFileSync');
  });
});
