import { useApp } from '../app/context';
import { VIEW_LABELS, VIEW_ORDER } from '../state/types';
import type { ViewId } from '../state/types';
import { CallGraph } from './CallGraph';
import { FilterBar } from './FilterBar';
import { FlameGraph } from './FlameGraph';
import { FunctionsTable } from './FunctionsTable';
import { Waterfall } from './Waterfall';

const TEXT = {
  mainView: 'Main view',
  views: 'Views',
} as const;

function ActiveView({ view }: { view: ViewId }) {
  switch (view) {
    case 'waterfall':
      return <Waterfall />;
    case 'flame':
      return <FlameGraph />;
    case 'callgraph':
      return <CallGraph />;
    case 'functions':
      return <FunctionsTable />;
  }
}

/** Tabs 1 to 4 and the active view. */
export function MainView() {
  const { snap, dispatch } = useApp();
  return (
    <section aria-label={TEXT.mainView} className="main-view card">
      <nav aria-label={TEXT.views} className="tabs" style={{ alignSelf: 'flex-start' }}>
        {VIEW_ORDER.map((v, i) => (
          <button
            key={v}
            type="button"
            className="tab"
            aria-selected={snap.view === v}
            aria-current={snap.view === v ? 'page' : undefined}
            onClick={() => dispatch({ type: 'go', patch: { view: v } })}
          >
            {VIEW_LABELS[v]} <kbd className="kbd">{i + 1}</kbd>
          </button>
        ))}
      </nav>
      <FilterBar />
      <div className="view-swap" key={snap.view}>
        <ActiveView view={snap.view} />
      </div>
    </section>
  );
}
