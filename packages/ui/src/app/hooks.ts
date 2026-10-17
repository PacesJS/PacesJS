import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { readPalette } from '../theme/palette';
import type { Palette } from '../theme/palette';

function subscribeTheme(cb: () => void): () => void {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  mq?.addEventListener('change', cb);
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    mq?.removeEventListener('change', cb);
    mo.disconnect();
  };
}

function themeKey(): string {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced) return forced;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** "light" or "dark": changes when the OS scheme or `data-theme` changes. */
export function useThemeName(): string {
  return useSyncExternalStore(subscribeTheme, themeKey, () => 'light');
}

/** Resolved CSS tokens for canvas drawing, refreshed when the theme changes. */
const palettes = new Map<string, Palette>();

function paletteFor(theme: string): Palette {
  let p = palettes.get(theme);
  if (!p || p.ink === '') {
    p = readPalette();
    palettes.set(theme, p);
  }
  return p;
}

export function usePalette(): Palette {
  return paletteFor(useThemeName());
}

export interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Keep a canvas sized to its CSS box and call `draw` whenever it resizes or `deps` change.
 * Returns a ref for the canvas. jsdom has no 2D context: drawing is skipped there.
 */
export function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, size: CanvasSize) => void,
  deps: readonly unknown[],
): RefObject<HTMLCanvasElement | null> {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  });
  const paint = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawRef.current(ctx, { width: w, height: h, dpr });
  }, []);
  useEffect(() => {
    paint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint, ...deps]);
  const observed = useRef<{ el: HTMLCanvasElement; ro: ResizeObserver } | null>(null);
  useEffect(() => {
    // The canvas can mount after the first render (data arrives later): follow the element.
    const canvas = ref.current;
    if (observed.current && observed.current.el === canvas) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    // One redraw per frame, however many resize notifications arrive while the dock moves.
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    });
    ro.observe(canvas);
    observed.current = { el: canvas, ro };
  });
  useEffect(() => () => observed.current?.ro.disconnect(), []);
  return ref;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  /** True while the latest request is in flight (previous data stays visible). */
  loading: boolean;
}

/**
 * Run an async query whenever `key` changes and keep the last result while the next one is
 * computed. `key` must identify the inputs of `run` (a string, so it compares cheaply).
 */
export function useAsync<T>(run: () => Promise<T>, key: string): AsyncState<T> {
  const [state, setState] = useState<{
    data: T | undefined;
    error: string | null;
    doneKey: string | null;
  }>({
    data: undefined,
    error: null,
    doneKey: null,
  });
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    let cancelled = false;
    runRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ data, error: null, doneKey: key });
      })
      .catch((e: unknown) => {
        // A query failure is shown in the view; the stack goes to the console for diagnosis.
        // eslint-disable-next-line no-console
        console.error('paces: a view query failed', e);
        if (!cancelled) {
          // The previous result belongs to a different request: showing it next to this error
          // would present stale data as current.
          setState({
            data: undefined,
            error: e instanceof Error ? e.message : String(e),
            doneKey: key,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return { data: state.data, error: state.error, loading: state.doneKey !== key };
}

/** Width of an element, tracked with a ResizeObserver. Pass the result of `useElementRef`. */
export function useElementWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setW(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return el ? w : 0;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Text width in CSS pixels for a font; falls back to an estimate where canvas is missing (jsdom). */
export function measureText(text: string, font: string): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Width and height of an element, tracked with a ResizeObserver (0 x 0 where there is none). */
export function useElementSize(el: HTMLElement | null): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) =>
      setSize({ w: entry?.contentRect.width ?? 0, h: entry?.contentRect.height ?? 0 }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return el ? size : { w: 0, h: 0 };
}
