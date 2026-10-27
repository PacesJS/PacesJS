import { useBrowserData } from '../app/useBrowserData';
import { Filmstrip } from './Filmstrip';

/** The filmstrip above the lanes. Nothing for a Node run. */
export function BrowserFilmstrip() {
  const data = useBrowserData();
  if (!data) return null;
  return (
    <div className="browser-lanes">
      <Filmstrip data={data} />
    </div>
  );
}
