const TEXT = {
  thisSelection: 'This selection',
  noOwnSource:
    ' has no source file of its own: it is a collapsed package. Expand it in the call graph (the +N chip) or select one of its functions.',
  select: 'Select a function in any view to read its source with time on every line.',
} as const;

interface EmptySourceNoteProps {
  fn: number | null;
  name: string;
  loading: boolean;
}

/** Text under an empty dock: nothing selected, or a selection that has no source of its own. */
export function EmptySourceNote({ fn, name, loading }: EmptySourceNoteProps) {
  if (fn !== null && !loading) {
    return (
      <p className="source-empty">
        <strong>{name || TEXT.thisSelection}</strong>
        {TEXT.noOwnSource}
      </p>
    );
  }
  return <p className="source-empty">{TEXT.select}</p>;
}
