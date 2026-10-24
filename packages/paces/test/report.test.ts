import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_VERSION, analyze } from '@pacesjs/engine';
import type { ExecutionModel, RawCapture } from '@pacesjs/engine';
import { writeSession } from '@pacesjs/format';
import { parseArgs } from '../src/args.js';
import type { Flags } from '../src/args.js';
import { main } from '../src/commands.js';
import { shellArg } from '../src/report/format.js';
import { ReportError, renderReport } from '../src/report/report.js';
import type { SourceResolver } from '../src/source-resolver.js';

const fixture = (name: string): RawCapture =>
  JSON.parse(
    gunzipSync(
      readFileSync(new URL(`../../engine/test/fixtures/${name}.capture.json.gz`, import.meta.url)),
    ).toString('utf8'),
  ) as RawCapture;

let dir: string;
let eslintFile: string;
let ordersFile: string;
let eslint: ExecutionModel;

function flagsFrom(args: string[]): Flags {
  const parsed = parseArgs(['report', 'x.paces', ...args]);
  if (parsed.kind !== 'report') throw new Error('not a report');
  return parsed.flags;
}

function render(model: ExecutionModel, args: string[], resolver?: SourceResolver) {
  return renderReport(
    { model, file: 'S.paces', color: false, ...(resolver ? { resolver } : {}) },
    flagsFrom(args),
  );
}

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paces-report-'));
  const eslintCapture = fixture('eslint-cli');
  eslint = analyze(eslintCapture);
  eslintFile = join(dir, 'eslint.paces');
  writeFileSync(eslintFile, writeSession(eslintCapture, { engineVersion: ENGINE_VERSION }));
  ordersFile = join(dir, 'orders.paces');
  writeFileSync(
    ordersFile,
    writeSession(fixture('orders-server'), { engineVersion: ENGINE_VERSION }),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('report views stay inside the line budget', () => {
  it.each([
    ['summary', []],
    ['tree', ['--tree']],
    ['tree from a function', ['--from', 'runRules']],
    ['top', ['--top', 'self']],
    ['package', ['--pkg', '@typescript-eslint/utils']],
    ['lines', ['--lines', 'traverseSync']],
    ['callers', ['--callers', 'traverseSync']],
    ['phases', ['--phases']],
    ['tasks', ['--tasks']],
  ])('%s fits the default 60 lines and ends with next: commands', (_name, args) => {
    const { text } = render(eslint, args);
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(60);
    const at = lines.lastIndexOf('next:');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1).length).toBeGreaterThanOrEqual(1);
    expect(lines.slice(at + 1).length).toBeLessThanOrEqual(3);
    expect(lines.slice(at + 1).every((l) => l.startsWith('  paces report S.paces '))).toBe(true);
  });

  it('honors a smaller --max-lines and says what was left out', () => {
    const { text } = render(eslint, [
      '--tree',
      '--depth',
      '12',
      '--min-share',
      '0',
      '--max-lines',
      '20',
    ]);
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(text).toMatch(
      /… \d+ more rows \(raise --depth, lower --min-share, or drill with --from f\d+\)/,
    );
  });
});

