import type { RefObject } from 'react';
import { useApp } from '../app/context';
import { canBack, canForward } from '../state/history';
import { displayEntry, fmtRun, fmtSamples } from '../util/format';
import { Icon } from './Icon';
import { NotesChip } from './NotesChip';
import { TransformBar } from './TransformBar';

interface HeaderProps {
  searchRef: RefObject<HTMLInputElement | null>;
  sessionPath?: string;
}

const ENDED_BY: Record<string, string> = {
  exit: 'Exit',
  sigint: 'Ctrl+C',
  duration: 'Duration limit',
  crash: 'Crash',
};

export function Header({ searchRef, sessionPath }: HeaderProps) {
  const { summary, state, snap, dispatch, onSearchEnter } = useHeader();
  const command = summary.command.join(' ');
  const perTrack = Math.max(
    0,
    ...summary.tracks.filter((t) => t.role === 'target').map((t) => t.samples),
  );
  const trackId = snap.track === 'all' ? summary.primaryTrack : snap.track;
  const track = summary.tracks.find((t) => t.id === trackId);
  const intervalMs = summary.intervalUs / 1000;
  const precisionMs = summary.precisionUs / 1000;
  const fmtMsPlain = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)} ms`;

  return (
    <header className="header">
      <div className="header-row">
        <div className="header-brand">
          <span className="header-logo" aria-hidden="true">
            <Icon name="logo" size={22} />
          </span>
          <span className="header-name">paces</span>
        </div>
        <div className="header-nav">
          <button
            type="button"
            className="icon-btn"
            aria-label="Back (Alt+Left)"
            disabled={!canBack(state.history)}
            onClick={() => dispatch({ type: 'back' })}
          >
            <Icon name="back" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Forward (Alt+Right)"
            disabled={!canForward(state.history)}
            onClick={() => dispatch({ type: 'forward' })}
          >
            <Icon name="forward" />
          </button>
        </div>
        <div className="cmd-chip" title={command}>
          <span className="cmd-chip-prefix">$ paces --</span>
          <span className="cmd-chip-cmd">{command}</span>
        </div>
        <dl className="header-stats">
          <div className="header-stat">
            <dt>Duration</dt>
            <dd>{fmtRun(summary.durationUs)}</dd>
          </div>
          <div className="header-stat">
            <dt>Samples</dt>
            <dd>
              {fmtSamples(perTrack)}
              {summary.tracks.length > 1 ? ' / track' : ''}
            </dd>
          </div>
          <div className="header-stat">
            <dt>Ended by</dt>
            <dd>{ENDED_BY[summary.endedBy] ?? summary.endedBy}</dd>
          </div>
          {summary.target.entry ? (
            <div className="header-stat">
              <dt>Entry</dt>
              <dd className="header-entry" title={summary.target.entry}>
                {displayEntry(summary.target.entry)}
              </dd>
            </div>
          ) : null}
        </dl>
        <span className="precision-badge" title="Sampled profile: timings are estimates">
          <Icon name="clock" size={14} />
          Sampled · {fmtMsPlain(intervalMs)} · ±{fmtMsPlain(precisionMs)}
        </span>
        <NotesChip />
        <div className="header-spacer" />
        <div className="field">
          <label htmlFor="track-pick">Tracks</label>
          <select
            id="track-pick"
            className="select"
            value={trackId}
            onChange={(e) => dispatch({ type: 'go', patch: { track: e.target.value } })}
          >
            {summary.tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          {track?.role === 'support' ? (
            <span
              className="support-note"
              title="npx/npm wrapper process: it launches the target and does little work itself"
            >
              <Icon name="info" size={14} />
              supporting
            </span>
          ) : null}
        </div>
        <div className="search">
          <label htmlFor="search" className="sr-only">
            Search functions, files and packages
          </label>
          <span className="search-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            id="search"
            ref={searchRef}
            type="search"
            className="search-input"
            placeholder="Search functions, files, packages"
            value={state.search}
            onChange={(e) => dispatch({ type: 'search', text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSearchEnter();
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
          />
          <kbd className="kbd search-kbd">/</kbd>
        </div>
        <button
          type="button"
          className="help-btn"
          aria-label="Keyboard shortcuts (?)"
          onClick={() => dispatch({ type: 'set-shortcuts', open: true })}
        >
          ?
        </button>
      </div>
      <TransformBar sessionPath={sessionPath} hasBaseline={summary.hasBaseline} />
    </header>
  );
}

function useHeader() {
  const app = useApp();
  return {
    summary: app.summary,
    state: app.state,
    snap: app.snap,
    dispatch: app.dispatch,
    onSearchEnter: () => app.dispatch({ type: 'go', patch: { view: 'functions' } }),
  };
}
