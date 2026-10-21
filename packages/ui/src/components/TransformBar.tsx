import { useId, useState } from 'react';
import { useApp } from '../app/context';
import { useAsync } from '../app/hooks';
import { fmtRange } from '../util/format';
import { hasTransform, transformLabel } from '../state/transforms';
import type { Transform } from '../state/types';
import { Icon } from './Icon';
import { Popover } from './Popover';

const TEXT = {
  fnFallback: (fn: number) => `function ${fn}`,
  stitch: 'Stitch continuations (inferred)',
  collapseDeps: 'Collapse dependencies',
  mergePlumbing: 'Merge plumbing',
  dropIdle: 'Drop idle',
  uninvert: 'Uninvert',
  invert: 'Invert call tree',
  merge: (name: string) => `Merge ${name}`,
  focusOn: (name: string) => `Focus on ${name}`,
  focusSelf: (name: string) => `Focus on ${name} self`,
  collapseRec: (name: string) => `Collapse recursion in ${name}`,
  dropSamples: (name: string) => `Drop samples with ${name}`,
  collapsePkg: (pkg: string) => `Collapse ${pkg}`,
  transforms: 'Transforms',
  stack: 'Transform stack, oldest first',
  separator: '›',
  rewindTitle: 'Rewind to this point',
  rewind: (label: string) => `Rewind to ${label}`,
  remove: (label: string) => `Remove ${label}`,
  range: (range: string) => `Range ${range}`,
  removeRange: 'Remove time range',
  add: 'Add transform',
  selectFunction: 'Select a function to merge, focus or collapse it.',
  compareLabel: 'Compare with another session',
  compare: 'Compare with…',
  baseline:
    'A baseline session is loaded: the flame graph shows the difference (blue = faster, orange = slower).',
  noBaseline:
    'No baseline in this session. Run paces diff a.paces b.paces to open two sessions in differential mode.',
} as const;

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
  const names = (fn: number): string => (fn === fnId ? selection.name : TEXT.fnFallback(fn));
  const pkgQuery = useAsync(
    () => (fnId === null ? Promise.resolve('') : client.packageOf(fnId)),
    `pkg:${fnId}`,
  );
  const pkg = fnId === null ? '' : (pkgQuery.data ?? '');

  const entries: MenuEntry[] = [
    {
      label: TEXT.stitch,
      transform: { k: 'stitch' },
      disabled: hasTransform(snap.transforms, 'stitch'),
    },
    {
      label: TEXT.collapseDeps,
      transform: { k: 'collapse-deps' },
      disabled: hasTransform(snap.transforms, 'collapse-deps'),
    },
    {
      label: TEXT.mergePlumbing,
      transform: { k: 'merge-plumbing' },
      disabled: hasTransform(snap.transforms, 'merge-plumbing'),
    },
    {
      label: TEXT.dropIdle,
      transform: { k: 'drop-idle' },
      disabled: hasTransform(snap.transforms, 'drop-idle'),
    },
    {
      label: hasTransform(snap.transforms, 'invert') ? TEXT.uninvert : TEXT.invert,
      transform: { k: 'invert' },
    },
    ...(fnId !== null
      ? ([
          { label: TEXT.merge(selection.name), transform: { k: 'merge-fn', fn: fnId } },
          { label: TEXT.focusOn(selection.name), transform: { k: 'focus-fn', fn: fnId } },
          { label: TEXT.focusSelf(selection.name), transform: { k: 'focus-self', fn: fnId } },
          {
            label: TEXT.collapseRec(selection.name),
            transform: { k: 'collapse-rec', fn: fnId },
          },
          { label: TEXT.dropSamples(selection.name), transform: { k: 'drop-fn', fn: fnId } },
          ...(pkg
            ? [{ label: TEXT.collapsePkg(pkg), transform: { k: 'collapse-pkg', pkg } } as MenuEntry]
            : []),
        ] as MenuEntry[])
      : []),
  ];

  return (
    <div className="transform-row">
      <span className="caps">{TEXT.transforms}</span>
      <ol className="chips" aria-label={TEXT.stack}>
        {snap.transforms.map((t, i) => {
          const label = transformLabel(t, names);
          return (
            <li key={`${i}-${label}`} className="chip-item">
              {i > 0 ? (
                <span className="chip-sep" aria-hidden="true">
                  {TEXT.separator}
                </span>
              ) : null}
              <span className="chip">
                <button
                  type="button"
                  className="chip-label"
                  title={TEXT.rewindTitle}
                  aria-label={TEXT.rewind(label)}
                  onClick={() => dispatch({ type: 'rewind-transform', index: i })}
                >
                  {label}
                </button>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={TEXT.remove(label)}
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
                {TEXT.separator}
              </span>
            ) : null}
            <span className="chip chip-range">
              <span className="chip-label">
                {TEXT.range(fmtRange(snap.range[0], snap.range[1]))}
              </span>
              <button
                type="button"
                className="chip-remove"
                aria-label={TEXT.removeRange}
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
        label={TEXT.add}
        style={{ top: 38, left: 0 }}
        trigger={(p) => (
          <button type="button" className="chip-add" {...p}>
            <Icon name="plus" size={14} strokeWidth={2} />
            {TEXT.add}
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
                {TEXT.selectFunction}
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
            label={TEXT.compareLabel}
            style={{ top: 38, right: 0, width: 320 }}
            trigger={(p) => (
              <button type="button" className="btn btn-sm" {...p}>
                {TEXT.compare}
              </button>
            )}
          >
            {() => (
              <p className="section-sub" style={{ padding: 8, lineHeight: '20px' }}>
                {TEXT.baseline}
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
              {TEXT.compare}
            </button>
            <span role="tooltip" id={compareTipId} className="compare-tip">
              {TEXT.noBaseline}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
