import { useEffect } from 'react';
import { clicksOff, onScrollbar } from './click-off';
import type { PointerStart } from './click-off';

/**
 * Click-off: one listener for the whole app. A click on anything that is not interactive and not what
 * the user is working with clears the selection (see click-off.ts for the rules).
 */
export function useClickOff(clearCurrent: () => void): void {
  useEffect(() => {
    let start: PointerStart | null = null;
    const popoverOpen = (): boolean =>
      document.querySelector('[role="menu"], [role="dialog"]:not([aria-modal="true"])') !== null;
    const onDown = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      start = {
        x: e.clientX,
        y: e.clientY,
        target,
        blocked: popoverOpen() || (target ? onScrollbar(target, e.clientX, e.clientY) : false),
      };
    };
    const onClick = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const begun = start;
      start = null;
      const blocked = begun?.blocked === true;
      const off = clicksOff(
        begun ? { ...begun, blocked } : null,
        { x: e.clientX, y: e.clientY, target },
        {
          selectedText: window.getSelection()?.toString() ?? '',
          popoverOpen: false,
          modalOpen: document.querySelector('[aria-modal="true"]') !== null,
        },
      );
      if (off) clearCurrent();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onClick);
    };
  }, [clearCurrent]);
}
