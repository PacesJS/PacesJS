import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { Origin } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { callTreeQuery, resolveSelector } from '../../src/query/tree.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const argv = ['node', '/project/src/app.js'];
const dep = 'file:///project/node_modules/lib/index.js';
const names = (_m: ExecutionModel, rows: Array<{ name: string }>) => rows.map((r) => r.name);

const m = analyze(
  synthCapture(
    [
      { stack: ['app', 'run', 'heavy'], samples: 50 },
      { stack: ['app', 'run', 'light'], samples: 6 },
      {
        stack: ['app', 'other', { name: 'libParse', url: dep }, { name: 'libInner', url: dep }],
        samples: 30,
      },
      { stack: ['app', 'other'], samples: 4 },
    ],
    { argv },
  ),
);

describe('callTreeQuery on a known tree', () => {
  it('lists rows depth first, heaviest child first, with exact microseconds', () => {
    const r = callTreeQuery(m, 0, { minShare: 0 });
    expect(names(m, r.rows)).toEqual([
      'src/app.js',
      'app',
      'run',
      'heavy',
      'light',
      'other',
      'lib',
    ]);
    expect(r.rows.map((x) => x.depth)).toEqual([0, 1, 2, 3, 3, 2, 3]);
    expect(r.rows[0]).toMatchObject({ totalUs: 90_000, selfUs: 0 });
    expect(r.rows[3]).toMatchObject({ totalUs: 50_000, selfUs: 50_000 });
  });

  it('collapses a dependency into one package row, expandable by name', () => {
    const collapsed = callTreeQuery(m, 0, { minShare: 0 });
    expect(collapsed.rows.at(-1)).toMatchObject({ synthetic: true, id: 'p:lib', totalUs: 30_000 });
    const open = callTreeQuery(m, 0, { minShare: 0, expandPkgs: ['lib'] });
    expect(
      names(
        m,
        open.rows.filter((x) => !x.synthetic),
      ),
    ).toContain('libParse');
    expect(
      names(
        m,
        open.rows.filter((x) => !x.synthetic),
      ),
    ).toContain('libInner');
    expect(
      callTreeQuery(m, 0, { minShare: 0, collapseDeps: false }).rows.some((x) => x.synthetic),
    ).toBe(false);
  });

  it('folds rows under the share threshold and says how many', () => {
    const r = callTreeQuery(m, 0, { minShare: 0.1 });
    expect(names(m, r.rows)).toEqual(['src/app.js', 'app', 'run', 'heavy', 'other', 'lib']);
    expect(r.rows.find((x) => x.name === 'run')?.folded).toBe(1);
    expect(r.hidden).toBe(1);
  });

  it('folds rows past the depth limit', () => {
    const r = callTreeQuery(m, 0, { minShare: 0, depth: 2 });
    expect(r.rows.every((x) => x.depth < 2)).toBe(true);
    expect(r.rows.find((x) => x.name === 'app')?.folded).toBe(5);
  });

  it('caps the number of rows', () => {
    const r = callTreeQuery(m, 0, { minShare: 0, maxRows: 3 });
    expect(r.rows.length).toBeLessThanOrEqual(4);
    expect(r.rows.length + r.hidden).toBe(r.available);
  });

  it('roots at a function with --from and shares stay relative to the whole run', () => {
    const sel = resolveSelector(m, 0, 'run').matches[0];
    const r = callTreeQuery(m, 0, { from: sel, minShare: 0 });
    expect(names(m, r.rows)).toEqual(['run', 'heavy', 'light']);
    expect(r.rows[0]?.totalUs).toBe(56_000);
    expect(r.rows[0]?.share).toBeCloseTo(56 / 90, 3);
    expect(r.rootUs).toBe(56_000);
  });

  it('hides origins and moves their self time up to the caller', () => {
    const r = callTreeQuery(m, 0, { minShare: 0, origins: [Origin.User], collapseDeps: false });
    const other = r.rows.find((x) => x.name === 'other');
    expect(other).toMatchObject({ totalUs: 34_000, selfUs: 34_000 });
    expect(r.rows.some((x) => x.name === 'libParse')).toBe(false);
  });

  it('orders siblings by self time or by execution order', () => {
    expect(names(m, callTreeQuery(m, 0, { minShare: 0, sort: 'time' }).rows).slice(0, 4)).toEqual([
      'src/app.js',
      'app',
      'run',
      'heavy',
    ]);
    const bySelf = callTreeQuery(m, 0, { minShare: 0, sort: 'self', depth: 3 });
    expect(bySelf.rows.filter((x) => x.depth === 2).map((x) => x.name)).toEqual(['other', 'run']);
  });

  it('rejects a task that does not exist', () => {
    expect(() => callTreeQuery(m, 0, { task: 999 })).toThrow(/No task 999/);
  });
});

