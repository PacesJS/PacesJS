import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import type { Transform } from '../../src/state/types';
import { nodeElk } from '../helpers/node-elk';
import { ordersModel } from '../helpers/real-model';

const model = ordersModel();
const q = createQueries(model, null, nodeElk);
const main = model.tracks[0]?.id ?? '';
const worker = model.tracks[1]?.id ?? '';
const scope = { track: main, transforms: [...DEFAULT_TRANSFORMS], range: null };
const fnNamed = (name: string): number =>
  q.functions(scope, name).rows.find((r) => r.name === name)?.fn ?? -1;
const lineTotal = fnNamed('lineTotal');
const withStack = (...t: Transform[]) => ({ ...scope, transforms: t });
const collapsed = withStack({ k: 'collapse-deps' });
const ajvId = (): number =>
  q.functions(collapsed, 'ajv').rows.find((r) => r.name === 'ajv')?.fn ?? -1;

describe('summary', () => {
  it('lists three tracks and the engine findings in the engine ranking', () => {
    const s = q.summary();
    expect(s.tracks).toHaveLength(3);
    expect(s.findings.map((f) => f.id)).toEqual(model.findings.map((f) => f.id));
    expect(s.findings[0]?.kind).toBe('hot-function');
  });

  it('knows whether a baseline was loaded', () => {
    expect(q.summary().hasBaseline).toBe(false);
    expect(createQueries(model, model, nodeElk).summary().hasBaseline).toBe(true);
  });
});

describe('functions table', () => {
  const res = q.functions(scope, '');

  it('puts lineTotal at the top by self time, with its location', () => {
    expect(res.rows[0]?.name).toBe('lineTotal');
    expect(res.rows[0]?.loc).toMatch(/src\/util\/money\.ts:6$/);
  });

  it('shows a share of the track wall time', () => {
    expect(res.rows[0]?.share).toBeCloseTo((res.rows[0]?.selfUs ?? 0) / res.baseUs, 10);
    expect(res.baseUs).toBe(model.tracks[0]?.durationUs);
  });

  it('shows collapsed dependency packages as one row, labelled node_modules', () => {
    const ajv = q.functions(collapsed, '').rows.find((r) => r.name === 'ajv');
    expect(ajv).toMatchObject({ origin: 1, pkg: 'ajv', loc: 'node_modules/ajv' });
  });

  it('filters by name, file or package without changing the total', () => {
    const filtered = q.functions(scope, 'money.ts');
    expect(filtered.rows.map((r) => r.name)).toContain('lineTotal');
    expect(filtered.rows.length).toBeLessThan(res.rows.length);
    expect(filtered.totalFns).toBe(res.totalFns);
  });

  it('restricts every query to the range', () => {
    const inRange = q.functions({ ...scope, range: [394_000, 594_000] }, '');
    const sum = (r: typeof res): number => r.rows.reduce((a, x) => a + x.selfUs, 0);
    expect(sum(inRange)).toBeLessThan(sum(res));
  });

  it('scopes a worker track to its own functions', () => {
    const crunch = model.findings.find((f) => f.showMe.track === worker)?.showMe.fn ?? -1;
    expect(q.details({ ...scope, track: worker }, crunch)).not.toBeNull();
    expect(q.details(scope, crunch)).toBeNull();
  });
});

describe('details and sandwich', () => {
  it('reports totals, callers, callees and a self row for lineTotal', () => {
    const d = q.details(scope, lineTotal);
    expect(d?.callers.map((c) => c.name)).toEqual(['buildInvoiceRows']);
    expect(d?.callers[0]?.frac).toBeCloseTo(1, 5);
    expect(d?.callees.find((c) => c.kind === 'self')?.frac).toBeGreaterThan(0.9);
    expect(d?.selfUs).toBeGreaterThan(0);
    expect(d?.share).toBeCloseTo((d?.totalUs ?? 0) / (model.tracks[0]?.durationUs ?? 1), 10);
  });

  it('works for a collapsed package through its stable id', () => {
    expect(q.details(collapsed, ajvId())?.name).toBe('ajv');
  });

  it('puts callers above and the function at level 0, widths as a share of the function', () => {
    const rows = q.sandwich(scope, lineTotal);
    expect(rows.filter((r) => r.level < 0).map((r) => r.name)).toEqual([
      'buildInvoiceRows',
      'renderInvoice',
      'getOrders',
    ]);
    expect(rows.find((r) => r.level === 0)).toMatchObject({ name: 'lineTotal', start: 0, end: 1 });
    expect(rows.find((r) => r.isSelf)?.end).toBeGreaterThan(0.9);
  });
});

