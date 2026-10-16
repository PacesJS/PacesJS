import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { readSession } from '../packages/format/dist/index.js';
import { PACES_CLI, ROOT, openAndClose, removeDir, runPaces, tempDir } from './helpers/cli.js';
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
          await fetch(`${u.origin}/api/heartbeat`, { method: 'POST', headers });
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
