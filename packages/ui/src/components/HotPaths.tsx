import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { showInView } from '../state/show-in';
import { fmtDuration, fmtShare } from '../util/format';

const LIMIT = 5;
const TAIL = 4;

const TEXT = {
  title: 'Hot paths',
  sub: 'Call chains that carry the most time, plumbing folded in · click to open in the flame graph',
  open: (names: readonly string[]) => `Open hot path ${names.join(' to ')} in the flame graph`,
  chain: (names: readonly string[], truncated: boolean) =>
    `${truncated ? '… → ' : ''}${names.join(' → ')}`,
  stats: (total: string, self: string, share: string) => `${total} total · ${self} self · ${share}`,
} as const;

/** The dominant call chains (engine `hotPaths`): click one to open it zoomed in the flame graph. */
export function HotPaths() {
  const { client, scope, scopeKey, dispatch } = useApp();
  const q = useAsync(() => client.hotPaths(scope, LIMIT), `hotpaths:${scopeKey}`);
  const paths = q.data ?? [];
  if (paths.length === 0) return null;
  return (
    <section className="hot-paths" aria-label={TEXT.title}>
      <div className="section-head">
        <h2 className="section-title">{TEXT.title}</h2>
        <span className="section-sub">{TEXT.sub}</span>
      </div>
      <ol className="hot-path-list">
        {paths.map((p) => {
          const tail = p.names.slice(-TAIL);
          const last = p.fns[p.fns.length - 1] ?? 0;
          return (
            <li key={p.fns.join('.')}>
              <button
                type="button"
                className="hot-path"
                aria-label={TEXT.open(tail)}
                onClick={() =>
                  dispatch({
                    ...showInView('flame', last),
                    options: { zoomPath: p.fns, zoom: [] },
                  })
                }
              >
                <span className="hot-path-chain">{TEXT.chain(tail, p.names.length > TAIL)}</span>
                <span className="hot-path-stats num">
                  {TEXT.stats(fmtDuration(p.totalUs), fmtDuration(p.selfUs), fmtShare(p.share))}
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
