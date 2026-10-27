import { useBrowserData } from '../app/useBrowserData';
import { PageLane } from './PageLane';

/** The page lane, the first of the lanes the milestone lines run through. Nothing for a Node run. */
export function BrowserPageLane() {
  const data = useBrowserData();
  if (!data) return null;
  return (
    <div className="browser-lanes">
      <PageLane data={data} />
    </div>
  );
}
