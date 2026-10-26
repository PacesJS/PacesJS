import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/data/queries';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import type { Transform } from '../../src/state/types';
import { nodeElk } from '../helpers/node-elk';
import { fixtureModel, ordersModel } from '../helpers/real-model';

const model = ordersModel();
const q = createQueries(model, null, nodeElk);
const main = model.tracks[0]?.id ?? '';
const worker = model.tracks[1]?.id ?? '';
const scope = {
  track: main,
  transforms: [...DEFAULT_TRANSFORMS],
  range: null,
  hide: [] as number[],
};
const shape = { sort: 'time', minDurUs: 0 } as const;
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

  it('has no marks for a run where none were added', () => {
    expect(q.summary().marks).toEqual([]);
  });

  it('places the marks of a run on its timeline, from the start of the run', () => {
    const marked = {
      ...model,
      meta: {
        ...model.meta,
        marks: [
          { at: model.meta.startedAt + 250, label: 'Mark 1' },
          { at: model.meta.startedAt + 900, label: 'Mark 2' },
        ],
      },
    };
    expect(createQueries(marked, null, nodeElk).summary().marks).toEqual([
      { us: 250_000, label: 'Mark 1' },
      { us: 900_000, label: 'Mark 2' },
    ]);
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
    q.flame(scope, { sort, color: 'origin', zoom, zoomPath: [] });

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

  it('zooms to a hot path by function ids, using the longest prefix that exists', () => {
    const chain = q.hotPaths(scope, 1)[0]?.fns ?? [];
    const f = q.flame(scope, { sort: 'heavy', color: 'origin', zoom: [], zoomPath: chain });
    expect(f.crumbs.map((c) => c.name).at(-1)).toBe('lineTotal');
    expect(f.w[0]).toBe(1);
    const bogus = q.flame(scope, {
      sort: 'heavy',
      color: 'origin',
      zoom: [],
      zoomPath: [chain[0] ?? 0, 999_999],
    });
    // The entry root counts as the first step; the unknown function is dropped.
    expect(bogus.crumbs.map((c) => c.name).at(-1)).toBe('getOrders');
    expect(bogus.crumbs).toHaveLength(2);
  });

  it('has no change data without a baseline', () => {
    expect(flame().delta).toBeUndefined();
  });
});

describe('task waterfall', () => {
  const longest = q.tasks(scope).find((t) => t.longest)?.index ?? 0;
  const wf = q.waterfall(scope, longest, shape);

  it('makes the task itself the root row', () => {
    expect(wf?.mode).toBe('task');
    expect(wf?.rows[0]).toMatchObject({
      kind: 'task',
      depth: 0,
      name: 'request · GET /orders',
      parent: -1,
    });
    expect(wf?.rows[0]?.end).toBe(wf?.taskUs);
  });

  it('roots the task at the entry script, with the user frames beneath it in execution order', () => {
    expect(wf?.rows[1]).toMatchObject({ depth: 1, parent: 0 });
    expect(wf?.rows[1]?.name).toMatch(/server\.js$/);
    expect(wf?.rows.slice(2, 5).map((r) => `${r.depth}:${r.name}`)).toEqual([
      '2:getOrders',
      '3:renderInvoice',
      '4:loadTemplate',
    ]);
  });

  it('keeps parents consistent and every row inside its task', () => {
    const rows = wf?.rows ?? [];
    expect(rows.every((r) => r.end >= r.start && r.end <= (wf?.taskUs ?? 0) + 1)).toBe(true);
    expect(rows.slice(1).every((r) => (rows[r.parent]?.depth ?? -9) < r.depth)).toBe(true);
  });

  it('marks the widest child at each level as the critical path, task first', () => {
    const crit = (wf?.criticalRows ?? []).map((id) => wf?.rows[id]?.name);
    expect(crit[0]).toBe('request · GET /orders');
    expect(crit[1]).toMatch(/server\.js$/);
    expect(crit).toContain('getOrders');
    expect(wf?.rows.filter((r) => r.critical).map((r) => r.id)).toEqual(wf?.criticalRows);
  });

  it('marks rows below the sampling precision as hatched', () => {
    expect(wf?.rows.some((r) => r.belowPrecision)).toBe(true);
  });

  it('puts the longest sibling first when the engine sorts by duration, children under parents', () => {
    const sorted = q.waterfall(scope, longest, { sort: 'duration', minDurUs: 0 });
    const rows = sorted?.rows ?? [];
    const parent = rows.find((r) => rows.filter((k) => k.parent === r.id).length > 2);
    const lengths = rows.filter((r) => r.parent === parent?.id).map((r) => r.end - r.start);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    expect(rows.map((r) => r.id)).toEqual(rows.map((_, i) => i));
    expect(rows.slice(1).every((r) => (rows[r.parent]?.depth ?? 99) < r.depth)).toBe(true);
  });

  it('drops calls under the minimum duration with everything beneath them, keeping the task row', () => {
    const all = q.waterfall(scope, longest, shape)?.rows.length ?? 0;
    const kept = q.waterfall(scope, longest, { sort: 'time', minDurUs: 30_000 })?.rows ?? [];
    expect(kept[0]?.kind).toBe('task');
    expect(kept.length).toBeLessThan(all);
    expect(kept.every((r) => r.kind === 'task' || r.end - r.start >= 30_000)).toBe(true);
  });
});

