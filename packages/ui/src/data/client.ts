import type { ElkProvider } from './layout';
import { createQueries } from './queries';
import type { Queries } from './queries';
import { QUERY_NAMES } from './protocol';
import type { QueryClient, WorkerBody, WorkerResponse } from './protocol';
import type { ExecutionModel } from '@pacesjs/engine';

/** In-process client: same API, no worker. Used by tests and by hosts without Worker support. */
export function localClient(
  model: ExecutionModel,
  baseline: ExecutionModel | null = null,
  elk?: ElkProvider,
): QueryClient {
  const q = createQueries(model, baseline, elk);
  return wrap(q);
}

function wrap(q: Queries): QueryClient {
  const out: Record<string, unknown> = {};
  for (const name of QUERY_NAMES) {
    const fn = q[name] as (...args: unknown[]) => unknown;
    out[name] = async (...args: unknown[]) => fn.apply(q, args);
  }
  return out as unknown as QueryClient;
}

/** Spawn the data worker, hand it the model bytes and return a promise-based client. */
export async function workerClient(
  bytes: Uint8Array,
  baselineBytes: Uint8Array | null,
): Promise<QueryClient> {
  const worker = new Worker(new URL('./data.worker.ts', import.meta.url), { type: 'module' });
  let next = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  worker.onerror = (ev) => {
    const err = new Error(`The data worker failed: ${ev.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const send = (req: WorkerBody, transfer: Transferable[] = []): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id }, transfer);
    });
  const copy = bytes.slice();
  const baseCopy = baselineBytes ? baselineBytes.slice() : null;
  await send(
    { kind: 'init', model: copy, baseline: baseCopy },
    baseCopy ? [copy.buffer, baseCopy.buffer] : [copy.buffer],
  );
  const out: Record<string, unknown> = {};
  for (const name of QUERY_NAMES) {
    out[name] = (...args: unknown[]) => send({ kind: 'call', method: name, args });
  }
  return out as unknown as QueryClient;
}
