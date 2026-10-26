// Measures what recording a page costs: the slowdown of a CPU-bound loop with paces recording versus
// an untraced browser, and how big a session is per second of recording.
// Usage: node scripts/bench-browser.mjs [--browser <path>] [--runs <n>] [--seconds <n>]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  detectDefaultBrowser,
  launchBrowser,
  startRecording,
} from '../packages/collector-browser/dist/index.js';
import { startZoo } from '../zoo/browser/server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const runs = Number(opt('--runs') ?? 4);
const seconds = Number(opt('--seconds') ?? 5);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exePath() {
  const given = opt('--browser') ?? process.env.PACES_BROWSER;
  if (given) return given;
  const found = await detectDefaultBrowser();
  if (found.kind !== 'chromium') throw new Error('Pass --browser <path> or set PACES_BROWSER.');
  return found.exe;
}

/** Reads the page's own timings through a page session. */
async function readTimes(cdp) {
  // Right after a navigation the target list can still say about:blank.
  let page;
  const give = Date.now() + 30_000;
  while (!page) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    page = targetInfos.find((t) => t.type === 'page' && t.url.includes('bench.html'));
    if (!page) {
      if (Date.now() > give) throw new Error('the benchmark page did not load');
      await sleep(100);
    }
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  });
  const end = Date.now() + 60_000;
  for (;;) {
    const done = await cdp.send(
      'Runtime.evaluate',
      { expression: 'window.__done === true', returnByValue: true },
      sessionId,
    );
    if (done.result.value) break;
    if (Date.now() > end) throw new Error('the benchmark page did not finish');
    await sleep(200);
  }
  const times = await cdp.send(
    'Runtime.evaluate',
    { expression: 'window.__times', returnByValue: true },
    sessionId,
  );
  return times.result.value;
}

async function untraced(exe, url) {
  const profileDir = mkdtempSync(join(tmpdir(), 'paces-bench-'));
  const browser = launchBrowser({ exe, profileDir });
  try {
    const { targetInfos } = await browser.client.send('Target.getTargets');
    const first = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await browser.client.send('Target.attachToTarget', {
      targetId: first.targetId,
      flatten: true,
    });
    await browser.client.send('Page.navigate', { url }, sessionId);
    return await readTimes(browser.client);
  } finally {
    browser.kill();
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

async function traced(exe, url, extra) {
  const run = await startRecording({
    url,
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
    ...extra,
  });
  const times = await readTimes(run.cdp);
  await run.stop();
  return times;
}

const exe = await exePath();
const zoo = await startZoo();
try {
  const bench = zoo.url('bench');
  const base = [];
  const recorded = [];
  const noShots = [];
  for (let i = 0; i < runs; i++) {
    base.push(median(await untraced(exe, bench)));
    recorded.push(median(await traced(exe, bench, {})));
    noShots.push(median(await traced(exe, bench, { screenshots: false })));
  }
  const pct = (a, b) => `${(((median(a) - median(b)) / median(b)) * 100).toFixed(1)}%`;
  console.log(`CPU-bound loop, median of ${runs} runs of 10:`);
  console.log(`  no tracing        ${median(base).toFixed(1)} ms`);
  console.log(
    `  recording         ${median(recorded).toFixed(1)} ms  (${pct(recorded, base)} slower)`,
  );
  console.log(
    `  --no-screenshots  ${median(noShots).toFixed(1)} ms  (${pct(noShots, base)} slower)`,
  );

  console.log(
    `\nSession size, ${seconds} s of recording per page (filtered trace as JSON, then gzipped):`,
  );
  for (const page of [
    'slow-click',
    'forced-layout',
    'third-party',
    'worker-and-iframe',
    'layout-shift',
  ]) {
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
    const json = JSON.stringify(rec.events);
    const shots = rec.screenshots.frames.reduce((n, f) => n + f.bytes.length, 0);
    console.log(
      `  ${page.padEnd(18)} ${String(rec.events.length).padStart(5)} events  ${(json.length / 1024).toFixed(0).padStart(5)} KiB json  ` +
        `${(gzipSync(json).length / 1024).toFixed(0).padStart(4)} KiB gz  ${rec.screenshots.frames.length} frames ${(shots / 1024).toFixed(0)} KiB  ` +
        `(dropped ${rec.filter.droppedEvents})`,
    );
  }
} finally {
  await zoo.close();
}
void root;
