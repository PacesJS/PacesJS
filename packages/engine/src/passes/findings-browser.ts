// Findings that only a browser can have. Pure functions of the finished model; each echoes its
// thresholds in `rule`. Timings from trace events are exact and carry no `~`; sampled ones do.

import type { Thresholds } from '../config.js';
import { functionName } from '../frames.js';
import { INPUT_KIND_NAMES, Origin, REQUEST_FLAG, REQUEST_TYPE_NAMES } from '../model.js';
import type { ExecutionModel, Finding, FnId, Severity, Track } from '../model.js';
import { formatBytes, formatDuration, formatPercent, plural } from '../util/format.js';
import { stretches } from '../query/idle.js';
import { requestInitiator } from '../query/network.js';
import type { RequestInitiator } from '../query/network.js';
import { displayPath } from '../util/paths.js';
import { lowerBound } from '../util/search.js';

export type BrowserRule = (model: ExecutionModel, th: Thresholds) => Finding[];

const text = (m: ExecutionModel, id: number): string => m.strings[id] ?? '';
const nameOf = (m: ExecutionModel, fn: FnId): string => functionName(m, fn) || '(anonymous)';
const where = (m: ExecutionModel, fn: FnId): string =>
  `${nameOf(m, fn)} (${displayPath(text(m, m.functions.file[fn] ?? 0)) || 'unknown'}:${m.functions.line[fn] ?? 0})`;
const severityBy = (value: number, high: number, medium: number): Severity =>
  value >= high ? 'high' : value >= medium ? 'medium' : 'low';
const seconds = (us: number): string => `${(us / 1e6).toFixed(1)} s`;

/** Main threads: the page, its iframes and extensions. Workers do not block the page. */
const isMainThread = (t: Track): boolean =>
  t.kind === 'page' || t.kind === 'frame' || t.kind === 'extension';

function taskRange(track: Track, k: number): [number, number] {
  return [
    lowerBound(track.samples.time, track.tasks.start[k] ?? 0),
    lowerBound(track.samples.time, track.tasks.end[k] ?? 0),
  ];
}

const isProgram = (m: ExecutionModel, fn: FnId): boolean =>
  m.functions.origin[fn] === Origin.User && m.functions.plumbing[fn] !== 1;

/** The user function that owns the most self time in `[a, b)`, counting native frames below it. */
function ownerOf(
  m: ExecutionModel,
  track: Track,
  a: number,
  b: number,
  accept: (time: number) => boolean = () => true,
): FnId | undefined {
  const acc = new Map<FnId, number>();
  for (let i = a; i < b; i++) {
    if (!accept(track.samples.time[i] ?? 0)) continue;
    for (let n = track.samples.node[i] ?? 0; n > 0; n = track.callTree.parent[n] ?? 0) {
      const fn = track.callTree.fn[n] ?? 0;
      if (isProgram(m, fn)) {
        acc.set(fn, (acc.get(fn) ?? 0) + (track.samples.dur[i] ?? 0));
        break;
      }
    }
  }
  let best: FnId | undefined;
  let bestUs = -1;
  for (const [fn, us] of acc) {
    if (us > bestUs || (us === bestUs && best !== undefined && fn < best)) {
      best = fn;
      bestUs = us;
    }
  }
  return best;
}

/** A long task counts as blocking only when at least this share of it was sampled as busy. */
const MIN_SAMPLED_SHARE = 0.25;

