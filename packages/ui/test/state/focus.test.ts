import { describe, expect, it } from 'vitest';
import { focusTransform } from '../../src/state/focus';

describe('the transform behind Focus here', () => {
  it('focuses the call node when its whole path is made of real functions', () => {
    expect(focusTransform([3, 4, 5], 5, 100)).toEqual({ k: 'focus-node', path: [3, 4, 5] });
  });

  it('falls back to the function when the path crosses a collapsed package', () => {
    expect(focusTransform([3, 120, 5], 5, 100)).toEqual({ k: 'focus-fn', fn: 5 });
  });

  it('offers nothing for a collapsed package on its own', () => {
    expect(focusTransform([120], 120, 100)).toBeNull();
    expect(focusTransform(null, null, 100)).toBeNull();
  });
});
