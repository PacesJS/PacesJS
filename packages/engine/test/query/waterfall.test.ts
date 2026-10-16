import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { Origin, TaskKind } from '../../src/model.js';
import type { RuntimeEvent } from '../../src/raw.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { describeTasks } from '../../src/query/tasks.js';
import { applyTransforms, describeFunction } from '../../src/query/view.js';
import { waterfallForRange, waterfallForTask } from '../../src/query/waterfall.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

describe('waterfall on the orders server', () => {
  const m = loadModel('orders-server');
  const track = m.tracks[0];
  const tasks = track?.tasks;
  const longest = Array.from({ length: tasks?.length ?? 0 }, (_, k) => k)
    .filter((k) => tasks?.kind[k] === TaskKind.Request)
    .reduce((a, b) =>
      (tasks?.end[b] ?? 0) - (tasks?.start[b] ?? 0) > (tasks?.end[a] ?? 0) - (tasks?.start[a] ?? 0)
        ? b
        : a,
    );
  const view = applyTransforms(m, 0, DEFAULT_TRANSFORMS);
  const w = waterfallForTask(m, view, longest);
  const nameOf = (fn: number) => describeFunction(m, fn, view.syntheticPackages).name;

  it('lists rows in execution order with parents before children', () => {
    for (let i = 1; i < w.rows.length; i++) {
      expect(w.rows[i]?.start ?? 0).toBeGreaterThanOrEqual(w.rows[i - 1]?.start ?? 0);
    }
    const bad = w.rows.filter((r) => r.parent >= r.id);
    expect(bad).toEqual([]);
  });

  it('merges plumbing and drops idle through the transform stack', () => {
    const names = w.rows.map((r) => nameOf(r.fn));
    expect(names).toContain('getOrders');
    expect(names).toContain('lineTotal');
    expect(names).not.toContain('processTicksAndRejections');
    expect(names).not.toContain('(idle)');
  });

  it('marks the widest child at each level as the critical path', () => {
    const all = w.criticalPath.map((id) => nameOf(w.rows[id]?.fn ?? 0));
    // The stitched view roots every stack at the entry script.
    const names = all.slice(all.indexOf('getOrders'));
    expect(all[0]).toBe('zoo/orders-server/dist/server.js');
    expect(names.slice(0, 3)).toEqual(['getOrders', 'renderInvoice', 'buildInvoiceRows']);
    expect(names[names.length - 1]).toBe('lineTotal');
    expect(w.rows.filter((r) => r.critical).length).toBe(w.criticalPath.length);
  });

  it('computes self time as duration minus child rows and shares of the task', () => {
    const root = w.rows
      .filter((r) => nameOf(r.fn) === 'getOrders')
      .reduce((a, b) => (b.durUs > a.durUs ? b : a));
    expect(root?.share).toBeGreaterThan(0.5);
    expect(root?.selfUs).toBeLessThan(root?.durUs ?? 0);
    expect(w.precisionUs).toBe(m.meta.precisionUs);
  });

  it('shows the minimap busy across the task', () => {
    expect(w.minimap.busy.length).toBe(120);
    expect(Math.max(...w.minimap.busy)).toBeLessThanOrEqual(1);
    expect(w.minimap.busy[60]).toBeGreaterThan(0.9);
  });

  it('builds a range waterfall without a task', () => {
    const r = waterfallForRange(m, view, 1_000_000, 1_300_000, { minimapBuckets: 10 });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.minimap.busy.length).toBe(10);
    expect(r.hasAsyncFlow).toBe(false);
  });

  it('throws for a task that does not exist', () => {
    expect(() => waterfallForTask(m, view, 9999)).toThrow(/No task 9999/);
  });
});

describe('waterfall edge cases', () => {
  it('hatches rows shorter than two sampling intervals', () => {
    const m = analyze(
      synthCapture([
        { stack: ['a', 'b'], samples: 1 },
        { stack: ['a'], samples: 5 },
      ]),
    );
    const view = applyTransforms(m, 0, []);
    const w = waterfallForTask(m, view, 0);
    const byName = (n: string) => w.rows.find((r) => describeFunction(m, r.fn).name === n);
    expect(byName('b')?.hatched).toBe(true);
    expect(byName('a')?.hatched).toBe(false);
  });

  const T0 = 1_800_000_000_000;
  const ev = (ms: number, phase: 'init' | 'before' | 'after', asyncId: number): RuntimeEvent => ({
    type: 'async',
    time: T0 + ms,
    phase,
    asyncId,
    triggerAsyncId: 1,
    asyncType: 'Timeout',
  });
  const steps = [{ stack: ['a'], samples: 5 }, { idle: 5 }, { stack: ['b'], samples: 5 }];
  const events = [ev(3, 'init', 2), ev(12, 'before', 2), ev(14, 'after', 2)];

  it('adds a labelled wait row and the scheduled task rows when async edges exist', () => {
    const m = analyze(synthCapture(steps, { events }));
    const view = applyTransforms(m, 0, []);
    const w = waterfallForTask(m, view, 0);
    const wait = w.rows.find((r) => r.kind === 'wait');
    expect(w.hasAsyncFlow).toBe(true);
    expect(wait?.label).toBe('idle wait ~5.0 ms');
    expect(wait?.task).toBe(1);
    const scheduled = w.rows.filter((r) => r.kind === 'call' && r.task === 1);
    expect(scheduled.length).toBe(1);
    expect(scheduled[0]?.parent).toBe(wait?.id);
  });

  it('leaves async rows out when followAsync is false or no async data exists', () => {
    const withData = analyze(synthCapture(steps, { events }));
    const v = applyTransforms(withData, 0, []);
    expect(waterfallForTask(withData, v, 0, { followAsync: false }).hasAsyncFlow).toBe(false);
    const plain = analyze(synthCapture(steps));
    expect(waterfallForTask(plain, applyTransforms(plain, 0, []), 0).hasAsyncFlow).toBe(false);
  });
});

