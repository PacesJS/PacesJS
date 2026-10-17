import { useRef, useState } from 'react';

const TIP_DELAY_MS = 150;

export interface BarTip {
  text: string;
  x: number;
  y: number;
  top: number;
}

/** A bar tooltip that waits a moment, so passing over bars does not flicker. */
export function useBarTooltip(): {
  tip: BarTip | null;
  show(el: HTMLElement, text: string): void;
  hide(): void;
} {
  const [tip, setTip] = useState<BarTip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = (): void => {
    if (timer.current !== null) globalThis.clearTimeout(timer.current);
    timer.current = null;
    setTip(null);
  };
  const show = (el: HTMLElement, text: string): void => {
    hide();
    timer.current = globalThis.setTimeout(() => {
      const b = el.getBoundingClientRect();
      setTip({ text, x: b.left + b.width / 2, y: b.bottom, top: b.top });
    }, TIP_DELAY_MS);
  };
  return { tip, show, hide };
}
