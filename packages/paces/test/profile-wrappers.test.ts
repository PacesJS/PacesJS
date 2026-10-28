// What the preload does behind the tools people start programs with. These ran the whole CLI as
// end-to-end tests; the capture is the same through runProfile, without a host or a window.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultBrowserFlags, defaultReportFlags } from '../src/args.js';
import type { Flags } from '../src/args.js';
import { NoProcessesError, runProfile } from '../src/profile.js';

const preload = createRequire(import.meta.url).resolve('@pacesjs/collector-node/preload.cjs');
const root = resolve(import.meta.dirname, '..', '..', '..');
const BUSY = 'let x=0;const t=Date.now();while(Date.now()-t<150){x+=Math.sqrt(x+1)}';

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

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'paces-wrap-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (cwd: string, command: string[], over: Partial<Flags> = {}) =>
  runProfile({ cwd, preload, command, flags: flags(over) });

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

describe('wrappers around a Node program', () => {
  it('npm run: registers npm and the app it starts, and --exclude can drop npm and its helpers', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'app.js'), BUSY);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'wrap', version: '1.0.0', scripts: { start: 'node app.js' } }),
    );
    const all = await run(dir, ['npm', 'run', 'start']);
    expect(all.exitCode).toBe(0);
    expect(all.capture.tracks.length).toBeGreaterThanOrEqual(2);

    const filtered = await run(dir, ['npm', 'run', 'start'], { exclude: ['**/npm-*.js'] });
    expect(filtered.capture.tracks).toHaveLength(1);
  }, 60_000);

  it('npx: profiles a local bin started through npx', async () => {
    const dir = tempDir();
    installLocalTool(dir, 'busytool', BUSY);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'wrap', version: '1.0.0' }));
    const r = await run(dir, ['npx', '--no-install', 'busytool']);
    expect(r.exitCode).toBe(0);
    expect(r.capture.tracks.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('worker threads: each worker is a track under its process', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'workers.js'),
      `const { Worker, isMainThread } = require('worker_threads');
       if (isMainThread) { new Worker(__filename); new Worker(__filename); } else { ${BUSY} }`,
    );
    const r = await run(dir, ['node', 'workers.js']);
    const workers = r.capture.tracks.filter((t) => t.info.kind === 'worker');
    expect(workers).toHaveLength(2);
    const process = r.capture.tracks.find((t) => t.info.kind !== 'worker');
    expect(workers.every((w) => w.info.parent === process?.info.id)).toBe(true);
  }, 30_000);

  it('an ESM entry point is profiled', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'app.mjs'), `${BUSY}\nexport {};`);
    const r = await run(dir, ['node', 'app.mjs']);
    expect(r.exitCode).toBe(0);
    expect(r.capture.tracks).toHaveLength(1);
    expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
  }, 30_000);

  it('a command that starts no Node process fails with a clear error', async () => {
    const dir = tempDir();
    const command = process.platform === 'win32' ? ['cmd', '/c', 'exit', '0'] : ['true'];
    await expect(run(dir, command)).rejects.toThrow(NoProcessesError);
    await expect(run(dir, command)).rejects.toThrow(/No Node process loaded the profiler/);
  }, 30_000);

  // tsx, ts-node and nodemon only run when installed in this repo.
  const bin = (tool: string): string =>
    join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${tool}.cmd` : tool);
  it.each(['tsx', 'ts-node', 'nodemon'].filter((tool) => existsSync(bin(tool))))(
    '%s: registers the process it starts',
    async (tool) => {
      const dir = tempDir();
      const file = tool === 'nodemon' ? 'app.js' : 'app.ts';
      writeFileSync(join(dir, file), BUSY);
      const args = tool === 'nodemon' ? ['--exitcrash', '--once', file] : [file];
      const r = await run(dir, [bin(tool), ...args]);
      expect(r.exitCode).toBe(0);
      expect(r.capture.tracks.length).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );
});
