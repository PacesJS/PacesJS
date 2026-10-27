import { NODE_RUN } from '../../src/run/index.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { PassContext } from '../../src/passes/types.js';
import { DEFAULT_THRESHOLDS } from '../../src/config.js';
import type { RawCapture } from '../../src/raw.js';
import { createStringTable } from '../../src/util/strings.js';

export const FIXTURES = [
  'orders-server',
  'sync-io',
  'hot-regex',
  'gc-heavy',
  'late-require',
  'rxjs-chain',
  'worker-imbalance',
  'eslint-cli',
  'eslint-cli-wrapped',
  'async-chain',
  'async-chain-hooks',
] as const;
// Not in FIXTURES: it needs V8 tracing (--v8), so the all-fixtures goldens do not cover it.
export type FixtureName = (typeof FIXTURES)[number] | 'deopt-loop';

const captures = new Map<string, RawCapture>();
export function loadCapture(name: FixtureName): RawCapture {
  const cached = captures.get(name);
  if (cached) return cached;
  const url = new URL(`../fixtures/${name}.capture.json.gz`, import.meta.url);
  const text = gunzipSync(readFileSync(url)).toString('utf8');
  const capture = JSON.parse(text) as RawCapture;
  captures.set(name, capture);
  return capture;
}

export function makeContext(): PassContext {
  return {
    run: NODE_RUN,
    thresholds: DEFAULT_THRESHOLDS,
    options: {},
    strings: createStringTable(),
    warnings: [],
  };
}
