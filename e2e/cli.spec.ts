import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { readSession } from '../packages/format/dist/index.js';
import {
  PACES_CLI,
  ROOT,
  goodbye,
  heartbeat,
  openAndClose,
  removeDir,
  runPaces,
  tempDir,
} from './helpers/cli.js';
import { engineReady } from './helpers/engine.js';

const APP = ['node', 'zoo/apps/hot-regex.cjs'];

async function profileInto(out: string): Promise<void> {
  await runPaces(['--no-open', '--out', out, '--', ...APP], {
    onUrl: async (url) => {
      await openAndClose(url);
    },
  });
}

test.describe('commands on a saved session', () => {
  test.beforeEach(async () => {
    test.skip(!(await engineReady()), 'the engine does not export the model functions yet');
  });

  test('open and diff serve a session and a baseline', async () => {
    const dir = tempDir();
    try {
      const a = join(dir, 'a.paces');
      const b = join(dir, 'b.paces');
      await profileInto(a);
      await profileInto(b);
      let hasBaseline: boolean | undefined;
      let baselineStatus = 0;
      const run = await runPaces(['diff', a, b, '--no-open'], {
        onUrl: async (url) => {
          const u = new URL(url);
          const headers = { 'x-paces-token': u.searchParams.get('token') ?? '' };
          const session = (await (await fetch(`${u.origin}/api/session`, { headers })).json()) as {
            hasBaseline: boolean;
          };
          hasBaseline = session.hasBaseline;
          baselineStatus = (await fetch(`${u.origin}/api/model?which=baseline`, { headers }))
            .status;
          await heartbeat(url);
          await goodbye(url);
        },
      });
      expect(run.code, run.stderr).toBe(0);
      expect([hasBaseline, baselineStatus]).toEqual([true, 200]);
    } finally {
      removeDir(dir);
    }
  });

  test('summary prints findings as text and as JSON', async () => {
    const dir = tempDir();
    try {
      const a = join(dir, 'a.paces');
      await profileInto(a);
      const text = await runPaces(['summary', a]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout.length).toBeGreaterThan(0);
      const json = await runPaces(['summary', a, '--json']);
      expect(() => JSON.parse(json.stdout)).not.toThrow();
    } finally {
      removeDir(dir);
    }
  });

  test('import turns a node --cpu-prof file into a session', async () => {
    const dir = tempDir();
    try {
      const r = spawnSync(
        process.execPath,
        ['--cpu-prof', '--cpu-prof-dir', dir, join(ROOT, 'zoo', 'apps', 'hot-regex.cjs')],
        { cwd: ROOT },
      );
      expect(r.status).toBe(0);
      const prof = join(dir, readdirSync(dir).find((f) => f.endsWith('.cpuprofile')) as string);
      const out = join(dir, 'imported.paces');
      const run = await runPaces(['import', prof, '--no-open', '--out', out], {
        onUrl: async (url) => {
          await openAndClose(url);
        },
      });
      expect(run.code, run.stderr).toBe(0);
      expect(readSession(new Uint8Array(readFileSync(out))).manifest.command[0]).toBe('import');
    } finally {
      removeDir(dir);
    }
  });

  test('mcp answers the official client over stdio', async () => {
    const dir = tempDir();
    try {
      const a = join(dir, 'a.paces');
      await profileInto(a);
      const req = createRequire(join(ROOT, 'packages', 'paces', 'package.json'));
      const { Client } = await import(
        pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href
      );
      const { StdioClientTransport } = await import(
        pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
      );
      const client = new Client({ name: 'e2e', version: '0.0.0' });
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [PACES_CLI, 'mcp', a] }),
      );
      const tools = await client.listTools();
      expect(tools.tools.map((t: { name: string }) => t.name)).toContain('summary');
      const result = await client.callTool({ name: 'summary', arguments: {} });
      expect(result.isError).toBeFalsy();
      await client.close();
    } finally {
      removeDir(dir);
    }
  });
});

test('the CLI writes default sessions to ./.paces/ with a Windows-safe timestamped name', async () => {
  const dir = tempDir();
  try {
    await runPaces(['--no-open', '--', 'node', '-e', 'let x=0;for(let i=0;i<2e6;i++)x+=i'], {
      cwd: dir,
      onUrl: async (url) => {
        await openAndClose(url);
      },
    });
    const files = existsSync(join(dir, '.paces')) ? readdirSync(join(dir, '.paces')) : [];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-\d{6}\.paces$/);
  } finally {
    removeDir(dir);
  }
});

