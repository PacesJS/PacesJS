import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

/** Width of an element in CSS pixels, kept current; `fallback` until it is known (or without ResizeObserver). */
export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 800): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