describe('whole-run waterfall', () => {
  const run = q.waterfall(scope, -1, shape);

  it('is the default: the whole logical execution rooted at the entry script', () => {
    expect(run?.mode).toBe('run');
    expect(run?.rows[0]).toMatchObject({ kind: 'call', depth: 0, parent: -1 });
    expect(run?.rows[0]?.name).toMatch(/server\.js$/);
    expect(run?.taskLabel).toMatch(/^Whole run · /);
  });

  it('covers the run, not one task', () => {
    const task = q.waterfall(scope, q.tasks(scope).find((t) => t.longest)?.index ?? 0, shape);
    expect(run?.taskUs).toBeGreaterThan((task?.taskUs ?? 0) * 3);
  });

  it('folds small tasks into summary rows instead of listing each', () => {
    const summaries = run?.rows.filter((r) => r.kind === 'summary') ?? [];
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]?.name).toMatch(/small tasks? ·/);
    expect(summaries[0]?.summaryTasks.length).toBeGreaterThan(0);
  });

  it('keeps ids as indexes with parents before children', () => {
    const rows = run?.rows ?? [];
    expect(rows.map((r) => r.id)).toEqual(rows.map((_, i) => i));
    expect(rows.slice(1).every((r) => r.parent >= 0 && r.parent < r.id)).toBe(true);
  });

  it('marks the critical path from the entry root', () => {
    expect(run?.criticalRows[0]).toBe(0);
    expect(run?.rows.filter((r) => r.critical).map((r) => r.id)).toEqual(run?.criticalRows);
  });

  it('shows a time range when no task is chosen and a range is set', () => {
    const r = q.waterfall({ ...scope, range: [394_000, 594_000] }, -1, shape);
    expect(r?.mode).toBe('range');
    expect(r?.taskLabel).toMatch(/^Range /);
  });
});

describe('stitched continuations in the whole run', () => {
  const eslint = fixtureModel('eslint-cli-wrapped');
  const qe = createQueries(eslint);
  const sc = {
    track: eslint.tracks[eslint.primaryTrack]?.id ?? '',
    transforms: [...DEFAULT_TRANSFORMS],
    range: null,
    hide: [] as number[],
  };
  const run = qe.waterfall(sc, -1, shape);

  it('marks the segments that resume after an await', () => {
    expect(run?.rows.some((r) => r.resumed)).toBe(true);
  });

  it('draws the time spent awaiting as idle rows between segments', () => {
    const waits = run?.rows.filter((r) => r.kind === 'wait' && /^awaiting/.test(r.name)) ?? [];
    expect(waits.length).toBeGreaterThan(0);
  });

  it('roots the run at the eslint entry script', () => {
    expect(run?.rows[0]?.name).toMatch(/eslint\.js$/);
  });
});

