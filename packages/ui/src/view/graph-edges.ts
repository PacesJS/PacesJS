// Edge geometry for the call graph. Edges leave a node along its bottom side and arrive along its
// top side, spread by where the other end is, so edges of one node do not all share one point.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeEnds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface EdgeRef {
  from: number;
  to: number;
}

/** Fraction of a node's width the edge attachment points are spread over (centred). */
const SPREAD = 0.7;

export const edgeKey = (e: EdgeRef): string => `${e.from}>${e.to}`;

function spread(box: Box, count: number, index: number): number {
  const inset = (1 - SPREAD) / 2;
  return box.x + box.w * (inset + (SPREAD * (index + 1)) / (count + 1));
}

/** Attachment points for every edge, ordered by the horizontal position of the other end. */
export function edgeAnchors(
  boxes: ReadonlyMap<number, Box>,
  edges: readonly EdgeRef[],
): Map<string, EdgeEnds> {
  const centre = (fn: number): number => {
    const b = boxes.get(fn);
    return b ? b.x + b.w / 2 : 0;
  };
  const out = new Map<number, EdgeRef[]>();
  const inn = new Map<number, EdgeRef[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from))?.push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to))?.push(e);
  }
  const startX = new Map<string, number>();
  const endX = new Map<string, number>();
  for (const [fn, list] of out) {
    const box = boxes.get(fn);
    if (!box) continue;
    const sorted = [...list].sort((a, b) => centre(a.to) - centre(b.to) || a.to - b.to);
    sorted.forEach((e, i) => startX.set(edgeKey(e), spread(box, sorted.length, i)));
  }
  for (const [fn, list] of inn) {
    const box = boxes.get(fn);
    if (!box) continue;
    const sorted = [...list].sort((a, b) => centre(a.from) - centre(b.from) || a.from - b.from);
    sorted.forEach((e, i) => endX.set(edgeKey(e), spread(box, sorted.length, i)));
  }
  const ends = new Map<string, EdgeEnds>();
  for (const e of edges) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    const k = edgeKey(e);
    ends.set(k, {
      x1: startX.get(k) ?? a.x + a.w / 2,
      y1: a.y + a.h,
      x2: endX.get(k) ?? b.x + b.w / 2,
      y2: b.y,
    });
  }
  return ends;
}

/** SVG path of a top-down edge: control points follow the vertical gap so long edges stay smooth. */
export function edgePath(e: EdgeEnds): string {
  const lift = Math.max(24, Math.abs(e.y2 - e.y1) * 0.5);
  return `M${e.x1} ${e.y1} C ${e.x1} ${e.y1 + lift}, ${e.x2} ${e.y2 - lift}, ${e.x2} ${e.y2}`;
}

/** Whether an edge deserves its "via N frames" label: heavy, or touching the selection. */
export function showViaLabel(
  weightUs: number,
  maxEdgeUs: number,
  touchesSelection: boolean,
): boolean {
  return touchesSelection || weightUs >= 0.25 * Math.max(1, maxEdgeUs);
}
