import { memo } from 'react';
import type { RefObject } from 'react';
import { useIsHovered } from '../app/hover';
import type { FnRow } from '../data/types';
import { originColor, originInfo } from '../theme/origin';
import { fmtCount, fmtDuration, fmtShare } from '../util/format';

interface FunctionRowProps {
  r: FnRow;
  maxSelf: number;
  selected: boolean;
  selectedRef: RefObject<HTMLDivElement | null>;
  onSelect(fn: number): void;
  onOpen(): void;
  onHover(fn: number | null): void;
}

/** One row of the functions table. It re-renders when its own row, selection or hover changes, not on every hover step. */
export const FunctionRow = memo(function FunctionRow({
  r,
  maxSelf,
  selected,
  selectedRef,
  onSelect,
  onOpen,
  onHover,
}: FunctionRowProps) {
  const hovered = useIsHovered(r.fn);
  return (
    <div
      ref={selected ? selectedRef : undefined}
      role="row"
      aria-selected={selected}
      tabIndex={0}
      className={`fn-row${selected ? ' is-selected' : ''}${hovered ? ' is-hover' : ''}`}
      onClick={() => onSelect(r.fn)}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(r.fn);
        }
      }}
      onPointerEnter={() => onHover(r.fn)}
      onPointerLeave={() => onHover(null)}
    >
      <span role="cell" className="fn-cell fn-cell-name">
        <span
          className="wf-dot"
          aria-hidden="true"
          style={{ background: originColor(r.origin, false) }}
        />
        <span className={`fn-name${r.origin === 0 ? ' is-user' : ''}`}>{r.name}</span>
      </span>
      <span role="cell" className="fn-cell fn-cell-origin">
        {originInfo(r.origin).label}
      </span>
      <span role="cell" className="fn-cell fn-cell-self">
        <span className="fn-bar" aria-hidden="true">
          <span
            className="fn-bar-fill"
            style={{
              width: `${Math.max(3, (r.selfUs / maxSelf) * 100)}%`,
              background: originColor(r.origin),
            }}
          />
        </span>
        <span className="num" style={{ fontWeight: 600 }}>
          {fmtDuration(r.selfUs)}
        </span>
      </span>
      <span role="cell" className="fn-cell fn-cell-num">
        {fmtDuration(r.totalUs)}
      </span>
      <span role="cell" className="fn-cell fn-cell-num">
        {fmtShare(r.share)}
      </span>
      <span role="cell" className="fn-cell fn-cell-calls">
        {r.calls > 0 ? fmtCount(r.calls) : '—'}
      </span>
      <span role="cell" className="fn-cell fn-cell-loc" title={r.loc}>
        {r.loc}
      </span>
    </div>
  );
});