const mainThreadBlocked: BrowserRule = (m, th) => {
  const limit = th.mainThreadBlockedMs * 1000;
  const long: Array<{ track: Track; task: number; dur: number }> = [];
  for (const track of m.tracks) {
    if (!isMainThread(track)) continue;
    for (let k = 0; k < track.tasks.length; k++) {
      const dur = (track.tasks.end[k] ?? 0) - (track.tasks.start[k] ?? 0);
      // A task the profiler barely saw (it was started or resumed during it) says nothing about the code.
      if (dur > limit && (track.tasks.busy[k] ?? 0) >= MIN_SAMPLED_SHARE * dur) {
        long.push({ track, task: k, dur });
      }
    }
  }
  if (long.length === 0) return [];
  long.sort((a, b) => b.dur - a.dur || a.task - b.task);
  const worst = long[0];
  if (!worst) return [];
  const total = long.reduce((n, x) => n + x.dur, 0);
  const [a, b] = taskRange(worst.track, worst.task);
  const owner = ownerOf(m, worst.track, a, b);
  const at = seconds(worst.track.tasks.start[worst.task] ?? 0);
  const culprit = owner === undefined ? '' : ` Most of it ran in ${where(m, owner)}.`;
  const summary =
    long.length === 1
      ? `One task blocked the page for ${formatDuration(worst.dur, false)}, starting at ${at}.${culprit}`
      : `${long.length} ${plural(long.length, 'task', 'tasks')} blocked the page for more than ${th.mainThreadBlockedMs} ms; the longest held it for ${formatDuration(worst.dur, false)}, starting at ${at}.${culprit}`;
  const wall = m.meta.durationUs || 1;
  return [
    {
      id: `main-thread-blocked:${worst.track.id}`,
      kind: 'main-thread-blocked',
      severity: severityBy(worst.dur, 250_000, 100_000),
      title: 'Main thread blocked',
      summary,
      rule: `Any main-thread task longer than ${th.mainThreadBlockedMs} ms, ranked by the longest and the total.`,
      impact: Math.min(1, total / wall),
      showMe: { view: 'waterfall', track: worst.track.id, task: worst.task },
      evidence: owner === undefined ? [] : [owner],
      track: worst.track.id,
    },
  ];
};

const VERB: Record<string, string> = {
  click: 'Clicking',
  submit: 'Submitting',
  change: 'Changing',
  key: 'Pressing',
};

const slowInteraction: BrowserRule = (m, th) => {
  const limit = th.slowInteractionMs * 1000;
  const slow: Array<{ track: Track; row: number; latency: number }> = [];
  for (const track of m.tracks) {
    const inputs = track.inputs;
    if (!inputs) continue;
    for (let i = 0; i < inputs.length; i++) {
      if ((inputs.latency[i] ?? -1) > limit)
        slow.push({ track, row: i, latency: inputs.latency[i] ?? 0 });
    }
  }
  if (slow.length === 0) return [];
  slow.sort((a, b) => b.latency - a.latency || a.row - b.row);
  const worst = slow[0];
  const inputs = worst?.track.inputs;
  if (!worst || !inputs) return [];
  const kind = INPUT_KIND_NAMES[inputs.kind[worst.row] ?? 0] ?? 'click';
  const label = text(m, inputs.label[worst.row] ?? 0);
  const task = inputs.task[worst.row] ?? -1;
  let owner: FnId | undefined;
  if (task >= 0) {
    const [a, b] = taskRange(worst.track, task);
    owner = ownerOf(m, worst.track, a, b);
  }
  const more = slow.length > 1 ? ` ${slow.length - 1} more were slow.` : '';
  return [
    {
      id: `slow-interaction:${worst.track.id}:${worst.row}`,
      kind: 'slow-interaction',
      severity: severityBy(worst.latency, 500_000, 300_000),
      title: 'Slow interaction',
      summary: `${VERB[kind] ?? 'Using'} ${label} took ${formatDuration(worst.latency, false)} to show a result.${owner === undefined ? '' : ` The handler ran in ${where(m, owner)}.`}${more}`,
      rule: `An input whose next paint is more than ${th.slowInteractionMs} ms later.`,
      impact: Math.min(1, worst.latency / (m.meta.durationUs || 1)),
      showMe: {
        view: 'waterfall',
        track: worst.track.id,
        ...(task >= 0 ? { task } : {}),
        range: [inputs.start[worst.row] ?? 0, (inputs.start[worst.row] ?? 0) + worst.latency],
      },
      evidence: owner === undefined ? [] : [owner],
      track: worst.track.id,
    },
  ];
};

