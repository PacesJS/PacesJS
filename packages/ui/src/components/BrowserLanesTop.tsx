import { useBrowserData } from '../app/useBrowserData';
import { Filmstrip } from './Filmstrip';
import { PageLane } from './PageLane';

/** The part of the browser lanes above the track lanes: the filmstrip and the page lane. Nothing for a Node run. */
export function BrowserLanesTop() {
  const data = useBrowserData();
  if (!data) return null;
  return (
    <div className="browser-lanes">
      <Filmstrip data={data} />
      <PageLane data={data} />
    </div>
  );
}
