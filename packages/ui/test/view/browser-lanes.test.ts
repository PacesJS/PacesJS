import { describe, expect, it } from 'vitest';
import { clusterInputs, filmstripSlots, frameLabel, lodRender } from '../../src/view/browser-lanes';

const DUR = 10_000_000;

describe('lodRender', () => {
  it('draws each row at its place as a share of the run', () => {
    const blocks = lodRender(
      [{ startUs: 1_000_000, durUs: 500_000, phase: 'layout', forced: false }],
      DUR,
      1000,
    );
    expect(blocks).toEqual([{ left: 0.1, width: 0.05, phase: 'layout', forced: false, count: 1 }]);
  });

  it('never draws a row narrower than a pixel', () => {
    const [block] = lodRender(
      [{ startUs: 1_000_000, durUs: 10, phase: 'paint', forced: false }],
      DUR,
      1000,
    );
    expect(block?.width).toBeCloseTo(1 / 1000, 6);
  });

  it('merges neighbours of the same phase that would touch, and counts them', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      startUs: 1_000_000 + i * 2_000,
      durUs: 1_000,
      phase: 'layout' as const,
      forced: true,
    }));
    const blocks = lodRender(rows, DUR, 1000);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ count: 50, forced: true, phase: 'layout' });
  });

  it('keeps different phases and forced and unforced apart', () => {
    const blocks = lodRender(
      [
        { startUs: 1_000_000, durUs: 1_000, phase: 'layout', forced: true },
        { startUs: 1_001_000, durUs: 1_000, phase: 'layout', forced: false },
        { startUs: 1_002_000, durUs: 1_000, phase: 'paint', forced: false },
      ],
      DUR,
      1000,
    );
    expect(blocks).toHaveLength(3);
  });

  it('keeps rows that are far apart as separate blocks', () => {
    const blocks = lodRender(
      [
        { startUs: 1_000_000, durUs: 1_000, phase: 'style', forced: false },
        { startUs: 5_000_000, durUs: 1_000, phase: 'style', forced: false },
      ],
      DUR,
      1000,
    );
    expect(blocks).toHaveLength(2);
  });

  it('draws nothing for nothing', () => {
    expect(lodRender([], DUR, 1000)).toEqual([]);
  });
});

describe('clusterInputs', () => {
  const click = (startUs: number, latencyUs = -1) => ({
    startUs,
    endUs: startUs + 1000,
    kind: 'click' as const,
    label: `b${startUs}`,
    task: -1,
    latencyUs,
  });

  it('leaves inputs that are far apart alone, with their own label', () => {
    const out = clusterInputs([click(1_000_000), click(6_000_000)], DUR, 1000);
    expect(out.map((c) => [c.count, c.label])).toEqual([
      [1, 'b1000000'],
      [1, 'b6000000'],
    ]);
  });

  it('gathers close inputs of one kind into a cluster that says how many', () => {
    const out = clusterInputs([click(1_000_000), click(1_050_000), click(1_100_000)], DUR, 1000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ count: 3, label: '3 clicks' });
    expect(out[0]?.endUs).toBeGreaterThan(1_100_000);
  });

  it('does not gather different kinds', () => {
    const out = clusterInputs(
      [click(1_000_000), { ...click(1_001_000), kind: 'key' as const, label: 'Enter' }],
      DUR,
      1000,
    );
    expect(out).toHaveLength(2);
  });

  it('flags a cluster that holds a slow interaction', () => {
    const out = clusterInputs([click(1_000_000, 50_000), click(1_010_000, 400_000)], DUR, 1000);
    expect(out[0]?.slowestUs).toBe(400_000);
  });

  it('splits them again when there is room to tell them apart', () => {
    const out = clusterInputs([click(1_000_000), click(1_050_000)], DUR, 100_000);
    expect(out).toHaveLength(2);
  });
});

describe('filmstripSlots', () => {
  const shots = {
    time: Float64Array.from([100_000, 2_000_000, 6_000_000]),
    id: Uint32Array.from([0, 1, 2]),
  };

  it('shows, in each slot, the last frame taken at or before it', () => {
    const slots = filmstripSlots(shots, [], DUR, 5);
    expect(slots.map((s) => s.frame)).toEqual([0, 1, 1, 2, 2]);
  });

  it('marks a slot that is inside a pause, and never shows a frame there', () => {
    const slots = filmstripSlots(shots, [{ startUs: 3_000_000, endUs: 5_000_000 }], DUR, 5);
    expect(slots[2]?.reason).toBe('paused');
    expect(slots[2]?.frame).toBeNull();
  });

  it('marks a slot that is a long way from any frame as having none, rather than blank', () => {
    const sparse = { time: Float64Array.from([100_000]), id: Uint32Array.from([0]) };
    const slots = filmstripSlots(sparse, [], DUR, 5);
    expect(slots[4]).toMatchObject({ frame: null, reason: 'none' });
  });

  it('gives a slot nothing before the first frame', () => {
    const late = { time: Float64Array.from([8_000_000]), id: Uint32Array.from([0]) };
    expect(filmstripSlots(late, [], DUR, 5)[0]).toMatchObject({ frame: null, reason: 'none' });
  });

  it('puts every slot at the middle of its share of the run', () => {
    const slots = filmstripSlots(shots, [], DUR, 4);
    expect(slots.map((s) => s.timeUs)).toEqual([1_250_000, 3_750_000, 6_250_000, 8_750_000]);
  });
});

describe('frameLabel', () => {
  it('says when the frame was taken', () => {
    expect(frameLabel(1_240_000)).toBe('Frame at 1.24 s');
  });
});
