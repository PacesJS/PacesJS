import { useMemo, useRef } from 'react';
import type { BrowserTimeline } from '@pacesjs/engine';
import { useApp } from '../app/context';
import { useWidth } from '../app/useWidth';
import { fmtDuration, fmtSeconds } from '../util/format';
import { clusterInputs } from '../view/browser-lanes';
import { LaneRange } from './LaneRange';
import { PausedBands } from './PausedBands';

const TEXT = {
  title: 'Interactions',
  meta: 'What the user did',
  list: 'Interactions',
  entry: (kind: string, label: string, at: string, wait: string) =>
    `${kind} ${label} at ${at}${wait}`,
  wait: (dur: string) => `, ${dur} to show a result`,
  empty: 'No interactions were recorded',
} as const;

/** A wait for a result longer than this is drawn as slow (the slow-interaction finding's limit). */
const SLOW_US = 200_000;

interface InteractionLaneProps {
  data: BrowserTimeline;
}

/**
 * The user's clicks, typing, scrolls and navigations, clustered when zoomed out so a burst reads as
 * one block with a count. These never appear in the mark flags, which are for the user's own marks.
 */
export function InteractionLane({ data }: InteractionLaneProps) {
  const { dispatch } = useApp();
  const plot = useRef<HTMLDivElement | null>(null);
  const width = useWidth(plot);
  const clusters = useMemo(
    () => clusterInputs(data.inputs, data.durationUs, width),
    [data.inputs, data.durationUs, width],
  );

  const choose = (c: (typeof clusters)[number]): void => {
    if (c.count === 1 && c.task >= 0) {
      dispatch({
        type: 'go',
        patch: { selection: { kind: 'task', track: data.track, task: c.task } },
        options: { task: c.task },
      });
      return;
    }
    const from = Math.round(c.startUs);
    const to = Math.round(Math.max(c.endUs, c.startUs + 1000));
    dispatch({ type: 'go', patch: { range: [from, to], selection: { kind: 'range', from, to } } });
  };

  return (
    <div className="lane-grid lane interaction-lane">
      <div className="lane-head">
        <div className="lane-name">
          <span className="lane-title">{TEXT.title}</span>
          <span className="lane-meta">{TEXT.meta}</span>
        </div>
      </div>
      <div ref={plot} className="lane-plot-dom interaction-plot">
        <PausedBands data={data} />
        <LaneRange durationUs={data.durationUs} />
        <div aria-hidden="true">
          {clusters.map((c, i) => (
            <span
              key={i}
              className={`input-block kind-${c.kind}${c.slowestUs > SLOW_US ? ' is-slow' : ''}`}
              title={`${c.label} · ${fmtSeconds(c.startUs, 2)}`}
              style={{
                left: `${(c.startUs / data.durationUs) * 100}%`,
                width: `max(${((c.endUs - c.startUs) / data.durationUs) * 100}%, 10px)`,
              }}
              onClick={() => choose(c)}
            >
              {c.count > 1 ? <span className="input-count">{c.count}</span> : null}
            </span>
          ))}
        </div>
      </div>
      <ul className="sr-only" aria-label={TEXT.list}>
        {data.inputs.length === 0 ? <li>{TEXT.empty}</li> : null}
        {clusters.map((c, i) => (
          <li key={i}>
            <button type="button" onClick={() => choose(c)}>
              {TEXT.entry(
                c.kind,
                c.label,
                fmtSeconds(c.startUs, 2),
                c.slowestUs >= 0 ? TEXT.wait(fmtDuration(c.slowestUs, { approx: false })) : '',
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
