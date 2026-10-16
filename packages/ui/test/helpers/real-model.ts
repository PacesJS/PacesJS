import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { analyze } from '@pacesjs/engine';
import type { ExecutionModel, RawCapture } from '@pacesjs/engine';

const cache = new Map<string, ExecutionModel>();

/** A zoo capture from the engine's fixtures, analyzed by the real engine. */
export function fixtureModel(name: string): ExecutionModel {
  let model = cache.get(name);
  if (!model) {
    const file = resolve(process.cwd(), `../engine/test/fixtures/${name}.capture.json.gz`);
    const raw = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as RawCapture;
    model = analyze(raw);
    cache.set(name, model);
  }
  return model;
}

/** The flagship ORDERS-SERVER capture. */
export const ordersModel = (): ExecutionModel => fixtureModel('orders-server');
