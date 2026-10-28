import { useMemo, useRef } from 'react';
import { useApp } from '../app/context';
import type { BrowserTimeline } from '@pacesjs/engine';
import { useHoverTip } from '../app/useHoverTip';
import { useWidth } from '../app/useWidth';
import { fmtBytes, fmtSeconds } from '../util/format';
import { idleLabel, idleShares, requestName, waitingTip } from '../view/waiting';
import { LaneRange } from './LaneRange';
import { LaneTip } from './LaneTip';

const TEXT = {
  title: 'Waiting',
  meta: 'Idle time and requests',
  idleList: 'Idle stretches',
  requestList: 'Slowest requests',
  request: (name: string, type: string, took: string, at: string) =>
    `${name}, ${type}, ${took} from ${at}`,
  bytes: (size: string) => `, ${size}`,
  empty: 'The main thread was never idle for long',
} as const;

/** Idle stretches shorter than this are drawn but not listed for screen readers. */
const LISTED_IDLE_US = 200_000;
const LISTED_REQUESTS = 8;
const CHART_PX = 44;
const LANE_PAD_PX = 4;
/** One column of the in-flight chart per this many pixels of width. */
const COLUMN_PX = 2;

interface WaitingLaneProps {
  data: BrowserTimeline;
}

/** Stacked columns: idle with requests in flight at the bottom, idle with none above it. */
export function sharesPath(
  shares: readonly number[],
  below: readonly number[],
  height: number,
): string {
  let d = '';
  shares.forEach((share, i) => {
    if (share <= 0) return;
    const base = height - (below[i] ?? 0) * height;
    const rise = Math.max(1, share * height);
    d += `M${i},${base} h1 v${-rise} h-1 z `;
  });
  return d.trim();
}

/**
 * What the page was waiting on. Each column is a slice of the run: the blue part is how much of it
 * the main thread sat idle with a request in flight, the grey part idle with none, and the rest was
 * busy. Hover anywhere to see which requests were under way and what the page was idle for.
 */
export function WaitingLane({ data }: WaitingLaneProps) {
  const { dispatch } = useApp();
  const plot = useRef<HTMLDivElement | null>(null);
  const width = useWidth(plot);
  const { tip, show, hide } = useHoverTip();
  const columns = Math.max(10, Math.round(width / COLUMN_PX));
  const shares = useMemo(
    () => idleShares(data.idle, data.durationUs, columns),
    [data.idle, data.durationUs, columns],
  );
  const waitingPath = useMemo(
    () => sharesPath(shares.waiting, new Array<number>(columns).fill(0), CHART_PX),
    [shares, columns],
  );
  const nothingPath = useMemo(() => sharesPath(shares.nothing, shares.waiting, CHART_PX), [shares]);
  const pick = (from: number, to: number): void => {
    const a = Math.round(from);
    const b = Math.round(to);
    dispatch({
      type: 'go',
      patch: { range: [a, b], selection: { kind: 'range', from: a, to: b } },
    });
  };
  const slowest = [...data.requests]
    .sort((a, b) => b.endUs - b.startUs - (a.endUs - a.startUs))
    .slice(0, LISTED_REQUESTS);
  const listed = data.idle.filter((s) => s.endUs - s.startUs >= LISTED_IDLE_US);
  const timeAt = (e: React.MouseEvent<HTMLDivElement>): number | undefined => {
    const box = e.currentTarget.getBoundingClientRect();
    return box.width > 0 ? ((e.clientX - box.left) / box.width) * data.durationUs : undefined;
  };
  const hover = (e: React.MouseEvent<HTMLDivElement>): void => {
    const at = timeAt(e);
    if (at !== undefined) show(e.currentTarget, waitingTip(data, at), e.clientX);
  };
  const choose = (e: React.MouseEvent<HTMLDivElement>): void => {
    const at = timeAt(e);
    const stretch =
      at === undefined ? undefined : data.idle.find((s) => s.startUs <= at && at <= s.endUs);
    if (stretch) pick(stretch.startUs, stretch.endUs);
  };

  return (
    <div className="lane-grid lane waiting-lane">
      <div className="lane-head">
        <div className="lane-name">
          <span className="lane-title">{TEXT.title}</span>
          <span className="lane-meta">{TEXT.meta}</span>
        </div>
      </div>
      <div
        ref={plot}
        className="lane-plot-dom waiting-plot"
        style={{ height: CHART_PX + LANE_PAD_PX * 2 }}
        onMouseMove={hover}
        onClick={choose}
        onMouseLeave={hide}
      >
        <LaneRange durationUs={data.durationUs} />
        <div aria-hidden="true">
          <svg
            className="waiting-chart"
            viewBox={`0 0 ${columns} ${CHART_PX}`}
            preserveAspectRatio="none"
            style={{ top: LANE_PAD_PX, height: CHART_PX }}
          >
            <path className="cause-nothing" d={nothingPath} />
            <path className="cause-requests" d={waitingPath} />
          </svg>
        </div>
      </div>
      <LaneTip tip={tip} />
      <ul className="sr-only" aria-label={TEXT.idleList}>
        {listed.length === 0 ? <li>{TEXT.empty}</li> : null}
        {listed.map((s, i) => (
          <li key={i}>
            <button type="button" onClick={() => pick(s.startUs, s.endUs)}>
              {`${idleLabel(s)}, from ${fmtSeconds(s.startUs, 2)}`}
            </button>
          </li>
        ))}
      </ul>
      <ul className="sr-only" aria-label={TEXT.requestList}>
        {slowest.map((r, i) => (
          <li key={i}>
            <button type="button" onClick={() => pick(r.startUs, r.endUs)}>
              {TEXT.request(
                requestName(r.url),
                r.type,
                fmtSeconds(r.endUs - r.startUs, 2),
                fmtSeconds(r.startUs, 2),
              ) + (r.wireBytes >= 0 ? TEXT.bytes(fmtBytes(r.wireBytes)) : '')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
