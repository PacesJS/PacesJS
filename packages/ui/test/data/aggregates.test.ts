import { describe, expect, it } from 'vitest';
import { buildCallGraph } from '../../src/data/callgraph';
import { flameData } from '../../src/data/flame';
import { functionDetails, functionsTable, sandwich } from '../../src/data/functions';
import { buildTView } from '../../src/data/tview';
import { buildWaterfall, longestTask, visibleRows } from '../../src/data/waterfall';
import { DEFAULT_TRANSFORMS } from '../../src/state/types';
import { matchCallSites } from '../../src/data/source';
import { createQueries } from '../../src/data/queries';
import { ORDERS, buildModel } from '../helpers/model-builder';
import { nodeElk } from '../helpers/node-elk';

const model = buildModel({ roots: ORDERS });
const track = model.tracks[0]!;
const fnId = (name: string): number =>
  Array.from(model.functions.name).findIndex((n) => model.strings[n] === name);
const tv = buildTView({ model, tracks: [track], transforms: DEFAULT_TRANSFORMS, range: null });

describe('functions table', () => {
  const res = functionsTable(model, tv, [track], null);

  it('sorts by self time, highest first', () => {
    expect(res.rows[0]?.name).toBe('fs.readFileSync');
    expect(res.rows[0]?.selfUs).toBe(37_000);
  });

  it('shows collapsed packages as one row', () => {
    expect(res.rows.map((r) => r.name)).toContain('ajv');
    expect(res.rows.find((r) => r.name === 'ajv')?.selfUs).toBe(15_000);
  });

  it('filters by name, file or package', () => {
    expect(functionsTable(model, tv, [track], null, 'money.ts').rows.map((r) => r.name)).toEqual([
      'lineTotal',
    ]);
    expect(functionsTable(model, tv, [track], null, 'AJV').rows).toHaveLength(1);
  });
});

describe('details and sandwich', () => {
  it('reports total, self, callers and callees with a self row', () => {
    const d = functionDetails(model, tv, [track], null, fnId('buildInvoiceRows'));
    expect(d?.totalUs).toBe(55_000);
    expect(d?.selfUs).toBe(20_000);
    expect(d?.callers.map((c) => c.name)).toEqual(['renderInvoice']);
    expect(d?.callers[0]?.frac).toBe(1);
    expect(d?.callees.map((c) => c.name)).toContain('self');
    expect(d?.callees.find((c) => c.name === 'self')?.frac).toBeCloseTo(20 / 55);
  });

  it('puts callers above and callees below, widths as a share of the function', () => {
    const rows = sandwich(model, tv, fnId('buildInvoiceRows'));
    expect(rows.filter((r) => r.level < 0).map((r) => r.name)).toContain('renderInvoice');
    const lineTotal = rows.find((r) => r.name === 'lineTotal');
    expect(lineTotal?.level).toBe(1);
    expect((lineTotal?.end ?? 0) - (lineTotal?.start ?? 0)).toBeCloseTo(20 / 55);
    expect(rows.find((r) => r.isSelf)?.name).toBe('self');
  });
});

describe('flame data', () => {
  it('starts with an all-samples root and orders heaviest first', () => {
    const f = flameData(model, tv, { sort: 'heavy', color: 'origin', zoom: [] });
    expect(f.node[0]).toBe(-1);
    expect(f.w[0]).toBe(1);
    const depth2 = Array.from({ length: f.length }, (_, i) => i).filter((i) => f.depth[i] === 2);
    expect(depth2.map((i) => f.x[i])).toEqual([0, expect.any(Number)]);
    expect(f.totalUs[depth2[0] ?? 0]).toBeGreaterThan(f.totalUs[depth2[1] ?? 0] ?? 0);
  });

  it('zooms into a frame so it fills the width', () => {
    const f0 = flameData(model, tv, { sort: 'heavy', color: 'origin', zoom: [] });
    const i = Array.from({ length: f0.length }, (_, k) => k).find((k) => f0.depth[k] === 1) ?? 0;
    const f1 = flameData(model, tv, { sort: 'heavy', color: 'origin', zoom: [f0.node[i] ?? 0] });
    expect(f1.w[0]).toBe(1);
    expect(f1.crumbs).toHaveLength(1);
  });
});

