import { describe, expect, it } from 'vitest';
import type { ExecutionModel } from '../../src/model.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import type { Waterfall, WaterfallRow } from '../../src/query/types.js';
import { applyTransforms } from '../../src/query/view.js';
import {
  reindex,
  smallTaskLimitUs,
  waterfallForRange,
  waterfallForRun,
  waterfallForTask,
} from '../../src/query/waterfall.js';
import { FIXTURES, loadModel } from '../helpers/fixtures.js';

/** Returns the first broken invariant, or '' when the waterfall is well formed. */
function broken(w: Waterfall, singleRoot: boolean, timeOrder = true): string {
  const roots = w.rows.filter((r) => r.parent < 0);
  if (singleRoot && w.rows.length > 0 && roots.length !== 1) return `roots: ${roots.length}`;
  for (let i = 0; i < w.rows.length; i++) {
    const r = w.rows[i];
    if (!r) continue;
    if (r.id !== i) return `row ${i} has id ${r.id}`;
    if (r.parent < 0) continue;
    if (r.parent >= r.id) return `row ${i} (${r.kind}) has parent ${r.parent} after it`;
    const p = w.rows[r.parent];
    if (p && r.depth !== p.depth + 1) return `row ${i} depth ${r.depth}, parent depth ${p.depth}`;
  }
  // In execution order within a parent (unless the siblings were sorted by size).
  const last = new Map<number, number>();
  for (const r of timeOrder ? w.rows : []) {
    const before = last.get(r.parent);
    if (before !== undefined && r.start < before - 1e-6)
      return `row ${r.id} starts before its sibling`;
    last.set(r.parent, r.start);
  }
  const flagged = w.rows.filter((r) => r.critical).map((r) => r.id);
  if (JSON.stringify(flagged) !== JSON.stringify([...w.criticalPath].sort((a, b) => a - b))) {
    return 'criticalPath differs from the rows flagged critical';
  }
  // A chain from the root: each critical row's parent is the previous critical row.
  for (let k = 0; k < w.criticalPath.length; k++) {
    const row = w.rows[w.criticalPath[k] ?? 0];
    const expected = k === 0 ? -1 : (w.criticalPath[k - 1] ?? -2);
    if (row?.parent !== expected) return `critical row ${row?.id} is not a chain link`;
  }
  return '';
}

const tracksOf = (m: ExecutionModel) => m.tracks.map((_, i) => i);

describe('whole-run waterfall invariants', () => {
  it.each([...FIXTURES])('%s: well formed on every track', (name) => {
    const m = loadModel(name);
    for (const t of tracksOf(m)) {
      expect(broken(waterfallForRun(m, t), true)).toBe('');
    }
  });

  it.each([...FIXTURES])('%s: still well formed with options', (name) => {
    const m = loadModel(name);
    for (const sort of ['time', 'duration'] as const) {
      const w = waterfallForRun(m, m.primaryTrack, { sort, minDurationUs: 2000 });
      expect(broken(w, true, sort === 'time')).toBe('');
    }
  });
});

describe('task and range waterfall invariants', () => {
  it.each([...FIXTURES])('%s: tasks and the full range are well formed', (name) => {
    const m = loadModel(name);
    const view = applyTransforms(m, m.primaryTrack, DEFAULT_TRANSFORMS);
    const tasks = m.tracks[m.primaryTrack]?.tasks.length ?? 0;
    for (let k = 0; k < Math.min(tasks, 12); k++) {
      expect(broken(waterfallForTask(m, view, k), false)).toBe('');
    }
    expect(broken(waterfallForRange(m, view, 0, m.meta.durationUs), false)).toBe('');
  });
});

describe('runtime blips and summary rows', () => {
  it.each([...FIXTURES])(
    '%s: no pause below the limit is a row, summaries are well formed',
    (name) => {
      const m = loadModel(name);
      for (const t of tracksOf(m)) {
        const w = waterfallForRun(m, t);
        const limit = Math.max(smallTaskLimitUs(m, t), 2 * m.meta.precisionUs);
        const blips = w.rows.filter(
          (r) =>
            r.kind === 'call' &&
            r.depth === 1 &&
            r.fn >= 0 &&
            /^\((program|garbage collector|idle)\)$/.test(
              m.strings[m.functions.name[r.fn] ?? 0] ?? '',
            ) &&
            r.durUs < limit,
        );
        expect(blips).toEqual([]);
        for (const r of w.rows.filter((x) => x.kind === 'summary')) {
          expect(r.summaryRuntimeUs).toBeGreaterThanOrEqual(0);
          expect(r.summaryTasks).toEqual([...r.summaryTasks].sort((a, b) => a - b));
          expect(r.summaryTasks.length > 0 || r.summaryRuntimeUs > 0).toBe(true);
        }
      }
    },
  );
});

