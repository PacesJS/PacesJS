import type { ShowMe } from '@pacesjs/engine';
import type { QueryClient } from '../data/protocol';

/**
 * A waterfall target that is plumbing (a module loader, a promise job) is merged away by the
 * default transforms, so there would be no row to select. Show me then opens it with plumbing
 * unmerged, which is the one thing that makes the target visible.
 */
export async function withVisibleTarget(client: QueryClient, showMe: ShowMe): Promise<ShowMe> {
  if (showMe.fn === undefined || showMe.view !== 'waterfall') return showMe;
  const info = await client.describe(
    { track: showMe.track ?? 'all', transforms: [], range: null, hide: [] },
    { kind: 'fn', fn: showMe.fn },
  );
  return info.plumbing
    ? { ...showMe, options: { ...showMe.options, unmergePlumbing: true } }
    : showMe;
}
