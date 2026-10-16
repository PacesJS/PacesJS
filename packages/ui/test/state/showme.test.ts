import { describe, expect, it } from 'vitest';
import { createState, reducer, snapshotOf } from '../../src/state/reducer';
import type { Finding } from '@pacesjs/engine';
import { clearShowMeAction, isShowing, showMeAction, showingText } from '../../src/state/showme';
import { initialSnapshot } from '../../src/state/types';

describe('Show me', () => {
  it('selects the task, sets the range and turns the critical path on in one step', () => {
    const state = createState(initialSnapshot());
    const action = showMeAction(
      {
        view: 'waterfall',
        track: 'main',
        task: 7,
        range: [10, 20],
        options: { criticalPath: true },
      },
      snapshotOf(state),
      'main',
    );
    const next = snapshotOf(reducer(state, action));
    expect(next.view).toBe('waterfall');
    expect(next.selection).toEqual({ kind: 'task', track: 'main', task: 7 });
    expect(next.range).toEqual([10, 20]);
    expect(next.options.task).toBe(7);
    expect(next.options.critical).toBe(true);
  });

  it('switches to the track the finding names', () => {
    const state = createState(initialSnapshot());
    const action = showMeAction(
      { view: 'functions', track: 'p1-w1', fn: 315 },
      snapshotOf(state),
      'p1',
    );
    expect(snapshotOf(reducer(state, action)).track).toBe('p1-w1');
  });

  it('keeps the current track when the finding names none', () => {
    const state = createState({ ...initialSnapshot(), track: 'p1-w2' });
    const action = showMeAction({ view: 'flame' }, snapshotOf(state), 'p1');
    expect(snapshotOf(reducer(state, action)).track).toBe('p1-w2');
  });

  it('keeps the current view for a track-timeline target', () => {
    const state = createState({ ...initialSnapshot(), view: 'flame' });
    const action = showMeAction({ view: 'timeline', range: [1, 2] }, snapshotOf(state), 'main');
    expect(snapshotOf(reducer(state, action)).view).toBe('flame');
  });

  it('unmerges plumbing for the flame graph when asked', () => {
    const state = createState(initialSnapshot());
    const action = showMeAction(
      { view: 'flame', options: { unmergePlumbing: true } },
      snapshotOf(state),
      'main',
    );
    const kinds = snapshotOf(reducer(state, action)).transforms.map((t) => t.k);
    expect(kinds).not.toContain('merge-plumbing');
  });

  it('selects the function when a finding names both a task and a function', () => {
    const state = createState(initialSnapshot());
    const action = showMeAction(
      { view: 'waterfall', track: 'main', task: 5, fn: 9 },
      snapshotOf(state),
      'main',
    );
    const next = snapshotOf(reducer(state, action));
    expect(next.selection).toEqual({ kind: 'fn', fn: 9 });
    expect(next.options.task).toBe(5);
  });

  it('leaves the source on the definition: a hot line is never the scroll target', () => {
    const state = createState(initialSnapshot());
    const action = showMeAction({ view: 'waterfall', fn: 3, line: 43 }, snapshotOf(state), 'main');
    const next = snapshotOf(reducer(state, action));
    expect(next.selection).toEqual({ kind: 'fn', fn: 3 });
    expect(next.options.line).toBe(0);
  });

  it('forgets a jump to the hottest line when another function is selected', () => {
    const start = { ...initialSnapshot(), options: { ...initialSnapshot().options, line: 1667 } };
    const state = createState(start);
    const next = snapshotOf(reducer(state, { type: 'select', selection: { kind: 'fn', fn: 9 } }));
    expect(next.options.line).toBe(0);
  });

  it('keeps a jump while the same function stays selected', () => {
    const start = {
      ...initialSnapshot(),
      selection: { kind: 'fn', fn: 9 } as const,
      options: { ...initialSnapshot().options, line: 1667 },
    };
    const state = createState(start);
    const next = snapshotOf(reducer(state, { type: 'options', options: { line: 1700 } }));
    expect(next.options.line).toBe(1700);
  });
});

const finding = (showMe: Finding['showMe'], title = 'Finding'): Finding => ({
  id: title,
  kind: 'hot-function',
  severity: 'medium',
  title,
  summary: '',
  rule: '',
  impact: 0.1,
  showMe,
  evidence: [],
});

const ctx = { functionCount: 100, packages: ['ajv', 'fast-uri'] };

