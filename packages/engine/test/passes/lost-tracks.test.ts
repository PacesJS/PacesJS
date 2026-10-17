import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyze.js';
import { buildAgentSummary } from '../../src/agent-summary.js';
import { ensureCaptureWarnings } from '../../src/passes/warnings.js';
import { deserializeModel, serializeModel } from '../../src/serialize.js';
import type { CaptureMeta } from '../../src/raw.js';
import { loadCapture } from '../helpers/capture.js';
import { synthCapture } from '../helpers/synth.js';

type Lost = NonNullable<CaptureMeta['lostTracks']>;
const withLost = (lost: Lost | undefined) => {
  const capture = synthCapture([{ stack: ['a'], samples: 5 }]);
  if (lost) capture.meta.lostTracks = lost;
  return capture;
};

describe('lost tracks warning', () => {
  it('is one structured warning with a count and readable details', () => {
    const m = analyze(
      withLost([
        { id: 'p4321', pid: 4321, kind: 'process' },
        { id: 'p4321-w2', pid: 4321, threadId: 2, kind: 'worker' },
      ]),
    );
    expect(m.meta.warnings).toEqual([
      {
        kind: 'lost-tracks',
        severity: 'warn',
        summary:
          '2 processes or workers were stopped before they could write a profile; their time is not in this session.',
        count: 2,
        details: ['pid 4321', 'pid 4321 (worker 2)'],
      },
    ]);
  });

  it('uses the singular for one', () => {
    const m = analyze(withLost([{ id: 'p1', pid: 9, kind: 'process' }]));
    expect(m.meta.warnings[0]?.summary).toBe(
      '1 process or worker was stopped before it could write a profile; its time is not in this session.',
    );
  });

  it('falls back to the label or id when there is no pid', () => {
    const m = analyze(withLost([{ id: 'p7', label: 'server', kind: 'process' }]));
    expect(m.meta.warnings[0]?.details).toEqual(['server']);
  });

  it('lists at most 20 entries but counts them all', () => {
    const lost: Lost = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      pid: 100 + i,
      kind: 'process' as const,
    }));
    const w = analyze(withLost(lost)).meta.warnings[0];
    expect(w?.count).toBe(30);
    expect(w?.details).toHaveLength(20);
  });

  it.each([undefined, []])('is absent when the field is %j', (lost) => {
    expect(analyze(withLost(lost)).meta.warnings).toEqual([]);
  });

  it('does not touch fixtures captured without the field', () => {
    expect(
      analyze(loadCapture('orders-server')).meta.warnings.some((w) => w.kind === 'lost-tracks'),
    ).toBe(false);
  });

  it('reaches the agent summary caveats', () => {
    const m = analyze(withLost([{ id: 'p1', pid: 9, kind: 'process' }]));
    const s = buildAgentSummary(m);
    expect(s.caveats.map((c) => c.kind)).toContain('lost-tracks');
    expect(s.warnings.some((w) => /stopped before/.test(w))).toBe(true);
  });

  it('survives serialization', () => {
    const m = analyze(withLost([{ id: 'p1', pid: 9, kind: 'process' }]));
    expect(deserializeModel(serializeModel(m)).meta.warnings).toEqual(m.meta.warnings);
  });

  describe('against a cached model', () => {
    const lost: Lost = [{ id: 'p1', pid: 9, kind: 'process' }];

    it('adds the warning to a model analyzed before the capture knew about lost tracks', () => {
      const cached = deserializeModel(serializeModel(analyze(withLost(undefined))));
      const fixed = ensureCaptureWarnings(cached, { lostTracks: lost });
      expect(fixed.meta.warnings.map((w) => w.kind)).toEqual(['lost-tracks']);
      expect(fixed.meta.lostTracks).toEqual(lost);
    });

    it('is idempotent', () => {
      const m = analyze(withLost(lost));
      const again = ensureCaptureWarnings(ensureCaptureWarnings(m, { lostTracks: lost }), {
        lostTracks: lost,
      });
      expect(again.meta.warnings.filter((w) => w.kind === 'lost-tracks')).toHaveLength(1);
    });

    it('leaves a model alone when the capture has none', () => {
      const m = analyze(withLost(undefined));
      expect(ensureCaptureWarnings(m, {}).meta.warnings).toEqual([]);
    });
  });
});
