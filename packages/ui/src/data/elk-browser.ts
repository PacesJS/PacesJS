import * as elkApi from 'elkjs/lib/elk-api.js';
import type { ElkLike } from './layout';

type ElkCtor = new (options: { workerFactory: (url?: string) => Worker }) => ElkLike;

// elkjs is CommonJS: depending on the bundler the constructor is the module or a nested default.
function resolveCtor(mod: unknown): ElkCtor {
  let cur = mod;
  for (let i = 0; i < 4 && typeof cur !== 'function'; i++) {
    cur = (cur as { default?: unknown } | null)?.default;
  }
  if (typeof cur !== 'function')
    throw new Error('elkjs did not load: no constructor found in the module.');
  return cur as ElkCtor;
}

let shared: ElkLike | null = null;

/**
 * ELK running in its own Web Worker, so layout never blocks the data worker or the main thread.
 * (`elk.bundled.js` must not be loaded inside our own worker: it installs a global `onmessage`.)
 */
export function browserElk(): ElkLike {
  if (shared) return shared;
  if (typeof Worker === 'undefined') {
    throw new Error('The call graph needs Web Worker support to compute its layout.');
  }
  const Ctor = resolveCtor(elkApi);
  shared = new Ctor({
    workerFactory: () =>
      new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url), { type: 'module' }),
  });
  return shared;
}
