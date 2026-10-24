import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readSession } from '@pacesjs/format';
import { main } from '../src/commands.js';
import type { Io } from '../src/commands.js';

// The engine pipeline functions are exercised by the engine package; here they are small stand-ins so
// the CLI plumbing (files, server, window lifecycle, exit codes) is tested on its own.
vi.mock('@pacesjs/engine', () => {
  const encode = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
  return {
    ENGINE_VERSION: '9.9.9',
    analyze: (capture: { tracks: unknown[] }) => ({
      tracks: capture.tracks.length,
      findings: [{ kind: 'hot-function', severity: 'high', title: 'Hot function', summary: 'x' }],
    }),
    serializeModel: (m: unknown) => encode(m),
    deserializeModel: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)),
    buildAgentSummary: (m: { findings: unknown[] }) => ({ findings: m.findings }),
  };
});

let dir: string;
const BUSY = 'let x=0;const t=Date.now();while(Date.now()-t<60){x+=Math.sqrt(x+1)}';

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

/** Behaves like a UI window: loads the session, sends a heartbeat, then closes (goodbye beacon). */
async function closeWindowWhenReady(
  err: string[],
): Promise<{ session: unknown; baseline?: number }> {
  const end = Date.now() + 20_000;
  let url: string | undefined;
  while (!url) {
    url = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(err.join('\n'))?.[1];
    if (Date.now() > end) throw new Error(`no URL printed:\n${err.join('\n')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  const u = new URL(url);
  const headers = { 'x-paces-token': u.searchParams.get('token') ?? '' };
  const session = await (await fetch(`${u.origin}/api/session`, { headers })).json();
  const baseline = (await fetch(`${u.origin}/api/model?which=baseline`, { headers })).status;
  await fetch(`${u.origin}/api/heartbeat`, { method: 'POST', headers });
  // A page's pagehide beacon: heartbeat silence alone no longer counts as a closed window.
  await fetch(`${u.origin}/api/goodbye?token=${u.searchParams.get('token') ?? ''}`, {
    method: 'POST',
  });
  return { session, baseline };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paces-cmds-'));
  process.env.PACES_GRACE_MS = '150';
  process.env.PACES_CONFIG_DIR = join(dir, 'config');
  writeFileSync(join(dir, 'app.js'), BUSY);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function profileTo(file: string): Promise<void> {
  const c = capture();
  const done = main(['--no-open', '--out', file, '--', 'node', join(dir, 'app.js')], c.io);
  await closeWindowWhenReady(c.err);
  expect(await done).toBe(0);
}

describe('paces commands', () => {
  it('profile: saves the session with a model cache, serves it, and ends when the window closes', async () => {
    const file = join(dir, 'a.paces');
    await profileTo(file);
    const session = readSession(new Uint8Array(readFileSync(file)), { engineVersion: '9.9.9' });
    expect(session.manifest.tracks).toHaveLength(1);
    expect(session.model).toBeDefined();
  });

  it('profile: --embed-sources stores project files the run loaded', async () => {
    const file = join(dir, 'embed.paces');
    const c = capture();
    const previous = process.cwd();
    process.chdir(dir);
    const done = main(
      ['--no-open', '--embed-sources', '--out', file, '--', 'node', 'app.js'],
      c.io,
    );
    try {
      await closeWindowWhenReady(c.err);
      await done;
    } finally {
      process.chdir(previous);
    }
    const session = readSession(new Uint8Array(readFileSync(file)));
    expect(session.manifest.sources.map((s) => s.path)).toContain('app.js');
  });

  it('open: serves a saved session without a baseline', async () => {
    const file = join(dir, 'a.paces');
    await profileTo(file);
    const c = capture();
    const done = main(['open', file, '--no-open'], c.io);
    const { session, baseline } = await closeWindowWhenReady(c.err);
    expect(await done).toBe(0);
    expect((session as { hasBaseline: boolean }).hasBaseline).toBe(false);
    expect(baseline).toBe(404);
  });

  it('diff: serves the head with the first file as the baseline', async () => {
    const a = join(dir, 'a.paces');
    const b = join(dir, 'b.paces');
    await profileTo(a);
    await profileTo(b);
    const c = capture();
    const done = main(['diff', a, b, '--no-open'], c.io);
    const { session, baseline } = await closeWindowWhenReady(c.err);
    expect(await done).toBe(0);
    expect((session as { hasBaseline: boolean }).hasBaseline).toBe(true);
    expect(baseline).toBe(200);
  });

  it('summary: prints findings, or JSON with --json', async () => {
    const file = join(dir, 'a.paces');
    await profileTo(file);
    const text = capture();
    expect(await main(['summary', file], text.io)).toBe(0);
    expect(text.out.join('\n')).toContain('Hot function');
    const json = capture();
    expect(await main(['summary', file, '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({ findings: [{ kind: 'hot-function' }] });
  });

  it('import: turns a real .cpuprofile into a session', async () => {
    const { spawnSync } = await import('node:child_process');
    const profDir = join(dir, 'prof');
    spawnSync(process.execPath, ['--cpu-prof', '--cpu-prof-dir', profDir, join(dir, 'app.js')]);
    const { readdirSync } = await import('node:fs');
    const prof = join(profDir, readdirSync(profDir)[0] as string);
    const out = join(dir, 'imported.paces');
    const c = capture();
    const done = main(['import', prof, '--no-open', '--out', out], c.io);
    await closeWindowWhenReady(c.err);
    expect(await done).toBe(0);
    expect(readSession(new Uint8Array(readFileSync(out))).manifest.command[0]).toBe('import');
  });

  describe('a gzipped profile (DevTools saves traces as .json.gz)', () => {
    let gz: string;
    beforeAll(async () => {
      const { spawnSync } = await import('node:child_process');
      const { readdirSync } = await import('node:fs');
      const { gzipSync } = await import('node:zlib');
      const profDir = join(dir, 'prof-gz');
      spawnSync(process.execPath, ['--cpu-prof', '--cpu-prof-dir', profDir, join(dir, 'app.js')]);
      const prof = join(profDir, readdirSync(profDir)[0] as string);
      gz = join(dir, 'Trace-1.json.gz');
      writeFileSync(gz, gzipSync(readFileSync(prof)));
    });

    it('open: imports it instead of refusing it as a session', async () => {
      const c = capture();
      const done = main(['open', gz, '--no-open'], c.io);
      await closeWindowWhenReady(c.err);
      expect(await done).toBe(0);
      expect(c.err.join('\n')).toContain('imported');
    });

    it('import: turns it into a session', async () => {
      const out = join(dir, 'imported-gz.paces');
      const c = capture();
      const done = main(['import', gz, '--no-open', '--out', out], c.io);
      await closeWindowWhenReady(c.err);
      expect(await done).toBe(0);
      expect(readSession(new Uint8Array(readFileSync(out))).manifest.command[0]).toBe('import');
    });
  });

  it('reports a missing file with a way forward and exit code 2', async () => {
    const c = capture();
    expect(await main(['open', join(dir, 'missing.paces')], c.io)).toBe(2);
    expect(c.err.join('\n')).toContain('No such file');
  });

  it('refuses a file that is not a session, naming what to open instead', async () => {
    const junk = join(dir, 'junk.paces');
    writeFileSync(junk, 'this is not a zip');
    const c = capture();
    expect(await main(['summary', junk], c.io)).toBe(1);
    expect(c.err.join('\n')).toContain('not a .paces session');
  });

  it('prints usage for --help and fails an unknown flag with exit code 2', async () => {
    const help = capture();
    expect(await main(['--help'], help.io)).toBe(0);
    expect(help.out.join('\n')).toContain('paces open');
    const bad = capture();
    expect(await main(['--nope', '--', 'node'], bad.io)).toBe(2);
  });
});
