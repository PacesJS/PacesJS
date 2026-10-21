import type { ReactNode } from 'react';
import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { useSource } from '../app/useSource';
import { originColor } from '../theme/origin';
import { fmtDuration } from '../util/format';
import { functionBand } from '../view/source-lines';
import { EmptySourceNote } from './EmptySourceNote';
import { SourceBody } from './SourceBody';
import { SourceHeader } from './SourceHeader';
import { WrapButton } from './WrapButton';

const TEXT = {
  maximized: 'Source, maximized',
  closeTitle: 'Close (Esc)',
  close: 'Close',
  noFunction: 'No function selected',
  outline: 'Functions in this file',
  inFile: 'In this file',
  outlineMeta: (line: number, selfTime: string) => `:${line} · ${selfTime}`,
  noOthers: 'No other function of this file ran.',
  source: 'Source',
  foot: 'Bars = self time on each line, from V8 line ticks. The shaded lines are the function itself.',
  openedAt: (line: number) => ` Opened at line ${line}.`,
} as const;

/** The dock, maximized: the whole file full screen, with an outline of the functions that ran in it. */
function Overlay({ children }: { children: ReactNode }) {
  const { dispatch } = useApp();
  return (
    <div className="dock-overlay-backdrop" data-keeps-selection>
      <div
        className="dock-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={TEXT.maximized}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            dispatch({ type: 'set-dock-maximized', maximized: false });
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function SourceOverlay() {
  const { client, scope, scopeKey, state, snap, dispatch, select, selection } = useApp();
  const source = useSource({ whole: true });
  const { info, fn } = source;
  const outlineQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.outline(scope, fn)),
    `outline:${scopeKey}:${fn}`,
  );
  const wrap = state.prefs.dock.wrap;

  const tools = (
    <>
      <WrapButton wrap={wrap} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => dispatch({ type: 'set-dock-maximized', maximized: false })}
        title={TEXT.closeTitle}
      >
        {TEXT.close}
      </button>
    </>
  );

  if (!info || fn === null) {
    return (
      <Overlay>
        <p className="section-title">{TEXT.noFunction}</p>
        <EmptySourceNote fn={fn} name={selection.name} loading={source.loading} />
        {tools}
      </Overlay>
    );
  }

  const outline = outlineQ.data;
  const band = functionBand(source.fileTexts, info.startLine);
  return (
    <Overlay>
      <div className="source-view">
        <nav className="source-outline" aria-label={TEXT.outline}>
          <h3 className="caps">{TEXT.inFile}</h3>
          <ul>
            {(outline?.items ?? []).map((it) => (
              <li key={it.fn}>
                <button
                  type="button"
                  className="outline-item"
                  aria-current={it.fn === fn ? 'true' : undefined}
                  onClick={() => select({ kind: 'fn', fn: it.fn })}
                >
                  <span
                    className="wf-dot"
                    aria-hidden="true"
                    style={{ background: originColor(it.origin, false) }}
                  />
                  <span className="outline-name">{it.name}</span>
                  <span className="outline-meta">
                    {TEXT.outlineMeta(it.line, fmtDuration(it.selfUs))}
                  </span>
                </button>
              </li>
            ))}
            {outline && outline.items.length === 0 ? (
              <li className="section-sub">{TEXT.noOthers}</li>
            ) : null}
          </ul>
        </nav>
        <section aria-label={TEXT.source} className="source card source-full">
          <SourceHeader source={source} tools={tools} />
          <SourceBody source={source} wrap={wrap} band={band} />
          <p className="source-foot">
            {TEXT.foot}
            {snap.options.line > 0 ? TEXT.openedAt(snap.options.line) : ''}
          </p>
        </section>
      </div>
    </Overlay>
  );
}
