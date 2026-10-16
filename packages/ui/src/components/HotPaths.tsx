import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { fmtDuration, fmtShare } from '../util/format';

const LIMIT = 5;
const TAIL = 4;

/** The dominant call chains (engine `hotPaths`): click one to open it zoomed in the flame graph. */
export function HotPaths() {
  const { client, scope, scopeKey, dispatch } = useApp();
  const q = useAsync(() => client.hotPaths(scope, LIMIT), `hotpaths:${scopeKey}`);
  const paths = q.data ?? [];
  if (paths.length === 0) return null;
  return (
    <section className="hot-paths" aria-label="Hot paths">
      <div className="section-head">
        <h2 className="section-title">Hot paths</h2>
        <span className="section-sub">
          Call chains that carry the most time, plumbing folded in · click to open in the flame
          graph
        </span>
      </div>
      <ol className="hot-path-list">
        {paths.map((p) => {
          const tail = p.names.slice(-TAIL);
          const lead = p.names.length > TAIL ? '… → ' : '';
          const last = p.fns[p.fns.length - 1] ?? 0;
          return (
            <li key={p.fns.join('.')}>
              <button
                type="button"
                className="hot-path"
                aria-label={`Open hot path ${tail.join(' to ')} in the flame graph`}
                onClick={() =>
                  dispatch({
                    type: 'go',
                    patch: { view: 'flame', selection: { kind: 'fn', fn: last } },
                    options: { zoomPath: p.fns, zoom: [] },
                  })
                }
              >
                <span className="hot-path-chain">
                  {lead}
                  {tail.join(' → ')}
                </span>
                <span className="hot-path-stats num">
                  {fmtDuration(p.totalUs)} total · {fmtDuration(p.selfUs)} self ·{' '}
                  {fmtShare(p.share)}
                </span>
                {p.loc ? <code className="hot-path-loc">{p.loc}</code> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
