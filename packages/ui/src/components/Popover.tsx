import { useEffect, useId, useRef } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react';
import { claimPopover, releasePopover } from './popover-store';

interface SurfaceProps {
  /** Stable per-popover id; claiming it closes whichever popover was open before. */
  id: string;
  role: 'menu' | 'dialog';
  label: string;
  onClose(): void;
  /** The trigger: pointer presses on it are not "outside", and Escape returns focus to it. */
  triggerRef?: RefObject<HTMLElement | null>;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

const ITEMS = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

/**
 * The one dismissable surface behind every dropdown, menu and popover: closes on an outside
 * press, Escape (focus goes back to the trigger), Tab out of it, or when another popover opens.
 * Menus also walk their items with the arrow keys.
 */
export function PopoverSurface({
  id,
  role,
  label,
  onClose,
  triggerRef,
  className,
  style,
  children,
}: SurfaceProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    claimPopover(id, () => closeRef.current());
    return () => releasePopover(id);
  }, [id]);

  const inside = (target: EventTarget | null): boolean =>
    target instanceof Node &&
    (ref.current?.contains(target) === true || triggerRef?.current?.contains(target) === true);
  const insideRef = useRef(inside);
  useEffect(() => {
    insideRef.current = inside;
  });

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!insideRef.current(e.target)) closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  useEffect(() => {
    if (role !== 'menu') return;
    ref.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [role]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeRef.current();
      triggerRef?.current?.focus();
      return;
    }
    if (role !== 'menu') return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number): void => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
  };

  return (
    <div
      ref={ref}
      className={className ?? 'menu'}
      role={role}
      aria-label={label}
      style={style}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && !inside(next)) closeRef.current();
      }}
    >
      {children}
    </div>
  );
}

interface PopoverProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  role: 'menu' | 'dialog';
  /** Accessible name of the popover. */
  label: string;
  /** The button that opens it. Receives the aria props and the toggle handler. */
  trigger(props: {
    ref: RefObject<HTMLButtonElement | null>;
    'aria-haspopup': 'menu' | 'dialog';
    'aria-expanded': boolean;
    'aria-controls': string | undefined;
    onClick(): void;
  }): ReactNode;
  /** Pass `close` to items that should dismiss the popover when chosen. */
  children: (close: () => void) => ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** A trigger button plus the popover it opens. Controlled, so callers can mirror the state. */
export function Popover({
  open,
  onOpenChange,
  role,
  label,
  trigger,
  children,
  className,
  style,
}: PopoverProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = (): void => onOpenChange(false);
  return (
    <div className="menu-anchor">
      {trigger({
        ref: triggerRef,
        'aria-haspopup': role,
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        onClick: () => onOpenChange(!open),
      })}
      {open ? (
        <PopoverSurface
          id={id}
          role={role}
          label={label}
          onClose={close}
          triggerRef={triggerRef}
          className={className}
          style={style}
        >
          {children(close)}
        </PopoverSurface>
      ) : null}
    </div>
  );
}
