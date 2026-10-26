// Characterization test for the safe-refactor run: pins the exact stdout (text and JSON, key order included) of
// every report view and MCP tool, the process environment `runProfile` builds, error messages of the file
// commands, and the source resolver's results. Hashes live in cli-golden.json; regenerate only with
// GOLDEN_WRITE=1 on unchanged code. Never regenerate to make a refactor pass.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, buildAgentSummary } from '@pacesjs/engine';
import type { ExecutionModel, RawCapture } from '@pacesjs/engine';
import { defaultBrowserFlags, defaultReportFlags, parseArgs } from '../../src/args.js';
import type { Flags } from '../../src/args.js';
import { main } from '../../src/commands.js';
import { handleMcpMessage } from '../../src/mcp.js';
import { buildTools } from '../../src/mcp-tools.js';
import { runProfile } from '../../src/profile.js';
import { renderReport } from '../../src/report/report.js';
import type { SourceResolver } from '../../src/source-resolver.js';
import { createSourceResolver } from '../../src/source-resolver.js';
import { globToRegExp, shouldProfile } from '../../src/glob.js';
import { planSpawn, quoteCmdArg } from '../../src/spawn-plan.js';
import { which } from '@pacesjs/shared';

const GOLDEN = new URL('./cli-golden.json', import.meta.url);
const WRITE = process.env['GOLDEN_WRITE'] === '1';
const expected: Record<string, string> = existsSync(GOLDEN)
  ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>)
  : {};
const actual: Record<string, string> = {};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function check(key: string, value: string): void {
  const got = digest(value);
  actual[key] = got;
  const dump = process.env['GOLDEN_DUMP'];
  if (dump) appendFileSync(dump, `${key} => ${JSON.stringify(value)}\n`);
  if (!WRITE) expect(got, key).toBe(expected[key]);
}

const load = (name: string): ExecutionModel =>
  analyze(
    JSON.parse(
      gunzipSync(
        readFileSync(
          new URL(`../../../engine/test/fixtures/${name}.capture.json.gz`, import.meta.url),
        ),
      ).toString('utf8'),
    ) as RawCapture,
  );

function flagsFrom(args: string[]): Flags {
  const parsed = parseArgs(['report', 'x.paces', ...args]);
  if (parsed.kind !== 'report') throw new Error('not a report');
  return parsed.flags;
}

const stubResolver: SourceResolver = {
  resolve: (requested) => ({
    exists: true,
    text: `// ${requested}\nfunction a() {\n  return 1;\n}\n`.repeat(40),
    hash: 'h',
    changedSinceProfile: false,
    status: 'ok',
    origin: 'disk',
    hint: '',
  }),
  diskPath: () => undefined,
};
const missingResolver: SourceResolver = {
  resolve: () => ({
    exists: false,
    text: '',
    hash: '',
    changedSinceProfile: false,
    status: 'missing',
    origin: 'disk',
    hint: 'gone',
  }),
  diskPath: () => undefined,
};

function renderAll(
  model: ExecutionModel,
  args: string[],
  color = false,
  resolver?: SourceResolver,
) {
  try {
    const out = renderReport(
      { model, file: 'S.paces', color, ...(resolver ? { resolver } : {}) },
      flagsFrom(args),
    );
    return `${out.text}\n--json--\n${JSON.stringify(out.json, null, 2)}`;
  } catch (e) {
    return `ERR ${(e as Error).name}: ${(e as Error).message}`;
  }
}

interface Case {
  fixture: string;
  fn: string;
  other: string;
  pkg: string;
}
const CASES: Case[] = [
  { fixture: 'eslint-cli', fn: 'traverseSync', other: 'runRules', pkg: '@typescript-eslint/utils' },
  { fixture: 'orders-server', fn: 'lineTotal', other: 'buildInvoiceRows', pkg: 'ajv' },
];

