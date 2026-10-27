import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { BrowserTimeline } from '@pacesjs/engine';
import { useApp } from '../app/context';
import { useScreenshots } from '../app/useScreenshots';
import { useWidth } from '../app/useWidth';
import { fmtSeconds } from '../util/format';
import { filmstripSlots, frameLabel } from '../view/browser-lanes';
import { LaneRange } from './LaneRange';

const TEXT = {
  title: 'Filmstrip',
  frames: (n: number) => `${n} ${n === 1 ? 'frame' : 'frames'}`,
  none: 'no frame',
  paused: 'paused',
  empty: 'No screenshots were recorded',
  noShots: 'Recorded with --no-screenshots',
  showMoment: (at: string) => `Show ${at}`,
} as const;

/** Width of one thumbnail, including its gap. */
const THUMB_PX = 120;
/** Width of the enlarged frame shown while a thumbnail is hovered or focused. */
const ZOOM_PX = 480;
/** A moment either side of a frame, when it is chosen. */
const AROUND_US = 150_000;

interface FilmstripProps {
  data: BrowserTimeline;
}

/**
 * What the page looked like over the run. Each slot shows the last frame taken at or before it; a
 * slot with no frame says whether it was a pause or just no frame, and is never left blank.
 */
export function Filmstrip({ data }: FilmstripProps) {
  const { dispatch } = useApp();
  const plot = useRef<HTMLDivElement | null>(null);
  const width = useWidth(plot);
  const slotCount = Math.max(1, Math.floor(width / THUMB_PX));
  const slots = useMemo(
    () => filmstripSlots(data.screenshots, data.paused, data.durationUs, slotCount),
    [data, slotCount],
  );
  const ids = useMemo(
    () => [...new Set(slots.flatMap((s) => (s.frame === null ? [] : [s.frame])))],
    [slots],
  );
  const urls = useScreenshots(ids);
  const [zoom, setZoom] = useState<{ id: number; at: number; left: number; top: number } | null>(
    null,
  );
  const showZoom = (id: number, at: number, el: HTMLElement): void => {
    const r = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, r.left + r.width / 2 - ZOOM_PX / 2),
      window.innerWidth - ZOOM_PX - 8,
    );
    setZoom({ id, at, left, top: r.bottom + 8 });
  };
  const timeOf = useMemo(() => {
    const m = new Map<number, number>();
    data.screenshots.id.forEach((id, i) => m.set(id, data.screenshots.time[i] ?? 0));
    return m;
  }, [data]);

  const choose = (timeUs: number): void =>
    dispatch({
      type: 'go',
      patch: {
        range: [Math.max(0, Math.round(timeUs - AROUND_US)), Math.round(timeUs + AROUND_US)],
        selection: {
          kind: 'range',
          from: Math.max(0, Math.round(timeUs - AROUND_US)),
          to: Math.round(timeUs + AROUND_US),
        },
      },
    });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[at + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div className="lane-grid lane filmstrip-lane">
      <div className="lane-head">
        <div className="lane-name">
          <span className="lane-title">{TEXT.title}</span>
          <span className="lane-meta">{TEXT.frames(data.screenshotCount)}</span>
        </div>
      </div>
      <div ref={plot} className="lane-plot-dom filmstrip-plot">
        {data.screenshotCount === 0 ? (
          <p className="filmstrip-empty">{TEXT.empty}</p>
        ) : (
          <div
            role="group"
            aria-label={TEXT.title}
            className="filmstrip"
            onKeyDown={onKeyDown}
            style={{ gridTemplateColumns: `repeat(${slotCount}, minmax(0, 1fr))` }}
          >
            {slots.map((slot, i) => {
              if (slot.frame === null) {
                return (
                  <div key={i} className={`filmstrip-gap is-${slot.reason}`}>
                    <span>{slot.reason === 'paused' ? TEXT.paused : TEXT.none}</span>
                  </div>
                );
              }
              const at = timeOf.get(slot.frame) ?? slot.timeUs;
              const url = urls.get(slot.frame);
              return (
                <button
                  key={i}
                  type="button"
                  className="filmstrip-frame"
                  aria-label={frameLabel(at)}
                  title={TEXT.showMoment(fmtSeconds(at, 2))}
                  onClick={() => choose(at)}
                  onMouseEnter={(e) => showZoom(slot.frame ?? 0, at, e.currentTarget)}
                  onFocus={(e) => showZoom(slot.frame ?? 0, at, e.currentTarget)}
                  onMouseLeave={() => setZoom(null)}
                  onBlur={() => setZoom(null)}
                >
                  {url ? <img src={url} alt="" draggable={false} /> : null}
                </button>
              );
            })}
          </div>
        )}
        {zoom && urls.get(zoom.id) ? (
          <figure
            className="filmstrip-zoom"
            style={{ left: zoom.left, top: zoom.top, width: ZOOM_PX }}
          >
            <img src={urls.get(zoom.id)} alt="" />
            <figcaption>{fmtSeconds(zoom.at, 2)}</figcaption>
          </figure>
        ) : null}
        <LaneRange durationUs={data.durationUs} />
      </div>
    </div>
  );
}