describe('waterfall on an inverted view', () => {
  it('reads the call-order tree, as the time axis needs', () => {
    const m = loadModel('orders-server');
    const task = Array.from({ length: m.tracks[0]?.tasks.length ?? 0 }, (_, k) => k).find(
      (k) => (m.tracks[0]?.tasks.busy[k] ?? 0) > 150_000,
    );
    const normal = waterfallForTask(m, applyTransforms(m, 0, DEFAULT_TRANSFORMS), task ?? 0);
    const inverted = waterfallForTask(
      m,
      applyTransforms(m, 0, [...DEFAULT_TRANSFORMS, { kind: 'invert' }]),
      task ?? 0,
    );
    expect(inverted.rows.map((r) => r.fn)).toEqual(normal.rows.map((r) => r.fn));
  });
});

describe('waterfall options on the eslint cli', () => {
  const m = loadModel('eslint-cli');
  const view = applyTransforms(m, m.primaryTrack, DEFAULT_TRANSFORMS);
  const entryTask = describeTasks(m, m.primaryTrack).find((t) => t.group === 'Entry')?.index ?? 0;
  const plain = waterfallForTask(m, view, entryTask);

  const isConsistent = (w: typeof plain): boolean =>
    w.rows.every((r, i) => r.id === i && r.parent < r.id) &&
    w.criticalPath.every((id) => w.rows[id]?.critical === true);

  it('has dependency rows by default (collapsed packages)', () => {
    expect(plain.rows.some((r) => r.fn >= m.functions.length)).toBe(true);
  });

  it('hides rows of the given origins and keeps ids, parents and the critical path consistent', () => {
    const w = waterfallForTask(m, view, entryTask, { hideOrigins: [Origin.Dependency] });
    expect(w.rows.length).toBeLessThan(plain.rows.length);
    expect(w.rows.some((r) => r.fn >= m.functions.length)).toBe(false);
    expect(isConsistent(w)).toBe(true);
  });

  it('drops rows shorter than the minimum duration together with their subtrees', () => {
    const w = waterfallForTask(m, view, entryTask, { minDurationUs: 5000 });
    expect(w.rows.length).toBeGreaterThan(0);
    expect(w.rows.length).toBeLessThan(plain.rows.length);
    expect(w.rows.every((r) => r.durUs >= 5000)).toBe(true);
    expect(isConsistent(w)).toBe(true);
  });

  it('orders siblings by start time by default', () => {
    const starts = new Map<number, number[]>();
    for (const r of plain.rows) starts.set(r.parent, [...(starts.get(r.parent) ?? []), r.start]);
    for (const list of starts.values()) expect(list).toEqual([...list].sort((a, b) => a - b));
  });

  it.each(['duration', 'share'] as const)('orders siblings by %s, longest first', (sort) => {
    const w = waterfallForTask(m, view, entryTask, { sort });
    expect(isConsistent(w)).toBe(true);
    expect(w.rows).toHaveLength(plain.rows.length);
    const durations = new Map<number, number[]>();
    for (const r of w.rows) {
      if (r.kind === 'wait') continue;
      durations.set(r.parent, [...(durations.get(r.parent) ?? []), r.durUs]);
    }
    for (const list of durations.values()) expect(list).toEqual([...list].sort((a, b) => b - a));
  });

  it('keeps every row, one per parent, in depth-first order after sorting', () => {
    const w = waterfallForTask(m, view, entryTask, { sort: 'duration' });
    const seen = new Set<number>();
    for (const r of w.rows) {
      expect(r.parent < 0 || seen.has(r.parent)).toBe(true);
      seen.add(r.id);
    }
    expect(seen.size).toBe(w.rows.length);
  });

  it('applies the same filters to a time range', () => {
    const w = waterfallForRange(m, view, 0, m.meta.durationUs, {
      hideOrigins: [Origin.Dependency],
      minDurationUs: 3000,
      sort: 'duration',
    });
    expect(w.rows.every((r) => r.durUs >= 3000 && r.fn < m.functions.length)).toBe(true);
    expect(isConsistent(w)).toBe(true);
  });

  it('keeps ids equal to indexes when a depth limit removes rows', () => {
    expect(isConsistent(waterfallForTask(m, view, entryTask, { maxDepth: 3 }))).toBe(true);
  });
});