const forcedLayout: BrowserRule = (m, th) => {
  interface Hit {
    track: Track;
    task: number;
    /** Forced layouts: the larger of the layouts and the style recalculations, which come in pairs. */
    count: number;
    layouts: number;
    styles: number;
    us: number;
  }
  const hits: Hit[] = [];
  for (const track of m.tracks) {
    const render = track.render;
    if (!render) continue;
    const perTask = new Map<number, Hit>();
    for (let i = 0; i < render.length; i++) {
      if (render.forced[i] !== 1) continue;
      const at = render.start[i] ?? 0;
      let task = -1;
      for (let k = 0; k < track.tasks.length; k++) {
        if ((track.tasks.start[k] ?? 0) <= at && at <= (track.tasks.end[k] ?? 0)) {
          task = k;
          break;
        }
      }
      const hit = perTask.get(task) ?? { track, task, count: 0, layouts: 0, styles: 0, us: 0 };
      if (render.phase[i] === 1) hit.layouts++;
      else hit.styles++;
      hit.count = Math.max(hit.layouts, hit.styles);
      hit.us += render.dur[i] ?? 0;
      perTask.set(task, hit);
    }
    for (const hit of perTask.values()) {
      if (hit.count > th.forcedLayoutCount || hit.us > th.forcedLayoutMs * 1000) hits.push(hit);
    }
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => b.us - a.us || b.count - a.count || a.task - b.task);
  const worst = hits[0];
  if (!worst) return [];
  let owner: FnId | undefined;
  if (worst.task >= 0) {
    const render = worst.track.render;
    const [a, b] = taskRange(worst.track, worst.task);
    owner = ownerOf(m, worst.track, a, b, (time) => {
      if (!render) return true;
      const i = lowerBound(render.start, time + 1) - 1;
      return (
        i >= 0 && render.forced[i] === 1 && time < (render.start[i] ?? 0) + (render.dur[i] ?? 0)
      );
    });
    owner ??= ownerOf(m, worst.track, a, b);
  }
  const who = owner === undefined ? 'A script' : `${nameOf(m, owner)}()`;
  return [
    {
      id: `forced-layout:${worst.track.id}`,
      kind: 'forced-layout',
      severity: severityBy(worst.us, 100_000, 30_000),
      title: 'Forced layout',
      summary: `${who} forced layout ${worst.count} times (${formatDuration(worst.us, false)}) by reading a measurement after changing the page.`,
      hint: 'Read all the measurements first, then make all the changes, or batch the reads with requestAnimationFrame.',
      rule: `More than ${th.forcedLayoutCount} layouts or style recalculations run from script, or more than ${th.forcedLayoutMs} ms of them, in one task.`,
      impact: Math.min(1, worst.us / (worst.track.busyUs || 1)),
      showMe: {
        view: 'waterfall',
        track: worst.track.id,
        ...(worst.task >= 0 ? { task: worst.task } : {}),
        ...(owner === undefined ? {} : { fn: owner }),
      },
      evidence: owner === undefined ? [] : [owner],
      track: worst.track.id,
    },
  ];
};

