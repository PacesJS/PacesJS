import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { showInView } from '../state/show-in';
import { originColor, originInfo } from '../theme/origin';
import { fmtCount, fmtDuration, fmtRange, fmtSeconds, fmtShare } from '../util/format';
import { DetailsSection } from './DetailsSection';
import { RelatedList } from './RelatedList';

const TEXT = {
  allTracks: 'all tracks',
  task: 'Task',
  showInWaterfall: 'Show in waterfall',
  showInFlame: 'Show in flame graph',
  duration: 'Duration',
  busy: 'Busy (CPU)',
  startedAt: 'Started at',
  over50: 'Over 50 ms',
  longTask: 'Yes, a long task',
  no: 'No',
  range: (range: string) => `Range ${range}`,
  nothingSelected: 'Nothing selected',
  rangeOn: (duration: string, track: string) =>
    `${duration} on ${track}. Select a function, call or task to see its numbers.`,
  selectAnything:
    'Select a function, a call, a task or a time range to see its numbers here. Selection is shared by every view.',
  showCallers: 'Show callers',
  openInEditor: 'Open in editor',
  thisCall: (total: string, self: string) => `This call: ${total} total (CPU) · ${self} self`,
  allCalls: 'All calls',
  allCallsCount: (count: string) => `All ${count} calls`,
  allCallsOf: (which: string, name: string) => `${which} of ${name}`,
  totalTime: 'Total time (CPU)',
  selfTime: 'Self time',
  share: (track: string) => `Share of ${track}`,
  inRange: ', in range',
  calls: 'Calls',
  noCalls: '—',
  estimate: 'est.',
  callers: 'Callers',
  callees: 'Callees and self',
} as const;

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
  const nodePath = snap.selection.kind === 'node' ? selection.path : null;
  const callQ = useAsync(
    () => (nodePath ? client.callAt(scope, nodePath) : Promise.resolve(null)),
    `details-call:${scopeKey}:${nodePath?.join('.') ?? ''}`,
  );
  const call = nodePath ? (callQ.data ?? null) : null;
  const d = fn === null ? null : detailsQ.data;
  const src = fn === null ? null : sourceQ.data;
  const trackLabel =
    snap.track === 'all'
      ? TEXT.allTracks
      : (summary.tracks.find((t) => t.id === snap.track)?.label ?? snap.track);

  if (selection.task) {
    const t = selection.task;
    return (
      <DetailsSection key={contentKey}>
        <div className="details-head">
          <span
            className="details-dot"
            aria-hidden="true"
            style={{ background: 'var(--c-origin-you)' }}
          />
          <h2 className="section-title">{t.label}</h2>
          <span className="origin-pill is-other">{TEXT.task}</span>
          <div className="details-actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                dispatch({ type: 'go', patch: { view: 'waterfall' }, options: { task: t.index } })
              }
            >
              {TEXT.showInWaterfall}
            </button>
          </div>
        </div>
        <dl className="stat-grid">
          <div className="stat stat-big">
            <dt>{TEXT.duration}</dt>
            <dd>{fmtDuration(t.durationUs)}</dd>
          </div>
          <div className="stat">
            <dt>{TEXT.busy}</dt>
            <dd>{fmtDuration(t.busyUs)}</dd>
          </div>
          <div className="stat">
            <dt>{TEXT.startedAt}</dt>
            <dd>{fmtSeconds(t.startUs, 2)}</dd>
          </div>
          <div className="stat">
            <dt>{TEXT.over50}</dt>
            <dd>{t.durationUs > 50_000 ? TEXT.longTask : TEXT.no}</dd>
          </div>
        </dl>
      </DetailsSection>
    );
  }

  if (!d || fn === null) {
    const range = snap.range;
    return (
      <DetailsSection key={contentKey}>
        <h2 className="section-title">
          {range ? TEXT.range(fmtRange(range[0], range[1])) : TEXT.nothingSelected}
        </h2>
        <p className="muted" role="status">
          {range
            ? TEXT.rangeOn(fmtDuration(range[1] - range[0], { approx: false }), trackLabel)
            : TEXT.selectAnything}
        </p>
      </DetailsSection>
    );
  }

  const info = originInfo(d.origin);
  const user = d.origin === 0;
  const jump = snap.view === 'waterfall' ? TEXT.showInFlame : TEXT.showInWaterfall;
  const jumpTo = snap.view === 'waterfall' ? 'flame' : 'waterfall';

  return (
    <DetailsSection key={contentKey}>
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
          <button type="button" className="btn" onClick={() => dispatch(showInView(jumpTo, fn))}>
            {jump}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => dispatch(showInView('functions', fn))}
          >
            {TEXT.showCallers}
          </button>
          <button
            type="button"
            className="btn btn-soft"
            disabled={!src?.path}
            onClick={() => src && void host.openInEditor(src.path, src.startLine || 1)}
          >
            {TEXT.openInEditor}
          </button>
        </div>
      </div>
      {call ? (
        <p className="scope-line is-call">
          {TEXT.thisCall(fmtDuration(call.totalUs), fmtDuration(call.selfUs))}
        </p>
      ) : null}
      <p className="scope-line">
        {TEXT.allCallsOf(
          d.calls > 0 ? TEXT.allCallsCount(fmtCount(d.calls)) : TEXT.allCalls,
          d.name,
        )}
      </p>
      <dl className="stat-grid">
        <div className="stat stat-big">
          <dt>{TEXT.totalTime}</dt>
          <dd>{fmtDuration(d.totalUs)}</dd>
        </div>
        <div className="stat">
          <dt>{TEXT.selfTime}</dt>
          <dd>{fmtDuration(d.selfUs)}</dd>
        </div>
        <div className="stat">
          <dt>
            {TEXT.share(trackLabel)}
            {snap.range ? TEXT.inRange : ''}
          </dt>
          <dd>{fmtShare(d.share)}</dd>
        </div>
        <div className="stat">
          <dt>{TEXT.calls}</dt>
          <dd>
            {d.calls > 0 ? fmtCount(d.calls) : TEXT.noCalls}{' '}
            <span className="stat-est">{TEXT.estimate}</span>
          </dd>
        </div>
      </dl>
      <div className="related-grid">
        <RelatedList title={TEXT.callers} rows={d.callers} />
        <RelatedList title={TEXT.callees} rows={d.callees} />
      </div>
    </DetailsSection>
  );
}
