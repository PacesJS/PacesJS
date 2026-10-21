import { Findings } from './Findings';
import { TrackLanes } from './TrackLanes';

const TEXT = {
  overview: 'Overview',
  tracks: 'Tracks',
  tracksSub: 'Drag across the lanes to set the range for every view',
  legend: 'Legend',
  cpuBusy: 'CPU busy',
  yourCode: 'Your code',
  dependency: 'Dependency',
  nodeInternals: 'Node internals',
  longTask: 'Long task, over 50 ms',
  gcPause: 'GC pause',
} as const;

/** Overview band: findings strip on top, track lanes below. */
export function Overview() {
  return (
    <section aria-label={TEXT.overview} className="overview card">
      <div className="overview-bar" aria-hidden="true" />
      <div className="overview-body">
        <Findings />
        <div className="tracks">
          <div className="section-head" style={{ alignItems: 'center' }}>
            <h2 className="section-title">{TEXT.tracks}</h2>
            <span className="section-sub">{TEXT.tracksSub}</span>
            <ul className="legend tracks-legend" aria-label={TEXT.legend}>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{
                    width: 14,
                    height: 8,
                    borderRadius: 2,
                    background: 'var(--c-cpu-fill)',
                    borderTop: '2px solid var(--c-cpu-line)',
                  }}
                />
                {TEXT.cpuBusy}
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ background: 'var(--c-origin-you)' }}
                />
                {TEXT.yourCode}
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ background: 'var(--c-origin-dependency)' }}
                />
                {TEXT.dependency}
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ background: 'var(--c-origin-node)' }}
                />
                {TEXT.nodeInternals}
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 2,
                    background: 'var(--c-sev-medium)',
                    border: '1px solid var(--c-outline)',
                  }}
                />
                {TEXT.longTask}
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ width: 2, height: 10, borderRadius: 0, background: 'var(--c-gc-tick)' }}
                />
                {TEXT.gcPause}
              </li>
            </ul>
          </div>
          <TrackLanes />
        </div>
      </div>
    </section>
  );
}
