import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { ENGINE_VERSION } from '../src/config.js';
import { loadCapture } from './helpers/capture.js';
import { loadModel } from './helpers/fixtures.js';
import { synthCapture } from './helpers/synth.js';

describe('analyze', () => {
  it('stamps the engine version and run metadata', () => {
    const m = loadModel('sync-io');
    expect(m.meta.engineVersion).toBe(ENGINE_VERSION);
    expect(m.meta.command).toEqual(['node', './zoo/apps/sync-io.cjs']);
    expect(m.meta.durationUs).toBeGreaterThan(200_000);
    expect(m.strings[0]).toBe('');
  });

  it('is deterministic: analyzing twice gives identical models', () => {
    const a = analyze(loadCapture('orders-server'));
    const b = analyze(loadCapture('orders-server'));
    expect(b).toEqual(a);
  });

  it('keeps a track without a CPU profile, empty, with a warning', () => {
    const capture = synthCapture([{ stack: ['a'], samples: 3 }]);
    const first = capture.tracks[0];
    if (!first) throw new Error('no track');
    const bare = {
      ...capture,
      tracks: [
        first,
        { info: { id: 'w1', kind: 'worker' as const, label: 'w' }, scripts: [], events: [] },
      ],
    };
    const m = analyze(bare);
    expect(m.tracks.length).toBe(2);
    expect(m.tracks[1]?.samples.length).toBe(0);
    expect(m.meta.warnings).toEqual(['Track w1 has no CPU profile; it is shown without samples.']);
  });

  it('handles a capture with no tracks', () => {
    const capture = synthCapture([{ stack: ['a'], samples: 1 }]);
    const m = analyze({ ...capture, tracks: [] });
    expect(m.tracks).toEqual([]);
    expect(m.findings).toEqual([]);
  });
});
