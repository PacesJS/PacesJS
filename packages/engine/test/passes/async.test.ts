import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import type { RuntimeEvent } from '../../src/raw.js';
import { loadModel } from '../helpers/fixtures.js';
import { synthCapture } from '../helpers/synth.js';

const T0 = 1_800_000_000_000;
const ev = (
  ms: number,
  phase: 'init' | 'before' | 'after',
  asyncId: number,
  triggerAsyncId = 1,
): RuntimeEvent => ({
  type: 'async',
  time: T0 + ms,
  phase,
  asyncId,
  triggerAsyncId,
  asyncType: 'Timeout',
});

// Samples are 1 ms apart starting at 1 ms: task A covers 1-6 ms, B 11-16 ms, C 21-26 ms.
const steps = [
  { stack: ['a'], samples: 5 },
  { idle: 5 },
  { stack: ['b'], samples: 5 },
  { idle: 5 },
  { stack: ['c'], samples: 5 },
];

describe('async stitching', () => {
  it('leaves the edge table empty without async data', () => {
    for (const name of ['orders-server', 'sync-io'] as const) {
      expect(loadModel(name).tracks[0]?.asyncEdges.length).toBe(0);
    }
  });

  it('links the task that scheduled a callback to the task it ran in, with the wait between', () => {
    const m = analyze(
      synthCapture(steps, {
        events: [
          ev(3, 'init', 2),
          ev(12, 'before', 2),
          ev(14, 'after', 2),
          ev(13, 'init', 3, 2),
          ev(22, 'before', 3),
          ev(24, 'after', 3),
        ],
      }),
    );
    const edges = m.tracks[0]?.asyncEdges;
    expect(edges?.length).toBe(2);
    expect(Array.from(edges?.from ?? [])).toEqual([0, 1]);
    expect(Array.from(edges?.to ?? [])).toEqual([1, 2]);
    expect(Array.from(edges?.waitUs ?? [])).toEqual([5000, 5000]);
  });

  it('ignores resources that never ran inside a task', () => {
    const m = analyze(
      synthCapture(steps, { events: [ev(3, 'init', 9), ev(8, 'before', 9), ev(9, 'after', 9)] }),
    );
    expect(m.tracks[0]?.asyncEdges.length).toBe(0);
  });

  it('does not link a task to itself', () => {
    const m = analyze(
      synthCapture(steps, { events: [ev(2, 'init', 5), ev(4, 'before', 5), ev(5, 'after', 5)] }),
    );
    expect(m.tracks[0]?.asyncEdges.length).toBe(0);
  });
});