describe('report golden masters', () => {
  for (const c of CASES) {
    it(`${c.fixture}: every view`, () => {
      const model = load(c.fixture);
      const views: Array<[string, string[]]> = [
        ['summary', []],
        ['summary-json', ['--json']],
        ['tree', ['--tree']],
        ['tree-deep', ['--tree', '--depth', '12', '--min-share', '0']],
        ['tree-self', ['--tree', '--sort', 'self', '--min-ms', '5']],
        ['tree-time', ['--tree', '--sort', 'time', '--depth', '3']],
        ['tree-user', ['--tree', '--origin', 'user']],
        ['tree-nocollapse', ['--tree', '--no-collapse', '--depth', '4']],
        ['tree-expand', ['--tree', '--expand', c.pkg, '--depth', '5']],
        ['from', ['--from', c.other]],
        ['from-fn', ['--from', c.fn, '--depth', '3']],
        ['from-id', ['--from', 'f1']],
        ['from-missing', ['--from', 'doesNotExist']],
        ['callees', ['--callees', c.other]],
        ['callers', ['--callers', c.fn]],
        ['callers-other', ['--callers', c.other]],
        ['callers-root', ['--callers', 'f0']],
        ['callers-missing', ['--callers', 'doesNotExist']],
        ['top-self', ['--top', 'self']],
        ['top-total', ['--top', 'total']],
        ['top-user', ['--top', 'self', '--origin', 'user', '--limit', '5']],
        ['top-dep', ['--top', 'total', '--origin', 'dependency,framework']],
        ['pkg', ['--pkg', c.pkg]],
        ['pkg-missing', ['--pkg', 'no-such-pkg']],
        ['lines', ['--lines', c.fn]],
        ['phases', ['--phases']],
        ['tasks', ['--tasks']],
        ['task-pick', ['--task', '1', '--tree']],
        ['track-bad', ['--track', 'nope']],
      ];
      for (const [name, args] of views) {
        check(`${c.fixture}/${name}`, renderAll(model, args));
        check(`${c.fixture}/${name}/lines-ok`, renderAll(model, args, false, stubResolver));
      }
      check(
        `${c.fixture}/lines-missing`,
        renderAll(model, ['--lines', c.fn], false, missingResolver),
      );
      check(`${c.fixture}/tree-color`, renderAll(model, ['--tree'], true));
      check(`${c.fixture}/top-color`, renderAll(model, ['--top', 'self'], true));
      for (const n of [4, 8, 12, 20, 40, 100]) {
        for (const v of [
          ['--tree', '--depth', '12', '--min-share', '0'],
          ['--callers', c.fn],
          ['--top', 'self'],
          ['--lines', c.fn],
          ['--tasks'],
          ['--phases'],
          ['--pkg', c.pkg],
          [],
        ]) {
          check(
            `${c.fixture}/max${n}/${v.join('_')}`,
            renderAll(model, [...v, '--max-lines', String(n)], false, stubResolver),
          );
        }
      }
    });
  }
});

describe('MCP golden masters', () => {
  for (const c of CASES) {
    it(`${c.fixture}: every tool`, async () => {
      const model = load(c.fixture);
      const tools = buildTools(model, () => buildAgentSummary(model));
      const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
        JSON.stringify(
          await handleMcpMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
            tools,
          ),
          null,
          2,
        );
      const calls: Array<[string, Record<string, unknown>]> = [
        ['summary', {}],
        ['findings', {}],
        ['findings', { severity: 'high' }],
        ['findings', { severity: 'bogus' }],
        ['hot_paths', {}],
        ['hot_paths', { limit: 3, origin: 'user' }],
        ['hot_paths', { limit: 0 }],
        ['hot_paths', { origin: 'nope' }],
        ['top_functions', {}],
        ['top_functions', { sort: 'total', limit: 7 }],
        ['top_functions', { origin: 'dependency', limit: 5 }],
        ['top_functions', { package: c.pkg }],
        ['top_functions', { limit: 1.5 }],
        ['top_functions', { sort: 'x' }],
        ['top_functions', { package: '' }],
        ['package_breakdown', { package: c.pkg }],
        ['package_breakdown', {}],
        ['callers', { function: c.fn }],
        ['callers', { function: c.fn, depth: 4 }],
        ['callers', { function: c.other, depth: 1 }],
        ['callers', { function: 'doesNotExist' }],
        ['callers', { function: c.fn, file: 'zzz' }],
        ['callers', {}],
        ['phases', {}],
        ['nope', {}],
      ];
      for (const [name, args] of calls) {
        check(`mcp/${c.fixture}/${name}/${JSON.stringify(args)}`, await call(name, args));
      }
      check(
        `mcp/${c.fixture}/list`,
        JSON.stringify(
          await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools),
        ),
      );
      check(
        `mcp/${c.fixture}/init`,
        JSON.stringify(
          await handleMcpMessage(
            { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '1' } },
            tools,
          ),
        ),
      );
    });
  }
});

describe('CLI argument and file errors', () => {
  async function cli(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
    return JSON.stringify({ code, out: out.join('\n'), err: err.join('\n') });
  }
  it('prints exact messages for missing files and bad flags', async () => {
    for (const args of [
      ['report', 'no-such-file.paces'],
      ['import', 'no-such-file.cpuprofile'],
      ['summary', 'no-such-file.paces'],
      ['open', 'no-such-file.paces', '--no-open'],
      ['diff', 'a.paces', 'b.paces'],
      ['report', 'x.paces', '--top', 'sideways'],
      ['report', 'x.paces', '--origin', 'nope'],
      ['report', 'x.paces', '--depth', '0'],
      ['report', 'x.paces', '--max-lines', 'a'],
      ['--nonsense'],
      ['guide'],
    ]) {
      check(`cli/${args.join(' ')}`, await cli(args));
    }
  });
});

