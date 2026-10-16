import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { ORIGIN_NAMES } from '../../src/model.js';
import type { ExecutionModel } from '../../src/model.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';
import type { Step } from '../helpers/synth.js';

function functionsOf(model: ExecutionModel, fileIncludes: string) {
  const out: Array<{ name: string; origin: string; pkg: string; plumbing: boolean }> = [];
  for (let fn = 0; fn < model.functions.length; fn++) {
    const file = model.strings[model.functions.file[fn] ?? 0] ?? '';
    if (!file.includes(fileIncludes)) continue;
    out.push({
      name: model.strings[model.functions.name[fn] ?? 0] ?? '',
      origin: ORIGIN_NAMES[model.functions.origin[fn] ?? 0] ?? '',
      pkg: model.strings[model.functions.pkg[fn] ?? 0] ?? '',
      plumbing: model.functions.plumbing[fn] === 1,
    });
  }
  return out;
}

const work = (url: string): Step[] => [{ stack: [{ name: 'work', url }], samples: 50 }];

describe('target detection on real captures', () => {
  const wrapped = loadModel('eslint-cli-wrapped');
  const direct = loadModel('eslint-cli');

  it('makes the package the program lives in the target', () => {
    expect(wrapped.target.packages).toEqual(['eslint']);
    expect(wrapped.target.entry).toMatch(/node_modules\/eslint\/bin\/eslint\.js$/);
    expect(wrapped.target.kind).toBe('cli');
    expect(wrapped.meta.runKind).toBe('cli');
  });

  it("classifies the target package's own functions as user code and keeps the package name", () => {
    const linter = functionsOf(direct, 'node_modules/eslint/lib/linter/linter.js');
    expect(linter.length).toBeGreaterThan(5);
    expect(linter.every((f) => f.origin === 'user' && f.pkg === 'eslint')).toBe(true);
  });

  it("keeps the target's other dependencies as dependencies", () => {
    const plugin = functionsOf(direct, 'node_modules/@typescript-eslint/');
    expect(plugin.length).toBeGreaterThan(5);
    expect(plugin.every((f) => f.origin === 'dependency')).toBe(true);
    expect(plugin.some((f) => f.pkg.startsWith('@typescript-eslint/'))).toBe(true);
  });

  it("hides paces' own instrumentation as plumbing that is never user code", () => {
    const preload = functionsOf(direct, 'collector-node/dist/preload.cjs');
    expect(preload.length).toBeGreaterThan(0);
    expect(preload.every((f) => f.origin === 'node' && f.plumbing)).toBe(true);
  });

  it('marks launcher processes as supporting and the eslint process as primary', () => {
    const roles = wrapped.tracks.map((t) => t.role);
    expect(roles.filter((r) => r === 'support')).toHaveLength(2);
    const primary = wrapped.tracks[wrapped.primaryTrack];
    expect(primary?.role).toBe('target');
    expect(primary?.entry).toBe(wrapped.target.entry);
  });

  it('labels tracks by what they run', () => {
    expect(wrapped.tracks[wrapped.primaryTrack]?.label).toMatch(/^eslint · pid \d+$/);
    const support = wrapped.tracks.filter((t) => t.role === 'support').map((t) => t.label);
    expect(support.sort()).toEqual([
      expect.stringMatching(/^_launcher · pid \d+ \(supporting\)$/),
      expect.stringMatching(/^eslint-cli-wrapped · pid \d+ \(supporting\)$/),
    ]);
  });

  it('treats the zoo app that only spawns eslint as supporting too', () => {
    expect(direct.tracks.map((t) => t.role).sort()).toEqual(['support', 'target']);
    const support = direct.tracks.find((t) => t.role === 'support');
    expect(support?.label).toMatch(/^eslint-cli · pid \d+ \(supporting\)$/);
  });

  it('keeps a server as its own target without a package', () => {
    const orders = loadModel('orders-server');
    expect(orders.target.packages).toEqual([]);
    expect(orders.target.kind).toBe('server');
    expect(orders.tracks.every((t) => t.role === 'target')).toBe(true);
    expect(orders.tracks[orders.primaryTrack]?.kind).toBe('process');
  });

  it('falls back to the first loaded script when the capture has no argv', () => {
    const orders = loadModel('orders-server');
    expect(orders.target.entry).toBe('zoo/orders-server/dist/server.js');
    expect(orders.tracks[orders.primaryTrack]?.label).toMatch(/^server · pid \d+$/);
  });

  it('names workers by thread', () => {
    const orders = loadModel('orders-server');
    const worker = orders.tracks.find((t) => t.kind === 'worker');
    expect(worker?.label).toMatch(/^worker \d+ · thread \d+$/);
    expect(worker?.role).toBe('target');
  });
});

