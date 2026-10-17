import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import type { RelatedRow } from '../data/types';
import { originColor, originInfo } from '../theme/origin';
import {
  CLEAR_SELECTION,
  clearShowMeAction,
  hasSelection,
  isShowing,
  showMeContext,
  showingText,
} from '../state/showme';
import { fmtCount, fmtDuration, fmtRange, fmtShare } from '../util/format';

function RelatedList({ title, rows }: { title: string; rows: RelatedRow[] }) {
  const { select } = useApp();
  return (
    <div className="related">
      <h3 className="caps">{title}</h3>
      <ul className="related-list">
        {rows.map((r) => {
          const cls = `related-name${r.origin === 0 ? ' is-user' : ''}${r.kind === 'self' ? ' is-self' : ''}`;
          return (
            <li key={`${r.kind}-${r.name}-${r.fn}`} className="related-row">
              {r.fn !== null ? (
                <button
                  type="button"
                  className={cls}
                  onClick={() => select({ kind: 'fn', fn: r.fn as number })}
                >
                  {r.name}
                </button>
              ) : (
                <span className={cls}>{r.name}</span>
              )}
              <span className="related-track" aria-hidden="true">
                <span
                  className="related-fill"
                  style={{
                    width: `${Math.min(100, r.frac * 100)}%`,
                    background: r.kind === 'self' ? 'var(--c-ink)' : originColor(r.origin),
                  }}
                />
              </span>
              <span className="related-pct">{fmtShare(r.frac)}</span>
            </li>
          );
        })}
        {rows.length === 0 ? <li className="section-sub">None in this range</li> : null}
      </ul>
    </div>
  );
}

/** "Showing: ..." for the active finding, plus the way out: a visible Clear selection chip. */
function SelectionBar() {
  const { summary, snap, selection, search, dispatch } = useApp();
  const ctx = showMeContext(summary);
  const finding = summary.findings.find((f) => isShowing(f, snap, search, ctx));
  if (!hasSelection(snap) && !finding) return null;
  const target =
    selection.name || (snap.range ? `range ${fmtRange(snap.range[0], snap.range[1])}` : '');
  return (
    <div className="selection-bar">
      <span className="selection-bar-text">
        {finding ? showingText(finding, target) : `Selected: ${target || 'a time range'}`}
      </span>
      <button
        type="button"
        className="chip-action"
        aria-label="Clear selection (Esc)"
        onClick={() => dispatch(finding ? clearShowMeAction(finding, snap) : CLEAR_SELECTION)}
      >
        Clear selection <kbd className="kbd">Esc</kbd>
      </button>
    </div>
  );
}

