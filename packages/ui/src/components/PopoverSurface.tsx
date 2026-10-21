import { useEffect, useRef } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react';
import { claimPopover, releasePopover } from './popover-store';

interface PopoverSurfaceProps {
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
}: PopoverSurfaceProps) {
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
