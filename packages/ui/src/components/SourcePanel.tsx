import { useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../app/context';
import { useSource } from '../app/useSource';
import type { SourceState } from '../app/useSource';
import { originColor, originInfo } from '../theme/origin';
import { fmtCount, fmtDuration } from '../util/format';
import { functionEnd } from '../view/source-lines';
import { Icon } from './Icon';
import { SourceCode } from './SourceCode';

/** Path as a breadcrumb: the last segment is the file, long paths keep their tail. */
function Breadcrumb({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const shown = parts.length > 4 ? ['…', ...parts.slice(-4)] : parts;
  return (
    <nav aria-label="File path" className="source-crumbs" title={path}>
      <ol>
        {shown.map((p, i) => (
          <li key={`${i}-${p}`} aria-current={i === shown.length - 1 ? 'location' : undefined}>
            {p}
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface SourceReasonNoteProps {
  source: SourceState;
}

/** Time in callees, largest first: the answer when a function has no time of its own. */
function CalleeTime({ source }: { source: SourceState }) {
  const { select } = useApp();
  return (
    <ul className="callee-time" aria-label="Time in callees">
      {source.callees.slice(0, 8).map((c) => (
        <li key={`${c.fn}-${c.name}`}>
          <button
            type="button"
            className="callee-time-row"
            disabled={c.fn === null}
            onClick={() => c.fn !== null && select({ kind: 'fn', fn: c.fn })}
          >
            <span
              className="wf-dot"
              aria-hidden="true"
              style={{ background: originColor(c.origin, false) }}
            />
            <span className="callee-time-name">{c.name}</span>
            <span className="num">{fmtDuration(c.us)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Why there is no source (or only generated code), and what to do about it. */
export function SourceReasonNote({ source }: SourceReasonNoteProps) {
  const r = source.reason;
  if (!r) return null;
  return (
    <div role="note" className={`source-reason is-${r.kind}`}>
      <Icon name={r.showsText ? 'info' : 'alert'} size={18} />
      <div>
        <strong className="source-reason-title">{r.title}</strong>
        <p className="source-reason-hint">{r.hint}</p>
        {r.kind === 'no-self-time' ? <CalleeTime source={source} /> : null}
      </div>
    </div>
  );
}

interface SourceHeaderProps {
  source: SourceState;
  /** Tool buttons on the path row. */
  tools: ReactNode;
  /** Switch between all calls and the selected call (only offered when a call is selected). */
  onScope?: (mode: 'all' | 'call') => void;
}

/** What the totals line covers: every call of the function, then the selected call on top. */
function totalsLines(source: SourceState, name: string): { call: string | null; all: string } {
  const { details, call, calls } = source;
  const all = details
    ? `${calls > 0 ? `All ${fmtCount(calls)} calls` : 'All calls'} of ${name}: ${fmtDuration(details.totalUs)} total (CPU) · ${fmtDuration(details.selfUs)} self`
    : ' ';
  return {
    call: call
      ? `This call: ${fmtDuration(call.totalUs)} total (CPU) · ${fmtDuration(call.selfUs)} self`
      : null,
    all,
  };
}

/** `All calls | This call`: which calls the callee chips cover. */
function ScopeToggle({
  mode,
  onScope,
}: {
  mode: 'all' | 'call';
  onScope: (mode: 'all' | 'call') => void;
}) {
  return (
    <div className="scope-toggle" role="group" aria-label="Which calls the callee chips cover">
      {(['all', 'call'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="scope-toggle-btn"
          aria-pressed={mode === m}
          onClick={() => onScope(m)}
        >
          {m === 'all' ? 'All calls' : 'This call'}
        </button>
      ))}
    </div>
  );
}

/** Path, function name, origin, `file:line`, totals, activity sparkline and "Open in editor". */
export function SourceHeader({ source, tools, onScope }: SourceHeaderProps) {
  const { host, snap, summary, selection } = useApp();
  const { info, details } = source;
  if (!info) return null;
  const primary = summary.tracks.find(
    (t) => t.id === (snap.track === 'all' ? info.sparkTrack : snap.track),
  );
  const peakIndex = info.spark.indexOf(Math.max(...info.spark));
  const peakSec = ((peakIndex + 0.5) / info.spark.length) * (info.durationUs / 1_000_000);
  const origin = details ? originInfo(details.origin) : null;
  const totals = totalsLines(source, selection.name);
  return (
    <div className="source-head">
      <div className="source-file">
        <Icon name="file" />
        {info.path ? (
          <Breadcrumb path={info.path} />
        ) : (
          <span className="source-path">{info.loc || '(no file)'}</span>
        )}
        <div className="source-tools">
          <button
            type="button"
            className="btn btn-sm btn-soft"
            disabled={!info.path}
            onClick={() => void host.openInEditor(info.path, info.startLine || 1)}
          >
            Open in editor
          </button>
          {tools}
        </div>
      </div>
      <div className="source-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="source-name-row">
            <h2 className="source-title">{selection.name}</h2>
            {origin ? <span className="origin-pill is-other">{origin.label}</span> : null}
            {info.loc ? <code className="source-loc">{info.loc}</code> : null}
          </div>
          {totals.call ? <span className="source-totals is-call">{totals.call}</span> : null}
          <span className="source-totals">{totals.all}</span>
          {source.call && onScope ? (
            <ScopeToggle mode={source.scopeMode} onScope={onScope} />
          ) : null}
        </div>
        <div className="spark-wrap">
          <div
            className="spark"
            role="img"
            aria-label={`Activity of ${selection.name} across the run, busiest around ${peakSec.toFixed(1)} s`}
          >
            {info.spark.map((v, i) => (
              <span
                key={i}
                className={`spark-bar${i === peakIndex && v > 0 ? ' is-peak' : ''}`}
                style={{ height: Math.max(2, Math.round(v * 24)) }}
              />
            ))}
          </div>
          <span className="spark-caption">
            When it ran on {primary?.label ?? 'main'}, 0–{(info.durationUs / 1_000_000).toFixed(1)}{' '}
            s
          </span>
        </div>
      </div>
    </div>
  );
}

/** Banner for a file that changed since profiling. */
export function ChangedBanner({ changed }: { changed: boolean }) {
  if (!changed) return null;
  return (
    <div role="status" className="note source-banner">
      <Icon name="alert" size={16} />
      <span className="note-text" style={{ flexBasis: 180 }}>
        This file changed since profiling. Lines may not match the run.
      </span>
      <button
        type="button"
        className="note-action"
        disabled
        title="This session has no recorded copy of the file"
      >
        Show recorded copy
      </button>
    </div>
  );
}

/** The docked source: resizable, collapsible, with the function and its per-line time. */
/** Text under an empty dock: nothing selected, or a selection that has no source of its own. */
export function EmptySourceNote({
  fn,
  name,
  loading,
}: {
  fn: number | null;
  name: string;
  loading: boolean;
}) {
  if (fn !== null && !loading) {
    return (
      <p className="source-empty">
        <strong>{name || 'This selection'}</strong> has no source file of its own: it is a collapsed
        package. Expand it in the call graph (the +N chip) or select one of its functions.
      </p>
    );
  }
  return (
    <p className="source-empty">
      Select a function in any view to read its source with time on every line.
    </p>
  );
}

export function SourcePanel() {
  const {
    state,
    snap,
    dispatch,
    selection,
    dockCollapsed: dockIsCollapsed,
    openDock,
    collapseDock,
  } = useApp();
  // A call row defaults to its own call; a function (from a table, flame or the source) to all.
  const [pick, setPick] = useState<{ key: string; mode: 'all' | 'call' } | null>(null);
  const key = `${snap.selection.kind}:${selection.path?.join('.') ?? selection.fn}`;
  const wantsCall = snap.selection.kind === 'node';
  const mode = pick && pick.key === key ? pick.mode : wantsCall ? 'call' : 'all';
  const source = useSource({ whole: false, mode });
  const { orientation, wrap } = state.prefs.dock;
  const { info, fn } = source;

  if (dockIsCollapsed) {
    return (
      <section key="rail" aria-label="Source" className="source card source-collapsed">
        <button
          type="button"
          className="icon-btn"
          aria-label="Expand source panel"
          onClick={openDock}
        >
          <Icon name="expand" />
        </button>
      </section>
    );
  }

  const tools = (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label="Wrap long lines"
        aria-pressed={wrap}
        title="Wrap long lines"
        onClick={() =>
          dispatch({ type: 'prefs', prefs: { dock: { ...state.prefs.dock, wrap: !wrap } } })
        }
      >
        <Icon name="wrap" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={orientation === 'right' ? 'Dock below' : 'Dock to the right'}
        title={orientation === 'right' ? 'Dock below' : 'Dock to the right'}
        onClick={() =>
          dispatch({
            type: 'prefs',
            prefs: {
              dock: {
                ...state.prefs.dock,
                orientation: orientation === 'right' ? 'bottom' : 'right',
              },
            },
          })
        }
      >
        <Icon name={orientation === 'right' ? 'dock-bottom' : 'dock-right'} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Maximize the source dock"
        title="Maximize: the whole file with an outline of its functions"
        onClick={() => dispatch({ type: 'set-dock-maximized', maximized: true })}
      >
        <Icon name="maximize" />
      </button>
      <button
        type="button"
        className="icon-btn source-collapse"
        aria-label="Collapse source panel"
        onClick={collapseDock}
      >
        <Icon name="collapse" />
      </button>
    </>
  );

  if (!info || fn === null) {
    return (
      <section key="panel" aria-label="Source" className="source card">
        <div className="source-head">
          <div className="source-file">
            <Icon name="file" />
            <span className="source-path">No function selected</span>
            <div className="source-tools">{tools}</div>
          </div>
        </div>
        <EmptySourceNote fn={fn} name={selection.name} loading={source.loading} />
      </section>
    );
  }

  const showCode = !source.reason || source.reason.showsText || source.lines.length > 0;
  return (
    <section key="panel" aria-label="Source" className="source card">
      <SourceHeader source={source} tools={tools} onScope={(m) => setPick({ key, mode: m })} />
      <ChangedBanner changed={source.changed} />
      <SourceReasonNote source={source} />
      {showCode ? (
        <SourceCode source={source} wrap={wrap} />
      ) : (
        <p className="source-empty">There is nothing to show for this function.</p>
      )}
      <p className="source-foot">
        Bars = self time on each line, from V8 line ticks, summed over{' '}
        {source.acrossAll.replace('across ', '')} (V8 records no ticks per call). Chips = time spent
        in the callee from that line,{' '}
        {source.scopeMode === 'call' ? 'in this call' : source.acrossAll}; select one to follow it.
        {snap.options.line > 0 ? ` Opened at line ${snap.options.line}.` : ''}
      </p>
    </section>
  );
}

/** First and last line of the function in `lines` (for the Source view's band). */
export function functionBand(
  texts: readonly string[],
  startLine: number,
): { first: number; last: number } | null {
  if (texts.length === 0 || startLine <= 0) return null;
  return { first: startLine, last: functionEnd(texts, startLine) };
}