describe('runProfile environment', () => {
  const preload = createRequire(import.meta.url).resolve('@pacesjs/collector-node/preload.cjs');
  const flags = (over: Partial<Flags> = {}): Flags => ({
    async: false,
    v8: false,
    embedSources: false,
    browser: defaultBrowserFlags(),
    noOpen: false,
    include: [],
    exclude: [],
    json: false,
    focus: [],
    report: defaultReportFlags(),
    ...over,
  });
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'paces-golden-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function envOf(
    name: string,
    over: Partial<Flags>,
    env: NodeJS.ProcessEnv,
    onSignal?: (s: string, h: () => void) => () => void,
  ): Promise<string> {
    const out = join(dir, `${name}.json`);
    // The busy loop runs from a timer so a deferred (--start-on) profile can start before it.
    const delay = onSignal ? 600 : 0;
    const code = `const fs=require('fs');setTimeout(()=>{let x=0;const t=Date.now();while(Date.now()-t<80){x+=Math.sqrt(x+1)}fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(process.env))},${delay})`;
    const r = await runProfile({
      command: ['node', '-e', code],
      flags: flags(over),
      cwd: resolve(import.meta.dirname, '..'),
      preload,
      env: { ...env },
      ...(onSignal ? { onSignal } : {}),
    });
    const seen = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
    const keep: Record<string, string> = {};
    for (const k of Object.keys(seen).sort()) {
      if (k.startsWith('PACES_') || k === 'NODE_OPTIONS') keep[k] = seen[k] ?? '';
    }
    for (const k of ['PACES_DIR', 'PACES_SESSION', 'PACES_SOCKET']) if (keep[k]) keep[k] = `<${k}>`;
    if (keep['PACES_PARENT']?.match(/^p\d+/)) keep['PACES_PARENT'] = '<PACES_PARENT track>';
    if (keep['NODE_OPTIONS'])
      keep['NODE_OPTIONS'] = keep['NODE_OPTIONS'].replaceAll(
        preload.replaceAll('\\', '/'),
        '<preload>',
      );
    return JSON.stringify({
      env: keep,
      exit: r.exitCode,
      tracks: r.capture.tracks.length,
      mode: r.capture.meta.mode,
      intervalUs: r.capture.meta.intervalUs,
      endedBy: r.capture.meta.endedBy,
      lost: r.capture.meta.lostTracks ?? null,
      hasSamples: (r.capture.tracks[0]?.cpuProfile?.samples.length ?? 0) > 0,
    });
  }

  it('builds the child environment', async () => {
    const clean = { PATH: process.env['PATH'] ?? '' };
    check('env/plain', await envOf('plain', {}, clean));
    check('env/interval', await envOf('interval', { interval: 500 }, clean));
    check('env/async', await envOf('async', { async: true }, clean));
    check(
      'env/existing',
      await envOf(
        'existing',
        {},
        {
          ...clean,
          NODE_OPTIONS: '--max-old-space-size=256',
          PACES_PARENT: 'x',
          PACES_DEFER: '1',
          PACES_ASYNC: '1',
          PACES_INTERVAL: '77',
        },
      ),
    );
    let fire: () => void = () => {};
    const pending = envOf('starton', { startOn: 'SIGUSR2' }, clean, (_s, h) => {
      fire = h;
      return () => {};
    });
    await new Promise((r) => setImmediate(r));
    fire();
    check('env/start-on', await pending);
  }, 60_000);
});