const looksLikeHost = (file: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(file) && !file.includes('node_modules/');

const thirdPartyCost: BrowserRule = (m, th) => {
  const mine = m.tracks.filter(isMainThread);
  const busy = mine.reduce((n, t) => n + t.busyUs, 0);
  if (busy <= 0) return [];
  const byHost = new Map<string, { us: number; fn: FnId; fnUs: number; track: Track }>();
  for (const track of mine) {
    for (let i = 0; i < track.fnIds.length; i++) {
      const fn = track.fnIds[i] ?? 0;
      if (m.functions.origin[fn] !== Origin.Dependency) continue;
      if (!looksLikeHost(text(m, m.functions.file[fn] ?? 0))) continue;
      const host = text(m, m.functions.pkg[fn] ?? 0);
      if (!host) continue;
      const us = track.agg.fnSelf[i] ?? 0;
      const entry = byHost.get(host) ?? { us: 0, fn, fnUs: -1, track };
      entry.us += us;
      if (us > entry.fnUs) {
        entry.fn = fn;
        entry.fnUs = us;
        entry.track = track;
      }
      byHost.set(host, entry);
    }
  }
  return [...byHost]
    .filter(([, v]) => v.us / busy > th.thirdPartyShare)
    .sort((a, b) => b[1].us - a[1].us || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([host, v]) => {
      const share = v.us / busy;
      return {
        id: `third-party-cost:${host}`,
        kind: 'third-party-cost' as const,
        severity: severityBy(share, 0.3, 0.15),
        title: 'Third-party cost',
        summary: `Scripts from ${host} used ${formatPercent(share)} of the main thread (${formatDuration(v.us)}), mostly in ${where(m, v.fn)}.`,
        rule: `Scripts from origins other than the site you opened, using more than ${formatPercent(th.thirdPartyShare)} of main-thread busy time.`,
        impact: Math.min(1, share),
        showMe: { view: 'functions' as const, track: v.track.id, fn: v.fn },
        evidence: [v.fn],
        track: v.track.id,
      };
    });
};

const layoutShift: BrowserRule = (m, th) => {
  const vitals = m.page?.vitals;
  if (!vitals) return [];
  let total = 0;
  let worstAt = 0;
  let worst = 0;
  for (let i = 0; i < vitals.length; i++) {
    if (vitals.kind[i] !== 5) continue;
    const value = vitals.value[i] ?? 0;
    total += value;
    if (value > worst) {
      worst = value;
      worstAt = vitals.time[i] ?? 0;
    }
  }
  if (total < th.layoutShiftScore) return [];
  const primary = m.tracks[m.primaryTrack];
  return [
    {
      id: 'layout-shift',
      kind: 'layout-shift',
      severity: severityBy(total, 0.25, th.layoutShiftScore),
      title: 'Layout shift',
      summary: `The page shifted ${total.toFixed(2)} after ${seconds(worstAt)}.`,
      hint: 'Reserve space for late content: give images, embeds and banners a fixed size.',
      rule: `Cumulative layout shift of ${th.layoutShiftScore} or more.`,
      impact: Math.min(1, total),
      showMe: {
        view: 'timeline',
        ...(primary ? { track: primary.id } : {}),
        range: [worstAt - 200_000, worstAt + 200_000],
      },
      evidence: [],
      ...(primary ? { track: primary.id } : {}),
    },
  ];
};

/** Request types whose body is text, so compression always pays. */
const TEXT_TYPES = new Set(['Document', 'Script', 'Stylesheet', 'Fetch', 'XHR']);
/** Wire bytes include headers; a body that shrank at all is below this share of its decoded size. */
const UNCOMPRESSED_RATIO = 0.9;

const NETWORK_URL = /^(https?|wss?):\/\//i;

const uncompressedText: BrowserRule = (m, th) => {
  const t = m.page?.requests;
  if (!t) return [];
  const hits: Array<{ url: string; bytes: number; start: number; end: number }> = [];
  for (let i = 0; i < t.length; i++) {
    const decoded = t.decoded[i] ?? -1;
    const encoded = t.encoded[i] ?? -1;
    const flags = t.flags[i] ?? 0;
    if (!TEXT_TYPES.has(REQUEST_TYPE_NAMES[t.type[i] ?? 0] ?? '')) continue;
    // The browser's own error page is a document too, but nothing served it.
    if (!NETWORK_URL.test(text(m, t.url[i] ?? 0))) continue;
    if (flags & (REQUEST_FLAG.cached | REQUEST_FLAG.failed)) continue;
    if (decoded < th.uncompressedTextBytes || encoded < UNCOMPRESSED_RATIO * decoded) continue;
    hits.push({
      url: text(m, t.url[i] ?? 0),
      bytes: decoded,
      start: t.start[i] ?? 0,
      end: Math.max(t.end[i] ?? 0, t.start[i] ?? 0),
    });
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => b.bytes - a.bytes || a.url.localeCompare(b.url));
  const total = hits.reduce((n, h) => n + h.bytes, 0);
  const listed = hits
    .slice(0, 3)
    .map((h) => `${displayPath(h.url)} (${formatBytes(h.bytes)})`)
    .join(', ');
  const primary = m.tracks[m.primaryTrack];
  const worst = hits[0];
  return [
    {
      id: 'uncompressed-text',
      kind: 'uncompressed-text',
      severity: severityBy(total, 500_000, 100_000),
      title: 'Uncompressed text',
      summary: `${plural(hits.length, 'text file was', 'text files were')} sent without compression (${formatBytes(total)} in all): ${listed}.`,
      hint: 'Turn on gzip or brotli for text files on the server or CDN; they usually shrink to a quarter or less.',
      rule: `A script, stylesheet, document or fetch of ${formatBytes(th.uncompressedTextBytes)} or more whose bytes on the wire are within ${formatPercent(1 - UNCOMPRESSED_RATIO)} of its size unpacked.`,
      impact: Math.min(1, total / 1_000_000),
      showMe: {
        view: 'timeline',
        ...(primary ? { track: primary.id } : {}),
        ...(worst ? { range: [worst.start, worst.end] as [number, number] } : {}),
      },
      evidence: [],
      ...(primary ? { track: primary.id } : {}),
    },
  ];
};

const VITAL_NAVIGATION = 0;
const VITAL_LCP = 4;

/** Time of the last vital of a kind at or before `limit`, else -1. */
function lastVital(m: ExecutionModel, kind: number, limit = Number.POSITIVE_INFINITY): number {
  const v = m.page?.vitals;
  let at = -1;
  for (let i = 0; v && i < v.length; i++) {
    const time = v.time[i] ?? 0;
    if (v.kind[i] === kind && time <= limit && time > at) at = time;
  }
  return at;
}

interface LoadSplit {
  busy: number;
  waiting: number;
  nothing: number;
}

/** What the main thread did in `[from, to]`: running a task, idle with a request in flight, or idle with none. */
function splitLoad(m: ExecutionModel, from: number, to: number): LoadSplit {
  const split: LoadSplit = { busy: 0, waiting: 0, nothing: 0 };
  for (const s of stretches(m, from, to)) {
    const span = s.end - s.start;
    if (s.cause === 'busy') split.busy += span;
    else if (s.cause === 'requests') split.waiting += span;
    else split.nothing += span;
  }
  return split;
}

/** The request that took the longest among those that finished in `(from, to]`. */
const slowestRequestBefore = (m: ExecutionModel, from: number, to: number) => {
  const t = m.page?.requests;
  let best = -1;
  let bestTook = -1;
  for (let i = 0; t && i < t.length; i++) {
    const end = t.end[i] ?? -1;
    const took = end - (t.start[i] ?? 0);
    const type = REQUEST_TYPE_NAMES[t.type[i] ?? 0];
    if (type === 'Media' || type === 'Other') continue;
    if (end > from && end <= to && took > bestTook) {
      best = i;
      bestTook = took;
    }
  }
  return t && best >= 0
    ? {
        url: text(m, t.url[best] ?? 0),
        start: t.start[best] ?? 0,
        took: bestTook,
        by: requestInitiator(m, best),
      }
    : undefined;
};

const requesterText = (by: RequestInitiator | null): string =>
  by ? `, requested by ${by.fn} (${displayPath(by.script)}:${by.line})` : '';

const slowLoad: BrowserRule = (m, th) => {
  const lcp = lastVital(m, VITAL_LCP);
  if (lcp < th.slowLoadMs * 1000) return [];
  const from = Math.max(0, lastVital(m, VITAL_NAVIGATION, lcp));
  const split = splitLoad(m, from, lcp);
  const slowest = slowestRequestBefore(m, from, lcp + 50_000);
  const dominant = Math.max(split.busy, split.waiting, split.nothing);
  const hint =
    dominant === split.waiting
      ? 'Most of the time went to waiting on the network: start the slowest request sooner (preload it), make it smaller, or serve it from nearer.'
      : dominant === split.busy
        ? 'Most of the time the main thread was busy: look at the long tasks before this moment.'
        : undefined;
  const primary = m.tracks[m.primaryTrack];
  const slowestText =
    slowest && dominant === split.waiting
      ? ` The slowest request to finish before it was ${displayPath(slowest.url)} (sent at ${seconds(slowest.start)}, took ${formatDuration(slowest.took, false)}${requesterText(slowest.by)}).`
      : '';
  return [
    {
      id: 'slow-load',
      kind: 'slow-load',
      severity: severityBy(lcp, 4_000_000, th.slowLoadMs * 1000),
      title: 'Slow load',
      summary: `Largest content appeared at ${seconds(lcp)}. Until then the main thread was busy ${seconds(split.busy)}, idle with requests in flight ${seconds(split.waiting)} and idle with nothing in flight ${seconds(split.nothing)}.${slowestText}`,
      ...(hint ? { hint } : {}),
      rule: `The last largest-contentful-paint of the page came after ${th.slowLoadMs} ms.`,
      impact: Math.min(1, lcp / 10_000_000),
      showMe: {
        view: 'timeline',
        ...(primary ? { track: primary.id } : {}),
        range: [from, lcp] as [number, number],
      },
      evidence: [],
      ...(primary ? { track: primary.id } : {}),
    },
  ];
};

/** A navigation is taken to be the cause of a document request that starts within this long of it. */
const NAVIGATION_WINDOW_US = 10_000_000;

const slowDocument: BrowserRule = (m, th) => {
  const t = m.page?.requests;
  if (!t) return [];
  let doc = -1;
  for (let i = 0; i < t.length; i++) {
    if (REQUEST_TYPE_NAMES[t.type[i] ?? 0] !== 'Document') continue;
    if (doc < 0 || (t.start[i] ?? 0) < (t.start[doc] ?? 0)) doc = i;
  }
  if (doc < 0) return [];
  const sent = t.start[doc] ?? 0;
  const navigation = lastVital(m, VITAL_NAVIGATION, sent);
  const wait = sent - navigation;
  if (navigation < 0 || wait > NAVIGATION_WINDOW_US || wait < th.documentWaitMs * 1000) return [];
  const primary = m.tracks[m.primaryTrack];
  return [
    {
      id: 'slow-document',
      kind: 'slow-document',
      severity: severityBy(wait, 2_000_000, th.documentWaitMs * 1000),
      title: 'Slow document',
      summary: `The HTML of ${displayPath(text(m, t.url[doc] ?? 0))} took ${seconds(wait)} to start arriving after the navigation began, before anything on the page could load.`,
      hint: 'That time is DNS, the connection, any redirects and the server itself: check the server response time first.',
      rule: `The page's first document request was sent more than ${th.documentWaitMs} ms after its navigation began.`,
      impact: Math.min(1, wait / 5_000_000),
      showMe: {
        view: 'timeline',
        ...(primary ? { track: primary.id } : {}),
        range: [navigation, sent] as [number, number],
      },
      evidence: [],
      ...(primary ? { track: primary.id } : {}),
    },
  ];
};

/** The browser-only rules, in report order. */
export const BROWSER_RULES: BrowserRule[] = [
  mainThreadBlocked,
  slowInteraction,
  forcedLayout,
  thirdPartyCost,
  layoutShift,
  uncompressedText,
  slowDocument,
  slowLoad,
];
