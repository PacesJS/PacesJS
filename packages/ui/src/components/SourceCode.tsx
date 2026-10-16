import { useEffect, useRef } from 'react';
import { useApp } from '../app/context';
import type { SourceState } from '../app/useSource';
import { originColor } from '../theme/origin';
import { fmtDuration } from '../util/format';
import { gutterWidth, tokenize } from '../view/source-lines';

interface SourceCodeProps {
  source: SourceState;
  wrap: boolean;
  /** Lines of the function itself get a faint band (the Source view shows the whole file). */
  band?: { first: number; last: number } | null;
}

/** The code with a self-time gutter on every line and a chip on lines that call a callee. */
export function SourceCode({ source, wrap, band = null }: SourceCodeProps) {
  const { select, snap } = useApp();
  const { lines, selfByLine, maxSelf, hottest, hotLine, chips, fn } = source;
  const hotRef = useRef<HTMLLIElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Scroll inside the panel only: scrollIntoView would also move the whole page.
    const box = scrollRef.current;
    const hot = hotRef.current;
    if (box && hot)
      box.scrollTop = Math.max(0, hot.offsetTop - box.clientHeight / 2 + hot.offsetHeight / 2);
  }, [fn, hotLine, lines.length]);

  return (
    <div className={`source-scroll${wrap ? ' is-wrap' : ''}`} ref={scrollRef}>
      <ol className="source-lines" aria-label="Source lines with self time">
        {lines.map((l, idx) => {
          const self = selfByLine.get(l.n) ?? 0;
          const isHot = l.n === hotLine && (self > 0 || snap.options.line > 0);
          const chip = chips.find((c) => c.lineIndex === idx);
          const inBand = band !== null && l.n >= band.first && l.n <= band.last;
          return (
            <li
              key={l.n}
              ref={isHot ? hotRef : undefined}
              className={`source-line${isHot ? ' is-hot' : ''}${inBand ? ' in-function' : ''}`}
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
    </div>
  );
}
