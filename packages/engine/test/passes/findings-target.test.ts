import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { FindingKind } from '../../src/model.js';
import type { RuntimeEvent } from '../../src/raw.js';
import { loadCapture } from '../helpers/capture.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const argv = ['node', '/project/src/app.js'];
const LOCATION = /\(\S+:\d+\)/;

describe('findings for a command-line target', () => {
  const m = loadModel('eslint-cli');
  const kinds = m.findings.map((f) => f.kind);

  it('drops event-loop findings that are not actionable for a batch command', () => {
    expect(kinds).not.toContain('event-loop-lag');
    expect(kinds).not.toContain('event-loop-blocked');
  });

  it('can bring them back through suppressForCli', () => {
    const back = analyze(loadCapture('eslint-cli'), { suppressForCli: [] });
    expect(back.findings.map((f) => f.kind)).toContain('event-loop-blocked');
  });

  it('keeps them for a server run', () => {
    const forced = analyze(loadCapture('eslint-cli'), { runKind: 'server' });
    expect(forced.findings.map((f) => f.kind)).toContain('event-loop-blocked');
  });

  it('never calls the target itself a hot dependency', () => {
    const deps = m.findings.filter((f) => f.kind === 'hot-dependency');
    expect(deps.some((f) => /^eslint\b/.test(f.summary))).toBe(false);
    expect(deps.length).toBeGreaterThan(0);
  });

  it('names the hot dependency of the target and its hottest function with a location', () => {
    const dep = m.findings.find((f) => f.kind === 'hot-dependency');
    expect(dep?.summary).toMatch(LOCATION);
  });

  it('reports the dominant call chain inside the target code', () => {
    const f = m.findings.find((x) => x.kind === 'hot-path');
    expect(f?.title).toBe('Hot path');
    expect(f?.summary).toContain(' → ');
    expect(f?.summary).toMatch(LOCATION);
    expect(f?.summary).toMatch(/\d+% of busy time/);
    expect(f?.track).toBe(m.tracks[m.primaryTrack]?.id);
  });

  it('points the hot path finding at the flame graph zoomed to the chain', () => {
    const f = m.findings.find((x) => x.kind === 'hot-path');
    const ids = String(f?.showMe.options?.zoomPath ?? '')
      .split(',')
      .map(Number);
    expect(f?.showMe).toMatchObject({ view: 'flame', track: m.tracks[m.primaryTrack]?.id });
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(f?.showMe.fn).toBe(ids.at(-1));
    expect(f?.evidence.length).toBeGreaterThan(0);
  });

  it('does not report the launcher processes', () => {
    const tracks = new Set(m.findings.map((f) => f.track));
    const support = m.tracks.filter((t) => t.role === 'support').map((t) => t.id);
    expect(support.some((id) => tracks.has(id))).toBe(false);
  });
});

describe('hot-path finding rules', () => {
  const steps = [
    { stack: ['app', 'run', 'heavy'], samples: 80 },
    { stack: ['app', 'other'], samples: 20 },
  ];

  it('is reported for a script, with function and location', () => {
    const m = analyze(synthCapture(steps, { argv }));
    const f = m.findings.find((x) => x.kind === 'hot-path');
    expect(f?.summary).toMatch(
      /^app → run → heavy \(src\/app\.js:1\): ~80 ms total, 80% of busy time/,
    );
    expect(f?.severity).toBe('high');
  });

  it('is not reported for a server, where hot-function covers it', () => {
    const request: RuntimeEvent = {
      type: 'request',
      time: 1_800_000_000_000,
      duration: 100,
      method: 'GET',
      url: '/x',
      status: 200,
    };
    const m = analyze(synthCapture(steps, { argv, events: [request] }));
    expect(m.findings.map((f) => f.kind)).not.toContain('hot-path');
  });

  it('is not reported when no chain carries the configured share', () => {
    const flat = [
      { stack: ['app', 'a'], samples: 25 },
      { stack: ['app', 'b'], samples: 25 },
      { stack: ['app', 'c'], samples: 25 },
      { stack: ['app', 'd'], samples: 25 },
    ];
    const m = analyze(synthCapture(flat, { argv }), { thresholds: { hotPathShare: 0.5 } });
    expect(m.findings.map((f) => f.kind)).not.toContain('hot-path');
  });

  it('echoes the threshold in its rule', () => {
    const m = analyze(synthCapture(steps, { argv }));
    expect(m.findings.find((x) => x.kind === 'hot-path')?.rule).toContain('10%');
  });
});

describe('hot dependencies of a package target', () => {
  const tool = 'file:///project/node_modules/tool/lib/main.js';
  const heavy = 'file:///project/node_modules/heavy/index.js';
  const m = analyze(
    synthCapture(
      [
        {
          stack: [
            { name: 'run', url: tool },
            { name: 'parse', url: heavy },
          ],
          samples: 70,
        },
        { stack: [{ name: 'run', url: tool }], samples: 30 },
      ],
      { argv: ['node', '/project/node_modules/tool/bin/tool.js'] },
    ),
  );

  it('reports the dependency, not the target package', () => {
    const deps = m.findings.filter((f) => f.kind === 'hot-dependency');
    expect(deps.map((f) => f.summary.split(' ')[0])).toEqual(['heavy']);
  });

  it('counts startup time for a command, which has no steady state', () => {
    expect(m.findings.some((f) => f.kind === 'hot-dependency')).toBe(true);
  });
});

describe('findings name function and location', () => {
  const m = loadModel('orders-server');

  it.each<[FindingKind, RegExp]>([
    ['hot-function', /^lineTotal \(zoo\/orders-server\/src\/util\/money\.ts:6\)/],
    ['sync-io', /loadTemplate \(zoo\/orders-server\/src\/render\/template\.ts:\d+\)/],
    ['event-loop-blocked', /\(\S+:\d+\)/],
  ])('%s', (kind, pattern) => {
    expect(m.findings.find((f) => f.kind === kind)?.summary).toMatch(pattern);
  });

  it('shows the file and line of the late-loaded module', () => {
    const f = loadModel('late-require').findings[0];
    expect(f?.summary).toMatch(LOCATION);
  });
});
