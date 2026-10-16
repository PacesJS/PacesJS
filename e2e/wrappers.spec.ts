import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { readSession } from '../packages/format/dist/index.js';
import { ROOT, openAndClose, removeDir, runPaces, tempDir } from './helpers/cli.js';

const BUSY = 'let x=0;const t=Date.now();while(Date.now()-t<150){x+=Math.sqrt(x+1)}';

async function profile(dir: string, args: string[]) {
  const out = join(dir, 'out.paces');
  const run = await runPaces(['--no-open', '--out', out, '--', ...args], {
    cwd: dir,
    onUrl: async (url) => {
      await openAndClose(url);
    },
  });
  const session = existsSync(out) ? readSession(new Uint8Array(readFileSync(out))) : undefined;
  return { run, session };
}

/** A local bin that `npx --no-install` can find, with the shims npm would have written. */
function installLocalTool(dir: string, name: string, js: string): void {
  const pkg = join(dir, 'node_modules', name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', bin: { [name]: 'cli.js' } }),
  );
  writeFileSync(join(pkg, 'cli.js'), `#!/usr/bin/env node\n${js}\n`);
  const bin = join(dir, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, `${name}.cmd`), `@ECHO off\r\nnode "%~dp0\\..\\${name}\\cli.js" %*\r\n`);
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\nexec node "$(dirname "$0")/../${name}/cli.js" "$@"\n`,
    { mode: 0o755 },
  );
}

test.describe('wrapper matrix', () => {
  test('npm run: registers npm and the app it starts, and --exclude can drop npm itself and its helpers', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'app.js'), BUSY);
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'wrap', version: '1.0.0', scripts: { start: 'node app.js' } }),
      );
      const all = await profile(dir, ['npm', 'run', 'start']);
      expect(all.run.code, all.run.stderr).toBe(0);
      expect(all.session?.manifest.tracks.length).toBeGreaterThanOrEqual(2);
      expect(all.run.stderr).not.toContain('DEP0190');
      const noisy = all.run.stderr
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('paces:'));
      expect(noisy).toEqual([]);

      const out = join(dir, 'filtered.paces');
      const filtered = await runPaces(
        ['--no-open', '--out', out, '--exclude', '**/npm-*.js', '--', 'npm', 'run', 'start'],
        { cwd: dir, onUrl: async (u) => void (await openAndClose(u)) },
      );
      expect(filtered.code, filtered.stderr).toBe(0);
      const session = readSession(new Uint8Array(readFileSync(out)));
      expect(session.manifest.tracks).toHaveLength(1);
    } finally {
      removeDir(dir);
    }
  });

  test('npx: profiles a local bin started through npx', async () => {
    const dir = tempDir();
    try {
      installLocalTool(dir, 'busytool', BUSY);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'wrap', version: '1.0.0' }));
      const { run, session } = await profile(dir, ['npx', '--no-install', 'busytool']);
      expect(run.code, run.stderr).toBe(0);
      expect(session?.manifest.tracks.length).toBeGreaterThanOrEqual(1);
    } finally {
      removeDir(dir);
    }
  });

  test('child process tree: each Node process becomes a track linked to its parent', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'child.js'), BUSY);
      writeFileSync(
        join(dir, 'parent.js'),
        `require('child_process').spawnSync(process.execPath,[require('path').join(__dirname,'child.js')],{stdio:'inherit'});${BUSY}`,
      );
      const { run, session } = await profile(dir, ['node', 'parent.js']);
      expect(run.code, run.stderr).toBe(0);
      const tracks = session?.manifest.tracks ?? [];
      expect(tracks).toHaveLength(2);
      expect(tracks.filter((t) => t.parent !== undefined)).toHaveLength(1);
    } finally {
      removeDir(dir);
    }
  });

  test('worker threads: each worker is a track under its process', async () => {
    const dir = tempDir();
    try {
      writeFileSync(
        join(dir, 'workers.js'),
        `const { Worker, isMainThread } = require('worker_threads');
         if (isMainThread) { new Worker(__filename); new Worker(__filename); } else { ${BUSY} }`,
      );
      const { run, session } = await profile(dir, ['node', 'workers.js']);
      expect(run.code, run.stderr).toBe(0);
      const tracks = session?.manifest.tracks ?? [];
      expect(tracks.filter((t) => t.kind === 'worker')).toHaveLength(2);
    } finally {
      removeDir(dir);
    }
  });

  test('an ESM entry point is profiled', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'app.mjs'), `${BUSY}\nexport {};`);
      const { run, session } = await profile(dir, ['node', 'app.mjs']);
      expect(run.code, run.stderr).toBe(0);
      expect(session?.manifest.tracks).toHaveLength(1);
    } finally {
      removeDir(dir);
    }
  });

  test('a non-Node command fails with a clear error', async () => {
    const dir = tempDir();
    try {
      const command = process.platform === 'win32' ? ['cmd', '/c', 'exit', '0'] : ['true'];
      const run = await runPaces(['--no-open', '--', ...command], { cwd: dir });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('No Node process loaded the profiler');
    } finally {
      removeDir(dir);
    }
  });

  test('the exit code of the target is the exit code of paces', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'fail.js'), `${BUSY};process.exit(5)`);
      const { run } = await profile(dir, ['node', 'fail.js']);
      expect(run.code).toBe(5);
    } finally {
      removeDir(dir);
    }
  });

  // tsx, ts-node and nodemon only run when installed; otherwise they are reported as skipped.
  for (const tool of ['tsx', 'ts-node', 'nodemon']) {
    const bins = [
      join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${tool}.cmd` : tool),
    ];
    test(`${tool}: registers the process it starts`, async () => {
      test.skip(!bins.some((b) => existsSync(b)), `${tool} is not installed in this repo`);
      const dir = tempDir();
      try {
        const file = tool === 'nodemon' ? 'app.js' : 'app.ts';
        writeFileSync(join(dir, file), BUSY);
        const args = tool === 'nodemon' ? ['--exitcrash', '--once', file] : [file];
        const { run, session } = await profile(dir, [
          bins.find((b) => existsSync(b)) as string,
          ...args,
        ]);
        expect(run.code, run.stderr).toBe(0);
        expect(session?.manifest.tracks.length).toBeGreaterThanOrEqual(1);
      } finally {
        removeDir(dir);
      }
    });
  }
});
