import type { BrowserIdle } from '@pacesjs/engine';
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
