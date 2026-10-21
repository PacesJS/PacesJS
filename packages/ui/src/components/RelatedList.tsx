import { useApp } from '../app/context';
import type { RelatedRow } from '../data/types';
import { originColor } from '../theme/origin';
import { fmtShare } from '../util/format';

const TEXT = {
  none: 'None in this range',
} as const;

interface RelatedListProps {
  title: string;
  rows: RelatedRow[];
}

export function RelatedList({ title, rows }: RelatedListProps) {
  const { select } = useApp();
  return (
    <div className="related">
      <h3 className="caps">{title}</h3>
      <ul className="related-list">
        {rows.map((r) => {
          const cls = `related-name${r.origin === 0 ? ' is-user' : ''}${r.kind === 'self' ? ' is-self' : ''}`;
          return (
            <li key={`${r.kind}-${r.name}-${r.fn}`} className="related-row">
              {r.fn !== null ? (
                <button
                  type="button"
                  className={cls}
                  onClick={() => select({ kind: 'fn', fn: r.fn as number })}
                >
                  {r.name}
                </button>
              ) : (
                <span className={cls}>{r.name}</span>
              )}
              <span className="related-track" aria-hidden="true">
                <span
                  className="related-fill"
                  style={{
                    width: `${Math.min(100, r.frac * 100)}%`,
                    background: r.kind === 'self' ? 'var(--c-ink)' : originColor(r.origin),
                  }}
                />
              </span>
              <span className="related-pct">{fmtShare(r.frac)}</span>
            </li>
          );
        })}
        {rows.length === 0 ? <li className="section-sub">{TEXT.none}</li> : null}
      </ul>
    </div>
  );
}
