import { describe, expect, it } from 'vitest';
import type { WaterfallRow } from '../../src/data/types';
import { waterfallRowModel } from '../../src/view/waterfall-row-model';
import type { RowModelContext } from '../../src/view/waterfall-row-model';

const ctx: RowModelContext = {
  callWidth: 320,
  fontSans: 'sans',
  measure: (t) => t.length * 7,
  functionCount: 100,
  threshold: '2 ms',
  foldLabel: '2 ms',
  whole: 'task',
  winStart: 0,
  winEnd: 10_000,
  barX0: 0,
  barX1: 1000,
  hiddenKids: 0,
  cpuUs: 0,
};

const row = (over: Partial<WaterfallRow>): WaterfallRow =>
  ({
    id: 1,
    kind: 'call',
    fn: 3,
    path: [3],
    name: 'lineTotal',
    loc: 'src/money.ts:6',
    origin: 0,
    start: 1000,
    end: 3000,
    depth: 1,
    parent: 0,
    hasChildren: false,
    critical: false,
    belowPrecision: false,
    share: 0.2,
    resumed: false,
    summaryTasks: [],
    selfUs: 100,
    ...over,
  }) as WaterfallRow;

describe('waterfallRowModel', () => {
  it('places the bar hover target by the visible window and says how long the call took', () => {
    const m = waterfallRowModel(row({}), ctx);
    expect(m.barBox).toEqual({ x: 100, w: 200 });
    expect(m.details).toContain('20.0% of the task');
    expect(m.where).toBe('src/money.ts:6');
    expect(m.isUser).toBe(true);
  });

  it('notes the callees a minimum duration hides, in the tooltip title', () => {
    const m = waterfallRowModel(row({}), { ...ctx, hiddenKids: 2 });
    expect(m.hiddenNote).toBe('2 callees under 2 ms hidden');
    expect(m.nameTitle).toBe('lineTotal · src/money.ts:6 · 2 callees under 2 ms hidden');
  });

  it('offers Focus only past the depth limit, with a depth badge before that', () => {
    expect(waterfallRowModel(row({ depth: 5 }), ctx).focusAs).toBeNull();
    const deep = waterfallRowModel(row({ depth: 30 }), ctx);
    expect(deep.focusAs).not.toBeNull();
    expect(deep.badged).toBe(true);
    expect(deep.depthBadge).toBe('⋯ 30');
  });

  it('has no hover target for a small-task summary fold', () => {
    const m = waterfallRowModel(row({ kind: 'fold', fold: 'small' } as Partial<WaterfallRow>), ctx);
    expect(m.barBox).toBeNull();
  });
});
