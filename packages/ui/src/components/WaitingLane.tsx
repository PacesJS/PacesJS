import { useApp } from '../app/context';
import type { BrowserTimeline } from '@pacesjs/engine';
import { fmtBytes, fmtSeconds } from '../util/format';
import { idleLabel, requestName } from '../view/waiting';
import { LaneRange } from './LaneRange';
import { PausedBands } from './PausedBands';

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
const ROW_PX = 6;
const STRIP_PX = 10;
const LANE_PAD_PX = 6;

interface WaitingLaneProps {
  data: BrowserTimeline;
}

/**
 * What the page was waiting on while the main thread had nothing to run. The strip is the idle time,
 * blue when a request was in flight and dotted when none was; the bars under it are the requests.
 */
export function WaitingLane({ data }: WaitingLaneProps) {
  const { dispatch } = useApp();
  const rows = data.requests.reduce((n, r) => Math.max(n, r.row + 1), 0);
  const left = (us: number): string => `${(us / data.durationUs) * 100}%`;
  const wide = (from: number, to: number, min: string): string =>
    `max(${((to - from) / data.durationUs) * 100}%, ${min})`;
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

  return (
    <div className="lane-grid lane waiting-lane">
      <div className="lane-head">
        <div className="lane-name">
          <span className="lane-title">{TEXT.title}</span>
          <span className="lane-meta">{TEXT.meta}</span>
        </div>
      </div>
      <div
        className="lane-plot-dom waiting-plot"
        style={{ height: STRIP_PX + rows * ROW_PX + LANE_PAD_PX * 2 }}
      >
        <PausedBands data={data} />
        <LaneRange durationUs={data.durationUs} />
        <div aria-hidden="true">
          {data.idle.map((s, i) => (
            <span
              key={i}
              className={`idle-block cause-${s.cause}`}
              title={idleLabel(s)}
              style={{ left: left(s.startUs), width: wide(s.startUs, s.endUs, '2px') }}
              onClick={() => pick(s.startUs, s.endUs)}
            />
          ))}
          {data.requests.map((r, i) => (
            <span
              key={i}
              className="request-bar"
              title={TEXT.request(
                requestName(r.url),
                r.type,
                fmtSeconds(r.endUs - r.startUs, 2),
                fmtSeconds(r.startUs, 2),
              )}
              style={{
                left: left(r.startUs),
                width: wide(r.startUs, r.endUs, '2px'),
                top: STRIP_PX + LANE_PAD_PX + r.row * ROW_PX,
              }}
              onClick={() => pick(r.startUs, r.endUs)}
            />
          ))}
        </div>
      </div>
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
