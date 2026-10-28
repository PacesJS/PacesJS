import { useMemo, useRef } from 'react';
import type { BrowserTimeline } from '@pacesjs/engine';
import { useApp } from '../app/context';
import { useWidth } from '../app/useWidth';
import { fmtDuration } from '../util/format';
import { lodRender } from '../view/browser-lanes';
import { LaneRange } from './LaneRange';

const TEXT = {
  title: 'Rendering',
  meta: 'Style, layout, paint (exact)',
  forced: 'forced by script',
  summary: (rows: number, forced: number) =>
    `${rows} rendering ${rows === 1 ? 'step' : 'steps'}${forced > 0 ? `, ${forced} forced by script` : ''}`,
  frames: 'Frames',
  dropped: 'dropped frame',
  block: (phase: string, count: number, forced: boolean) =>
    `${phase}${count > 1 ? ` ×${count}` : ''}${forced ? ` · ${TEXT.forced}` : ''}`,
} as const;

interface RenderLaneProps {
  data: BrowserTimeline;
}

/** Style, layout, paint and composite work of the page, with the frames it produced; all exact. */
export function RenderLane({ data }: RenderLaneProps) {
  const { dispatch } = useApp();
  const plot = useRef<HTMLDivElement | null>(null);
  const width = useWidth(plot);
  const blocks = useMemo(
    () => lodRender(data.render, data.durationUs, width),
    [data.render, data.durationUs, width],
  );
  const forcedRows = useMemo(() => data.render.filter((r) => r.forced).length, [data.render]);

  const focus = (left: number, w: number): void => {
    const from = Math.round(left * data.durationUs);
    const to = Math.round((left + w) * data.durationUs);
    dispatch({
      type: 'go',
      patch: { range: [from, to], selection: { kind: 'range', from, to } },
    });
  };

  return (
    <div className="lane-grid lane render-lane">
      <div className="lane-head">
        <div className="lane-name">
          <span className="lane-title">{TEXT.title}</span>
          <span className="lane-meta">{TEXT.meta}</span>
        </div>
      </div>
      <div ref={plot} className="lane-plot-dom render-plot">
        <LaneRange durationUs={data.durationUs} />
        <div className="render-frames" aria-hidden="true">
          {Array.from(data.frames.end, (end, i) => (
            <span
              key={i}
              className={`frame-tick${data.frames.dropped[i] === 1 ? ' is-dropped' : ''}`}
              title={data.frames.dropped[i] === 1 ? TEXT.dropped : TEXT.frames}
              style={{ left: `${(end / data.durationUs) * 100}%` }}
            />
          ))}
        </div>
        <div className="render-blocks" aria-hidden="true">
          {blocks.map((b, i) => (
            <span
              key={i}
              className={`render-block phase-${b.phase}${b.forced ? ' is-forced' : ''}`}
              title={`${TEXT.block(b.phase, b.count, b.forced)} · ${fmtDuration(b.width * data.durationUs, { approx: false })}`}
              style={{ left: `${b.left * 100}%`, width: `${b.width * 100}%` }}
              onClick={() => focus(b.left, b.width)}
            />
          ))}
        </div>
      </div>
      <p className="sr-only">{TEXT.summary(data.render.length, forcedRows)}</p>
    </div>
  );
}
