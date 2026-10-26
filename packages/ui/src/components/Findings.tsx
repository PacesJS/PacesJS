import { useState } from 'react';
import type { Finding } from '@pacesjs/engine';
import { useApp } from '../app/context';
import { withVisibleTarget } from '../state/showme-resolve';
import { clearShowMeAction, isShowing, showMeAction, showMeContext } from '../state/showme';

const TEXT = {
  severity: { high: 'High', medium: 'Medium', low: 'Low' },
  opensSource: 'source',
  opensWaterfallSource: 'waterfall + source',
  opensWaterfall: 'waterfall',
  opensFlame: 'flame graph',
  opensCallGraph: 'call graph',
  opensFunctions: 'functions',
  opensTimeline: 'track timeline',
  title: 'Findings',
  none: 'No findings: nothing crossed a threshold in this run',
  top: (shown: number, total: number) =>
    `Top ${shown} of ${total}, ranked by severity · thresholds from paces.config.json`,
  showTop: 'Show top 5',
  viewAll: (total: number) => `View all ${total}`,
  rank: (n: number) => `#${n}`,
  rule: (rule: string) => `Rule: ${rule}`,
  fix: (hint: string) => `Fix: ${hint}`,
  opens: (what: string) => `Opens ${what}`,
  showMeLabel: (title: string) => `Show me: ${title}`,
  showingTitle: 'Showing this finding. Press again to clear it.',
  showing: 'Showing',
  showMe: 'Show me',
} as const;

function opensLabel(f: Finding): string {
  const v = f.showMe.view;
  if (f.kind === 'hot-function' && f.showMe.line !== undefined) return TEXT.opensSource;
  if (v === 'waterfall')
    return f.showMe.line !== undefined ? TEXT.opensWaterfallSource : TEXT.opensWaterfall;
  if (v === 'flame') return TEXT.opensFlame;
  if (v === 'callgraph') return TEXT.opensCallGraph;
  if (v === 'functions') return TEXT.opensFunctions;
  return TEXT.opensTimeline;
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
        <h2 className="section-title">{TEXT.title}</h2>
        <span className="section-sub">
          {ranked.length === 0 ? TEXT.none : TEXT.top(shown.length, ranked.length)}
        </span>
        {ranked.length > 5 ? (
          <button type="button" className="section-link" onClick={() => setAll((v) => !v)}>
            {all ? TEXT.showTop : TEXT.viewAll(ranked.length)}
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
                  <span className={`sev-pill sev-${f.severity}`}>{TEXT.severity[f.severity]}</span>
                  <span className="section-sub">{TEXT.rank(i + 1)}</span>
                </div>
                <h3 className="finding-title">{f.title}</h3>
                <p className="finding-text">{f.summary}</p>
                {f.hint ? <p className="finding-hint">{TEXT.fix(f.hint)}</p> : null}
                <p className="finding-rule">{TEXT.rule(f.rule.replace(/^Rule:\s*/i, ''))}</p>
                <div className="finding-foot">
                  <span className="finding-opens">{TEXT.opens(opensLabel(f))}</span>
                  <button
                    type="button"
                    className={`btn${active ? ' btn-primary' : ''}`}
                    aria-label={TEXT.showMeLabel(f.title)}
                    aria-pressed={active}
                    title={active ? TEXT.showingTitle : undefined}
                    onClick={() => void press(f, active)}
                  >
                    {active ? TEXT.showing : TEXT.showMe}
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