describe('entry script to target package', () => {
  it.each([
    [
      'pnpm',
      '/project/node_modules/.pnpm/eslint@9.39.5/node_modules/eslint/bin/eslint.js',
      'eslint',
    ],
    ['flat npm', '/project/node_modules/eslint/bin/eslint.js', 'eslint'],
    ['scoped', '/project/node_modules/@scope/tool/dist/cli.js', '@scope/tool'],
    [
      'Windows global',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\eslint\\bin\\eslint.js',
      'eslint',
    ],
    ['nested', '/project/node_modules/a/node_modules/b/bin/b.js', 'b'],
  ])('%s install', (_name, entry, pkg) => {
    const url = `file://${entry.replaceAll('\\', '/').replace(/^([A-Za-z]:)/, '/$1')}`;
    const capture = synthCapture(work(url.replace('/bin/', '/lib/')), {
      argv: ['node', entry],
      projectRoot: '/project',
    });
    // The profile runs a file of the same package as the entry.
    const model = analyze(capture);
    expect(model.target.packages).toEqual([pkg]);
    const fn = functionsOf(model, `node_modules/${pkg}/`).find((f) => f.name === 'work');
    expect(fn).toMatchObject({ origin: 'user', pkg });
  });

  it('uses the project as the target for a script outside node_modules', () => {
    const model = analyze(
      synthCapture(work('file:///project/src/app.js'), { argv: ['node', '/project/src/app.js'] }),
    );
    expect(model.target).toMatchObject({ packages: [], entry: 'src/app.js' });
  });

  it('keeps a faithful absolute path outside the project root', () => {
    const model = analyze(
      synthCapture(work('file:///C:/tools/x/lib/a.js'), {
        argv: ['node', 'C:\\tools\\x\\a.js'],
        projectRoot: 'C:\\Users\\me\\proj',
      }),
    );
    expect(model.target.entry).toBe('C:/tools/x/a.js');
    expect(model.strings).toContain('C:/tools/x/lib/a.js');
  });

  it('reads the entry from the loaded scripts when argv is missing', () => {
    const model = analyze(
      synthCapture(work('file:///project/node_modules/tool/lib/a.js'), {
        scripts: [
          { scriptId: '1', url: 'evalmachine.<anonymous>', sourceMapURL: '', hash: '' },
          {
            scriptId: '2',
            url: 'file:///project/packages/paces/dist/preload.cjs',
            sourceMapURL: '',
            hash: '',
          },
          {
            scriptId: '3',
            url: 'file:///project/node_modules/tool/bin/tool.js',
            sourceMapURL: '',
            hash: '',
          },
        ],
      }),
    );
    expect(model.target.packages).toEqual(['tool']);
    expect(model.target.entry).toBe('node_modules/tool/bin/tool.js');
  });
});

