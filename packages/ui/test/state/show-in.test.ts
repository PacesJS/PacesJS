import { describe, expect, it } from 'vitest';
import { showInView } from '../../src/state/show-in';

describe('showInView', () => {
  it('goes to the view with the function selected', () => {
    expect(showInView('callgraph', 7)).toEqual({
      type: 'go',
      patch: { view: 'callgraph', selection: { kind: 'fn', fn: 7 } },
    });
  });
});
