// Click-off: a click on something that is not interactive clears the selection. One mechanism for
// the whole app: the shell listens, this module decides. Views that handle a click on their own
// canvas (a flame frame) stop it from reaching the shell; everything else is the allowlist below.

/** Interactive elements, what the user is working with, and regions that own their gestures. */
const KEEPS = [
  '[data-keeps-selection]',
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="separator"]',
  '[role="row"]',
  '[role="listitem"]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="tooltip"]',
].join(',');

export const keepsSelection = (el: Element | null): boolean => Boolean(el?.closest(KEEPS));

/** A press inside the scrollbar gutter of an element (its own scrollbars, not its content). */
export function onScrollbar(el: Element, x: number, y: number): boolean {
  const box = el as HTMLElement;
  if (typeof box.offsetWidth !== 'number') return false;
  // Only a container that scrolls has gutters. Borders make the offset box larger than the client
  // box, and an inline element has an empty client box: neither has a scrollbar to press.
  const style = getComputedStyle(el);
  const scrolls = (overflow: string): boolean => /auto|scroll|overlay/.test(overflow);
  const rect = el.getBoundingClientRect();
  const vertical =
    scrolls(style.overflowY) &&
    box.offsetWidth > box.clientWidth &&
    x >= rect.left + box.clientWidth;
  const horizontal =
    scrolls(style.overflowX) &&
    box.offsetHeight > box.clientHeight &&
    y >= rect.top + box.clientHeight;
  return vertical || horizontal;
}

/** Where a press began, kept until its click. `blocked`: it began on something that keeps. */
export interface PointerStart {
  x: number;
  y: number;
  target: Element | null;
  blocked: boolean;
}

export interface ClickEnd {
  x: number;
  y: number;
  target: Element | null;
}

export interface ClickContext {
  /** The page's current text selection. */
  selectedText: string;
  /** A menu or popover was open when the press began. */
  popoverOpen: boolean;
  /** A modal dialog is open. */
  modalOpen: boolean;
}

/** A press that moved this far is a drag, not a click. */
export const DRAG_PX = 4;

/** Whether this click clears the selection. */
export function clicksOff(start: PointerStart | null, end: ClickEnd, ctx: ClickContext): boolean {
  if (ctx.selectedText !== '' || ctx.popoverOpen || ctx.modalOpen) return false;
  if (start) {
    if (start.blocked || keepsSelection(start.target)) return false;
    if (Math.hypot(end.x - start.x, end.y - start.y) > DRAG_PX) return false;
  }
  return !keepsSelection(end.target);
}