/** Numbers for the current selection: self, total, share, calls, origin, callers and callees. */
export function DetailsDrawer() {
  const { client, host, scope, scopeKey, snap, selection, dispatch, summary, openDock } = useApp();
  const fn = selection.fn;
  // A new selection remounts the drawer, which cross-fades its content (motion.css).
  const contentKey = `${snap.selection.kind}:${fn ?? selection.task?.index ?? ''}`;
  const detailsQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.details(scope, fn)),
    `details:${scopeKey}:${fn}`,
  );
  const sourceQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.source(scope, fn)),
    `src-info:${scopeKey}:${fn}`,
  );
  const d = fn === null ? null : detailsQ.data;
  const src = fn === null ? null : sourceQ.data;
  const trackLabel =
    snap.track === 'all'
      ? 'all tracks'
      : (summary.tracks.find((t) => t.id === snap.track)?.label ?? snap.track);

  if (selection.task) {
    const t = selection.task;
    return (
      <section
        key={contentKey}
        aria-label="Selection details"
        className="details card"
        data-keeps-selection
      >
        <SelectionBar />
        <div className="details-head">
          <span
            className="details-dot"
            aria-hidden="true"
            style={{ background: 'var(--c-origin-you)' }}
          />
          <h2 className="section-title">{t.label}</h2>
          <span className="origin-pill is-other">Task</span>
          <div className="details-actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                dispatch({ type: 'go', patch: { view: 'waterfall' }, options: { task: t.index } })
              }
            >
              Show in waterfall
            </button>
          </div>
        </div>
        <dl className="stat-grid">
          <div className="stat stat-big">
            <dt>Duration</dt>
            <dd>{fmtDuration(t.durationUs)}</dd>
          </div>
          <div className="stat">
            <dt>Busy (CPU)</dt>
            <dd>{fmtDuration(t.busyUs)}</dd>
          </div>
          <div className="stat">
            <dt>Started at</dt>
            <dd>{(t.startUs / 1_000_000).toFixed(2)} s</dd>
          </div>
          <div className="stat">
            <dt>Over 50 ms</dt>
            <dd>{t.durationUs > 50_000 ? 'Yes, a long task' : 'No'}</dd>
          </div>
        </dl>
      </section>
    );
  }

  if (!d || fn === null) {
    const range = snap.range;
    return (
      <section
        key={contentKey}
        aria-label="Selection details"
        className="details card"
        data-keeps-selection
      >
        <SelectionBar />
        <h2 className="section-title">
          {range ? `Range ${fmtRange(range[0], range[1])}` : 'Nothing selected'}
        </h2>
        <p className="muted" role="status">
          {range
            ? `${fmtDuration(range[1] - range[0], { approx: false })} on ${trackLabel}. Select a function, call or task to see its numbers.`
            : 'Select a function, a call, a task or a time range to see its numbers here. Selection is shared by every view.'}
        </p>
      </section>
    );
  }

  const info = originInfo(d.origin);
  const user = d.origin === 0;
  const jump = snap.view === 'waterfall' ? 'Show in flame graph' : 'Show in waterfall';
  const jumpTo = snap.view === 'waterfall' ? 'flame' : 'waterfall';

  return (
    <section
      key={contentKey}
      aria-label="Selection details"
      className="details card"
      data-keeps-selection
    >
      <SelectionBar />
      <div className="details-head">
        <span
          className="details-dot"
          aria-hidden="true"
          style={{ background: originColor(d.origin, false) }}
        />
        <h2 className="section-title">{d.name}</h2>
        {d.loc ? (
          <button type="button" className="details-loc" onClick={() => openDock()}>
            {d.loc}
          </button>
        ) : null}
        <span className={`origin-pill${user ? '' : ' is-other'}`}>{info.label}</span>
        <div className="details-actions">
          <button
            type="button"
            className="btn"
            onClick={() =>
              dispatch({ type: 'go', patch: { view: jumpTo, selection: { kind: 'fn', fn } } })
            }
          >
            {jump}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              dispatch({ type: 'go', patch: { view: 'functions', selection: { kind: 'fn', fn } } })
            }
          >
            Show callers
          </button>
          <button
            type="button"
            className="btn btn-soft"
            disabled={!src?.path}
            onClick={() => src && void host.openInEditor(src.path, src.startLine || 1)}
          >
            Open in editor
          </button>
        </div>
      </div>
      <dl className="stat-grid">
        <div className="stat stat-big">
          <dt>Total time</dt>
          <dd>{fmtDuration(d.totalUs)}</dd>
        </div>
        <div className="stat">
          <dt>Self time</dt>
          <dd>{fmtDuration(d.selfUs)}</dd>
        </div>
        <div className="stat">
          <dt>
            Share of {trackLabel}
            {snap.range ? ', in range' : ''}
          </dt>
          <dd>{fmtShare(d.share)}</dd>
        </div>
        <div className="stat">
          <dt>Calls</dt>
          <dd>
            {d.calls > 0 ? fmtCount(d.calls) : '—'} <span className="stat-est">est.</span>
          </dd>
        </div>
      </dl>
      <div className="related-grid">
        <RelatedList title="Callers" rows={d.callers} />
        <RelatedList title="Callees and self" rows={d.callees} />
      </div>
    </section>
  );
}
