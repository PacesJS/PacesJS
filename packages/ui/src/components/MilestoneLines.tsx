import { useMemo } from 'react';
import { useBrowserData } from '../app/useBrowserData';
import { milestones } from '../view/milestones';

/**
 * One line per loading milestone, from the top of the page lane to the bottom of the last lane, so
 * what happened at that moment can be read straight down every track. What each line is shows when
 * it is hovered in the page lane; the lines carry only their color.
 */
export function MilestoneLines() {
  const data = useBrowserData();
  const marks = useMemo(() => (data ? milestones(data.vitals, data.durationUs) : []), [data]);
  if (!data || marks.length === 0) return null;
  return (
    <div className="milestone-lines" aria-hidden="true">
      {marks.map((m) => (
        <span
          key={`${m.kind}-${m.timeUs}`}
          className={`milestone-line is-${m.kind}`}
          style={{ left: `${(m.timeUs / data.durationUs) * 100}%` }}
        />
      ))}
    </div>
  );
}
