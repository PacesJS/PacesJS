import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, WF_COLUMN_LIMITS, dockCollapsed, parsePrefs } from '../../src/state/prefs';
import {
  MIN_BAR_PX,
  fitCallWidth,
  fitNumericWidth,
  gridTemplate,
  resizeColumn,
} from '../../src/view/waterfall-columns';
import { barColumn } from '../../src/view/waterfall-geometry';
import type { WaterfallRow } from '../../src/data/types';

const cols = DEFAULT_PREFS.wfCols;
const row = (name: string, depth: number, loc = ''): WaterfallRow => ({
  id: 0,
  kind: 'call',
  fn: 1,
  path: [1],
  name,
  loc,
  origin: 0,
  start: 0,
  end: 1,
  depth,
  parent: -1,
  hasChildren: false,
  critical: false,
  belowPrecision: false,
  share: 1,
  resumed: false,
  summaryTasks: [],
  selfUs: 0,
  deopts: 0,
});
const mono = (text: string): number => text.length * 7;

describe('waterfall column grid', () => {
  it('gives the bar column the remaining width with a floor', () => {
    expect(gridTemplate(cols)).toBe(`320px minmax(${MIN_BAR_PX}px, 1fr) 76px 60px`);
  });

  it('places the bar column between the call and the number columns', () => {
    const { x0, x1 } = barColumn(1000, { call: 400, time: 100, share: 80 });
    expect(x0).toBe(8 + 400 + 12);
    expect(x1).toBe(1000 - 8 - 80 - 12 - 100 - 12);
  });
});

describe('resizing columns', () => {
  it('widens CALL when its edge is dragged right', () => {
    expect(resizeColumn(cols, 'call', 40).call).toBe(360);
  });

  it('widens TIME when its left edge is dragged left', () => {
    expect(resizeColumn(cols, 'time', -20).time).toBe(96);
  });

  it('never goes below the minimum widths', () => {
    expect(resizeColumn(cols, 'call', -5000).call).toBe(WF_COLUMN_LIMITS.call.min);
    expect(resizeColumn(cols, 'share', 5000).share).toBe(WF_COLUMN_LIMITS.share.min);
  });

  it('never goes above the maximum widths', () => {
    expect(resizeColumn(cols, 'call', 5000).call).toBe(WF_COLUMN_LIMITS.call.max);
  });
});

describe('auto-fit', () => {
  it('fits the call column to the deepest, longest name', () => {
    const w = fitCallWidth([row('a', 0), row('averyverylongfunctionname', 6)], mono, mono);
    expect(w).toBe(6 * 16 + 14 + 8 + 12 + 16 + 25 * 7);
  });

  it('counts part of the location but not all of it', () => {
    const short = fitCallWidth([row('f', 0, 'a.ts:1')], mono, mono);
    const long = fitCallWidth([row('f', 0, 'x'.repeat(200))], mono, mono);
    expect(long).toBeGreaterThan(short);
    expect(long).toBe(14 + 8 + 12 + 16 + 7 + 8 + 140);
  });

  it('fits a numeric column to its widest label within the limits', () => {
    expect(fitNumericWidth('time', ['~199.7 ms', '< 2 ms'], mono)).toBe(9 * 7 + 16);
    expect(fitNumericWidth('time', ['x'], mono)).toBe(WF_COLUMN_LIMITS.time.min);
  });
});

describe('saved preferences', () => {
  it('falls back to the defaults for anything missing or malformed', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ wfCols: { call: 'wide' }, dock: { orientation: 'left' } })).toEqual(
      DEFAULT_PREFS,
    );
  });

  it('clamps saved sizes into range', () => {
    const p = parsePrefs({ wfCols: { call: 5 }, dock: { widthFraction: 5, heightPx: 1 } });
    expect(p.wfCols.call).toBe(WF_COLUMN_LIMITS.call.min);
    expect(p.dock.widthFraction).toBe(0.75);
    expect(p.dock.heightPx).toBe(200);
  });

  it('round-trips a saved layout', () => {
    const saved = {
      wfCols: { call: 400, time: 90, share: 70 },
      dock: {
        orientation: 'bottom',
        widthFraction: 0.5,
        heightPx: 500,
        wrap: true,
      },
    };
    expect(parsePrefs(saved)).toEqual(saved);
  });
});

describe('the dock follows the selection', () => {
  it('is a rail when nothing with code is selected, and extended when something is', () => {
    expect(dockCollapsed(null, false)).toBe(true);
    expect(dockCollapsed(null, true)).toBe(false);
  });

  it('keeps a manual collapse while a function stays selected', () => {
    expect(dockCollapsed({ mode: 'collapsed', forCode: true }, true)).toBe(true);
  });

  it('keeps a manual expand only while nothing is selected', () => {
    expect(dockCollapsed({ mode: 'open', forCode: false }, false)).toBe(false);
    expect(dockCollapsed({ mode: 'open', forCode: false }, true)).toBe(false);
  });

  it('does not persist whether the dock is open, only its size and side', () => {
    expect(Object.keys(DEFAULT_PREFS.dock).sort()).toEqual([
      'heightPx',
      'orientation',
      'widthFraction',
      'wrap',
    ]);
    expect(Object.keys(parsePrefs({ dock: { mode: 'collapsed' } }).dock)).not.toContain('mode');
  });
});
