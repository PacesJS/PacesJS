import { useState } from 'react';
import type { Finding } from '@pacesjs/engine';
import { useApp } from '../app/context';
import { withVisibleTarget } from '../state/showme-resolve';
import { clearShowMeAction, isShowing, showMeAction, showMeContext } from '../state/showme';

const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

function opensLabel(f: Finding): string {
  const v = f.showMe.view;
  if (f.kind === 'hot-function' && f.showMe.line !== undefined) return 'source';
  if (v === 'waterfall') return f.showMe.line !== undefined ? 'waterfall + source' : 'waterfall';
  if (v === 'flame') return 'flame graph';
  if (v === 'callgraph') return 'call graph';
  if (v === 'functions') return 'functions';
  return 'track timeline';
}

export function Findings() {
  const { client, summary, snap, dispatch, primaryTrack, search } = useApp();
  const [all, setAll] = useState(false);
  // The engine already ranks findings (severity, impact, rule order, id): #1 is the top finding.
  const ranked = summary.findings;
  const shown = all ? ranked : ranked.slice(0, 5);
  const ctx = showMeContext(summary);
  /** Show me (or clear it when active), then bring the proving view into sight. */
  const press = async (f: Finding, active: boolean): Promise<void> => {
    if (active) {
      dispatch(clearShowMeAction(f, snap));
      return;
    }
    const target = await withVisibleTarget(client, f.showMe);
    dispatch(showMeAction(target, snap, primaryTrack, ctx));
    requestAnimationFrame(() =>
      document.querySelector('.main-view')?.scrollIntoView({ block: 'start' }),
    );
  };
  const activeId = ranked.find((f) => isShowing(f, snap, search, ctx))?.id ?? null;

  return (
    <div className="findings">
      <div className="section-head">
        <h2 className="section-title">Findings</h2>
        <span className="section-sub">
          {ranked.length === 0
            ? 'No findings: nothing crossed a threshold in this run'
            : `Top ${shown.length} of ${ranked.length}, ranked by severity · thresholds from paces.config.json`}
        </span>
        {ranked.length > 5 ? (
          <button type="button" className="section-link" onClick={() => setAll((v) => !v)}>
            {all ? 'Show top 5' : `View all ${ranked.length}`}
          </button>
        ) : null}
      </div>
      {ranked.length > 0 ? (
        <ol className="findings-grid">
          {shown.map((f, i) => {
            const active = f.id === activeId;
            return (
              <li
                key={f.id}
                className={`finding-card${active ? ' is-active' : ''}`}
                aria-current={active ? 'true' : undefined}
              >
                <div className="finding-head">
                  <span className={`sev-pill sev-${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
                  <span className="section-sub">#{i + 1}</span>
                </div>
                <h3 className="finding-title">{f.title}</h3>
                <p className="finding-text">{f.summary}</p>
                <p className="finding-rule">Rule: {f.rule.replace(/^Rule:\s*/i, '')}</p>
                <div className="finding-foot">
                  <span className="finding-opens">Opens {opensLabel(f)}</span>
                  <button
                    type="button"
                    className={`btn${active ? ' btn-primary' : ''}`}
                    aria-label={`Show me: ${f.title}`}
                    aria-pressed={active}
                    title={active ? 'Showing this finding. Press again to clear it.' : undefined}
                    onClick={() => void press(f, active)}
                  >
                    {active ? 'Showing' : 'Show me'}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
