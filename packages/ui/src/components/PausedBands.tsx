import type { BrowserTimeline } from '@pacesjs/engine';

const TEXT = { paused: 'Paused, not recording' } as const;

interface PausedBandsProps {
  data: BrowserTimeline;
}

/** Hatched bands over the stretches where recording was paused: nothing was captured there. */
export function PausedBands({ data }: PausedBandsProps) {
  return (
    <>
      {data.paused.map((p, i) => (
        <span
          key={i}
          className="paused-band"
          aria-hidden="true"
          title={TEXT.paused}
          style={{
            left: `${(p.startUs / data.durationUs) * 100}%`,
            width: `${((p.endUs - p.startUs) / data.durationUs) * 100}%`,
          }}
        />
      ))}
    </>
  );
}
