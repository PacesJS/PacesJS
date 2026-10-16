import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { Origin } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { callersOf, hotPaths, packageBreakdown } from '../../src/query/paths.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const argv = ['node', '/project/src/app.js'];
const nameOf = (m: ExecutionModel, fn: number) => m.strings[m.functions.name[fn] ?? 0] ?? '';

describe('hotPaths on a known tree', () => {
  const m = analyze(
    synthCapture(
      [
        { stack: ['app', 'run', 'heavy'], samples: 50 },
        { stack: ['app', 'run', 'light'], samples: 5 },
        { stack: ['app', 'other'], samples: 5 },
      ],
      { argv },
    ),
  );

  it('ends the dominant chain where no single callee still carries the minimum share', () => {
    const [top] = hotPaths(m, 0, { minShare: 0.5 });
    expect(top?.fns.map((f) => nameOf(m, f))).toEqual(['app', 'run', 'heavy']);
    expect(top).toMatchObject({ selfUs: 50_000, totalUs: 50_000 });
    expect(top?.share).toBeCloseTo(50 / 60, 3);
  });

  it('carries source locations for each frame', () => {
    const [top] = hotPaths(m, 0, { minShare: 0.5 });
    expect(top?.locations.map((l) => l.name)).toEqual(['app', 'run', 'heavy']);
    expect(top?.locations[0]).toMatchObject({ file: 'src/app.js', line: 1 });
  });

  it('lists further chains by total time, up to the limit', () => {
    const paths = hotPaths(m, 0, { minShare: 0.04, limit: 2 });
    expect(paths.map((p) => nameOf(m, p.fns.at(-1) ?? 0))).toEqual(['heavy', 'light']);
  });

  it('skips chains below the minimum share', () => {
    expect(hotPaths(m, 0, { minShare: 0.9 }).map((p) => nameOf(m, p.fns.at(-1) ?? 0))).toEqual([
      'run',
    ]);
  });
});

describe('hotPaths inside the target code', () => {
  const dep = 'file:///project/node_modules/lib/index.js';
  const m = analyze(
    synthCapture(
      [
        {
          stack: ['app', 'handle', { name: 'libParse', url: dep }, { name: 'libInner', url: dep }],
          samples: 60,
        },
        { stack: ['app', 'handle'], samples: 10 },
      ],
      { argv },
    ),
  );

  it('ends at the last frame of the requested origin and counts dependency time inside it', () => {
    const [top] = hotPaths(m, 0, { minShare: 0.5, origin: Origin.User });
    expect(top?.fns.map((f) => nameOf(m, f))).toEqual(['app', 'handle']);
    expect(top?.totalUs).toBe(70_000);
    expect(top?.selfUs).toBe(70_000);
  });

  it('shows dependency frames when no origin is requested', () => {
    const [top] = hotPaths(m, 0, { minShare: 0.5 });
    expect(top?.fns.map((f) => nameOf(m, f))).toEqual(['app', 'handle', 'libParse', 'libInner']);
  });
});

describe('hotPaths on the eslint cli', () => {
  const m = loadModel('eslint-cli');
  const paths = hotPaths(m, m.primaryTrack, { origin: Origin.User, limit: 5 });

  it('finds chains of target functions ranked by total time', () => {
    expect(paths.length).toBeGreaterThan(1);
    const totals = paths.map((p) => p.totalUs);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(paths.every((p) => p.fns.every((f) => m.functions.origin[f] === Origin.User))).toBe(
      true,
    );
  });

  it('never exceeds the limit and reports shares of busy time', () => {
    expect(paths.length).toBeLessThanOrEqual(5);
    expect(paths.every((p) => p.share > 0 && p.share <= 1)).toBe(true);
  });

  it('is deterministic', () => {
    expect(hotPaths(m, m.primaryTrack, { origin: Origin.User, limit: 5 })).toEqual(paths);
  });

  it('rejects a track that does not exist', () => {
    expect(() => hotPaths(m, 99)).toThrow(/No track at index 99/);
  });
});

