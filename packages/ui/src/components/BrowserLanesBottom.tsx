import { useBrowserData } from '../app/useBrowserData';
import { InteractionLane } from './InteractionLane';
import { RenderLane } from './RenderLane';

/** The part below the track lanes: rendering work and the user's input. Nothing for a Node run. */
export function BrowserLanesBottom() {
  const data = useBrowserData();
  if (!data) return null;
  return (
    <div className="browser-lanes">
      <RenderLane data={data} />
      <InteractionLane data={data} />
    </div>
  );
}
