import type { ReactNode } from 'react';

interface SwitchProps {
  checked: boolean;
  onChange(next: boolean): void;
  children: ReactNode;
  hint?: string;
  disabled?: boolean;
  /** Accessible name when the children are not plain text. */
  label?: string;
}

export function Switch({ checked, onChange, children, hint, disabled, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {children}
      {hint ? <span className="switch-hint">{hint}</span> : null}
    </button>
  );
}
