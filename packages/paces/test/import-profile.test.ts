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

/** Every node's call path from the root, as text: stable however the nodes are numbered. */
function callPaths(nodes: CdpProfile['nodes']): Map<number, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const paths = new Map<number, string>();
  const walk = (id: number, prefix: string): void => {
    const n = byId.get(id);
    if (!n) return;
    const f = n.callFrame;
    const path = `${prefix}/${f.functionName}:${f.url}:${f.lineNumber}:${f.columnNumber}`;
    paths.set(id, path);
    for (const c of n.children ?? []) walk(c, path);
  };
  const children = new Set(nodes.flatMap((n) => n.children ?? []));
  for (const n of nodes) if (!children.has(n.id)) walk(n.id, '');
  return paths;
}

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
    // The importer numbers nodes in the order it meets them, so ids can differ from V8's: what has to
    // survive is each sample's call path and the shape of the tree.
    const samplePaths = (profile: CdpProfile | undefined): string[] => {
      const pathOf = callPaths(profile?.nodes ?? []);
      return (profile?.samples ?? []).map((id) => pathOf.get(id) ?? '?');
    };
    expect(samplePaths(imported)).toEqual(samplePaths(p));
    const shape = (profile: CdpProfile | undefined): string[] =>
      [...callPaths(profile?.nodes ?? []).values()].sort();
    expect(shape(imported)).toEqual(shape(p));
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
