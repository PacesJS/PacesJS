import { deserializeModel } from '@pacesjs/engine';
import { createQueries } from './queries';
import type { Queries } from './queries';
import type { WorkerRequest, WorkerResponse } from './protocol';

let queries: Queries | null = null;

function reply(msg: WorkerResponse): void {
  (self as unknown as { postMessage(m: WorkerResponse): void }).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  void (async () => {
    try {
      if (req.kind === 'init') {
        queries = createQueries(
          deserializeModel(req.model),
          req.baseline ? deserializeModel(req.baseline) : null,
        );
        reply({ id: req.id, ok: true, result: null });
        return;
      }
      if (!queries) throw new Error('The model is not loaded yet.');
      const fn = queries[req.method] as (...args: unknown[]) => unknown;
      reply({ id: req.id, ok: true, result: await fn.apply(queries, req.args) });
    } catch (e) {
      reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
};
