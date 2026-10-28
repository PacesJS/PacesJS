// The CLI end to end in this process, with the real engine and real child programs: what `paces
// --report`, `paces report` and the default session location do. Nothing here opens a window.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSession } from '@pacesjs/format';
import { main } from '../src/commands.js';

const root = resolve(import.meta.dirname, '..', '..', '..');
const hotRegex = join(root, 'zoo', 'apps', 'hot-regex.cjs');
const syncIo = join(root, 'zoo', 'apps', 'sync-io.cjs');
const killed = join(import.meta.dirname, 'fixtures', 'killed-children.cjs');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paces-cli-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(argv: string[], cwd = root) {
  const out: string[] = [];
  const err: string[] = [];
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const code = await main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    process.chdir(previous);
  }
}

describe('paces --report', () => {
  it('profiles, prints the report and the next commands, and opens no window or server', async () => {
    const file = join(dir, 'r.paces');
    const r = await cli(['--report', '--out', file, '--', 'node', hotRegex]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/http:\/\/127\.0\.0\.1/);
    expect(r.stdout).toContain('next:');
    expect(r.stdout).toContain(`paces report ${file}`);
    expect(r.stdout).not.toContain('\u001b[');
    expect(existsSync(file)).toBe(true);
  }, 60_000);

  it('mirrors the exit code of the target', async () => {
    const r = await cli([
      '--report',
      '--out',
      join(dir, 'exit.paces'),
      '--',
      'node',
      '-e',
      'let x=0;for(let i=0;i<3e6;i++)x+=i;process.exit(6)',
    ]);
    expect(r.code).toBe(6);
    expect(r.stdout).toContain('next:');
  }, 60_000);

  it('writes a default session to ./.paces/ under a Windows-safe timestamped name', async () => {
    const cwd = mkdtempSync(join(dir, 'cwd-'));
    const r = await cli(
      ['--report', '--', 'node', '-e', 'let x=0;for(let i=0;i<2e6;i++)x+=i'],
      cwd,
    );
    expect(r.code, r.stderr).toBe(0);
    const files = readdirSync(join(cwd, '.paces'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-\d{6}\.paces$/);
  }, 60_000);
});

describe('paces report on a saved session', () => {
  const session = (): string => join(dir, 'drill.paces');
  beforeAll(async () => {
    await cli(['--report', '--out', session(), '--', 'node', hotRegex]);
  }, 60_000);

  it('answers drill-down commands with the exact ids it printed', async () => {
    const tree = await cli(['report', session(), '--tree', '--depth', '3', '--max-lines', '30']);
    expect(tree.code, tree.stderr).toBe(0);
    const id = /\[(f\d+)\]/.exec(tree.stdout)?.[1] ?? '';
    expect(id).not.toBe('');
    const lines = await cli(['report', session(), '--lines', id]);
    expect(lines.code, lines.stderr).toBe(0);
    expect(lines.stdout).toContain(`[${id}]`);
  }, 60_000);

  it('exits 1 for a function that is nowhere in the session', async () => {
    const r = await cli(['report', session(), '--callers', 'noSuchFunctionAnywhere']);
    expect(r.code).toBe(1);
  });

  it('reads a node --cpu-prof file directly', async () => {
    const profDir = mkdtempSync(join(dir, 'prof-'));
    const run = spawnSync(process.execPath, ['--cpu-prof', '--cpu-prof-dir', profDir, hotRegex]);
    expect(run.status).toBe(0);
    const prof = readdirSync(profDir).find((f) => f.endsWith('.cpuprofile')) ?? '';
    const r = await cli(['report', join(profDir, prof), '--top', 'self', '--limit', '5']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('top functions by self time');
  }, 60_000);
});

describe('processes that were stopped before they could write', () => {
  it('are reported once, recorded in the session and named in the report caveats', async () => {
    const file = join(dir, 'k.paces');
    const r = await cli(['--report', '--out', file, '--', 'node', killed]);
    expect(r.code, r.stderr).toBe(0);
    const warning = r.stderr.split(/\r?\n/).filter((l) => l.includes('were stopped before'));
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain('3 of 4 processes were stopped before they could write a profile');
    expect(r.stderr).toMatch(/\n {2}(process pid|worker thread)/);
    const session = readSession(new Uint8Array(readFileSync(file)));
    expect(session.capture.meta.lostTracks).toHaveLength(3);
    expect(session.manifest.tracks).toHaveLength(1);
    expect(r.stdout).toMatch(/caveats:.*(stopped before|lost)/i);
    const json = await cli(['report', file, '--json']);
    expect(json.stdout).toMatch(/lost-tracks|stopped before/);
  }, 60_000);

  it('are not mentioned for a normal run', async () => {
    const file = join(dir, 'n.paces');
    const r = await cli(['--report', '--out', file, '--', 'node', syncIo]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('were stopped before');
    expect(readSession(new Uint8Array(readFileSync(file))).capture.meta.lostTracks).toBeUndefined();
  }, 60_000);
});
