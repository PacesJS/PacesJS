import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { analyze, recordingToCapture } from '@pacesjs/engine';
import type { BrowserRecordingInput } from '@pacesjs/engine';
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

const browserCache = new Map<string, ExecutionModel>();

/** A page recorded from the browser zoo in a real Chromium, analyzed by the real engine. */
export function browserModel(name: string): ExecutionModel {
  let model = browserCache.get(name);
  if (!model) {
    const file = resolve(process.cwd(), `../engine/test/fixtures/browser/${name}.browser.json.gz`);
    const { input } = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as {
      input: BrowserRecordingInput;
    };
    model = analyze(recordingToCapture(input));
    browserCache.set(name, model);
  }
  return model;
}

/** The JPEGs a browser fixture kept, by frame id. */
export function browserScreenshots(name: string): Record<number, Uint8Array> {
  const file = resolve(process.cwd(), `../engine/test/fixtures/browser/${name}.browser.json.gz`);
  const { screenshotJpegs } = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as {
    screenshotJpegs: Array<{ id: number; base64: string }>;
  };
  return Object.fromEntries(
    screenshotJpegs.map((s) => [s.id, Uint8Array.from(Buffer.from(s.base64, 'base64'))]),
  );
}

/** A browser fixture analyzed with some of its recording options changed (throttle, cold cache). */
export function browserModelWith(
  name: string,
  over: Partial<BrowserRecordingInput>,
): ExecutionModel {
  const file = resolve(process.cwd(), `../engine/test/fixtures/browser/${name}.browser.json.gz`);
  const { input } = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as {
    input: BrowserRecordingInput;
  };
  return analyze(recordingToCapture({ ...input, ...over }));
}
