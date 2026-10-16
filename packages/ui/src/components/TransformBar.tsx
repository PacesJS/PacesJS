import { useId, useState } from 'react';
import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { fmtRange } from '../util/format';
import { transformLabel } from '../state/transforms';
import { hasTransform } from '../state/transforms';
import type { Transform } from '../state/types';
import { Icon } from './Icon';
import { Popover } from './Popover';

interface TransformBarProps {
  /** Session file shown at the right, when the host provides it. */
  sessionPath?: string;
  hasBaseline: boolean;
}

interface MenuEntry {
  label: string;
  transform: Transform;
  disabled?: boolean;
}

export function TransformBar({ sessionPath, hasBaseline }: TransformBarProps) {
  const { snap, dispatch, selection, client } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const compareTipId = useId();
  const fnId = selection.fn;
  const names = (fn: number): string => (fn === fnId ? selection.name : `function ${fn}`);
  const pkgQuery = useAsync(
    () => (fnId === null ? Promise.resolve('') : client.packageOf(fnId)),
    `pkg:${fnId}`,
  );
  const pkg = fnId === null ? '' : (pkgQuery.data ?? '');

  const entries: MenuEntry[] = [
    {
      label: 'Collapse dependencies',
      transform: { k: 'collapse-deps' },
      disabled: hasTransform(snap.transforms, 'collapse-deps'),
    },
    {
      label: 'Merge plumbing',
      transform: { k: 'merge-plumbing' },
      disabled: hasTransform(snap.transforms, 'merge-plumbing'),
    },
    {
      label: 'Drop idle',
      transform: { k: 'drop-idle' },
      disabled: hasTransform(snap.transforms, 'drop-idle'),
    },
    {
      label: hasTransform(snap.transforms, 'invert') ? 'Uninvert' : 'Invert call tree',
      transform: { k: 'invert' },
    },
    ...(fnId !== null
      ? ([
          { label: `Merge ${selection.name}`, transform: { k: 'merge-fn', fn: fnId } },
          { label: `Focus on ${selection.name}`, transform: { k: 'focus-fn', fn: fnId } },
          { label: `Focus on ${selection.name} self`, transform: { k: 'focus-self', fn: fnId } },
          {
            label: `Collapse recursion in ${selection.name}`,
            transform: { k: 'collapse-rec', fn: fnId },
          },
          { label: `Drop samples with ${selection.name}`, transform: { k: 'drop-fn', fn: fnId } },
          ...(pkg
            ? [{ label: `Collapse ${pkg}`, transform: { k: 'collapse-pkg', pkg } } as MenuEntry]
            : []),
        ] as MenuEntry[])
      : []),
  ];

  return (
    <div className="transform-row">
      <span className="caps">Transforms</span>
      <ol className="chips" aria-label="Transform stack, oldest first">
        {snap.transforms.map((t, i) => {
          const label = transformLabel(t, names);
          return (
            <li key={`${i}-${label}`} className="chip-item">
              {i > 0 ? (
                <span className="chip-sep" aria-hidden="true">
                  ›
                </span>
              ) : null}
              <span className="chip">
                <button
                  type="button"
                  className="chip-label"
                  title="Rewind to this point"
                  aria-label={`Rewind to ${label}`}
                  onClick={() => dispatch({ type: 'rewind-transform', index: i })}
                >
                  {label}
                </button>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove ${label}`}
                  onClick={() => dispatch({ type: 'remove-transform', index: i })}
                >
                  <Icon name="close" size={14} strokeWidth={2} />
                </button>
              </span>
            </li>
          );
        })}
        {snap.range ? (
          <li className="chip-item">
            {snap.transforms.length > 0 ? (
              <span className="chip-sep" aria-hidden="true">
                ›
              </span>
            ) : null}
            <span className="chip chip-range">
              <span className="chip-label">Range {fmtRange(snap.range[0], snap.range[1])}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label="Remove time range"
                onClick={() =>
                  dispatch({
                    type: 'go',
                    patch: {
                      range: null,
                      selection:
                        snap.selection.kind === 'range' ? { kind: 'none' } : snap.selection,
                    },
                  })
                }
              >
                <Icon name="close" size={14} strokeWidth={2} />
              </button>
            </span>
          </li>
        ) : null}
      </ol>
      <Popover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        role="menu"
        label="Add transform"
        style={{ top: 38, left: 0 }}
        trigger={(p) => (
          <button type="button" className="chip-add" {...p}>
            <Icon name="plus" size={14} strokeWidth={2} />
            Add transform
          </button>
        )}
      >
        {(close) => (
          <>
            {entries.map((e) => (
              <button
                key={e.label}
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={e.disabled}
                onClick={() => {
                  dispatch({ type: 'add-transform', transform: e.transform });
                  close();
                }}
              >
                {e.label}
              </button>
            ))}
            {fnId === null ? (
              <span className="section-sub" style={{ padding: '6px 12px' }}>
                Select a function to merge, focus or collapse it.
              </span>
            ) : null}
          </>
        )}
      </Popover>
      <div className="header-spacer" />
      {sessionPath ? <span className="session-path">{sessionPath}</span> : null}
      <div className="compare-anchor">
        {hasBaseline ? (
          <Popover
            open={compareOpen}
            onOpenChange={setCompareOpen}
            role="dialog"
            label="Compare with another session"
            style={{ top: 38, right: 0, width: 320 }}
            trigger={(p) => (
              <button type="button" className="btn btn-sm" {...p}>
                Compare with…
              </button>
            )}
          >
            {() => (
              <p className="section-sub" style={{ padding: 8, lineHeight: '20px' }}>
                A baseline session is loaded: the flame graph shows the difference (blue = faster,
                orange = slower).
              </p>
            )}
          </Popover>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm"
              aria-disabled="true"
              aria-describedby={compareTipId}
            >
              Compare with…
            </button>
            <span role="tooltip" id={compareTipId} className="compare-tip">
              No baseline in this session. Run paces diff a.paces b.paces to open two sessions in
              differential mode.
            </span>
          </>
        )}
      </div>
    </div>
  );
}