describe('flame data', () => {
  const flame = (zoom: number[] = [], sort: 'heavy' | 'alpha' = 'heavy') =>
    q.flame(scope, { sort, color: 'origin', zoom });

  it('starts with an all-samples root covering the full width', () => {
    const f = flame();
    expect(f.node[0]).toBe(-1);
    expect(f.names[0]).toBe('all samples');
    expect(f.w[0]).toBe(1);
  });

  it('zooms into a frame so it fills the width and leaves a breadcrumb', () => {
    const f0 = flame();
    const i = Array.from({ length: f0.length }, (_, k) => k).find((k) => f0.depth[k] === 1) ?? 0;
    const f1 = flame([f0.node[i] ?? 0]);
    expect(f1.w[0]).toBe(1);
    expect(f1.crumbs).toHaveLength(1);
    expect(f1.crumbs[0]?.name).toBe(f0.names[i]);
  });

  it('orders siblings alphabetically on request', () => {
    const f = flame([], 'alpha');
    const kids = Array.from({ length: f.length }, (_, i) => i)
      .filter((i) => f.depth[i] === 1)
      .sort((a, b) => (f.x[a] ?? 0) - (f.x[b] ?? 0));
    // The engine sorts unnamed functions as '' (first); the view labels them '(anonymous)'.
    const names = kids.map((i) => (f.names[i] === '(anonymous)' ? '' : (f.names[i] as string)));
    expect(names).toEqual([...names].sort());
  });

  it('has no change data without a baseline', () => {
    expect(flame().delta).toBeUndefined();
  });
});

describe('waterfall', () => {
  const wf = q.waterfall(scope, -1);

  it('opens on the longest task and makes the task itself the root row', () => {
    expect(wf?.rows[0]).toMatchObject({ kind: 'task', depth: 0, name: 'GET /orders', parent: -1 });
    expect(wf?.rows[0]?.end).toBe(wf?.taskUs);
  });

  it('puts the first user frame beneath the task, in execution order', () => {
    expect(wf?.rows.slice(1, 4).map((r) => `${r.depth}:${r.name}`)).toEqual([
      '1:getOrders',
      '2:renderInvoice',
      '3:loadTemplate',
    ]);
  });

  it('keeps parents consistent and every row inside its task', () => {
    const rows = wf?.rows ?? [];
    expect(rows.every((r) => r.end >= r.start && r.end <= (wf?.taskUs ?? 0) + 1)).toBe(true);
    expect(rows.slice(1).every((r) => (rows[r.parent]?.depth ?? -9) < r.depth)).toBe(true);
  });

  it('marks the widest child at each level as the critical path, task first', () => {
    const crit = (wf?.criticalRows ?? []).map((id) => wf?.rows[id]?.name);
    expect(crit.slice(0, 3)).toEqual(['GET /orders', 'getOrders', 'renderInvoice']);
    expect(wf?.rows.filter((r) => r.critical).map((r) => r.id)).toEqual(wf?.criticalRows);
  });

  it('marks rows below the sampling precision as hatched', () => {
    expect(wf?.rows.some((r) => r.belowPrecision)).toBe(true);
  });

  it('shows a time range when no task is chosen', () => {
    const r = q.waterfall({ ...scope, range: [394_000, 594_000] }, -1);
    expect(r?.taskIndex).toBe(-1);
    expect(r?.taskLabel).toMatch(/^Range /);
  });

  it('offers the longest task first in the picker', () => {
    const tasks = q.tasks(scope);
    expect(tasks[0]?.longest).toBe(true);
    expect(tasks.some((t) => t.label === 'GET /orders')).toBe(true);
  });
});

