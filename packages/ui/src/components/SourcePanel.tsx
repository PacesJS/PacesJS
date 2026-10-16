import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { matchCallSites } from '../view/call-sites';
import { originColor } from '../theme/origin';
import { fmtCount, fmtDuration } from '../util/format';
import { gutterWidth, lineWindow, tokenize } from '../view/source-lines';
import { Icon } from './Icon';

export function SourcePanel() {
  const { client, host, scope, scopeKey, snap, selection, state, dispatch, select, summary } =
    useApp();
  const fn = selection.fn;
  const infoQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.source(scope, fn)),
    `src:${scopeKey}:${fn}`,
  );
  const detailsQ = useAsync(
    () => (fn === null ? Promise.resolve(null) : client.details(scope, fn)),
    `src-details:${scopeKey}:${fn}`,
  );
  const info = fn === null ? null : infoQ.data;
  const details = fn === null ? null : detailsQ.data;
  const path = info?.path ?? '';
  const textQ = useAsync(
    () => (path ? host.readSource(path) : Promise.resolve(null)),
    `text:${path}`,
  );
  const file = path ? textQ.data : null;
  const hotRef = useRef<HTMLLIElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const allLines = useMemo(() => (file?.exists ? file.text.split(/\r?\n/) : []), [file]);
  const win = useMemo(
    () => (info && allLines.length > 0 ? lineWindow(allLines, info.startLine || 1) : null),
    [info, allLines],
  );

  const selfByLine = useMemo(
    () => new Map((info?.lineSelf ?? []).map((l) => [l.line, l.selfUs])),
    [info],
  );
  const maxSelf = Math.max(0, ...(info?.lineSelf ?? []).map((l) => l.selfUs));
  const hotLine = snap.options.line > 0 ? snap.options.line : (info?.hottestLine ?? 0);
  const hottest = info?.hottestLine ?? 0;

  // Without readable source, still show the lines that have time attributed to them.
  const shown = useMemo(() => {
    if (win) {
      return Array.from({ length: win.last - win.first + 1 }, (_, k) => {
        const n = win.first + k;
        return { n, text: allLines[n - 1] ?? '' };
      });
    }
    return (info?.lineSelf ?? []).map((l) => ({ n: l.line, text: '' }));
  }, [win, allLines, info]);

  const chips = useMemo(() => {
    if (!win || !details) return [];
    const lines = shown.map((l) => l.text);
    const callees = details.callees
      .filter((c) => c.kind === 'callee')
      .map((c) => ({
        fn: c.fn,
        name: c.name,
        totalUs: c.frac * details.totalUs,
        origin: c.origin,
      }));
    return matchCallSites(lines, callees);
  }, [win, details, shown]);

  useEffect(() => {
    // Scroll inside the panel only: scrollIntoView would also move the whole page.
    const box = scrollRef.current;
    const hot = hotRef.current;
    if (box && hot)
      box.scrollTop = Math.max(0, hot.offsetTop - box.clientHeight / 2 + hot.offsetHeight / 2);
  }, [fn, hotLine, shown.length]);

  if (state.sourceCollapsed) {
    return (
      <section aria-label="Source" className="source card source-collapsed">
        <button
          type="button"
          className="icon-btn"
          aria-label="Expand source panel"
          onClick={() => dispatch({ type: 'set-source-collapsed', collapsed: false })}
        >
          <Icon name="expand" />
        </button>
      </section>
    );
  }

  const collapse = (
    <button
      type="button"
      className="icon-btn source-collapse"
      aria-label="Collapse source panel"
      onClick={() => dispatch({ type: 'set-source-collapsed', collapsed: true })}
    >
      <Icon name="collapse" />
    </button>
  );

  if (!info || fn === null) {
    return (
      <section aria-label="Source" className="source card">
        <div className="source-head">
          <div className="source-file">
            <Icon name="file" />
            <span className="source-path">No function selected</span>
            {collapse}
          </div>
        </div>
        <p className="source-empty">
          Select a function in any view to read its source with time on every line.
        </p>
      </section>
    );
  }

  const primary = summary.tracks.find(
    (t) => t.id === (snap.track === 'all' ? info.sparkTrack : snap.track),
  );
  const peakIndex = info.spark.indexOf(Math.max(...info.spark));
  const peakSec = ((peakIndex + 0.5) / info.spark.length) * (info.durationUs / 1_000_000);

  return (
    <section aria-label="Source" className="source card">
      <div className="source-head">
        <div className="source-file">
          <Icon name="file" />
          <span className="source-path" title={info.path}>
            {info.path || info.loc || '(no file)'}
          </span>
          {collapse}
        </div>
        <div className="source-title-row">
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <h2 className="source-title">{selection.name}</h2>
            <span className="source-totals">
              {details
                ? `${fmtDuration(details.totalUs)} total · ${fmtDuration(details.selfUs)} self · ${details.calls > 0 ? fmtCount(details.calls) : '—'} calls est.`
                : ' '}
            </span>
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
              When it ran on {primary?.label ?? 'main'}, 0–
              {(info.durationUs / 1_000_000).toFixed(1)} s
            </span>
          </div>
        </div>
      </div>

      {file?.exists && file.changedSinceProfile ? (
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
      ) : null}
      {info.mapMissing ? (
        <div role="status" className="note source-banner">
          <Icon name="info" size={16} />
          <span className="note-text" style={{ flexBasis: 180 }}>
            No source map was found, so this shows generated code with its generated names.
          </span>
        </div>
      ) : null}
      {path && file && !file.exists ? (
        <div role="status" className="note source-banner">
          <Icon name="info" size={16} />
          <span className="note-text" style={{ flexBasis: 180 }}>
            Source file not found on disk. Per-line time is still shown.
          </span>
        </div>
      ) : null}

      <div className="source-scroll" ref={scrollRef}>
        {shown.length === 0 ? (
          <p className="source-empty">
            {info.path
              ? 'No line-level time was recorded for this function.'
              : 'This function has no source file (native or runtime code).'}
          </p>
        ) : (
          <ol className="source-lines" aria-label="Source lines with self time">
            {shown.map((l, idx) => {
              const self = selfByLine.get(l.n) ?? 0;
              const isHot = l.n === hotLine && (self > 0 || snap.options.line > 0);
              const chip = chips.find((c) => c.lineIndex === idx);
              return (
                <li
                  key={l.n}
                  ref={isHot ? hotRef : undefined}
                  className={`source-line${isHot ? ' is-hot' : ''}`}
                  aria-label={self > 0 ? `Line ${l.n}, self ${fmtDuration(self)}` : undefined}
                >
                  <span className="source-gutter">
                    {l.n === hottest && self > 0 ? (
                      <span className="source-val">{fmtDuration(self)}</span>
                    ) : null}
                    {self > 0 ? (
                      <span
                        className="source-bar"
                        aria-hidden="true"
                        style={{ width: gutterWidth(self, maxSelf) }}
                      />
                    ) : null}
                  </span>
                  <span className="source-n">{l.n}</span>
                  <span className="source-code">
                    {tokenize(l.text).map((t, k) => (
                      <span key={k} className={t.kind === 'plain' ? undefined : `syn-${t.kind}`}>
                        {t.text}
                      </span>
                    ))}
                    {chip ? (
                      <button
                        type="button"
                        className="call-chip"
                        title="Time spent in the callee, matched to this line by name"
                        onClick={() => chip.fn !== null && select({ kind: 'fn', fn: chip.fn })}
                      >
                        <span
                          className="call-chip-dot"
                          aria-hidden="true"
                          style={{ background: originColor(chip.origin, false) }}
                        />
                        {chip.name.split('▸').pop()?.trim()} {fmtDuration(chip.totalUs)}
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <p className="source-foot">
        Bars = self time on each line, from V8 line ticks. Chips = time spent in the callee from
        that line; select one to follow it.
      </p>
    </section>
  );
}
