import { useState } from 'react';
import type { Finding, ShowMe } from '@pacesjs/engine';
import { useApp } from '../app/context';
import { showMeAction } from '../state/showme';
import type { Selection } from '../state/types';

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

export function rankFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] ||
        b.f.impact - a.f.impact ||
        a.i - b.i,
    )
    .map((x) => x.f);
}

export function opensLabel(f: Finding): string {
  const v = f.showMe.view;
  if (f.kind === 'hot-function' && f.showMe.line !== undefined) return 'source';
  if (v === 'waterfall') return f.showMe.line !== undefined ? 'waterfall + source' : 'waterfall';
  if (v === 'flame') return 'flame graph';
  if (v === 'callgraph') return 'call graph';
  if (v === 'functions') return 'functions';
  return 'track timeline';
}

function sameTarget(sel: Selection, showMe: ShowMe): boolean {
  if (showMe.task !== undefined) return sel.kind === 'task' && sel.task === showMe.task;
  if (showMe.fn !== undefined) return sel.kind === 'fn' && sel.fn === showMe.fn;
  return false;
}

export function Findings() {
  const { summary, snap, dispatch, primaryTrack } = useApp();
  const [all, setAll] = useState(false);
  const ranked = rankFindings(summary.findings);
  const shown = all ? ranked : ranked.slice(0, 5);
  const activeId = ranked.find((f) => sameTarget(snap.selection, f.showMe))?.id ?? null;

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
                    onClick={() => dispatch(showMeAction(f.showMe, snap, primaryTrack))}
                  >
                    Show me
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
