import * as elkModule from 'elkjs/lib/elk.bundled.js';
import type { ElkLike } from '../../src/data/layout';

type ElkCtor = new () => ElkLike;

/** In-process ELK for Node tests (the browser build runs ELK in its own worker). */
export function nodeElk(): ElkLike {
  let cur: unknown = elkModule;
  for (let i = 0; i < 4 && typeof cur !== 'function'; i++)
    cur = (cur as { default?: unknown } | null)?.default;
  return new (cur as ElkCtor)();
}
