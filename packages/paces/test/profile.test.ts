import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Flags } from '../src/args.js';
import { nodeOptionsWith, runProfile } from '../src/profile.js';

const preload = createRequire(import.meta.url).resolve('@pacesjs/collector-node/preload.cjs');
const flags = (over: Partial<Flags> = {}): Flags => ({
  async: false,
  embedSources: false,
  noOpen: false,
  include: [],
  exclude: [],
  json: false,
  ...over,
});
const base = { cwd: resolve(import.meta.dirname, '..'), preload };
const node = (code: string) => ['node', '-e', code];
const busy = 'let x=0;const t=Date.now();while(Date.now()-t<60){x+=Math.sqrt(x+1)}';

describe('nodeOptionsWith', () => {
  it('appends to existing NODE_OPTIONS and quotes the path with forward slashes', () => {
    expect(nodeOptionsWith('--max-old-space-size=512', 'C:\\Program Files\\p\\preload.cjs')).toBe(
      '--max-old-space-size=512 --require "C:/Program Files/p/preload.cjs"',
    );
  });

  it('sets NODE_OPTIONS when there is none', () => {
    expect(nodeOptionsWith(undefined, '/p/preload.cjs')).toBe('--require "/p/preload.cjs"');
  });
});

describe('runProfile', () => {
  it('captures one track from a plain node command and mirrors exit code 0', async () => {
    const r = await runProfile({ ...base, command: node(busy), flags: flags() });
    expect(r.exitCode).toBe(0);
    expect(r.capture.tracks).toHaveLength(1);
    expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
    expect(r.capture.meta).toMatchObject({ mode: 'default', intervalUs: 1000, endedBy: 'exit' });
  });

  it('mirrors a non-zero exit code and still flushes the profile', async () => {
    const r = await runProfile({
      ...base,
      command: node(`${busy};process.exit(7)`),
      flags: flags(),
    });
    expect(r.exitCode).toBe(7);
    expect(r.capture.tracks[0]?.cpuProfile).toBeDefined();
  });

  it('records fine mode for a short interval', async () => {
    const r = await runProfile({ ...base, command: node(busy), flags: flags({ interval: 100 }) });
    expect(r.capture.meta).toMatchObject({ mode: 'fine', intervalUs: 100 });
  });

  it('keeps an existing NODE_OPTIONS in the child', async () => {
    const r = await runProfile({
      ...base,
      command: node(
        `process.exit(process.env.NODE_OPTIONS.includes('--max-old-space-size=300') ? 0 : 9)`,
      ),
      flags: flags(),
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=300' },
    });
    expect(r.exitCode).toBe(0);
  });

  it('registers a child process tree as separate linked tracks', async () => {
    const child = `require('child_process').spawnSync(process.execPath,['-e','${busy}'],{stdio:'inherit'})`;
    const r = await runProfile({ ...base, command: node(child), flags: flags() });
    const tracks = r.capture.tracks.map((t) => t.info);
    expect(tracks).toHaveLength(2);
    expect(tracks.filter((t) => t.parent !== undefined)).toHaveLength(1);
  });

  it('drops processes matching --exclude and keeps the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paces-excl-'));
    writeFileSync(join(dir, 'child.js'), busy);
    writeFileSync(
      join(dir, 'parent.js'),
      `require('child_process').spawnSync(process.execPath,[require('path').join(__dirname,'child.js')],{stdio:'inherit'});${busy}`,
    );
    const r = await runProfile({
      ...base,
      command: ['node', join(dir, 'parent.js')],
      flags: flags({ exclude: ['**/child.js'] }),
    });
    expect(r.capture.tracks).toHaveLength(1);
    expect(r.capture.tracks[0]?.info.parent).toBeUndefined();
  });

  it('promotes a track to root when its parent was filtered out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paces-orphan-'));
    writeFileSync(join(dir, 'child.js'), busy);
    writeFileSync(
      join(dir, 'parent.js'),
      `require('child_process').spawnSync(process.execPath,[require('path').join(__dirname,'child.js')],{stdio:'inherit'});${busy}`,
    );
    const r = await runProfile({
      ...base,
      command: ['node', join(dir, 'parent.js')],
      flags: flags({ exclude: ['**/parent.js'] }),
    });
    expect(r.capture.tracks).toHaveLength(1);
    expect(r.capture.tracks[0]?.info.parent).toBeUndefined();
  });

  it('fails clearly when no Node process registers', async () => {
    const command = process.platform === 'win32' ? ['cmd', '/c', 'exit', '0'] : ['true'];
    await expect(runProfile({ ...base, command, flags: flags() })).rejects.toThrow(
      /No Node process loaded the profiler/,
    );
  });

  it('fails clearly when the command does not exist', async () => {
    await expect(
      runProfile({ ...base, command: ['definitely-not-a-command-xyz'], flags: flags() }),
    ).rejects.toThrow(/not found/);
  });

  it('on interrupt: flushes, then runs the app own SIGINT handler and mirrors its exit code', async () => {
    const app = `
      process.on('SIGINT', () => { setTimeout(() => process.exit(42), 10); });
      const t = setInterval(() => { let x = 0; for (let i = 0; i < 1e5; i++) x += i; }, 5);
      require('fs').writeFileSync(process.env.READY, '1');`;
    const ready = join(mkdtempSync(join(tmpdir(), 'paces-ready-')), 'ready');
    let trigger: () => void = () => {};
    const result = runProfile({
      ...base,
      command: node(app),
      flags: flags(),
      env: { ...process.env, READY: ready },
      onInterrupt: (h) => {
        trigger = h;
        return () => {};
      },
    });
    await waitFor(() => existsSync(ready), 15);
    trigger();
    const r = await result;
    expect(r.exitCode).toBe(42);
    expect(r.capture.meta.endedBy).toBe('sigint');
    expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
  }, 20_000);

  it('with --duration: stops profiling after the window and leaves the app running', async () => {
    const app = `setInterval(() => { let x = 0; for (let i = 0; i < 1e5; i++) x += i; }, 5);`;
    const r = await runProfile({ ...base, command: node(app), flags: flags({ duration: 1 }) });
    expect(r.capture.meta.endedBy).toBe('duration');
    expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
    expect(r.child).toBeDefined();
    await r.child?.stop();
  }, 20_000);

  it.runIf(process.platform !== 'win32')(
    'with --start-on: waits for the signal',
    async () => {
      let fire: () => void = () => {};
      const app = `setInterval(() => { let x = 0; for (let i = 0; i < 1e5; i++) x += i; }, 5); setTimeout(() => process.exit(0), 1500);`;
      const run = runProfile({
        ...base,
        command: node(app),
        flags: flags({ startOn: 'SIGUSR2' }),
        onSignal: (_s, h) => {
          fire = h;
          return () => {};
        },
      });
      await new Promise((r) => setImmediate(r));
      fire();
      const r = await run;
      expect(r.capture.tracks[0]?.cpuProfile?.samples.length).toBeGreaterThan(0);
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'refuses --start-on on Windows with a way forward',
    async () => {
      await expect(
        runProfile({ ...base, command: node(busy), flags: flags({ startOn: 'SIGUSR2' }) }),
      ).rejects.toThrow(/--duration/);
    },
  );
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs * 1000;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
