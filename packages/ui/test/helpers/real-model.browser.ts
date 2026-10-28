// The browser twin of real-model.ts, which reads fixtures from disk. Browser tests cannot, so they
// fetch the committed fixtures through Vite, and each test file awaits `preload` for the ones it
// uses before it asks for them (the getters stay synchronous, like the Node ones).
import { analyze, recordingToCapture } from '@pacesjs/engine';
import type { BrowserRecordingInput, ExecutionModel, RawCapture } from '@pacesjs/engine';

const captureUrls = import.meta.glob('../../../engine/test/fixtures/*.capture.json.gz', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const pageUrls = import.meta.glob('../../../engine/test/fixtures/browser/*.browser.json.gz', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface PageFixture {
  input: BrowserRecordingInput;
  screenshotJpegs: Array<{ id: number; base64: string }>;
}

const captures = new Map<string, ExecutionModel>();
const pages = new Map<string, PageFixture>();
const pageModels = new Map<string, ExecutionModel>();

/** Vite serves a .gz as `content-encoding: gzip`, so the browser has usually unpacked it already. */
async function gunzipJson<T>(url: string): Promise<T> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gzipped
    ? await new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).text()
    : new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

const urlOf = (table: Record<string, string>, name: string, suffix: string): string => {
  const hit = Object.entries(table).find(([path]) => path.endsWith(`/${name}${suffix}`));
  if (!hit) throw new Error(`no fixture named ${name}`);
  return hit[1];
};

/** Loads fixtures before a test file asks for them: `orders-server`, or `browser:slow-click`. */
export async function preload(...names: string[]): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      if (name.startsWith('browser:')) {
        const page = name.slice('browser:'.length);
        if (pages.has(page)) return;
        pages.set(page, await gunzipJson(urlOf(pageUrls, page, '.browser.json.gz')));
      } else if (!captures.has(name)) {
        captures.set(
          name,
          analyze(await gunzipJson<RawCapture>(urlOf(captureUrls, name, '.capture.json.gz'))),
        );
      }
    }),
  );
}

/** A zoo capture from the engine's fixtures, analyzed by the real engine. */
export function fixtureModel(name: string): ExecutionModel {
  const model = captures.get(name);
  if (!model) throw new Error(`fixture ${name} was not preloaded: await preload('${name}')`);
  return model;
}

/** The flagship ORDERS-SERVER capture. */
export const ordersModel = (): ExecutionModel => fixtureModel('orders-server');

const pageOf = (name: string): PageFixture => {
  const page = pages.get(name);
  if (!page) throw new Error(`page ${name} was not preloaded: await preload('browser:${name}')`);
  return page;
};

/** A page recorded from the browser zoo in a real Chromium, analyzed by the real engine. */
export function browserModel(name: string): ExecutionModel {
  let model = pageModels.get(name);
  if (!model) {
    model = analyze(recordingToCapture(pageOf(name).input));
    pageModels.set(name, model);
  }
  return model;
}

/** The JPEGs a browser fixture kept, by frame id. */
export function browserScreenshots(name: string): Record<number, Uint8Array> {
  return Object.fromEntries(
    pageOf(name).screenshotJpegs.map((s) => [
      s.id,
      Uint8Array.from(atob(s.base64), (c) => c.charCodeAt(0)),
    ]),
  );
}

/** A browser fixture analyzed with some of its recording options changed (throttle, cold cache). */
export function browserModelWith(
  name: string,
  over: Partial<BrowserRecordingInput>,
): ExecutionModel {
  return analyze(recordingToCapture({ ...pageOf(name).input, ...over }));
}