describe('report content', () => {
  it('starts with the run kind, target, track and precision', () => {
    const header = render(eslint, []).text.split('\n')[1] ?? '';
    expect(header).toMatch(/^cli · eslint · entry .*eslint\.js · track eslint/);
    expect(header).toContain('±');
    expect(header).toContain('~ = sampled');
  });

  it('prints sampled times with ~ in ms', () => {
    expect(render(eslint, ['--tree', '--depth', '2']).text).toMatch(/~\d+ ms/);
  });

  it('tags dependencies by package and collapsed packages as such', () => {
    const { text } = render(eslint, ['--tree', '--depth', '4', '--min-share', '0.2%']);
    expect(text).toMatch(/▸ [@\w/-]+ \(collapsed\)/);
  });

  it('--expand shows the functions inside a plugin, --no-collapse shows them all', () => {
    const closed = render(eslint, [
      '--from',
      'runRules',
      '--depth',
      '6',
      '--min-share',
      '0.1%',
    ]).text;
    const open = render(eslint, [
      '--from',
      'runRules',
      '--depth',
      '6',
      '--min-share',
      '0.1%',
      '--expand',
      '@typescript-eslint/utils',
    ]).text;
    expect(closed).toContain('▸ @typescript-eslint/utils (collapsed)');
    expect(open).not.toContain('▸ @typescript-eslint/utils (collapsed)');
    expect(open).toContain('(@typescript-eslint/utils)');
    expect(
      render(eslint, ['--from', 'runRules', '--no-collapse', '--min-share', '0.1%']).text,
    ).not.toContain('(collapsed)');
  });

  it('--origin user hides the rest and moves their time up', () => {
    const { text } = render(eslint, ['--tree', '--origin', 'user', '--depth', '3']);
    expect(text).not.toContain('(native)');
    expect(text).not.toContain('(collapsed)');
  });

  it('--pkg lists the hot functions of one dependency with self time', () => {
    const { text } = render(eslint, ['--pkg', '@typescript-eslint/utils']);
    expect(text).toContain('package @typescript-eslint/utils');
    expect(text).toMatch(/self\s+~/);
  });

  it('--lines shows ms per line and the code when a source is available', () => {
    const resolver = {
      resolve: () => ({
        exists: true,
        text: Array.from({ length: 4000 }, (_, i) => `code of line ${i + 1}`).join('\n'),
        hash: 'h',
        changedSinceProfile: false,
        status: 'ok',
        origin: 'disk',
        hint: '',
      }),
      diskPath: () => undefined,
    } as unknown as SourceResolver;
    const { text } = render(eslint, ['--lines', 'traverseSync'], resolver);
    expect(text).toMatch(/▶\s+\d+\s+~[\d.]+ ms\s+\d+% │ code of line \d+/);
    expect(text).toContain('callee time under this function:');
  });

  it('--lines says so when the source text is unavailable', () => {
    expect(render(eslint, ['--lines', 'traverseSync']).text).toContain('source text not available');
  });

  it('--tasks lists the whole run first and --task drills into one task', () => {
    const tasks = render(eslint, ['--tasks']).text;
    expect(tasks).toContain('[task whole');
    const one = tasks.match(/\[task (\d+)\s*\]/)?.[1];
    expect(one).toBeDefined();
    expect(render(eslint, ['--tree', '--task', String(one)]).text).toContain(`task ${one}`);
  });

  it('is deterministic and ids are stable across renders', () => {
    const a = render(eslint, ['--tree']).text;
    expect(render(eslint, ['--tree']).text).toBe(a);
    const id = a.match(/\[(f\d+)\]/)?.[1] as string;
    expect(render(eslint, ['--tree', '--from', id]).text).toContain(`[${id}]`);
  });

  it('a name path matches descendants, not only children', () => {
    const { text } = render(eslint, [
      '--tree',
      '--from',
      'verify,runRules,traverseSync',
      '--depth',
      '2',
    ]);
    expect(text.split('\n')[2]).toMatch(/^traverseSync \[f\d+\]/);
  });

  it('works on a second real capture (orders-server)', () => {
    const orders = analyze(fixture('orders-server'));
    expect(render(orders, []).text).toContain('next:');
    expect(render(orders, ['--tasks']).text).toContain('[task');
  });
});

