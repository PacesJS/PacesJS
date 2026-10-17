import { useEffect, useRef } from 'react';
import { useApp } from '../app/context';
import type { SourceState } from '../app/useSource';
import { originColor } from '../theme/origin';
import { fmtDuration } from '../util/format';
import {
  gutterTitle,
  gutterWidth,
  isLowConfidence,
  sampleLabel,
  tokenize,
} from '../view/source-lines';

interface SourceCodeProps {
  source: SourceState;
  wrap: boolean;
  /** Lines of the function itself get a faint band (the Source view shows the whole file). */
  band?: { first: number; last: number } | null;
}

/** The code with a self-time gutter on every line and a chip on lines that call a callee. */
export function SourceCode({ source, wrap, band = null }: SourceCodeProps) {
  const { select, dispatch } = useApp();
  const {
    lines,
    selfByLine,
    rolledFrom,
    precisionUs,
    maxSelf,
    hottest,
    targetLine,
    definitionLine,
    chips,
    fn,
    scopeMode,
    acrossAll,
  } = source;
  const targetRef = useRef<HTMLLIElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Scroll inside the panel only: scrollIntoView would also move the whole page.
    const box = scrollRef.current;
    const target = targetRef.current;
    if (box && target)
      box.scrollTop = Math.max(
        0,
        target.offsetTop - box.clientHeight / 2 + target.offsetHeight / 2,
      );
  }, [fn, targetLine, lines.length]);

  const hottestSelf = selfByLine.get(hottest) ?? 0;
  const showJump = hottest > 0 && hottest !== definitionLine && hottestSelf > 0;
  return (
    <>
      {showJump ? (
        <div className="source-jump">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => dispatch({ type: 'options', options: { line: hottest }, replace: true })}
          >
            Jump to hottest line · {hottest} · {fmtDuration(hottestSelf)}
          </button>
        </div>
      ) : null}
      <div className={`source-scroll${wrap ? ' is-wrap' : ''}`} ref={scrollRef}>
        <ol className="source-lines" aria-label="Source lines with self time">
          {lines.map((l, idx) => {
            const self = selfByLine.get(l.n) ?? 0;
            const from = rolledFrom.get(l.n) ?? [];
            const low = self > 0 && isLowConfidence(self, precisionUs);
            const isDefinition = l.n === definitionLine;
            const chip = chips.find((c) => c.lineIndex === idx);
            const inBand = band !== null && l.n >= band.first && l.n <= band.last;
            return (
              <li
                key={l.n}
                ref={l.n === targetLine ? targetRef : undefined}
                className={`source-line${isDefinition ? ' is-definition' : ''}${inBand ? ' in-function' : ''}`}
                aria-current={isDefinition ? 'location' : undefined}
                aria-label={
                  self > 0
                    ? `Line ${l.n}, self ${fmtDuration(self)}${low ? `, ${sampleLabel(self, precisionUs)}` : ''}${isDefinition ? ', function definition' : ''}`
                    : isDefinition
                      ? `Line ${l.n}, function definition`
                      : undefined
                }
              >
                <span
                  className="source-gutter"
                  title={gutterTitle(
                    self,
                    precisionUs,
                    from,
                    scopeMode === 'call'
                      ? `${acrossAll}; per-call line ticks are not recorded`
                      : acrossAll,
                  )}
                >
                  {l.n === hottest && self > 0 ? (
                    <span className="source-val">
                      {/* One sample's milliseconds are only the sampling interval: say what it is. */}
                      {low ? sampleLabel(self, precisionUs) : fmtDuration(self)}
                    </span>
                  ) : null}
                  {self > 0 ? (
                    <span
                      className={`source-bar${low || scopeMode === 'call' ? ' is-faint' : ''}`}
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
                      title={`Time spent in the callee ${scopeMode === 'call' ? 'in this call' : acrossAll}, matched to this line by name`}
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
      </div>
    </>
  );
}