describe('Show me contract', () => {
  const run = (showMe: Finding['showMe'], start = initialSnapshot()) => {
    const state = createState(start);
    return snapshotOf(reducer(state, showMeAction(showMe, start, 'p1', ctx)));
  };

  it('selects the package node of a hot dependency and reveals its neighbours', () => {
    const next = run({ view: 'callgraph', track: 'p1', options: { expandPackage: 'fast-uri' } });
    expect(next.view).toBe('callgraph');
    expect(next.selection).toEqual({ kind: 'fn', fn: 101 });
    expect(next.options.reveal).toEqual([101]);
    expect(next.transforms.map((t) => t.k)).toContain('collapse-deps');
  });

  it('opens the waterfall on the lag window and selects that range', () => {
    const next = run({
      view: 'timeline',
      track: 'p1-w1',
      range: [1000, 5000],
      options: { delayLane: true },
    });
    expect(next.view).toBe('waterfall');
    expect(next.track).toBe('p1-w1');
    expect(next.range).toEqual([1000, 5000]);
    expect(next.selection).toEqual({ kind: 'range', from: 1000, to: 5000 });
    expect(next.options.task).toBe(-1);
  });

  it('opens the flame graph on the window of a GC finding', () => {
    expect(run({ view: 'timeline', range: [1, 9], options: { gcMarkers: true } }).view).toBe(
      'flame',
    );
  });

  it('zooms the flame graph to the call chain of a hot path', () => {
    const next = run({
      view: 'flame',
      track: 'p1',
      fn: 12,
      options: { zoomPath: '3,17,12' },
    });
    expect(next.view).toBe('flame');
    expect(next.options.zoomPath).toEqual([3, 17, 12]);
    expect(next.selection).toEqual({ kind: 'fn', fn: 12 });
  });

  it('forgets an earlier zoom chain when another target is shown', () => {
    const start = {
      ...initialSnapshot(),
      options: { ...initialSnapshot().options, zoomPath: [1, 2] },
    };
    expect(run({ view: 'functions', fn: 4 }, start).options.zoomPath).toEqual([]);
  });

  it('puts a search target into the search box', () => {
    const state = createState(initialSnapshot());
    const action = showMeAction(
      { view: 'functions', options: { search: 'JSON' } },
      snapshotOf(state),
      'p1',
      ctx,
    );
    expect(reducer(state, action).search).toBe('JSON');
  });

  const targets: Array<[string, Finding['showMe']]> = [
    ['a function', { view: 'functions', track: 'p1', fn: 7 }],
    ['a task', { view: 'waterfall', track: 'p1', task: 3 }],
    ['a package', { view: 'callgraph', track: 'p1', options: { expandPackage: 'ajv' } }],
    ['a range', { view: 'timeline', track: 'p1', range: [10, 20], options: { delayLane: true } }],
  ];

  it.each(targets)('knows it is showing %s, and clears it', (_name, showMe) => {
    const f = finding(showMe);
    const start = initialSnapshot();
    expect(isShowing(f, start, '', ctx)).toBe(false);
    const shown = run(showMe);
    expect(isShowing(f, shown, '', ctx)).toBe(true);
    const cleared = snapshotOf(reducer(createState(shown), clearShowMeAction(f, shown)));
    expect(isShowing(f, cleared, '', ctx)).toBe(false);
    expect(cleared.selection).toEqual({ kind: 'none' });
  });

  it('puts plumbing back when clearing an unmerge target', () => {
    const f = finding({ view: 'flame', options: { unmergePlumbing: true } });
    const shown = run(f.showMe);
    expect(isShowing(f, shown, '', ctx)).toBe(true);
    const cleared = snapshotOf(reducer(createState(shown), clearShowMeAction(f, shown)));
    expect(cleared.transforms.map((t) => t.k)).toContain('merge-plumbing');
    expect(isShowing(f, cleared, '', ctx)).toBe(false);
  });

  it('is no longer showing once the selection moves elsewhere', () => {
    const f = finding({ view: 'functions', track: 'p1', fn: 7 });
    const moved = { ...run(f.showMe), selection: { kind: 'fn', fn: 8 } as const };
    expect(isShowing(f, moved, '', ctx)).toBe(false);
  });

  it('announces the finding and its target', () => {
    expect(showingText(finding({ view: 'flame' }, 'Hot function'), 'lineTotal')).toBe(
      'Showing: Hot function · lineTotal',
    );
  });
});