describe('--json', () => {
  const shape = (v: unknown): unknown =>
    Array.isArray(v)
      ? [v.length > 0 ? shape(v[0]) : 'empty']
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
        : typeof v;

  it('tree rows have a stable schema', () => {
    const { json } = render(eslint, ['--tree', '--depth', '2', '--json']);
    expect((json as { schemaVersion: number }).schemaVersion).toBe(1);
    expect(shape(json)).toMatchInlineSnapshot(`
      {
        "busyMs": "number",
        "durationMs": "number",
        "hiddenRows": "number",
        "next": [
          "string",
        ],
        "precisionMs": "number",
        "rootMs": "number",
        "rows": [
          {
            "collapsed": "boolean",
            "depth": "number",
            "file": "string",
            "folded": "number",
            "id": "string",
            "line": "number",
            "name": "string",
            "origin": "string",
            "package": "string",
            "selfMs": "number",
            "share": "number",
            "totalMs": "number",
          },
        ],
        "runKind": "string",
        "schemaVersion": "number",
        "target": {
          "entry": "string",
          "kind": "string",
          "packages": [
            "string",
          ],
        },
        "task": "string",
        "track": {
          "id": "string",
          "index": "number",
          "label": "string",
        },
        "view": "string",
      }
    `);
  });

  it('every view carries schemaVersion and view', () => {
    for (const args of [
      [],
      ['--top', 'self'],
      ['--phases'],
      ['--tasks'],
      ['--lines', 'runRules'],
      ['--callers', 'runRules'],
    ]) {
      const { json } = render(eslint, args);
      expect(json).toMatchObject({ schemaVersion: 1 });
      expect(json).toHaveProperty('view');
    }
  });

  it('the CLI prints it as one JSON document', async () => {
    const r = await cli(['report', eslintFile, '--top', 'self', '--limit', '3', '--json']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { rows: unknown[] }).rows).toHaveLength(3);
  });
});

