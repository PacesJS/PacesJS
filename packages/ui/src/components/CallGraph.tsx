import { useMemo, useState } from 'react';
import { useApp } from '../app/context';
import { useHoverFn } from '../app/hover';
import { useGraphViewport } from '../app/useGraphViewport';
import { useAsync, useElementSize } from '../app/hooks';
import type { CgNode } from '../data/types';
import { NODE_H } from '../data/layout';
import type { PlacedNode } from '../data/layout';
import { fmtCount, fmtDuration } from '../util/format';
import { edgeAnchors, edgeKey, edgePath, showViaLabel } from '../view/graph-edges';
import { ZOOM_STEP, detailAt, percent } from '../view/graph-viewport';
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

const TEXT = {
  laying: 'Laying out the call graph…',
  package: 'package',
  node: (name: string, kind: string, self: string, total: string) =>
    `${name}, ${kind}, self ${self}, total ${total}`,
  ego: 'Ego mode',
  egoName: (name: string) => `: ${name}`,
  pruned: 'Pruned to 80% of time ·',
  shownOf: (shown: number, total: number) => `${shown} of ${total}`,
  functions: 'functions',
  prune: 'Prune',
  showAll: 'Show all',
  zoom: 'Zoom',
  zoomOut: 'Zoom out',
  minus: '−',
  zoomLevel: 'Zoom level',
  zoomIn: 'Zoom in',
  plus: '+',
  fit: 'Fit',
  actual: '100%',
  collapse: (pkg: string) => `Collapse ${pkg}`,
  reveal: (name: string) => `Reveal ${name}`,
  caption: 'callers above callees · each function shown once · scroll to zoom, drag to pan',
  encoding: 'Encoding',
  nodeSize: 'Node size and fill = self time',
  innerBar: 'Inner bar = total time',
  edgeWidth: 'Edge width = time passed to callee',
  sampleEdge: '27% · ~96',
  shareOfCaller: 'Share of caller · est. calls',
  sampleHidden: '+3',
  hiddenNeighbours: 'Hidden callers or callees',
  hint: 'Each function appears once, with its whole cost in one box. Callers sit above callees; thicker edges carried more time. Select a node to fade everything more than two levels away.',
  graph: (count: number) =>
    `Call graph with ${count} functions. Scroll to zoom, drag to pan, plus and minus to zoom, 0 for 100%, arrows to pan.`,
  recursionTitle: (times: number) => `Recursive: calls itself ${times} times`,
  recursion: (times: number) => `↻ ×${times}`,
  self: 'self',
  total: (duration: string) => `total ${duration}`,
  edge: (percent: number, calls: string) => `${percent}% · ${calls}`,
  via: (frames: number) => `via ${frames} ${frames === 1 ? 'frame' : 'frames'}`,
  expand: (name: string, members: number) => `Expand ${name}: ${members} functions`,
  more: (count: number) => `+${count}`,
  hiddenCallees: (count: number, name: string) =>
    `Show ${count} hidden callee${count === 1 ? '' : 's'} of ${name}`,
  hiddenCallers: (count: number, name: string) =>
    `Show ${count} hidden caller${count === 1 ? '' : 's'} of ${name}`,
  footer:
    'Faded nodes are outside two levels of the selection. Positions stay put when the selection changes; only fading and highlight move.',
  packagesCollapsed: ' Packages are collapsed; use the +N chip on a package to expand it in place.',
} as const;

