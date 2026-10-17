import { describe, expect, it } from 'vitest';
import { callGraph } from '../../src/query/callgraph.js';
import { flameLayout } from '../../src/query/flame.js';
import { functionRows } from '../../src/query/functions.js';
import { functionSource } from '../../src/query/source.js';
import { timelineLane } from '../../src/query/timeline.js';
import { DEFAULT_TRANSFORMS } from '../../src/query/types.js';
import { applyTransforms } from '../../src/query/view.js';
import { waterfallForTask } from '../../src/query/waterfall.js';
import { FIXTURES, loadModel } from '../helpers/fixtures.js';

const cases = FIXTURES.flatMap((name) =>
  loadModel(name).tracks.map((_, trackIndex) => [name, trackIndex] as const),
);

describe('query layer over every recorded track', () => {
  it.each(cases)('%s track %i: the views agree with each other', (name, trackIndex) => {
    const model = loadModel(name);
    const view = applyTransforms(model, trackIndex, DEFAULT_TRANSFORMS);

    const flame = flameLayout(model, view);
    expect(flame.x[0]).toBe(0);
    expect(flame.w[0]).toBe(1);
    expect(flame.totalUs).toBeCloseTo(view.totalUs, 3);

    const rows = functionRows(model, view, { includeIdle: true });
    const selfSum = rows.reduce((n, r) => n + r.self, 0);
    expect(selfSum + (view.tree.self[0] ?? 0)).toBeCloseTo(view.totalUs, 0);

    const graph = callGraph(model, view);
    expect(graph.nodes.length).toBeLessThanOrEqual(41);

    const track = model.tracks[trackIndex];
    const longest = Array.from({ length: track?.tasks.length ?? 0 }, (_, k) => k).sort(
      (a, b) => (track?.tasks.busy[b] ?? 0) - (track?.tasks.busy[a] ?? 0) || a - b,
    )[0];
    if (longest !== undefined) {
      // Rows of tasks reached over async edges lie beyond the task, so this checks the task alone.
      const wf = waterfallForTask(model, view, longest, { followAsync: false });
      const start = track?.tasks.start[longest] ?? 0;
      const end = track?.tasks.end[longest] ?? 0;
      expect(wf.rows.every((r) => r.start >= start - 1 && r.end <= end + 1)).toBe(true);
    }

    const lane = timelineLane(model, trackIndex);
    expect(lane.tasks.length).toBe(track?.tasks.length);

    const top = rows[0];
    if (top) expect(functionSource(model, view, top.fn).fn).toBe(top.fn);
  });

  it('shows lineTotal as the top user function with its hot line on the orders server', () => {
    const model = loadModel('orders-server');
    const view = applyTransforms(model, 0, DEFAULT_TRANSFORMS);
    const rows = functionRows(model, view);
    expect(rows[0]?.name).toBe('lineTotal');
    expect(functionSource(model, view, rows[0]?.fn ?? 0).hottestLine).toBe(9);
  });
});
