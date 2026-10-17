import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useApp } from '../app/context';
import { useAsync, useElementSize } from '../app/hooks';
import type { CgNode } from '../data/types';
import { NODE_H } from '../data/layout';
import type { PlacedNode } from '../data/layout';
import { fmtCount, fmtDuration } from '../util/format';
import { edgeAnchors, edgeKey, edgePath, showViaLabel } from '../view/graph-edges';
import {
  ZOOM_STEP,
  centerOn,
  detailAt,
  fitViewport,
  focusViewport,
  isInView,
  panBy,
  percent,
  zoomAt,
} from '../view/graph-viewport';
import type { Viewport } from '../view/graph-viewport';
import { Hint } from './Hint';
import { Legend } from './Legend';
import { Switch } from './Switch';

const PAN_KEY_PX = 60;
const DRAG_PX = 4;

const ORIGIN_VAR = [
  '--c-origin-you',
  '--c-origin-dependency',
  '--c-origin-framework',
  '--c-origin-node',
  '--c-origin-native',
  '--c-origin-gc',
  '--c-origin-gc',
] as const;

export function CallGraph() {
  const { client, scope, scopeKey, snap, dispatch, selection, hoverFn, select, openDock } =
    useApp();
  const [all, setAll] = useState(false);
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const box = useElementSize(boxEl);
  const [view, setView] = useState<Viewport>({ k: 1, x: 0, y: 0 });
  const [seen, setSeen] = useState({ layout: '', sel: '', size: '' });
  // Once the user zooms or pans, a resize no longer re-fits the graph.
  const [moved, setMoved] = useState(false);
  // The buttons and keys ease the view; the wheel and dragging follow the pointer 1:1.
  const [easing, setEasing] = useState(false);
  const viewRef = useRef(view);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  useEffect(() => {
    viewRef.current = view;
  });
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

  // Place the graph: fit it when a new layout arrives (centred on the selection when there is
  // one), and pan to the selection when it moves out of sight. State is adjusted while rendering.
  const layoutKey = res
    ? `${res.layout.width}x${res.layout.height}:${res.layout.nodes.length}`
    : '';
  const sizeKey = `${Math.round(box.w / 24)}x${Math.round(box.h / 24)}`;
  if (
    res &&
    box.w > 0 &&
    (seen.layout !== layoutKey || seen.sel !== String(selFn) || seen.size !== sizeKey)
  ) {
    setSeen({ layout: layoutKey, sel: String(selFn), size: sizeKey });
    const content = { w: res.layout.width, h: res.layout.height };
    const fresh = seen.layout !== layoutKey || seen.size === '';
    const resized = seen.size !== sizeKey && !moved;
    if (fresh || resized) {
      setView(selBox ? focusViewport(content, selBox, box) : fitViewport(content, box));
    } else if (selBox && !isInView(view, selBox, box)) {
      setView(centerOn(view, selBox, box));
    }
  }

  // Wheel and trackpad zoom toward the cursor. A native listener: React's wheel handler is
  // passive and could not stop the page from scrolling.
  useEffect(() => {
    if (!boxEl) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = boxEl.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setMoved(true);
      setEasing(false);
      setView(zoomAt(viewRef.current, factor, e.clientX - rect.left, e.clientY - rect.top));
    };
    boxEl.addEventListener('wheel', onWheel, { passive: false });
    return () => boxEl.removeEventListener('wheel', onWheel);
  }, [boxEl]);

  const zoomBy = (factor: number): void => {
    setMoved(true);
    setEasing(true);
    setView(zoomAt(view, factor, box.w / 2, box.h / 2));
  };
  const fit = (): void => {
    setMoved(false);
    setEasing(true);
    if (res) setView(fitViewport({ w: res.layout.width, h: res.layout.height }, box));
  };
  const actual = (): void => {
    setMoved(true);
    setEasing(true);
    setView(zoomAt(view, 1 / view.k, box.w / 2, box.h / 2));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const move = (dx: number, dy: number): void => {
      e.preventDefault();
      setMoved(true);
      setEasing(false);
      setView(panBy(view, dx, dy));
    };
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomBy(1 / ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      actual();
    } else if (e.key === 'ArrowLeft') move(PAN_KEY_PX, 0);
    else if (e.key === 'ArrowRight') move(-PAN_KEY_PX, 0);
    else if (e.key === 'ArrowUp') move(0, PAN_KEY_PX);
    else if (e.key === 'ArrowDown') move(0, -PAN_KEY_PX);
  };

  // Dragging pans. The pointer is captured only once it has moved, so plain clicks still reach
  // the nodes underneath.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
    d.moved = true;
    setMoved(true);
    setEasing(false);
    d.x = e.clientX;
    d.y = e.clientY;
    setView(panBy(viewRef.current, dx, dy));
  };
  const endDrag = (): void => {
    justDragged.current = drag.current?.moved === true;
    drag.current = null;
  };

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
  const near = res.near ? new Set(res.near) : null;
  const anchors = edgeAnchors(new Map(res.layout.nodes.map((n) => [n.fn, n])), res.graph.edges);
  const detail = detailAt(view.k);
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
        <div className="cg-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="btn"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            −
          </button>
          <span className="cg-zoom-level num" aria-label="Zoom level">
            {percent(view.k)}
          </span>
          <button
            type="button"
            className="btn"
            aria-label="Zoom in"
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            +
          </button>
          <button type="button" className="btn" onClick={fit}>
            Fit
          </button>
          <button type="button" className="btn" onClick={actual}>
            100%
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
            Collapse {p}
          </button>
        ))}
        {selectionHidden ? (
          <button type="button" className="btn" onClick={() => reveal([selFn])}>
            Reveal {selection.name}
          </button>
        ) : null}
        <p className="axis-caption" style={{ marginLeft: 'auto' }}>
          callers above callees · each function shown once · scroll to zoom, drag to pan
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
      <div
        className={`cg-scroll is-${detail}`}
        ref={setBoxEl}
        tabIndex={0}
        role="group"
        aria-label={`Call graph with ${graph.nodes.length} functions. Scroll to zoom, drag to pan, plus and minus to zoom, 0 for 100%, arrows to pan.`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={(e) => {
          if (justDragged.current) {
            justDragged.current = false;
            e.stopPropagation();
          }
        }}
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
                      <span
                        className="cg-recursion"
                        title={`Recursive: calls itself ${n.recursion} times`}
                      >
                        ↻ ×{n.recursion}
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
                    <span className="cg-node-self-label">self</span>
                    <span className="cg-node-total">total {fmtDuration(n.totalUs)}</span>
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
                    via {e.hiddenFrames} {e.hiddenFrames === 1 ? 'frame' : 'frames'}
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
                    onClick={() => reveal([n.fn])}
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
                    onClick={() => reveal([n.fn])}
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