describe('call graph', () => {
  const run = (query: Partial<{ all: boolean; revealed: number[]; ego: number | null }> = {}) =>
    q.callGraph(scope, { all: false, revealed: [], ego: null, ...query }, []);

  it('shows each function once with a position per node', async () => {
    const { graph, layout } = await run({ all: true });
    expect(new Set(graph.nodes.map((n) => n.fn)).size).toBe(graph.nodes.length);
    expect(layout.nodes).toHaveLength(graph.nodes.length);
  });

  it('prunes to the heaviest functions and counts the rest', async () => {
    const pruned = (await run()).graph;
    const all = (await run({ all: true })).graph;
    expect(pruned.shownFns).toBeLessThan(all.shownFns);
    expect(pruned.totalFns).toBe(all.totalFns);
  });

  it('reveals the neighbours of a function from its +N chip', async () => {
    const before = (await run()).graph.shownFns;
    const after = (await run({ revealed: [fnNamed('buildInvoiceRows')] })).graph.shownFns;
    expect(after).toBeGreaterThan(before);
  });

  it('connects the pruned graph even when one function dominates self time', async () => {
    const { graph } = await run();
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it('keeps node positions identical when the selection changes', async () => {
    const a = await run({ ego: null });
    const b = await run({ ego: lineTotal });
    expect(b.layout.nodes).toEqual(a.layout.nodes);
  });

  it('reports the ego neighbourhood of the selected function', async () => {
    const { near } = await run({ ego: lineTotal });
    expect(near).toContain(lineTotal);
    expect((await run()).near).toBeNull();
  });

  it('lays out the same graph the same way twice', async () => {
    expect((await run()).layout).toEqual((await run()).layout);
  });
});

describe('source', () => {
  it('gives lineTotal line-level self time and its project-relative path', () => {
    const info = q.source(scope, lineTotal);
    expect(info?.path).toMatch(/src\/util\/money\.ts$/);
    expect(info?.lineSelf.length).toBeGreaterThan(0);
    expect(info?.lineSelf.some((l) => l.line === info.hottestLine)).toBe(true);
    expect(Math.max(...(info?.spark ?? []))).toBe(1);
  });

  it('has no source for a collapsed package', () => {
    expect(q.source(collapsed, ajvId())).toBeNull();
  });
});

describe('overview lanes', () => {
  const o = q.overview();

  it('has a lane per track with CPU buckets and tasks', () => {
    expect(o.lanes).toHaveLength(3);
    expect(o.lanes[0]?.taskStart.length).toBeGreaterThan(10);
    expect(Math.max(...(o.lanes[0]?.cpu ?? []))).toBeGreaterThan(0);
  });

  it('splits the lane label into title and detail', () => {
    expect(o.lanes[0]?.label).toBe('main');
    expect(o.lanes[1]?.label).toBe('worker 1');
  });

  it('marks long tasks by the engine rule', () => {
    expect(Array.from(o.lanes[0]?.taskLong ?? []).some((v) => v === 1)).toBe(true);
  });

  it('records the loop-delay peak', () => {
    expect(o.lanes[0]?.hasLoopData).toBe(true);
    expect(o.lanes[0]?.peakDelayUs).toBeGreaterThan(50_000);
  });
});

describe('describe', () => {
  it('names functions, calls and tasks, and nothing for no selection', () => {
    expect(q.describe(scope, { kind: 'fn', fn: lineTotal }).name).toBe('lineTotal');
    const node = q.describe(scope, { kind: 'node', track: main, path: [271, 279] });
    expect(node).toMatchObject({ name: 'renderInvoice', path: [271, 279] });
    expect(q.describe(scope, { kind: 'task', track: main, task: 7 }).task?.label).toBe(
      'GET /orders',
    );
    expect(q.describe(scope, { kind: 'none' }).fn).toBeNull();
  });
});
