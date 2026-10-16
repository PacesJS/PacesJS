import { useState } from 'react';
import type { ModelWarning } from '@pacesjs/engine';
import { useApp } from '../app/context';
import { Icon } from './Icon';
import { Popover } from './Popover';

const SMALL_PROFILE_SAMPLES = 200;

/** Notes about the profile: the engine's aggregated warnings plus a low-sample-count note. */
export function profileNotes(
  warnings: readonly ModelWarning[],
  tracks: ReadonlyArray<{ role: string; samples: number }>,
): ModelWarning[] {
  const notes = [...warnings];
  const perTrack = Math.max(0, ...tracks.filter((t) => t.role === 'target').map((t) => t.samples));
  if (perTrack > 0 && perTrack < SMALL_PROFILE_SAMPLES) {
    notes.push({
      kind: 'few-samples',
      severity: 'info',
      summary: `This profile has only ${perTrack} samples, so the numbers are statistically noisy. Run it longer, or sample faster with --interval 100.`,
      count: perTrack,
      details: [],
    });
  }
  // Warnings that need attention come first.
  return notes.sort((a, b) => Number(b.severity === 'warn') - Number(a.severity === 'warn'));
}

/**
 * One collapsed chip in the header instead of a wall of text: "N notes", with the notes in a
 * popover (warn-severity first, details expandable). Dismissible for the session.
 */
export function NotesChip() {
  const { summary, state, dispatch } = useApp();
  const [open, setOpen] = useState(false);
  const notes = profileNotes(summary.warnings, summary.tracks);
  if (notes.length === 0 || state.notesDismissed) return null;
  const warn = notes.some((n) => n.severity === 'warn');
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      role="dialog"
      label="Notes about this profile"
      className="menu notes-popover"
      trigger={(p) => (
        <button
          type="button"
          className={`notes-chip${warn ? ' is-warn' : ''}`}
          aria-label={`${notes.length} ${notes.length === 1 ? 'note' : 'notes'}${warn ? ', some need attention' : ''}`}
          {...p}
        >
          <Icon name={warn ? 'alert' : 'info'} size={14} />
          {notes.length} {notes.length === 1 ? 'note' : 'notes'}
        </button>
      )}
    >
      {() => (
        <>
          <ul className="notes-list">
            {notes.map((n) => (
              <li key={n.kind} className={`notes-item is-${n.severity}`}>
                <Icon name={n.severity === 'warn' ? 'alert' : 'info'} size={16} />
                <div>
                  <p className="notes-summary">
                    {n.summary}
                    {n.count > 1 && n.kind !== 'few-samples' ? (
                      <span className="notes-count"> ×{n.count}</span>
                    ) : null}
                  </p>
                  {n.details.length > 0 ? (
                    <details className="notes-details">
                      <summary>Show details</summary>
                      <ul>
                        {n.details.map((d) => (
                          <li key={d}>
                            <code>{d}</code>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="notes-foot">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => dispatch({ type: 'dismiss-notes' })}
            >
              Dismiss notes
            </button>
          </div>
        </>
      )}
    </Popover>
  );
}
