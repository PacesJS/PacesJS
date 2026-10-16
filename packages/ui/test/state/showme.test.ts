import { describe, expect, it } from 'vitest';
import { createState, reducer, snapshotOf } from '../../src/state/reducer';
import { showMeAction } from '../../src/state/showme';
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

  it('scrolls the source to the target line', () => {
    const state = createState(initialSnapshot());
    const action = showMeAction({ view: 'waterfall', fn: 3, line: 43 }, snapshotOf(state), 'main');
    const next = snapshotOf(reducer(state, action));
    expect(next.selection).toEqual({ kind: 'fn', fn: 3 });
    expect(next.options.line).toBe(43);
  });
});
