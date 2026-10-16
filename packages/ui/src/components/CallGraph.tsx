import { useMemo, useState } from 'react';
import { useApp } from '../app/context';
import { useAsync, useElementWidth } from '../app/hooks';
import type { CgEdge, CgNode } from '../data/callgraph';
import { NODE_H } from '../data/layout';
import type { PlacedNode } from '../data/layout';
import { fmtCount, fmtDuration } from '../util/format';
import { Hint } from './Hint';
import { Legend } from './Legend';
import { Switch } from './Switch';

const ORIGIN_VAR = [
  '--c-origin-you',
  '--c-origin-dependency',
  '--c-origin-framework',
  '--c-origin-node',
  '--c-origin-native',
  '--c-origin-gc',
  '--c-origin-gc',
] as const;

/** Functions within `levels` of the selection along caller and callee edges (ego mode). */
export function egoSet(edges: readonly CgEdge[], fn: number, levels = 2): Set<number> {
  const keep = new Set<number>([fn]);
  let up = [fn];
  let down = [fn];
  for (let l = 0; l < levels; l++) {
    const nu: number[] = [];
    const nd: number[] = [];
    for (const e of edges) {
      if (up.includes(e.to) && !keep.has(e.from)) {
        keep.add(e.from);
        nu.push(e.from);
      }
      if (down.includes(e.from) && !keep.has(e.to)) {
        keep.add(e.to);
        nd.push(e.to);
      }
    }
    up = nu;
    down = nd;
  }
  return keep;
}

