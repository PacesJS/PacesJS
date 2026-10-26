import { describe, expect, it } from 'vitest';
import { deoptNote, deoptSourceTitle } from '../../src/view/deopt-text';

describe('deopt wording', () => {
  it('counts the times V8 threw away optimized code', () => {
    expect(deoptNote(1)).toBe('V8 threw away optimized code 1 time');
    expect(deoptNote(10)).toBe('V8 threw away optimized code 10 times');
  });

  it('lists the reasons on a source line, most often first', () => {
    expect(
      deoptSourceTitle([
        { line: 6, reason: 'wrong map', kind: 'eager', count: 7 },
        { line: 6, reason: 'overflow', kind: 'eager', count: 1 },
      ]),
    ).toBe('V8 threw away optimized code here 8 times: wrong map ×7, overflow');
  });

  it('says a lazy deopt resumed here instead of claiming this line broke', () => {
    expect(
      deoptSourceTitle([{ line: 9, reason: 'prototype chain changed', kind: 'lazy', count: 2 }]),
    ).toBe(
      'V8 threw away optimized code 2 times after something it depended on changed (prototype chain changed ×2); the code resumed on this line',
    );
  });
});