export function CallGraph() {
  const { client, scope, scopeKey, snap, dispatch, selection, select, openDock } = useApp();
  const hoverFn = useHoverFn();
  const [all, setAll] = useState(false);
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const box = useElementSize(boxEl);
  const revealIds = snap.options.reveal;
  const reveal = (ids: number[]): void =>
    dispatch({
      type: 'options',
      options: { reveal: [...new Set([...revealIds, ...ids])] },
      replace: true,
    });
  const expanded = snap.options.expanded;
  const selFn = selection.fn;
  const egoFn = snap.options.ego ? selFn : null;
  const q = useAsync(
    () => client.callGraph(scope, { all, revealed: revealIds, ego: egoFn }, expanded),
    `cg:${scopeKey}:${all}:${revealIds.join(',')}:${expanded.join('|')}:${egoFn}`,
  );
  const res = q.data;
  const pos = useMemo(
    () => new Map<number, PlacedNode>((res?.layout.nodes ?? []).map((n) => [n.fn, n])),
    [res],
  );

  const selBox = selFn === null ? undefined : pos.get(selFn);

  const { view, easing, zoomBy, fit, actual, handlers } = useGraphViewport({
    boxEl,
    box,
    layout: res && {
      w: res.layout.width,
      h: res.layout.height,
      nodeCount: res.layout.nodes.length,
    },
    selFn,
    selBox,
  });

  if (q.error)
    return (
      <div className="wf-empty" role="alert">
        {q.error}
      </div>
    );
  if (!res)
    return (
      <div className="wf-empty" role="status">
        {TEXT.laying}
      </div>
    );
  const { graph, layout } = res;
  const near = res.near ? new Set(res.near) : null;
  const anchors = edgeAnchors(new Map(res.layout.nodes.map((n) => [n.fn, n])), res.graph.edges);
  const detail = detailAt(view.k);
  const byFn = new Map<number, CgNode>(graph.nodes.map((n) => [n.fn, n]));
  const maxTotal = graph.maxTotalUs;
  const selectionHidden = selFn !== null && !byFn.has(selFn);

  const nodeBox = (fn: number): PlacedNode => pos.get(fn) ?? { fn, x: 0, y: 0, w: 200, h: NODE_H };

  const label = (n: CgNode): string =>
    TEXT.node(
      n.name,
      n.isPackage ? TEXT.package : n.sub,
      fmtDuration(n.selfUs),
      fmtDuration(n.totalUs),
    );

  return (
    <>
      <div className="toolbar">
        <Switch
          checked={snap.options.ego}
          onChange={(v) => dispatch({ type: 'options', options: { ego: v } })}
        >
          {TEXT.ego}
          {selection.fn !== null && selection.name ? TEXT.egoName(selection.name) : ''}
        </Switch>
        <span className="fn-status">
          {TEXT.pruned} <strong>{TEXT.shownOf(graph.shownFns, graph.totalFns)}</strong>{' '}
          {TEXT.functions}
        </span>
        <button type="button" className="btn" onClick={() => setAll((v) => !v)}>
          {all ? TEXT.prune : TEXT.showAll}
        </button>
        <div className="cg-zoom" role="group" aria-label={TEXT.zoom}>
          <button
            type="button"
            className="btn"
            aria-label={TEXT.zoomOut}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            {TEXT.minus}
          </button>
          <span className="cg-zoom-level num" aria-label={TEXT.zoomLevel}>
            {percent(view.k)}
          </span>
          <button
            type="button"
            className="btn"
            aria-label={TEXT.zoomIn}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            {TEXT.plus}
          </button>
          <button type="button" className="btn" onClick={fit}>
            {TEXT.fit}
          </button>
          <button type="button" className="btn" onClick={actual}>
            {TEXT.actual}
          </button>
        </div>
        {expanded.map((p) => (
          <button
            key={p}
            type="button"
            className="btn"
            onClick={() =>
              dispatch({ type: 'options', options: { expanded: expanded.filter((x) => x !== p) } })
            }
          >
            {TEXT.collapse(p)}
          </button>
        ))}
        {selectionHidden ? (
          <button type="button" className="btn" onClick={() => reveal([selFn])}>
            {TEXT.reveal(selection.name)}
          </button>
        ) : null}
        <p className="axis-caption" style={{ marginLeft: 'auto' }}>
          {TEXT.caption}
        </p>
      </div>
      <Legend />
      <ul className="cg-encoding" aria-label={TEXT.encoding}>
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
          {TEXT.nodeSize}
        </li>
        <li>
          <span
            aria-hidden="true"
            style={{ width: 18, height: 6, borderRadius: 3, background: 'var(--c-ink)' }}
          />
          {TEXT.innerBar}
        </li>
        <li>
          <span
            aria-hidden="true"
            style={{ width: 18, height: 0, borderTop: '4px solid var(--c-muted)' }}
          />
          {TEXT.edgeWidth}
        </li>
        <li>
          <span className="cg-label" style={{ position: 'static', transform: 'none' }}>
            {TEXT.sampleEdge}
          </span>
          {TEXT.shareOfCaller}
        </li>
        <li>
          <span
            className="cg-label"
            style={{ position: 'static', transform: 'none', borderColor: 'var(--c-border-strong)' }}
          >
            {TEXT.sampleHidden}
          </span>
          {TEXT.hiddenNeighbours}
        </li>
      </ul>
      <Hint id="hint-callgraph">{TEXT.hint}</Hint>
      <div
        className={`cg-scroll is-${detail}`}
        ref={setBoxEl}
        tabIndex={0}
        role="group"
        aria-label={TEXT.graph(graph.nodes.length)}
        {...handlers}
      >
        <div className="cg-plot">
          <div
            className={`cg-layer${easing ? ' is-easing' : ''}`}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
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
                const ends = anchors.get(edgeKey(e));
                if (!ends) return null;
                // Clicking a node lights up its own edges, whatever the ego fading does.
                const touches = selFn !== null && (e.from === selFn || e.to === selFn);
                const isEgo = touches || (near ? near.has(e.from) && near.has(e.to) : false);
                const faded = near !== null && !isEgo;
                return (
                  <path
                    key={`${e.from}-${e.to}`}
                    d={edgePath(ends)}
                    fill="none"
                    strokeWidth={1.5 + (9 * e.timeUs) / graph.maxEdgeUs}
                    strokeDasharray={e.hiddenFrames > 0 ? '2 5' : e.back ? '5 4' : undefined}
                    strokeLinecap="round"
                    className={`${isEgo ? 'cg-edge-ego' : 'cg-edge'}${faded ? ' cg-fade-edge' : ''}`}
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
                  className={`cg-node${isSel ? ' is-selected' : ''}${faded ? ' is-faded' : ''}${n.isEntry ? ' is-entry' : ''}`}
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
                  onDoubleClick={() => openDock()}
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
                    {n.recursion > 0 ? (
                      <span className="cg-recursion" title={TEXT.recursionTitle(n.recursion)}>
                        {TEXT.recursion(n.recursion)}
                      </span>
                    ) : null}
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
                    <span className="cg-node-self">{fmtDuration(n.selfUs)}</span>
                    <span className="cg-node-self-label">{TEXT.self}</span>
                    <span className="cg-node-total">{TEXT.total(fmtDuration(n.totalUs))}</span>
                  </span>
                </button>
              );
            })}
            {graph.edges
              .filter((e) => near !== null && near.has(e.from) && near.has(e.to))
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
                    {TEXT.edge(Math.round(e.share * 100), fmtCount(e.calls))}
                  </span>
                );
              })}
            {graph.edges
              .filter(
                (e) =>
                  e.hiddenFrames > 0 &&
                  showViaLabel(
                    e.timeUs,
                    graph.maxEdgeUs,
                    selFn !== null && (e.from === selFn || e.to === selFn),
                  ),
              )
              .map((e) => {
                const a = nodeBox(e.from);
                const b = nodeBox(e.to);
                return (
                  <span
                    key={`via-${e.from}-${e.to}`}
                    className="cg-label cg-via"
                    style={{
                      left: (a.x + a.w / 2 + b.x + b.w / 2) / 2,
                      top: (a.y + a.h + b.y) / 2 + 6,
                    }}
                  >
                    {TEXT.via(e.hiddenFrames)}
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
                    aria-label={TEXT.expand(n.name, n.members)}
                    style={{ left: box.x + box.w - 18, top: box.y + box.h - 10 }}
                    onClick={() =>
                      dispatch({
                        type: 'options',
                        options: { expanded: [...new Set([...expanded, n.name])] },
                      })
                    }
                  >
                    {TEXT.more(n.members)}
                  </button>,
                );
              } else if (n.hiddenCallees > 0) {
                chips.push(
                  <button
                    key={`c-${n.fn}`}
                    type="button"
                    className="cg-chip"
                    aria-label={TEXT.hiddenCallees(n.hiddenCallees, n.name)}
                    style={{ left: box.x + box.w - 18, top: box.y + box.h - 10 }}
                    onClick={() => reveal([n.fn])}
                  >
                    {TEXT.more(n.hiddenCallees)}
                  </button>,
                );
              }
              if (n.hiddenCallers > 0) {
                chips.push(
                  <button
                    key={`u-${n.fn}`}
                    type="button"
                    className="cg-chip"
                    aria-label={TEXT.hiddenCallers(n.hiddenCallers, n.name)}
                    style={{ left: box.x + box.w - 18, top: box.y - 14 }}
                    onClick={() => reveal([n.fn])}
                  >
                    {TEXT.more(n.hiddenCallers)}
                  </button>,
                );
              }
              return chips;
            })}
          </div>
        </div>
      </div>
      <p className="view-footer" style={{ display: 'block' }}>
        {TEXT.footer}
        {snap.transforms.some((t) => t.k === 'collapse-deps') ? TEXT.packagesCollapsed : ''}
      </p>
    </>
  );
}
