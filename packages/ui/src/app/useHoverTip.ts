import { useState } from 'react';

export interface HoverTip {
  title: string;
  lines: string[];
  x: number;
  y: number;
  top: number;
}

/** A tooltip that follows a hover target at once (no delay): these targets are small, so waiting hides them. */
export function useHoverTip(): {
  tip: HoverTip | null;
  show(el: HTMLElement, content: { title: string; lines: string[] }, clientX?: number): void;
  hide(): void;
} {
  const [tip, setTip] = useState<HoverTip | null>(null);
  return {
    tip,
    show: (el, content, clientX) => {
      const b = el.getBoundingClientRect();
      setTip({ ...content, x: clientX ?? b.left + b.width / 2, y: b.bottom, top: b.top });
    },
    hide: () => setTip(null),
  };
}