describe('the critical path follows the work', () => {
  it.each([...FIXTURES])(
    '%s: each critical row carries the most work among its siblings',
    (name) => {
      const m = loadModel(name);
      const w = waterfallForRun(m, m.primaryTrack);
      const work = new Float64Array(w.rows.length);
      for (let i = w.rows.length - 1; i >= 0; i--) {
        const r = w.rows[i];
        if (!r || r.kind !== 'call') continue;
        work[i] = (work[i] ?? 0) + r.selfUs;
        if (r.parent >= 0) work[r.parent] = (work[r.parent] ?? 0) + (work[i] ?? 0);
      }
      for (const id of w.criticalPath) {
        const row = w.rows[id];
        const siblings = w.rows.filter((r) => r.kind === 'call' && r.parent === row?.parent);
        expect(siblings.every((r) => (work[r.id] ?? 0) <= (work[id] ?? 0) + 1e-6)).toBe(true);
      }
    },
  );
});

const VARIANTS: Array<[string, Parameters<typeof waterfallForRun>[2]]> = [
  ['default', {}],
  ['hideOrigins', { hideOrigins: [3, 4, 5, 6] }],
  ['minDurationUs', { minDurationUs: 3000 }],
  ['sort time', { sort: 'time' }],
  ['sort duration', { sort: 'duration' }],
  ['sort share', { sort: 'share' }],
  ['collapseTrivialUs 0', { collapseTrivialUs: 0 }],
  ['collapseTrivialUs 5 ms', { collapseTrivialUs: 5000 }],
];

describe('every fixture with every option variant', () => {
  it.each([...FIXTURES])('%s', (name) => {
    const m = loadModel(name);
    for (const [label, options] of VARIANTS) {
      const sorted = options?.sort === 'duration' || options?.sort === 'share';
      for (const t of tracksOf(m)) {
        expect(`${label}: ${broken(waterfallForRun(m, t, options), true, !sorted)}`).toBe(
          `${label}: `,
        );
      }
    }
  });

  it('includes a capture made with async hooks, whose continuations are stitched exactly', () => {
    const m = loadModel('async-chain-hooks');
    const stitch = Array.from(m.tracks[m.primaryTrack]?.continuations.stitch ?? []);
    expect(stitch).toContain(2);
  });
});

describe('reindex', () => {
  const row = (
    id: number,
    parent: number,
    depth: number,
    start: number,
    end: number,
  ): WaterfallRow => ({
    id,
    kind: 'call',
    fn: id,
    node: id,
    start,
    end,
    durUs: end - start,
    selfUs: 0,
    depth,
    parent,
    share: 0,
    critical: false,
    hatched: false,
    task: -1,
    label: '',
    resumed: false,
    summaryTasks: [],
    summaryRuntimeUs: 0,
  });

  it('puts a parent before a child that starts earlier than the parent row, and widens the parent', () => {
    // A merged child row whose start precedes the first segment of its parent row.
    const rows = [row(0, -1, 0, 0, 100), row(1, 0, 1, 40, 90), row(2, 1, 2, 30, 80)];
    const out = reindex(rows, new Map());
    expect(out.map((r) => r.fn)).toEqual([0, 1, 2]);
    expect(out.map((r) => r.parent)).toEqual([-1, 0, 1]);
    expect(out[1]?.start).toBe(30);
    expect(out[1]?.durUs).toBe(60);
    expect(out[0]?.start).toBe(0);
  });

  it('emits rows depth-first, children in time order, whatever the global start times', () => {
    const rows = [
      row(0, -1, 0, 0, 100),
      row(1, 0, 1, 10, 50),
      row(2, 0, 1, 60, 90),
      row(3, 1, 2, 5, 20),
      row(4, 2, 2, 55, 70),
    ];
    const out = reindex(rows, new Map());
    expect(out.map((r) => r.fn)).toEqual([0, 1, 3, 2, 4]);
    expect(out.every((r, i) => r.id === i && r.parent < r.id)).toBe(true);
  });

  it('follows aliases and keeps depth one more than the parent', () => {
    const rows = [
      row(0, -1, 0, 0, 100),
      row(1, 0, 1, 10, 40),
      row(2, 0, 1, 50, 90),
      row(3, 2, 5, 55, 60),
    ];
    const out = reindex(rows, new Map([[2, 1]]));
    expect(out.map((r) => r.fn)).toEqual([0, 1, 3]);
    expect(out[2]).toMatchObject({ parent: 1, depth: 2 });
  });
});
