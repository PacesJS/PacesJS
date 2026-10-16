import { describe, expect, it } from 'vitest';
import { buildAgentSummary } from '../src/agent-summary.js';
import { FIXTURES, loadModel } from './helpers/fixtures.js';

describe('agent summary', () => {
  const summary = buildAgentSummary(loadModel('orders-server'));

  it('is plain JSON that survives a round trip', () => {
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('lists the findings with source locations a coding agent can open', () => {
    const hot = summary.findings.find((f) => f.kind === 'hot-function');
    expect(hot?.evidence[0]).toEqual({
      name: 'lineTotal',
      file: 'zoo/orders-server/src/util/money.ts',
      line: 6,
    });
    expect(hot?.showMe).toMatchObject({ view: 'functions', name: 'lineTotal', line: 9 });
    const sync = summary.findings.find((f) => f.kind === 'sync-io');
    expect(sync?.showMe).toMatchObject({ view: 'waterfall', name: 'loadTemplate' });
    expect(summary.findings.map((f) => f.kind)).toEqual(
      loadModel('orders-server').findings.map((f) => f.kind),
    );
  });

  it('names the hottest paths without plumbing frames', () => {
    const top = summary.hotPaths[0];
    expect(top?.path.at(-1)?.name).toBe('lineTotal');
    expect(top?.path.map((p) => p.name)).toContain('buildInvoiceRows');
    expect(top?.share).toBeGreaterThan(0.4);
  });

  it('ranks functions by self time with origin and package', () => {
    expect(summary.topFunctions[0]).toMatchObject({ name: 'lineTotal', origin: 'user', pkg: '' });
    const selfs = summary.topFunctions.map((f) => f.selfMs);
    expect(selfs).toEqual([...selfs].sort((a, b) => b - a));
  });

  it('summarizes tasks by kind and lists the longest', () => {
    expect(summary.taskStats.byKind.request?.count).toBeGreaterThanOrEqual(14);
    expect(summary.taskStats.longTasks).toBeGreaterThanOrEqual(14);
    expect(summary.taskStats.longest[0]?.label).toBe('worker.js');
    expect(summary.taskStats.longest.map((t) => t.label)).toContain('GET /orders');
  });

  it('states the sampling precision so numbers can be read honestly', () => {
    expect(summary.sampled).toBe(true);
    expect(summary.precisionMs).toBeCloseTo(1.6, 1);
  });

  it.each(FIXTURES)('builds for %s', (name) => {
    const s = buildAgentSummary(loadModel(name));
    expect(s.schemaVersion).toBe(1);
    expect(s.tracks.length).toBeGreaterThan(0);
  });
});
