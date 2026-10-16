import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CdpProfile } from '@pacesjs/engine';
import { ImportError, importProfile } from '../src/import-profile.js';

let dir: string;
let profileText: string;
const opts = { name: 'p.cpuprofile', cwd: '/proj', mtimeMs: 2_000_000 };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paces-import-'));
  const r = spawnSync(
    process.execPath,
    [
      '--cpu-prof',
      '--cpu-prof-dir',
      dir,
      '-e',
      'let x=0;const t=Date.now();while(Date.now()-t<80){x+=Math.sqrt(x+1)}',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`node --cpu-prof failed: ${r.stderr}`);
  const file = readdirSync(dir).find((f) => f.endsWith('.cpuprofile'));
  profileText = readFileSync(join(dir, file as string), 'utf8');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('importProfile', () => {
  it('imports a real node --cpu-prof file as one track with its samples', () => {
    const capture = importProfile(profileText, opts);
    const parsed = JSON.parse(profileText) as CdpProfile;
    expect(capture.tracks).toHaveLength(1);
    expect(capture.tracks[0]?.cpuProfile?.samples).toHaveLength(parsed.samples.length);
    expect(capture.meta.command).toEqual(['import', 'p.cpuprofile']);
    expect(capture.meta.intervalUs).toBeGreaterThan(0);
  });

  it('imports a DevTools trace, rebuilding children from parent links', () => {
    const p = JSON.parse(profileText) as CdpProfile;
    const parentOf = new Map<number, number>();
    for (const n of p.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
    const nodes = p.nodes.map((n) => {
      const copy: Record<string, unknown> = { ...n, parent: parentOf.get(n.id) };
      delete copy.children;
      return copy;
    });
    const trace = {
      traceEvents: [
        { name: 'Profile', pid: 7, tid: 1, id: '0x1', args: { data: { startTime: p.startTime } } },
        {
          name: 'ProfileChunk',
          pid: 7,
          tid: 1,
          id: '0x1',
          args: { data: { cpuProfile: { nodes, samples: p.samples }, timeDeltas: p.timeDeltas } },
        },
        { name: 'Other', pid: 7, tid: 1 },
      ],
    };
    const capture = importProfile(JSON.stringify(trace), { ...opts, name: 'trace.json' });
    const imported = capture.tracks[0]?.cpuProfile;
    expect(capture.tracks[0]?.info.pid).toBe(7);
    expect(imported?.samples).toEqual(p.samples);
    const rebuilt = new Map(imported?.nodes.map((n) => [n.id, n.children ?? []]));
    const original = new Map(p.nodes.map((n) => [n.id, n.children ?? []]));
    expect([...rebuilt.entries()].map(([id, c]) => [id, [...c].sort()])).toEqual(
      [...original.entries()].map(([id, c]) => [id, [...c].sort()]),
    );
  });

  it('rejects non-JSON with guidance', () => {
    expect(() => importProfile('not json', opts)).toThrow(ImportError);
    expect(() => importProfile('not json', opts)).toThrow(/cpuprofile/);
  });

  it('rejects JSON that is neither a profile nor a trace', () => {
    expect(() => importProfile('{"a":1}', opts)).toThrow(
      /neither a .cpuprofile nor a DevTools trace/,
    );
  });

  it('rejects a trace without CPU samples', () => {
    expect(() => importProfile('{"traceEvents":[{"name":"X"}]}', opts)).toThrow(
      /no CPU profile samples/,
    );
  });
});
