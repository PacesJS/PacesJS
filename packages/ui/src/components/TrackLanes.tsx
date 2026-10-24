import { useMemo, useState } from 'react';
import { useApp } from '../app/context';
import { useAsync, useCanvas, usePalette } from '../app/hooks';
import type { LaneData } from '../data/types';
import { drawDelay, laneTicks } from '../view/draw-lane';
import { fmtAxis, fmtDuration, fmtRange, fmtSeconds } from '../util/format';
import { clamp } from '../view/scale';
import { Icon } from './Icon';
import { LanePlot } from './LanePlot';
import { MarkFlags } from './MarkFlags';

const TEXT = {
  peak: (delay: string, at: string) => `peak ${delay} at ${at}`,
  loading: 'Loading tracks…',
  pin: (label: string) => `Pin ${label}`,
  unpin: (label: string) => `Unpin ${label}`,
  supporting: 'supporting',
  supportingTitle: 'npx/npm wrapper process: it launches the target and does little work itself',
  loopDelay: 'Loop delay, p99',
  longest: (label: string) => `Longest tasks on ${label}`,
  task: 'task',
  taskEntry: (label: string, duration: string, at: string) => `${label}, ${duration}, at ${at}`,
  selectedRange: (range: string) => `Selected range ${range}`,
  trackCount: (count: number) => `${count} tracks`,
} as const;

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
        {TEXT.peak(
          fmtDuration(lane.peakDelayUs, { approx: false }),
          fmtSeconds(lane.peakDelayAtUs, 1),
        )}
      </span>
    </div>
  );
}

/** Track lanes: axis, pin buttons, canvas plots, range overlay and a text mirror of the tasks. */
export function TrackLanes() {
  const { client, snap, state, dispatch, selection, summary } = useApp();
  const overview = useAsync(() => client.overview(), 'overview').data;
  const [hover, setHover] = useState<{ lane: string; task: number }>({ lane: '', task: -1 });
  // Stable between renders so an unrelated state change (a hover elsewhere) repaints no lane canvas.
  const ticks = useMemo(() => (overview ? laneTicks(overview.durationUs) : []), [overview]);
  const lanes = useMemo(
    () =>
      [...(overview?.lanes ?? [])].sort((a, b) => {
        const pa = state.pinned.includes(a.id) ? 0 : 1;
        const pb = state.pinned.includes(b.id) ? 0 : 1;
        return pa - pb;
      }),
    [overview, state.pinned],
  );
  if (!overview)
    return (
      <div className="status-line" role="status">
        {TEXT.loading}
      </div>
    );

  const frac = (us: number): number => clamp(us / overview.durationUs, 0, 1);
  const range = snap.range;
  const focusRange = (from: number, to: number): void =>
    dispatch({
      type: 'go',
      patch: {
        range: [Math.round(from), Math.round(to)],
        selection: { kind: 'range', from: Math.round(from), to: Math.round(to) },
      },
    });

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
        <MarkFlags marks={summary.marks} durationUs={overview.durationUs} onRange={focusRange} />
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
                    aria-label={pinned ? TEXT.unpin(lane.label) : TEXT.pin(lane.label)}
                    aria-pressed={pinned}
                    onClick={() => dispatch({ type: 'toggle-pin', track: lane.id })}
                  >
                    <Icon name="pin" size={16} />
                  </button>
                  <div className={`lane-name${lane.support ? ' is-support' : ''}`}>
                    <span className="lane-title">{lane.label}</span>
                    <span className="lane-meta">{lane.meta}</span>
                    {lane.support ? (
                      <span className="lane-support" title={TEXT.supportingTitle}>
                        {TEXT.supporting}
                      </span>
                    ) : null}
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
                  onRange={focusRange}
                />
              </div>
              {lane.hasLoopData ? (
                <div className="lane-delay">
                  <span className="lane-delay-label">{TEXT.loopDelay}</span>
                  <DelayPlot lane={lane} />
                </div>
              ) : null}
              <ul className="sr-only" aria-label={TEXT.longest(lane.label)}>
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
                      {TEXT.taskEntry(
                        lane.taskLabels[i] || TEXT.task,
                        fmtDuration((lane.taskEnd[i] ?? 0) - (lane.taskStart[i] ?? 0)),
                        fmtSeconds(lane.taskStart[i] ?? 0, 2),
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {summary.marks.map((m, i) => (
          <div
            key={`${m.us}-${i}`}
            className="mark-line"
            aria-hidden="true"
            style={{
              left: `calc(var(--lane-head-w) + var(--sp-12) + (100% - var(--lane-head-w) - var(--sp-12)) * ${frac(m.us)})`,
            }}
          />
        ))}
        {range ? (
          <div
            className="range-overlay"
            role="group"
            aria-label={TEXT.selectedRange(fmtRange(range[0], range[1]))}
            style={{
              left: `calc(var(--lane-head-w) + var(--sp-12) + (100% - var(--lane-head-w) - var(--sp-12)) * ${frac(range[0])})`,
              width: `calc((100% - var(--lane-head-w) - var(--sp-12)) * ${frac(range[1]) - frac(range[0])})`,
            }}
          >
            <span className="range-label">{fmtRange(range[0], range[1])}</span>
          </div>
        ) : null}
        <span className="sr-only" role="status">
          {TEXT.trackCount(summary.tracks.length)}
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
