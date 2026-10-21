import type { ReactNode } from 'react';
import { SelectionBar } from './SelectionBar';

const TEXT = {
  details: 'Selection details',
} as const;

interface DetailsSectionProps {
  children: ReactNode;
}

/** The card every selection shows in the drawer; a new `key` remounts it, which cross-fades the content. */
export function DetailsSection({ children }: DetailsSectionProps) {
  return (
    <section aria-label={TEXT.details} className="details card" data-keeps-selection>
      <SelectionBar />
      {children}
    </section>
  );
}
