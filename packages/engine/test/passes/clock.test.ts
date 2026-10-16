import { describe, expect, it } from 'vitest';
import { alignClock } from '../../src/passes/clock.js';
import { loadCapture } from '../helpers/capture.js';

describe('clock alignment', () => {
  it('places the profile inside the wall-clock window of the run', () => {
    const capture = loadCapture('orders-server');
    const main = capture.tracks[0]?.cpuProfile;
    const clock = alignClock(capture);
    const startModelUs = (main?.startTime ?? 0) - clock.monoAtStartUs;
    const wallUs = (capture.meta.endedAt - capture.meta.startedAt) * 1000;
    expect(startModelUs).toBeGreaterThanOrEqual(0);
    expect((main?.endTime ?? 0) - clock.monoAtStartUs).toBeLessThanOrEqual(wallUs + 1);
  });

  it('lines GC samples up with GC events', () => {
    const capture = loadCapture('orders-server');
    const clock = alignClock(capture);
    const gcEvents = capture.tracks.reduce(
      (n, t) => n + t.events.filter((e) => e.type === 'gc').length,
      0,
    );
    expect(clock.gcHits).toBeGreaterThanOrEqual(gcEvents * 0.6);
  });

  it('falls back to anchoring the profile end on the run end without events', () => {
    const capture = loadCapture('orders-server');
    const bare = {
      ...capture,
      tracks: capture.tracks.map((t) => ({ ...t, events: [] })),
    };
    const clock = alignClock(bare);
    expect(clock.monoAtStartUs).toBe(clock.lowUs);
  });
});
