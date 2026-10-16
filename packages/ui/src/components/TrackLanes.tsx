import { useState } from 'react';
import { useApp } from '../app/context';
import { useAsync, useCanvas, usePalette } from '../app/hooks';
import type { LaneData } from '../data/overview';
import { drawDelay, laneTicks } from '../view/draw-lane';
import { fmtAxis, fmtDuration, fmtRange } from '../util/format';
import { Icon } from './Icon';
import { LanePlot } from './LanePlot';

function DelayPlot({ lane }: { lane: LaneData }) {
  const pal = usePalette();
  const ref = useCanvas(
    (ctx, { width, height }) => drawDelay(ctx, width, height, lane, pal),
    [lane, pal],
  );
  return (
    <div className="lane-delay-plot">
      <canvas ref={ref} className="lane-canvas" aria-hidden="true" />
      <span className="lane-delay-peak">
        peak {fmtDuration(lane.peakDelayUs, { approx: false })} at{' '}
        {(lane.peakDelayAtUs / 1_000_000).toFixed(1)} s
      </span>
    </div>
  );
}

/** Track lanes: axis, pin buttons, canvas plots, range overlay and a text mirror of the tasks. */
export function TrackLanes() {
  const { client, snap, state, dispatch, selection, summary } = useApp();
  const overview = useAsync(() => client.overview(), 'overview').data;
  const [hover, setHover] = useState<{ lane: string; task: number }>({ lane: '', task: -1 });
  if (!overview)
    return (
      <div className="status-line" role="status">
        Loading tracks…
      </div>
    );

  const ticks = laneTicks(overview.durationUs);
  const lanes = [...overview.lanes].sort((a, b) => {
    const pa = state.pinned.includes(a.id) ? 0 : 1;
    const pb = state.pinned.includes(b.id) ? 0 : 1;
    return pa - pb;
  });
  const frac = (us: number): number => Math.min(1, Math.max(0, us / overview.durationUs));
  const range = snap.range;

  return (
    <div className="tracks-scroll">
      <div className="tracks-inner">
        <div className="lane-grid" style={{ alignItems: 'end', paddingBottom: 4 }}>
          <div />
          <div className="lane-axis">
            {ticks.map((t) => (
              <span key={t} className="lane-axis-tick" style={{ left: `${frac(t) * 100}%` }}>
                {fmtAxis(t, 's', true)}
              </span>
            ))}
          </div>
        </div>
        {lanes.map((lane) => {
          const pinned = state.pinned.includes(lane.id);
          const selectedTask =
            selection.task && selection.track === lane.id ? selection.task.index : -1;
          const top = longestTasks(lane, 24);
          return (
            <div key={lane.id}>
              <div className="lane-grid lane">
                <div className="lane-head">
                  <button
                    type="button"
                    className="pin-btn"
                    aria-label={`${pinned ? 'Unpin' : 'Pin'} ${lane.label}`}
                    aria-pressed={pinned}
                    onClick={() => dispatch({ type: 'toggle-pin', track: lane.id })}
                  >
                    <Icon name="pin" size={16} />
                  </button>
                  <div className="lane-name">
                    <span className="lane-title">{lane.label}</span>
                    <span className="lane-meta">{lane.meta}</span>
                  </div>
                </div>
                <LanePlot
                  lane={lane}
                  ticks={ticks}
                  selectedTask={selectedTask}
                  hoveredTask={hover.lane === lane.id ? hover.task : -1}
                  onHoverTask={(task) => setHover({ lane: lane.id, task })}
                  onSelectTask={(task) =>
                    dispatch(
                      task >= 0
                        ? {
                            type: 'go',
                            patch: {
                              selection: { kind: 'task', track: lane.id, task },
                              view: snap.view,
                            },
                            options: { task },
                          }
                        : { type: 'select', selection: { kind: 'none' } },
                    )
                  }
                  onRange={(from, to) =>
                    dispatch({
                      type: 'go',
                      patch: {
                        range: [Math.round(from), Math.round(to)],
                        selection: { kind: 'range', from: Math.round(from), to: Math.round(to) },
                      },
                    })
                  }
                />
              </div>
              {lane.hasLoopData ? (
                <div className="lane-delay">
                  <span className="lane-delay-label">Loop delay, p99</span>
                  <DelayPlot lane={lane} />
                </div>
              ) : null}
              <ul className="sr-only" aria-label={`Longest tasks on ${lane.label}`}>
                {top.map((i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() =>
                        dispatch({
                          type: 'go',
                          patch: { selection: { kind: 'task', track: lane.id, task: i } },
                          options: { task: i },
                        })
                      }
                    >
                      {`${lane.taskLabels[i] || 'task'}, ${fmtDuration((lane.taskEnd[i] ?? 0) - (lane.taskStart[i] ?? 0))}, at ${((lane.taskStart[i] ?? 0) / 1_000_000).toFixed(2)} s`}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {range ? (
          <div
            className="range-overlay"
            role="group"
            aria-label={`Selected range ${fmtRange(range[0], range[1])}`}
            style={{
              left: `calc(212px + (100% - 212px) * ${frac(range[0])})`,
              width: `calc((100% - 212px) * ${frac(range[1]) - frac(range[0])})`,
            }}
          >
            <span className="range-label">{fmtRange(range[0], range[1])}</span>
          </div>
        ) : null}
        <span className="sr-only" role="status">
          {summary.tracks.length} tracks
        </span>
      </div>
    </div>
  );
}

function longestTasks(lane: LaneData, n: number): number[] {
  const idx = Array.from({ length: lane.taskStart.length }, (_, i) => i);
  const dur = (i: number): number => (lane.taskEnd[i] ?? 0) - (lane.taskStart[i] ?? 0);
  return idx.sort((a, b) => dur(b) - dur(a) || a - b).slice(0, n);
}
