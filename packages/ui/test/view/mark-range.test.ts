import { describe, expect, it } from 'vitest';
import { markRange } from '../../src/view/mark-range';

const marks = [
  { us: 2_000_000, label: 'Mark 1' },
  { us: 5_000_000, label: 'Mark 2' },
  { us: 8_000_000, label: 'Mark 3' },
];
const DURATION = 10_000_000;

describe('markRange', () => {
  it('runs from the start of the run to the mark for "before"', () => {
    expect(markRange(marks, 1, { kind: 'before' }, DURATION)).toEqual([0, 5_000_000]);
  });

  it('runs from the mark to the end of the run for "after"', () => {
    expect(markRange(marks, 1, { kind: 'after' }, DURATION)).toEqual([5_000_000, DURATION]);
  });

  it('runs between two marks whichever is named first', () => {
    expect(markRange(marks, 2, { kind: 'between', other: 0 }, DURATION)).toEqual([
      2_000_000, 8_000_000,
    ]);
    expect(markRange(marks, 0, { kind: 'between', other: 2 }, DURATION)).toEqual([
      2_000_000, 8_000_000,
    ]);
  });

  it('has no range when it would be empty (a mark at the very start or end)', () => {
    const edge = [
      { us: 0, label: 'a' },
      { us: DURATION, label: 'b' },
    ];
    expect(markRange(edge, 0, { kind: 'before' }, DURATION)).toBeNull();
    expect(markRange(edge, 1, { kind: 'after' }, DURATION)).toBeNull();
    expect(markRange(edge, 0, { kind: 'between', other: 0 }, DURATION)).toBeNull();
  });

  it('has no range for a mark that does not exist', () => {
    expect(markRange(marks, 7, { kind: 'before' }, DURATION)).toBeNull();
    expect(markRange(marks, 0, { kind: 'between', other: 9 }, DURATION)).toBeNull();
  });
});