describe('task picker', () => {
  const tasks = q.tasks(scope);

  it('starts with the whole run, then the entry point, then the other groups', () => {
    expect(tasks[0]).toMatchObject({ group: 'Whole run', index: -1 });
    expect(tasks[1]?.group).toBe('Entry');
  });

  it('flags the longest task once and lists requests by label', () => {
    expect(tasks.filter((t) => t.longest)).toHaveLength(1);
    expect(tasks.some((t) => t.group === 'Requests' && t.label.endsWith('GET /orders'))).toBe(true);
  });

  it('puts trivial tasks under Small tasks', () => {
    const small = tasks.filter((t) => t.group === 'Small tasks');
    expect(small.length).toBeGreaterThan(0);
    expect(small.every((t) => t.trivial)).toBe(true);
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
    const base = (await run()).graph;
    const widest = base.nodes.reduce((a, n) =>
      n.hiddenCallers + n.hiddenCallees > a.hiddenCallers + a.hiddenCallees ? n : a,
    );
    expect(widest.hiddenCallers + widest.hiddenCallees).toBeGreaterThan(0);
    const after = (await run({ revealed: [widest.fn] })).graph.shownFns;
    expect(after).toBeGreaterThan(base.shownFns);
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

describe('origin filter', () => {
  const hide = (...origins: number[]) => ({ ...scope, hide: origins });
  const row = (name: string, sc = scope) => q.functions(sc, name).rows.find((r) => r.name === name);

  it('removes the hidden origin from the functions table', () => {
    expect(row('readFileUtf8')?.origin).toBe(4);
    expect(row('readFileUtf8', hide(4))).toBeUndefined();
  });

  it('moves the hidden self time to the caller, so totals do not shrink', () => {
    const before = row('readFileSync');
    const after = row('readFileSync', hide(4));
    expect(after?.selfUs).toBeGreaterThan(before?.selfUs ?? 0);
    expect(after?.totalUs).toBeCloseTo(before?.totalUs ?? 0, 0);
  });

  it('reports how much time each hidden origin held', () => {
    const [native] = q.hidden(hide(4));
    expect(native?.origin).toBe(4);
    expect(native?.selfUs).toBeGreaterThan(0);
    expect(q.hidden(scope)).toEqual([]);
  });

  it('applies to the waterfall rows too', () => {
    const names = q.waterfall(hide(4), -1, shape)?.rows.map((r) => r.name) ?? [];
    expect(names).not.toContain('readFileUtf8');
    expect(names).toContain('readFileSync');
  });

  it('narrows the functions table to one origin or one package', () => {
    const mine = q.functions(scope, '', { origins: [0] }).rows;
    expect(mine.every((r) => r.origin === 0)).toBe(true);
    const ajv = q.functions(collapsed, '', { pkg: 'ajv' }).rows;
    expect(ajv.length).toBeGreaterThan(0);
    expect(ajv.every((r) => r.pkg === 'ajv')).toBe(true);
  });
});

describe('hot paths', () => {
  it('lists the dominant call chains with their time, share and location', () => {
    const paths = q.hotPaths(scope, 4);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]?.names.at(-1)).toBe('lineTotal');
    expect(paths[0]?.share).toBeGreaterThan(0.5);
    expect(paths[0]?.loc).toMatch(/money\.ts:\d+$/);
    expect(paths.length).toBeLessThanOrEqual(4);
  });
});

describe('file outline', () => {
  it('lists the functions of the same file in line order', () => {
    const o = q.outline(scope, lineTotal);
    expect(o?.path).toMatch(/src\/util\/money\.ts$/);
    expect(o?.items.map((i) => i.name)).toContain('lineTotal');
    expect(o?.items.map((i) => i.name)).toContain('formatCurrency');
    const lines = (o?.items ?? []).map((i) => i.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it('has no outline for a collapsed package', () => {
    expect(q.outline(collapsed, ajvId())).toBeNull();
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
    expect(o.lanes[0]?.label).toBe('server');
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
    expect(q.describe(scope, { kind: 'task', track: main, task: 7 }).task?.label).toMatch(
      /GET \/orders$/,
    );
    expect(q.describe(scope, { kind: 'none' }).fn).toBeNull();
  });
});

describe('a hot path in a stitched run', () => {
  const wrapped = fixtureModel('eslint-cli-wrapped');
  const wq = createQueries(wrapped, null, nodeElk);
  const wscope = {
    track: wrapped.tracks[wrapped.primaryTrack]?.id ?? '',
    transforms: [...DEFAULT_TRANSFORMS],
    range: null,
    hide: [] as number[],
  };

  it('zooms to the whole chain even though a dependency frame sits above and inside it', async () => {
    const finding = wrapped.findings.find((f) => f.kind === 'hot-path');
    const zoomPath = String(finding?.showMe?.options?.['zoomPath'] ?? '')
      .split(',')
      .map(Number);
    const flame = await wq.flame(wscope, { sort: 'heavy', color: 'origin', zoom: [], zoomPath });
    const names = flame.crumbs.map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(zoomPath.length);
    expect(names).toContain('lintFiles');
    expect(names.at(-1)).toBe('parse');
  });
});

describe('deopt marks', () => {
  const deoptModel = fixtureModel('deopt-loop');
  const dq = createQueries(deoptModel, null, nodeElk);
  const dscope = {
    track: deoptModel.tracks[0]?.id ?? '',
    transforms: [...DEFAULT_TRANSFORMS],
    range: null,
    hide: [] as number[],
  };
  const price = dq.functions(dscope, 'price').rows.find((r) => r.name === 'price')?.fn ?? -1;

  it('puts the deopt count of price on its flame bars', () => {
    const f = dq.flame(dscope, { sort: 'heavy', color: 'origin', zoom: [], zoomPath: [] });
    const bars = Array.from({ length: f.length }, (_, i) => i).filter((i) => f.fn[i] === price);
    expect(bars.length).toBeGreaterThan(0);
    for (const i of bars) expect(f.deopts[i]).toBe(10);
  });

  it('puts it on the waterfall rows of price', () => {
    const wf = dq.waterfall(dscope, -1, { sort: 'time', minDurUs: 0 });
    const rows = (wf?.rows ?? []).filter((r) => r.kind === 'call' && r.fn === price);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.deopts).toBe(10);
  });

  it('lists the deopts of price with the source panel info', () => {
    expect(dq.source(dscope, price)?.deopts).toEqual([
      { line: 6, reason: 'wrong map', kind: 'eager', count: 10 },
    ]);
  });
});