describe('packageBreakdown', () => {
  const m = loadModel('eslint-cli');

  it('lists the functions of one dependency by self time', () => {
    const rows = packageBreakdown(m, m.primaryTrack, 'typescript');
    expect(rows.length).toBeGreaterThan(10);
    const selfs = rows.map((r) => r.self);
    expect(selfs).toEqual([...selfs].sort((a, b) => b - a));
    expect(
      rows.every((r) => r.file.includes('node_modules/') && r.file.includes('typescript/')),
    ).toBe(true);
    expect(rows.every((r) => r.total >= r.self)).toBe(true);
  });

  it('carries name and location', () => {
    const [row] = packageBreakdown(m, m.primaryTrack, 'typescript');
    expect(row?.name).toBeTypeOf('string');
    expect(row?.line).toBeGreaterThan(0);
  });

  it('works for scoped plugin packages', () => {
    expect(packageBreakdown(m, m.primaryTrack, '@typescript-eslint/parser').length).toBeGreaterThan(
      0,
    );
  });

  it('returns nothing for an unknown package', () => {
    expect(packageBreakdown(m, m.primaryTrack, 'left-pad')).toEqual([]);
  });

  it('works for the target package too', () => {
    expect(packageBreakdown(m, m.primaryTrack, 'eslint').length).toBeGreaterThan(50);
  });
});

describe('callersOf', () => {
  const m = analyze(
    synthCapture(
      [
        { stack: ['main', 'a', 'f'], samples: 10 },
        { stack: ['main', 'b', 'f'], samples: 30 },
        { stack: ['main', 'b'], samples: 5 },
      ],
      { argv },
    ),
  );
  const fn = (name: string) =>
    Array.from({ length: m.functions.length }, (_, i) => i).find((i) => nameOf(m, i) === name) ??
    -1;

  it('lists direct callers by the time reached through them', () => {
    const callers = callersOf(m, 0, fn('f'), 1);
    expect(callers.map((c) => [c.name, c.weightUs])).toEqual([
      ['b', 30_000],
      ['a', 10_000],
    ]);
    expect(callers.every((c) => c.callers.length === 0)).toBe(true);
  });

  it('follows callers up to the requested depth', () => {
    const [b] = callersOf(m, 0, fn('f'), 2);
    expect(b?.callers.map((c) => c.name)).toEqual(['main']);
  });

  it('counts calls from the samples', () => {
    expect(callersOf(m, 0, fn('f'), 1)[0]?.calls).toBe(1);
  });

  it('stops at recursion instead of looping', () => {
    const rec = analyze(synthCapture([{ stack: ['main', 'r', 'r', 'r'], samples: 10 }], { argv }));
    const r =
      Array.from({ length: rec.functions.length }, (_, i) => i).find(
        (i) => rec.strings[rec.functions.name[i] ?? 0] === 'r',
      ) ?? -1;
    expect(callersOf(rec, 0, r, 5).length).toBeGreaterThan(0);
  });

  it('returns an empty list for a root function', () => {
    expect(callersOf(m, 0, fn('main'), 3)).toEqual([]);
  });
});

describe('hotPaths follow stitched continuations', () => {
  const rt = (name: string) => ({ name, url: 'node:internal/process/task_queues' });
  const m = analyze(
    synthCapture(
      [
        { stack: ['main', 'run', 'readAndVerify'], samples: 3 },
        { stack: ['main', 'run'], samples: 1 },
        { idle: 6 },
        { stack: [rt('processTicksAndRejections'), 'readAndVerify', 'verify'], samples: 40 },
        { idle: 3 },
      ],
      { argv },
    ),
  );

  it('reads one logical chain from the caller down to the work done after the await', () => {
    const [top] = hotPaths(m, 0, { minShare: 0.5 });
    expect(top?.fns.map((f) => nameOf(m, f))).toEqual(['main', 'run', 'readAndVerify', 'verify']);
  });

  it('leaves the entry root out of the chain', () => {
    const [top] = hotPaths(m, 0, { minShare: 0.01, limit: 1 });
    expect(top?.fns.includes(m.tracks[0]?.rootFn ?? -1)).toBe(false);
  });
});
