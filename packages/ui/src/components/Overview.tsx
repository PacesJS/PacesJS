import type { ReactNode } from 'react';
import { useApp } from '../app/context';
import { BrowserLanesBottom } from './BrowserLanesBottom';
import { BrowserFilmstrip } from './BrowserFilmstrip';
import { BrowserPageLane } from './BrowserPageLane';
import { Findings } from './Findings';
import { MilestoneLines } from './MilestoneLines';
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
  exact: 'Exact: rendering, frames, input',
  thirdParty: 'Third-party',
  pageInternals: 'Browser internals',
} as const;

/** The lanes of a page share a box the milestone lines run down; a Node run has no such lines and no box. */
function LaneStack({ page, children }: { page: boolean; children: ReactNode }) {
  return page ? <div className="lane-stack">{children}</div> : <>{children}</>;
}

/** Overview band: findings strip on top, track lanes below. */
export function Overview() {
  const { summary } = useApp();
  const page = summary.browser !== undefined;
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
                {page ? TEXT.thirdParty : TEXT.dependency}
              </li>
              <li className="legend-item">
                <span
                  aria-hidden="true"
                  className="legend-swatch"
                  style={{ background: 'var(--c-origin-node)' }}
                />
                {page ? TEXT.pageInternals : TEXT.nodeInternals}
              </li>
              {page ? (
                <li className="legend-item">
                  <span aria-hidden="true" className="legend-swatch legend-exact" />
                  {TEXT.exact}
                </li>
              ) : null}
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
          <BrowserFilmstrip />
          <LaneStack page={page}>
            <MilestoneLines />
            <BrowserPageLane />
            <TrackLanes />
            <BrowserLanesBottom />
          </LaneStack>
        </div>
      </div>
    </section>
  );
}