describe('waterfall', () => {
  const task = longestTask(track);

  it('selects the longest task by default', () => {
    expect(buildWaterfall(model, track, { transforms: [], task: -1 })?.taskIndex).toBe(task);
  });

  it('lists calls in execution order, indented by depth', () => {
    const w = buildWaterfall(model, track, { transforms: [], task: -1 });
    const names = w?.rows.map((r) => `${r.depth}:${r.name}`);
    expect(names?.slice(0, 4)).toEqual([
      '0:GET /orders',
      '1:getOrders',
      '2:authenticate',
      '2:renderInvoice',
    ]);
  });

  it('folds a dependency package into one row when dependencies are collapsed', () => {
    const w = buildWaterfall(model, track, { transforms: DEFAULT_TRANSFORMS, task: -1 });
    const ajv = w?.rows.find((r) => r.name.startsWith('ajv'));
    expect(ajv?.name).toBe('ajv ▸ validate');
    expect(ajv?.folded).toBe(1);
    expect(w?.rows.map((r) => r.name)).not.toContain('validateStep');
  });

  it('marks the widest child at each level as the critical path', () => {
    const w = buildWaterfall(model, track, { transforms: [], task: -1 });
    const crit = w?.rows.filter((r) => r.critical).map((r) => r.name);
    expect(crit).toEqual([
      'GET /orders',
      'getOrders',
      'renderInvoice',
      'buildInvoiceRows',
      'lineTotal',
      'Intl.NumberFormat',
    ]);
  });

  it('hides rows under a collapsed parent', () => {
    const w = buildWaterfall(model, track, { transforms: [], task: -1 });
    const parentIdx = w?.rows.findIndex((r) => r.name === 'getOrders') ?? -1;
    const vis = visibleRows(w?.rows ?? [], new Set([parentIdx]));
    expect(vis).toHaveLength(parentIdx + 1);
  });
});

describe('call graph', () => {
  const g = buildCallGraph(model, tv, [track], null, { all: true, reveal: [] });

  it('shows each function once with edge weights from caller to callee', () => {
    const names = g.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    const edge = g.edges.find(
      (e) => e.from === fnId('renderInvoice') && e.to === fnId('buildInvoiceRows'),
    );
    expect(edge?.timeUs).toBe(55_000);
  });

  it('prunes to the functions covering most of the time and counts the hidden ones', () => {
    const pruned = buildCallGraph(model, tv, [track], null, { all: false, reveal: [] });
    expect(pruned.shownFns).toBeLessThanOrEqual(pruned.totalFns);
    expect(pruned.shownFns).toBeGreaterThan(0);
  });

  it('draws recursion as a loop with a count, not as duplicate nodes', () => {
    const rec = buildModel({
      roots: [
        { fn: 'walk', self: 1, kids: [{ fn: 'walk', self: 1, kids: [{ fn: 'walk', self: 2 }] }] },
      ],
    });
    const rt = buildTView({ model: rec, tracks: rec.tracks, transforms: [], range: null });
    const rg = buildCallGraph(rec, rt, rec.tracks, null, { all: true, reveal: [] });
    expect(rg.nodes.filter((n) => n.name === 'walk')).toHaveLength(1);
    expect(rg.loops[0]?.count).toBe(2);
  });
});

describe('call-site chips', () => {
  it('pins a callee to the line that calls it', () => {
    const lines = [
      'export function load() {',
      "  const raw = fs.readFileSync(file, 'utf8');",
      '  return raw;',
      '}',
    ];
    const chips = matchCallSites(lines, [
      { fn: 1, name: 'fs.readFileSync', totalUs: 37_000, origin: 3 },
    ]);
    expect(chips).toEqual([expect.objectContaining({ lineIndex: 1, name: 'fs.readFileSync' })]);
  });
});

describe('queries facade', () => {
  const q = createQueries(model, null, nodeElk);
  const scope = { track: 'all', transforms: [...DEFAULT_TRANSFORMS], range: null };

  it('summarizes the run for the header', () => {
    const s = q.summary();
    expect(s.command).toEqual(['node', 'server.js']);
    expect(s.totalSamples).toBeGreaterThan(100);
  });

  it('describes selections of every kind', () => {
    expect(q.describe({ kind: 'fn', fn: fnId('lineTotal') }).name).toBe('lineTotal');
    expect(q.describe({ kind: 'task', track: 'main', task: 0 }).task?.label).toBe('GET /orders');
    expect(q.describe({ kind: 'none' }).fn).toBeNull();
  });

  it('computes a call-graph layout with positions for every node', async () => {
    const res = await q.callGraph(scope, { all: true, reveal: [] }, []);
    expect(res.layout.nodes).toHaveLength(res.graph.nodes.length);
  });

  it('keeps node positions identical when asked twice', async () => {
    const a = await q.callGraph(scope, { all: false, reveal: [] }, []);
    const b = await q.callGraph(scope, { all: false, reveal: [] }, []);
    expect(b.layout.nodes).toEqual(a.layout.nodes);
  });
});
