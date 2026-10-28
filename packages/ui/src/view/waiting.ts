import type { BrowserIdle, BrowserRequest } from '@pacesjs/engine';
import { fmtSeconds } from '../util/format';

/** The file a request asked for, else the host; an address that is not a file says what it is. */
export function requestName(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'blob' || scheme === 'data') return scheme;
  const path = url.split(/[?#]/)[0] ?? url;
  const last = path.split('/').filter(Boolean).pop() ?? url;
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)\/?$/i.exec(path)?.[1];
  return host ?? last;
}

const join = (names: string[]): string =>
  names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** One sentence for an idle stretch: how long, and what it was waiting on. */
export function idleLabel(s: BrowserIdle): string {
  const how = fmtSeconds(s.endUs - s.startUs, 1);
  if (s.cause === 'nothing') return `Idle ${how}, nothing in flight`;
  const names = s.requests.map(requestName);
  return `Idle ${how}, waiting on ${names.length > 0 ? join(names) : 'requests'}`;
}

/** The requests under way at a moment, the longest-running first. */
export function inFlightAt(requests: readonly BrowserRequest[], timeUs: number): BrowserRequest[] {
  return requests
    .filter((r) => r.startUs <= timeUs && timeUs <= r.endUs)
    .sort((a, b) => b.endUs - b.startUs - (a.endUs - a.startUs));
}

/**
 * For each of `buckets` equal slices of the run, the share of it the main thread sat idle with a
 * request in flight, and the share it sat idle with none. The rest was busy, or not recorded.
 */
export function idleShares(
  idle: readonly BrowserIdle[],
  durationUs: number,
  buckets: number,
): { waiting: number[]; nothing: number[] } {
  const waiting = new Array<number>(Math.max(0, buckets)).fill(0);
  const nothing = new Array<number>(Math.max(0, buckets)).fill(0);
  if (durationUs <= 0 || buckets <= 0) return { waiting, nothing };
  const slice = durationUs / buckets;
  for (const s of idle) {
    const into = s.cause === 'requests' ? waiting : nothing;
    const from = Math.max(0, Math.floor(s.startUs / slice));
    const to = Math.min(buckets - 1, Math.floor(s.endUs / slice));
    for (let i = from; i <= to; i++) {
      const covered = Math.min(s.endUs, (i + 1) * slice) - Math.max(s.startUs, i * slice);
      into[i] = Math.min(1, (into[i] ?? 0) + covered / slice);
    }
  }
  return { waiting, nothing };
}

const SHOWN_REQUESTS = 3;

/** What the page was waiting on at a moment: the idle stretch it falls in, and the requests in flight. */
export function waitingTip(
  data: {
    idle: readonly BrowserIdle[];
    requests: readonly BrowserRequest[];
    paused?: ReadonlyArray<{ startUs: number; endUs: number }>;
  },
  timeUs: number,
): { title: string; lines: string[] } {
  if (data.paused?.some((p) => p.startUs <= timeUs && timeUs <= p.endUs)) {
    return { title: fmtSeconds(timeUs, 2), lines: ['Recording was paused'] };
  }
  const lines: string[] = [];
  const stretch = data.idle.find((s) => s.startUs <= timeUs && timeUs <= s.endUs);
  if (stretch) lines.push(idleLabel(stretch));
  const flying = inFlightAt(data.requests, timeUs);
  if (flying.length === 0) lines.push('No requests in flight');
  else {
    const names = flying.slice(0, SHOWN_REQUESTS).map((r) => requestName(r.url));
    const more = flying.length - names.length;
    const list = more > 0 ? `${names.join(', ')} and ${more} more` : join(names);
    lines.push(
      `${flying.length} ${flying.length === 1 ? 'request' : 'requests'} in flight: ${list}`,
    );
  }
  return { title: fmtSeconds(timeUs, 2), lines };
}
