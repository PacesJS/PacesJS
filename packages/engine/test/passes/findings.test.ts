import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { DEFAULT_THRESHOLDS } from '../../src/config.js';
import type { FindingKind } from '../../src/model.js';
import type { RuntimeEvent } from '../../src/raw.js';
import { loadCapture } from '../helpers/capture.js';
import { loadModel } from '../helpers/fixtures.js';
import type { FixtureName } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const kinds = (name: FixtureName): FindingKind[] => loadModel(name).findings.map((f) => f.kind);

describe('findings: each zoo app produces its planted finding and only that one', () => {
  it.each<[FixtureName, FindingKind]>([
    ['sync-io', 'sync-io'],
    ['hot-regex', 'hot-function'],
    ['gc-heavy', 'gc-pressure'],
    ['late-require', 'late-module-loading'],
    ['rxjs-chain', 'async-overhead'],
    ['worker-imbalance', 'hot-function'],
  ])('%s -> %s', (name, kind) => {
    expect(kinds(name)).toEqual([kind]);
  });
});

describe('findings on the orders server (several planted problems)', () => {
  const m = loadModel('orders-server');
  const find = (kind: FindingKind) => m.findings.filter((f) => f.kind === kind);

  it('reports the planted set, ranked by severity then impact', () => {
    expect(m.findings.map((f) => f.kind)).toEqual([
      'hot-function',
      'event-loop-blocked',
      'hot-function',
      'sync-io',
      'event-loop-lag',
    ]);
  });

  it('points the hot function finding at the hot line of lineTotal in the original source', () => {
    const f = find('hot-function')[0];
    expect(f?.summary).toContain('lineTotal');
    expect(f?.showMe).toMatchObject({ view: 'functions', line: 9, track: m.tracks[0]?.id });
    expect(m.strings[m.functions.file[f?.evidence[0] ?? 0] ?? 0]).toBe(
      'zoo/orders-server/src/util/money.ts',
    );
  });

  it('reports the same worker function once across both workers', () => {
    const crunch = find('hot-function').filter((f) => f.summary.startsWith('crunch'));
    expect(crunch.length).toBe(1);
  });

  it('opens the waterfall on the longest blocking request task with the critical path on', () => {
    const f = find('event-loop-blocked')[0];
    const tasks = m.tracks[0]?.tasks;
    const dur = (k: number) => (tasks?.end[k] ?? 0) - (tasks?.start[k] ?? 0);
    const steady = Array.from({ length: tasks?.length ?? 0 }, (_, k) => k).filter(
      (k) => tasks?.kind[k] !== 0,
    );
    expect(f?.summary).toMatch(/^14 tasks ran longer than 50 ms/);
    expect(f?.showMe).toMatchObject({ view: 'waterfall', options: { criticalPath: true } });
    expect(dur(f?.showMe.task ?? 0)).toBe(Math.max(...steady.map(dur)));
  });

  it('names the synchronous call and the user function that makes it', () => {
    const f = find('sync-io')[0];
    expect(f?.summary).toContain('fs.readFileSync');
    const fns = (f?.evidence ?? []).map((id) => m.strings[m.functions.name[id] ?? 0]);
    expect(fns).toEqual(['readFileSync', 'loadTemplate']);
    expect(f?.showMe.view).toBe('waterfall');
  });

  it('does not count startup work as blocking', () => {
    expect(find('event-loop-blocked')[0]?.rule).toContain('not counting startup');
  });
});

describe('findings: thresholds', () => {
  it('echoes the thresholds in each finding rule', () => {
    const findings = loadModel('orders-server').findings;
    expect(findings.find((f) => f.kind === 'event-loop-blocked')?.rule).toContain('50 ms');
    expect(findings.find((f) => f.kind === 'hot-function')?.rule).toContain('10%');
    expect(findings.find((f) => f.kind === 'event-loop-lag')?.rule).toContain('100 ms');
  });

  it('applies custom thresholds and shows them in the rule', () => {
    const m = analyze(loadCapture('orders-server'), {
      thresholds: { longTaskMs: 400, hotFunctionShare: 0.6 },
    });
    expect(m.findings.map((f) => f.kind)).toEqual(['sync-io', 'event-loop-lag']);
    const hot = analyze(loadCapture('hot-regex'), { thresholds: { hotFunctionShare: 0.05 } })
      .findings[0];
    expect(hot?.rule).toContain('5.0%');
  });

  it('exports the defaults from the spec', () => {
    expect(DEFAULT_THRESHOLDS).toMatchObject({
      longTaskMs: 50,
      hotFunctionShare: 0.1,
      hotDependencyShare: 0.2,
      gcShare: 0.1,
      gcPauseMs: 50,
      plumbingShare: 0.15,
      serializationShare: 0.05,
      loopLagP99Ms: 100,
    });
  });
});

describe('findings: rules without a zoo app', () => {
  const dep = (name: string) => ({
    name,
    url: 'file:///project/node_modules/heavy/lib/index.js',
    line: 3,
  });
  const request = (ms: number, duration: number): RuntimeEvent => ({
    type: 'request',
    time: 1_800_000_000_000 + ms,
    duration,
    method: 'GET',
    url: '/x',
    status: 200,
  });

  it('flags a hot dependency by package total time outside startup', () => {
    const m = analyze(
      synthCapture(
        [
          { stack: [dep('work'), 'inner'], samples: 60 },
          { stack: ['userWork'], samples: 20 },
        ],
        { events: [request(0, 100)] },
      ),
    );
    const f = m.findings.find((x) => x.kind === 'hot-dependency');
    expect(f?.summary).toMatch(/^heavy accounts for 75%/);
    expect(f?.showMe).toMatchObject({ view: 'callgraph', options: { expandPackage: 'heavy' } });
  });

  it('flags JSON.parse and JSON.stringify above 5% of busy time', () => {
    const m = analyze(
      synthCapture([
        { stack: ['handler', { name: 'JSON.stringify', url: '', line: -1, col: -1 }], samples: 20 },
        { stack: ['other'], samples: 80 },
      ]),
    );
    const f = m.findings.find((x) => x.kind === 'heavy-serialization');
    expect(f?.summary).toContain('20%');
    expect(f?.showMe).toMatchObject({ view: 'functions', options: { search: 'JSON' } });
  });

  it('flags a single GC pause over 50 ms even when GC share is low', () => {
    const m = analyze(
      synthCapture([{ stack: ['work'], samples: 1000 }], {
        events: [{ type: 'gc', time: 1_800_000_000_500, duration: 60, kind: 4 }],
      }),
    );
    const f = m.findings.find((x) => x.kind === 'gc-pressure');
    expect(f?.summary).toContain('60 ms');
    expect(f?.showMe.view).toBe('timeline');
  });

  it('flags event-loop lag from the p99 loop delay', () => {
    const m = analyze(
      synthCapture([{ stack: ['work'], samples: 400 }], {
        events: [
          { type: 'loop', time: 1_800_000_000_100, p50: 1, p99: 130, max: 140 },
          { type: 'loop', time: 1_800_000_000_200, p50: 1, p99: 20, max: 30 },
        ],
      }),
    );
    const lag = m.findings.filter((x) => x.kind === 'event-loop-lag');
    expect(lag.length).toBe(1);
    expect(lag[0]?.summary).toContain('130 ms');
  });

  it('stays quiet for a small healthy profile', () => {
    expect(analyze(synthCapture([{ stack: ['a'], samples: 5 }])).findings).toEqual([]);
  });
});