describe('a profile file', () => {
  const profile = (): { text: string; dir: string } => {
    const out = mkdtempSync(join(dir, 'prof-'));
    const r = spawnSync(
      process.execPath,
      [
        '--cpu-prof',
        '--cpu-prof-dir',
        out,
        '-e',
        'let x=0;const t=Date.now();while(Date.now()-t<60){x+=Math.sqrt(x+1)}',
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`node --cpu-prof failed: ${r.stderr}`);
    const file = readdirSync(out).find((f) => f.endsWith('.cpuprofile')) as string;
    return { text: readFileSync(join(out, file), 'utf8'), dir: out };
  };

  it('reads a gzipped DevTools-style .json.gz like the plain file', async () => {
    const { text, dir: out } = profile();
    const plain = join(out, 'p.json');
    const gz = join(out, 'Trace-1.json.gz');
    writeFileSync(plain, text);
    writeFileSync(gz, gzipSync(text));

    const fromPlain = await cli(['report', plain, '--no-color']);
    const fromGz = await cli(['report', gz, '--no-color']);

    expect(fromGz.code).toBe(0);
    expect(fromGz.out.replaceAll('Trace-1.json.gz', 'p.json')).toBe(fromPlain.out);
  });
});

describe('errors', () => {
  it('an ambiguous selector lists candidates with ids and exits non-zero', async () => {
    const r = await cli(['report', eslintFile, '--tree', '--from', '(anonymous)']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('is ambiguous');
    expect(r.err).toMatch(/f\d+ {2}\(anonymous\)/);
    expect(r.err).toContain('Pick one by id');
  });

  it('an unknown selector explains the accepted forms', async () => {
    const r = await cli(['report', eslintFile, '--callers', 'noSuchFunctionAnywhere']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('file.js:123');
  });

  it('an unknown track and task are reported', () => {
    expect(() => render(eslint, ['--tree', '--track', 'nope'])).toThrow(ReportError);
    expect(() => render(eslint, ['--tree', '--task', '99999'])).toThrow(/task/);
  });

  it('bad flag values are usage errors', async () => {
    expect((await cli(['report', eslintFile, '--depth', '0'])).code).toBe(2);
    expect((await cli(['report', eslintFile, '--origin', 'martian'])).code).toBe(2);
  });
});

describe('terminal output', () => {
  it('has no ANSI escapes when stdout is not a TTY', async () => {
    const r = await cli(['report', eslintFile, '--lines', 'traverseSync']);
    expect(r.out).not.toContain('\u001b[');
  });

  it('uses them only when color is on', () => {
    const colored = renderReport(
      { model: eslint, file: 'S.paces', color: true },
      flagsFrom(['--tree', '--depth', '2']),
    );
    expect(colored.text).toContain('\u001b[');
    expect(render(eslint, ['--tree']).text).not.toContain('\u001b[');
  });
});

describe('selectors survive the shells', () => {
  it('shellArg quotes only when needed', () => {
    expect(shellArg('a,b,c')).toBe('a,b,c');
    expect(shellArg('C:\\work\\.paces\\x.paces')).toBe('C:\\work\\.paces\\x.paces');
    expect(shellArg('my file.paces')).toBe('"my file.paces"');
  });

  const cliPath = new URL('../dist/cli.js', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  );
  const args = ['report', '', '--tree', '--from', 'verify,runRules,traverseSync', '--depth', '1'];

  it.runIf(process.platform === 'win32')('PowerShell passes name paths with commas intact', () => {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `& node "${cliPath}" report "${eslintFile}" --tree --from verify,runRules,traverseSync --depth 1`,
      ],
      { encoding: 'utf8' },
    );
    expect(r.stdout).toContain('traverseSync');
    expect(r.status).toBe(0);
    expect(args.length).toBeGreaterThan(0);
  });

  it.skipIf(!spawnSync('bash', ['-c', 'true']).status === false)(
    'bash passes name paths and quoted selectors intact',
    () => {
      const script = `node "${cliPath.replaceAll('\\', '/')}" report "${eslintFile.replaceAll('\\', '/')}" --tree --from 'verify,runRules,traverseSync' --depth 1`;
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(r.stdout).toContain('traverseSync');
    },
  );
});

describe('paces guide', () => {
  it('prints a pasteable guide of at most 60 lines that names every view', async () => {
    const r = await cli(['guide']);
    expect(r.code).toBe(0);
    expect(r.out.split(/\r?\n/).length).toBeLessThanOrEqual(60);
    for (const word of [
      '--report',
      '--tree',
      '--callers',
      '--callees',
      '--lines',
      '--pkg',
      '--phases',
      '--tasks',
      '--json',
      'f123',
    ]) {
      expect(r.out).toContain(word);
    }
  });
});

describe('next: suggestions point somewhere useful', () => {
  it('suggests --lines for the hottest function in the target code, never GC or runtime glue', () => {
    const text = render(eslint, []).text;
    const lines = text.slice(text.lastIndexOf('next:')).split('\n');
    const lineCmd = lines.find((l) => l.includes('--lines '));
    expect(lineCmd).toBeDefined();
    const id = /--lines (f\d+)/.exec(lineCmd ?? '')?.[1] ?? '';
    const fn = Number(id.slice(1));
    expect(eslint.functions.origin[fn]).toBe(0); // Origin.User: the target's own code
  });

  it('points --lines at the hottest own function by self time over the whole run, not only the rows shown', () => {
    const out = render(eslint, []);
    const summary = (
      out.json as {
        summary: { topSelf: Array<{ name: string; file: string; line: number; origin: string }> };
      }
    ).summary;
    const expected = summary.topSelf.find((f) => f.origin === 'user' && f.file !== '');
    expect(expected).toBeDefined();
    const id = /--lines (f[0-9]+)/.exec(out.text.slice(out.text.lastIndexOf('next:')))?.[1] ?? '';
    const lines = render(eslint, ['--lines', id]).text;
    expect(lines.split(String.fromCharCode(10))[0]).toContain(`lines of ${expected?.name}`);
  });
  it('does not suggest a pass-through wrapper package as the package to drill into', () => {
    const text = render(eslint, []).text;
    const next = text.slice(text.lastIndexOf('next:'));
    expect(next).not.toContain('@humanwhocodes/retry');
  });
});
