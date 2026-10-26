import type { BrowserTimeline } from '@pacesjs/engine';
import { useApp } from '../app/context';
import { fmtDuration, fmtSeconds } from '../util/format';
import { LaneRange } from './LaneRange';
import { PausedBands } from './PausedBands';

const TEXT = {
  title: 'Milestones',
  meta: 'Loading and long tasks',
  milestones: 'Page milestones',
  longTasks: 'Long tasks',
  at: (name: string, when: string) => `${name} at ${when}`,
  shift: (score: string, when: string) => `Layout shift ${score} at ${when}`,
  longTask: (dur: string, when: string) => `Long task, ${dur}, at ${when}`,
  navigation: 'Navigation',
} as const;

const NAMES: Record<string, string> = {
  navigation: TEXT.navigation,
  DOMContentLoaded: 'DOMContentLoaded',
  load: 'Load',
  FCP: 'First contentful paint',
  LCP: 'Largest contentful paint',
};

interface PageLaneProps {
  data: BrowserTimeline;
}

/**
 * The page as a whole: navigation, loading milestones, layout shifts and the long tasks of the main
 * thread. The marks are exact (from trace events), so none of them carries a `~`.
 */
export function PageLane({ data }: PageLaneProps) {
  const { dispatch } = useApp();
  const left = (us: number): string => `${(us / data.durationUs) * 100}%`;
  const selectTask = (task: number): void =>
    dispatch({
      type: 'go',
      patch: { selection: { kind: 'task', track: data.track, task } },
      options: { task },
    });

  return (
    <div className="lane-grid lane page-lane">
      <div className="lane-head">
        <div className="lane-name">
          <span className="lane-title">{TEXT.title}</span>
          <span className="lane-meta">{TEXT.meta}</span>
        </div>
      </div>
      <div className="lane-plot-dom page-plot">
        <PausedBands data={data} />
        <LaneRange durationUs={data.durationUs} />
        <div aria-hidden="true">
          {data.vitals.map((v, i) =>
            v.name === 'shift' ? (
              <span
                key={i}
                className="page-mark is-shift"
                style={{ left: left(v.timeUs), height: `${Math.min(100, 20 + v.value * 300)}%` }}
              />
            ) : (
              <span key={i} className={`page-mark is-${v.name}`} style={{ left: left(v.timeUs) }}>
                {v.name === 'FCP' || v.name === 'load' ? (
                  <span className="page-mark-label">{v.name}</span>
                ) : null}
              </span>
            ),
          )}
          {data.longTasks.map((t) => (
            <span
              key={t.task}
              className="page-long-task"
              style={{
                left: left(t.startUs),
                width: `max(${(t.durationUs / data.durationUs) * 100}%, 3px)`,
              }}
            />
          ))}
        </div>
      </div>
      <ul className="sr-only" aria-label={TEXT.milestones}>
        {data.vitals.map((v, i) => (
          <li key={i}>
            {v.name === 'shift'
              ? TEXT.shift(v.value.toFixed(2), fmtSeconds(v.timeUs, 2))
              : TEXT.at(NAMES[v.name] ?? v.name, fmtSeconds(v.timeUs, 2))}
          </li>
        ))}
      </ul>
      <ul className="sr-only" aria-label={TEXT.longTasks}>
        {data.longTasks.map((t) => (
          <li key={t.task}>
            <button type="button" onClick={() => selectTask(t.task)}>
              {TEXT.longTask(
                fmtDuration(t.durationUs, { approx: false }),
                fmtSeconds(t.startUs, 2),
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