describe('source resolver results', () => {
  let base: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'paces-golden-src-')));
    mkdirSync(join(base, 'project', 'src'), { recursive: true });
    writeFileSync(join(base, 'project', 'src', 'a.ts'), 'export const a = 1;\n');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('returns exact statuses and hints', () => {
    const root = join(base, 'project');
    const fileUrl = (p: string) => `file:///${p.replaceAll('\\', '/').replace(/^\//, '')}`;
    const map = JSON.stringify({
      version: 3,
      sources: ['../src/uri.ts', '../src/no-content.ts'],
      sourcesContent: ['export const uri = 1;\n', null],
    });
    const r = createSourceResolver({
      projectRoot: root,
      scriptUrls: [
        fileUrl(join(root, 'dist', 'bundle.js')),
        fileUrl(join(root, 'src', 'gone.js')),
        fileUrl(join(root, 'src', 'a.ts')),
      ],
      sourceMaps: { [fileUrl(join(root, 'dist', 'bundle.js'))]: map },
      embedded: new Map([['src/copy.ts', new TextEncoder().encode('copied')]]),
      startedAt: Date.now() + 60_000,
    });
    const asks = [
      join(root, 'src', 'a.ts'),
      `${fileUrl(join(root, 'src', 'a.ts'))}?x=1`,
      `${join(root, 'src', 'a.ts')}#frag`,
      join(root, 'src', 'gone.js'),
      join(root, 'src', 'never-loaded.js'),
      join(root, 'src', 'uri.ts'),
      join(root, 'src', 'no-content.ts'),
      `${join(root, 'src', 'gone.js')}?v=2`,
      'src/copy.ts',
      join(base, 'elsewhere.js'),
      fileUrl(join(base, 'elsewhere.js')),
      'node:fs',
      '',
      '../../etc/passwd',
    ];
    const slashBase = base.replaceAll('\\', '/');
    const label = (t: string): string =>
      t.replaceAll(base, '<base>').replaceAll(slashBase, '<base>').replaceAll('\\', '/');
    for (const ask of asks) {
      const res = r.resolve(ask);
      const norm = JSON.stringify({ ...res, hash: res.hash ? 'set' : '' });
      check(`resolver/${label(ask)}`, norm);
      check(`resolver-disk/${label(ask)}`, label(String(r.diskPath(ask))));
    }
  });
});

describe('glob, which and cmd quoting', () => {
  it('keeps their exact results', () => {
    for (const g of [
      '*',
      '**',
      '*.js',
      'a/**/b',
      'a?c',
      '[ab]*',
      '{a,b}',
      'C:\\x\\*.js',
      '**/node_modules/**',
      'x.y',
      'a+b(c)',
    ]) {
      check(`glob/${g}`, String(globToRegExp(g)));
    }
    const argvs = [
      ['node', '/p/app.js'],
      ['node', 'C:\\p\\app.js'],
      ['npx', 'eslint', '.'],
    ];
    for (const a of argvs) {
      for (const gl of ['*app*', '**/app.js', 'eslint', '*', 'C:/p/*', 'node']) {
        check(
          `shouldProfile/${a.join(' ')}/${gl}`,
          `${shouldProfile(a, [gl], [])}${shouldProfile(a, [], [gl])}${shouldProfile(a, [gl], [gl])}`,
        );
      }
    }
    for (const arg of [
      '',
      'a b',
      'a"b',
      'a\\',
      'a\\"b',
      'a b\\',
      '%PATH%',
      'a&b',
      '^',
      '(x)',
      'tab\there',
      "it's",
      'é',
      '"',
      '\\\\"',
    ]) {
      check(`quote/${JSON.stringify(arg)}`, `${quoteCmdArg(arg)}|${quoteCmdArg(arg, true)}`);
    }
    const present = new Set([
      'C:\\bin\\node.exe',
      'C:\\bin\\npx.cmd',
      'C:\\bin\\tool.BAT',
      'C:\\bin\\both.exe',
      'C:\\bin\\both.cmd',
      'D:\\x\\y.cmd',
      '/usr/bin/node',
    ]);
    const exists = (p: string): boolean => present.has(p);
    const winEnv = {
      Path: 'C:\\nowhere;C:\\bin',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ComSpec: 'C:\\cmd.exe',
    };
    const cmds = [
      ['node', '-e', '1'],
      ['npx', 'eslint', '.', 'a b', 'q"x', '%P%'],
      ['tool', 'x'],
      ['both', 'x'],
      ['D:\\x\\y.cmd', 'a b'],
      ['definitely-not-a-command-xyz'],
      ['y.cmd'],
    ];
    for (const cmd of cmds) {
      check(`plan-win/${cmd.join(' ')}`, JSON.stringify(planSpawn(cmd, winEnv, 'win32', exists)));
      check(
        `plan-posix/${cmd.join(' ')}`,
        JSON.stringify(planSpawn(cmd, { PATH: '/usr/bin' }, 'linux', exists)),
      );
      check(`which-win/${cmd[0]}`, String(which(cmd[0] ?? '', winEnv, 'win32', exists)));
      check(
        `which-win-noext/${cmd[0]}`,
        String(which(cmd[0] ?? '', { PATH: 'C:\\bin' }, 'win32', exists)),
      );
      check(
        `which-posix/${cmd[0]}`,
        String(which(cmd[0] ?? '', { PATH: '/usr/bin:/bin' }, 'linux', exists)),
      );
    }
  });
});

describe('golden file', () => {
  it('writes or checks the hash file', () => {
    if (WRITE) {
      const sorted = Object.fromEntries(
        Object.entries(actual).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      writeFileSync(GOLDEN, `${JSON.stringify(sorted, null, 1)}\n`);
    } else {
      expect(Object.keys(actual).length).toBe(Object.keys(expected).length);
    }
  });
});
