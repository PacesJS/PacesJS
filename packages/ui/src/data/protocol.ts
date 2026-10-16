import type { Queries } from './queries';

export type QueryName = keyof Queries;

/** Async mirror of `Queries`: what the main thread calls. */
export type QueryClient = {
  [K in QueryName]: Queries[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export type WorkerBody =
  | { kind: 'init'; model: Uint8Array; baseline: Uint8Array | null }
  | { kind: 'call'; method: QueryName; args: unknown[] };

export type WorkerRequest = WorkerBody & { id: number };

export type WorkerResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export const QUERY_NAMES: readonly QueryName[] = [
  'summary',
  'overview',
  'tasks',
  'waterfall',
  'flame',
  'functions',
  'details',
  'sandwich',
  'callGraph',
  'source',
  'describe',
  'packageOf',
];
