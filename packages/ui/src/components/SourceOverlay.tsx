import type { ReactNode } from 'react';
import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { useSource } from '../app/useSource';
import { originColor } from '../theme/origin';
import { fmtDuration } from '../util/format';
import { Icon } from './Icon';
import { SourceCode } from './SourceCode';
import {
  ChangedBanner,
  EmptySourceNote,
  SourceHeader,
  SourceReasonNote,
  functionBand,
} from './SourcePanel';

/** The dock, maximized: the whole file full screen, with an outline of the functions that ran in it. */
function Overlay({ children }: { children: ReactNode }) {
  const { dispatch } = useApp();
  return (
    <div className="dock-overlay-backdrop">
      <div
        className="dock-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Source, maximized"
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
        className="btn btn-sm"
        onClick={() => dispatch({ type: 'set-dock-maximized', maximized: false })}
        title="Close (Esc)"
      >
        Close
      </button>
    </>
  );

  if (!info || fn === null) {
    return (
      <Overlay>
        <p className="section-title">No function selected</p>
        <EmptySourceNote fn={fn} name={selection.name} loading={source.loading} />
        {tools}
      </Overlay>
    );
  }

  const outline = outlineQ.data;
  const band = functionBand(source.fileTexts, info.startLine);
  const showCode = !source.reason || source.reason.showsText || source.lines.length > 0;
  return (
    <Overlay>
      <div className="source-view">
        <nav className="source-outline" aria-label="Functions in this file">
          <h3 className="caps">In this file</h3>
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
                    :{it.line} · {fmtDuration(it.selfUs)}
                  </span>
                </button>
              </li>
            ))}
            {outline && outline.items.length === 0 ? (
              <li className="section-sub">No other function of this file ran.</li>
            ) : null}
          </ul>
        </nav>
        <section aria-label="Source" className="source card source-full">
          <SourceHeader source={source} tools={tools} />
          <ChangedBanner changed={source.changed} />
          <SourceReasonNote source={source} />
          {showCode ? (
            <SourceCode source={source} wrap={wrap} band={band} />
          ) : (
            <p className="source-empty">There is nothing to show for this function.</p>
          )}
          <p className="source-foot">
            Bars = self time on each line, from V8 line ticks. The shaded lines are the function
            itself.
            {snap.options.line > 0 ? ` Opened at line ${snap.options.line}.` : ''}
          </p>
        </section>
      </div>
    </Overlay>
  );
}
