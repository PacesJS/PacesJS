import type { ReactNode } from 'react';
import { useApp } from '../app/context';
import type { SourceState } from '../app/useSource';
import { originInfo } from '../theme/origin';
import { isWebScript } from '../view/source-reason';
import { fmtCount, fmtDuration } from '../util/format';
import { Icon } from './Icon';

const TEXT = {
  filePath: 'File path',
  ellipsis: '…',
  allCalls: 'All calls',
  allCallsCount: (count: string) => `All ${count} calls`,
  thisCall: 'This call',
  totalsAll: (which: string, name: string, total: string, self: string) =>
    `${which} of ${name}: ${total} total (CPU) · ${self} self`,
  totalsCall: (total: string, self: string) => `This call: ${total} total (CPU) · ${self} self`,
  scopeGroup: 'Which calls the callee chips cover',
  noFile: '(no file)',
  openInEditor: 'Open in editor',
  activity: (name: string, peak: string) =>
    `Activity of ${name} across the run, busiest around ${peak} s`,
  main: 'main',
  ran: (track: string, duration: string) => `When it ran on ${track}, 0–${duration} s`,
} as const;

interface SourceHeaderProps {
  source: SourceState;
  /** Tool buttons on the path row. */
  tools: ReactNode;
  /** Switch between all calls and the selected call (only offered when a call is selected). */
  onScope?: (mode: 'all' | 'call') => void;
}

interface BreadcrumbProps {
  path: string;
}

interface ScopeToggleProps {
  mode: 'all' | 'call';
  onScope: (mode: 'all' | 'call') => void;
}

/** Path as a breadcrumb: the last segment is the file, long paths keep their tail. */
function Breadcrumb({ path }: BreadcrumbProps) {
  const parts = path.split('/').filter(Boolean);
  const shown = parts.length > 4 ? [TEXT.ellipsis, ...parts.slice(-4)] : parts;
  return (
    <nav aria-label={TEXT.filePath} className="source-crumbs" title={path}>
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

/** What the totals line covers: every call of the function, then the selected call on top. */
function totalsLines(source: SourceState, name: string): { call: string | null; all: string } {
  const { details, call, calls } = source;
  const all = details
    ? TEXT.totalsAll(
        calls > 0 ? TEXT.allCallsCount(fmtCount(calls)) : TEXT.allCalls,
        name,
        fmtDuration(details.totalUs),
        fmtDuration(details.selfUs),
      )
    : ' ';
  return {
    call: call ? TEXT.totalsCall(fmtDuration(call.totalUs), fmtDuration(call.selfUs)) : null,
    all,
  };
}

/** `All calls | This call`: which calls the callee chips cover. */
function ScopeToggle({ mode, onScope }: ScopeToggleProps) {
  return (
    <div className="scope-toggle" role="group" aria-label={TEXT.scopeGroup}>
      {(['all', 'call'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="scope-toggle-btn"
          aria-pressed={mode === m}
          onClick={() => onScope(m)}
        >
          {m === 'all' ? TEXT.allCalls : TEXT.thisCall}
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
          <span className="source-path">{info.loc || TEXT.noFile}</span>
        )}
        <div className="source-tools">
          {isWebScript(info.path) ? null : (
            <button
              type="button"
              className="btn btn-sm btn-soft"
              disabled={!info.path}
              onClick={() => void host.openInEditor(info.path, info.startLine || 1)}
            >
              {TEXT.openInEditor}
            </button>
          )}
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
            aria-label={TEXT.activity(selection.name, peakSec.toFixed(1))}
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
            {TEXT.ran(primary?.label ?? TEXT.main, (info.durationUs / 1_000_000).toFixed(1))}
          </span>
        </div>
      </div>
    </div>
  );
}
