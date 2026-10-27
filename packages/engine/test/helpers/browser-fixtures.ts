import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { BrowserRecordingInput } from '../../src/trace/types.js';

export const BROWSER_FIXTURES = [
  'forced-layout',
  'slow-click',
  'third-party',
  'worker-and-iframe',
  'layout-shift',
  'big-script',
  'slow-load',
  'slow-doc',
  'late-hero',
  'paused-resume',
] as const;
export type BrowserFixtureName = (typeof BROWSER_FIXTURES)[number];

export interface BrowserFixture {
  page: string;
  input: BrowserRecordingInput;
  screenshotJpegs: Array<{ id: number; base64: string }>;
}

const cache = new Map<string, BrowserFixture>();

/** A trace recorded from a zoo page by scripts/gen-browser-fixtures.mjs. */
export function loadBrowserFixture(name: BrowserFixtureName): BrowserFixture {
  const hit = cache.get(name);
  if (hit) return hit;
  const url = new URL(`../fixtures/browser/${name}.browser.json.gz`, import.meta.url);
  const fixture = JSON.parse(gunzipSync(readFileSync(url)).toString('utf8')) as BrowserFixture;
  cache.set(name, fixture);
  return fixture;
}

/** A deep copy, for tests that change the input. */
export function cloneInput(name: BrowserFixtureName): BrowserRecordingInput {
  return structuredClone(loadBrowserFixture(name).input);
}
