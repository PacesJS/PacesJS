// Records the browser zoo pages with a real Chromium and writes the captures the engine tests read.
// Usage: node scripts/gen-browser-fixtures.mjs [--browser <path>] [--out <dir>] [--seconds <n>] [page...]
// The browser is --browser, then $PACES_BROWSER, then the default browser. Regenerate with
// `pnpm fixtures:browser`; fixtures are never edited by hand.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { detectDefaultBrowser, startRecording } from '../packages/collector-browser/dist/index.js';
import { startZoo } from '../zoo/browser/server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter(
  (a, i) => !a.startsWith('--') && !['--browser', '--out', '--seconds'].includes(args[i - 1]),
);
const PAGES = ['forced-layout', 'slow-click', 'third-party', 'worker-and-iframe', 'layout-shift'];
const pages = positional.length > 0 ? positional : PAGES;
const outDir = opt('--out') ?? join(root, 'packages/engine/test/fixtures/browser');
const seconds = Number(opt('--seconds') ?? 3.5);
const MAX_SHOTS = 8;

async function browserPath() {
  const given = opt('--browser') ?? process.env.PACES_BROWSER;
  if (given) return given;
  const found = await detectDefaultBrowser();
  if (found.kind !== 'chromium') {
    console.error(
      'The default browser is not Chromium. Pass --browser <path> or set PACES_BROWSER.',
    );
    process.exit(2);
  }
  return found.exe;
}

const exe = await browserPath();
mkdirSync(outDir, { recursive: true });
const zoo = await startZoo();
try {
  for (const page of pages) {
    const run = await startRecording({
      url: zoo.url(page),
      exe,
      screenshots: true,
      startPaused: false,
      fullTrace: false,
      keepQuery: false,
      hiRes: false,
      overlay: true,
      eventMarks: true,
      eventText: true,
      cacheCold: false,
      durationMs: seconds * 1000,
    });
    const rec = await run.done;
    const frames = rec.screenshots.frames;
    const picked = [];
    for (let i = 0; i < Math.min(MAX_SHOTS, frames.length); i++) {
      const frame = frames[Math.round((i * (frames.length - 1)) / Math.max(1, MAX_SHOTS - 1))];
      if (frame && !picked.includes(frame)) picked.push(frame);
    }
    const { screenshots, ...rest } = rec;
    const fixture = {
      note: `Recorded by scripts/gen-browser-fixtures.mjs from zoo/browser/pages/${page}.html`,
      page,
      input: {
        ...rest,
        screenshots: frames.map(({ id, tsUs, hash }) => ({ id, tsUs, hash })),
        screenshotCount: screenshots.frames.length,
        deduplicated: screenshots.deduplicated,
      },
      screenshotJpegs: picked.map((f) => ({
        id: f.id,
        base64: Buffer.from(f.bytes).toString('base64'),
      })),
    };
    const file = join(outDir, `${page}.browser.json.gz`);
    const bytes = gzipSync(JSON.stringify(fixture));
    writeFileSync(file, bytes);
    console.log(
      `${page}: ${rec.events.length} events kept, ${rec.filter.droppedEvents} dropped, ` +
        `${frames.length} frames, ${(bytes.length / 1024).toFixed(0)} KiB gz -> ${file}`,
    );
  }
} finally {
  await zoo.close();
}
