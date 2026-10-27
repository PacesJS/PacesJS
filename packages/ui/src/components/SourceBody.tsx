import type { SourceState } from '../app/useSource';
import { ChangedBanner } from './ChangedBanner';
import { SourceCode } from './SourceCode';
import { SourceReasonNote } from './SourceReasonNote';

const TEXT = {
  nothing: 'There is nothing to show for this function.',
  formatted:
    'This file is minified. It is laid out here for reading; its line numbers differ from the original.',
} as const;

interface SourceBodyProps {
  source: SourceState;
  wrap: boolean;
  band?: { first: number; last: number } | null;
}

/** Changed-file banner, the reason note and the code (or why there is none): the body of every source view. */
export function SourceBody({ source, wrap, band }: SourceBodyProps) {
  const showCode = !source.reason || source.reason.showsText || source.lines.length > 0;
  return (
    <>
      <ChangedBanner changed={source.changed} />
      {source.formatted ? (
        <p className="source-formatted" role="note">
          {TEXT.formatted}
        </p>
      ) : null}
      <SourceReasonNote source={source} />
      {showCode ? (
        <SourceCode source={source} wrap={wrap} band={band} />
      ) : (
        <p className="source-empty">{TEXT.nothing}</p>
      )}
    </>
  );
}
