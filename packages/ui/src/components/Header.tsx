import type { RefObject } from 'react';
import { useApp } from '../app/context';
import { canBack, canForward } from '../state/history';
import { displayEntry, fmtCount, fmtRun } from '../util/format';
import { Icon } from './Icon';
import { NotesChip } from './NotesChip';
import { TransformBar } from './TransformBar';

interface HeaderProps {
  searchRef: RefObject<HTMLInputElement | null>;
  sessionPath?: string;
}

const TEXT = {
  endedBy: {
    exit: 'Exit',
    sigint: 'Ctrl+C',
    duration: 'Duration limit',
    crash: 'Crash',
  } as Record<string, string>,
  brand: 'paces',
  back: 'Back (Alt+Left)',
  forward: 'Forward (Alt+Right)',
  commandPrefix: '$ paces --',
  duration: 'Duration',
  samples: 'Samples',
  perTrack: ' / track',
  endedByLabel: 'Ended by',
  entry: 'Entry',
  sampledTitle: 'Sampled profile: timings are estimates',
  sampled: (interval: string, precision: string) => `Sampled · ${interval} · ±${precision}`,
  ms: (value: string) => `${value} ms`,
  tracks: 'Tracks',
  supporting: 'supporting',
  supportingTitle: 'npx/npm wrapper process: it launches the target and does little work itself',
  searchLabel: 'Search functions, files and packages',
  searchPlaceholder: 'Search functions, files, packages',
  searchKey: '/',
  shortcuts: 'Keyboard shortcuts (?)',
  shortcutsGlyph: '?',
} as const;

export function Header({ searchRef, sessionPath }: HeaderProps) {
  const { summary, state, snap, dispatch } = useApp();
  const onSearchEnter = () => dispatch({ type: 'go', patch: { view: 'functions' } });
  const command = summary.command.join(' ');
  const perTrack = Math.max(
    0,
    ...summary.tracks.filter((t) => t.role === 'target').map((t) => t.samples),
  );
  const trackId = snap.track === 'all' ? summary.primaryTrack : snap.track;
  const track = summary.tracks.find((t) => t.id === trackId);
  const intervalMs = summary.intervalUs / 1000;
  const precisionMs = summary.precisionUs / 1000;
  const fmtMsPlain = (n: number): string => TEXT.ms(String(Number.isInteger(n) ? n : n.toFixed(1)));

  return (
    <header className="header">
      <div className="header-row">
        <div className="header-brand">
          <span className="header-logo" aria-hidden="true">
            <Icon name="logo" size={22} />
          </span>
          <span className="header-name">{TEXT.brand}</span>
        </div>
        <div className="header-nav">
          <button
            type="button"
            className="icon-btn"
            aria-label={TEXT.back}
            disabled={!canBack(state.history)}
            onClick={() => dispatch({ type: 'back' })}
          >
            <Icon name="back" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={TEXT.forward}
            disabled={!canForward(state.history)}
            onClick={() => dispatch({ type: 'forward' })}
          >
            <Icon name="forward" />
          </button>
        </div>
        <div className="cmd-chip" title={command}>
          <span className="cmd-chip-prefix">{TEXT.commandPrefix}</span>
          <span className="cmd-chip-cmd">{command}</span>
        </div>
        <dl className="header-stats">
          <div className="header-stat">
            <dt>{TEXT.duration}</dt>
            <dd>{fmtRun(summary.durationUs)}</dd>
          </div>
          <div className="header-stat">
            <dt>{TEXT.samples}</dt>
            <dd>
              {fmtCount(perTrack)}
              {summary.tracks.length > 1 ? TEXT.perTrack : ''}
            </dd>
          </div>
          <div className="header-stat">
            <dt>{TEXT.endedByLabel}</dt>
            <dd>{TEXT.endedBy[summary.endedBy] ?? summary.endedBy}</dd>
          </div>
          {summary.target.entry ? (
            <div className="header-stat">
              <dt>{TEXT.entry}</dt>
              <dd className="header-entry" title={summary.target.entry}>
                {displayEntry(summary.target.entry)}
              </dd>
            </div>
          ) : null}
        </dl>
        <span className="precision-badge" title={TEXT.sampledTitle}>
          <Icon name="clock" size={14} />
          {TEXT.sampled(fmtMsPlain(intervalMs), fmtMsPlain(precisionMs))}
        </span>
        <NotesChip />
        <div className="header-spacer" />
        <div className="field">
          <label htmlFor="track-pick">{TEXT.tracks}</label>
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
            <span className="support-note" title={TEXT.supportingTitle}>
              <Icon name="info" size={14} />
              {TEXT.supporting}
            </span>
          ) : null}
        </div>
        <div className="search">
          <label htmlFor="search" className="sr-only">
            {TEXT.searchLabel}
          </label>
          <span className="search-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            id="search"
            ref={searchRef}
            type="search"
            className="search-input"
            placeholder={TEXT.searchPlaceholder}
            value={state.search}
            onChange={(e) => dispatch({ type: 'search', text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSearchEnter();
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
          />
          <kbd className="kbd search-kbd">{TEXT.searchKey}</kbd>
        </div>
        <button
          type="button"
          className="help-btn"
          aria-label={TEXT.shortcuts}
          onClick={() => dispatch({ type: 'set-shortcuts', open: true })}
        >
          {TEXT.shortcutsGlyph}
        </button>
      </div>
      <TransformBar sessionPath={sessionPath} hasBaseline={summary.hasBaseline} />
    </header>
  );
}