export function CallGraph() {
  const { client, scope, scopeKey, snap, dispatch, selection, hoverFn, select } = useApp();
  const [all, setAll] = useState(false);
  const [reveal, setReveal] = useState<{ key: string; ids: number[] }>({ key: '', ids: [] });
  const [fit, setFit] = useState(false);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const boxW = useElementWidth(scrollEl);
  const revealIds = reveal.key === scopeKey ? reveal.ids : [];
  const expanded = snap.options.expanded;
  const q = useAsync(
    () => client.callGraph(scope, { all, reveal: revealIds }, expanded),
    `cg:${scopeKey}:${all}:${revealIds.join(',')}:${expanded.join('|')}`,
  );
  const res = q.data;
  const selFn = selection.fn;
  const pos = useMemo(
    () => new Map<number, PlacedNode>((res?.layout.nodes ?? []).map((n) => [n.fn, n])),
    [res],
  );

  if (q.error)
    return (
      <div className="wf-empty" role="alert">
        {q.error}
      </div>
    );
  if (!res)
    return (
      <div className="wf-empty" role="status">
        Laying out the call graph…
      </div>
    );
  const { graph, layout } = res;
  const ego = snap.options.ego && selFn !== null && graph.nodes.some((n) => n.fn === selFn);
  const near = ego && selFn !== null ? egoSet(graph.edges, selFn) : null;
  const scale = fit && boxW > 0 && layout.width > boxW ? boxW / layout.width : 1;
  const byFn = new Map<number, CgNode>(graph.nodes.map((n) => [n.fn, n]));
  const maxTotal = graph.maxTotalUs;
  const selectionHidden = selFn !== null && !byFn.has(selFn);

  const nodeBox = (fn: number): PlacedNode => pos.get(fn) ?? { fn, x: 0, y: 0, w: 200, h: NODE_H };

  const label = (n: CgNode): string =>
    `${n.name}, ${n.isPackage ? 'package' : n.sub}, self ${fmtDuration(n.selfUs)}, total ${fmtDuration(n.totalUs)}`;

  return (
    <>
      <div className="toolbar">
        <Switch
          checked={snap.options.ego}
          onChange={(v) => dispatch({ type: 'options', options: { ego: v } })}
        >
          Ego mode{selection.fn !== null && selection.name ? `: ${selection.name}` : ''}
        </Switch>
        <span className="fn-status">
          Pruned to 80% of time ·{' '}
          <strong>
            {graph.shownFns} of {graph.totalFns}
          </strong>{' '}
          functions
        </span>
        <button type="button" className="btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Prune' : 'Show all'}
        </button>
        <button type="button" className="btn" aria-pressed={fit} onClick={() => setFit((v) => !v)}>
          Fit
        </button>
        {expanded.map((p) => (
          <button
            key={p}
            type="button"
            className="btn"
            onClick={() =>
              dispatch({ type: 'options', options: { expanded: expanded.filter((x) => x !== p) } })
            }
          >
            Collapse {p}
          </button>
        ))}
        {selectionHidden ? (
          <button
            type="button"
            className="btn"
            onClick={() => setReveal({ key: scopeKey, ids: [...revealIds, selFn] })}
          >
            Reveal {selection.name}
          </button>
        ) : null}
        <p className="axis-caption" style={{ marginLeft: 'auto' }}>
          callers above callees · each function shown once
        </p>
      </div>
      <Legend />
      <ul className="cg-encoding" aria-label="Encoding">
        <li>
          <span
            aria-hidden="true"
            style={{
              width: 18,
              height: 12,
              borderRadius: 3,
              background: 'color-mix(in srgb, var(--c-origin-you) 70%, transparent)',
            }}
          />
          Node size and fill = self time
        </li>
        <li>
          <span
            aria-hidden="true"
            style={{ width: 18, height: 6, borderRadius: 3, background: 'var(--c-ink)' }}
          />
          Inner bar = total time
        </li>
        <li>
          <span
            aria-hidden="true"
            style={{ width: 18, height: 0, borderTop: '4px solid var(--c-muted)' }}
          />
          Edge width = time passed to callee
        </li>
        <li>
          <span className="cg-label" style={{ position: 'static', transform: 'none' }}>
            27% · ~96
          </span>
          Share of caller · est. calls
        </li>
        <li>
          <span
            className="cg-label"
            style={{ position: 'static', transform: 'none', borderColor: 'var(--c-border-strong)' }}
          >
            +3
          </span>
          Hidden callers or callees
        </li>
      </ul>
      <Hint id="hint-callgraph">
        Each function appears once, with its whole cost in one box. Callers sit above callees;
        thicker edges carried more time. Select a node to fade everything more than two levels away.
      </Hint>
      <div className="cg-scroll" ref={setScrollEl}>
        <div
          className="cg-plot"
          role="group"
          aria-label={`Call graph with ${graph.nodes.length} functions`}
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            style={{
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              width: layout.width,
              height: layout.height,
              position: 'absolute',
              left: 0,
              top: 0,
            }}
          >
            <svg
              className="cg-svg"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden="true"
            >
              {graph.edges.map((e) => {
                const a = nodeBox(e.from);
                const b = nodeBox(e.to);
                const x1 = a.x + a.w / 2;
                const y1 = a.y + a.h;
                const x2 = b.x + b.w / 2;
                const y2 = b.y;
                const my = (y1 + y2) / 2;
                const isEgo = near
                  ? near.has(e.from) &&
                    near.has(e.to) &&
                    (e.from === selFn || e.to === selFn || (near.has(e.from) && near.has(e.to)))
                  : false;
                const faded = near !== null && !isEgo;
                return (
                  <path
                    key={`${e.from}-${e.to}`}
                    d={`M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
                    fill="none"
                    strokeWidth={1.5 + (9 * e.timeUs) / graph.maxEdgeUs}
                    strokeLinecap="round"
                    className={`${isEgo ? 'cg-edge-ego' : 'cg-edge'}${faded ? ' cg-fade-edge' : ''}`}
                  />
                );
              })}
              {graph.loops.map((l) => {
                const n = nodeBox(l.fn);
                const x = n.x + n.w;
                const y = n.y + n.h * 0.3;
                return (
                  <path
                    key={`loop-${l.fn}`}
                    className="cg-loop"
                    d={`M${x} ${y} C ${x + 32} ${y - 10}, ${x + 32} ${y + 44}, ${x} ${y + 34}`}
                    fill="none"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                  />
                );
              })}
            </svg>
            {graph.nodes.map((n) => {
              const box = nodeBox(n.fn);
              const rgb = `var(${ORIGIN_VAR[n.origin] ?? ORIGIN_VAR[4]})`;
              const alpha = Math.round((0.14 + 0.62 * Math.sqrt(n.selfUs / graph.maxSelfUs)) * 100);
              const isSel = selFn === n.fn;
              const faded = near !== null && !near.has(n.fn);
              const isHover = hoverFn === n.fn && !isSel;
              return (
                <button
                  key={n.fn}
                  type="button"
                  className={`cg-node${isSel ? ' is-selected' : ''}${faded ? ' is-faded' : ''}`}
                  aria-label={label(n)}
                  aria-pressed={isSel}
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.w,
                    height: box.h,
                    border: `1px solid color-mix(in srgb, ${rgb} 55%, transparent)`,
                    background: `color-mix(in srgb, ${rgb} ${alpha}%, transparent)`,
                    outline: isHover ? '1px solid var(--c-outline)' : undefined,
                  }}
                  onClick={() => select({ kind: 'fn', fn: n.fn })}
                  onDoubleClick={() => dispatch({ type: 'set-source-collapsed', collapsed: false })}
                  onPointerEnter={() =>
                    dispatch({ type: 'hover', selection: { kind: 'fn', fn: n.fn } })
                  }
                  onPointerLeave={() => dispatch({ type: 'hover', selection: { kind: 'none' } })}
                >
                  <span className="cg-node-head">
                    <span className={`cg-node-name${n.origin === 0 ? ' is-user' : ''}`}>
                      {n.name}
                    </span>
                    <span className="cg-node-sub">{n.sub}</span>
                  </span>
                  <span className="cg-node-bar" aria-hidden="true">
                    <span
                      className="cg-node-fill"
                      style={{
                        width: `${((n.totalUs / maxTotal) * 100).toFixed(1)}%`,
                        background: n.origin === 0 ? 'var(--c-ink)' : rgb,
                      }}
                    />
                  </span>
                  <span className="cg-node-stats">
                    self {fmtDuration(n.selfUs)} · total {fmtDuration(n.totalUs)}
                  </span>
                </button>
              );
            })}
            {graph.edges
              .filter(
                (e) =>
                  near !== null &&
                  near.has(e.from) &&
                  near.has(e.to) &&
                  (e.from === selFn || e.to === selFn || near.has(e.from)),
              )
              .map((e) => {
                const a = nodeBox(e.from);
                const b = nodeBox(e.to);
                const my = (a.y + a.h + b.y) / 2;
                return (
                  <span
                    key={`l-${e.from}-${e.to}`}
                    className="cg-label"
                    style={{ left: (a.x + a.w / 2 + b.x + b.w / 2) / 2, top: my - 9 }}
                  >
                    {Math.round(e.share * 100)}% · {fmtCount(e.calls)}
                  </span>
                );
              })}
            {graph.loops.map((l) => {
              const n = nodeBox(l.fn);
              return (
                <span
                  key={`ll-${l.fn}`}
                  className="cg-loop-label"
                  style={{ left: n.x + n.w + 20, top: n.y + n.h * 0.3 + 12 }}
                >
                  recursion ×{l.count}
                </span>
              );
            })}
            {graph.nodes.flatMap((n) => {
              const box = nodeBox(n.fn);
              const chips: React.ReactNode[] = [];
              if (n.isPackage && n.members > 1) {
                chips.push(
                  <button
                    key={`x-${n.fn}`}
                    type="button"
                    className="cg-chip"
                    aria-label={`Expand ${n.name}: ${n.members} functions`}
                    style={{ left: box.x + box.w - 18, top: box.y + box.h - 10 }}
                    onClick={() =>
                      dispatch({
                        type: 'options',
                        options: { expanded: [...new Set([...expanded, n.name])] },
                      })
                    }
                  >
                    +{n.members}
                  </button>,
                );
              } else if (n.hiddenCallees > 0) {
                chips.push(
                  <button
                    key={`c-${n.fn}`}
                    type="button"
                    className="cg-chip"
                    aria-label={`Show ${n.hiddenCallees} hidden callee${n.hiddenCallees === 1 ? '' : 's'} of ${n.name}`}
                    style={{ left: box.x + box.w - 18, top: box.y + box.h - 10 }}
                    onClick={() =>
                      setReveal({ key: scopeKey, ids: [...revealIds, ...n.hiddenCalleeIds] })
                    }
                  >
                    +{n.hiddenCallees}
                  </button>,
                );
              }
              if (n.hiddenCallers > 0) {
                chips.push(
                  <button
                    key={`u-${n.fn}`}
                    type="button"
                    className="cg-chip"
                    aria-label={`Show ${n.hiddenCallers} hidden caller${n.hiddenCallers === 1 ? '' : 's'} of ${n.name}`}
                    style={{ left: box.x + box.w - 18, top: box.y - 14 }}
                    onClick={() =>
                      setReveal({ key: scopeKey, ids: [...revealIds, ...n.hiddenCallerIds] })
                    }
                  >
                    +{n.hiddenCallers}
                  </button>,
                );
              }
              return chips;
            })}
          </div>
        </div>
      </div>
      <p className="view-footer" style={{ display: 'block' }}>
        Faded nodes are outside two levels of the selection. Positions stay put when the selection
        changes; only fading and highlight move.
        {snap.transforms.some((t) => t.k === 'collapse-deps')
          ? ' Packages are collapsed; use the +N chip on a package to expand it in place.'
          : ''}
      </p>
    </>
  );
}
