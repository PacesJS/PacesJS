import { describe, expect, it } from 'vitest';
import { runMarks } from '../../src/data/marks';

describe('runMarks', () => {
  const startedAt = 1_000_000;

  it('puts each mark at its microseconds from the start of the run', () => {
    expect(
      runMarks(
        [
          { at: startedAt + 1500, label: 'Mark 1' },
          { at: startedAt + 4200, label: 'Mark 2' },
        ],
        startedAt,
        10_000_000,
      ),
    ).toEqual([
      { us: 1_500_000, label: 'Mark 1' },
      { us: 4_200_000, label: 'Mark 2' },
    ]);
  });

  it('keeps them in time order whatever order they were recorded in', () => {
    const marks = runMarks(
      [
        { at: startedAt + 3000, label: 'late' },
        { at: startedAt + 1000, label: 'early' },
      ],
      startedAt,
      10_000_000,
    );
    expect(marks.map((m) => m.label)).toEqual(['early', 'late']);
  });

  it('pulls a mark that falls outside the run to its nearest end, so it still shows', () => {
    expect(
      runMarks(
        [
          { at: startedAt - 50, label: 'before' },
          { at: startedAt + 99_000, label: 'after' },
        ],
        startedAt,
        2_000_000,
      ),
    ).toEqual([
      { us: 0, label: 'before' },
      { us: 2_000_000, label: 'after' },
    ]);
  });

  it('is empty for a run with no marks, and for a session that predates them', () => {
    expect(runMarks([], startedAt, 1_000_000)).toEqual([]);
    expect(runMarks(undefined, startedAt, 1_000_000)).toEqual([]);
  });

  it('keeps only the marks the user added, not the page events a browser run records', () => {
    expect(
      runMarks(
        [
          { at: startedAt + 1000, label: 'after login', kind: 'manual' },
          { at: startedAt + 2000, label: 'button#save "Save"', kind: 'click' },
          { at: startedAt + 3000, label: 'Mark 2' },
          { at: startedAt + 4000, label: 'http://x.test/', kind: 'navigate' },
        ],
        startedAt,
        10_000_000,
      ).map((m) => m.label),
    ).toEqual(['after login', 'Mark 2']);
  });
});
