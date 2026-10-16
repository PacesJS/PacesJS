import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { analyze } from '@pacesjs/engine';
import type { ExecutionModel, RawCapture } from '@pacesjs/engine';

const FIXTURE = resolve(process.cwd(), '../engine/test/fixtures/orders-server.capture.json.gz');

let cached: ExecutionModel | null = null;

/** The flagship ORDERS-SERVER capture, analyzed by the real engine. */
export function ordersModel(): ExecutionModel {
  if (!cached) {
    const raw = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as RawCapture;
    cached = analyze(raw);
  }
  return cached;
}