describe('track roles', () => {
  const small = (n: number): Step[] => [{ stack: ['small'], samples: n }];
  const big: Step[] = [{ stack: ['big'], samples: 500 }];

  it.each([
    ['npx', '/g/node_modules/npm/bin/npx-cli.js', 'npx'],
    ['npm', '/g/node_modules/npm/bin/npm-cli.js', 'npm'],
    ['pnpm', '/g/node_modules/pnpm/bin/pnpm.cjs', 'pnpm'],
    ['yarn', '/g/node_modules/yarn/bin/yarn.js', 'yarn'],
    ['cross-env', '/p/node_modules/cross-env/dist/bin/cross-env.js', 'cross-env'],
  ])('treats %s as a supporting launcher by name, even when it is busy', (_n, entry, label) => {
    const model = analyze(
      synthCapture(big, {
        argv: ['node', entry],
        extraTracks: [{ id: 'p2', steps: small(20), argv: ['node', '/p/app.js'] }],
      }),
    );
    expect(model.tracks.map((t) => t.role)).toEqual(['support', 'target']);
    expect(model.primaryTrack).toBe(1);
    expect(model.tracks[0]?.label).toBe(`${label} (supporting)`);
  });

  it('treats a quiet process that spawned the target as supporting', () => {
    const model = analyze(
      synthCapture(small(20), {
        argv: ['node', '/p/launcher.js'],
        extraTracks: [{ id: 'p2', steps: big, argv: ['node', '/p/app.js'], parent: 'p1' }],
      }),
    );
    expect(model.tracks.map((t) => t.role)).toEqual(['support', 'target']);
  });

  it('counts a grandparent launcher as having spawned the target', () => {
    const model = analyze(
      synthCapture(small(10), {
        argv: ['node', '/p/a.js'],
        extraTracks: [
          { id: 'p2', steps: small(10), argv: ['node', '/p/b.js'], parent: 'p1' },
          { id: 'p3', steps: big, argv: ['node', '/p/c.js'], parent: 'p2' },
        ],
      }),
    );
    expect(model.tracks.map((t) => t.role)).toEqual(['support', 'support', 'target']);
    expect(model.primaryTrack).toBe(2);
  });

  it('keeps a quiet process that spawned nothing as a target', () => {
    const model = analyze(
      synthCapture(small(20), {
        argv: ['node', '/p/side.js'],
        extraTracks: [{ id: 'p2', steps: big, argv: ['node', '/p/app.js'] }],
      }),
    );
    expect(model.tracks.map((t) => t.role)).toEqual(['target', 'target']);
    expect(model.primaryTrack).toBe(1);
  });

  it('makes workers follow the role of their process', () => {
    const model = analyze(
      synthCapture(big, {
        argv: ['node', '/p/app.js'],
        extraTracks: [{ id: 'w1', steps: small(30), kind: 'worker', threadId: 1, parent: 'p1' }],
      }),
    );
    expect(model.tracks[1]?.role).toBe('target');
    expect(model.tracks[1]?.label).toBe('worker 1 · thread 1');
    expect(model.primaryTrack).toBe(0);
  });
});

describe('explicit focus', () => {
  const url = 'file:///project/node_modules/foo/index.js';
  const capture = () => synthCapture(work(url), { argv: ['node', '/project/src/app.js'] });

  it('makes a named package first-party', () => {
    const model = analyze(capture(), { focus: ['foo'] });
    expect(model.target.packages).toEqual(['foo']);
    expect(functionsOf(model, 'node_modules/foo/')[0]).toMatchObject({
      origin: 'user',
      pkg: 'foo',
    });
  });

  it('makes files matching a path glob first-party', () => {
    const model = analyze(capture(), { focus: ['node_modules/foo/**'] });
    expect(functionsOf(model, 'node_modules/foo/')[0]?.origin).toBe('user');
  });

  it('replaces the package derived from the entry script', () => {
    const model = analyze(
      synthCapture(work('file:///project/node_modules/eslint/lib/a.js'), {
        argv: ['node', '/project/node_modules/eslint/bin/eslint.js'],
      }),
      { focus: ['other'] },
    );
    expect(model.target.packages).toEqual(['other']);
    expect(functionsOf(model, 'node_modules/eslint/')[0]?.origin).toBe('dependency');
  });
});

describe('run kind', () => {
  it.each(['sync-io', 'hot-regex', 'orders-server'] as const)('detects a server in %s', (name) => {
    expect(loadModel(name).meta.runKind).toBe('server');
  });

  it('calls a package binary a cli', () => {
    expect(loadModel('eslint-cli').meta.runKind).toBe('cli');
  });

  it('calls an arg-less project script a script', () => {
    const model = analyze(
      synthCapture(work('file:///project/src/app.js'), { argv: ['node', '/project/src/app.js'] }),
    );
    expect(model.meta.runKind).toBe('script');
  });

  it('calls a project script with arguments a cli', () => {
    const model = analyze(
      synthCapture(work('file:///project/src/app.js'), {
        argv: ['node', '/project/src/app.js', '--fix'],
      }),
    );
    expect(model.meta.runKind).toBe('cli');
  });

  it('honors an explicit override', () => {
    const model = analyze(synthCapture(work('file:///project/src/app.js')), { runKind: 'server' });
    expect(model.meta.runKind).toBe('server');
    expect(model.target.kind).toBe('server');
  });
});
