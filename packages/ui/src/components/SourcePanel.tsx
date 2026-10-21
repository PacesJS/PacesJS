import { useState } from 'react';
import { useApp } from '../app/context';
import { useSource } from '../app/useSource';
import { EmptySourceNote } from './EmptySourceNote';
import { Icon } from './Icon';
import { SourceBody } from './SourceBody';
import { SourceHeader } from './SourceHeader';
import { WrapButton } from './WrapButton';

const TEXT = {
  source: 'Source',
  expand: 'Expand source panel',
  dockBelow: 'Dock below',
  dockRight: 'Dock to the right',
  maximize: 'Maximize the source dock',
  maximizeTitle: 'Maximize: the whole file with an outline of its functions',
  collapse: 'Collapse source panel',
  noFunction: 'No function selected',
  foot: (summed: string, scope: string) =>
    `Bars = self time on each line, from V8 line ticks, summed over ${summed} (V8 records no ticks per call). Chips = time spent in the callee from that line, ${scope}; select one to follow it.`,
  inThisCall: 'in this call',
  openedAt: (line: number) => ` Opened at line ${line}.`,
} as const;

/** The docked source: resizable, collapsible, with the function and its per-line time. */
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
      <section key="rail" aria-label={TEXT.source} className="source card source-collapsed">
        <button type="button" className="icon-btn" aria-label={TEXT.expand} onClick={openDock}>
          <Icon name="expand" />
        </button>
      </section>
    );
  }

  const tools = (
    <>
      <WrapButton wrap={wrap} />
      <button
        type="button"
        className="icon-btn"
        aria-label={orientation === 'right' ? TEXT.dockBelow : TEXT.dockRight}
        title={orientation === 'right' ? TEXT.dockBelow : TEXT.dockRight}
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
        aria-label={TEXT.maximize}
        title={TEXT.maximizeTitle}
        onClick={() => dispatch({ type: 'set-dock-maximized', maximized: true })}
      >
        <Icon name="maximize" />
      </button>
      <button
        type="button"
        className="icon-btn source-collapse"
        aria-label={TEXT.collapse}
        onClick={collapseDock}
      >
        <Icon name="collapse" />
      </button>
    </>
  );

  if (!info || fn === null) {
    return (
      <section key="panel" aria-label={TEXT.source} className="source card">
        <div className="source-head">
          <div className="source-file">
            <Icon name="file" />
            <span className="source-path">{TEXT.noFunction}</span>
            <div className="source-tools">{tools}</div>
          </div>
        </div>
        <EmptySourceNote fn={fn} name={selection.name} loading={source.loading} />
      </section>
    );
  }

  return (
    <section key="panel" aria-label={TEXT.source} className="source card">
      <SourceHeader source={source} tools={tools} onScope={(m) => setPick({ key, mode: m })} />
      <SourceBody source={source} wrap={wrap} />
      <p className="source-foot">
        {TEXT.foot(
          source.acrossAll.replace('across ', ''),
          source.scopeMode === 'call' ? TEXT.inThisCall : source.acrossAll,
        )}
        {snap.options.line > 0 ? TEXT.openedAt(snap.options.line) : ''}
      </p>
    </section>
  );
}
