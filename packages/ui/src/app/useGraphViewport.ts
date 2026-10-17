import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import {
  ZOOM_STEP,
  centerOn,
  fitViewport,
  focusViewport,
  isInView,
  panBy,
  zoomAt,
} from '../view/graph-viewport';
import type { Rect, Size, Viewport } from '../view/graph-viewport';
import { DRAG_PX } from './click-off';

const PAN_KEY_PX = 60;

interface GraphViewportInput {
  boxEl: HTMLElement | null;
  box: Size;
  /** The laid-out graph; `nodeCount` tells a new layout from the same one. */
  layout: (Size & { nodeCount: number }) | undefined;
  selFn: number | null;
  selBox: Rect | undefined;
}

/** Zoom and pan of the call graph: buttons, keys, wheel and drag, and the fit/follow-selection rules. */
export function useGraphViewport({ boxEl, box, layout, selFn, selBox }: GraphViewportInput) {
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

  // Place the graph: fit it when a new layout arrives (centred on the selection when there is
  // one), and pan to the selection when it moves out of sight. State is adjusted while rendering.
  const layoutKey = layout ? `${layout.w}x${layout.h}:${layout.nodeCount}` : '';
  const sizeKey = `${Math.round(box.w / 24)}x${Math.round(box.h / 24)}`;
  if (
    layout &&
    box.w > 0 &&
    (seen.layout !== layoutKey || seen.sel !== String(selFn) || seen.size !== sizeKey)
  ) {
    setSeen({ layout: layoutKey, sel: String(selFn), size: sizeKey });
    const content = { w: layout.w, h: layout.h };
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
    if (layout) setView(fitViewport({ w: layout.w, h: layout.h }, box));
  };
  const actual = (): void => {
    setMoved(true);
    setEasing(true);
    setView(zoomAt(view, 1 / view.k, box.w / 2, box.h / 2));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
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
  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
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
  const onClickCapture = (e: MouseEvent<HTMLElement>): void => {
    if (justDragged.current) {
      justDragged.current = false;
      e.stopPropagation();
    }
  };

  return {
    view,
    easing,
    zoomBy,
    fit,
    actual,
    handlers: {
      onKeyDown,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onClickCapture,
    },
  };
}
