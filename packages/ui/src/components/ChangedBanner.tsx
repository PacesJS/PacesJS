import { Icon } from './Icon';

const TEXT = {
  changed: 'This file changed since profiling. Lines may not match the run.',
  showCopy: 'Show recorded copy',
  noCopy: 'This session has no recorded copy of the file',
} as const;

interface ChangedBannerProps {
  changed: boolean;
}

/** Banner for a file that changed since profiling. */
export function ChangedBanner({ changed }: ChangedBannerProps) {
  if (!changed) return null;
  return (
    <div role="status" className="note source-banner">
      <Icon name="alert" size={16} />
      <span className="note-text" style={{ flexBasis: 180 }}>
        {TEXT.changed}
      </span>
      <button type="button" className="note-action" disabled title={TEXT.noCopy}>
        {TEXT.showCopy}
      </button>
    </div>
  );
}
