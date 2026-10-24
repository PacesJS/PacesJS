import { describe, expect, it } from 'vitest';
import { selfWidth } from '../../src/view/self-share';

describe('selfWidth', () => {
  it('is the bar width times the share of the call that is its own time', () => {
    expect(selfWidth(200, 25, 100)).toBe(50);
  });

  it('is nothing for a call with no self time', () => {
    expect(selfWidth(200, 0, 100)).toBe(0);
  });

  it('is nothing when the call has no total to take a share of', () => {
    expect(selfWidth(200, 10, 0)).toBe(0);
  });

  it('never exceeds the bar, even when self rounds past total', () => {
    expect(selfWidth(200, 120, 100)).toBe(200);
  });

  it('is nothing for a bar too narrow to show a stripe', () => {
    expect(selfWidth(3, 50, 100)).toBe(0);
  });

  it('keeps a visible sliver for a small but non-zero share of a wide bar', () => {
    expect(selfWidth(400, 1, 1000)).toBe(3);
  });
});
