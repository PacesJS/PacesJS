import { describe, expect, it } from 'vitest';
import { buildAgentSummary } from '../src/agent-summary.js';
import { analyze } from '../src/analyze.js';
import { FIXTURES, loadModel } from './helpers/fixtures.js';
import { synthCapture } from './helpers/synth.js';

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
    expect(summary.taskStats.longest[0]?.label).toBe(
      'main · load zoo/orders-server/dist/worker.js',
    );
    expect(summary.taskStats.longest.map((t) => t.label)).toContain('request · GET /orders');
  });

  it('states the sampling precision so numbers can be read honestly', () => {
    expect(summary.sampled).toBe(true);
    expect(summary.precisionMs).toBeCloseTo(1.6, 1);
  });

  it.each(FIXTURES)('builds for %s', (name) => {
    const s = buildAgentSummary(loadModel(name));
    expect(s.schemaVersion).toBe(2);
    expect(s.tracks.length).toBeGreaterThan(0);
  });
});

describe('agent summary for a command-line target', () => {
  const model = loadModel('eslint-cli');
  const summary = buildAgentSummary(model);

  it('says what was profiled', () => {
    expect(summary.target).toEqual({
      packages: ['eslint'],
      entry: model.target.entry,
      kind: 'cli',
    });
    expect(summary.runKind).toBe('cli');
    expect(summary.primaryTrack).toMatchObject({ index: model.primaryTrack });
    expect(summary.primaryTrack.label).toMatch(/^eslint · pid \d+$/);
  });

  it('marks tracks as target or supporting', () => {
    expect(summary.tracks.map((t) => t.role).sort()).toEqual(['support', 'target']);
  });

  it('lists the 25 functions with the most self time, from the target process', () => {
    expect(summary.topSelf).toHaveLength(25);
    const selfs = summary.topSelf.map((f) => f.selfMs);
    expect(selfs).toEqual([...selfs].sort((a, b) => b - a));
    expect(summary.topSelf[0]).toMatchObject({
      name: expect.any(String),
      origin: expect.any(String),
      pkg: expect.any(String),
      file: expect.any(String),
      line: expect.any(Number),
      share: expect.any(Number),
    });
  });

  it('shows target code and plugin code side by side', () => {
    const origins = new Set(summary.topSelf.map((f) => `${f.origin}:${f.pkg}`));
    expect([...origins].some((o) => o === 'user:eslint')).toBe(true);
    expect([...origins].some((o) => o.startsWith('dependency:'))).toBe(true);
  });

  it('gives the dominant call chains with locations', () => {
    expect(summary.hotPaths.length).toBeGreaterThan(0);
    expect(summary.hotPaths.length).toBeLessThanOrEqual(8);
    const totals = summary.hotPaths.map((p) => p.totalMs);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(summary.hotPaths[0]?.path.length).toBeGreaterThan(1);
    expect(summary.hotPaths[0]?.path[0]).toMatchObject({
      file: expect.any(String),
      line: expect.any(Number),
    });
  });

  it('breaks time down per package with each package top functions', () => {
    const eslint = summary.packages.find((p) => p.name === 'eslint');
    expect(eslint).toMatchObject({ isTarget: true });
    const plugin = summary.packages.find((p) => p.name === '@typescript-eslint/eslint-plugin');
    expect(plugin?.isTarget).toBe(false);
    expect(plugin?.topFunctions.length).toBeGreaterThan(0);
    expect(summary.packages.every((p) => p.topFunctions.length <= 3)).toBe(true);
    expect(summary.packages.every((p) => p.topFunctions.every((f) => f.pkg === p.name))).toBe(true);
    expect(summary.packages.every((p) => p.totalMs >= p.selfMs)).toBe(true);
  });

  it('lists the phases of the run in time order', () => {
    const phases = summary.phases;
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases[0]?.name).toBe('startup · module loading');
    expect(phases.map((p) => p.name)).toContain('main work');
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]?.startMs ?? 0).toBeGreaterThanOrEqual(
        (phases[i - 1]?.startMs ?? 0) + (phases[i - 1]?.durationMs ?? 0) - 0.2,
      );
    }
    const covered = phases.reduce((n, p) => n + p.durationMs, 0);
    expect(covered).toBeGreaterThan(
      summary.tracks.find((t) => t.id === summary.primaryTrack.id)!.durationMs * 0.9,
    );
  });

  it('carries aggregated caveats instead of per-file warnings', () => {
    const missing = summary.caveats.find((c) => c.kind === 'dependency-source-map-missing');
    expect(missing).toMatchObject({ severity: 'info' });
    expect(missing?.count).toBeGreaterThan(100);
    expect(missing?.details.length).toBeLessThanOrEqual(20);
    expect(summary.warnings).toEqual(summary.caveats.map((c) => c.summary));
  });

  it('stays compact enough to paste into an agent prompt', () => {
    expect(JSON.stringify(summary).length).toBeLessThan(40_000);
  });

  it('is plain JSON', () => {
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });
});

describe('agent summary phases', () => {
  const top = (url: string) => ({ name: '', url, line: 0, col: 0 });
  const model = analyze(
    synthCapture(
      [
        { stack: [top('file:///project/src/boot.js')], samples: 60 },
        { stack: ['loadConfig', top('file:///project/src/settings.js')], samples: 60 },
        { stack: ['run', 'compute'], samples: 60 },
        { idle: 60 },
      ],
      { argv: ['node', '/project/src/boot.js'] },
    ),
  );

  it('splits a run into startup, config loading, main work and waiting', () => {
    const names = buildAgentSummary(model).phases.map((p) => p.name);
    expect(names).toEqual(['startup · module loading', 'config loading', 'main work', 'waiting']);
  });

  it('gives each phase its time range and hottest functions', () => {
    const [startup, config, work] = buildAgentSummary(model).phases;
    expect(startup?.startMs).toBeLessThan(5);
    expect(config?.startMs).toBeCloseTo(60, -1);
    expect(work?.hottest[0]).toMatchObject({ name: 'compute', file: 'src/app.js', line: 1 });
  });
});
