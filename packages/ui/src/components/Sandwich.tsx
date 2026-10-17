import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import type { SandwichRow } from '../data/types';
import { originColor } from '../theme/origin';
import { fmtDuration, fmtShare } from '../util/format';

interface SandwichProps {
  fn: number;
  name: string;
  totalUs: number;
}

const ROW = 30;

function sandwichTop(level: number, minLevel: number): number {
  return (level - minLevel) * ROW + (level > 0 ? 12 : 0);
}

/** Callers above (inverted), callees below; widths are a share of the function's own time. */
export function Sandwich({ fn, name, totalUs }: SandwichProps) {
  const { client, scope, scopeKey, select } = useApp();
  const q = useAsync(() => client.sandwich(scope, fn), `sandwich:${scopeKey}:${fn}`);
  const rows: SandwichRow[] = q.data ?? [];
  const minLevel = rows.reduce((m, r) => Math.min(m, r.level), 0);
  const maxLevel = rows.reduce((m, r) => Math.max(m, r.level), 0);
  const height = sandwichTop(maxLevel, minLevel) + ROW;
  const callers = rows
    .filter((r) => r.level === -1)
    .map((r) => `${r.name} ${fmtShare(r.end - r.start)}`);
  const callees = rows
    .filter((r) => r.level === 1)
    .map((r) => `${r.name} ${fmtShare(r.end - r.start)}`);

  return (
    <div className="sandwich">
      <div className="sandwich-head">
        <h2 className="section-title">Sandwich · {name}</h2>
        <span className="section-sub">
          Callers above, inverted · callees below · width = share of this function&apos;s{' '}
          {fmtDuration(totalUs)}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div
          className="sandwich-plot"
          role="img"
          aria-label={`Sandwich view of ${name}. Callers: ${callers.join(', ') || 'none'}. Callees: ${callees.join(', ') || 'none'}.`}
          style={{ height }}
        >
          {rows.map((r, i) => {
            const w = (r.end - r.start) * 100;
            const top = sandwichTop(r.level, minLevel);
            if (r.isSelf) {
              return (
                <span
                  key={`self-${i}`}
                  className="sandwich-self"
                  style={{ left: `calc(${r.start * 100}% + 12px)`, top: top + 6 }}
                >
                  self · {fmtShare(r.end - r.start)}
                </span>
              );
            }
            const focus = r.level === 0;
            const label = w > 7 ? r.name : '';
            return (
              <button
                key={`${r.level}-${r.fn}-${r.start}`}
                type="button"
                className={`sandwich-bar${focus ? ' is-focus' : ''}`}
                aria-label={`${r.name}, ${fmtShare(r.end - r.start)} of ${name}`}
                style={{
                  top,
                  left: `${r.start * 100}%`,
                  width: `calc(${w}% - 2px)`,
                  background: originColor(r.origin),
                }}
                onClick={() => r.fn !== null && select({ kind: 'fn', fn: r.fn })}
              >
                <span className={`sandwich-label${r.origin === 0 ? ' is-user' : ''}`}>{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
