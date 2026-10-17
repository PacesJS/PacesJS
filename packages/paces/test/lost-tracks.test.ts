import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { analyze, deserializeModel, serializeModel } from '@pacesjs/engine';
import type { RawCapture } from '@pacesjs/engine';
import { loadModel, readSession, writeSession } from '@pacesjs/format';
import { loadEngine } from '../src/engine.js';
import { detectLostTracks, lostTracksLines } from '../src/lost-tracks.js';

const reg = (id: string, pid: number, threadId = 0, argv = ['node', '/p/app.js']) => ({
  id,
  pid,
  threadId,
  argv,
});

describe('detectLostTracks', () => {
  const registered = [reg('p1', 1), reg('p2', 2), reg('p2-w1', 2, 1), reg('p3', 3)];

  it('reports tracks that registered but never wrote anything', () => {
    const lost = detectLostTracks({
      registered,
      delivered: new Set(['p1']),
      include: [],
      exclude: [],
      started: true,
    });
    expect(lost.map((l) => l.id)).toEqual(['p2', 'p2-w1', 'p3']);
    expect(lost[1]).toMatchObject({ kind: 'worker', pid: 2, threadId: 1 });
    expect(lost[0]).toMatchObject({ kind: 'process', pid: 2 });
  });

  it('reports nothing when every track delivered', () => {
    expect(
      detectLostTracks({
        registered,
        delivered: new Set(['p1', 'p2', 'p2-w1', 'p3']),
        include: [],
        exclude: [],
        started: true,
      }),
    ).toEqual([]);
  });

  it('does not count processes the user filtered out', () => {
    const lost = detectLostTracks({
      registered: [reg('p1', 1), reg('p2', 2, 0, ['node', '/p/jest-worker.js'])],
      delivered: new Set(['p1']),
      include: [],
      exclude: ['**/jest-worker.js'],
      started: true,
    });
    expect(lost).toEqual([]);
  });

  it('does not count processes outside --include', () => {
    const lost = detectLostTracks({
      registered: [reg('p1', 1), reg('p2', 2, 0, ['node', '/p/other.js'])],
      delivered: new Set(['p1']),
      include: ['**/app.js'],
      exclude: [],
      started: true,
    });
    expect(lost).toEqual([]);
  });

  it('counts nothing when profiling never started (--start-on signal never came)', () => {
    expect(
      detectLostTracks({
        registered,
        delivered: new Set(),
        include: [],
        exclude: [],
        started: false,
      }),
    ).toEqual([]);
  });

  it('labels each lost track', () => {
    const [p, w] = detectLostTracks({
      registered: [reg('p2', 20), reg('p2-w3', 20, 3)],
      delivered: new Set(),
      include: [],
      exclude: [],
      started: true,
    });
    expect(p?.label).toBe('process pid 20');
    expect(w?.label).toBe('worker thread 3 (pid 20)');
  });
});

describe('lostTracksLines', () => {
  const lost = Array.from({ length: 3 }, (_, i) => ({
    id: `p${i}`,
    pid: 100 + i,
    kind: 'process' as const,
    label: `process pid ${100 + i}`,
  }));

  it('says how many of how many were stopped, in one line plus one detail line', () => {
    const lines = lostTracksLines(lost, 4);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'paces: 3 of 4 processes were stopped before they could write a profile (killed workers or children?): their time is not in this session.',
    );
    expect(lines[1]).toBe('  process pid 100, process pid 101, process pid 102');
  });

  it('lists at most five and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      kind: 'process' as const,
      label: `l${i}`,
    }));
    expect(lostTracksLines(many, 9)[1]).toBe('  l0, l1, l2, l3, l4, and 3 more');
  });

  it('prints nothing when none were lost', () => {
    expect(lostTracksLines([], 4)).toEqual([]);
  });
});

describe('an old model cache with lost tracks', () => {
  it('shows the lost-tracks warning after loading a cache written without it', () => {
    const url = new URL('../../engine/test/fixtures/hot-regex.capture.json.gz', import.meta.url);
    const capture = JSON.parse(gunzipSync(readFileSync(url)).toString('utf8')) as RawCapture;
    const old = serializeModel(analyze(capture));
    expect(deserializeModel(old).meta.warnings.some((w) => w.kind === 'lost-tracks')).toBe(false);
    capture.meta.lostTracks = [{ id: 'p9', pid: 9, kind: 'process', label: 'process pid 9' }];
    const engine = loadEngine();
    const bytes = writeSession(capture, { engineVersion: engine.engineVersion, model: old });
    const loaded = loadModel(readSession(bytes, { engineVersion: engine.engineVersion }), engine);
    expect(loaded.fromCache).toBe(true);
    expect(loaded.model.meta.warnings.filter((w) => w.kind === 'lost-tracks')).toHaveLength(1);
  });
});
