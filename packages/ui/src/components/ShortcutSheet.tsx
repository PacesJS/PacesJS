import { useEffect, useRef } from 'react';
import { SHORTCUTS } from '../state/keymap';

const TEXT = {
  title: 'Keyboard shortcuts',
  close: 'Close',
} as const;

interface ShortcutSheetProps {
  onClose(): void;
}

export function ShortcutSheet({ onClose }: ShortcutSheetProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet card"
        role="dialog"
        aria-modal="true"
        aria-label={TEXT.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="section-head">
          <h2 className="section-title">{TEXT.title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
          >
            {TEXT.close}
          </button>
        </div>
        <dl className="sheet-list">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} style={{ display: 'contents' }}>
              <dt className="sheet-keys">{s.keys}</dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
