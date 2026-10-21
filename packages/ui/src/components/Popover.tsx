import { useId, useRef } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { PopoverSurface } from './PopoverSurface';

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
