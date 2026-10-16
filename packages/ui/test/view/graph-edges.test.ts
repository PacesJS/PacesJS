import { describe, expect, it } from 'vitest';
import { edgeAnchors, edgeKey, edgePath, showViaLabel } from '../../src/view/graph-edges';

const boxes = new Map([
  [1, { x: 100, y: 0, w: 200, h: 72 }],
  [2, { x: 0, y: 200, w: 200, h: 72 }],
  [3, { x: 300, y: 200, w: 200, h: 72 }],
  [4, { x: 600, y: 200, w: 200, h: 72 }],
]);

describe('call graph edge anchors', () => {
  const edges = [
    { from: 1, to: 4 },
    { from: 1, to: 2 },
    { from: 1, to: 3 },
  ];
  const ends = edgeAnchors(boxes, edges);
  const at = (to: number) => ends.get(edgeKey({ from: 1, to }));

  it('leaves along the bottom of the caller and arrives on top of the callee', () => {
    expect(at(2)?.y1).toBe(72);
    expect(at(2)?.y2).toBe(200);
  });

  it('spreads the edges of one node, ordered by where the callee sits', () => {
    const xs = [2, 3, 4].map((to) => at(to)?.x1 ?? 0);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(3);
  });

  it('keeps every attachment point inside the node width', () => {
    for (const to of [2, 3, 4]) {
      const x = at(to)?.x1 ?? 0;
      expect(x).toBeGreaterThan(100);
      expect(x).toBeLessThan(300);
    }
  });

  it('puts a lone edge in the middle of both nodes', () => {
    const lone = edgeAnchors(boxes, [{ from: 1, to: 2 }]).get(edgeKey({ from: 1, to: 2 }));
    expect(lone?.x1).toBe(200);
    expect(lone?.x2).toBe(100);
  });

  it('spreads edges that arrive at one node by where they come from', () => {
    const into = edgeAnchors(boxes, [
      { from: 4, to: 1 },
      { from: 2, to: 1 },
    ]);
    const a = into.get(edgeKey({ from: 2, to: 1 }))?.x2 ?? 0;
    const b = into.get(edgeKey({ from: 4, to: 1 }))?.x2 ?? 0;
    expect(a).toBeLessThan(b);
  });

  it('builds a smooth path whose bend grows with the vertical gap', () => {
    const near = edgePath({ x1: 0, y1: 0, x2: 50, y2: 60 });
    const far = edgePath({ x1: 0, y1: 0, x2: 50, y2: 600 });
    expect(near).toMatch(/^M0 0 C 0 30, 50 30, 50 60$/);
    expect(far).toMatch(/^M0 0 C 0 300, 50 300, 50 600$/);
  });
});

describe('via-frames labels', () => {
  it('labels heavy edges only', () => {
    expect(showViaLabel(900, 1000, false)).toBe(true);
    expect(showViaLabel(100, 1000, false)).toBe(false);
  });

  it('labels any edge that touches the selection', () => {
    expect(showViaLabel(1, 1000, true)).toBe(true);
  });
});
