import { Findings } from './Findings';
import { TrackLanes } from './TrackLanes';

/** Overview band: findings strip on top, track lanes below. */
export function Overview() {
  return (
    <section aria-label="Overview" className="overview card">
      <div className="overview-bar" aria-hidden="true" />
      <div className="overview-body">
        <Findings />
        <div className="tracks">
          <div className="section-head" style={{ alignItems: 'center' }}>
            <h2 className="section-title">Tracks</h2>
            <span className="section-sub">
              Drag across the lanes to set the range for every view
            </span>
            <ul className="legend tracks-legend" aria-label="Legend">
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
                CPU busy
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ background: 'var(--c-origin-you)' }}
                />
                Your code
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ background: 'var(--c-origin-dependency)' }}
                />
                Dependency
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ background: 'var(--c-origin-node)' }}
                />
                Node internals
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
                Long task, over 50 ms
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ width: 2, height: 10, borderRadius: 0, background: 'var(--c-gc-tick)' }}
                />
                GC pause
              </li>
            </ul>
          </div>
          <TrackLanes />
        </div>
      </div>
    </section>
  );
}