test.describe('report mode', () => {
  test.beforeEach(async () => {
    test.skip(!(await engineReady()), 'the engine does not export the model functions yet');
  });

  test('--report profiles, prints the report and exits without a window or server', async () => {
    const dir = tempDir();
    try {
      const out = join(dir, 'r.paces');
      const run = await runPaces(['--report', '--out', out, '--', ...APP]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.url).toBeUndefined();
      expect(run.stdout).toContain('next:');
      expect(run.stdout).toContain(`paces report ${out}`);
      expect(run.stdout).not.toContain('\u001b[');
      expect(existsSync(out)).toBe(true);
    } finally {
      removeDir(dir);
    }
  });

  test('--report mirrors the exit code of the target', async () => {
    const dir = tempDir();
    try {
      const run = await runPaces([
        '--report',
        '--out',
        join(dir, 'r.paces'),
        '--',
        'node',
        '-e',
        'let x=0;for(let i=0;i<3e6;i++)x+=i;process.exit(6)',
      ]);
      expect(run.code).toBe(6);
      expect(run.stdout).toContain('next:');
    } finally {
      removeDir(dir);
    }
  });

  test('drill-down commands on the saved session answer with exact ids', async () => {
    const dir = tempDir();
    try {
      const out = join(dir, 'r.paces');
      await runPaces(['--report', '--out', out, '--', ...APP]);
      const tree = await runPaces(['report', out, '--tree', '--depth', '3', '--max-lines', '30']);
      expect(tree.code, tree.stderr).toBe(0);
      const id = /\[(f\d+)\]/.exec(tree.stdout)?.[1] as string;
      const again = await runPaces(['report', out, '--lines', id]);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain(`[${id}]`);
      const bad = await runPaces(['report', out, '--callers', 'noSuchFunctionAnywhere']);
      expect(bad.code).toBe(1);
    } finally {
      removeDir(dir);
    }
  });

  test('report reads a .cpuprofile directly', async () => {
    const dir = tempDir();
    try {
      const r = spawnSync(
        process.execPath,
        ['--cpu-prof', '--cpu-prof-dir', dir, join(ROOT, 'zoo', 'apps', 'hot-regex.cjs')],
        { cwd: ROOT },
      );
      expect(r.status).toBe(0);
      const prof = join(dir, readdirSync(dir).find((f) => f.endsWith('.cpuprofile')) as string);
      const run = await runPaces(['report', prof, '--top', 'self', '--limit', '5']);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain('top functions by self time');
    } finally {
      removeDir(dir);
    }
  });
});

test.describe('lost tracks', () => {
  test.beforeEach(async () => {
    test.skip(!(await engineReady()), 'the engine does not export the model functions yet');
  });

  test('killed children and workers are reported once and recorded in the session', async () => {
    const dir = tempDir();
    try {
      const out = join(dir, 'k.paces');
      const run = await runPaces([
        '--report',
        '--out',
        out,
        '--',
        'node',
        'e2e/fixtures/killed-children.cjs',
      ]);
      expect(run.code, run.stderr).toBe(0);
      const warning = run.stderr.split(/\r?\n/).filter((l) => l.includes('were stopped before'));
      expect(warning).toHaveLength(1);
      expect(warning[0]).toContain(
        '3 of 4 processes were stopped before they could write a profile',
      );
      expect(run.stderr).toMatch(/\n {2}(process pid|worker thread)/);
      const session = readSession(new Uint8Array(readFileSync(out)));
      expect(session.capture.meta.lostTracks).toHaveLength(3);
      expect(session.manifest.tracks).toHaveLength(1);
      expect(run.stdout).toMatch(/caveats:.*(stopped before|lost)/i);
      const json = await runPaces(['report', out, '--json']);
      expect(JSON.stringify(JSON.parse(json.stdout))).toMatch(/lost-tracks|stopped before/);
    } finally {
      removeDir(dir);
    }
  });

  test('a normal run prints no lost-track line and records none', async () => {
    const dir = tempDir();
    try {
      const out = join(dir, 'n.paces');
      const run = await runPaces(['--report', '--out', out, '--', 'node', 'zoo/apps/sync-io.cjs']);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).not.toContain('were stopped before');
      expect(
        readSession(new Uint8Array(readFileSync(out))).capture.meta.lostTracks,
      ).toBeUndefined();
    } finally {
      removeDir(dir);
    }
  });
});