describe('resolveSelector', () => {
  it('matches exact names before substrings and says which it used', () => {
    expect(resolveSelector(m, 0, 'heavy')).toMatchObject({ how: 'exact' });
    expect(resolveSelector(m, 0, 'eav')).toMatchObject({ how: 'substring' });
    expect(resolveSelector(m, 0, 'eav').matches).toHaveLength(1);
    expect(resolveSelector(m, 0, 'nothing').matches).toEqual([]);
  });

  it('matches anonymous functions by their displayed name', () => {
    const eslint = loadModel('eslint-cli');
    expect(
      resolveSelector(eslint, eslint.primaryTrack, '(anonymous)').matches.length,
    ).toBeGreaterThan(1);
  });

  it('is case sensitive', () => {
    expect(resolveSelector(m, 0, 'HEAVY').matches).toEqual([]);
  });

  it('resolves an id printed by an earlier query, the same way every time', () => {
    const id = callTreeQuery(m, 0, { minShare: 0 }).rows[3]?.id as string;
    expect(id).toMatch(/^f\d+$/);
    const a = resolveSelector(m, 0, id);
    expect(a.how).toBe('id');
    expect(a.matches).toHaveLength(1);
    expect(callTreeQuery(m, 0, { minShare: 0 }).rows[3]?.id).toBe(id);
  });

  it('matches name paths by descendant, not only by child', () => {
    const r = resolveSelector(m, 0, 'app,heavy');
    expect(r.how).toBe('path');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.path).toHaveLength(4);
    expect(resolveSelector(m, 0, 'other,heavy').matches).toEqual([]);
  });

  it('matches file suffix and definition line', () => {
    const fn = callTreeQuery(m, 0, { minShare: 0 }).rows[3];
    const r = resolveSelector(m, 0, `app.js:${fn?.line}`);
    expect(r.how).toBe('location');
    expect(r.matches.length).toBeGreaterThan(0);
  });
});

describe('on the eslint cli capture', () => {
  const model = loadModel('eslint-cli');
  const track = model.primaryTrack;

  it('finds runRules by name, by id and inside a path', () => {
    const byName = resolveSelector(model, track, 'runRules');
    expect(byName.matches.length).toBeGreaterThan(0);
    const top = byName.matches[0];
    expect(resolveSelector(model, track, `f${top?.fn}`).matches[0]?.fn).toBe(top?.fn);
    expect(
      resolveSelector(model, track, 'verify,runRules,traverseSync').matches.length,
    ).toBeGreaterThan(0);
  });

  it('roots at runRules and keeps dependency plugins collapsed until expanded', () => {
    const from = resolveSelector(model, track, 'runRules').matches[0];
    const closed = callTreeQuery(model, track, { from, depth: 8, minShare: 0.005 });
    expect(closed.rows[0]?.name).toBe('runRules');
    expect(closed.rows.some((r) => r.synthetic)).toBe(true);
    const pkg = closed.rows.find((r) => r.synthetic)?.pkg as string;
    const open = callTreeQuery(model, track, {
      from,
      depth: 8,
      minShare: 0.005,
      expandPkgs: [pkg],
    });
    expect(open.rows.some((r) => r.synthetic && r.pkg === pkg)).toBe(false);
    expect(open.rows.some((r) => r.pkg === pkg && !r.synthetic)).toBe(true);
  });

  it('numbers match the UI default view: root total equals the stitched view total', () => {
    const r = callTreeQuery(model, track, { minShare: 0 });
    expect(r.rootUs).toBe(r.viewUs);
    expect(r.rows[0]?.share).toBeGreaterThan(0.9);
  });
});
