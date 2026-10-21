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

const TEXT = {
  jump: (line: number, duration: string) => `Jump to hottest line · ${line} · ${duration}`,
  lines: 'Source lines with self time',
  lineSelf: (n: number, duration: string) => `Line ${n}, self ${duration}`,
  lineSample: (sample: string) => `, ${sample}`,
  lineDefinitionSuffix: ', function definition',
  lineDefinition: (n: number) => `Line ${n}, function definition`,
  perCall: (across: string) => `${across}; per-call line ticks are not recorded`,
  inThisCall: 'in this call',
  chipTitle: (scope: string) => `Time spent in the callee ${scope}, matched to this line by name`,
} as const;

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
            {TEXT.jump(hottest, fmtDuration(hottestSelf))}
          </button>
        </div>
      ) : null}
      <div className={`source-scroll${wrap ? ' is-wrap' : ''}`} ref={scrollRef}>
        <ol className="source-lines" aria-label={TEXT.lines}>
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
                    ? `${TEXT.lineSelf(l.n, fmtDuration(self))}${low ? TEXT.lineSample(sampleLabel(self, precisionUs)) : ''}${isDefinition ? TEXT.lineDefinitionSuffix : ''}`
                    : isDefinition
                      ? TEXT.lineDefinition(l.n)
                      : undefined
                }
              >
                <span
                  className="source-gutter"
                  title={gutterTitle(
                    self,
                    precisionUs,
                    from,
                    scopeMode === 'call' ? TEXT.perCall(acrossAll) : acrossAll,
                  )}
                >
                  {self > 0 ? (
                    <span className={`source-val${l.n === hottest ? ' is-hottest' : ''}`}>
                      {/* Every bar has its value. One sample's milliseconds are only the sampling
                          interval, so a low-confidence line says "1 sample" instead. */}
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
                      title={TEXT.chipTitle(scopeMode === 'call' ? TEXT.inThisCall : acrossAll)}
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
